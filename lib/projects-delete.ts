import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Dirent } from "node:fs";
import {
  CONFIG_DIR_NAME as DEFAULT_CONFIG_DIR_NAME,
  getAgentDir,
  getConfigDirName,
  getConfigRootDir,
  getSessionsDir,
} from "@oh-my-pi/pi-utils";
import { resolveHomeRoot } from "../bin/web-auth-store.js";

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
 *
 * ### The production incident that shaped the agent-directory rule
 *
 * Measured 2026-10-20 on this host. A test ran `DELETE /api/projects/
 * home/steimmerbyte/.omp` against the dev server and lost 130 chats.
 * `isProtectedProjectRoot` did not fire, and the reason is structural rather
 * than a typo:
 *
 * - `getUserHome()` returns `/` for an **admin** (`lib/request-identity.ts:141`),
 *   by design — the admin is the whole account root space. Measured:
 *   `getUserHome({username:"steimmerbyte", isAdmin:true}) === "/"`.
 * - With `home = "/"`, `/home/steimmerbyte/.omp` sits at depth 3, and the
 *   depth-1 rule — which is what normally protects `~/.omp` — cannot reach it.
 * - `PROTECTED_HOME_CHILDREN` did not help either: it compares against
 *   `path.join(home, child)`, which for `home = "/"` is `/.omp`, not
 *   `/home/steimmerbyte/.omp`.
 * - Measured before this rule: `isProtectedProjectRoot("/home/steimmerbyte/.omp", "/")`
 *   was `false`. For a **non-admin** it was `true`, which is why the gap only
 *   showed up on the identity the test happened to use.
 *
 * So the depth rule was never the protection; it was a coincidence of the
 * identity's home pointing at the right tree. The rule below removes the
 * coincidence: the omp runtime directories are refused by their *resolved
 * path*, for every identity, admin or not, so the answer no longer depends on
 * what `getUserHome()` happened to return.
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
 * The directories omp itself owns, resolved by omp and never by string
 * concatenation here.
 *
 * `getAgentDir()` and friends come from `@oh-my-pi/pi-utils`, the same module
 * the CLI and `lib/omp-runtime.ts` use. Hard-coding `~/.omp` in a guard would
 * be wrong three times over: it breaks under `OMP_PROFILE` (the active profile
 * moves the tree to `~/.omp/profiles/<name>`), under `PI_CODING_AGENT_DIR`
 * (an explicit agent-dir override), and under an account whose config root is
 * not under the home the guard was handed. Measured on this host:
 * `getAgentDir()` = `/home/steimerbyte/.omp/agent`,
 * `getSessionsDir()` = `/home/steimerbyte/.omp/agent/sessions`.
 *
 * Every entry is refused for **every** identity. That is the whole point: the
 * runtime tree is not the caller's, and "the caller is an admin" is exactly the
 * condition under which the old rule failed.
 *
 * `resolveHomeRoot`-independent by construction — there is no identity here at
 * all, so there is no `getUserHome()` value that can talk its way past it.
 */
function ompRuntimeRoots(): readonly string[] {
  const roots = new Set<string>();
  // Each resolver is defensive: a guard that throws while protecting is a
  // guard that is not protecting, and the callers treat a throw as a 500.
  const add = (value: unknown) => {
    if (typeof value !== "string" || value.trim() === "") return;
    roots.add(path.resolve(value));
  };
  try { add(getConfigRootDir()); } catch { /* keep the rest */ }
  try { add(getAgentDir()); } catch { /* keep the rest */ }
  try { add(getSessionsDir()); } catch { /* keep the rest */ }

  // The config *directory name* for this install (".omp" by default), resolved
  // rather than hard-coded, joined onto the identity's home. This is what
  // covers a tenant's own agent tree — `<home>/.omp` — including for a
  // non-admin whose `home` is correct, and including the `.omp` tree of a home
  // the guard was handed as `/` (where the join produces `/.omp`, which is
  // harmless and gets caught by the runtime roots above anyway).
  try {
    const dirName = getConfigDirName();
    if (typeof dirName === "string" && dirName.trim() !== "") roots.add(path.resolve(os.homedir(), dirName));
  } catch { /* keep the rest */ }

  return [...roots];
}

/** `true` when `resolved` is one of the omp runtime directories or lives below one. */
function isOmpRuntimePath(resolved: string): boolean {
  for (const runtimeRoot of ompRuntimeRoots()) {
    if (isSameOrBelow(resolved, runtimeRoot)) return true;
  }
  // Any path that *passes through* a directory named like the omp config
  // directory — `.omp` — is a runtime tree, whoever owns it. The resolved roots
  // above only cover the *service* account's tree, which is why
  // `/home/pi/.omp` measured `false` for an admin even after they were added:
  // the admin's home is `/`, so nothing joined `.omp` onto the right place.
  //
  // The match is per path segment and over the *whole* path, not just the
  // basename. Checking only the basename was the first version of this rule and
  // it was wrong in a way the tests caught: `~/.omp` was refused while
  // `~/.omp/agent` and `~/.omp/agent/sessions` were not — the two directories
  // that hold the credentials and every transcript. A rule that protects the
  // folder but not its contents protects nothing.
  //
  // Segment-wise, so `workspace/.omp-notes` is a project and stays deletable.
  // Enumerating accounts instead would mean reading the account store or
  // listing the home root, and both can disagree with the request: an account
  // whose directory does not exist yet, a home root moved by
  // `OMP_WEB_HOME_ROOT`. A path that runs through a `.omp` segment is a runtime
  // tree in every reading, and a *project* living inside one is not a thing
  // anyone has — refusing it costs a rename, getting it wrong costs the
  // installation.
  //
  // Both the resolved name and the default `.omp` are matched, and that is not
  // belt-and-braces: `getConfigDirName()` returns `PI_CONFIG_DIR` when it is
  // set, so a test or an operator with that variable exported would otherwise
  // leave every real `~/.omp` unprotected. Found by execution — the guard
  // returned `false` for `~/.omp` once `PI_CONFIG_DIR` pointed elsewhere.
  for (const configDirName of configDirNames()) {
    if (resolved.split(path.sep).includes(configDirName)) return true;
  }
  return false;
}

/**
 * The config-directory names a runtime tree can live under: whatever this
 * install resolves, plus omp's own default.
 *
 * Two names, both matched per path segment, because the resolved one follows
 * `PI_CONFIG_DIR` and a folder named `.omp` is a runtime tree whether or not
 * that variable happens to be set right now.
 */
function configDirNames(): readonly string[] {
  const names = new Set<string>([DEFAULT_CONFIG_DIR_NAME]);
  try {
    const resolved = getConfigDirName();
    if (typeof resolved === "string" && resolved.trim() !== "") names.add(resolved);
  } catch {
    // The default still applies; a guard that cannot ask one question must not
    // answer that one "allowed".
  }
  return [...names];
}

/**
 * The directories that hold account homes on this host.
 *
 * More than one, and deliberately not derived from the identity alone:
 * `getUserHome()` returns `/` for an admin, so for the very identity that lost
 * the chats it named no home root at all. `os.homedir()`'s parent and
 * `resolveHomeRoot()` are process facts, not identity facts, and both hold for
 * every account the service serves.
 */
function homeRoots(home: string): readonly string[] {
  const fsRoot = path.parse(home).root;
  const candidates = new Set<string>();
  if (home !== fsRoot) candidates.add(path.dirname(home));
  // The real process home, whose parent is the account root on a normal
  // install. Skipped when it *is* the filesystem root.
  const realHome = path.resolve(os.homedir());
  if (realHome !== fsRoot) candidates.add(path.dirname(realHome));
  try {
    const resolved = path.resolve(resolveHomeRoot());
    if (resolved !== fsRoot) candidates.add(resolved);
  } catch {
    // Not fatal: the two candidates above already cover a default install.
  }
  return [...candidates].filter((candidate) => candidate !== fsRoot && candidate !== "");
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

  // The omp runtime tree. First, because it is the one that actually failed in
  // production, and because it must not depend on `homeDir` at all: an admin's
  // home is `/`, so every home-derived rule below is evaluated against a tree
  // that has nothing to do with the folder that was deleted.
  if (isOmpRuntimePath(resolved)) return true;

  // An *ancestor* of the home. `/home` is the parent of every account's home
  // on this host, so deleting it deletes every account at once — and the depth
  // rule below cannot see it, because `/home` is outside the home it belongs
  // to. Measured before this rule: `isProtectedProjectRoot("/home",
  // "/home/tester")` was `false`.
  if (resolved !== home && isSameOrBelow(home, resolved)) return true;

  // Any account's home directory, not only this identity's. Deleting
  // `/home/steimerbyte` takes that account's whole tree with it, and an admin —
  // whose `home` is `/` — had no rule that reached it.
  for (const homeRoot of homeRoots(home)) {
    if (path.dirname(resolved) === homeRoot) return true;
  }

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
 *
 * `"omp-runtime"` is a reason of its own and not a flavour of `"system-path"`,
 * because the two mean different things to the person who clicked. A system
 * path is "pick a different folder". The agent directory is "this is the
 * running installation's own state — sessions, credentials, skills, config —
 * and there is nothing to pick instead". The 2026-10-20 incident was the
 * second kind and the dialog showed the first.
 */
export function protectedRootReason(root: string, homeDir: string = os.homedir()): string | null {
  if (!isProtectedProjectRoot(root, homeDir)) return null;
  const resolved = path.resolve(root);
  const home = path.resolve(homeDir);
  const fsRoot = path.parse(resolved).root;
  if (resolved === fsRoot) return "filesystem-root";
  if (resolved === home) return "home";
  if (isOmpRuntimePath(resolved)) return "omp-runtime";
  if (isSameOrBelow(home, resolved)) return "home-ancestor";
  for (const homeRoot of homeRoots(home)) {
    if (path.dirname(resolved) === homeRoot) return "account-home";
  }
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

/**
 * At or above this many chats, a delete requires an explicit confirmation that
 * carries the number.
 *
 * The number is a judgement call and is therefore asserted by
 * `lib/projects-delete.test.mjs`, per the AGENTS.md rule that a comment naming a
 * figure needs a test that checks that figure. Its two anchors are measured:
 * the 2026-10-20 incident destroyed 130 chats, and an ordinary project on this
 * host has single-digit chats. Ten sits above the ordinary case and an order of
 * magnitude below the incident, so it fires on "this folder holds a history"
 * rather than on "this folder has a file in it".
 *
 * A number in a dialog is *not* the protection — the protection is
 * `isProtectedProjectRoot`. This is the second, independent layer, and it
 * fails safe by design: a caller that does not know about the confirmation gets
 * `409 confirmation-required` with the count in it and nothing deleted, not a
 * silent delete of the folder it was not looking at.
 */
export const DELETE_CONFIRMATION_CHAT_THRESHOLD = 10;

/**
 * How many filesystem entries a preview will walk before it gives up and
 * reports `entriesTruncated`.
 *
 * A folder of a million files must not turn a delete button into a directory
 * scan that hangs the dashboard. The cap is not an optimisation: without it,
 * one pathological path would make the preview unbounded, and a preview that
 * can hang is a preview nobody opens — which is the case where the count would
 * have mattered.
 */
export const PREVIEW_MAX_ENTRIES = 200_000;

export interface ProjectDeletionPreview {
  /** Sessions whose cwd is inside the folder, and which the delete would remove. */
  sessionCount: number;
  /** Ids of those sessions, for the confirmation text. */
  sessionIds: readonly string[];
  /** Recursive filesystem entries under the folder. */
  entryCount: number;
  /** `true` when the walk hit `PREVIEW_MAX_ENTRIES` and `entryCount` is a floor. */
  entriesTruncated: boolean;
  /** `true` when this delete requires an explicit confirmation with the count. */
  requiresConfirmation: boolean;
}

/**
 * Count what a delete would destroy, without destroying anything.
 *
 * Deliberately separate from the delete: the point is that the user sees this
 * number *before* anything is gone, and that the server recomputes it at delete
 * time rather than trusting what the client was shown. A client that shows a
 * stale count, or no count, cannot talk its way past the threshold check.
 */
export function countTreeEntries(
  root: string,
  maxEntries: number = PREVIEW_MAX_ENTRIES,
): { entryCount: number; entriesTruncated: boolean } {
  let entryCount = 0;
  let entriesTruncated = false;
  const queue: string[] = [root];

  while (queue.length > 0) {
    const current = queue.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // A directory we cannot read (permissions, a broken mount, a race with
      // the delete itself) contributes an unknown number. Counting it as zero
      // would understate the damage; the truncation flag is what makes the
      // number honest, so it is set instead of silently skipped.
      entriesTruncated = true;
      continue;
    }
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount >= maxEntries) {
        entriesTruncated = true;
        return { entryCount, entriesTruncated };
      }
      // `isDirectory()` is false for a symlink, so a link cannot walk the walk
      // out of the folder and out of the count.
      if (entry.isDirectory()) queue.push(path.join(current, entry.name));
    }
  }
  return { entryCount, entriesTruncated };
}