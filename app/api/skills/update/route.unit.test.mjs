import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `POST /api/skills/update` refreshes one installed skill package.
 *
 * Same boundary shape as `install`: identity, then `cwd`/`package`/`scope`, then
 * the admin rule for a global update, then the path and trust checks. The 404
 * case is reachable without spawning `npx`, because the skill lookup happens
 * before the update command.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-skills-update-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;
const AGENT_DIR = join(HOME_ROOT, "agent");
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

const HOME = join(HOME_ROOT, "update-alice");
const CLEAN = join(HOME, "clean");
mkdirSync(CLEAN, { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });
writeFileSync(join(AGENT_DIR, "config.yml"), "\n", "utf8");

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
const TENANT = { host: "localhost:30141", "x-omp-user": "update-alice" };

function post(body, headers = TENANT, contentType = "application/json") {
  return route.POST(
    new Request(`${ORIGIN}/api/skills/update`, {
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

test("ohne JSON ist 415, ohne Identitaet 403", async () => {
  assert.equal((await post({ cwd: CLEAN }, TENANT, "text/plain")).status, 415);
  const anonymous = await post({ cwd: CLEAN, package: "owner/repo@skill", scope: "project" }, { host: "localhost:30141" });
  assert.equal(anonymous.status, 403);
  assert.equal((await anonymous.json()).error, "Access denied");
});

test("cwd, package und scope sind gemeinsam Pflicht", async () => {
  for (const body of [{}, { cwd: CLEAN }, { cwd: CLEAN, package: "owner/repo@skill" }, { package: "owner/repo@skill", scope: "project" }]) {
    const response = await post(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error, "cwd, package, and scope are required");
  }
});

test("ein globales Update ist fuer Mandanten gesperrt", async () => {
  const response = await post({ cwd: CLEAN, package: "owner/repo@skill", scope: "global" });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Access denied");
});

test("ein cwd ausserhalb der Wurzeln ist 403", async () => {
  const response = await post({ cwd: "/etc", package: "owner/repo@skill", scope: "project" });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Access denied");
});

test("ohne installiertes Paket ist 404, ohne npx zu starten", async () => {
  const response = await post({ cwd: CLEAN, package: "owner/repo@no-such", scope: "project" });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "Installed skill not found");
});
