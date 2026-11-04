import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { createJiti } from "jiti";

/**
 * `GET /api/git/status` and `GET /api/git/diff` feed the changes panel.
 *
 * Both take `cwd` from the query string, so both must judge it against the
 * identity's roots — and the diff additionally validates that the file belongs
 * to the repository. The repository is a real `git init` in a temp home; only
 * real git can answer `--porcelain` and `git diff`.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-git-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const HOME = join(HOME_ROOT, "git-alice");
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
writeFileSync(join(REPO, "tracked.txt"), "line one\nline two\n");
git(["add", "tracked.txt"]);
git(["commit", "--quiet", "-m", "initial"]);
writeFileSync(join(REPO, "tracked.txt"), "line one\nline two changed\n");
writeFileSync(join(REPO, "untracked.txt"), "brand new\n");

const statusRoute = await jiti.import("./status/route.ts");
const diffRoute = await jiti.import("./diff/route.ts");

const ORIGIN = "http://localhost:30141";
const TENANT = { host: "localhost:30141", "x-omp-user": "git-alice" };

function status(query, headers = TENANT) {
  return statusRoute.GET(new NextRequest(`${ORIGIN}/api/git/status${query}`, { headers }));
}

function diff(query, headers = TENANT) {
  return diffRoute.GET(new NextRequest(`${ORIGIN}/api/git/diff${query}`, { headers }));
}

test.after(() => {
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

test("status ohne cwd oder mit relativem Pfad ist 400", async () => {
  for (const query of ["", "?cwd=", `?cwd=${encodeURIComponent("repo")}`]) {
    const response = await status(query);
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).error, "cwd must be an absolute path");
  }
});

test("status ausserhalb der eigenen Wurzeln ist 403", async () => {
  const response = await status(`?cwd=${encodeURIComponent("/etc")}`);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Access denied");
});

test("status auf ein fehlendes Verzeichnis ist 404", async () => {
  const response = await status(`?cwd=${encodeURIComponent(join(HOME, "missing"))}`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "Directory not found");
});

test("status auf eine Datei ist 400", async () => {
  const response = await status(`?cwd=${encodeURIComponent(join(REPO, "tracked.txt"))}`);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Not a directory");
});

test("status liefert die Aenderungen des Repositories", async () => {
  const response = await status(`?cwd=${encodeURIComponent(REPO)}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.isGitRepository, true);
  assert.equal(body.repositoryRoot, REPO);
  const modified = body.files.find((file) => file.filePath === join(REPO, "tracked.txt"));
  assert.equal(modified.status, "modified");
  const untracked = body.files.find((file) => file.filePath === join(REPO, "untracked.txt"));
  assert.equal(untracked.status, "untracked");
  assert.ok(body.additions > 0);
});

test("status in einem Nicht-Repo ist kein Fehler, sondern isGitRepository: false", async () => {
  const response = await status(`?cwd=${encodeURIComponent(PLAIN)}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    isGitRepository: false,
    repositoryRoot: null,
    files: [],
    additions: 0,
    deletions: 0,
  });
});

test("diff ohne cwd oder ohne path ist 400", async () => {
  assert.equal((await diff("")).status, 400);
  assert.equal((await diff(`?cwd=${encodeURIComponent(REPO)}`)).status, 400);
  const relative = await diff(
    `?cwd=${encodeURIComponent(REPO)}&path=${encodeURIComponent("tracked.txt")}`,
  );
  assert.equal(relative.status, 400);
  assert.equal((await relative.json()).error, "path must be an absolute path");
});

test("diff ausserhalb der eigenen Wurzeln ist 403", async () => {
  const response = await diff(
    `?cwd=${encodeURIComponent(REPO)}&path=${encodeURIComponent("/etc/passwd")}`,
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Access denied");
});

test("diff auf eine geaenderte Datei liefert einen Patch", async () => {
  const response = await diff(
    `?cwd=${encodeURIComponent(REPO)}&path=${encodeURIComponent(join(REPO, "tracked.txt"))}`,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.supported, true);
  assert.equal(body.status, "modified");
  assert.match(body.patch, /line two changed/);
});

test("diff auf eine unbekannte Datei ist supported: false, kein Fehler", async () => {
  const response = await diff(
    `?cwd=${encodeURIComponent(REPO)}&path=${encodeURIComponent(join(REPO, "not-in-status.txt"))}`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { supported: false });
});
