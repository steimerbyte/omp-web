import { NextResponse } from "next/server";
import { getAllowedFileRoots } from "@/lib/file-access";
import { listAllSessions } from "@/lib/session-reader";
import { getRequestIdentity, getUserHome, type WebIdentity } from "@/lib/request-identity";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { resolveProject } from "@/lib/worktree";
import {
  DEFAULT_PRIORITIES,
  applyProjectPatches,
  applySizeMeasurements,
  isSizeMeasurementStale,
  mergePriorityPatches,
  mergeProjectPatches,
  projectDisplayName,
  sortProjectViews,
  type ProjectView,
  type ProjectsFile,
} from "@/lib/projects-schema";
import { measureProjectSizes } from "@/lib/project-size";
import {
  adoptProjects,
  getProjectsPath,
  isProjectsPathAllowed,
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
 * The guards below are `requireIdentity` from `lib/request-identity.ts` — not
 * an inline `identity.isAdmin`, and not a private copy of the check. See the
 * note at `app/api/web-access/route.ts`: on 12.10.2026 a route skipped its
 * guard with a comment claiming the proxy had covered it, and that gap is how
 * `bob` turned the password lock off.
 */
function requireIdentity(req: Request): WebIdentity | null {
  const identity = getRequestIdentity(req.headers);
  if (identity === null) return null;
  // The derived path is checked against the account's own home before any
  // directory is touched — the same second layer
  // `isQuickPhrasesPathAllowed` adds, catching an identity whose
  // `OMP_WEB_HOME_ROOT` points somewhere foreign.
  return isProjectsPathAllowed(identity, getProjectsPath(identity)) ? identity : null;
}

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
  const identity = requireIdentity(req);
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

    // Measure synchronously, bounded per project and capped in parallel
    // (`lib/project-size.ts`). Deferred measurement was rejected: a value that
    // arrives on a poll nobody triggers is a value that never arrives. A folder
    // that cannot be measured within the budget reports `null` and the card
    // simply shows no size — honest, rather than a number that is not there yet.
    const stale = file.projects.filter((project) => isSizeMeasurementStale(project));
    const measurements =
      stale.length > 0 ? await measureProjectSizes(stale.map((project) => project.root)) : new Map();
    const measuredAt = new Date().toISOString();
    const withSizes = applySizeMeasurements(file.projects, measurements, measuredAt);

    // Only persist when something was actually measured, so a GET that found
    // everything cached does not rewrite the file on every poll.
    if (stale.length > 0) {
      writeProjectsFile(identity, { ...file, projects: withSizes });
    }

    const all = await buildProjectViews(identity, { ...file, projects: withSizes });
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
  const identity = requireIdentity(req);
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