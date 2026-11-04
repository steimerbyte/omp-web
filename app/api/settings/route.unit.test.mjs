import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { parse as parseYaml } from "yaml";

/**
 * `/api/settings` is the panel's read/write pair.
 *
 * Reading is a per-identity question: with the process singleton a tenant saw
 * the operator's `config.yml`. Writing has two boundaries — the host-wide
 * settings (`isAdminOnlySetting`, e.g. `autolearn.enabled`) and the value
 * validation. Both are asserted here as *effects*, not as intent: the response
 * and the file the account ends up with.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-settings-unit-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;
const AGENT_DIR = join(HOME_ROOT, "agent");
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

const TENANT_NAME = "settings-alice";
const HOME = join(HOME_ROOT, TENANT_NAME);
const TENANT_AGENT_DIR = join(HOME, ".omp", "agent");
mkdirSync(HOME, { recursive: true });
mkdirSync(TENANT_AGENT_DIR, { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });

const route = await jiti.import("./route.ts");
const sdk = await jiti.import("@oh-my-pi/pi-coding-agent");

// `bun test` shares one process: a sibling file may have been the first to
// load the SDK, and its agent dir would then be this file's too.
const dirs = await jiti.import("@oh-my-pi/pi-utils");
dirs.setAgentDir(AGENT_DIR);

const processSettings = await sdk.Settings.loadIsolated({ agentDir: AGENT_DIR });
const previousRuntime = globalThis.__ompRuntimePromise;
globalThis.__ompRuntimePromise = Promise.resolve({
  agentDir: AGENT_DIR,
  settings: processSettings,
  authStorage: { findApiKey: async () => undefined },
  modelRegistry: { getAvailable: () => [], getAll: () => [], getError: () => undefined },
});

const ORIGIN = "http://localhost:30141";
const TENANT = { host: "localhost:30141", "x-omp-user": TENANT_NAME };
const ADMIN = { host: "localhost:30141", "x-omp-user": "settings-admin", "x-omp-admin": "1" };

function get(query = "", headers = TENANT) {
  return route.GET(new Request(`${ORIGIN}/api/settings${query}`, { headers }));
}

function patch(headers, body, contentType = "application/json") {
  return route.PATCH(
    new Request(`${ORIGIN}/api/settings`, {
      method: "PATCH",
      headers: { ...headers, "content-type": contentType },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

function writtenConfig() {
  const file = join(TENANT_AGENT_DIR, "config.yml");
  return existsSync(file) ? parseYaml(readFileSync(file, "utf8")) : undefined;
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

test("GET liefert Tabs und Felder mit Typ, Wert und Schreibrecht", async () => {
  const response = await get();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.tabs) && body.tabs.length > 0);
  assert.ok(Array.isArray(body.fields) && body.fields.length > 0);
  const field = body.fields.find((entry) => entry.path === "hideThinkingBlock");
  assert.ok(field, "hideThinkingBlock fehlt in der Feldliste");
  assert.equal(field.type, "boolean");
  assert.equal(typeof field.writable, "boolean");
  assert.equal(typeof body.theme.names.dark, "string");
  assert.ok(Array.isArray(body.availableThemes));
});

test("der Mandant sieht die hostweiten Einstellungen als nicht schreibbar", async () => {
  const body = await (await get()).json();
  const autolearn = body.fields.find((entry) => entry.path === "autolearn.enabled");
  assert.equal(autolearn.writable, false);
  assert.ok(body.fields.some((entry) => entry.writable === true), "kein schreibbares Feld fuer den Mandanten");
});

test("der Admin sieht dieselbe Liste vollstaendig schreibbar", async () => {
  const body = await (await get("", ADMIN)).json();
  assert.deepEqual(body.fields.filter((entry) => entry.writable !== true), []);
});

test("ein cwd ausserhalb der eigenen Wurzeln ist 403", async () => {
  const response = await get(`?cwd=${encodeURIComponent("/etc")}`);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Access denied");
});

test("PATCH ohne Identitaet oder falsches Content-Type wird abgewiesen", async () => {
  const anonymous = await patch({ host: "localhost:30141" }, { path: "hideThinkingBlock", value: true });
  assert.equal(anonymous.status, 403);
  const untrusted = await patch({ ...TENANT, host: "evil.example" }, { path: "hideThinkingBlock", value: true });
  assert.equal(untrusted.status, 403);
  const wrongType = await patch(TENANT, { path: "hideThinkingBlock", value: true }, "text/plain");
  assert.equal(wrongType.status, 415);
});

test("ein unbekannter Pfad ist 400", async () => {
  const response = await patch(TENANT, { path: "no.such.setting", value: 1 });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Unknown setting");
});

test("ein Mandant kann autolearn nicht umschalten und schreibt nichts", async () => {
  const before = writtenConfig();
  const response = await patch(TENANT, { path: "autolearn.enabled", value: true });
  assert.equal(response.status, 403);
  assert.deepEqual(writtenConfig(), before);
});

test("ein Mandant schreibt eine Anzeigeeinstellung in seine eigene config.yml", async () => {
  const fields = (await (await get()).json()).fields;
  const display = fields.find(
    (entry) => entry.writable === true && entry.type === "boolean" && entry.path !== "hideThinkingBlock",
  );
  assert.ok(display, "kein schreibbares Boolean-Feld fuer den Mandanten");

  const response = await patch(TENANT, { path: display.path, value: !display.value });
  assert.equal(response.status, 200, `${display.path}: ${JSON.stringify(await response.clone().json())}`);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.value, !display.value);

  // The value must land in the tenant's file, not the operator's.
  const keys = display.path.split(".");
  const valueAt = (doc) => keys.reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), doc);
  assert.equal(valueAt(writtenConfig()), !display.value);
  const operatorFile = join(AGENT_DIR, "config.yml");
  const operatorValue = existsSync(operatorFile)
    ? valueAt(parseYaml(readFileSync(operatorFile, "utf8")))
    : undefined;
  assert.notEqual(operatorValue, !display.value, "der Wert steht in der Prozess-config.yml");

  // And a fresh read sees it.
  const reread = (await (await get()).json()).fields.find((entry) => entry.path === display.path);
  assert.equal(reread.value, !display.value);
});

test("ein falscher Werttyp ist 400 und behaelt den alten Wert", async () => {
  const before = writtenConfig();
  const bool = await patch(TENANT, { path: "hideThinkingBlock", value: "yes" });
  assert.equal(bool.status, 400);
  assert.equal((await bool.json()).error, "Expected a boolean");
  assert.deepEqual(writtenConfig(), before);

  const unknownTheme = await patch(TENANT, { path: "theme.dark", value: "no-such-theme" });
  assert.equal(unknownTheme.status, 400);
  assert.match((await unknownTheme.json()).error, /Unknown omp theme/);
});

test("ein kaputter Body ist 400, kein 500", async () => {
  const response = await patch(TENANT, "{ not json");
  assert.equal(response.status, 400);
});
