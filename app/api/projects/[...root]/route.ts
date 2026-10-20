import { NextRequest, NextResponse } from "next/server";
import { DELETE as deleteFileActions } from "@/app/api/file-actions/[...path]/route";
import { DELETE as deleteSession } from "@/app/api/sessions/[id]/route";
import { listAllSessions } from "@/lib/session-reader";
import { isWritePathAllowed } from "@/lib/write-access";
import { getRequestIdentity, getUserHome, type WebIdentity } from "@/lib/request-identity";
import { isApiRequestAllowed } from "@/lib/request-security";
import { filePathFromSegments } from "@/lib/file-paths";
import { normalizeProjectRoot } from "@/lib/projects-schema";
import {
  countTreeEntries,
  DELETE_CONFIRMATION_CHAT_THRESHOLD,
  protectedRootReason,
  type ProjectDeletionPreview,
} from "@/lib/projects-delete";
import {
  getProjectsPath,
  isProjectsPathAllowed,
  readProjectsFile,
  writeProjectsFile,
} from "@/lib/projects-store";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/projects/[...root] (catch-all: an absolute project root
 * spans several segments, so `/home/pi/workspace/omp-web` is one root, not one
 * segment) — delete a project *and* its folder.
 *
 * ### Why this is a route and not a client-side sequence
 *
 * The plan had the browser call `DELETE /api/sessions/[id]` once per chat,
 * then `DELETE /api/file-actions/…`, then `PUT /api/projects`. That ordering
 * is a *convention*, and a convention is not a guarantee: a browser that
 * reloads halfway through leaves a folder with its chats already gone, and a
 * future caller that forgets step 2 removes chats without ever intending to.
 *
 * So the order lives here, in one handler, and it is the only thing that
 * deletes a project.
 *
 * ### The order, and why each step is where it is
 *
 * 1. **Refuse a protected folder, delete nothing.** `isProtectedProjectRoot`
 *    runs before *any* write — before the first session is touched. If it
 *    refuses, not one chat is deleted and the registry is unchanged. A folder
 *    is protected because deleting it is not recoverable by re-running the
 *    request; deleting the chats first would leave the user with a partially
 *    dismantled folder and no way back.
 *
 * 2. **Delete every session whose cwd is inside the folder, completely.**
 *    This must finish before the folder goes, because
 *    `DELETE /api/sessions/[id]` performs a *cascade re-parent*: it rewrites
 *    the header line of every sibling `.jsonl` that pointed at the deleted
 *    session (see `app/api/sessions/[id]/route.ts`, the `parentSessionPath`
 *    block). Those rewrites land in files that the folder deletion in step 3
 *    would then destroy — and a half-finished re-parent leaves orphaned
 *    records for whoever opens the folder next. If a session delete fails, we
 *    stop: the folder is still intact, and the failure is reported as
 *    "nothing was removed" rather than pretending otherwise.
 *
 * 3. **Delete the folder**, through the existing `file-actions` handler, so
 *    its own guards apply unchanged (`isApiRequestAllowed`,
 *    `getRequestIdentity`, `isWritePathAllowed`, the `lstat`, and the explicit
 *    refusal of a filesystem root).
 *
 * 4. **Drop the registry entry**, last. A registry entry pointing at a deleted
 *    folder would show a dead card; a missing entry for a folder that still
 *    exists is recoverable by re-adoption.
 *
 * ### What this route deliberately does not do
 *
 * It does not re-implement the cascade re-parent, the ownership check or the
 * write-allowlist. Steps 2 and 3 call the real handlers, which means their
 * guards — including `requireSessionAccess`, which answers 404 for a foreign
 * session — run exactly as they do for a direct request. A second
 * implementation of a delete would be a second thing to get wrong.
 */

function requireIdentity(req: Request): WebIdentity | null {
  const identity = getRequestIdentity(req.headers);
  if (identity === null) return null;
  return isProjectsPathAllowed(identity, getProjectsPath(identity)) ? identity : null;
}

/**
 * The identity headers, forwarded to a delegated handler.
 *
 * Delegation re-runs that handler's own guards, and those guards read the
 * identity from these headers. Forwarding them is what keeps
 * `requireSessionAccess` judging a session against the account that asked to
 * delete it — an anonymous forwarded request would be refused for every
 * session, which is correct behaviour and useless here.
 */
function forwardedHeaders(request: Request): HeadersInit {
  return {
    "x-omp-user": request.headers.get("x-omp-user") ?? "",
    "x-omp-admin": request.headers.get("x-omp-admin") ?? "",
    host: request.headers.get("host") ?? "localhost",
  };
}

/**
 * Sessions a delete of `root` would remove: everything whose cwd *is* the root
 * or lies below it.
 *
 * Below, not only equal — a chat that ran in `project/src` would otherwise
 * survive as a record pointing at a folder that no longer exists. It is the
 * same predicate the delete itself uses, factored out, because the count the
 * user confirms and the set the server deletes must not be able to disagree.
 */
function sessionsInside(sessions: readonly { id: string; cwd: string }[], root: string) {
  return sessions.filter(
    (session) =>
      session.cwd === root || (typeof session.cwd === "string" && session.cwd.startsWith(`${root}/`)),
  );
}

/**
 * What a delete of `root` would destroy, computed without destroying anything.
 *
 * ### Why this exists separately from `isProtectedProjectRoot`
 *
 * The protection rule answers "may this be deleted at all". It cannot answer
 * "how much goes", and on 2026-10-20 the amount was 130 chats. So the amount is
 * measured, and a delete above the threshold is refused until the request
 * carries a confirmation that names the number the server itself computed.
 *
 * ### Why the number is recomputed here instead of taken from the client
 *
 * A client-supplied count is a suggestion. The confirmation is compared against
 * this count, computed after the guards and immediately before the first write,
 * so a caller that shows a stale number — or none — gets a refusal rather than
 * a silent delete. The client's value is a *promise* that it showed the user;
 * the server's is the fact.
 */
async function buildPreview(
  root: string,
  identity: WebIdentity,
): Promise<ProjectDeletionPreview> {
  const sessions = await listAllSessions({ identity });
  const inside = sessionsInside(sessions, root);
  const { entryCount, entriesTruncated } = countTreeEntries(root);

  return {
    sessionCount: inside.length,
    sessionIds: inside.map((session) => session.id),
    entryCount,
    entriesTruncated,
    requiresConfirmation: inside.length >= DELETE_CONFIRMATION_CHAT_THRESHOLD,
  };
}

/**
 * The confirmation the client has to send back: the count of chats it says the
 * user was shown, as a string in `x-omp-delete-confirm`.
 *
 * A string comparison, not a boolean, is the whole design. `confirm: true`
 * proves only that *something* was clicked; `confirm: "130"` proves the caller
 * held the number 130 when it clicked, and lets the server refuse when the real
 * number has moved on since — the case where a user confirms "3 chats" and the
 * folder turns out to hold 130.
 */
function confirmedChatCount(request: Request): string | null {
  const raw = request.headers.get("x-omp-delete-confirm");
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return /^\d{1,9}$/.test(trimmed) ? trimmed : null;
}

/**
 * GET /api/projects/[...root] — what a delete would remove, before asking.
 *
 * Same guards as the delete, in the same order, so a preview cannot report a
 * number for a folder the delete would refuse. That is the point of it: the
 * client that shows "130 chats" and the server that deletes 130 chats must be
 * looking at the same folder under the same rules.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ root: string[] }> },
) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireIdentity(request);
  if (identity === null) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  try {
    const { root: segments } = await params;
    const root = normalizeProjectRoot(filePathFromSegments(segments));
    if (root === null) {
      return NextResponse.json({ error: "Invalid project root" }, { status: 400 });
    }

    const reason = protectedRootReason(root, getUserHome(identity));
    if (reason !== null) {
      return NextResponse.json(
        { error: "This folder is protected and cannot be deleted", code: "protected", reason },
        { status: 403 },
      );
    }

    if (!(await isWritePathAllowed(root, { mustExist: true }, identity))) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const preview = await buildPreview(root, identity);
    return NextResponse.json({ root, ...preview });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ root: string[] }> },
) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireIdentity(request);
  if (identity === null) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  try {
    const { root: segments } = await params;
    // The segments come from a catch-all param, so the path has to be
    // reassembled — including its leading slash. Joining the filtered segments
    // alone would turn `/etc` into `etc`, a relative path that every check
    // downstream rejects for the wrong reason.
    //
    // Next has *already* percent-decoded the segments, so they must not be
    // decoded a second time here: a folder literally named `100%` would make
    // `decodeURIComponent` throw and turn a valid delete into a 500.
    const root = normalizeProjectRoot(filePathFromSegments(segments));
    if (root === null) {
      return NextResponse.json({ error: "Invalid project root" }, { status: 400 });
    }

    // (1) The protection check, before any write at all.
    //
    // `getUserHome(identity)` and not `os.homedir()`: the process runs as one
    // account while serving several identities, so "the home" is a property of
    // the caller. Passing the wrong one would compare every path against the
    // wrong tree and refuse or allow the wrong folders.
    //
    // The *reason* is reported alongside the refusal because "protected" alone
    // does not tell the user which rule spoke. Measured 2026-10-20: the admin
    // whose home is `/` got no answer at all from the home rules for
    // `~/.omp`, and the runtime rule is what closes that.
    const reason = protectedRootReason(root, getUserHome(identity));
    if (reason !== null) {
      return NextResponse.json(
        { error: "This folder is protected and cannot be deleted", code: "protected", reason },
        { status: 403 },
      );
    }

    // The folder must be inside this identity's writable roots before
    // anything is deleted. Checked here as well as inside the file-actions
    // handler, so a refusal costs no session deletions.
    if (!(await isWritePathAllowed(root, { mustExist: true }, identity))) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // (1b) Count what this would destroy, before the first write.
    //
    // Independent of the rule above on purpose. `isProtectedProjectRoot` is a
    // hard "never" for a folder that must not be deleted at all; this is the
    // second layer for a folder that *may* be deleted but is not what the user
    // had in mind. On 2026-10-20 a wrong path was a legitimate project by every
    // rule in the first layer, and 130 chats went with it.
    const preview = await buildPreview(root, identity);

    if (preview.requiresConfirmation) {
      const confirmed = confirmedChatCount(request);
      if (confirmed === null) {
        // Nothing confirmed yet. The response carries the count so the client
        // can show it and send it back — and the folder is untouched.
        return NextResponse.json(
          {
            error: `This project has ${preview.sessionCount} chats; confirming the delete is required`,
            code: "confirmation-required",
            ...preview,
          },
          { status: 409 },
        );
      }
      if (confirmed !== String(preview.sessionCount)) {
        // The number moved between the preview and the confirmation. Refusing
        // is the only honest answer: the user confirmed a count that is no
        // longer the truth, which is exactly the mistake this layer exists for.
        return NextResponse.json(
          {
            error:
              `The chat count changed since it was confirmed ` +
              `(confirmed ${confirmed}, now ${preview.sessionCount}); nothing was deleted`,
            code: "confirmation-stale",
            ...preview,
          },
          { status: 409 },
        );
      }
    }

    const inside = await listAllSessions({ identity }).then((sessions) =>
      // Recomputed rather than reusing `preview.sessionIds`: between the count
      // and here a session could have been created, and deleting the preview's
      // list would leave that one behind pointing at a folder that is gone.
      // The confirmation compared against `preview.sessionCount`, so a count
      // that grew in between is caught by the confirmation check above only if
      // it grew *before* it; this keeps the delete and the preview consistent
      // in the other direction.
      sessionsInside(sessions, root),
    );

    // (2) Every session, fully, before the folder goes.
    for (const session of inside) {
      const response = await deleteSession(
        new Request(`http://localhost/api/sessions/${encodeURIComponent(session.id)}`, {
          method: "DELETE",
          headers: forwardedHeaders(request),
        }),
        { params: Promise.resolve({ id: session.id }) },
      );

      if (!response.ok) {
        // Stop with the folder intact. Some sessions may already be gone —
        // that is stated in the response rather than hidden, because the user
        // has to know what state the folder is in.
        const deleted = inside.indexOf(session);
        return NextResponse.json(
          {
            error: "Deleting a chat failed; the folder was left untouched",
            code: "session-delete-failed",
            sessionsDeleted: deleted,
            sessionsTotal: inside.length,
          },
          { status: 409 },
        );
      }
    }

    // (3) The folder, through the existing handler and its guards.
    const folderResponse = await deleteFileActions(
      new NextRequest(
        `http://localhost/api/file-actions/${root.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`,
        { method: "DELETE", headers: forwardedHeaders(request) },
      ),
      { params: Promise.resolve({ path: root.split("/").filter((segment) => segment !== "") }) },
    );

    if (!folderResponse.ok) {
      const body = await folderResponse.json().catch(() => ({}) as { error?: string });
      return NextResponse.json(
        { error: body.error ?? "Unable to delete the folder", code: "folder-delete-failed" },
        { status: folderResponse.status },
      );
    }

    // (4) The registry entry, last.
    const stored = readProjectsFile(identity);
    if (stored) {
      writeProjectsFile(identity, {
        ...stored,
        projects: stored.projects.filter((project) => project.root !== root),
      });
    }

    return NextResponse.json({ ok: true, root, sessionsDeleted: inside.length });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}