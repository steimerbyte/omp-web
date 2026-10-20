import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { isPathWithinRoots } from "./path-security";
import { getUserHome, type WebIdentity } from "./request-identity";
import { resolveTenantAgentDir } from "./tenant-config";
import { normalizeProjectsFile, type ProjectMeta, type ProjectsFile } from "./projects-schema";

/**
 * The server-side store for the projects dashboard: one file per account.
 *
 * Every choice here mirrors `lib/quick-phrases-store.ts`, deliberately. That
 * module already answers the three questions this one has — where does a
 * per-account file go, how is the path accepted, how is it written so a crash
 * cannot tear it — and a second answer to any of them is a second boundary.
 *
 * The `omp-web-` prefix matches `omp-web-quick-phrases.json` and
 * `omp-web-trusted-projects.json`: the file sits in the agent directory but is
 * not omp configuration. omp never reads it and must never overwrite it.
 */
const STORE_FILE = "omp-web-projects.json";

/**
 * The registry path of one identity.
 *
 * `resolveTenantAgentDir` puts the tenant boundary in the path: for an admin
 * the global agent dir, for a tenant `<home>/<name>/.omp/agent`.
 */
export function getProjectsPath(identity: WebIdentity): string {
  return join(resolveTenantAgentDir(identity), STORE_FILE);
}

/**
 * `true` when the registry path lies below the account's own home.
 *
 * The derivation is not the acceptance. `resolveTenantAgentDir` is how the path
 * is *computed*; this asks whether the finished path is actually inside
 * `getUserHome(identity)`. It is the second layer, and it catches the case the
 * derivation cannot know: an account whose `OMP_WEB_HOME_ROOT` points
 * somewhere else. Same check, same reason, as
 * `isQuickPhrasesPathAllowed`.
 */
export function isProjectsPathAllowed(identity: WebIdentity, path: string): boolean {
  return isPathWithinRoots(path, new Set([getUserHome(identity)]));
}

/**
 * The stored registry, or `null` when there is no file yet.
 *
 * `null` is not "an empty registry". An empty registry is a decision the user
 * made — every project deleted — and it must survive a reload. `null` means
 * "this account has never had one", which is what lets the route adopt the
 * existing project folders from the session list exactly once.
 */
export function readProjectsFile(identity: WebIdentity): ProjectsFile | null {
  const path = getProjectsPath(identity);
  if (!existsSync(path)) return null;
  try {
    return normalizeProjectsFile(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // Unreadable content counts as "not absent" but not as "has content": the
    // caller gets defaults and an existing file, so a seed cannot run over a
    // damaged registry and destroy entries the user can neither see nor
    // defend. The file is deliberately *not* rewritten here — a read that
    // repairs state hides the damage from whoever has to clean it up.
    return normalizeProjectsFile(null);
  }
}

/**
 * Write the registry atomically, `0o600`, in a `0o700` directory.
 *
 * `writePrivateFileAtomicSync` writes a temp file with `wx` and renames it, so
 * a crash mid-write leaves the previous file rather than half of one. The
 * registry is the only record of which folders the dashboard may delete, and a
 * truncated one would be a list of paths with nothing to check them against.
 */
export function writeProjectsFile(identity: WebIdentity, file: ProjectsFile): ProjectsFile {
  const path = getProjectsPath(identity);
  const normalized = normalizeProjectsFile(file);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, JSON.stringify(normalized, null, 2) + "\n");
  return normalized;
}

/**
 * Add projects that are not in the registry yet.
 *
 * Used once, for the folders that already exist on disk before the dashboard
 * did. Without it the dashboard would open empty on an account with nine
 * projects, and every one of them would have to be re-added by hand.
 *
 * Adoption is conservative in three ways: existing entries are never touched,
 * an adopted project starts at the lowest priority, and it is flagged
 * `adopted` so the UI can say it was inferred rather than chosen.
 */
export function adoptProjects(
  existing: readonly ProjectMeta[],
  candidates: readonly { root: string }[],
  now = new Date(),
): ProjectMeta[] {
  const known = new Set(existing.map((project) => project.root));
  const adopted: ProjectMeta[] = [];
  for (const candidate of candidates) {
    if (known.has(candidate.root)) continue;
    known.add(candidate.root);
    const timestamp = now.toISOString();
    adopted.push({
      root: candidate.root,
      priority: "parked",
      openTodos: 0,
      status: "yellow",
      createdAt: timestamp,
      lastTouchedAt: timestamp,
      adopted: true,
      sizeBytes: null,
    });
  }
  return adopted;
}