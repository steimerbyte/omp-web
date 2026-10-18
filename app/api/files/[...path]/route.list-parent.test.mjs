import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { createJiti } from "jiti";

/**
 * Der Elternpfad von `GET /api/files/<pfad>?type=list`.
 *
 * `FileBrowserDialog` zeigte den Knopf "eine Ebene hoeher" allein deshalb an,
 * weil es `getFileDirectory(currentPath)` nicht leer war — rein lexikalisch.
 * Fuer ein Konto mit Home `<home-root>/alice` ist der Elternpfad von
 * `<home-root>/alice` aber `<home-root>`, und das liegt in keiner Allowlist
 * dieses Kontos. Der erste Klick endete damit bei jedem Mandanten in
 * `403 Access denied`. Commit `5569d3a` hat genau diese Fehlerklasse in
 * `/api/cwd/browse` behoben, aber nur in dieser Route.
 *
 * Geprueft wird die **Route**, weil die Pruefung dort liegen muss: die
 * Komponente kennt die Allowlist nicht und kann sie auch nicht erraten. Die
 * Route nennt deshalb nur einen Elternpfad, den sie selbst betreten darf
 * (`parentPath: null` heisst fuer die Oberflaeche "kein Weg nach oben").
 *
 * Der zweite Test ist die Gegenprobe gegen das Ueberdrehen: fuer
 * `<home-root>/alice/projects/demo` ist `<home-root>/alice/projects` eine
 * Stufe hoeher, liegt in der Home des Kontos und wird deshalb **nicht**
 * abgelehnt — der Knopf muss dort bleiben, wo der Klick funktioniert.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "omp-web-listparent-home-")));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const HOME = join(HOME_ROOT, "alice");
mkdirSync(join(HOME, "projects", "demo"), { recursive: true });

const filesRoute = await jiti.import("./route.ts");
// `bun test` laedt alle Dateien in einen Prozess, und `OMP_WEB_HOME_ROOT` ist
// Prozess-Umgebung. Ohne diese ausdrueckliche Freigabe wuerde die Home dieses
// Tests an der eines anderen hängen, der spaeter geladen wurde — der Test
// hinge dann von der Dateireihenfolge ab.
const { allowFileRoot } = await jiti.import("@/lib/file-access");
const IDENTITY = { username: "alice", isAdmin: false };
allowFileRoot(HOME, IDENTITY);

/**
 * Ein zweiter Baum fuer den Admin-Fall: nur Admins bekommen `/` in ihre
 * Allowlist (`getAdditionalAllowedRoots`). Das ist der einzige Fall, in dem
 * die Kette bis zur Wurzel laufen kann — und damit der einzige, in dem die
 * Abbruchbedingung der Schleife ueberhaupt erreicht wird.
 */
const ADMIN_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "omp-web-listparent-admin-")));
const ADMIN_TREE = join(ADMIN_ROOT, "srv", "app");
mkdirSync(join(ADMIN_TREE, "deep"), { recursive: true });
const ADMIN_IDENTITY = { username: "root", isAdmin: true };
allowFileRoot(ADMIN_ROOT, ADMIN_IDENTITY);

const ORIGIN = "http://localhost:30141";

function list(dirPath, { admin = false } = {}) {
  const segments = dirPath.split("/").filter(Boolean);
  const url = `${ORIGIN}/api/files/${segments.map(encodeURIComponent).join("/")}?type=list`;
  return filesRoute.GET(
    new NextRequest(url, {
      headers: {
        host: "localhost:30141",
        "x-omp-user": admin ? "root" : "alice",
        // Admin ist ein eigener Kopf, nicht Teil des Benutzernamens.
        ...(admin ? { "x-omp-admin": "1" } : {}),
      },
    }),
    { params: Promise.resolve({ path: segments }) },
  );
}

test.after(() => {
  rmSync(HOME_ROOT, { recursive: true, force: true });
  rmSync(ADMIN_ROOT, { recursive: true, force: true });
});

test("in der Home des Kontos nennt die Liste keinen Elternpfad", async () => {
  const res = await list(HOME);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.path, HOME);
  // `<home-root>` liegt oberhalb der erlaubten Home. Der lexikalische Elternpfad
  // wuerde ihn nennen, und jeder Klick darauf endet in "Access denied".
  assert.equal(body.parentPath, null);
  // Die Liste selbst bleibt vollstaendig — der Fix darf keinen gueltigen Fall
  // mitverlieren.
  assert.deepEqual(body.entries.map((entry) => entry.name), ["projects"]);
});

test("eine Stufe tiefer in der Home bleibt navigierbar", async () => {
  const res = await list(join(HOME, "projects", "demo"));
  const body = await res.json();

  assert.equal(res.status, 200);
  // `<home-root>/alice/projects` ist in der Allowlist des Kontos, also bleibt
  // der Knopf. Genau dieser Fall waere mit einer zu strengen Regel kaputt.
  assert.equal(body.parentPath, join(HOME, "projects"));
});

test("die Liste nennt jede betretbare Krume und hoert vor der Home auf", async () => {
  const res = await list(join(HOME, "projects", "demo"));
  const body = await res.json();

  assert.equal(res.status, 200);
  // Die Brotkrumen von `FileBrowserDialog` werden zu Knoepfen, sobald sie
  // hier stehen. Reichen wuerde nur der Elternpfad, wuerde der Dialog weiter
  // jede Krume ueber der Home klickbar rendern — und der erste Klick endete in
  // "Access denied". Reihenfolge: vom naechsten Vorfahren aus.
  assert.deepEqual(body.ancestors, [join(HOME, "projects"), HOME]);
  // `HOME_ROOT` ist die Wurzel des Mandanten und liegt ausserhalb seiner
  // Allowlist; es darf in keiner Form als Ziel auftauchen.
  assert.equal(body.ancestors.includes(HOME_ROOT), false);
});

test("in der Home des Kontos ist die Kette der betretbaren Krume leer", async () => {
  const res = await list(HOME);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body.ancestors, []);
  assert.equal(body.parentPath, null);
});
/**
 * `parentPath` ist das erste Element von `ancestors` — die Zusage, dass ein
 * Client, der nur `parentPath` liest, unveraendert weiterarbeitet. Bisher
 * stand sie nur im Code; der Test in `FileBrowserDialog.crumbs.test.mjs` setzt
 * beide Werte von Hand in einem Mock und kann sie deshalb gar nicht pruefen.
 * Geprueft wird sie hier, gegen die Antwort der Route selbst.
 */
test("parentPath ist immer das erste Element von ancestors", async () => {
  for (const dirPath of [HOME, join(HOME, "projects"), join(HOME, "projects", "demo")]) {
    const res = await list(dirPath);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(
      body.parentPath,
      body.ancestors[0] ?? null,
      `fuer ${dirPath}: parentPath=${JSON.stringify(body.parentPath)} ancestors=${JSON.stringify(body.ancestors)}`,
    );
  }
});

/**
 * Ein Vorfahr, den die Allowlist nicht kennt, darf nicht allein deshalb in der
 * Kette stehen, weil er lexikalisch der Elternpfad ist. Fuer den Mandanten
 * ist das `HOME_ROOT` — und es steht dort nachweislich nicht.
 */
test("ein nicht erlaubter Vorfahr landet nicht in ancestors", async () => {
  const res = await list(join(HOME, "projects", "demo"));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body.ancestors, [join(HOME, "projects"), HOME]);
  // Der lexikalische Elternpfad von `HOME` IST `HOME_ROOT`. Er ist der naechste
  // Kandidat, den die Schleife prueft — und er muss die Schleife beenden.
  assert.equal(body.ancestors.includes(HOME_ROOT), false);
  assert.equal(body.parentPath, join(HOME, "projects"));
});

/**
 * Die zweite Abbruchbedingung der Schleife: ein Vorfahr, der die
 * Allowlist-Pruefung nicht besteht, beendet die Kette.
 *
 * Geprueft wird sie an der Pruefung selbst, nicht ueber einen 200-Request —
 * und das ist keine Auswahl, sondern eine Notwendigkeit: jeder Pfad, dessen
 * Vorfahr nicht erlaubt ist, faellt auch selbst durch die Allowlist-Pruefung
 * der Route und kommt gar nicht erst in die Schleife. Ein toter Symlink loest
 * sich ueber `realpathSync` nicht auf, also genau so: der Ordner unter dem
 * Link ist nicht erreichbar, die Liste gibt es nicht, und es gibt nichts zu
 * beobachten.
 *
 * Die Wirkung dieser Bedingung ist damit an der einen Stelle belegbar, an der
 * sie im Betrieb auftritt — und der andere Fall, die Wurzel als eigener
 * Elternpfad, im naechsten Test.
 */
test("ein Vorfahr, der sich nicht aufloesen laesst, ist kein bestaetigter Vorfahr", async () => {
  const { isExistingFilePathAllowed } = await jiti.import("@/lib/file-access");
  const DANGLING = join(HOME, "dangling");
  symlinkSync(join(HOME, "gibt-es-nicht"), DANGLING);

  try {
    const allowed = await jiti.import("@/lib/allowed-roots")
      .then(({ getAdditionalAllowedRoots }) => getAdditionalAllowedRoots(IDENTITY));
    allowed.add(HOME);

    // Der tote Link ist kein bestaetigter Vorfahr — die Schleife endet dort.
    assert.equal(isExistingFilePathAllowed(DANGLING, allowed), false,
      "ein toter Symlink wurde als betretbarer Vorfahr akzeptiert");
    // Gegenprobe: der Elternpfad derselben Kette ist es sehr wohl, sonst
    // pruefte der Test nichts.
    assert.equal(isExistingFilePathAllowed(HOME, allowed), true,
      "die Gegenprobe ist ebenfalls nicht erlaubt — der Test prueft nichts");
  } finally {
    rmSync(DANGLING, { recursive: true, force: true });
  }
});

/**
 * Die Kette laeuft fuer einen Admin bis zur Wurzel — nur Admins haben `/` in
 * der Allowlist — und kommt dort zurueck, statt weiterzulaufen.
 *
 * Zwei Bedingungen halten die Schleife an, und der Test deckt beide nicht
 * einzeln auf: `getFileDirectory("/")` liefert `""`, und die Abbruchbedingung
 * `next === cursor` deckt den Fall ab, in dem die Wurzel ihr eigener
 * Elternpfad waere. Geprueft wird das Ergebnis, das beide zusammen ergeben —
 * eine vollstaendige Kette, die an `/` endet und den Request beantwortet.
 */
test("die Kette endet an der Wurzel, statt endlos weiterzulaufen", async () => {
  const res = await list(join(ADMIN_TREE, "deep"), { admin: true });
  const body = await res.json();

  assert.equal(res.status, 200);
  // Die Kette laeuft nach oben bis `/` und endet dort. Der Request ist
  // ueberhaupt erst zurueckgekommen — das ist der eigentliche Nachweis.
  assert.deepEqual(body.ancestors, [
    ADMIN_TREE,
    join(ADMIN_ROOT, "srv"),
    ADMIN_ROOT,
    ...allAncestorsOf(ADMIN_ROOT),
    "/",
  ]);
  assert.equal(body.ancestors[body.ancestors.length - 1], "/");
  assert.equal(body.parentPath, ADMIN_TREE);
});

/**
 * Die Vorfahren einer Allowlist-Wurzel auf dem Weg zur `/`, so wie die Schleife
 * sie berechnet. Bewusst aus `getFileDirectory` nachgebaut und nicht aus der
 * Route importiert: sonst wuerde der Test die Implementierung gegen sich
 * selbst pruefen.
 */
function allAncestorsOf(dirPath) {
  const parts = dirPath.split("/").filter(Boolean);
  const out = [];
  let running = "";
  for (const part of parts) {
    running = `${running}/${part}`;
    out.push(running);
  }
  return out.reverse().slice(1);
}
