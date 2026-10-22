import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

/**
 * The measurement runs in the background now, so the GET no longer writes the
 * measurement itself — the run does, and the run writes it into the registry
 * it re-reads right before the write (`lib/projects-sizes.ts`).
 *
 * The folder in this test does not exist, so `du` fails at once and the
 * measurement ends in milliseconds: the test can wait for the write instead
 * of racing it. The race between a measurement and a *user's* write has its
 * own test, in `app/api/projects/size-race.test.mjs`.
 */
test("the background run persists a fresh measurement for a stale project", () => withHome(async () => {
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

  // The GET answered before the measurement was done — that is the whole
  // point of the move. The run writes the result afterwards.
  const deadline = Date.now() + 5_000;
  let onDisk = JSON.parse(readFileSync(getProjectsPath(alice), "utf8"));
  while (onDisk.projects[0].sizeMeasuredAt === "2026-01-01T00:00:00.000Z") {
    assert.ok(Date.now() < deadline, "the background run did not write a measurement");
    await new Promise((resolve) => setTimeout(resolve, 20));
    onDisk = JSON.parse(readFileSync(getProjectsPath(alice), "utf8"));
  }

  // A fresh timestamp proves the measurement ran; `null` proves the timeout
  // path is allowed and is not treated as a failure of the request.
  assert.notEqual(onDisk.projects[0].sizeMeasuredAt, "2026-01-01T00:00:00.000Z", "the stale measurement was replaced");
  assert.ok(
    onDisk.projects[0].sizeBytes === null || typeof onDisk.projects[0].sizeBytes === "number",
    "sizeBytes is either a number or an explicit null",
  );
}));

/**
 * The route is per account, so it must not be admin-only — and that is a
 * property of the *source*, checked without running it.
 *
 * ### Why this test reads the source at all
 *
 * This is the exception `AGENTS.md` names: an architecture rule that cannot
 * be checked by behaviour. Exercising an *admin* identity here would resolve
 * the global agent dir (`resolveTenantAgentDir` → `getAgentDir` from the SDK)
 * and boot the real omp runtime, which this test must not do. The rule is
 * "the entry guard is not `requireAdmin`", and the only way to see it without
 * running the admin path is to read the route. Same discipline as
 * `app/api/host-wide-guards.test.mjs`.
 *
 * Everything that *can* be checked by behaviour is checked by behaviour, and
 * those tests are the ones that count:
 *
 *  - "GET without an identity is 403 and writes nothing" — the identity
 *    guard is in force.
 *  - "PUT requires an identity, not an admin role" — a tenant manages its own
 *    registry, so the route is not admin-only.
 *
 * What is left here is the part that behaviour cannot reach: that
 * `requireAdmin` does not appear as the *entry* guard, and that the one
 * admin check that is allowed — the `allowFileRoot` grant on create — carries
 * the identity. `AGENTS.md` requires that grant to be operator-only, because
 * the allow-list is one process-wide store: a grant made by one account
 * widens the filesystem for all of them. A grant without an identity lands in
 * the unattributed bucket, which every admin can see.
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

  // The one admin check that is allowed is the allow-list grant, and it has to
  // carry the identity — a grant without one lands in the unattributed bucket,
  // which every admin can see.
  const grants = [...code.matchAll(/allowFileRoot\(([^)]*)\)/g)].map((match) => match[1]);
  assert.ok(grants.length > 0, "the create path grants the new root to the file allow-list");
  for (const args of grants) {
    assert.match(args, /identity/, "allowFileRoot without an identity lands in the unattributed bucket");
  }
});

test("PUT requires an identity, not an admin role", () => withHome(async () => {
  const response = await route.PUT(request("/api/projects", {
    method: "PUT",
    headers: TENANT,
    body: { projects: [] },
  }));
  assert.equal(response.status, 200, "a tenant manages their own registry");
}));

// ------------------------------------------------------------ POST: guards --

/**
 * `POST /api/projects` — the create path.
 *
 * The client (`ProjectsDashboard.createProject`) has always sent this, and the
 * route only had GET and PUT, so "New project" answered 405 every time. The
 * guard chain is the one PUT uses, plus the checks that stand between a name
 * and a `mkdir`.
 *
 * Every assertion here reads the *filesystem*, not the response body: a route
 * that returns 400 while still having created a directory passes a
 * status-code test and is exactly the bug these tests exist for.
 */

/**
 * What a rejected create is allowed to have left behind: nothing.
 *
 * `getUserHome(identity)` is `<OMP_WEB_HOME_ROOT>/<username>`, so the only
 * directory the create path could ever create is `<root>/alice/workspace`.
 * Even that must be absent — nothing may run before the guards, which is the
 * property `bin/web-auth-store.js` documents for account names and the reason
 * these assertions look at the disk rather than the response.
 */
function createdRoots(root) {
  const workspace = join(root, "alice", "workspace");
  return existsSync(workspace) ? [workspace] : [];
}

test("POST without an identity is 403 and creates nothing", () => withHome(async (root) => {
  const response = await route.POST(request("/api/projects", {
    method: "POST",
    headers: ANON,
    body: { name: "alpha", priority: "later", initGit: false },
  }));
  assert.equal(response.status, 403);
  assert.deepEqual(createdRoots(root), [], "an anonymous request created a directory");
  assert.equal(existsSync(getProjectsPath(alice)), false, "and wrote a registry");
}));

test("POST without a JSON content type is 415", () => withHome(async (root) => {
  const response = await route.POST(new Request("http://localhost/api/projects", {
    method: "POST",
    headers: TENANT,
    body: JSON.stringify({ name: "alpha" }),
  }));
  assert.equal(response.status, 415);
  assert.deepEqual(createdRoots(root), []);
}));

test("POST refuses a cross-origin request before reading the identity", () => withHome(async (root) => {
  const response = await route.POST(request("/api/projects", {
    method: "POST",
    headers: { ...TENANT, origin: "https://evil.example" },
    body: { name: "alpha", priority: "later", initGit: false },
  }));
  assert.equal(response.status, 403);
  assert.deepEqual(createdRoots(root), []);
}));

// -------------------------------------------------- POST: name validation --

/**
 * The name becomes a path segment. Each of these is one way out of
 * `<home>/workspace`, so each is asserted together with "nothing was created".
 */
const ESCAPING_NAMES = [
  ["a parent traversal", "../../etc"],
  ["a single parent", ".."],
  ["a separator", "alpha/beta"],
  ["a backslash separator", "alpha\\beta"],
  ["an absolute path", "/etc/passwd"],
  ["a leading dot", ".hidden"],
  ["a leading dash", "-rf"],
  ["an empty name", ""],
  ["a whitespace name", "   "],
  ["a name with spaces", "my project"],
  ["a non-string", 42],
];

for (const [label, name] of ESCAPING_NAMES) {
  test(`POST refuses ${label}`, () => withHome(async (root) => {
    const response = await route.POST(request("/api/projects", {
      method: "POST",
      headers: TENANT,
      body: { name, priority: "later", initGit: false },
    }));
    assert.equal(response.status, 400, `${JSON.stringify(name)} should be refused`);
      assert.deepEqual(createdRoots(root), [], "a refused name still created a directory");
    assert.equal(existsSync("/etc/omp-web-should-not-exist"), false);
  }));
}

test("POST refuses a name longer than the folder-name limit", () => withHome(async (root) => {
  const response = await route.POST(request("/api/projects", {
    method: "POST",
    headers: TENANT,
    body: { name: "a".repeat(65), priority: "later", initGit: false },
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(createdRoots(root), []);
}));

// -------------------------------------------------- POST: path and purpose --

test("POST creates the folder under the account's own workspace", () => withHome(async (root) => {
  const read = readFileSync;
  const response = await route.POST(request("/api/projects", {
    method: "POST",
    headers: TENANT,
    body: { name: "alpha", priority: "important", initGit: false },
  }));
  assert.equal(response.status, 201);

  // The temp home root is this account's `getUserHome`, so the folder has to
  // land exactly here and nowhere else.
  const expected = join(root, "alice", "workspace", "alpha");
  assert.ok(existsSync(expected), `expected ${expected} to exist`);

  const body = await response.json();
  assert.equal(body.root, expected);
  assert.ok(
    body.projects.some((project) => project.root === expected),
    "the new project is in the response",
  );
  assert.ok(
    body.projects.some((project) => project.root === expected && project.priority === "important"),
    "the chosen category was kept",
  );

  // Server-owned fields: the client sent none of them, so the store's values
  // must be the ones on disk.
  const onDisk = JSON.parse(read(getProjectsPath(alice), "utf8"));
  const stored = onDisk.projects.find((project) => project.root === expected);
  assert.equal(stored.adopted, undefined, "a created project is not 'adopted from sessions'");
  assert.ok(typeof stored.createdAt === "string", "createdAt is the store's");
  assert.ok(Number.isFinite(Date.parse(stored.createdAt)), "and it is a timestamp");
  assert.equal(stored.openTodos, 0);
  assert.equal(stored.branch, undefined, "the client cannot set derived fields");
}));

test("POST refuses a folder that already exists rather than adopting it", () => withHome(async (root) => {
  mkdirSync(join(root, "alice", "workspace", "taken"), { recursive: true });

  const response = await route.POST(request("/api/projects", {
    method: "POST",
    headers: TENANT,
    body: { name: "taken", priority: "later", initGit: false },
  }));
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "exists");

  // The folder the user already had is now a one-click recursive delete away
  // from the dashboard. It must not have become a project.
  assert.equal(existsSync(getProjectsPath(alice)), false, "an existing folder entered the registry");
}));

test("POST creates no git repository unless it was asked for", () => withHome(async (root) => {
  await route.POST(request("/api/projects", {
    method: "POST",
    headers: TENANT,
    body: { name: "plain", priority: "later", initGit: false },
  }));
  assert.equal(existsSync(join(root, "alice", "workspace", "plain", ".git")), false);

  await route.POST(request("/api/projects", {
    method: "POST",
    headers: TENANT,
    body: { name: "withgit", priority: "later", initGit: true },
  }));
  assert.ok(
    existsSync(join(root, "alice", "workspace", "withgit", ".git")),
    "initGit was honoured, so the card does not say 'no repo' for a repo the user asked for",
  );
}));

/**
 * A protected location is refused before anything is written.
 *
 * The derived path is `<home>/workspace/<name>`, which is depth 2 and so never
 * caught by the depth-1 delete rule — the check is defence in depth for a home
 * that resolves into a system root, and its real value here is the *order*:
 * `isProtectedProjectRoot` has to run before the `mkdirSync`, or a refusal
 * costs a directory. That order cannot be exercised through the happy path, so
 * it is pinned against the source, the way `delete-route.test.mjs` pins its
 * own ordering.
 */
test("POST checks protection before it creates anything", async () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

  const protection = source.indexOf("isProtectedProjectRoot(root, home)");
  const pathCheck = source.indexOf("isPathWithinRoots(root");
  const mkdir = source.indexOf("mkdirSync(root");

  assert.ok(protection > -1, "the create path consults isProtectedProjectRoot");
  assert.ok(pathCheck > -1, "the create path constrains the joined path");
  // `indexOf` returns -1 for an absent string, and -1 compares less than
  // everything — so without these two the ordering assertions below would pass
  // on a route that dropped the check entirely.
  assert.ok(protection < mkdir, "the protection check has to run before the mkdir — after it, a refusal costs a directory");
  assert.ok(pathCheck < protection, "the path check runs before the protection check");
  assert.ok(pathCheck < mkdir, "and before anything is created");
});

test("POST refuses a protected home without creating anything", () => withHome(async () => {
  // `OMP_WEB_HOME_ROOT` is the root the account homes are computed under, so
  // pointing it at a system directory gives this identity a home that
  // `isProtectedProjectRoot` refuses outright — the case the check exists for.
  const previous = process.env.OMP_WEB_HOME_ROOT;
  process.env.OMP_WEB_HOME_ROOT = "/etc";
  try {
    const response = await route.POST(request("/api/projects", {
      method: "POST",
      headers: TENANT,
      body: { name: "alpha", priority: "later", initGit: false },
    }));
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.code, "protected");
  } finally {
    if (previous === undefined) delete process.env.OMP_WEB_HOME_ROOT;
    else process.env.OMP_WEB_HOME_ROOT = previous;
  }
}));

test("POST keeps another account's registry out of it", () => withHome(async (root) => {
  const read = readFileSync;
  await route.POST(request("/api/projects", {
    method: "POST",
    headers: { host: "localhost", "x-omp-user": "alice" },
    body: { name: "alpha", priority: "later", initGit: false },
  }));
  await route.POST(request("/api/projects", {
    method: "POST",
    headers: { host: "localhost", "x-omp-user": "bob" },
    body: { name: "beta", priority: "later", initGit: false },
  }));

  assert.ok(existsSync(join(root, "alice", "workspace", "alpha")));
  assert.ok(existsSync(join(root, "bob", "workspace", "beta")));

  const aliceFile = JSON.parse(read(getProjectsPath(alice), "utf8"));
  assert.deepEqual(
    aliceFile.projects.map((project) => project.root),
    [join(root, "alice", "workspace", "alpha")],
    "alice's registry holds only her project",
  );
}));

test("POST accepts an unknown category by falling back, and refuses nothing else", () => withHome(async (root) => {
  const read = readFileSync;
  const response = await route.POST(request("/api/projects", {
    method: "POST",
    headers: TENANT,
    body: { name: "alpha", priority: "not-a-priority", initGit: false },
  }));
  assert.equal(response.status, 201);
  const expected = join(root, "alice", "workspace", "alpha");
  assert.ok(existsSync(expected));
  const onDisk = JSON.parse(read(getProjectsPath(alice), "utf8"));
  assert.equal(onDisk.projects[0].priority, "later", "an unknown id falls back instead of being stored");
}));