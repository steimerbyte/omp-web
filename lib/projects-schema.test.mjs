import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SIZE_TTL_MS, applySizeMeasurements, isSizeMeasurementStale } = await jiti.import(
  "./projects-schema.ts",
);

/**
 * The size cache of the projects registry: how long a measurement is trusted,
 * and what a measurement may change.
 *
 * The TTL is a number in a comment in `lib/projects-schema.ts`, and
 * `AGENTS.md` says that a number in a comment needs a test that checks the
 * same number — otherwise the next reader believes a recollection. So the
 * value is asserted here, and the boundary is exercised around it.
 */

const MEASURED_AT = "2026-10-22T12:00:00.000Z";
const MEASURED_AT_MS = Date.parse(MEASURED_AT);

test("the size TTL is five minutes", () => {
  // Five minutes, and the reason is in the comment above `SIZE_TTL_MS`: the
  // old value of 30 s was shorter than the measurement it was supposed to
  // space out.
  //
  // The measurement of the 18 folders of the measured registry took 6,9 s to
  // 20,5 s on 2026-10-22 (three runs over identical paths; the spread is the
  // page cache of the filesystem). The 52,0 s that also comes up in the
  // repository is a different number: that is the *whole request* on a cold
  // cache, measured with `curl -w "%{time_total}"` — the measurement plus
  // the git calls of the board.
  assert.equal(SIZE_TTL_MS, 300_000);
  assert.equal(SIZE_TTL_MS, 5 * 60_000);
});

test("a fresh measurement is not measured again", () => {
  assert.equal(isSizeMeasurementStale({ sizeMeasuredAt: MEASURED_AT }, MEASURED_AT_MS), false);
  // Right up to the TTL, the measurement is still trusted.
  assert.equal(
    isSizeMeasurementStale({ sizeMeasuredAt: MEASURED_AT }, MEASURED_AT_MS + SIZE_TTL_MS - 1),
    false,
  );
});

test("an expired measurement is measured again", () => {
  assert.equal(
    isSizeMeasurementStale({ sizeMeasuredAt: MEASURED_AT }, MEASURED_AT_MS + SIZE_TTL_MS),
    true,
  );
  assert.equal(
    isSizeMeasurementStale({ sizeMeasuredAt: MEASURED_AT }, MEASURED_AT_MS + SIZE_TTL_MS + 1),
    true,
  );
});

test("a project that was never measured is measured", () => {
  assert.equal(isSizeMeasurementStale({}, MEASURED_AT_MS), true);
  assert.equal(isSizeMeasurementStale({ sizeMeasuredAt: undefined }, MEASURED_AT_MS), true);
  // A timestamp that is not a timestamp is no timestamp.
  assert.equal(isSizeMeasurementStale({ sizeMeasuredAt: "not a date" }, MEASURED_AT_MS), true);
});

test("a failed measurement waits for its TTL instead of being retried at once", () => {
  // The folder could not be measured: the attempt happened and failed. The
  // old rule (`sizeBytes === null` means stale) retried it on every single
  // request, which is what produced a `du` swarm every 30 seconds for a
  // folder that can never be measured.
  const failed = { sizeBytes: null, sizeMeasuredAt: MEASURED_AT };
  assert.equal(isSizeMeasurementStale(failed, MEASURED_AT_MS), false);
  assert.equal(isSizeMeasurementStale(failed, MEASURED_AT_MS + SIZE_TTL_MS), true);
});

test("a measurement changes the size fields and nothing else", () => {
  const project = {
    root: "/tmp/omp-web-schema-project",
    priority: "now",
    openTodos: 3,
    status: "red",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastTouchedAt: "2026-01-02T00:00:00.000Z",
    adopted: true,
  };

  const measured = applySizeMeasurements(
    [project],
    new Map([[project.root, { bytes: 4242, partial: false }]]),
    MEASURED_AT,
  );

  assert.equal(measured[0].sizeBytes, 4242);
  assert.equal(measured[0].sizeMeasuredAt, MEASURED_AT);
  assert.equal(measured[0].sizeIsLowerBound, undefined, "a complete measurement claims nothing");
  assert.equal(measured[0].priority, "now");
  assert.equal(measured[0].openTodos, 3);
  assert.equal(measured[0].status, "red");
  assert.equal(measured[0].lastTouchedAt, "2026-01-02T00:00:00.000Z");
  assert.equal(measured[0].adopted, true);
});

test("a project that was not measured keeps its old values", () => {
  const project = {
    root: "/tmp/omp-web-schema-other",
    priority: "later",
    openTodos: 0,
    status: "green",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastTouchedAt: "2026-01-02T00:00:00.000Z",
    sizeBytes: 99,
    sizeMeasuredAt: MEASURED_AT,
  };

  const measured = applySizeMeasurements(
    [project],
    new Map([["/tmp/omp-web-schema-project", { bytes: 4242, partial: false }]]),
    "2026-10-22T13:00:00.000Z",
  );

  assert.equal(measured[0].sizeBytes, 99, "a project outside the measurement keeps its size");
  assert.equal(measured[0].sizeMeasuredAt, MEASURED_AT);
});

test("a partial measurement is marked as a lower bound", () => {
  const project = {
    root: "/tmp/omp-web-schema-partial",
    priority: "now",
    openTodos: 0,
    status: "yellow",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastTouchedAt: "2026-01-01T00:00:00.000Z",
  };

  const measured = applySizeMeasurements(
    [project],
    new Map([[project.root, { bytes: 1864862, partial: true }]]),
    MEASURED_AT,
  );

  // The number and the flag travel together: a number that only saw part of
  // the tree is a lower bound, and the card has to be able to say so.
  assert.equal(measured[0].sizeBytes, 1864862);
  assert.equal(measured[0].sizeIsLowerBound, true);
});

test("a stored lower bound survives the round trip through the store", async () => {
  const { normalizeProjectMeta } = await jiti.import("./projects-schema.ts");
  const stored = normalizeProjectMeta({
    root: "/tmp/omp-web-schema-partial",
    priority: "now",
    openTodos: 0,
    status: "yellow",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastTouchedAt: "2026-01-01T00:00:00.000Z",
    sizeBytes: 1864862,
    sizeMeasuredAt: MEASURED_AT,
    sizeIsLowerBound: true,
  });

  assert.equal(stored.sizeIsLowerBound, true);
  assert.equal(stored.sizeBytes, 1864862);
});
