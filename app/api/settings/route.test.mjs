import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * Die Rollengrenze von `/api/settings`.
 *
 * Der PATCH schreibt in die `config.yml` des Kontos, das ihn stellt — er war
 * damit offen fuer jede Anzeigeeinstellung, aber auch fuer die Schalter, die
 * bestimmen, was eine Sitzung ueberhaupt laedt (`autolearn`, `memory.backend`,
 * `commands.*`, `skills.*`). `isAdminOnlySetting()` beantwortet, welche Pfade
 * das sind; `requireAdmin()` antwortet darauf. Diese Tests rufen die **Route**
 * auf, nicht den Guard: ein Test von `isAdminOnlySetting` allein belegt nur,
 * dass die Praefixliste stimmt, nicht dass der PATCH sie benutzt.
 *
 * Jeder Fall mit Nebenwirkung beobachtet beide Seiten: die **Antwort** und die
 * **Datei**. Ein "403 zurueck, aber der Wert steht in der config.yml"-Fehler
 * ist genau die Variante, die eine reine Statuspruefung nicht sieht.
 *
 * Gemessen wird in einem eigenen Prozess. `bun test` teilt sich einen Prozess,
 * und `lib/omp-runtime.ts` ist darin ein Singleton: der Agent-Dir des ersten
 * Files, das ihn laedt, gilt fuer alle, und das SDK kann daneben in zwei Kopien
 * existieren (dann schreibt `setting.set()` gegen ein fremdes Handle). Beides
 * ist eine Eigenheit des Pruefstands, keine der Route — ein eigener Prozess mit
 * eigenem Home misst die Route so, wie sie laeuft, und macht diese Datei
 * unabhaengig von der Reihenfolge der Testdateien (dasselbe Muster wie
 * `lib/tenant-settings-isolation.test.mjs`).
 *
 * **Keine Zugangsdaten in diesem File.** `providers.*` traegt API-Keys; die
 * GET-Antwort liefert fuer Credential-Felder `null`, und die Teste geben keinen
 * Dateiinhalt aus.
 */

const PROBE = `
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";
import { parse as parseYaml } from "yaml";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const route = await jiti.import(process.env.PROBE_ROUTE);
const { isAdminOnlySetting } = await jiti.import(process.env.PROBE_SETTINGS_API);

const ADMIN = { host: "localhost", "x-omp-user": "pi", "x-omp-admin": "1" };
const TENANT = { host: "localhost", "x-omp-user": "alice" };

const send = (headers, method, body) =>
  new Request("http://localhost/api/settings", {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const getFields = async (headers) => {
  const res = await route.GET(send(headers, "GET"));
  if (res.status !== 200) throw new Error("GET status " + res.status + ": " + (await res.text()));
  return (await res.json()).fields;
};

/** Der Wert unter \`keys\` in einer config.yml; \`undefined\`, wenn Datei oder Pfad fehlen. */
const writtenValue = (path, keys) => {
  if (!existsSync(path)) return undefined;
  const doc = parseYaml(readFileSync(path, "utf8"));
  return keys.reduce((node, key) => (node && typeof node === "object" && !Array.isArray(node) ? node[key] : undefined), doc);
};

const denied = async (path, value, keys) => {
  const res = await route.PATCH(send(TENANT, "PATCH", { path, value }));
  const body = await res.json();
  return {
    path,
    status: res.status,
    success: body.success === true,
    // Der Wert, den der Mandant damit in seiner eigenen config.yml haette.
    written: writtenValue(join(process.env.OMP_WEB_HOME_ROOT, "alice", ".omp", "agent", "config.yml"), keys),
  };
};

const tenantFields = await getFields(TENANT);
const adminFields = await getFields(ADMIN);

const adminWrite = await route.PATCH(send(ADMIN, "PATCH", { path: "autolearn.enabled", value: true }));
const adminAfter = (await getFields(ADMIN)).find((field) => field.path === "autolearn.enabled");

// Eine Anzeigeeinstellung, die der Mandant selbst stellen darf: die erste
// beschreibbare Boolean-Einstellung ausserhalb der Admin-Praefixe.
const display = tenantFields.find(
  (field) => field.writable && field.type === "boolean" && !isAdminOnlySetting(field.path),
);
if (!display) throw new Error("kein beschreibbares Anzeigefeld fuer den Mandanten");
const displayWrite = await route.PATCH(send(TENANT, "PATCH", { path: display.path, value: !display.value }));

console.log(JSON.stringify({
  denials: [
    await denied("autolearn.enabled", true, ["autolearn", "enabled"]),
    await denied("memory.backend", "local", ["memory", "backend"]),
    await denied("commands.enableClaudeUser", true, ["commands", "enableClaudeUser"]),
  ],
  adminStatus: adminWrite.status,
  adminValue: adminAfter?.value,
  adminConfigValue: writtenValue(join(process.env.PI_CODING_AGENT_DIR, "config.yml"), ["autolearn", "enabled"]),
  displayPath: display.path,
  displayWanted: !display.value,
  displayStatus: displayWrite.status,
  displayValue: (await getFields(TENANT)).find((field) => field.path === display.path)?.value,
  displayConfigValue: writtenValue(
    join(process.env.OMP_WEB_HOME_ROOT, "alice", ".omp", "agent", "config.yml"),
    display.path.split("."),
  ),
  tenantBlocked: tenantFields.filter((field) => field.writable === false).map((field) => field.path),
  // writable: false ist ein Versprechen an die Oberflaeche: der PATCH lehnt
  // diesen Pfad ab. Ein Pfad, der nur in der Anzeige gesperrt ist, waere die
  // Anzeige einer Regel, die es nicht gibt — und umgekehrt.
  tenantBlockedNotAdminOnly: tenantFields
    .filter((field) => field.writable === false && !isAdminOnlySetting(field.path))
    .map((field) => field.path),
  adminNotWritable: adminFields.filter((field) => field.writable !== true).map((field) => field.path),
}));
`;

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-settings-home-"));
const PROCESS_AGENT_DIR = join(HOME_ROOT, "proc-agent");
const probePath = join(HOME_ROOT, "probe.mjs");
writeFileSync(probePath, PROBE);

const measured = (() => {
  const out = execFileSync(process.execPath, [probePath], {
    encoding: "utf8",
    env: {
      ...process.env,
      OMP_WEB_HOME_ROOT: HOME_ROOT,
      PI_CODING_AGENT_DIR: PROCESS_AGENT_DIR,
      NODE_ENV: "test",
      PI_TEST_RUNTIME: "1",
      PROBE_ROUTE: new URL("./route.ts", import.meta.url).href,
      PROBE_SETTINGS_API: new URL("../../../lib/settings-api.ts", import.meta.url).href,
    },
    cwd: new URL("../..", import.meta.url).pathname,
  });
  return JSON.parse(out.trim().split("\n").at(-1));
})();

test.after(() => {
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

test("ein Mandant kann autolearn.enabled nicht schreiben", () => {
  const [denial] = measured.denials;
  assert.equal(denial.path, "autolearn.enabled");
  // `autolearn` schaltet `manage_skill` frei, das in den Prozess-Store schreibt.
  assert.equal(denial.status, 403, `erwartet 403, bekam ${denial.status}`);
  // Ein 200 waere derselbe Einbruch mit freundlicherer Antwort — die Datei
  // darunter ist der Grund, warum auch dieser Fall geprueft wird.
  assert.notEqual(denial.success, true);
  assert.notEqual(denial.written, true);
});

test("ein Mandant kann memory.backend nicht schreiben", () => {
  const [, denial] = measured.denials;
  assert.equal(denial.status, 403);
  assert.notEqual(denial.written, "local");
});

test("ein Mandant kann commands.enableClaudeUser nicht schreiben", () => {
  const [, , denial] = measured.denials;
  assert.equal(denial.status, 403);
  assert.notEqual(denial.written, true);
});

test("ein Admin schreibt autolearn.enabled, und die Folgelesung sieht den Wert", () => {
  assert.equal(measured.adminStatus, 200);
  assert.equal(measured.adminValue, true, "die Folgelesung sieht den geschriebenen Wert nicht");
  assert.equal(measured.adminConfigValue, true, "der Admin hat nicht in seinen Agent-Dir geschrieben");
});

test("ein Mandant schreibt eine Anzeigeeinstellung selbst", () => {
  assert.equal(measured.displayStatus, 200, `${measured.displayPath}: erwartet 200, bekam ${measured.displayStatus}`);
  assert.equal(measured.displayValue, measured.displayWanted, "die Folgelesung sieht den Wert des Mandanten nicht");
  assert.equal(measured.displayConfigValue, measured.displayWanted, "der Wert steht nicht in der config.yml des Mandanten");
});

test("die Leseliste stimmt mit dem Schreib-Guard ueberein", () => {
  assert.deepEqual(measured.tenantBlockedNotAdminOnly, []);
  assert.ok(
    measured.tenantBlocked.some(
      (path) => path === "autolearn.enabled" || path === "memory.backend"
        || path.startsWith("skills.") || path.startsWith("commands."),
    ),
    `kein gesperrtes Feld aus der Admin-Liste: ${measured.tenantBlocked.join(", ")}`,
  );
  // Fuer den Admin ist dieselbe Liste vollstaendig schreibbar.
  assert.deepEqual(measured.adminNotWritable, []);
});
