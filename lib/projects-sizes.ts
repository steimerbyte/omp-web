import { measureProjectSizes } from "./project-size";
import {
  applySizeMeasurements,
  isSizeMeasurementStale,
  type ProjectSizeEntry,
  type ProjectSizesResponse,
  type SizeMeasurement,
} from "./projects-schema";
import { getProjectsPath, readProjectsFile, writeProjectsFile } from "./projects-store";
import type { WebIdentity } from "./request-identity";

/**
 * The background size measurement for the projects dashboard.
 *
 * ### Why the measurement left the request
 *
 * `GET /api/projects` used to measure every stale folder *before* it
 * answered. `du -sb` per folder, eight at a time: one measurement of the 18
 * roots of a real registry takes **6,9 s to 20,5 s** (three runs over the
 * same paths on 2026-10-22 on the dev host; the spread is the page cache of
 * the filesystem, the details, the numbers of the folders without a size and
 * the reason the run is expensive are in `lib/project-size.ts`), and the
 * endpoint answered only after it. The board showed nothing at all for those
 * seconds — not a spinner, not a partial board: nothing.
 *
 * So the measurement moved here, out of the request. What is left in the
 * request is the answer to "how big is this folder", and that answer is
 * *stale information*, not a measurement result. The request now ships the
 * last known value immediately and the new value arrives on a poll.
 *
 * ### The deferred measurement was rejected once — for a reason that no longer holds
 *
 * The old route carried this note: "Deferred measurement was rejected: a
 * value that arrives on a poll nobody triggers is a value that never
 * arrives." The reasoning was right and the conclusion was wrong *for that
 * design*: nothing triggered the poll, so the value would indeed never
 * arrive. Now the client polls `GET /api/projects/sizes` and that endpoint
 * triggers the run itself, so the value arrives. The rejection was of the
 * *missing trigger*, not of deferral as such.
 *
 * ### The write is the dangerous part
 *
 * A measurement run takes 6,9 s to 20,5 s — up to 90 s when the per-folder
 * budget of 30 s is hit, because the pool rounds of 18 roots are serial
 * (three rounds of 30 s). Writing the result back at the end of that run
 * means writing a file that was read seconds ago — and a `PUT` in between (a
 * changed priority, a todo counter, a status) is silently overwritten. That
 * is data loss, not cosmetics.
 *
 * So the run reads the registry **again**, immediately before the write, and
 * applies the measurement to *that* state (`applySizeMeasurements` touches
 * `sizeBytes` and `sizeMeasuredAt` and nothing else). The window between
 * read and write is milliseconds instead of twenty seconds, and a project
 * that was deleted in between is simply not in the fresh state, so it is
 * never written back.
 *
 * ### One run per identity
 *
 * Two parallel requests of the same identity produce **one** run, not two:
 * the lock lives on `globalThis` (which survives the Next.js hot reload, and
 * which `AGENTS.md` requires — a module-level `Map` does not survive it),
 * keyed by the registry path. The path is the unit of contention, not the
 * user name: two admin accounts share one global registry file, and a lock
 * keyed by the user name would let them measure and write the same file at
 * the same time. Two identities with two registries get two runs, and they
 * never see each other's folders — the roots come from this identity's
 * registry and from nowhere else.
 *
 * The lock is released in a `finally`, so a failed run does not wedge the
 * identity forever.
 */

/** How a set of roots is measured. Injectable so a test can hold a run open. */
export type SizeMeasurer = (roots: readonly string[]) => Promise<Map<string, SizeMeasurement>>;

declare global {
  /**
   * The in-flight measurement runs, keyed by registry path.
   *
   * `globalThis` and not a module-level `Map`: `AGENTS.md` is explicit that
   * the dev server reloads modules on every change, and a `Map` that lives in
   * a module is empty again after the reload — which would let a second run
   * start while the first is still measuring. `lib/rpc-manager.ts` keeps its
   * session registry and its start locks the same way.
   */
  var __ompProjectSizeRuns: Map<string, Promise<void>> | undefined;
}

function getRuns(): Map<string, Promise<void>> {
  if (!globalThis.__ompProjectSizeRuns) globalThis.__ompProjectSizeRuns = new Map();
  return globalThis.__ompProjectSizeRuns;
}

/**
 * Measure the stale folders of this identity and store the result.
 *
 * The registry is read twice, and that is the whole point: once to find out
 * *what* to measure, and once — right before the write — to find out what
 * the file *now* says. The second read is what keeps a `PUT` from being
 * overwritten by a measurement that started before it.
 */
async function measureAndStore(identity: WebIdentity, measure: SizeMeasurer): Promise<void> {
  const file = readProjectsFile(identity);
  if (file === null) return;

  const stale = file.projects.filter((project) => isSizeMeasurementStale(project));
  // Nothing to do: every folder has a measurement that is still inside its
  // TTL. Starting a `du` swarm here would be the old behaviour under a new
  // name.
  if (stale.length === 0) return;

  const measurements = await measure(stale.map((project) => project.root));
  const measuredAt = new Date().toISOString();

  // The fresh read. Everything that happened to the registry during the
  // measurement is in here, and `applySizeMeasurements` changes nothing but
  // the two size fields.
  const fresh = readProjectsFile(identity);
  if (fresh === null) return;

  const withSizes = applySizeMeasurements(fresh.projects, measurements, measuredAt);
  writeProjectsFile(identity, { ...fresh, projects: withSizes });
}

/**
 * Start a measurement run for this identity, unless one is already running.
 *
 * Fire and forget: the caller does not wait, and the caller is a route that
 * has already answered. The returned promise is deliberately not handed out
 * — a caller that awaited it would be the synchronous measurement this
 * module exists to remove.
 *
 * Errors are caught and logged. An unhandled rejection in a Next.js server
 * takes the process down, and a folder that cannot be measured is not worth
 * a restart.
 */
export function startProjectSizeMeasurement(
  identity: WebIdentity,
  options: { measure?: SizeMeasurer } = {},
): void {
  // The registry path is the key: it is the file the run reads and writes,
  // and two admin accounts share one such file.
  const key = getProjectsPath(identity);
  const runs = getRuns();
  // One run per identity. The check and the set happen in the same
  // synchronous block, so two parallel calls cannot both get through.
  if (runs.has(key)) return;

  const measure = options.measure ?? measureProjectSizes;
  const run = measureAndStore(identity, measure)
    .catch((error) => {
      console.error("[projects] the size measurement failed:", error);
    })
    .finally(() => {
      runs.delete(key);
    });
  runs.set(key, run);
}

/**
 * `true` while a measurement run for this identity is in flight.
 *
 * Only used by the tests; the routes do not need it, because they trigger a
 * run and let it happen.
 */
export function isProjectSizeMeasurementRunning(identity: WebIdentity): boolean {
  return getRuns().has(getProjectsPath(identity));
}

/**
 * The last known sizes of this identity's projects, and whether a measurement
 * is still owed.
 *
 * `pending` is `true` when at least one project has no measurement or a
 * measurement that is older than the TTL. The client polls while it is
 * `true` and stops when it is `false`.
 *
 * A project whose measurement *failed* (a folder that cannot be measured in
 * the budget) is not pending: the attempt happened, the answer is "no size",
 * and the next attempt is due when its TTL expires. Without that
 * distinction the client would poll for two minutes against a folder that
 * will never have a size.
 */
export function readProjectSizes(identity: WebIdentity, now = Date.now()): ProjectSizesResponse {
  const file = readProjectsFile(identity);
  const projects = file?.projects ?? [];

  const sizes: ProjectSizeEntry[] = projects.map((project) => ({
    root: project.root,
    sizeBytes: project.sizeBytes ?? null,
    sizeMeasuredAt: project.sizeMeasuredAt ?? null,
    sizeIsLowerBound: project.sizeIsLowerBound === true,
  }));

  return {
    sizes,
    pending: projects.some((project) => isSizeMeasurementStale(project, now)),
  };
}
