import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mock } from "bun:test";

/**
 * The race between a measurement and a write.
 *
 * ### What this is about
 *
 * `GET /api/projects` used to measure the folder sizes *before* it answered,
 * and to write the result back when the measurement was done. The registry it
 * wrote back was the one it had read **at the start** of the request — a
 * snapshot that was already half a minute old by the time it landed on the
 * disk. A `PUT` in between — a changed priority, a todo counter, a status —
 * was silently overwritten by that snapshot. That is data loss, not
 * cosmetics, and it is the reason the measurement had to move into the
 * background *and* re-read the registry before it writes.
 *
 * ### How the race is made deterministic
 *
 * In production the window is 20,5 s wide — one measurement of the 18 roots
 * of a real registry (measured 2026-10-22 on the dev host, the details in
 * `lib/project-size.ts`), and up to about 60 s when the per-folder budget is
 * hit. A test cannot wait for that, and a test that does not control the
 * window tests nothing: it would pass or fail depending on how fast the
 * machine is.
 *
 * So the measurement is replaced by a promise the test holds open. The fake
 * module below stands in for `lib/project-size.ts` — the only thing the
 * production code does with it is call `measureProjectSizes` and wait for the
 * result. The test decides when that result arrives, and the race is decided
 * by the test's ordering, not by a stopwatch.
 *
 * The test drives the **route**, not the store: a test that calls the writer
 * directly proves the writer works, not that the route uses it.
 */

const TENANT = { host: "localhost", "x-omp-user": "alice" };
const alice = { username: "alice", isAdmin: false };
const PROJECT_ROOT = "/tmp/omp-web-race-project";
const OLD_MEASUREMENT = "2026-01-01T00:00:00.000Z";

/**
 * The measurement gate: the test opens it before the request and closes it
 * when it wants the measurement to end.
 */
let gate = null;
let measurementCalls = 0;

mock.module("@/lib/project-size", () => ({
  SIZE_TIMEOUT_MS: 10_000,
  MAX_PARALLEL: 8,
  measureProjectSize: async () => null,
  measureProjectSizes: async (roots) => {
    measurementCalls += 1;
    gate?.markStarted();
    await gate?.finished;
    return new Map(roots.map((root) => [root, 4242]));
  },
}));

function armGate() {
  let markStarted;
  let release;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const finished = new Promise((resolve) => {
    release = resolve;
  });
  gate = { markStarted, finished };
  return { started, release: () => release() };
}

const route = await import("./route.ts");
const { getProjectsPath, writeProjectsFile } = await import("@/lib/projects-store.ts");

function withHome(fn) {
  const previous = process.env.OMP_WEB_HOME_ROOT;
  const root = mkdtempSync(join(tmpdir(), "omp-web-size-race-"));
  process.env.OMP_WEB_HOME_ROOT = root;
  const restore = () => {
    if (previous === undefined) delete process.env.OMP_WEB_HOME_ROOT;
    else process.env.OMP_WEB_HOME_ROOT = previous;
  };
  const result = fn(root);
  if (result && typeof result.then === "function") {
    return result.then(
      (value) => {
        restore();
        rmSync(root, { recursive: true, force: true });
        return value;
      },
      (error) => {
        restore();
        rmSync(root, { recursive: true, force: true });
        throw error;
      },
    );
  }
  restore();
  rmSync(root, { recursive: true, force: true });
  return result;
}

function request(url, { method = "GET", headers = TENANT, body } = {}) {
  return new Request(`http://${headers.host ?? "localhost"}${url}`, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function readRegistry() {
  return JSON.parse(readFileSync(getProjectsPath(alice), "utf8"));
}

function writeRegistry(project) {
  writeProjectsFile(alice, {
    schemaVersion: 1,
    projects: [project],
    priorities: [],
  });
}

/** A project whose measurement is long expired, so a measurement is owed. */
function staleProject() {
  return {
    root: PROJECT_ROOT,
    priority: "now",
    openTodos: 0,
    status: "red",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastTouchedAt: "2026-01-01T00:00:00.000Z",
    sizeBytes: 1,
    sizeMeasuredAt: OLD_MEASUREMENT,
  };
}

/**
 * Wait until the registry on disk says what the predicate wants.
 *
 * The background run writes the file after the measurement ended, and the
 * test does not get a handle on that write — it watches the disk, which is
 * where the loss would have happened anyway.
 */
async function waitForRegistry(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const file = readRegistry();
    if (predicate(file)) return file;
    if (Date.now() > deadline) {
      throw new Error(`the registry did not change within ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a priority changed during the measurement is not lost", () => withHome(async () => {
  const measurement = armGate();
  measurementCalls = 0;
  writeRegistry(staleProject());

  // The GET starts the measurement.
  const pendingGet = route.GET(request("/api/projects"));
  await measurement.started;

  // The user changes the card while the measurement is still running.
  const put = await route.PUT(
    request("/api/projects", {
      method: "PUT",
      body: { projects: [{ root: PROJECT_ROOT, priority: "later", openTodos: 0, status: "red" }] },
    }),
  );
  assert.equal(put.status, 200);

  // The measurement ends, and the result is written back.
  measurement.release();
  await pendingGet;
  const file = await waitForRegistry((stored) => stored.projects[0].sizeMeasuredAt !== OLD_MEASUREMENT);

  assert.equal(
    file.projects[0].priority,
    "later",
    "the priority the user set must survive the measurement that was already running",
  );
  assert.equal(file.projects[0].sizeBytes, 4242, "the measurement itself was stored");
}), 20_000);

test("the measurement writes the size fields and nothing else", () => withHome(async () => {
  const measurement = armGate();
  measurementCalls = 0;
  writeRegistry(staleProject());

  const pendingGet = route.GET(request("/api/projects"));
  await measurement.started;

  // Everything the user can change, changed at once.
  const put = await route.PUT(
    request("/api/projects", {
      method: "PUT",
      body: {
        projects: [{ root: PROJECT_ROOT, priority: "done", openTodos: 7, status: "green" }],
      },
    }),
  );
  assert.equal(put.status, 200);

  measurement.release();
  await pendingGet;
  const file = await waitForRegistry((stored) => stored.projects[0].sizeMeasuredAt !== OLD_MEASUREMENT);
  const project = file.projects[0];

  assert.equal(project.priority, "done", "the priority survived");
  assert.equal(project.openTodos, 7, "the todo counter survived");
  assert.equal(project.status, "green", "the status survived");
  assert.equal(project.root, PROJECT_ROOT, "the key survived");
  // The two fields the measurement owns, and only those two, are new.
  assert.equal(project.sizeBytes, 4242, "the size was written");
  assert.notEqual(project.sizeMeasuredAt, OLD_MEASUREMENT, "the measurement timestamp was written");
}), 20_000);

test("the GET answers while the measurement is still running", () => withHome(async () => {
  const measurement = armGate();
  measurementCalls = 0;
  writeRegistry(staleProject());

  // The first GET starts the measurement. It is not awaited: on the old code
  // it does not answer until the measurement is done, and this test is about
  // exactly that.
  const firstGet = route.GET(request("/api/projects"));
  await measurement.started;

  // The measurement is now held open. A second GET must not wait for it.
  // The race below is the assertion: a GET that waits for the measurement
  // never answers, and "never" is what the timeout stands for.
  const started = Date.now();
  const answered = await Promise.race([
    route.GET(request("/api/projects")).then((response) => ({ response })),
    new Promise((resolve) => setTimeout(() => resolve(null), 500)),
  ]);
  const duration = Date.now() - started;

  assert.ok(answered !== null, "the GET waited for the measurement that was already running");
  assert.equal(answered.response.status, 200);
  // The measurement is held open for the whole test, so any waiting for it
  // would be unbounded. The bound is a second; the measured duration of this
  // GET on the test host was 12 ms (2026-10-22, Bun 1.4.0, WSL2).
  assert.ok(duration < 1_000, `the GET waited ${duration} ms for a running measurement`);

  measurement.release();
  await firstGet;
  await waitForRegistry((stored) => stored.projects[0].sizeMeasuredAt !== OLD_MEASUREMENT);
}), 20_000);

test("two requests of the same identity cause one measurement", () => withHome(async () => {
  const measurement = armGate();
  measurementCalls = 0;
  writeRegistry(staleProject());

  // Both requests are in flight. The first one starts the measurement; the
  // second one has to join it instead of starting a second `du` swarm.
  const first = route.GET(request("/api/projects"));
  const second = route.GET(request("/api/projects"));
  await measurement.started;

  assert.equal(measurementCalls, 1, "the second request joined the running measurement");

  measurement.release();
  await Promise.all([first, second]);
  await waitForRegistry((stored) => stored.projects[0].sizeMeasuredAt !== OLD_MEASUREMENT);
}), 20_000);
