import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `GET /api/model-roles?cwd=` backs the role table in the model panel.
 *
 * `cwd` is a query parameter, so the allowlist has to come from the identity.
 * The PUT side already has its own tests; this one covers the read side, which
 * had no test at all (and therefore no proof that the guard is in front of the
 * settings read).
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-model-roles-get-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;
const AGENT_DIR = join(HOME_ROOT, "agent");
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

const HOME = join(HOME_ROOT, "roles-alice");
mkdirSync(join(HOME, "project"), { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });

const route = await jiti.import("./route.ts");
const sdk = await jiti.import("@oh-my-pi/pi-coding-agent");

const settings = await sdk.Settings.loadIsolated({ agentDir: AGENT_DIR });
const previousRuntime = globalThis.__ompRuntimePromise;
globalThis.__ompRuntimePromise = Promise.resolve({
  agentDir: AGENT_DIR,
  settings,
  authStorage: { findApiKey: async () => undefined },
  modelRegistry: {
    getAvailable: () => [{ id: "zeta", name: "Zeta", provider: "prov", api: "openai-completions", reasoning: false }],
    getAll: () => [{ id: "zeta", name: "Zeta", provider: "prov", api: "openai-completions", reasoning: false }],
    getError: () => undefined,
  },
});

const ORIGIN = "http://localhost:30141";

function get(query, headers = { "x-omp-user": "roles-alice" }) {
  return route.GET(new Request(`${ORIGIN}/api/model-roles${query}`, { headers: { host: "localhost:30141", ...headers } }));
}

test.after(() => {
  if (previousRuntime === undefined) delete globalThis.__ompRuntimePromise;
  else globalThis.__ompRuntimePromise = previousRuntime;
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

test("ohne cwd ist 400", async () => {
  const response = await get("");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "cwd required");
});

test("ein cwd ausserhalb der eigenen Wurzeln ist 403", async () => {
  const response = await get(`?cwd=${encodeURIComponent("/etc")}`);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Access denied");
});

test("ohne Identitaet ist jedes cwd verboten", async () => {
  const response = await get(`?cwd=${encodeURIComponent(join(HOME, "project"))}`, {});
  assert.equal(response.status, 403);
});

test("die Antwort enthaelt die Rollentabelle mit Quelle und Aufloesung", async () => {
  const response = await get(`?cwd=${encodeURIComponent(join(HOME, "project"))}`);
  assert.equal(response.status, 200);
  const { roles } = await response.json();
  assert.ok(Array.isArray(roles) && roles.length > 0);
  const def = roles.find((role) => role.role === "default");
  assert.equal(def.builtin, true);
  assert.equal(typeof def.name, "string");
  assert.ok("source" in def);
});
