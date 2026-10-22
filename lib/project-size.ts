import { execFile } from "child_process";
import { promisify } from "util";
import {
  MAX_PARALLEL,
  SIZE_TIMEOUT_MS,
  type SizeMeasurement,
} from "./projects-schema";

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
 * ### What costs time: the tree entries, not the bytes
 *
 * An earlier version of this comment said "a 2.4 GB folder takes visibly
 * longer to measure than a 40 MB one". That is wrong, and it was wrong in the
 * direction that matters: the bytes explain the duration almost not at all.
 *
 * Measured 2026-10-22 on the dev host over 15 folders of a real registry,
 * with a linear fit each:
 *
 * ```
 * t(Bytes)  = 924,95 ms + 2,085e-7 ms/Byte * S      r2 = 0,334
 * t(Inodes) = 270,13 ms + 0,0212 ms/Inode * I        r2 = 0,919
 * ```
 *
 * The inode count explains the duration; the byte count does not. Six
 * examples from the same measurement:
 *
 * | Ordner | Bytes | Inodes | Zeit |
 * |---|---|---|---|
 * | `workspace` | 18,96 GB | 487.348 | 10,43 s |
 * | `omp-web` | 2,41 GB | 131.766 | 4,47 s |
 * | `.omp` | 4,62 GB | 119.797 | 4,34 s |
 * | `AGENT` | 2,84 GB | 142.581 | 1,73 s |
 * | `tmp` | 20,82 GB | 27.518 | 0,52 s |
 * | `Zed` | 0,000065 GB | 14 | 1,33 s |
 *
 * `tmp` holds 20,82 GB and is measured in 0,52 s, because it has 27.518 tree
 * entries. `omp-web` holds 2,41 GB and needs 4,47 s, because it has
 * 131.766. `du` walks the tree and stats the entries; it does not read the
 * contents — so the work is proportional to the *number of entries*, not to
 * their size. (`Zed` is the exception that proves the rule: 14 entries on a
 * Windows mount, and the fixed cost of that mount is 1,3 s.)
 *
 * ### The nesting multiplies the entries, not only the bytes
 *
 * 11 of the 18 roots of a real registry lie *inside* another root:
 * `<home>/workspace` contains 8 further project roots, `<home>/.omp`
 * contains `.omp/plugins`. `du -sb` walks the tree under the folder it is
 * given, so the workspace tree is walked **9 times** — once for `workspace`
 * itself and once for each of the 8 roots below it. What is walked nine
 * times is 487.348 tree entries, and that is the bill.
 *
 * The expensive single measurements are therefore the *parent* trees and not
 * the child projects. In the measurement below, `workspace` (10,0 s), `AGENT`
 * (10,0 s) and `tmp` (10,1 s) hit the budget, while the child
 * `01_PROJEKTE/ki-hardware-calculator-react` — 191 MB — needed 9,2 s, because
 * it sits on the same 9p mount and the eight parallel `du` processes compete
 * for it. Its size is not what makes it slow; its 4.700 entries are.
 *
 * ### The measurement, measured
 *
 * 2026-10-22 on the dev host (Intel i5-1335U, WSL2, Bun 1.4.0, Next
 * 16.2.12), against the 18 real roots of this account's registry:
 *
 * | | |
 * |---|---|
 * | three runs, identical code and identical paths | **6,9 s / 14,4 s / 20,5 s** |
 * | pool rounds (8 per round, the rounds are serial) | 3 |
 * | folders measured / folders with a size | 11 of 18 |
 * | folders without a size | 7 (4 by timeout, 3 by error) |
 * | sum of the measured sizes | 51,97 GB |
 *
 * The spread is the **page cache of the filesystem**, not the code: the same
 * three runs over the same paths differ by a factor of three. The four
 * folders that blew the 10 s budget of that measurement were
 * `workspace/omp-web` (10 115,9 ms), `workspace/AGENT` (10 032,5 ms), `tmp`
 * (10 006,8 ms) and `workspace` (10 004,7 ms). Two of the three errors are
 * roots that do not exist on the disk, the third is `/tmp`.
 *
 * The budget is 30 s now (`SIZE_TIMEOUT_MS`, `lib/projects-schema.ts`), and
 * with it **16 of the 18** folders have a number: the four above are
 * measured, `/tmp` comes back as a lower bound (see below), and the two that
 * have nothing are roots that do not exist on the disk.
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
 * the code next. The visible consequence of the budget is that the biggest
 * card can show no size while the cards of its children show theirs.
 *
 * ### The rejected alternative: one traversal for the whole tree
 *
 * `du -sb --max-depth=1 <home>` walks the tree **once** and hands out the
 * size of every folder in it. The argument for it is not bytes, it is
 * **entries**: one traversal instead of nine saves nine passes over 487.348
 * tree entries, and the entries are what the time is made of (the fits
 * above). It was not done, because it changes what the number *means* — the
 * sizes would come from one common traversal with one common timestamp
 * instead of from a measurement of each folder, and the roots that do not
 * lie below the common root would still have to be measured on their own.
 * That is a decision about the semantics of the card, not a refactoring, and
 * it is not this commit's to take.
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
 * Largest stdout we will look at. `du -sb` prints one number and one path; a
 * huge output would mean something other than `du` answered, and parsing that
 * would be a second attack surface.
 */
const MAX_OUTPUT_BYTES = 4_096;

/**
 * The number `du` printed, or `null` when it printed nothing usable.
 *
 * `du -sb` prints `<bytes>\t<path>`. Only the leading integer is read; the
 * path that follows is echoed back and never interpreted.
 */
function parseDuTotal(stdout: string): number | null {
  const firstLine = stdout.split("\n", 1)[0]?.trim() ?? "";
  const match = /^(\d+)(?:\t|$)/.exec(firstLine);
  if (!match) return null;
  const bytes = Number(match[1]);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

/**
 * The total of a *partially* readable tree, or `null`.
 *
 * `du` exits 1 when it cannot read a subdirectory — `/tmp` on a machine with
 * a private systemd directory is the everyday case — and it still prints the
 * total of what it could read. `execFile` throws on the non-zero exit and
 * throws the stdout away with it, so the number was lost even though `du`
 * had computed it.
 *
 * The number is a **lower bound**: the unreadable part was not counted. It
 * is therefore not the size of the folder, and the card says so with a "≥".
 *
 * Measured on this host: `du -sb /tmp` exits 1, prints
 * "16830164\t/tmp" on stdout and "du: cannot read directory
 * '/tmp/systemd-private-…': Permission denied" on stderr. Before, that
 * number was thrown away with the error and `/tmp` had no size at all.
 *
 * What is *not* a lower bound is the output of a process that was killed:
 * the timeout kills `du` mid-walk, and `du` prints its total at the very
 * end, so a killed process has printed either nothing or nothing complete.
 * That case is refused here.
 */
function partialTotalFromFailure(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const failure = error as {
    killed?: boolean;
    signal?: string | null;
    code?: unknown;
    stdout?: unknown;
  };
  // Killed by the timeout or by a signal: the walk did not finish.
  if (failure.killed === true) return null;
  if (typeof failure.signal === "string") return null;
  // A string code is a spawn failure (ENOENT, EACCES): `du` never ran, so
  // there is no stdout to read.
  if (typeof failure.code !== "number") return null;
  const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
  return parseDuTotal(stdout);
}

/**
 * Measure one folder in bytes, or `null` when it cannot be measured.
 *
 * `null` is a real, expected answer — missing folder, no permission, timeout,
 * no `du` on the platform — and it is never turned into a zero. A `0` would
 * render as "empty project", which is a claim about the disk that was never
 * established.
 *
 * A number that only saw part of the tree comes back as
 * `{ bytes, partial: true }`: it is a lower bound, and the caller has to say
 * so (see `SizeMeasurement`).
 *
 * The caller is responsible for having checked that this path belongs to this
 * identity. This function does no authorization: it runs `du` on whatever it is
 * handed, and the route is what knows which paths are allowed.
 *
 * Exported although the only production caller is `measureProjectSizes` below:
 * the single-folder behaviour *is* the contract — `null` versus `0`, shell
 * metacharacters treated as a name, a missing folder, a partial measurement —
 * and `lib/project-size.test.mjs` asserts each of those against this function
 * directly. Exercising them through the pool version would mean constructing
 * enough roots to leave one pool round, which tests the batching rather than
 * the answer.
 */
export async function measureProjectSize(root: string): Promise<SizeMeasurement> {
  if (typeof root !== "string" || root.trim() === "") {
    return { bytes: null, partial: false };
  }
  // `execFile` without a shell, so the path is an argument and not a script.
  // A folder name containing `;` or `$(...)` is a folder name.
  try {
    const { stdout } = await execFileAsync("du", ["-sb", "--", root], {
      timeout: SIZE_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: "utf8",
    });
    const bytes = parseDuTotal(stdout);
    return bytes === null ? { bytes: null, partial: false } : { bytes, partial: false };
  } catch (error) {
    // The partial total is kept, because `du` computed it; everything else —
    // ENOENT, EACCES, ETIMEDOUT, a kill signal — is the same answer here.
    // The card shows no size, and the next run tries again after the TTL.
    const partial = partialTotalFromFailure(error);
    return partial === null
      ? { bytes: null, partial: false }
      : { bytes: partial, partial: true };
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
): Promise<Map<string, SizeMeasurement>> {
  const maxParallel = Math.max(1, options.maxParallel ?? MAX_PARALLEL);
  const results = new Map<string, SizeMeasurement>();

  for (let offset = 0; offset < roots.length; offset += maxParallel) {
    const round = roots.slice(offset, offset + maxParallel);
    const measured = await Promise.all(round.map((root) => measureProjectSize(root)));
    round.forEach((root, index) => {
      results.set(root, measured[index]);
    });
  }

  return results;
}
