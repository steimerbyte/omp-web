import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `GET /api/theme?cwd=` serves the palettes the client applies at boot.
 *
 * Two boundaries: the API gate (`isApiRequestAllowed`, i.e. Host/Origin) and
 * the cwd allowlist belongs to the *identity*, not to the query string.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-theme-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const TENANT = { username: "theme-alice", isAdmin: false };
const AGENT_DIR = join(HOME_ROOT, "process-agent");
mkdirSync(join(HOME_ROOT, "theme-alice"), { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });

const { Settings } = await jiti.import("@oh-my-pi/pi-coding-agent");
const route = await jiti.import("./route.ts");

const previousRuntime = globalThis.__ompRuntimePromise;
globalThis.__ompRuntimePromise = Settings.loadIsolated({ agentDir: AGENT_DIR }).then((settings) => ({
  agentDir: AGENT_DIR,
  settings,
  authStorage: { findApiKey: async () => undefined },
  modelRegistry: { getAvailable: () => [], getAll: () => [], getError: () => undefined },
}));

const ORIGIN = "http://localhost:30141";

function get(query, headers = { "x-omp-user": "theme-alice" }) {
  return route.GET(new Request(`${ORIGIN}/api/theme${query}`, { headers: { host: "localhost:30141", ...headers } }));
}

test.after(() => {
  if (previousRuntime === undefined) delete globalThis.__ompRuntimePromise;
  else globalThis.__ompRuntimePromise = previousRuntime;
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

test("ohne cwd liefert die Route die Paletten aus den Prozess-Settings", async () => {
  const response = await get("");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.names.dark, "string");
  assert.equal(typeof body.names.light, "string");
  assert.equal(typeof body.palettes.dark, "object");
  assert.equal(typeof body.palettes.light, "object");
});

test("ein cwd innerhalb der eigenen Home ist erlaubt", async () => {
  const response = await get(`?cwd=${encodeURIComponent(join(HOME_ROOT, "theme-alice"))}`);
  assert.equal(response.status, 200);
});

test("ein cwd ausserhalb der erlaubten Wurzeln wird abgelehnt", async () => {
  const response = await get(`?cwd=${encodeURIComponent("/etc")}`);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Access denied");
});

test("ein fremder Host wird abgewiesen, bevor eine Einstellung gelesen wird", async () => {
  const response = await route.GET(new Request(`${ORIGIN}/api/theme`, { headers: { host: "evil.example" } }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Untrusted API request");
});

test("eine Windows-artige Wurzel ist fuer einen Mandanten kein Freibrief", async () => {
  const response = await get(`?cwd=${encodeURIComponent("C:\\Windows")}`);
  assert.equal(response.status, 403);
});
