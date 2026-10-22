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
 * ### What costs time: the nesting, not the size
 *
 * This comment used to say "a 2.4 GB folder takes visibly longer to measure
 * than a 40 MB one". Measured on 2026-10-22, that is wrong. The registry of
 * this account holds 18 roots, and **11 of them lie inside another root**:
 * `<home>/workspace` contains 8 further project roots, `<home>/.omp`
 * contains `.omp/plugins`. `du -sb` walks the tree under the folder it is
 * given, so the workspace tree is walked **9 times** — once for `workspace`
 * itself and once for each of the 8 roots below it.
 *
 * The expensive single measurements are therefore the *parent* trees and not
 * the child projects. In the measurement below, `workspace` (10,0 s), `AGENT`
 * (10,0 s) and `tmp` (10,1 s) hit the budget, while the child
 * `01_PROJEKTE/ki-hardware-calculator-react` — 191 MB — needed 9,2 s, because
 * it sits on the same 9p mount and the eight parallel `du` processes compete
 * for it. Its size is not what makes it slow.
 *
 * ### The measurement, measured
 *
 * 2026-10-22 on the dev host (Intel i5-1335U, WSL2, Bun 1.4.0, Next
 * 16.2.12), against the 18 real roots of this account's registry:
 *
 * | | |
 * |---|---|
 * | total | **20,5 s** |
 * | pool rounds (8 per round, the rounds are serial) | 3 |
 * | folders measured / folders with a size | 11 of 18 |
 * | folders without a size | 7 (4 by timeout, 3 by error) |
 * | sum of the measured sizes | 51,97 GB |
 *
 * The four that blew the 10 s budget: `workspace/omp-web` (10 115,9 ms),
 * `workspace/AGENT` (10 032,5 ms), `tmp` (10 006,8 ms), `workspace`
 * (10 004,7 ms). Two of the three errors are roots that do not exist on the
 * disk, the third is `/tmp`.
 *
 * The same four folders, measured again right afterwards, took 1,15 s, 1,26 s,
 * 0,16 s and 4,81 s. The difference is the **metadata cache of the mount**,
 * not the code: `du -sb` walks the tree and stats the entries, it does not
 * read the contents, so a cold 9p mount makes the *walk* slow. The 20,5 s
 * above is the number to plan with; the warm number is what a run costs when
 * it follows another one.
 *
 * ### The sizes overlap, and that is the existing semantics
 *
 * `du -sb` on a parent counts the bytes of its children. `workspace`
 * (20,37 GB) contains the bytes of the 8 project roots below it, and `.omp`
 * (4,95 GB) contains `.omp/plugins` (1,21 GB). **The sum of the sizes on the
 * cards is therefore counted twice** and is not a total of anything.
 *
 * That is the semantics this dashboard has always had, and it is not changed
 * here: the card shows the size of *that folder*, and a folder that contains
 * other folders is bigger than the sum of its parts on purpose. The reader
 * has to know it — `docs/spec.md` says so — and so does the person who reads
 * the code next. The visible consequence of the budget below is that the
 * biggest card can show no size while the cards of its children show theirs.
 *
 * ### The rejected alternative: one traversal for the whole tree
 *
 * `du -sb --max-depth=1 <home>` walks the tree **once** and hands out the
 * size of every folder in it: the 9-fold traversal above becomes one pass,
 * and the cost driver is gone. It was not done, because it changes what the
 * number *means* — the sizes would come from one common traversal with one
 * common timestamp instead of from a measurement of each folder, and the
 * roots that do not lie below the common root would still have to be
 * measured on their own. That is a decision about the semantics of the card,
 * not a refactoring, and it is not this commit's to take.
 *
 * ### Why the measurement is capped
 *
 * The cap is per folder and the pool rounds are serial, so one run costs at
 * most `ceil(folders / MAX_PARALLEL) * SIZE_TIMEOUT_MS`.
 *
 * The cap used to protect the *request*: the route measured inside its
 * answer, and one slow mount would hold the whole dashboard open. That is
 * gone — the measurement runs in the background now
 * (`lib/projects-sizes.ts`) and nobody waits for it. What the cap protects
 * now is the background work: eight `du` processes on a 9p mount are enough
 * to make the machine feel slow, and a folder that cannot be measured in the
 * budget reports `null` and is shown without a size — honest, and better
 * than a number that is not there.
 */

/**
 * Per-folder budget. One slow folder must not stall the rest.
 *
 * 30 seconds. The old value was 10, and at 10 the four biggest folders of
 * the registry delivered **nothing**: they were killed at 10,0-10,1 s (the
 * measurement above), among them the project that was being worked on. The
 * cap no longer protects a waiting user — the measurement runs in the
 * background and nobody waits for it — so what it buys is the bound on the
 * background work, and what it costs is the size of the biggest folders.
 *
 * At 30 s a cold run costs about 60 s instead of 20,5 s (two of the three
 * pool rounds hit the cap), which the client's poll window still covers (60
 * polls of 2 s = 120 s). A warm run is unaffected: the same four folders
 * took 0,16-4,81 s.
 *
 * The number is asserted by `lib/project-size.test.mjs` ("the documented
 * budget bounds the background run"), so this comment and the constant cannot
 * drift apart.
 */
export const SIZE_TIMEOUT_MS = 30_000;

/**
 * How many `du` processes run at once.
 *
 * Eight is a compromise: each one is I/O-bound on a different tree, so raising
 * this buys little past a handful, while a higher number multiplies the worst
 * case for a run. The cost is bounded at
 * `ceil(count / MAX_PARALLEL) * SIZE_TIMEOUT_MS` regardless of how many
 * projects exist.
 *
 * It is worth knowing what these eight do to each other: because 11 of the
 * 18 roots of a real registry lie inside other roots, the eight processes
 * are often walking the *same* tree at the same time. That is why the child
 * `01_PROJEKTE/ki-hardware-calculator-react` (191 MB) needed 9,2 s in the
 * measurement above while its parent `workspace` was being walked as well.
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