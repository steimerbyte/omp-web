import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `/api/worktrees` lists, creates and removes git worktrees for the session
 * switcher.
 *
 * All three methods take `cwd` from the caller (query or body) and check it
 * against the identity's roots; POST/DELETE additionally require JSON. The
 * repository is a real one in a temp home, and the worktree directory
 * (`<repo>-worktrees/<branch>`) is created by the real `git worktree add`.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-worktrees-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const HOME = join(HOME_ROOT, "wt-alice");
const REPO = join(HOME, "repo");
const PLAIN = join(HOME, "plain");
mkdirSync(REPO, { recursive: true });
mkdirSync(PLAIN, { recursive: true });

function git(args, cwd = REPO) {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
}

git(["init", "--quiet", "--initial-branch=main"]);
writeFileSync(join(REPO, "README.md"), "repo\n");
git(["add", "README.md"]);
git(["commit", "--quiet", "-m", "initial"]);

const route = await jiti.import("./route.ts");

const ORIGIN = "http://localhost:30141";
const TENANT = { host: "localhost:30141", "x-omp-user": "wt-alice" };

function request(method, body, headers = TENANT, contentType = "application/json") {
  return route[method](
    new Request(`${ORIGIN}/api/worktrees`, {
      method,
      headers: { ...headers, ...(contentType ? { "content-type": contentType } : {}) },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    }),
  );
}

const get = (query, headers = TENANT) => route.GET(new Request(`${ORIGIN}/api/worktrees${query}`, { headers }));

test.after(() => {
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

test("GET ohne cwd ist 400, ohne Identitaet 403, ausserhalb der Wurzeln 403", async () => {
  assert.equal((await get("")).status, 400);

  const outside = await get(`?cwd=${encodeURIComponent("/etc")}`);
  assert.equal(outside.status, 403);
  assert.equal((await outside.json()).error, "Access denied");

  const anonymous = await get(`?cwd=${encodeURIComponent(REPO)}`, { host: "localhost:30141" });
  assert.equal(anonymous.status, 403);

  const untrusted = await get(`?cwd=${encodeURIComponent(REPO)}`, { ...TENANT, host: "evil.example" });
  assert.equal(untrusted.status, 403);
});

test("GET listet das Haupt-Checkout als einziges Worktree", async () => {
  const response = await get(`?cwd=${encodeURIComponent(REPO)}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.projectRoot, REPO);
  assert.equal(body.isGit, true);
  assert.equal(body.isTopLevel, true);
  assert.deepEqual(body.worktrees, [{ path: REPO, branch: "main", isMain: true }]);
});

test("GET auf ein Nicht-Repo meldet isGit: false", async () => {
  const response = await get(`?cwd=${encodeURIComponent(PLAIN)}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.isGit, false);
  assert.deepEqual(body.worktrees, []);
});

test("POST verlangt JSON und beide Felder", async () => {
  assert.equal((await request("POST", { cwd: REPO }, TENANT, "text/plain")).status, 415);
  assert.equal((await request("POST", {})).status, 400);
  assert.equal((await request("POST", { cwd: REPO })).status, 400);
  assert.equal((await request("POST", { cwd: REPO, branch: 42 })).status, 400);
});

test("POST fuer ein fremdes cwd ist 403", async () => {
  const response = await request("POST", { cwd: "/etc", branch: "feature" });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Access denied");
});

test("POST legt ein Worktree an, GET sieht es", async () => {
  const response = await request("POST", { cwd: REPO, branch: "feature/x" });
  assert.equal(response.status, 200);
  const created = await response.json();
  assert.equal(created.branch, "feature/x");
  assert.equal(created.path, join(`${REPO}-worktrees`, "feature-x"));
  assert.equal(existsSync(created.path), true);

  const listed = await (await get(`?cwd=${encodeURIComponent(REPO)}`)).json();
  assert.equal(listed.worktrees.length, 2);
  assert.equal(listed.worktrees.some((entry) => entry.path === created.path), true);
});

test("POST auf denselben Pfad ist 400 mit der Ursache", async () => {
  const response = await request("POST", { cwd: REPO, branch: "feature/x" });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /already exists/);
});

test("DELETE verlangt JSON, cwd und path", async () => {
  assert.equal((await request("DELETE", { cwd: REPO }, TENANT, "text/plain")).status, 415);
  assert.equal((await request("DELETE", {})).status, 400);
  const noPath = await request("DELETE", { cwd: REPO });
  assert.equal(noPath.status, 400);
  assert.equal((await noPath.json()).error, "path is required");
});

test("DELETE eines unsauberen Worktrees ist 409 mit dirty: true", async () => {
  const dirtyPath = join(`${REPO}-worktrees`, "feature-x");
  writeFileSync(join(dirtyPath, "scratch.txt"), "uncommitted\n");
  const response = await request("DELETE", { cwd: REPO, path: dirtyPath });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.dirty, true);
  assert.match(body.error, /modified or untracked|dirty/);
  assert.equal(existsSync(dirtyPath), true);
});

test("DELETE mit force entfernt das Worktree", async () => {
  const dirtyPath = join(`${REPO}-worktrees`, "feature-x");
  const response = await request("DELETE", { cwd: REPO, path: dirtyPath, force: true });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
  assert.equal(existsSync(dirtyPath), false);

  const listed = await (await get(`?cwd=${encodeURIComponent(REPO)}`)).json();
  assert.equal(listed.worktrees.length, 1);
});
