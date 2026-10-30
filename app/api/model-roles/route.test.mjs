import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

test("model-role PUT writes global roles through canonical Settings and re-reads the target scope", async () => {
  const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
  const putSource = source.slice(source.indexOf("export async function PUT"));

  assert.match(putSource, /const runtime = await getOmpRuntime\(\)/);
  assert.match(
    putSource,
    /const settingsToWrite = scope === "global"\s*\?\s*runtime\.settings\s*:\s*await getSettingsForCwd\(result\.cwd\)/s,
  );
  assert.match(putSource, /await settingsToWrite\.flush\(\)/);
  assert.match(putSource, /const settings = await getSettingsForCwd\(result\.cwd\)/);
});

/**
 * `scope: "global"` schreibt in die `config.yml` des **Prozesskontos**, nicht
 * in die des Aufrufers (`AGENTS.md:289`). Ein Mandant, der das darf, verschiebt
 * den Default des Betreibers — und damit den jeder anderen Sitzung.
 *
 * Die Route wird als echtes Modul geladen, der Runtime kommt aus
 * `globalThis.__ompRuntimePromise`. Statt einer Attrappe steht dort eine
 * **echte, isolierte** `Settings` auf einem Wegwerf-Verzeichnis: damit ist die
 * Zusage nicht "irgendwo wurde `setModelRole` gerufen", sondern die Datei, die
 * danach auf der Platte liegt. `loadIsolated` fasst `~/.omp/agent` nicht an.
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });

const HOME_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "omp-web-model-roles-")));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const TENANT = { username: "role-tenant", isAdmin: false };
const ADMIN = { username: "role-admin", isAdmin: true };
const processAgentDir = join(HOME_ROOT, "process-agent");
mkdirSync(join(HOME_ROOT, TENANT.username), { recursive: true });
mkdirSync(processAgentDir, { recursive: true });

const { Settings } = await jiti.import("@oh-my-pi/pi-coding-agent");
const route = await jiti.import("./route.ts");
// `bun test` laeuft in einem Prozess: ohne diese Freigabe haengt das `cwd` des
// Tests an der Home, die eine andere Testdatei zuletzt gesetzt hat.
const { allowFileRoot } = await jiti.import("@/lib/file-access");

/** Ein frisches Projekt je Test; nur das eigene Konto darf es benutzen. */
function projectDir() {
  const dir = realpathSync(mkdtempSync(join(HOME_ROOT, TENANT.username, "project-")));
  allowFileRoot(dir, TENANT);
  return dir;
}

/** Der "Prozess" dieser Tests: eine isolierte Settings ueber `processAgentDir`. */
async function installIsolatedRuntime() {
  const settings = await Settings.loadIsolated({ agentDir: processAgentDir });
  globalThis.__ompRuntimePromise = Promise.resolve({
    agentDir: processAgentDir,
    settings,
    modelRegistry: { getAvailable: () => [], getAll: () => [] },
  });
  return settings;
}

function removeRuntime() {
  delete globalThis.__ompRuntimePromise;
}

/** Die Datei, in die eine Ebene schreibt — leer, wenn es sie noch nicht gibt. */
function readConfig(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
}

function put(identity, body) {
  const headers = { host: "localhost", "content-type": "application/json" };
  if (identity) {
    headers["x-omp-user"] = identity.username;
    if (identity.isAdmin) headers["x-omp-admin"] = "1";
  }
  return route.PUT(
    new Request("http://localhost/api/model-roles", {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

test("ein Mandant darf keine globalen Modellrollen schreiben", async (t) => {
  await installIsolatedRuntime();
  t.after(removeRuntime);
  const project = projectDir();
  const before = readConfig(join(processAgentDir, "config.yml"));

  const response = await put(TENANT, {
    cwd: project,
    role: "default",
    selector: "auditprov/bob-model",
    scope: "global",
  });

  assert.equal(response.status, 403, `erwartet 403, bekam ${response.status}`);
  assert.equal((await response.json()).error, "Access denied");
  // Der Beweis, dass der Guard *vor* dem Schreiben sitzt: die Prozess-Config
  // ist byte-gleich, und im Projekt ist ebenfalls nichts entstanden.
  assert.equal(readConfig(join(processAgentDir, "config.yml")), before, "die Prozess-config.yml wurde veraendert");
  assert.equal(readConfig(join(project, ".omp", "config.yml")), "", "im Projekt darf nichts stehen");
});

test("ein Mandant schreibt seine eigene Rolle weiterhin", async (t) => {
  await installIsolatedRuntime();
  t.after(removeRuntime);
  const project = projectDir();
  const before = readConfig(join(processAgentDir, "config.yml"));

  const response = await put(TENANT, {
    cwd: project,
    role: "default",
    selector: "auditprov/own-model",
    scope: "project",
  });

  assert.equal(response.status, 200, `erwartet 200, bekam ${response.status}`);
  const projectConfig = readConfig(join(project, ".omp", "config.yml"));
  assert.match(projectConfig, /default: auditprov\/own-model/, `Projekt-Config: ${projectConfig}`);
  assert.equal(readConfig(join(processAgentDir, "config.yml")), before, "die Prozess-Ebene bleibt unberuehrt");
});

test("der Admin schreibt globale Rollen weiterhin", async (t) => {
  await installIsolatedRuntime();
  t.after(removeRuntime);

  const adminProject = projectDir();
  const response = await put(ADMIN, {
    cwd: adminProject,
    role: "default",
    selector: "openrouter/openai/gpt-5",
    scope: "global",
  });

  assert.equal(response.status, 200, `erwartet 200, bekam ${response.status}`);
  const processConfig = readConfig(join(processAgentDir, "config.yml"));
  assert.match(processConfig, /default: openrouter\/openai\/gpt-5/, `Prozess-Config: ${processConfig}`);
  assert.equal(readConfig(join(adminProject, ".omp", "config.yml")), "", "die Projekt-Ebene bleibt unberuehrt");
});

test("ein Aufruf ohne scope gilt als global und ist fuer Mandanten gesperrt", async (t) => {
  await installIsolatedRuntime();
  t.after(removeRuntime);
  const project = projectDir();
  const before = readConfig(join(processAgentDir, "config.yml"));

  // Der Default der Route ist `global`; ein Mandant, der das Feld weglaesst,
  // darf nicht versehentlich in die Prozess-Config schreiben.
  const response = await put(TENANT, { cwd: project, role: "default", selector: "a/b" });

  assert.equal(response.status, 403, `erwartet 403, bekam ${response.status}`);
  assert.equal(readConfig(join(processAgentDir, "config.yml")), before);
});
