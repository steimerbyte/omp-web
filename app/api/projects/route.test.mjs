import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const route = await jiti.import("./route.ts");
const { getProjectsPath, writeProjectsFile } = await jiti.import("@/lib/projects-store.ts");

/**
 * Guard tests for /api/projects.
 *
 * These call the **route**, not the guards — the same discipline as
 * `app/api/host-wide-guards.test.mjs`. A test that calls `requireIdentity`
 * directly proves the guard works; it does not prove the route uses it, and
 * that difference is exactly how the web-access break happened.
 *
 * Every request runs against a temporary home, so the registry really is
 * written and really is read back: a route that returned 403 while still
 * writing would otherwise never be observed.
 */

const TENANT = { host: "localhost", "x-omp-user": "alice" };
const ANON = { host: "localhost" };

function withHome(fn) {
  const previous = process.env.OMP_WEB_HOME_ROOT;
  const root = mkdtempSync(join(tmpdir(), "omp-web-projects-route-"));
  process.env.OMP_WEB_HOME_ROOT = root;
  const restore = () => {
    if (previous === undefined) delete process.env.OMP_WEB_HOME_ROOT;
    else process.env.OMP_WEB_HOME_ROOT = previous;
  };
  // Async bodies must not have the home torn down before they finish, so the
  // cleanup is handed back and the caller awaits it.
  const result = fn(root);
  if (result && typeof result.then === "function") {
    return result.then(
      (value) => { restore(); rmSync(root, { recursive: true, force: true }); return value; },
      (error) => { restore(); rmSync(root, { recursive: true, force: true }); throw error; },
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

const alice = { username: "alice", isAdmin: false };

// --------------------------------------------------------------- guards --

test("GET without an identity is 403 and writes nothing", () => withHome(async () => {
  const response = await route.GET(request("/api/projects", { headers: ANON }));
  assert.equal(response.status, 403);
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(getProjectsPath(alice)), false, "a refused request must not create a registry");
}));

test("PUT without an identity is 403 and writes nothing", () => withHome(async () => {
  const response = await route.PUT(request("/api/projects", {
    method: "PUT",
    headers: ANON,
    body: { projects: [] },
  }));
  assert.equal(response.status, 403);
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(getProjectsPath(alice)), false);
}));

test("an admin header alone is not an identity", () => withHome(async () => {
  // `x-omp-admin` without `x-omp-user`: the role without the account. Both
  // headers are set by proxy.ts and nowhere else, and this pairing must not
  // authenticate anyone.
  const response = await route.GET(request("/api/projects", {
    headers: { host: "localhost", "x-omp-admin": "1" },
  }));
  assert.equal(response.status, 403);
}));

test("PUT without a JSON content type is 415", () => withHome(async () => {
  const bad = new Request("http://localhost/api/projects", {
    method: "PUT",
    headers: { ...TENANT, "content-type": "text/plain" },
    body: "{}",
  });
  const response = await route.PUT(bad);
  assert.equal(response.status, 415);
}));

test("a cross-origin request is refused before the identity is read", () => withHome(async () => {
  const response = await route.GET(request("/api/projects", {
    headers: { ...TENANT, origin: "http://evil.example", "sec-fetch-site": "cross-site" },
  }));
  assert.equal(response.status, 403);
}));

// ------------------------------------------------------------ validation --

test("PUT rejects a body without a projects array", () => withHome(async () => {
  const response = await route.PUT(request("/api/projects", { method: "PUT", body: { nope: [] } }));
  assert.equal(response.status, 400);
}));

test("PUT rejects a non-array projects field", () => withHome(async () => {
  const response = await route.PUT(request("/api/projects", { method: "PUT", body: { projects: "x" } }));
  assert.equal(response.status, 400);
}));

test("PUT rejects a relative root", () => withHome(async () => {
  writeProjectsFile(alice, {
    schemaVersion: 1,
    projects: [],
    priorities: [],
  });
  const response = await route.PUT(request("/api/projects", {
    method: "PUT",
    body: { projects: [{ root: "relative/path" }] },
  }));
  assert.equal(response.status, 400, "a relative path is not a folder key");
}));

test("PUT rejects duplicate roots rather than picking one", () => withHome(async () => {
  const root = "/tmp/omp-web-projects-dup";
  writeProjectsFile(alice, {
    schemaVersion: 1,
    projects: [{
      root, priority: "now", openTodos: 1, status: "red",
      createdAt: "2026-10-01T00:00:00.000Z", lastTouchedAt: "2026-10-01T00:00:00.000Z",
    }],
    priorities: [],
  });
  const response = await route.PUT(request("/api/projects", {
    method: "PUT",
    body: {
      projects: [
        { root, priority: "done", openTodos: 9, status: "green" },
        { root, priority: "later", openTodos: 8, status: "yellow" },
      ],
    },
  }));
  assert.equal(response.status, 400, "two entries for one folder is ambiguous");
}));

// -------------------------------------------------------------- the merge --

/**
 * The merge is the load-bearing behaviour of PUT: `root` and the timestamps
 * are the store's, and a client cannot write them. These are asserted by
 * reading the file back, not by trusting the response.
 */
test("a client cannot rewrite root, createdAt or adopted", () => withHome(async () => {
  const root = "/tmp/omp-web-projects-owned";
  const other = "/tmp/omp-web-projects-injected";
  writeProjectsFile(alice, {
    schemaVersion: 1,
    projects: [{
      root, priority: "now", openTodos: 3, status: "red",
      createdAt: "2026-01-01T00:00:00.000Z", lastTouchedAt: "2026-02-01T00:00:00.000Z",
      adopted: true,
    }],
    priorities: [],
  });

  const response = await route.PUT(request("/api/projects", {
    method: "PUT",
    body: {
      projects: [
        // Every server-owned field is present and hostile.
        {
          root, priority: "done", openTodos: 7, status: "green",
          createdAt: "1999-01-01T00:00:00.000Z", adopted: false, sizeBytes: 1,
        },
        // A root the registry never had: ignored, not inserted.
        { root: other, priority: "now", openTodos: 99, status: "red" },
      ],
    },
  }));
  assert.equal(response.status, 200);

  const onDisk = JSON.parse(readFileSync(getProjectsPath(alice), "utf8"));
  assert.equal(onDisk.projects.length, 1, "an unknown root is never inserted");
  const stored = onDisk.projects[0];
  assert.equal(stored.root, root);
  assert.equal(stored.createdAt, "2026-01-01T00:00:00.000Z", "createdAt is the store's");
  assert.equal(stored.adopted, true, "adopted is the store's");
  assert.equal(stored.sizeBytes, null, "the size cache is the store's");
  // The fields the client *is* allowed to change did change.
  assert.equal(stored.priority, "done");
  assert.equal(stored.openTodos, 7);
  assert.equal(stored.status, "green");
}));

test("omitting a project does not delete it", () => withHome(async () => {
  const keep = "/tmp/omp-web-projects-keep";
  writeProjectsFile(alice, {
    schemaVersion: 1,
    projects: [{
      root: keep, priority: "later", openTodos: 2, status: "yellow",
      createdAt: "2026-01-01T00:00:00.000Z", lastTouchedAt: "2026-01-01T00:00:00.000Z",
    }],
    priorities: [],
  });

  // A body with an empty array: a replace-semantics client would wipe this.
  const response = await route.PUT(request("/api/projects", { method: "PUT", body: { projects: [] } }));
  assert.equal(response.status, 200);

  const onDisk = JSON.parse(readFileSync(getProjectsPath(alice), "utf8"));
  assert.equal(onDisk.projects.length, 1, "PUT is a merge, never a replace");
  assert.equal(onDisk.projects[0].root, keep);
}));

test("a client can rename a category but not repaint or reorder it", () => withHome(async () => {
  writeProjectsFile(alice, { schemaVersion: 1, projects: [], priorities: [] });

  await route.PUT(request("/api/projects", {
    method: "PUT",
    body: {
      projects: [],
      // Reversed order, a hex colour, and an unknown id.
      priorities: [
        { id: "parked", name: "Archiv", colorValue: "#ff00ff" },
        { id: "now", name: "  ", colorValue: "var(--success)" },
        { id: "nonsense", name: "Nope", colorValue: "var(--danger)" },
      ],
    },
  }));

  const onDisk = JSON.parse(readFileSync(getProjectsPath(alice), "utf8"));
  assert.equal(onDisk.priorities.length, 5, "the five fixed categories are always present");
  assert.deepEqual(
    onDisk.priorities.map((p) => p.id),
    ["now", "important", "later", "done", "parked"],
    "sort order is not the client's to change",
  );
  const parked = onDisk.priorities.find((p) => p.id === "parked");
  assert.equal(parked.name, "Archiv", "renaming is the feature, so it works");
  assert.equal(parked.colorValue, "var(--text-dim)", "a hex literal is refused");
  const now = onDisk.priorities.find((p) => p.id === "now");
  assert.equal(now.colorValue, "var(--danger)", "the colour is the store's");
  assert.notEqual(now.name, "  ", "a blank name falls back to the default");
}));

// -------------------------------------------------------------- GET shape --

test("GET returns projects and priorities, and answers even with none", () => withHome(async () => {
  const response = await route.GET(request("/api/projects"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.projects), "projects is an array");
  assert.equal(body.priorities.length, 5, "the five categories ship with the endpoint");
  assert.equal(typeof body.home, "string", "the home is sent so the UI can build the create path");
}));

test("GET creates a registry for the account, and only for that account", () => withHome(async (root) => {
  await route.GET(request("/api/projects"));

  const bobPath = join(root, "bob", ".omp", "agent", "omp-web-projects.json");
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(getProjectsPath(alice)), true, "alice's own registry exists");
  assert.equal(existsSync(bobPath), false, "bob's is untouched");
}));

test("GET does not rewrite the registry when every size is cached", () => withHome(async () => {
  const root = "/tmp/omp-web-projects-cached";
  writeProjectsFile(alice, {
    schemaVersion: 1,
    projects: [{
      root, priority: "parked", openTodos: 0, status: "yellow",
      createdAt: "2026-01-01T00:00:00.000Z", lastTouchedAt: "2026-01-01T00:00:00.000Z",
      sizeBytes: 12345, sizeMeasuredAt: new Date().toISOString(),
    }],
    priorities: [],
  });
  const before = readFileSync(getProjectsPath(alice), "utf8");

  await route.GET(request("/api/projects"));

  assert.equal(readFileSync(getProjectsPath(alice), "utf8"), before, "a fully cached GET writes nothing");
}));

test("GET persists a fresh measurement for a stale project", () => withHome(async () => {
  const root = "/tmp/omp-web-projects-stale";
  writeProjectsFile(alice, {
    schemaVersion: 1,
    projects: [{
      root, priority: "parked", openTodos: 0, status: "yellow",
      createdAt: "2026-01-01T00:00:00.000Z", lastTouchedAt: "2026-01-01T00:00:00.000Z",
      sizeBytes: 1, sizeMeasuredAt: "2026-01-01T00:00:00.000Z", // far past the TTL
    }],
    priorities: [],
  });

  const response = await route.GET(request("/api/projects"));
  assert.equal(response.status, 200, "an unmeasurable folder still answers");

  const onDisk = JSON.parse(readFileSync(getProjectsPath(alice), "utf8"));
  const measuredAt = onDisk.projects[0].sizeMeasuredAt;
  // A fresh timestamp proves the measurement ran; `null` proves the timeout
  // path is allowed and is not treated as a failure of the request.
  assert.notEqual(measuredAt, "2026-01-01T00:00:00.000Z", "the stale measurement was replaced");
  assert.ok(
    onDisk.projects[0].sizeBytes === null || typeof onDisk.projects[0].sizeBytes === "number",
    "sizeBytes is either a number or an explicit null",
  );
}));

/**
 * The route is per account, so it must not be admin-only — and that is a
 * property of the *source*, checked without running it.
 *
 * Exercising an admin identity here would resolve the global agent dir
 * (`resolveTenantAgentDir` → `getAgentDir` from the SDK) and boot the real
 * omp runtime, which this test must not do. So the claim is pinned the way
 * `app/api/host-wide-guards.test.mjs` pins the guards it wants: by reading the
 * route text. If someone swaps `requireIdentity` for `requireAdmin`, this line
 * fails.
 */
test("the route requires an identity but not an admin role", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  // Comments explain *why* the admin guard is absent here, so the prose would
  // match a naive scan. Only the code is asserted — the same source-slicing
  // discipline `app/api/host-wide-guards.test.mjs` uses.
  const code = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .join("\n");

  assert.doesNotMatch(
    code,
    /requireAdmin/,
    "the registry is per account; admin-only would lock tenants out of their own dashboard",
  );
  assert.doesNotMatch(
    code,
    /isAdminIdentity\(identity\)/,
    "an inline admin check is the pattern AGENTS.md rules out; the create path uses requireAdmin",
  );
  assert.match(code, /requireIdentity/, "an identity is still required");
});

test("PUT requires an identity, not an admin role", () => withHome(async () => {
  const response = await route.PUT(request("/api/projects", {
    method: "PUT",
    headers: TENANT,
    body: { projects: [] },
  }));
  assert.equal(response.status, 200, "a tenant manages their own registry");
}));