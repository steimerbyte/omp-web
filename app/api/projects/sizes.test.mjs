import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * The polling endpoint for the folder sizes.
 *
 * The tests call the **route**, not the guard: a test that calls
 * `requireProjectsIdentity` directly proves the guard works, not that the
 * route uses it — and that difference is exactly how the web-access break of
 * 12.10.2026 happened. Same discipline as `app/api/projects/route.test.mjs`.
 *
 * The measurement itself is *not* mocked here. The registry in these tests
 * points at a folder that does not exist, so `du` fails immediately and the
 * measurement ends in milliseconds — the endpoint's own behaviour (it starts
 * a run) is what is under test, and a run that ends at once is easier to
 * wait for than one that takes a minute.
 */

const ANON = { host: "localhost" };

const route = await import("./sizes/route.ts");
const { getProjectsPath, writeProjectsFile } = await import("@/lib/projects-store.ts");

/**
 * A fresh identity and a fresh home per test.
 *
 * The allow-roots cache is keyed by the identity and lives five seconds, so
 * tests that share a username would hand each other the previous test's temp
 * root — and the endpoint would report nothing for a reason that has nothing
 * to do with the case under test. Same reasoning as
 * `app/api/projects/delete-route.test.mjs`.
 */
let identityCounter = 0;

function withHome(fn) {
  const previous = process.env.OMP_WEB_HOME_ROOT;
  const root = mkdtempSync(join(tmpdir(), "omp-web-sizes-"));
  process.env.OMP_WEB_HOME_ROOT = root;

  identityCounter += 1;
  const identity = { username: `alice${identityCounter}`, isAdmin: false };
  const headers = { host: "localhost", "x-omp-user": identity.username };
  // The account's home is `<root>/<username>` and the home is in the
  // allow-list, so a folder below it is visible to that account. A folder
  // outside it is not — and the endpoint must not report it.
  const visibleRoot = join(root, identity.username, "workspace", "project");
  const hiddenRoot = join(root, "elsewhere", "foreign-project");

  const restore = () => {
    if (previous === undefined) delete process.env.OMP_WEB_HOME_ROOT;
    else process.env.OMP_WEB_HOME_ROOT = previous;
  };
  const result = fn({ identity, headers, visibleRoot, hiddenRoot, root });
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

function request(url, { method = "GET", headers, body } = {}) {
  return new Request(`http://${headers?.host ?? "localhost"}${url}`, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function writeRegistry(identity, projects) {
  writeProjectsFile(identity, { schemaVersion: 1, projects, priorities: [] });
}

function readRegistry(identity) {
  return JSON.parse(readFileSync(getProjectsPath(identity), "utf8"));
}

async function waitForRegistry(identity, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const file = readRegistry(identity);
    if (predicate(file)) return file;
    if (Date.now() > deadline) throw new Error(`the registry did not change within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A project with a fresh measurement of `sizeBytes`. */
function measured(root, sizeBytes, measuredAt = new Date().toISOString()) {
  return {
    root,
    priority: "now",
    openTodos: 0,
    status: "yellow",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastTouchedAt: "2026-01-01T00:00:00.000Z",
    sizeBytes,
    sizeMeasuredAt: measuredAt,
  };
}

// --------------------------------------------------------------- guards --

test("GET /api/projects/sizes without an identity is 403 and writes nothing", () =>
  withHome(async ({ identity }) => {
    const response = await route.GET(request("/api/projects/sizes", { headers: ANON }));
    assert.equal(response.status, 403);
    const { existsSync } = await import("node:fs");
    assert.equal(
      existsSync(getProjectsPath(identity)),
      false,
      "a refused request must not create a registry",
    );
  }));

test("GET /api/projects/sizes refuses a cross-site request", () =>
  withHome(async ({ headers }) => {
    const response = await route.GET(
      request("/api/projects/sizes", {
        headers: { ...headers, origin: "http://evil.example", "sec-fetch-site": "cross-site" },
      }),
    );
    assert.equal(response.status, 403);
  }));

test("an admin header alone is not an identity", () =>
  withHome(async () => {
    const response = await route.GET(
      request("/api/projects/sizes", { headers: { host: "localhost", "x-omp-admin": "1" } }),
    );
    assert.equal(response.status, 403);
  }));

// ----------------------------------------------------------- visibility --

test("the endpoint reports only the folders the account may see", () =>
  withHome(async ({ identity, headers, visibleRoot, hiddenRoot }) => {
    // Two folders in one registry: one inside the account's own home, one
    // outside it. The board shows only the first one, so the sizes endpoint
    // must not report the second one either — not its size, not its
    // measurement time, not its existence.
    writeRegistry(identity, [measured(visibleRoot, 4711), measured(hiddenRoot, 9999)]);

    const response = await route.GET(request("/api/projects/sizes", { headers }));
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.deepEqual(
      body.sizes.map((size) => size.root),
      [visibleRoot],
      "a folder the account may not see is not reported",
    );
    assert.equal(
      body.sizes.some((size) => size.sizeBytes === 9999),
      false,
      "its size is not reported either",
    );
  }));

test("a hidden folder that owes a measurement does not keep the client polling", () =>
  withHome(async ({ identity, headers, visibleRoot, hiddenRoot }) => {
    // The visible folder is fresh, the hidden one is stale. `pending` is
    // computed over the same set the endpoint answers, so the client does
    // not poll for two minutes for a number it will never be shown.
    writeRegistry(identity, [
      measured(visibleRoot, 4711),
      measured(hiddenRoot, 1, "2026-01-01T00:00:00.000Z"),
    ]);

    const response = await route.GET(request("/api/projects/sizes", { headers }));
    const body = await response.json();
    assert.equal(body.pending, false, "the client waits for what it can see");
  }));

// --------------------------------------------------------- the answer --

test("the endpoint answers with the sizes and the pending flag", () =>
  withHome(async ({ identity, headers, visibleRoot }) => {
    writeRegistry(identity, [measured(visibleRoot, 4711)]);

    const response = await route.GET(request("/api/projects/sizes", { headers }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(Array.isArray(body.sizes), true, "sizes is an array");
    assert.equal(body.sizes.length, 1);
    assert.equal(body.sizes[0].root, visibleRoot);
    assert.equal(body.sizes[0].sizeBytes, 4711);
    assert.equal(typeof body.sizes[0].sizeMeasuredAt, "string");
    assert.equal(body.sizes[0].sizeIsLowerBound, false, "a complete measurement is not a lower bound");
    assert.equal(body.pending, false, "a fresh measurement is nothing to wait for");
  }));

test("a project that was never measured is pending", () =>
  withHome(async ({ identity, headers, visibleRoot }) => {
    writeRegistry(identity, [
      {
        root: visibleRoot,
        priority: "now",
        openTodos: 0,
        status: "yellow",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastTouchedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const response = await route.GET(request("/api/projects/sizes", { headers }));
    const body = await response.json();
    assert.equal(body.pending, true, "the client has to keep polling");
    assert.equal(body.sizes[0].sizeBytes, null, "no size has been measured yet");
    assert.equal(body.sizes[0].sizeMeasuredAt, null, "and no measurement was made yet");
    assert.equal(body.sizes[0].sizeIsLowerBound, false, "there is no number to bound");
  }));

test("the endpoint starts the measurement itself", () =>
  withHome(async ({ identity, headers, visibleRoot }) => {
    writeRegistry(identity, [measured(visibleRoot, 1, "2026-01-01T00:00:00.000Z")]);

    const response = await route.GET(request("/api/projects/sizes", { headers }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).pending, true);

    // The run writes the measurement back. That it happens at all is the
    // proof that the endpoint triggers the run — the client only ever calls
    // this endpoint.
    const file = await waitForRegistry(
      identity,
      (stored) => stored.projects[0].sizeMeasuredAt !== "2026-01-01T00:00:00.000Z",
    );
    assert.notEqual(file.projects[0].sizeMeasuredAt, "2026-01-01T00:00:00.000Z");
  }));

test("a measurement that failed is not pending any more", () =>
  withHome(async ({ identity, headers, visibleRoot }) => {
    // A folder that cannot be measured: the attempt happened, the answer is
    // "no size", and the client must stop waiting for a number that will
    // not arrive.
    writeRegistry(identity, [measured(visibleRoot, null)]);

    const response = await route.GET(request("/api/projects/sizes", { headers }));
    const body = await response.json();
    assert.equal(body.pending, false, "a failed measurement is an answer, not a promise");
    assert.equal(body.sizes[0].sizeBytes, null);
    assert.equal(typeof body.sizes[0].sizeMeasuredAt, "string");
  }));

test("the endpoint measures only this identity's projects", () =>
  withHome(async ({ headers }) => {
    const bob = { username: "bob", isAdmin: false };
    writeProjectsFile(bob, {
      schemaVersion: 1,
      projects: [measured("/tmp/omp-web-sizes-bob", 1)],
      priorities: [],
    });

    const response = await route.GET(request("/api/projects/sizes", { headers }));
    const body = await response.json();
    assert.deepEqual(
      body.sizes.map((size) => size.root),
      [],
      "alice has no registry of her own, so she sees no sizes at all",
    );
    assert.equal(body.pending, false);
  }));
