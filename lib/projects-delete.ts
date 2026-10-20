import os from "node:os";
import path from "node:path";

/**
 * Which folders the dashboard may never delete, and why this lives here.
 *
 * ### The problem this solves
 *
 * The dashboard models a project as a folder, so "delete project" means
 * "recursively delete that folder". That is a real, irreversible action
 * reachable from a card button, and some folders on this host are not
 * disposable even for the account that owns them: `~/docker/stacks` holds
 * running Compose stacks, `~/Documents` holds the user's actual documents, and
 * `/` plus `/etc`, `/usr`, `/var` are not the dashboard's to remove at all.
 *
 * ### Why a confirmation dialog is not the protection
 *
 * A dialog is a UI affordance. The same delete path is reachable from the
 * FileExplorer, from a stale tab, and from any future caller that forgets the
 * dialog — and a bug there would be silent, because the code would still look
 * correct. So the refusal is in code, on the path, and it is the thing the
 * test pins.
 *
 * This is deliberately *narrower* than the write allowlist. `isWritePathAllowed`
 * answers "may this identity write here"; that answer is `true` for
 * `~/docker/stacks` when the account owns it, because writing a Compose file
 * there is legitimate. Deleting the folder that holds them is a different
 * question, and `isWritePathAllowed` must not be stretched to answer it — that
 * would break the explorer for a rule that only the dashboard needs.
 */

/**
 * System directories that are never removable, at any depth below them.
 *
 * Compared as a whole path segment, so `/etcetera` is *not* protected while
 * `/etc` and `/etc/ssl` are. A plain `startsWith("/etc")` would also block
 * `/etcetera`, and worse, would let `/etcfoo` be deleted by anyone who found
 * the prefix confusing.
 */
const PROTECTED_SYSTEM_ROOTS: readonly string[] = [
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib64",
  "/opt",
  "/proc",
  "/root",
  "/sbin",
  "/srv",
  "/sys",
  "/usr",
  "/var",
  "/System",
  "/Library",
  "/Applications",
  "/Windows",
];

/**
 * Folders directly under the home that hold user data rather than projects.
 *
 * This is the rule that bites: projects live in `<home>/workspace/…`, but
 * everything else at depth 1 under the home is somebody's life, not a
 * scratchpad. `~/docker/stacks` is the concrete case from the design — it is a
 * live Compose root that happens to look like a project because a session once
 * ran there.
 */
const PROTECTED_HOME_CHILDREN: readonly string[] = [
  "docker",
  "Documents",
  "Desktop",
  "Downloads",
  "Music",
  "Pictures",
  "Videos",
  "Public",
  "Templates",
  ".ssh",
  ".gnupg",
  ".config",
  ".local",
  ".omp",
];

/** `true` when `candidate` is `root` itself or lies below it, on segment boundaries. */
function isSameOrBelow(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate.startsWith(prefix);
}

/**
 * `true` when this folder must never be removed by the projects dashboard.
 *
 * The home is a parameter rather than an implicit `os.homedir()` read, for two
 * reasons. The service runs as one account while serving several identities,
 * so "the home" is a property of the *identity* and not of the process — the
 * same distinction `getUserHome(identity)` exists to make elsewhere. And as a
 * test seam it lets the tests exercise every rule without inventing a fake
 * machine layout.
 */
export function isProtectedProjectRoot(root: string, homeDir: string = os.homedir()): boolean {
  if (typeof root !== "string" || root.trim() === "") return true;
  const resolved = path.resolve(root);
  const home = path.resolve(homeDir);
  const fsRoot = path.parse(resolved).root;

  // A filesystem root has no parent that could contain it, so "depth" is
  // undefined there. Refused outright, like the file-actions route does.
  if (resolved === fsRoot) return true;

  // The home itself. Deleting it is the one action no dashboard may offer.
  if (resolved === home) return true;

  for (const systemRoot of PROTECTED_SYSTEM_ROOTS) {
    if (isSameOrBelow(resolved, path.resolve(systemRoot))) return true;
  }

  // Depth 1 under the home: `<home>/docker`, `<home>/Documents`, and every
  // sibling that comes with them. Depth 2 is where projects start
  // (`<home>/workspace/project`), so the rule stops exactly there.
  const relative = path.relative(home, resolved);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    const depth = relative.split(path.sep).filter((segment) => segment !== "").length;
    if (depth === 1) return true;
  }

  // A known home child named explicitly. Redundant with the depth rule for
  // POSIX homes, but load-bearing when `homeDir` points somewhere the caller
  // did not derive from the identity — the case `getUserHome` exists for.
  for (const child of PROTECTED_HOME_CHILDREN) {
    if (isSameOrBelow(resolved, path.join(home, child))) return true;
  }

  return false;
}

/**
 * The reason a folder is protected, for the message the UI shows.
 *
 * Split from the boolean because "this may not be deleted" is not actionable
 * on its own — the user needs to know whether the fix is "pick a different
 * folder" or "this one is not a project at all".
 */
export function protectedRootReason(root: string, homeDir: string = os.homedir()): string | null {
  if (!isProtectedProjectRoot(root, homeDir)) return null;
  const resolved = path.resolve(root);
  const home = path.resolve(homeDir);
  if (resolved === path.parse(resolved).root) return "filesystem-root";
  if (resolved === home) return "home";
  for (const systemRoot of PROTECTED_SYSTEM_ROOTS) {
    if (isSameOrBelow(resolved, path.resolve(systemRoot))) return "system-path";
  }
  const relative = path.relative(home, resolved);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    const depth = relative.split(path.sep).filter((segment) => segment !== "").length;
    if (depth === 1) return "home-child";
  }
  return "protected-home-child";
}