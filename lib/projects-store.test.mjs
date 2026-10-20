import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  adoptProjects,
  getProjectsPath,
  isProjectsPathAllowed,
  readProjectsFile,
  writeProjectsFile,
} = await jiti.import("./projects-store.ts");
const { DEFAULT_PRIORITIES } = await jiti.import("./projects-schema.ts");

/**
 * Tenant separation and storage of the projects registry.
 *
 * Runs against real files in a temporary home, because filesystem separation
 * is exactly the property that must hold. A test against a mocked `fs` proves
 * the opposite of what matters: that user A never reaches user B's path.
 *
 * `resolveTenantAgentDir` reads `OMP_WEB_HOME_ROOT` from `process.env`, so it
 * is pointed at a temp root here and restored afterwards — a leaked `env` would
 * send the rest of the suite down a road to nowhere.
 */
function withHome(fn) {
  const previous = process.env.OMP_WEB_HOME_ROOT;
  const root = mkdtempSync(join(tmpdir(), "omp-web-projects-"));
  process.env.OMP_WEB_HOME_ROOT = root;
  try {
    return fn(root);
  } finally {
    if (previous === undefined) delete process.env.OMP_WEB_HOME_ROOT;
    else process.env.OMP_WEB_HOME_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

const alice = { username: "alice", isAdmin: false };
const bob = { username: "bob", isAdmin: false };

function file(projects) {
  return { schemaVersion: 1, projects, priorities: [...DEFAULT_PRIORITIES] };
}

test("two accounts get two files, each named after its owner", () => withHome((root) => {
  const alicePath = getProjectsPath(alice);
  const bobPath = getProjectsPath(bob);

  assert.notEqual(alicePath, bobPath);
  assert.ok(alicePath.startsWith(join(root, "alice")), alicePath);
  assert.ok(bobPath.startsWith(join(root, "bob")), bobPath);
  assert.equal(alicePath.endsWith("omp-web-projects.json"), true);
}));

test("the registry path carries the tenant boundary", () => withHome(() => {
  // Not just "different": the boundary is *in the path*, so the two files
  // cannot collide even if the store is later pointed at one directory.
  const alicePath = getProjectsPath(alice);
  assert.ok(alicePath.includes("alice"), alicePath);
  assert.ok(!getProjectsPath(bob).includes(alicePath), "bob must not resolve into alice's dir");
}));

test("one account cannot read another account's registry", () => withHome(() => {
  writeProjectsFile(alice, file([
    { root: "/home/alice/workspace/alice-proj", priority: "now", openTodos: 3, status: "red", createdAt: "2026-10-01T00:00:00.000Z", lastTouchedAt: "2026-10-02T00:00:00.000Z" },
  ]));

  const read = readProjectsFile(alice);
  assert.equal(read.projects.length, 1);
  assert.equal(read.projects[0].root, "/home/alice/workspace/alice-proj");
  // Bob has no file at all. He sees "never had one", not Alice's folder.
  assert.equal(readProjectsFile(bob), null);
}));

test("one account cannot overwrite another account's registry", () => withHome(() => {
  writeProjectsFile(alice, file([
    { root: "/home/alice/workspace/alice-proj", priority: "now", openTodos: 3, status: "red", createdAt: "2026-10-01T00:00:00.000Z", lastTouchedAt: "2026-10-01T00:00:00.000Z" },
  ]));
  writeProjectsFile(bob, file([
    { root: "/home/bob/workspace/bob-proj", priority: "done", openTodos: 0, status: "green", createdAt: "2026-10-01T00:00:00.000Z", lastTouchedAt: "2026-10-01T00:00:00.000Z" },
  ]));

  const aliceFile = readProjectsFile(alice);
  assert.equal(aliceFile.projects.length, 1);
  assert.equal(aliceFile.projects[0].root, "/home/alice/workspace/alice-proj");
}));

test("no file means null, and an empty registry is not the same thing", () => withHome(() => {
  assert.equal(readProjectsFile(alice), null, "never had one");

  // Every project deleted is a decision. It must survive as an empty array and
  // never be re-seeded from the session list.
  writeProjectsFile(alice, file([]));
  const after = readProjectsFile(alice);
  assert.notEqual(after, null, "an emptied registry still exists");
  assert.deepEqual(after.projects, []);
}));

test("a corrupt registry reads as empty but still existing", () => withHome(() => {
  const path = getProjectsPath(alice);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "{ this is not json");

  const read = readProjectsFile(alice);
  // Content is lost, existence is not: a seed running over a damaged file
  // would overwrite projects the user cannot see.
  assert.notEqual(read, null, "damaged is not absent");
  assert.deepEqual(read.projects, []);
  assert.equal(read.priorities.length, 5, "defaults are still usable");
}));

test("a corrupt registry is not rewritten by a read", () => withHome(() => {
  const path = getProjectsPath(alice);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "{ this is not json");

  readProjectsFile(alice);

  // A read that repairs state hides the damage from whoever has to clean it.
  assert.equal(readFileSync(path, "utf8"), "{ this is not json");
}));

test("the registry file is private to its account", () => withHome(() => {
  writeProjectsFile(alice, file([]));
  const mode = statSync(getProjectsPath(alice)).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
}));

test("the registry directory is private to its account", () => withHome(() => {
  writeProjectsFile(alice, file([]));
  const dir = join(getProjectsPath(alice), "..");
  const mode = statSync(dir).mode & 0o777;
  assert.equal(mode, 0o700, `expected 0700, got ${mode.toString(8)}`);
}));

test("a write is atomic and leaves no temp file behind", () => withHome(() => {
  writeProjectsFile(alice, file([]));
  writeProjectsFile(alice, file([
    { root: "/home/alice/workspace/p", priority: "later", openTodos: 1, status: "yellow", createdAt: "2026-10-01T00:00:00.000Z", lastTouchedAt: "2026-10-01T00:00:00.000Z" },
  ]));

  const dir = join(getProjectsPath(alice), "..");
  const leftovers = readdirSync(dir).filter((n) => n.includes(".tmp"));
  assert.deepEqual(leftovers, [], "no temp file survives a completed write");
  const parsed = JSON.parse(readFileSync(getProjectsPath(alice), "utf8"));
  assert.equal(parsed.projects.length, 1);
}));

test("the stored file round-trips through normalization", () => withHome(() => {
  const written = writeProjectsFile(alice, {
    schemaVersion: 1,
    // Duplicate root, `..` traversal, a hex colour, an unknown status: none of
    // these may survive into the file that ends up on disk.
    projects: [
      { root: "/home/alice/workspace/p/../p", priority: "now", openTodos: 2, status: "red", createdAt: "2026-10-01T00:00:00.000Z", lastTouchedAt: "2026-10-01T00:00:00.000Z" },
      { root: "/home/alice/workspace/p", priority: "now", openTodos: 2, status: "red", createdAt: "2026-10-01T00:00:00.000Z", lastTouchedAt: "2026-10-01T00:00:00.000Z" },
    ],
    priorities: [{ id: "now", name: "  ", colorValue: "#ff0000" }],
  });

  assert.equal(written.projects.length, 1, "duplicate root collapses");
  assert.equal(written.projects[0].root, "/home/alice/workspace/p", "traversal is normalized");
  assert.equal(written.priorities.length, 5, "all five categories are present");
  const now = written.priorities.find((p) => p.id === "now");
  assert.equal(now.colorValue, "var(--danger)", "a hex literal never survives");
  assert.equal(now.name, "Sofort", "an empty name falls back to the default");

  const onDisk = JSON.parse(readFileSync(getProjectsPath(alice), "utf8"));
  assert.equal(onDisk.projects.length, 1);
}));

test("adoption adds missing folders and never touches existing ones", () => withHome(() => {
  const existing = [{
    root: "/home/alice/workspace/known",
    priority: "now",
    openTodos: 5,
    status: "red",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastTouchedAt: "2026-02-01T00:00:00.000Z",
  }];

  const result = adoptProjects(existing, [
    { root: "/home/alice/workspace/known" },  // already there
    { root: "/home/alice/workspace/fresh" },
  ]);

  assert.equal(result.length, 1, "only the genuinely new folder is adopted");
  assert.equal(result[0].root, "/home/alice/workspace/fresh");
  assert.equal(result[0].adopted, true, "adopted is flagged so the UI can say so");
  assert.equal(result[0].priority, "parked", "adoption starts at the lowest priority");
  assert.equal(result[0].openTodos, 0);

  // The pre-existing entry keeps every field it had, including the counters a
  // user has edited by hand.
  assert.deepEqual(existing[0], {
    root: "/home/alice/workspace/known",
    priority: "now",
    openTodos: 5,
    status: "red",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastTouchedAt: "2026-02-01T00:00:00.000Z",
  });
}));

test("adoption is idempotent", () => withHome(() => {
  const candidates = [{ root: "/home/alice/workspace/fresh" }];
  const once = adoptProjects([], candidates);
  const twice = adoptProjects(once, candidates);
  assert.equal(once.length, 1);
  assert.equal(twice.length, 0, "a second pass adopts nothing");
}));

test("the registry path must lie inside the account's own home", () => withHome((root) => {
  assert.equal(isProjectsPathAllowed(alice, getProjectsPath(alice)), true);
  assert.equal(isProjectsPathAllowed(alice, join(root, "bob", ".omp", "agent", "omp-web-projects.json")), false);
  assert.equal(isProjectsPathAllowed(alice, join(root, "..", "..", "etc", "omp-web-projects.json")), false);
}));