import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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

const ORIGIN = "http://localhost:30141";

function list(dirPath) {
  const segments = dirPath.split("/").filter(Boolean);
  const url = `${ORIGIN}/api/files/${segments.map(encodeURIComponent).join("/")}?type=list`;
  return filesRoute.GET(
    new NextRequest(url, { headers: { host: "localhost:30141", "x-omp-user": "alice" } }),
    { params: Promise.resolve({ path: segments }) },
  );
}

test.after(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

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