import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Die Mandantengrenze von `/api/mcp`.
 *
 * Diese Tests rufen die **Route** auf, nicht den Guard. Ein Test, der nur
 * `resolveTenantAgentDir` oder `isAdminIdentity` prueft, beweist, dass die
 * Bausteine stimmen — nicht, dass die Route sie benutzt. Genau diese Luecke war
 * der Einbruch: `configPath` las `getAgentDir()` und `validatedCwd` rief
 * `getRequestIdentity` nur, wenn ueberhaupt ein `cwd` mitkam. Ein `PUT` mit
 * `{ scope: "user" }` lief durch keine einzige Pruefung und schrieb in die
 * gemeinsame MCP-Konfiguration aller — eine Datei, aus der MCP-Server als
 * Kindprozesse gestartet werden.
 *
 * Der Beweis ist deshalb zweigeteilt und jeder Teil beobachtet eine andere
 * Sache: die **Antwort** (403) und die **Nebenwirkung** (die globale Datei wurde
 * nicht angefasst). Ein "403 zurueck, aber der Eintrag steht trotzdem in der
 * globalen Datei"-Fehler kann hier nicht durchrutschen.
 *
 * **Keine Zugangsdaten in diesem File.** MCP-Eintraege tragen `env` und
 * `headers`; die Teste pruefen Pfade und Rechte und geben niemals den Inhalt
 * einer Konfiguration aus.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-mcp-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const mcpRoute = await jiti.import("./route.ts");

const ADMIN = { host: "localhost", "x-omp-user": "pi", "x-omp-admin": "1" };
const TENANT = { host: "localhost", "x-omp-user": "alice" };
const OTHER_TENANT = { host: "localhost", "x-omp-user": "bob" };
const ANON = { host: "localhost" };

/** Der Prozess-Agent-Dir. Fuer einen Admin ist das genau der User-Scope. */
function processAgentDir() {
  return jiti.import("@oh-my-pi/pi-coding-agent").then((sdk) => sdk.getAgentDir());
}

function tenantDir(username) {
  return join(HOME_ROOT, username, ".omp", "agent");
}

function request(url, { method = "GET", headers = TENANT, body } = {}) {
  return new Request(`http://${headers.host ?? "localhost"}${url}`, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Ein Eintrag, der als Kindprozess laufen wuerde — ohne Secret, ohne Nutzlast. */
const SERVER = { name: "probe", config: { command: "true", args: [] } };

/** Legt eine mcp.json mit genau einem Server an und gibt ihren Pfad zurueck. */
function seedMcpFile(path, name = "seeded") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ mcpServers: { [name]: { command: "true", args: [] } } }, null, 2)}\n`);
  return path;
}

test.after(() => {
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Der Schreibpfad
// ---------------------------------------------------------------------------

test("ein Nicht-Admin kann scope 'user' nicht in die Prozesskonfiguration schreiben", async () => {
  const agentDir = await processAgentDir();
  const globalPath = join(agentDir, "mcp.json");
  const existedBefore = existsSync(globalPath);
  const before = existedBefore ? readFileSync(globalPath, "utf8") : null;

  const res = await mcpRoute.PUT(request("/api/mcp", { method: "PUT", body: { scope: "user", servers: [SERVER] } }));

  assert.equal(res.status, 403, `erwartet 403, bekam ${res.status}`);

  // Die Nebenwirkung, nicht nur die Antwort: die globale Datei ist unberuehrt.
  if (existedBefore) {
    assert.equal(readFileSync(globalPath, "utf8"), before, "die globale mcp.json wurde veraendert");
  } else {
    assert.equal(existsSync(globalPath), false, "die globale mcp.json wurde neu angelegt");
  }
});

test("der Benutzer-Scope eines Nicht-Admins landet auch nicht in dessen eigenem Verzeichnis", async () => {
  // Der Guard steht VOR der Ableitung. Ein Mandant, der es ablehnt bekommt,
  // bekommt es auch dort — eine "403, aber Datei geschrieben"-Variante waere
  // genau der Fehler, den die erste Probe nicht sieht.
  const path = join(tenantDir("alice"), "mcp.json");

  const res = await mcpRoute.PUT(request("/api/mcp", { method: "PUT", body: { scope: "user", servers: [SERVER] } }));

  assert.equal(res.status, 403);
  assert.equal(existsSync(path), false, "es wurde eine Mandantendatei angelegt, die niemand liest");
});

test("ein Admin schreibt weiterhin in die globale Datei, weil er das Prozesskonto ist", async () => {
  const agentDir = await processAgentDir();
  const globalPath = join(agentDir, "mcp.json");
  mkdirSync(agentDir, { recursive: true });
  rmSync(globalPath, { force: true });

  const res = await mcpRoute.PUT(request("/api/mcp", { method: "PUT", headers: ADMIN, body: { scope: "user", servers: [SERVER] } }));

  assert.equal(res.status, 200, `erwartet 200, bekam ${res.status}: ${await res.text()}`);
  assert.ok(existsSync(globalPath), "der Admin hat nicht in die globale mcp.json geschrieben");
  const written = JSON.parse(readFileSync(globalPath, "utf8"));
  assert.deepEqual(Object.keys(written.mcpServers), ["probe"]);

  rmSync(globalPath, { force: true });
});

test("zwei Mandanten teilen sich keinen User-Scope mehr", async () => {
  const alicePath = join(tenantDir("alice"), "mcp.json");
  const bobPath = join(tenantDir("bob"), "mcp.json");

  for (const headers of [TENANT, OTHER_TENANT]) {
    const res = await mcpRoute.PUT(request("/api/mcp", { method: "PUT", headers, body: { scope: "user", servers: [SERVER] } }));
    assert.equal(res.status, 403);
  }
  assert.equal(existsSync(alicePath), false);
  assert.equal(existsSync(bobPath), false);
});

// ---------------------------------------------------------------------------
// PATCH — der Weg, an dem ein Guard auf body.scope allein nicht ausreicht
// ---------------------------------------------------------------------------

test("PATCH mit scope 'user' ist fuer einen Nicht-Admin gesperrt", async () => {
  const res = await mcpRoute.PATCH(request("/api/mcp", {
    method: "PATCH",
    body: { scope: "user", name: "probe", enabled: false },
  }));
  assert.equal(res.status, 403, `erwartet 403, bekam ${res.status}`);
});

test("PATCH mit scope 'project' schreibt nicht in die Konfiguration eines anderen", async () => {
  // `setMcpServerEnabled` faellt bei unbekanntem Namen auf `userPath` zurueck
  // und schreibt dort `disabledServers`/`enabledServers`. Ein Guard, der nur auf
  // `body.scope === "user"` schaut, wuerde diesen Pfad durchlassen.
  const bobUserPath = join(tenantDir("bob"), "mcp.json");

  const res = await mcpRoute.PATCH(request("/api/mcp", {
    method: "PATCH",
    body: { scope: "project", name: "gibtsnicht", enabled: false },
  }));

  // 400/403 ist in Ordnung — entscheidend ist, dass nirgends eine fremde Datei
  // entstanden ist. `cwd` fehlt hier absichtlich.
  assert.ok(res.status === 400 || res.status === 403, `erwartet 400 oder 403, bekam ${res.status}`);
  assert.equal(existsSync(bobUserPath), false);
});

// ---------------------------------------------------------------------------
// Der Projekt-Scope bleibt Mandanteneigentum
// ---------------------------------------------------------------------------

test("ein Mandant kann in einem cwd seiner Roots auf project schreiben", async () => {
  const projectCwd = join(tenantDir("alice"), "projekt");
  mkdirSync(projectCwd, { recursive: true });
  // Ausgangszustand herstellen: dieser Test darf nicht davon abhaengen, was ein
  // vorheriger Test in der Reihenfolge angelegt hat.
  rmSync(join(tenantDir("alice"), "mcp.json"), { force: true });
  rmSync(join(projectCwd, ".omp"), { recursive: true, force: true });
  // Der cwd muss in den Lesewurzeln der Identitaet liegen.
  const { allowFileRoot } = await jiti.import("@/lib/file-access");
  allowFileRoot(projectCwd, { username: "alice", isAdmin: false });

  const res = await mcpRoute.PUT(
    request(`/api/mcp?cwd=${encodeURIComponent(projectCwd)}`, {
      method: "PUT",
      body: { scope: "project", servers: [SERVER] },
    }),
  );

  assert.equal(res.status, 200, `erwartet 200, bekam ${res.status}: ${await res.text()}`);
  assert.ok(existsSync(join(projectCwd, ".omp", "mcp.json")), "die Projektkonfiguration fehlt");
  assert.equal(existsSync(join(tenantDir("alice"), "mcp.json")), false, "es wurde in den User-Scope geschrieben");

  // Der legitime Projektpfad bleibt lesbar — die Containment-Pruefung darf
  // nicht jede Projektkonfiguration abschneiden.
  const read = await mcpRoute.GET(request(`/api/mcp?cwd=${encodeURIComponent(projectCwd)}`));
  assert.equal(read.status, 200, `erwartet 200, bekam ${read.status}`);
  const body = await read.json();
  assert.deepEqual((body.project?.servers ?? []).map((entry) => entry.name), ["probe"]);
});

test("ein .omp-Symlink macht aus dem Projekt keinen fremden MCP-Store", async () => {
  // OMP-005: `<cwd>/.omp` als Link auf `/home/pi/.omp/agent` liess `GET` die
  // Server des Betreibers anzeigen und `PUT` seine `mcp.json` schreiben. Beide
  // Wege muessen den *echten* Pfad pruefen, nicht den Linktext.
  const projectCwd = join(tenantDir("alice"), "symlink-projekt");
  const victimDir = join(HOME_ROOT, "victim");
  const victimPath = seedMcpFile(join(victimDir, "mcp.json"), "victim");
  const before = readFileSync(victimPath, "utf8");
  mkdirSync(projectCwd, { recursive: true });
  rmSync(join(projectCwd, ".omp"), { recursive: true, force: true });
  symlinkSync(victimDir, join(projectCwd, ".omp"), "dir");
  const { allowFileRoot } = await jiti.import("@/lib/file-access");
  allowFileRoot(projectCwd, { username: "alice", isAdmin: false });

  const read = await mcpRoute.GET(request(`/api/mcp?cwd=${encodeURIComponent(projectCwd)}`));
  assert.equal(read.status, 403, `erwartet 403, bekam ${read.status}`);
  assert.equal((await read.text()).includes("victim"), false, "der fremde Server wurde gelesen");

  const write = await mcpRoute.PUT(request(`/api/mcp?cwd=${encodeURIComponent(projectCwd)}`, {
    method: "PUT",
    body: { scope: "project", servers: [SERVER] },
  }));
  assert.equal(write.status, 400, `erwartet 400, bekam ${write.status}`);
  assert.equal(readFileSync(victimPath, "utf8"), before, "der Symlink hat in einen fremden Store geschrieben");
  assert.equal(existsSync(join(victimDir, "mcp.json")), true);
});

test("ein Admin darf seine mcp.json aus dem Agent-Verzeichnis heraus verlinken", async (t) => {
  // Der Admin ist das Prozesskonto: ein `mcp.json`, das in ein
  // Dotfiles-Repository zeigt, ist ein normaler Aufbau und darf weder am Lesen
  // noch am Schreiben gehindert werden. Aufgeloest wird trotzdem, damit genau
  // die Zieldatei gelesen und geschrieben wird.
  const agentDir = await processAgentDir();
  const linkPath = join(agentDir, "mcp.json");
  const dotfiles = join(HOME_ROOT, "dotfiles");
  mkdirSync(dotfiles, { recursive: true });
  const target = seedMcpFile(join(dotfiles, "mcp.json"), "dotfile");

  // Den echten Bestand des Prozesskontos sichern und am Ende zuruecklegen.
  const previous = existsSync(linkPath)
    ? lstatSync(linkPath).isSymbolicLink()
      ? { link: readlinkSync(linkPath) }
      : { content: readFileSync(linkPath) }
    : null;
  t.after(() => {
    rmSync(linkPath, { force: true });
    if (previous?.link !== undefined) symlinkSync(previous.link, linkPath);
    else if (previous?.content !== undefined) writeFileSync(linkPath, previous.content);
    rmSync(dotfiles, { recursive: true, force: true });
  });
  rmSync(linkPath, { force: true });
  mkdirSync(agentDir, { recursive: true });
  symlinkSync(target, linkPath, "file");

  const read = await mcpRoute.GET(request("/api/mcp", { headers: ADMIN }));
  assert.equal(read.status, 200, `erwartet 200, bekam ${read.status}`);
  const body = await read.json();
  // Kein deepEqual auf die ganze Liste: `addDiscoveredServers` liest
  // prozessweite Capability-Discovery, in die eine frueher gelaufene Testdatei
  // denselben Bun-Prozess einen Server (`thunderbird`) gelegt hat. `dotfile`
  // kann nur aus dem Symlink-Ziel stammen — nichts sonst im Fixture deklariert
  // ihn —, also belegt `includes` genau die Behauptung.
  assert.ok(
    (body.user?.servers ?? []).some((entry) => entry.name === "dotfile"),
    `der verlinkte Server fehlt: ${JSON.stringify(body.user?.servers)}`,
  );

  const written = await mcpRoute.PUT(request("/api/mcp", {
    method: "PUT",
    headers: ADMIN,
    body: { scope: "user", servers: [SERVER] },
  }));
  assert.equal(written.status, 200, `erwartet 200, bekam ${written.status}: ${await written.text()}`);
  // Geschrieben wurde durch den Link in das Ziel, nicht daneben.
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(target, "utf8")).mcpServers), ["probe"]);
  assert.equal(readFileSync(linkPath, "utf8"), readFileSync(target, "utf8"));
});

test("ein Mandant bekommt am selben Aufbau weiterhin 403 und das Ziel bleibt unberuehrt", async () => {
  const victim = seedMcpFile(join(HOME_ROOT, "victim-tenant", "mcp.json"), "victim");
  const before = readFileSync(victim, "utf8");
  mkdirSync(tenantDir("bob"), { recursive: true });
  const linkPath = join(tenantDir("bob"), "mcp.json");
  rmSync(linkPath, { force: true });
  symlinkSync(victim, linkPath, "file");

  try {
    const read = await mcpRoute.GET(request("/api/mcp", { headers: OTHER_TENANT }));
    assert.equal(read.status, 403, `erwartet 403, bekam ${read.status}`);
    assert.equal((await read.text()).includes("victim"), false);

    const write = await mcpRoute.PUT(request("/api/mcp", {
      method: "PUT",
      headers: OTHER_TENANT,
      body: { scope: "user", servers: [SERVER] },
    }));
    assert.equal(write.status, 403, `erwartet 403, bekam ${write.status}`);
    assert.equal(readFileSync(victim, "utf8"), before, "der Mandanten-Symlink hat in einen fremden Store geschrieben");
  } finally {
    rmSync(linkPath, { force: true });
  }
});

test("ein fremder cwd bleibt auch fuer den Admin-Scope unerreichbar", async () => {
  const foreign = join(tmpdir(), "omp-web-mcp-fremd");
  mkdirSync(foreign, { recursive: true });

  const res = await mcpRoute.PUT(
    request(`/api/mcp?cwd=${encodeURIComponent(foreign)}`, {
      method: "PUT",
      body: { scope: "project", servers: [SERVER] },
    }),
  );

  assert.equal(res.status, 400, `erwartet 400, bekam ${res.status}`);
  assert.equal(existsSync(join(foreign, ".omp", "mcp.json")), false);
});

// ---------------------------------------------------------------------------
// Lesehemmung
// ---------------------------------------------------------------------------

test("ohne Identitaet gibt es keine MCP-Konfiguration", async () => {
  const res = await mcpRoute.GET(request("/api/mcp", { headers: ANON }));
  assert.equal(res.status, 403, `erwartet 403, bekam ${res.status}`);
});

test("ein Mandant sieht die Prozesskonfiguration nicht", async () => {
  const agentDir = await processAgentDir();
  const globalPath = seedMcpFile(join(agentDir, "mcp.json"), "hostwide");

  try {
    const asTenant = await mcpRoute.GET(request("/api/mcp"));
    assert.equal(asTenant.status, 200, `erwartet 200, bekam ${asTenant.status}`);
    const tenantBody = await asTenant.json();
    const names = (tenantBody.user?.servers ?? []).map((s) => s.name);
    assert.equal(names.includes("hostwide"), false, "der Mandant sieht den Server des Prozesskontos");

    const asAdmin = await mcpRoute.GET(request("/api/mcp", { headers: ADMIN }));
    assert.equal(asAdmin.status, 200);
    const adminBody = await asAdmin.json();
    const adminNames = (adminBody.user?.servers ?? []).map((s) => s.name);
    assert.equal(adminNames.includes("hostwide"), true, "der Admin sieht seine eigene Konfiguration nicht");
  } finally {
    rmSync(globalPath, { force: true });
  }
});

// ---------------------------------------------------------------------------
// Die Quelle selbst: configPath muss die Identity kennen
// ---------------------------------------------------------------------------

test("configPath leitet den User-Scope ueber resolveTenantAgentDir ab", async () => {
  const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

  // Kein `getAgentDir()` mehr im Pfad-Ausdruck: genau das war der Einbruch.
  assert.doesNotMatch(source, /join\(getAgentDir\(\), *"mcp.json"\)/);
  assert.match(source, /resolveTenantAgentDir\(identity\)/);

  // Und der Guard steht in beiden Mutationen, vor der Pfadableitung.
  for (const handler of ["export async function PUT", "export async function PATCH"]) {
    const section = source.slice(source.indexOf(handler));
    const guard = section.indexOf("requireUserScope(identity, body.scope)");
    const pathUse = section.indexOf("configPath(identity,");
    assert.ok(guard > 0, `${handler} ruft den User-Scope-Guard nicht auf`);
    assert.ok(pathUse > guard, `${handler} leitet einen Pfad ab, bevor der Guard steht`);
  }
});