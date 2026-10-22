import { NextResponse } from "next/server";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAllowedFileRoots } from "@/lib/file-access";
import { allowFileRoot } from "@/lib/allowed-roots";
import { listAllSessions } from "@/lib/session-reader";
import { getUserHome, isAdminIdentity, type WebIdentity } from "@/lib/request-identity";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { isPathWithinRoots } from "@/lib/path-security";
import { resolveProject, initRepository } from "@/lib/worktree";
import { isProtectedProjectRoot } from "@/lib/projects-delete";
import { requireProjectsIdentity } from "@/lib/projects-guards";
import {
  DEFAULT_PRIORITIES,
  applyProjectPatches,
  isPriorityId,
  isValidProjectFolderName,
  mergePriorityPatches,
  mergeProjectPatches,
  normalizeProjectMeta,
  normalizeProjectRoot,
  projectDisplayName,
  sortProjectViews,
  type PriorityId,
  type ProjectView,
  type ProjectsFile,
} from "@/lib/projects-schema";
import { startProjectSizeMeasurement } from "@/lib/projects-sizes";
import {
  adoptProjects,
  readProjectsFile,
  writeProjectsFile,
} from "@/lib/projects-store";

export const dynamic = "force-dynamic";

/**
 * GET/PUT /api/projects — the projects dashboard registry.
 *
 * Modelled on `app/api/quick-phrases/route.ts`, which is the same shape of
 * problem: exactly one file per account, no generic key-value store behind it.
 * A store a client can write arbitrary keys into would be a *new* tenant
 * boundary rather than a solved one.
 *
 * ### Why not `requireAdmin`
 *
 * The registry is per account, like the phrases list. Making it admin-only
 * would mean a tenant cannot manage their own dashboard at all. What *is*
 * host-wide is the allow-list grant that project creation implies, and that
 * one is handled by the create path, not here.
 *
 * ### The guard is shared, not copied
 *
 * The identity check is `requireProjectsIdentity` from
 * `lib/projects-guards.ts` — not an inline `identity.isAdmin`, and not a
 * private copy of the check. The second route that needed it,
 * `GET /api/projects/sizes`, uses the same function; a copy would be a
 * second thing to get wrong, and `AGENTS.md` is explicit about that. See
 * the note at `app/api/web-access/route.ts`: on 12.10.2026 a route skipped
 * its guard with a comment claiming the proxy had covered it, and that gap
 * is how `bob` turned the password lock off.
 */

/**
 * Load the registry, adopting the folders that already exist on disk.
 *
 * The adoption runs only while there is *no* file. Once a file exists — even
 * one with an empty `projects` array — it is the answer, because "every
 * project deleted" is a decision the user made and a re-seed would undo it
 * behind their back.
 */
function loadOrAdopt(identity: WebIdentity, sessionRoots: readonly string[]): ProjectsFile {
  const stored = readProjectsFile(identity);
  if (stored) return stored;

  const adopted: ProjectsFile = {
    schemaVersion: 1,
    projects: adoptProjects([], sessionRoots.map((root) => ({ root }))),
    priorities: DEFAULT_PRIORITIES.map((priority) => ({ ...priority })),
  };
  return writeProjectsFile(identity, adopted);
}

/**
 * Join the registry with everything derivable from the session list.
 *
 * Only the sessions belonging to this identity are scanned: `listAllSessions`
 * returns the unfiltered cache and filters on the identity it is given, which
 * is the same order every other session route uses.
 */
async function buildProjectViews(
  identity: WebIdentity,
  file: ProjectsFile,
): Promise<ProjectView[]> {
  const sessions = await listAllSessions({ identity });

  // chatCount / lastSessionAt per root, in one pass over the session list.
  const stats = new Map<string, { chats: number; lastSessionAt: string | null }>();
  for (const session of sessions) {
    const root = session.projectRoot ?? session.cwd;
    if (!root) continue;
    const entry = stats.get(root) ?? { chats: 0, lastSessionAt: null };
    entry.chats += 1;
    if (entry.lastSessionAt === null || session.modified > entry.lastSessionAt) {
      entry.lastSessionAt = session.modified;
    }
    stats.set(root, entry);
  }

  const projects = await Promise.all(
    file.projects.map(async (project): Promise<ProjectView> => {
      const stat = stats.get(project.root);
      const lastSessionAt = stat?.lastSessionAt ?? null;
      // The card shows the later of the two: "touched on purpose" and "a chat
      // ran here" are different facts and either can be the more recent one.
      const lastActivityAt =
        lastSessionAt !== null && lastSessionAt > project.lastTouchedAt
          ? lastSessionAt
          : project.lastTouchedAt;

      // `resolveProject` is the git-derived view; it is an *attribute* of the
      // folder here, not its identity. A non-git folder resolves to itself with
      // `branch: null`, which is the card's "kein Repo" row.
      const resolved = await resolveProject(project.root);

      return {
        ...project,
        name: projectDisplayName(project.root),
        chatCount: stat?.chats ?? 0,
        lastSessionAt,
        isGit: resolved.branch !== null || resolved.isWorktree,
        branch: resolved.branch,
        lastActivityAt,
        // The answer, not the rule: the browser cannot run
        // `isProtectedProjectRoot` (it reads the identity's home and the
        // filesystem), so it is computed here and shipped. `getUserHome`, not
        // `os.homedir()` — see the delete route for why the home is a property
        // of the caller.
        isProtected: isProtectedProjectRoot(project.root, getUserHome(identity)),
      };
    }),
  );

  return sortProjectViews(projects);
}

/**
 * `true` when this identity may see this folder at all.
 *
 * Filtering happens on *this* identity's allowed roots, so a project that
 * another account added to its own registry does not appear here with a path
 * this account cannot open. Hidden rather than refused: the request itself was
 * legitimate, and a 403 would confirm that something exists over there.
 */
async function isVisibleTo(identity: WebIdentity, root: string): Promise<boolean> {
  const allowed = await getAllowedFileRoots(identity);
  if (allowed.size === 0) return false;
  const resolved = root.replace(/\\/g, "/");
  for (const allowedRoot of allowed) {
    const base = allowedRoot.replace(/\\/g, "/").replace(/\/$/, "");
    if (resolved === base || resolved.startsWith(`${base}/`)) return true;
  }
  return false;
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireProjectsIdentity(req);
  if (identity === null) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  try {
    const sessions = await listAllSessions({ identity });
    const sessionRoots = [
      ...new Set(
        sessions
          .map((session) => session.projectRoot ?? session.cwd)
          .filter((root): root is string => typeof root === "string" && root !== ""),
      ),
    ];

    const file = loadOrAdopt(identity, sessionRoots);

    // The folder sizes are *not* measured here any more. They used to be,
    // and one measurement of the 18 roots of a real registry takes 20,5 s
    // (measured 2026-10-22 on the dev host, the details in
    // `lib/project-size.ts`) — twenty seconds of nothing on the screen,
    // because the request could not answer before the measurement was done.
    //
    // The measurement runs in the background now
    // (`lib/projects-sizes.ts`): this request ships the last known sizes,
    // the run replaces them when it is done, and the client picks them up
    // from `GET /api/projects/sizes`.
    //
    // The deferred measurement was rejected once, and the reason is worth
    // keeping: "a value that arrives on a poll nobody triggers is a value
    // that never arrives". That rejection was of the *missing trigger*, not
    // of deferral. Nobody triggered the poll then; the poll exists now, and
    // the sizes endpoint triggers the run itself, so the value does arrive.
    startProjectSizeMeasurement(identity);

    const all = await buildProjectViews(identity, file);
    const visibleProjects = (
      await Promise.all(
        all.map(async (project) => ((await isVisibleTo(identity, project.root)) ? project : null)),
      )
    ).filter((project): project is ProjectView => project !== null);

    return NextResponse.json({
      projects: visibleProjects,
      priorities: file.priorities,
      home: getUserHome(identity),
    });
  } catch {
    return NextResponse.json({ error: "Unable to read projects" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireProjectsIdentity(req);
  if (identity === null) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body: unknown = await req.json();
    const stored = readProjectsFile(identity);
    const current: ProjectsFile = stored ?? {
      schemaVersion: 1,
      projects: [],
      priorities: DEFAULT_PRIORITIES.map((priority) => ({ ...priority })),
    };

    const merged = mergeProjectPatches(current.projects, body);
    if (!merged.ok) {
      return NextResponse.json({ error: merged.error }, { status: 400 });
    }

    // `root`, `createdAt`, `adopted` and the size cache are the store's. A
    // merge rather than a replace is what keeps a client from attaching its
    // metadata to a folder it never added, and from removing projects by
    // simply omitting them.
    const next: ProjectsFile = {
      schemaVersion: 1,
      projects: applyProjectPatches(current.projects, merged.patches),
      priorities: mergePriorityPatches(current.priorities, body),
    };

    const written = writeProjectsFile(identity, next);
    const views = await buildProjectViews(identity, written);
    // The client gets the validated state back, not its own unvalidated input.
    return NextResponse.json({ projects: views, priorities: written.priorities });
  } catch {
    return NextResponse.json({ error: "Unable to save projects" }, { status: 500 });
  }
}

/**
 * POST /api/projects — create a project, which means creating its folder.
 *
 * ### The guard chain, and the order it runs in
 *
 * `isApiRequestAllowed` → `requireProjectsIdentity` → `hasJsonContentType` → name
 * validation → path check → protection check → existence check → `mkdir`.
 *
 * The first three are byte-for-byte the chain PUT runs, and deliberately:
 * this is the same resource with one method more, and a second set of guards
 * would be a second thing to get wrong. In particular there is **no**
 * `requireAdmin` — the registry is per account (see the note at the top of
 * this file), so a tenant managing their own dashboard is the normal case.
 *
 * The rest is the part the order is about. Everything that can *write* to the
 * filesystem — `mkdirSync`, `allowFileRoot`, the registry write — sits behind
 * every check, and the name is validated before the path is even joined. The
 * reverse order is the bug `bin/web-auth-store.js` documents: a `400` that
 * arrives after a `mkdir` has already created `../etc` is a refusal that cost
 * something.
 *
 * ### What the identity is allowed to grant
 *
 * `allowFileRoot` is process-wide state, so it stays admin-gated exactly as
 * `AGENTS.md` requires for `/api/cwd/validate` and `/api/default-cwd`: a
 * tenant's folder is checked against their own home and **nothing** is
 * granted, because a grant made by one user would widen the filesystem for
 * every other operator in the process, permanently. That is also why the
 * "New project" button is admin-only in the dashboard — not a cosmetic
 * choice.
 *
 * ### An existing folder is refused, not adopted
 *
 * 409, and this is the honest answer rather than the convenient one. The
 * dashboard's promise is "the folder *is* the project" — deleting a project
 * recursively deletes that folder and every chat inside it. Silently adopting
 * `~/Documents` because the user typed its name would put an unrecoverable
 * delete button on a folder nobody asked to create. Refusing keeps the
 * invariant true: everything on the board was created by this endpoint.
 *
 * The registry already contains an entry for a folder whose directory was
 * removed by hand, so that case is answered too — re-creating the folder is
 * allowed there, because the existing entry is this account's own record of a
 * project, not a foreign folder.
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireProjectsIdentity(req);
  if (identity === null) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body: unknown = await req.json();
    const raw = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

    // Before any path is joined. `isValidProjectFolderName` is the single
    // definition of a legal folder name (see `lib/projects-schema.ts`); the
    // dialog's copy exists to give the same answer without a round trip.
    if (!isValidProjectFolderName(raw.name)) {
      return NextResponse.json(
        { error: "A project name must be kebab-case, without path separators" },
        { status: 400 },
      );
    }
    const priority: PriorityId = isPriorityId(raw.priority) ? raw.priority : "later";

    // The home of the *identity*, not `homedir()` of the service process:
    // the process serves several identities from one tree, so "the home" is a
    // property of the caller.
    const home = getUserHome(identity);
    const workspace = join(home, "workspace");
    const root = normalizeProjectRoot(join(workspace, raw.name));
    if (root === null || !isPathWithinRoots(root, new Set([workspace]))) {
      // Unreachable given the name check above — `join` of a segment with no
      // separator cannot leave its parent. It stays because this is the
      // boundary that runs `mkdir`, and a check that only holds because of a
      // property of a *different* function is not a check.
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // `isProtectedProjectRoot` on the *child*. Not on `<home>/workspace` as
    // well: `lib/projects-delete.ts` protects every depth-1 folder under the
    // home, so the workspace directory is itself "protected" by that rule and
    // asking about it would refuse every project this endpoint exists to
    // create. That rule exists to stop a *delete* from eating `~/Documents`;
    // it says nothing about writing a new folder two levels down, which is
    // exactly what this is. The child check still runs because it is the
    // question that matters — a home that resolves into a system root, or a
    // named protected home child further down — and because it is the one a
    // future change to the derived path has to keep passing.
    if (isProtectedProjectRoot(root, home)) {
      return NextResponse.json(
        { error: "This location is protected and cannot be used for a project", code: "protected" },
        { status: 403 },
      );
    }

    const stored = readProjectsFile(identity);
    const current: ProjectsFile = stored ?? {
      schemaVersion: 1,
      projects: [],
      priorities: DEFAULT_PRIORITIES.map((priority) => ({ ...priority })),
    };
    const alreadyRegistered = current.projects.some((project) => project.root === root);

    // `mkdirSync({recursive: true})` would succeed silently on an existing
    // directory, which would turn "create" into "adopt" — see the note above.
    // Re-creating a folder this account already had a card for is the one
    // exception, and it is the exception because the registry entry is this
    // account's own record rather than a foreign folder.
    if (!alreadyRegistered && existsSync(root)) {
      return NextResponse.json(
        { error: "A folder with this name already exists", code: "exists" },
        { status: 409 },
      );
    }

    mkdirSync(root, { recursive: true });

    // `initGit` is the client's checkbox, and it is honoured here rather than
    // ignored: a folder the card then reports as "kein Repo" because the
    // server dropped the flag would be a silent lie. `resolveProject`
    // (`lib/worktree.ts`) reads the repo the same way the card does.
    if (raw.initGit === true) {
      await initRepository(root);
    }

    const now = new Date().toISOString();
    // Server-owned fields, exactly as in PUT: the client chose a name and a
    // category, and nothing else. `root` is derived here, `createdAt` and
    // `adopted` are facts about how the entry came to exist, and the size
    // cache belongs to the next GET.
    const entry = normalizeProjectMeta(
      {
        root,
        priority,
        openTodos: 0,
        status: "yellow",
        createdAt: now,
        lastTouchedAt: now,
        adopted: false,
      },
    );
    if (entry === null) {
      return NextResponse.json({ error: "Invalid project" }, { status: 400 });
    }

    const next: ProjectsFile = {
      schemaVersion: 1,
      // Replace rather than append: a re-created folder keeps its identity,
      // and two cards for one path is the duplicate the normalization exists
      // to prevent.
      projects: [...current.projects.filter((project) => project.root !== root), entry],
      priorities: current.priorities,
    };
    const written = writeProjectsFile(identity, next);

    // Admin-only, with the identity as the argument. Without it the grant
    // lands in the unattributed bucket (`AGENTS.md`), which is visible to
    // every admin rather than to the account that created the project.
    if (isAdminIdentity(identity)) {
      allowFileRoot(root, identity);
    }

    const views = await buildProjectViews(identity, written);
    return NextResponse.json(
      { projects: views, priorities: written.priorities, root },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to create the project" },
      { status: 500 },
    );
  }
}