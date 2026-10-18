import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

/** Legt `<home-root>/<username>/projects/demo` an und gibt die Home zurueck. */
function seedTenantHome(username) {
  const home = join(HOME_ROOT, username);
  mkdirSync(join(home, "projects", "demo"), { recursive: true });
  return home;
}

function browse(query, username) {
  const url = `${ORIGIN}/api/cwd/browse${query}`;
  return browseRoute.GET(new NextRequest(url, {
    headers: { host: "localhost:30141", "x-omp-user": username },
  }));
}

/** Wie `browse`, aber mit dem Admin-Kopf — die Route sieht dann `/` als Home. */
function browseAsAdmin(query) {
  const url = `${ORIGIN}/api/cwd/browse${query}`;
  return browseRoute.GET(new NextRequest(url, {
    headers: { host: "localhost:30141", "x-omp-user": "admin", "x-omp-admin": "1" },
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
  const bobHome = seedTenantHome("bob");

  const [alice, bob] = await Promise.all([browse("", "alice"), browse("", "bob")]);
  const [aliceBody, bobBody] = await Promise.all([alice.json(), bob.json()]);

  assert.equal(alice.status, 200);
  assert.equal(bob.status, 200);
  assert.equal(aliceBody.path, aliceHome);
  assert.equal(bobBody.path, bobHome);
  assert.deepEqual(bobBody.directories.map((entry) => entry.name), ["projects"]);
});

test("ein Tilde-Pfad zeigt auf das Home des Kontos, nicht auf das des Dienstkontos", async () => {
  const home = seedTenantHome("alice");
  mkdirSync(join(home, "projects", "tilde"), { recursive: true });

  // Das Eingabefeld des DirectoryPickers wirbt ausdruecklich mit "~": ohne
  // Identitaet loest normalizeDirectory() die Tilde mit os.homedir() auf, also
  // mit der Home des Dienstkontos, und die Allowlist verweigert.
  const res = await browse("?path=~/projects/tilde", "alice");
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.path, join(home, "projects", "tilde"));
});

test("ein explizit genannter Pfad gewinnt weiterhin gegen das Home der Identitaet", async () => {
  const home = seedTenantHome("alice");
  const project = join(home, "projects", "demo");

  const res = await browse(`?path=${encodeURIComponent(project)}`, "alice");
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.path, project);
});

test("der Knopf 'ein Verzeichnis hoch' wird angeboten, obwohl die Antwort immer 403 waere", async () => {
  const home = seedTenantHome("alice");

  const res = await browse("", "alice");
  const body = await res.json();

  assert.equal(res.status, 200);
  // `<home-root>` liegt oberhalb von `<home-root>/alice` und damit ausserhalb
  // jeder Allowlist dieses Kontos. `getParentDirectory()` lieferte es trotzdem,
  // also aktivierte DirectoryPicker den Aufwaerts-Knopf und der naechste Klick
  // endete in "Access denied". Ohne navigierbaren Elternpfad gibt es nichts zu
  // klicken, und `canNavigateUp` wird false.
  assert.equal(body.path, home);
  assert.equal(body.parentPath, null);
});

test("der Admin startet weiterhin im Home des Prozesses, nicht in der Wurzel", async () => {
  const res = await browseAsAdmin("");
  const body = await res.json();

  assert.equal(res.status, 200);
  // `getUserHome(admin)` ist `/`, nicht die Home des Kontos. Fuenf Mandanten-
  // Tests sahen nur die Mandantenrichtung; faellt die `identity.isAdmin`-
  // Verzweigung in `identityHome()`/`getBrowseStartDirectory()` weg, startet der
  // Admin hier in `/` — und kein Mandantentest merkt es.
  assert.equal(body.path, realpathSync(homedir()));
  assert.notEqual(body.path, "/");
});

test("der Admin darf auch eine Ebene hoeher als sein Home betreten", async () => {
  const home = realpathSync(homedir());

  const res = await browseAsAdmin("");
  const body = await res.json();

  // Fuer den Admin ist der Elternpfad seiner Home erreichbar, weil `/` in
  // seinen Roots steht. Verstuende die Allowlist das anders, waere der
  // Aufwaerts-Knopf beim Admin weg — die Umkehrung desselben Fehlers.
  assert.equal(body.parentPath, dirname(home));
  const parent = await browseAsAdmin(`?path=${encodeURIComponent(body.parentPath)}`);
  assert.equal(parent.status, 200);
});
