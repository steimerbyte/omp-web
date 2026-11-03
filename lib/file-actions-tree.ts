import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Bounded, asynchronous tree walking for `app/api/file-actions/[...path]`.
 *
 * ### Why this is async and capped
 *
 * Measured on 2026-11-03, 12 cores, load average 5.19, against a 20 200-entry
 * tree (200 directories of 100 small files) with a 10 ms probe: the old
 * synchronous `treeSize` + `copyTree` took 413 ms, and the event loop was
 * blocked for 413 ms of it; the old `rmSync` took 55 ms and blocked for 55 ms
 * (idle baseline 1-4 ms). Nothing bounded that work either, so one
 * authenticated request against a large folder was a denial of service with
 * the caller's own credentials.
 *
 * Everything here is `fs/promises`, so the loop stays free while the thread
 * pool works: the same tree through the route takes 1184 ms wall time for the
 * copy — one async round trip per entry instead of a synchronous call — but
 * the maximum loop lag was 34.1 ms; the delete took 61 ms with 4.3 ms of lag
 * (idle baseline 6 ms / 1.4 ms). On top of that, `inspectTree` walks without
 * mutating and refuses over-limit trees *before* the first write, so a refusal
 * leaves no partial destination and no half-deleted folder.
 *
 * ### The numbers
 *
 * - 50 000 entries: about 3 s of copy at the measured rate (1184 ms for
 *   20 200 entries) — seconds, not minutes, while still covering an ordinary
 *   project folder. A copy of a `node_modules` larger than that is refused
 *   with a message that names the limit; a delete has no entry cap.
 * - 64 levels: deeper nesting is pathological, and it bounds the recursion in
 *   `copyTree`.
 * - 512 MiB: the copy limit that already existed, now checked before the
 *   first byte is written instead of after a synchronous size walk.
 * - 10 s: about 8x the measured 20 200-entry copy, so a slow disk — or a tree
 *   that grows between the walk and the copy — still cannot hold a request for
 *   minutes.
 *
 * ### Entry types
 *
 * Symlinks are never followed: a symlink inside the source is copied as a
 * symlink, and one inside a folder being deleted is removed without being
 * traversed (the old `rmSync`/`copyFileSync` pair did the same implicitly).
 * FIFOs, sockets and devices are refused for a copy — `copyFile` on a FIFO
 * blocks until a writer appears — and merely counted for a delete, where
 * removing them is safe and legitimate.
 */

export type TreeOperation = "copy" | "delete";

export interface TreeLimits {
  readonly maxEntries: number;
  readonly maxDepth: number;
  readonly maxBytes: number;
  readonly maxMillis: number;
}

export const MAX_TREE_ENTRIES = 50_000;
export const MAX_TREE_DEPTH = 64;
export const MAX_TREE_BYTES = 512 * 1024 * 1024;
export const MAX_TREE_MILLIS = 10_000;

export const TREE_LIMITS: TreeLimits = {
  maxEntries: MAX_TREE_ENTRIES,
  maxDepth: MAX_TREE_DEPTH,
  maxBytes: MAX_TREE_BYTES,
  maxMillis: MAX_TREE_MILLIS,
};

/**
 * A refusal the route turns into a response. `status` carries the HTTP code:
 * 413 for a tree over the byte limit, 422 for the entry, depth and time
 * budgets, which are about shape rather than size.
 */
export class TreeRefusal extends Error {
  readonly status: number;

  constructor(message: string, status = 422) {
    super(message);
    this.name = "TreeRefusal";
    this.status = status;
  }
}

/** The absolute `performance.now()` stamp an operation must finish by. */
export function treeDeadline(limits: TreeLimits = TREE_LIMITS): number {
  return performance.now() + limits.maxMillis;
}

function byteRefusal(limits: TreeLimits): TreeRefusal {
  return new TreeRefusal(
    `Refusing to copy: the folder is larger than ${limits.maxBytes / 1024 / 1024} MB, which is the limit`,
    413,
  );
}

function specialFileRefusal(name: string): TreeRefusal {
  return new TreeRefusal(`Refusing to copy "${name}": it is a FIFO, socket or device, not a regular file`);
}

/**
 * Count entries, bytes and depth without touching anything.
 *
 * Throws `TreeRefusal` as soon as a limit is crossed, so the caller learns the
 * tree is too large before it starts writing or removing. The walk is
 * iterative over an explicit stack, so the depth limit is a policy rather than
 * a stack bound, and the event loop gets control at every `await`.
 */
export async function inspectTree(
  target: string,
  operation: TreeOperation,
  deadline: number,
  limits: TreeLimits = TREE_LIMITS,
): Promise<void> {
  const rootStat = await fs.lstat(target);
  if (!rootStat.isDirectory()) {
    if (rootStat.isSymbolicLink()) return;
    if (!rootStat.isFile()) {
      if (operation === "copy") throw specialFileRefusal(path.basename(target));
      return;
    }
    if (operation === "copy" && rootStat.size > limits.maxBytes) throw byteRefusal(limits);
    return;
  }

  let entries = 0;
  let bytes = 0;
  const pending: { dir: string; depth: number }[] = [{ dir: target, depth: 0 }];

  while (pending.length > 0) {
    if (performance.now() > deadline) {
      throw new TreeRefusal(
        `Refusing to ${operation}: the folder took longer than ${limits.maxMillis / 1000} s to inspect`,
      );
    }
    const { dir, depth } = pending.pop() as { dir: string; depth: number };
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      // No entry cap for a delete: async `rm` does not block the loop, and the
      // deadline and depth limits bound it; the entry cap bounds a copy's work.
      if (operation === "copy") {
        entries += 1;
        if (entries > limits.maxEntries) {
          throw new TreeRefusal(
            `Refusing to copy: the folder holds more than ${limits.maxEntries} entries, which is the limit`,
          );
        }
      }
      if (entry.isDirectory()) {
        if (depth + 1 > limits.maxDepth) {
          throw new TreeRefusal(
            `Refusing to ${operation}: folder nesting is deeper than ${limits.maxDepth} levels`,
          );
        }
        pending.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        continue;
      }
      // Not followed: a link cannot walk the walk out of the folder.
      if (entry.isSymbolicLink()) continue;
      if (!entry.isFile()) {
        if (operation === "copy") throw specialFileRefusal(entry.name);
        continue;
      }
      // Only a copy needs the size; a delete does not read the bytes it removes.
      if (operation === "copy") {
        bytes += (await fs.lstat(path.join(dir, entry.name))).size;
        if (bytes > limits.maxBytes) throw byteRefusal(limits);
      }
    }
  }
}

/**
 * Recursive copy, asynchronous. Deliberately does not follow symlinks: a
 * symlink inside the source is copied as a symlink, so a link pointing outside
 * the project cannot pull foreign content in through the copy.
 *
 * The entry and byte limits are enforced by `inspectTree` beforehand; the
 * deadline and the regular-file check are repeated here because the tree can
 * change between the walk and the copy.
 */
export async function copyTree(
  source: string,
  destination: string,
  deadline: number,
  limits: TreeLimits = TREE_LIMITS,
): Promise<void> {
  const walk = async (from: string, to: string, depth: number): Promise<void> => {
    if (performance.now() > deadline) {
      throw new TreeRefusal(
        `Refusing to copy: the copy took longer than ${limits.maxMillis / 1000} s`,
      );
    }
    if (depth > limits.maxDepth) {
      throw new TreeRefusal(`Refusing to copy: folder nesting is deeper than ${limits.maxDepth} levels`);
    }
    const stat = await fs.lstat(from);
    if (stat.isSymbolicLink()) {
      await fs.symlink(await fs.readlink(from), to);
      return;
    }
    if (stat.isDirectory()) {
      await fs.mkdir(to, { recursive: true });
      for (const entry of await fs.readdir(from)) {
        await walk(path.join(from, entry), path.join(to, entry), depth + 1);
      }
      return;
    }
    if (!stat.isFile()) throw specialFileRefusal(path.basename(from));
    await fs.copyFile(from, to);
    // copyFile does not carry the mode across on every platform, and an
    // executable losing +x is a real regression for a project the agent runs.
    await fs.chmod(to, stat.mode);
  };
  await walk(source, destination, 0);
}
