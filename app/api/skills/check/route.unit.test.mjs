import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `POST /api/skills/check` is the "updates available?" query for installed
 * skills. With no installed skill there is nothing to ask GitHub about, which is
 * exactly the point of the case: the endpoint must answer `{updates: []}`
 * instead of reaching the network with an empty list.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-skills-check-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;
const AGENT_DIR = join(HOME_ROOT, "agent");
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

const HOME = join(HOME_ROOT, "check-alice");
const PROJECT = join(HOME, "project");
mkdirSync(PROJECT, { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });

const route = await jiti.import("./route.ts");
const sdk = await jiti.import("@oh-my-pi/pi-coding-agent");

// `bun test` shares one process: a sibling file may have been the first to
// load the SDK, and its agent dir would then be this file's too.
const dirs = await jiti.import("@oh-my-pi/pi-utils");
dirs.setAgentDir(AGENT_DIR);

const settings = await sdk.Settings.loadIsolated({ agentDir: AGENT_DIR });
const previousRuntime = globalThis.__ompRuntimePromise;
globalThis.__ompRuntimePromise = Promise.resolve({
  agentDir: AGENT_DIR,
  settings,
  authStorage: { findApiKey: async () => undefined },
  modelRegistry: { getAvailable: () => [], getAll: () => [], getError: () => undefined },
});

const ORIGIN = "http://localhost:30141";
const TENANT = { host: "localhost:30141", "x-omp-user": "check-alice" };

function post(body, headers = TENANT, contentType = "application/json") {
  return route.POST(
    new Request(`${ORIGIN}/api/skills/check`, {
      method: "POST",
      headers: { ...headers, "content-type": contentType },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

test.after(() => {
  if (previousRuntime === undefined) delete globalThis.__ompRuntimePromise;
  else globalThis.__ompRuntimePromise = previousRuntime;
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  dirs.__resetDirsFromEnvForTests();
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

test("ohne JSON ist 415, ohne cwd 400, ausserhalb der Wurzeln 403", async () => {
  assert.equal((await post({}, TENANT, "text/plain")).status, 415);

  const noCwd = await post({});
  assert.equal(noCwd.status, 400);
  assert.equal((await noCwd.json()).error, "cwd required");

  const outside = await post({ cwd: "/etc" });
  assert.equal(outside.status, 403);
  assert.equal((await outside.json()).error, "Access denied");

  const anonymous = await post({ cwd: PROJECT }, { host: "localhost:30141" });
  assert.equal(anonymous.status, 403);
});

test("package und scope muessen gemeinsam kommen", async () => {
  const onlyPackage = await post({ cwd: PROJECT, package: "owner/repo@skill" });
  assert.equal(onlyPackage.status, 400);
  assert.match((await onlyPackage.json()).error, /provided together/);

  const onlyScope = await post({ cwd: PROJECT, scope: "project" });
  assert.equal(onlyScope.status, 400);
});

test("ohne installierte Skills ist die Antwort leer, ohne Netzabfrage", async () => {
  const response = await post({ cwd: PROJECT });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { updates: [] });
});

test("ein unbekanntes Paket ist 404", async () => {
  const response = await post({ cwd: PROJECT, package: "owner/repo@missing", scope: "project" });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "Installed skill not found");
});
