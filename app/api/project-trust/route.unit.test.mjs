import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `/api/project-trust` is the decision gate for project-scoped code.
 *
 * A project that carries `.omp/extensions`, `.mcp.json` or a project
 * `config.yml` has to be trusted before its code is imported; the route decides
 * *whether* that decision is needed and records it in the operator's agent dir.
 * Every path input (`cwd`) comes from the caller, so the check is against the
 * identity's roots.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-project-trust-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;
const AGENT_DIR = join(HOME_ROOT, "agent");
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

const HOME = join(HOME_ROOT, "trust-alice");
const CLEAN = join(HOME, "clean");
const CODEY = join(HOME, "codey");
mkdirSync(CLEAN, { recursive: true });
mkdirSync(join(CODEY, ".omp", "extensions"), { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });

const route = await jiti.import("./route.ts");

// `bun test` shares one process: a sibling file may have been the first to
// load the SDK, and its agent dir would then be this file's too.
const dirs = await jiti.import("@oh-my-pi/pi-utils");
dirs.setAgentDir(AGENT_DIR);

const ORIGIN = "http://localhost:30141";
const TENANT = { host: "localhost:30141", "x-omp-user": "trust-alice" };

function get(query, headers = TENANT) {
  return route.GET(new Request(`${ORIGIN}/api/project-trust${query}`, { headers }));
}

function post(body, headers = TENANT) {
  return route.POST(
    new Request(`${ORIGIN}/api/project-trust`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

test.after(() => {
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  dirs.__resetDirsFromEnvForTests();
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

test("ohne cwd ist 400", async () => {
  const response = await get("");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "cwd required");
});

test("ein nicht existierendes Verzeichnis ist 400", async () => {
  const response = await get(`?cwd=${encodeURIComponent(join(HOME, "missing"))}`);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Directory does not exist");
});

test("eine Datei ist kein Projekt", async () => {
  const file = join(HOME, "file.txt");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, "x");
  const response = await get(`?cwd=${encodeURIComponent(file)}`);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "cwd must be a directory");
});

test("ein fremdes Verzeichnis ist 403", async () => {
  const response = await get(`?cwd=${encodeURIComponent("/etc")}`);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Access denied");
});

test("ein Projekt ohne Ressourcen braucht kein Vertrauen", async () => {
  const response = await get(`?cwd=${encodeURIComponent(CLEAN)}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { requiresTrust: false, trusted: true });
});

test("ein Projekt mit ausfuehrbaren Ressourcen ist zunaechst unvertraut", async () => {
  const response = await get(`?cwd=${encodeURIComponent(CODEY)}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { requiresTrust: true, trusted: false });
});

test("POST ohne Vertrauensbedarf ist 409, kein stiller Erfolg", async () => {
  const response = await post({ cwd: CLEAN });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /no resources that require trust/);
});

test("POST fuer ein fremdes Verzeichnis ist 403", async () => {
  const response = await post({ cwd: "/etc" });
  assert.equal(response.status, 403);
});

test("POST merkt sich das Vertrauen in der Agent-Datei und GET sieht es", async () => {
  const response = await post({ cwd: CODEY });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { requiresTrust: true, trusted: true });

  const trustFile = join(AGENT_DIR, "omp-web-trusted-projects.json");
  assert.equal(existsSync(trustFile), true);
  const stored = JSON.parse(readFileSync(trustFile, "utf8"));
  assert.equal(Object.values(stored).includes(true), true);

  const readBack = await get(`?cwd=${encodeURIComponent(CODEY)}`);
  assert.deepEqual(await readBack.json(), { requiresTrust: true, trusted: true });
});

test("POST ohne cwd im Body ist 400", async () => {
  const response = await post({});
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "cwd required");
});

test("ein kaputter JSON-Body endet im 500-Zweig statt in einem Crash", async () => {
  const response = await post("{ not json");
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /JSON|Unexpected/);
});
