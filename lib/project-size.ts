import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Folder size for the dashboard card, in bytes.
 *
 * ### Why `du -sb` and not a walk
 *
 * `du` already knows about hard links, sparse files and the block sizes the
 * filesystem actually charged for. A hand-rolled recursive walk gets at most
 * the sum of `st_size`, which over-counts sparse files and under-counts block
 * rounding, and it has to be re-implemented correctly for every platform.
 *
 * ### Why this is not free, and why it is capped anyway
 *
 * A 2.4 GB folder takes visibly longer to measure than a 40 MB one. At nine
 * projects that is invisible; at fifty it is a visible pause. So the
 * measurement is cached in the registry with a TTL
 * (`isSizeMeasurementStale`, `lib/projects-schema.ts`) and the route measures
 * synchronously on GET, capped here.
 *
 * The cap is not an optimisation, it is the reason the route can stay
 * synchronous. Without it, one pathologically slow mount would hold the whole
 * dashboard open for the sum of all timeouts. With it, the request costs at
 * most `ceil(projects / MAX_PARALLEL) * SIZE_TIMEOUT_MS`, and a folder that
 * cannot be measured in that budget reports `null` and is simply shown without
 * a size — which is honest, and better than a number that arrives later.
 */

/** Per-project budget. One slow folder must not stall the rest. */
export const SIZE_TIMEOUT_MS = 10_000;

/**
 * How many `du` processes run at once.
 *
 * Eight is a compromise: each one is I/O-bound on a different tree, so raising
 * this buys little past a handful, while a higher number multiplies the worst
 * case for the request. The cost is bounded at
 * `ceil(count / 8) * 10s` regardless of how many projects exist.
 */
export const MAX_PARALLEL = 8;

/**
 * Largest stdout we will look at. `du -sb` prints one number and one path; a
 * huge output would mean something other than `du` answered, and parsing that
 * would be a second attack surface.
 */
const MAX_OUTPUT_BYTES = 4_096;

/**
 * Measure one folder in bytes, or `null` when it cannot be measured.
 *
 * `null` is a real, expected answer — missing folder, no permission, timeout,
 * no `du` on the platform — and it is never turned into a zero. A `0` would
 * render as "empty project", which is a claim about the disk that was never
 * established.
 *
 * The caller is responsible for having checked that this path belongs to this
 * identity. This function does no authorization: it runs `du` on whatever it is
 * handed, and the route is what knows which paths are allowed.
 *
 * Exported although the only production caller is `measureProjectSizes` below:
 * the single-folder behaviour *is* the contract — `null` versus `0`, shell
 * metacharacters treated as a name, a missing folder — and `lib/project-size.test.mjs`
 * asserts each of those against this function directly. Exercising them
 * through the pool version would mean constructing enough roots to leave one
 * pool round, which tests the batching rather than the answer.
 */
export async function measureProjectSize(root: string): Promise<number | null> {
  if (typeof root !== "string" || root.trim() === "") return null;
  // `execFile` without a shell, so the path is an argument and not a script.
  // A folder name containing `;` or `$(...)` is a folder name.
  try {
    const { stdout } = await execFileAsync("du", ["-sb", "--", root], {
      timeout: SIZE_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: "utf8",
    });
    const firstLine = stdout.split("\n", 1)[0]?.trim() ?? "";
    // `du -sb` prints `<bytes>\t<path>`. Only the leading integer is read; the
    // path that follows is echoed back and never interpreted.
    const match = /^(\d+)(?:\t|$)/.exec(firstLine);
    if (!match) return null;
    const bytes = Number(match[1]);
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
  } catch {
    // ENOENT, EACCES, ETIMEDOUT, kill signal — all the same answer here. The
    // card shows no size, and the next GET tries again after the TTL.
    return null;
  }
}

/**
 * Measure many folders with a bounded number of concurrent processes.
 *
 * Runs in pool rounds rather than one `Promise.all`: an unbounded pool over
 * fifty projects would start fifty `du` processes at once, and the point of
 * the cap is that it is a cap.
 *
 * Roots that are skipped by the staleness check are absent from the result
 * map rather than present with a value, so the caller can tell "not measured
 * this round" from "measured as unavailable".
 */
export async function measureProjectSizes(
  roots: readonly string[],
  options: { maxParallel?: number } = {},
): Promise<Map<string, number | null>> {
  const maxParallel = Math.max(1, options.maxParallel ?? MAX_PARALLEL);
  const results = new Map<string, number | null>();

  for (let offset = 0; offset < roots.length; offset += maxParallel) {
    const round = roots.slice(offset, offset + maxParallel);
    const measured = await Promise.all(round.map((root) => measureProjectSize(root)));
    round.forEach((root, index) => {
      results.set(root, measured[index]);
    });
  }

  return results;
}