import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, realpathSync, statSync } from "fs";
import type { Stats } from "fs";
import { homedir } from "os";
import path from "path";
import { getAdditionalAllowedRoots, getAllowedRootsCache, identityKey, normalizeSlashes } from "./allowed-roots";
import { isExistingPathWithinRoots, isPathWithinRoots } from "./path-security";
import { listAllSessions } from "./session-reader";
import { getUserHome, type WebIdentity } from "./request-identity";
export { allowFileRoot, normalizeSlashes } from "./allowed-roots";

// Short-TTL cache of the allowed-roots set. Without this, every file list/read
// request re-scans every pi session on disk just to check access. 5s is short
// enough that newly-created cwds appear promptly. Keyed by identity, because
// the set is per-identity now: a single cached union would hand one account the
// roots of another.
const ALLOWED_ROOTS_TTL_MS = 5_000;
const WINDOWS_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;

export function isWindowsAbsolutePath(filePath: string): boolean {
  return WINDOWS_ABSOLUTE_RE.test(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("//");
}

/**
 * The roots `identity` may read.
 *
 * The argument is mandatory in the type but nullable in fact: a request whose
 * identity could not be established gets an empty set. That is the whole
 * contract. `listAllSessions()` is *not* called in that case, because it
 * returns every session on the machine including other tenants' — the
 * unfiltered scan would rebuild the very root set the identity is there to
 * narrow, and an empty result is the only genuinely safe one.
 *
 * Sessions are filtered by the same identity that gates the result, so another
 * tenant's cwd never becomes a root here.
 *
 * The filter is not enough on its own, and that is why the `cwd` is checked
 * again below: a session in the requesting account's own archive answers the
 * ownership question with the `cwd` written **inside** the file, and a tenant
 * can write that file (its worker has exactly its own home bound). Measured
 * 2026-11-08: a non-admin wrote `{"type":"session","cwd":"/"}` into its own
 * sessions directory and `GET /api/files/etc/passwd` answered 200. The
 * archive reader rejects such a record now, and this second check makes the
 * root set safe even if a future caller hands over an unfiltered list.
 */
export async function getAllowedFileRoots(identity: WebIdentity | null): Promise<Set<string>> {
  if (!identity) return new Set<string>();

  const key = identityKey(identity);
  const now = Date.now();
  const cache = getAllowedRootsCache();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.roots;

  const sessions = await listAllSessions({ identity });
  const roots = new Set<string>();
  // Der zweite Schnitt. Fuer einen Nicht-Admin darf ein `cwd` nur dann Wurzel
  // werden, wenn er in seinem Home liegt — dieselbe Regel, die
  // `isSessionOwnedBy` fuer den Prozess-Baum zieht. Ohne diesen Test haengt die
  // ganze Grenze an der Frage, ob die Session-Liste schon gefiltert ist, und
  // das ist eine Annahme ueber einen Aufrufer, kein Zustand. Ein Admin behaelt
  // `/`, deshalb ist die Pruefung fuer ihn eine no-op.
  const ownHome = identity.isAdmin ? null : normalizeSlashes(getUserHome(identity));
  const insideOwnHome = (candidate: string): boolean => {
    if (ownHome === null) return true;
    const value = normalizeSlashes(candidate);
    return value === ownHome || value.startsWith(`${ownHome}/`);
  };
  for (const s of sessions) {
    if (s.cwd && insideOwnHome(s.cwd)) roots.add(normalizeSlashes(s.cwd));
    // The project root (main repo shared by all worktrees) is browsable too —
    // the project dropdown lists it even when only worktrees have sessions.
    if (s.projectRoot && insideOwnHome(s.projectRoot)) roots.add(normalizeSlashes(s.projectRoot));
  }

  // Also allow ~/omp-cwd-* directories created by the default-cwd endpoint.
  // Scanned in the *requesting* account's home, not `homedir()`: the service
  // runs as one account, so scanning the process home handed every logged-in
  // user the service account's scratch directories as browsable roots — a
  // cross-tenant read that no identity check could catch afterwards, because by
  // then the path was in the allowlist. For an admin the two coincide.
  try {
    const ownHome = identity.isAdmin ? homedir() : getUserHome(identity);
    const realHome = realpathSync(ownHome);
    for (const name of readdirSync(ownHome)) {
      if (!/^omp-cwd-\d{8}$/.test(name)) continue;
      const candidate = path.join(ownHome, name);
      // `lstatSync`, not `statSync`: a symlink is not a scratch directory.
      // OMP-006 was exactly this — an `omp-cwd-*` link pointed outside the
      // home, the link path entered this set as a root, and every later check
      // is measured against this set (its symlinks are resolved too). So a
      // root has to be a real directory that resolves inside the home; a link
      // that leaves it grants the target and is refused here.
      try {
        if (!lstatSync(candidate).isDirectory()) continue;
        if (!isPathWithinRoots(realpathSync(candidate), new Set([realHome]))) continue;
      } catch {
        continue;
      }
      roots.add(normalizeSlashes(candidate));
    }
  } catch {
    // ignore if home is unreadable or does not exist
  }

  for (const root of getAdditionalAllowedRoots(identity)) roots.add(root);

  cache.set(key, { roots, expiresAt: now + ALLOWED_ROOTS_TTL_MS });
  return roots;
}

export function isFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  for (const root of allowedRoots) {
    const useWindowsRules = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
    const resolver = useWindowsRules ? path.win32 : path;
    const sep = useWindowsRules ? "\\" : path.sep;
    const normalized = resolver.resolve(target);
    const normalizedRoot = resolver.resolve(root);
    const comparable = useWindowsRules ? normalized.toLowerCase() : normalized;
    const comparableRoot = useWindowsRules ? normalizedRoot.toLowerCase() : normalizedRoot;
    const rootWithSep = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
    if (comparable === comparableRoot || comparable.startsWith(rootWithSep)) {
      return true;
    }
  }
  return false;
}

/** Authorize an existing path after resolving symbolic links. */
export function isExistingFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  return isExistingPathWithinRoots(target, allowedRoots);
}

function resolveRealRoots(allowedRoots: Set<string>): Set<string> {
  const resolved = new Set<string>();
  for (const root of allowedRoots) {
    try {
      resolved.add(realpathSync(root));
    } catch {
      // A stale root (removed session, deleted worktree) names nothing to
      // compare against; dropping it is what the old check did as well.
    }
  }
  return resolved;
}

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export type PathAuthorization =
  | { ok: true; path: string }
  | { ok: false; reason: "not-found" | "not-allowed" };

/**
 * Resolve `target` once and prove the resolved path is inside `allowedRoots`.
 *
 * Callers have to use the returned `path` for the actual operation. The
 * authorization above this function is lexical (and, for the session bypass,
 * optional); using the original path afterwards re-resolves every component,
 * so a link exchanged in between names a different file than the one that was
 * approved.
 */
export function resolveAuthorizedPath(target: string, allowedRoots: Set<string>): PathAuthorization {
  let resolved: string;
  try {
    resolved = realpathSync(target);
  } catch (error) {
    return { ok: false, reason: isMissingPath(error) ? "not-found" : "not-allowed" };
  }
  if (!isPathWithinRoots(resolved, resolveRealRoots(allowedRoots))) {
    return { ok: false, reason: "not-allowed" };
  }
  return { ok: true, path: resolved };
}

export interface OpenedAuthorizedFile {
  /** Resolved path the descriptor was opened from. */
  path: string;
  fd: number;
  stat: Stats;
}

export type OpenAuthorizedFileResult =
  | { ok: true; file: OpenedAuthorizedFile }
  | { ok: false; reason: "not-found" | "not-allowed" | "not-a-file" };

/**
 * Open `target` and bind the authorization to the descriptor.
 *
 * OMP-019: the check resolved the target and the read then used the original
 * path. A second process sharing the home swapped a checked directory for a
 * symlink to the outside between the two, and the read followed it — measured
 * as a deterministic leak over 120 reads. A path string cannot be authorized
 * *and* then read safely, because the name is re-resolved on every syscall.
 *
 * So the decision is taken on the object that is read: after the open the path
 * is resolved again and must still be under the roots, and its device/inode
 * must be the ones `fstat` reports for the descriptor. A swap at any point
 * leaves either a path outside the roots or an inode mismatch, and the caller
 * gets no bytes. `O_NOFOLLOW` refuses the case where the final component was
 * replaced by a symlink after the resolution. Symlinks that stay inside the
 * root keep working, because the first resolution follows them.
 *
 * `onBeforeOpen` is a test seam that runs between the two steps so the swap can
 * be replayed deterministically; production callers pass nothing.
 */
export function openAuthorizedFile(
  target: string,
  allowedRoots: Set<string>,
  onBeforeOpen?: () => void,
): OpenAuthorizedFileResult {
  const authorized = resolveAuthorizedPath(target, allowedRoots);
  if (!authorized.ok) return authorized;

  onBeforeOpen?.();

  // O_NONBLOCK: open(2) on a FIFO with O_RDONLY blocks until a writer appears,
  // before the fstat guard below can refuse it; the flag is a no-op for
  // regular files.
  const nonBlock = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = openSync(authorized.path, constants.O_RDONLY | nonBlock | noFollow);
  } catch (error) {
    return { ok: false, reason: isMissingPath(error) ? "not-found" : "not-allowed" };
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      closeSync(fd);
      return { ok: false, reason: "not-a-file" };
    }
    const fresh = realpathSync(authorized.path);
    if (!isPathWithinRoots(fresh, resolveRealRoots(allowedRoots))) {
      closeSync(fd);
      return { ok: false, reason: "not-allowed" };
    }
    const freshStat = statSync(fresh);
    if (freshStat.dev !== stat.dev || freshStat.ino !== stat.ino) {
      closeSync(fd);
      return { ok: false, reason: "not-allowed" };
    }
    return { ok: true, file: { path: fresh, fd, stat } };
  } catch (error) {
    try { closeSync(fd); } catch { /* the descriptor is already gone */ }
    return { ok: false, reason: isMissingPath(error) ? "not-found" : "not-allowed" };
  }
}

/** Close a descriptor from `openAuthorizedFile`, unless a stream owns it now. */
export function closeAuthorizedFile(file: OpenedAuthorizedFile): void {
  try { closeSync(file.fd); } catch { /* already closed by a stream */ }
}
