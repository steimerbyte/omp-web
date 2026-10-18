import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { createJiti } from "jiti";

/**
 * Der cwd-Browser fuer Mandanten.
 *
 * Diese Tests rufen die **Route** auf. Der Startpfad des Pickers entsteht aus
 * `getBrowseStartDirectory()`, und ein Test, der nur diese Funktion prueft,
 * beweist nicht, dass die Route eine Identitaet an sie weitergibt — genau diese
 * Luecke war der Fehler: die Route rief `getBrowseStartDirectory(requested)`
 * ohne Identitaet, die Funktion fiel auf `os.homedir()` zurueck, und das ist die
 * Home des *Dienstkontos*. Fuer einen Mandanten liegt dieser Pfad in keiner
 * Allowlist, also antwortete `GET /api/cwd/browse` ohne `?path=` mit `403
 * Access denied`: der Verzeichniswaehler war fuer jeden Mandanten tot, bis der
 * Nutzer von Hand einen Pfad eintippte.
 *
 * Beobachtet wird die **Antwort der Route** (200 mit dem Home des Kontos und
 * seinen Unterverzeichnissen), nicht die Hilfsfunktion.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-browse-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const browseRoute = await jiti.import("./route.ts");
const { clearAllowedRootsCache } = await jiti.import("@/lib/allowed-roots");

const ORIGIN = "http://localhost:30141";

/** Legt `<home-root>/<username>` mit einem Projekt darunter an. */
function seedTenantHome(username, projectName = "demo") {
  const home = join(HOME_ROOT, username);
  mkdirSync(join(home, "projects", projectName), { recursive: true });
  return home;
}

function browse(query, username) {
  const url = `${ORIGIN}/api/cwd/browse${query}`;
  return browseRoute.GET(new NextRequest(url, {
    headers: { host: "localhost:30141", "x-omp-user": username },
  }));
}

test.beforeEach(() => clearAllowedRootsCache());
test.after(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

test("der Verzeichniswaehler oeffnet ohne ?path= im Home des angemeldeten Kontos", async () => {
  const home = seedTenantHome("alice");

  const res = await browse("", "alice");
  const body = await res.json();

  assert.equal(res.status, 200);
  // Ohne die Identitaet landet der Start auf der Home des Dienstkontos und der
  // Allowlist-Check davor beantwortet die Anfrage mit 403.
  assert.equal(body.path, home);
  assert.deepEqual(
    body.directories.map((entry) => entry.name),
    ["projects"],
  );
});

test("zwei Mandanten starten in ihrem eigenen Home, nicht in einem gemeinsamen", async () => {
  const aliceHome = seedTenantHome("alice");
  const bobHome = seedTenantHome("bob", "scratch");

  const [alice, bob] = await Promise.all([browse("", "alice"), browse("", "bob")]);
  const [aliceBody, bobBody] = await Promise.all([alice.json(), bob.json()]);

  assert.equal(alice.status, 200);
  assert.equal(bob.status, 200);
  assert.equal(aliceBody.path, aliceHome);
  assert.equal(bobBody.path, bobHome);
  assert.deepEqual(bobBody.directories.map((entry) => entry.name), ["projects"]);
});

test("ein explizit genannter Pfad gewinnt weiterhin gegen das Home der Identitaet", async () => {
  const home = seedTenantHome("alice");
  const project = join(home, "projects", "demo");

  const res = await browse(`?path=${encodeURIComponent(project)}`, "alice");
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.path, project);
});