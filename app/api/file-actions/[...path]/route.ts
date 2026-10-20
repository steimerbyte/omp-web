import { NextResponse, type NextRequest } from "next/server";
import fs from "fs";
import path from "path";
import { isApiRequestAllowed } from "@/lib/request-security";
import { filePathFromSegments } from "@/lib/file-paths";
import {
  authorizeTransfer,
  destinationExists,
  isSameOrBelow,
  isWritePathAllowed,
} from "@/lib/write-access";
import { getRequestIdentity, getUserHome, type WebIdentity } from "@/lib/request-identity";
import { protectedRootReason } from "@/lib/projects-delete";

export const dynamic = "force-dynamic";

/**
 * Destructive file operations: move, copy, mkdir, rename, delete.
 *
 * These live in their own route rather than as more `type=` values on
 * `app/api/files/[...path]`, for two reasons. That file is already 700 lines and
 * carries the read and upload contracts; a destructive module that is easy to
 * read end to end is worth more than the shared prefix. And a separate module
 * makes the write boundary auditable in one place — every handler that can
 * destroy something is in this file, and every one of them opens with the same
 * two checks.
 *
 * The sibling path is a deliberate workaround: Next.js rejects a segment after
 * a catch-all, so `/api/files/[...path]/actions` will not build. Splitting the
 * prefix keeps the catch-all last in both routes.
 *
 * The path segment addresses the *source*. The destination arrives in the body
 * as an absolute path, because a move target is a directory the user picked,
 * not a relative step from the source.
 *
 * Every handler is refused unless the path is inside a *writable* root, which
 * is a strictly narrower set than the read allowlist — see lib/write-access.ts
 * for why reusing the read set here would be a hole rather than a shortcut.
 *
 * ### The second check: protected trees
 *
 * On 2026-10-20 a single `DELETE` here removed 130 chats. The path deleted was
 * `~/.omp`, and it was reachable because 129 chats had `cwd = ~/.omp`, which
 * made that directory an ordinary writable root — the request passed every
 * guard the handler had.
 *
 * That is the difference the two checks answer. `isWritePathAllowed` answers
 * *may this caller write here*, and a chat that once ran in a directory makes it
 * yes. `protectedRootReason` answers *may this tree be destroyed, moved away,
 * or written into at all* — a question no session cwd gets a vote on. Same
 * function the projects dashboard uses, so the two routes cannot drift apart.
 *
 * It runs on **both operands** of every transfer, and after the write guard
 * rather than before it: the write guard is the one that costs nothing to fail,
 * so it goes first and a refusal there explains itself as a permission problem
 * rather than as "that folder is not yours to remove".
 */

const MAX_COPY_BYTES = 512 * 1024 * 1024;

function errorResponse(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

function isAbsolute(target: string): boolean {
  return path.isAbsolute(target);
}

/** An absolute destination under `targetDir`, named `name`. */
function destinationIn(targetDir: string, name: string): string {
  return path.join(targetDir, name);
}

/**
 * The refusal for a path that may not be destroyed, moved or written into.
 *
 * `protectedRootReason` and not the boolean `isProtectedProjectRoot`, for two
 * reasons. The client needs `code: "protected"` to tell this apart from a
 * write-permission failure — the dashboard's `ConfirmDialog` keys its message
 * off that code, and a delete refused as "access denied" reads as a bug to the
 * person who just clicked the right button. And the *reason* names the rule
 * that spoke: `"omp-runtime"` is "this is the running installation", which is
 * a different sentence from `"system-path"`, which is "pick another folder".
 *
 * `getUserHome(identity)`, never `os.homedir()`: the process serves several
 * identities from one account, so the home is a property of the caller. On the
 * host where the 130 chats went, the admin's home resolved to `/`, and every
 * home-derived comparison was made against a tree with nothing to do with the
 * folder being deleted.
 */
function protectedRefusal(target: string, identity: WebIdentity): NextResponse | null {
  const reason = protectedRootReason(target, getUserHome(identity));
  if (reason === null) return null;
  return NextResponse.json(
    { error: "This path is protected and cannot be modified", code: "protected", reason },
    { status: 403 },
  );
}

/** The final path segment, rejecting "." and "..". */
function safeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === "." || trimmed === "..") return null;
  if (trimmed.includes("/") || trimmed.includes("\\")) return null;
  if (trimmed.includes("\0")) return null;
  return trimmed;
}

/** Total bytes a directory tree occupies, for the copy size guard. */
function treeSize(target: string): number {
  const stat = fs.lstatSync(target);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(target)) {
    total += treeSize(path.join(target, entry));
  }
  return total;
}

/**
 * Recursive copy. Deliberately does not follow symlinks: a symlink inside the
 * source is copied as a symlink, so a link pointing outside the project cannot
 * pull foreign content in through the copy.
 */
function copyTree(source: string, destination: string): void {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), destination);
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyTree(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  fs.copyFileSync(source, destination);
  // copyFileSync does not carry the mode across on every platform, and an
  // executable losing +x is a real regression for a project the agent runs.
  fs.chmodSync(destination, stat.mode);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  if (!isApiRequestAllowed(request)) {
    return errorResponse("Untrusted API request", 403);
  }

  try {
    const { path: segments } = await params;
    // Resolved once, before any path from the URL or the body is looked at.
    // Every handler below reaches `isWritePathAllowed`/`authorizeTransfer` with
    // this value and nothing else, so the source path and the destination in
    // the body cannot influence who is being authorized.
    const identity = getRequestIdentity(request.headers);
    if (!identity) return errorResponse("Access denied", 403);

    const source = filePathFromSegments(segments);
    const type = request.nextUrl.searchParams.get("type");
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return errorResponse("Request body must be a JSON object", 400);

    if (type === "mkdir") {
      const name = safeName(body.name);
      if (!name) return errorResponse("name must be a single path segment", 400);
      const target = destinationIn(source, name);
      if (destinationExists(target)) {
        return errorResponse(`"${name}" already exists here`, 409);
      }
      if (!(await isWritePathAllowed(target, { mustExist: false }, identity))) {
        return errorResponse("Access denied", 403);
      }
      // mkdir never destroys anything, but it is not harmless either: a
      // directory created inside the agent tree becomes a place omp reads.
      // `<runtime>/extensions` and `<runtime>/skills` are the concrete case —
      // both are loaded as executable or model-invoked content on the next
      // start, so this is a write to the boundary, not a housekeeping write.
      const refused = protectedRefusal(target, identity);
      if (refused) return refused;
      fs.mkdirSync(target);
      return NextResponse.json({ ok: true, path: target });
    }

    if (type === "rename") {
      const name = safeName(body.name);
      if (!name) return errorResponse("name must be a single path segment", 400);
      const destination = destinationIn(path.dirname(source), name);
      if (source === destination) return NextResponse.json({ ok: true, path: source });
      if (destinationExists(destination)) {
        return errorResponse(`"${name}" already exists in this folder`, 409);
      }
      const auth = await authorizeTransfer(source, destination, "move", identity);
      if (!auth.ok) return errorResponse("Access denied", 403, { reason: auth.reason });
      // Both operands, not just the new name. `destination` is a sibling of
      // `source`, so a rename cannot cross into another tree — which means a
      // check on the destination alone would read as "the folder is writable"
      // for every protected tree, and moving `~/.omp/agent` to
      // `~/.omp/agent.bak` would pass it. A rename is a delete of the old name
      // plus a write of the new one, so both are checked.
      for (const operand of [source, destination]) {
        const refused = protectedRefusal(operand, identity);
        if (refused) return refused;
      }
      // A directory cannot be renamed into itself or a descendant; the kernel
      // would reject it, but with an error the user cannot act on.
      if (isSameOrBelow(source, destination)) {
        return errorResponse("Cannot move a folder into itself", 400);
      }
      fs.renameSync(source, destination);
      return NextResponse.json({ ok: true, path: destination, previousPath: source });
    }

    if (type === "move" || type === "copy") {
      const targetDir = body.destination;
      if (typeof targetDir !== "string" || !isAbsolute(targetDir)) {
        return errorResponse("destination must be an absolute path", 400);
      }
      const destination = destinationIn(path.resolve(targetDir), path.basename(source));
      if (destination === source) {
        return NextResponse.json({ ok: true, path: source });
      }
      if (destinationExists(destination)) {
        return errorResponse(`"${path.basename(source)}" already exists at the destination`, 409);
      }

      const auth = await authorizeTransfer(source, destination, type, identity);
      if (!auth.ok) return errorResponse("Access denied", 403, { reason: auth.reason });

      // Both operands again, and here the two cases fail differently:
      //
      // - `move` destroys the source. Moving `~/.omp` out of the tree — to a
      //   scratch directory, a rename-friendly name, anywhere the allowlist
      //   permits — is the same loss as deleting it, with a step in between
      //   that looks like a rename.
      // - `copy` reads the source and writes the destination. Either half can
      //   be the violation: a protected source is an exfiltration primitive
      //   (the agent tree holds credentials and every transcript), and a
      //   protected destination is a write into a place omp later loads.
      //
      // `authorizeTransfer` already checks both halves for *writability* and
      // passes when both are writable, which is exactly the incident's shape.
      for (const operand of [source, destination]) {
        const refused = protectedRefusal(operand, identity);
        if (refused) return refused;
      }

      // Copying or moving a folder into itself recurses until the disk is
      // full, and the size guard below would only notice after the writes
      // started.
      if (isSameOrBelow(source, destination)) {
        return errorResponse("Cannot copy or move a folder into itself", 400);
      }

      if (type === "copy") {
        const size = treeSize(source);
        if (size > MAX_COPY_BYTES) {
          return errorResponse(
            `Refusing to copy ${(size / 1024 / 1024).toFixed(0)} MB; the limit is ${MAX_COPY_BYTES / 1024 / 1024} MB`,
            413,
          );
        }
        copyTree(source, destination);
      } else {
        // renameSync is atomic within a filesystem and throws EXDEV across
        // one. A copy-then-delete fallback would leave a half-moved tree if the
        // process died in between, so a cross-device move is reported rather
        // than attempted.
        try {
          fs.renameSync(source, destination);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EXDEV") {
            return errorResponse(
              "Source and destination are on different filesystems, which a move cannot span",
              409,
            );
          }
          throw error;
        }
      }
      return NextResponse.json({ ok: true, path: destination, previousPath: type === "move" ? source : undefined });
    }

    return errorResponse(`Unknown action "${type ?? ""}"`, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return errorResponse("Not found", 404);
    if (code === "ENOTEMPTY") return errorResponse("Target folder is not empty", 409);
    if (code === "EACCES" || code === "EPERM") return errorResponse("Permission denied by the operating system", 403);
    return errorResponse(message, 500);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  if (!isApiRequestAllowed(request)) {
    return errorResponse("Untrusted API request", 403);
  }

  try {
    const { path: segments } = await params;
    const target = filePathFromSegments(segments);

    // Same rule as POST: the identity is the only input to the decision, the
    // URL segment is only ever the thing being judged.
    const identity = getRequestIdentity(request.headers);
    if (!identity) return errorResponse("Access denied", 403);

    if (!(await isWritePathAllowed(target, { mustExist: true }, identity))) {
      return errorResponse("Access denied", 403);
    }

    // The check that was missing, and the one the writable-root test above
    // cannot substitute for. `isWritePathAllowed` answers "may this caller
    // write here", and a directory that a session once used as its cwd is
    // writable by construction — `~/.omp` was, because 129 chats ran there.
    // That answer is correct and useless here, because this call removes the
    // tree recursively. `protectedRootReason` answers the other question —
    // "may this be destroyed at all" — and it has no identity argument that
    // could talk its way past it, which is the property the incident turned
    // on: the guard that failed was reached through the caller's home.
    //
    // After `isWritePathAllowed`, not before it: the guard order here is
    // pinned by tests, and a caller with no write access gets the permission
    // error rather than learning which trees exist on this host.
    const refused = protectedRefusal(target, identity);
    if (refused) return refused;

    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) {
      // rmSync without recursive would fail on a populated folder. Recursive
      // deletion is the user's explicit action, and the writable-root check
      // above is what bounds it — but refuse the filesystem root outright,
      // because a root that somehow entered the writable set must not be
      // removable with one request. Unreachable while `isWritePathAllowed`
      // filters `/` out of the write set; kept as a second line under a
      // recursive delete, which is the wrong place to be short one.
      if (path.resolve(target) === path.parse(path.resolve(target)).root) {
        return errorResponse("Refusing to delete a filesystem root", 400);
      }
      fs.rmSync(target, { recursive: true, force: false });
    } else {
      fs.unlinkSync(target);
    }
    return NextResponse.json({ ok: true, path: target });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return errorResponse("Not found", 404);
    if (code === "ENOTEMPTY") return errorResponse("Target folder is not empty", 409);
    if (code === "EACCES" || code === "EPERM") return errorResponse("Permission denied by the operating system", 403);
    return errorResponse(message, 500);
  }
}
