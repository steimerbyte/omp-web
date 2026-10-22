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

const TENANT = { host: "localhost", "x-omp-user": "alice" };
const ANON = { host: "localhost" };
const alice = { username: "alice", isAdmin: false };
const PROJECT_ROOT = "/tmp/omp-web-sizes-project";

const route = await import("./sizes/route.ts");
const { getProjectsPath, writeProjectsFile } = await import("@/lib/projects-store.ts");

function withHome(fn) {
  const previous = process.env.OMP_WEB_HOME_ROOT;
  const root = mkdtempSync(join(tmpdir(), "omp-web-sizes-"));
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

function writeRegistry(project) {
  writeProjectsFile(alice, {
    schemaVersion: 1,
    projects: [project],
    priorities: [],
  });
}

function readRegistry() {
  return JSON.parse(readFileSync(getProjectsPath(alice), "utf8"));
}

async function waitForRegistry(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const file = readRegistry();
    if (predicate(file)) return file;
    if (Date.now() > deadline) throw new Error(`the registry did not change within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// --------------------------------------------------------------- guards --

test("GET /api/projects/sizes without an identity is 403 and writes nothing", () =>
  withHome(async () => {
    const response = await route.GET(request("/api/projects/sizes", { headers: ANON }));
    assert.equal(response.status, 403);
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(getProjectsPath(alice)), false, "a refused request must not create a registry");
  }));

test("GET /api/projects/sizes refuses a cross-site request", () =>
  withHome(async () => {
    const response = await route.GET(
      request("/api/projects/sizes", {
        headers: { ...TENANT, origin: "http://evil.example", "sec-fetch-site": "cross-site" },
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

test("the sizes route uses the shared guard instead of a copy of it", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./sizes/route.ts", import.meta.url), "utf8");
  // Only the code is asserted, not the prose: the comments explain the
  // guard chain and would match a naive scan.
  const code = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .join("\n");

  assert.match(code, /requireProjectsIdentity/, "the shared guard is used");
  assert.doesNotMatch(
    code,
    /getRequestIdentity/,
    "the identity check belongs to lib/projects-guards.ts, not to this route",
  );
  assert.doesNotMatch(
    code,
    /requireAdmin/,
    "the sizes are per account; admin-only would lock tenants out of their own dashboard",
  );
});

// --------------------------------------------------------- the answer --

test("the endpoint answers with the sizes and the pending flag", () =>
  withHome(async () => {
    writeRegistry({
      root: PROJECT_ROOT,
      priority: "now",
      openTodos: 0,
      status: "yellow",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastTouchedAt: "2026-01-01T00:00:00.000Z",
      sizeBytes: 4711,
      sizeMeasuredAt: new Date().toISOString(),
    });

    const response = await route.GET(request("/api/projects/sizes"));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(Array.isArray(body.sizes), true, "sizes is an array");
    assert.equal(body.sizes.length, 1);
    assert.equal(body.sizes[0].root, PROJECT_ROOT);
    assert.equal(body.sizes[0].sizeBytes, 4711);
    assert.equal(typeof body.sizes[0].sizeMeasuredAt, "string");
    assert.equal(body.sizes[0].sizeIsLowerBound, false, "a complete measurement is not a lower bound");
    assert.equal(body.pending, false, "a fresh measurement is nothing to wait for");
  }));

test("a project that was never measured is pending", () =>
  withHome(async () => {
    writeRegistry({
      root: PROJECT_ROOT,
      priority: "now",
      openTodos: 0,
      status: "yellow",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastTouchedAt: "2026-01-01T00:00:00.000Z",
    });

    const response = await route.GET(request("/api/projects/sizes"));
    const body = await response.json();
    assert.equal(body.pending, true, "the client has to keep polling");
    assert.equal(body.sizes[0].sizeBytes, null, "no size has been measured yet");
    assert.equal(body.sizes[0].sizeMeasuredAt, null, "and no measurement was made yet");
    assert.equal(body.sizes[0].sizeIsLowerBound, false, "there is no number to bound");
  }));

test("the endpoint starts the measurement itself", () =>
  withHome(async () => {
    writeRegistry({
      root: PROJECT_ROOT,
      priority: "now",
      openTodos: 0,
      status: "yellow",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastTouchedAt: "2026-01-01T00:00:00.000Z",
      sizeBytes: 1,
      sizeMeasuredAt: "2026-01-01T00:00:00.000Z",
    });

    const response = await route.GET(request("/api/projects/sizes"));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).pending, true);

    // The run writes the measurement back. That it happens at all is the
    // proof that the endpoint triggers the run — the client only ever calls
    // this endpoint.
    const file = await waitForRegistry(
      (stored) => stored.projects[0].sizeMeasuredAt !== "2026-01-01T00:00:00.000Z",
    );
    assert.notEqual(file.projects[0].sizeMeasuredAt, "2026-01-01T00:00:00.000Z");
  }));

test("a measurement that failed is not pending any more", () =>
  withHome(async () => {
    // A folder that cannot be measured: the attempt happened, the answer is
    // "no size", and the client must stop waiting for a number that will
    // not arrive.
    writeRegistry({
      root: PROJECT_ROOT,
      priority: "now",
      openTodos: 0,
      status: "yellow",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastTouchedAt: "2026-01-01T00:00:00.000Z",
      sizeBytes: null,
      sizeMeasuredAt: new Date().toISOString(),
    });

    const response = await route.GET(request("/api/projects/sizes"));
    const body = await response.json();
    assert.equal(body.pending, false, "a failed measurement is an answer, not a promise");
    assert.equal(body.sizes[0].sizeBytes, null);
    assert.equal(typeof body.sizes[0].sizeMeasuredAt, "string");
  }));

test("the endpoint measures only this identity's projects", () =>
  withHome(async () => {
    const bob = { username: "bob", isAdmin: false };
    writeProjectsFile(bob, {
      schemaVersion: 1,
      projects: [
        {
          root: "/tmp/omp-web-sizes-bob",
          priority: "now",
          openTodos: 0,
          status: "yellow",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastTouchedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      priorities: [],
    });

    const response = await route.GET(request("/api/projects/sizes"));
    const body = await response.json();
    assert.deepEqual(
      body.sizes.map((size) => size.root),
      [],
      "alice has no registry of her own, so she sees no sizes at all",
    );
    assert.equal(body.pending, false);
  }));
