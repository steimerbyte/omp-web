import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `GET /api/display-settings` must read the *caller's* `config.yml`.
 *
 * Reading the process singleton was the bug: a tenant toggled the value through
 * `/api/settings` (which writes their isolated instance) and this route answered
 * from the operator's file, so the toggle looked like a no-op.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-display-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const AGENT_DIR = join(HOME_ROOT, "process-agent");
const TENANT_AGENT_DIR = join(HOME_ROOT, "disp-alice", ".omp", "agent");
mkdirSync(join(HOME_ROOT, "disp-alice"), { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });
mkdirSync(TENANT_AGENT_DIR, { recursive: true });

// Route first: importing a deep SDK subpath through jiti before it switches
// jiti's loader mode, and bun then attributes the route's coverage to a data:
// URL instead of this file.
const route = await jiti.import("./route.ts");
const sdk = await jiti.import("@oh-my-pi/pi-coding-agent");
const settingsModule = await jiti.import("@oh-my-pi/pi-coding-agent/session/settings");

const processSettings = await sdk.Settings.loadIsolated({ agentDir: AGENT_DIR });
const previousRuntime = globalThis.__ompRuntimePromise;
globalThis.__ompRuntimePromise = Promise.resolve({
  agentDir: AGENT_DIR,
  settings: processSettings,
  authStorage: { findApiKey: async () => undefined },
  modelRegistry: { getAvailable: () => [], getAll: () => [], getError: () => undefined },
});

const ORIGIN = "http://localhost:30141";

function get(query = "", headers = { "x-omp-user": "disp-alice" }) {
  return route.GET(
    new Request(`${ORIGIN}/api/display-settings${query}`, { headers: { host: "localhost:30141", ...headers } }),
  );
}

test.after(() => {
  if (previousRuntime === undefined) delete globalThis.__ompRuntimePromise;
  else globalThis.__ompRuntimePromise = previousRuntime;
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

test("der Default ist false", async () => {
  const response = await get();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { hideThinkingBlock: false });
});

test("ein Mandant liest den Wert aus seiner eigenen config.yml", async () => {
  // Write through the same isolated Settings layer the settings route uses,
  // then let the route load its own instance from the file.
  const tenantSettings = await sdk.Settings.loadIsolated({ agentDir: TENANT_AGENT_DIR });
  settingsModule.cfgHideThinkingBlock.set(tenantSettings, true);
  await tenantSettings.flush();

  // The operator's file stays untouched — that is the cross-tenant half.
  assert.equal(settingsModule.cfgHideThinkingBlock.get(processSettings), false);

  // `getSettingsForIdentity` caches one instance per agent dir; the first test
  // already built it, so the cached instance has to go for a file re-read.
  globalThis.__ompTenantSettings?.delete(TENANT_AGENT_DIR);

  const response = await get();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { hideThinkingBlock: true });
});

test("ein fremder Host wird abgewiesen", async () => {
  const response = await route.GET(
    new Request(`${ORIGIN}/api/display-settings`, { headers: { host: "evil.example", "x-omp-user": "disp-alice" } }),
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Untrusted API request");
});

test("ein cwd ausserhalb der eigenen Wurzeln ist 403", async () => {
  const response = await get(`?cwd=${encodeURIComponent("/etc")}`);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Access denied");
});

test("ein erlaubter cwd liefert dieselbe Antwort", async () => {
  const response = await get(`?cwd=${encodeURIComponent(join(HOME_ROOT, "disp-alice"))}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.hideThinkingBlock, "boolean");
});
