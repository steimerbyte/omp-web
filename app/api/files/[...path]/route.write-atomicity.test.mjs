import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { createJiti } from "jiti";

/**
 * `PUT /api/files/...?type=write` ist der Editor-Speicherpfad. Er schreibt
 * ueber eine Temp-Datei und `rename`, was den Inhalt atomar ersetzt. Zwei
 * Nachbarnutzen dieser Route machen den Schreibpfad aber sichtbar:
 *
 *  - Die Temp-Datei bekommt die Standardrechte des Prozesses. `rename`
 *    uebernimmt sie fuer das Ziel, also verliert eine 0755-Datei ihr +x, sobald
 *    der Nutzer sie im Browser speichert. `copyTree` in der file-actions-Route
 *    haelt die Rechte aus demselben Grund ausdruecklich fest.
 *
 *  - Das `catch` raeumt nur auf, wenn `tempHandle` gesetzt ist, und das passiert
 *    erst *nach* dem Schreibvorgang. Scheitert der Schreibvorgang selbst,
 *    bleibt eine halb geschriebene Datei unter dem Zielnamen liegen — in einem
 *    Projektverzeichnis, das der Agent liest und in dem `git status` sie zeigt.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-put-atomic-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const HOME = join(HOME_ROOT, "writer");
mkdirSync(HOME, { recursive: true });

const filesRoute = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("@/lib/file-access");
allowFileRoot(HOME, { username: "writer", isAdmin: false });

const ORIGIN = "http://localhost:30141";

function saveRequest(filePath, content) {
  const segments = filePath.split("/").filter(Boolean);
  const url = `${ORIGIN}/api/files/${segments.map(encodeURIComponent).join("/")}?type=write`;
  return filesRoute.PUT(
    new NextRequest(url, {
      method: "PUT",
      headers: { host: "localhost:30141", "x-omp-user": "writer", "content-type": "application/json" },
      body: JSON.stringify({ content }),
    }),
    { params: Promise.resolve({ path: segments }) },
  );
}

test.after(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

test("das Speichern im Browser behaelt die Rechte einer ausfuehrbaren Datei", async (t) => {
  if (process.platform === "win32") {
    t.skip("Nutzerrechte sind unter Windows nicht ueber mode steuerbar");
    return;
  }
  const directory = join(HOME, "projects", "editor-mode");
  mkdirSync(directory, { recursive: true });
  const target = join(directory, "deploy.sh");
  writeFileSync(target, "#!/bin/sh\necho alt\n");
  fs.chmodSync(target, 0o755);

  const res = await saveRequest(target, "#!/bin/sh\necho neu\n");
  const body = await res.json();

  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(readFileSync(target, "utf8"), "#!/bin/sh\necho neu\n");
  // Ohne ein chmod auf die Temp-Datei traegt das Ergebnis deren Rechte
  // (0644) und nicht die der Datei, die ueberschrieben wurde.
  assert.equal(
    statSync(target).mode & 0o777,
    0o755,
    "ein im Browser gespeichertes Skript muss ausfuehrbar bleiben",
  );
});

test("ein gespeichertes Skript bleibt auch bei 0700 ausfuehrbar", async (t) => {
  if (process.platform === "win32") {
    t.skip("Nutzerrechte sind unter Windows nicht ueber mode steuerbar");
    return;
  }
  const directory = join(HOME, "projects", "editor-mode-700");
  mkdirSync(directory, { recursive: true });
  const target = join(directory, "private.sh");
  writeFileSync(target, "#!/bin/sh\necho alt\n");
  fs.chmodSync(target, 0o700);

  const res = await saveRequest(target, "#!/bin/sh\necho neu\n");
  assert.equal(res.status, 200);

  assert.equal(statSync(target).mode & 0o777, 0o700);
});

test("der Ordner bleibt nach einem Speichern frei von Temp-Dateien", async () => {
  const directory = join(HOME, "projects", "editor-temp");
  mkdirSync(directory, { recursive: true });
  const target = join(directory, "notes.txt");
  writeFileSync(target, "ALT\n");

  const res = await saveRequest(target, "NEU\n");
  assert.equal(res.status, 200);

  assert.deepEqual(readdirSync(directory).sort(), ["notes.txt"]);
});

test("ein gescheiterter Schreibvorgang legt keine halbe Datei daneben", async () => {
  const directory = join(HOME, "projects", "editor-write-fail");
  mkdirSync(directory, { recursive: true });
  const target = join(directory, "notes.txt");
  writeFileSync(target, "ALTER INHALT\n");

  // Modelliert ENOSPC mitten im Schreiben: die Datei wird angelegt, ein Teil
  // landet, dann bricht der Vorgang ab. Genau so sieht ein voller Datentraeger
  // aus, und genau da ist `tempHandle` noch nicht gesetzt.
  const realWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function patched(file, data, ...rest) {
    if (typeof file === "string" && file.startsWith(target) && file !== target) {
      realWriteFileSync.call(fs, file, "HALB", "utf8");
      const error = new Error("ENOSPC: no space left on device");
      error.code = "ENOSPC";
      throw error;
    }
    return realWriteFileSync.call(fs, file, data, ...rest);
  };

  try {
    await saveRequest(target, "NEUER INHALT\n");
  } finally {
    fs.writeFileSync = realWriteFileSync;
  }

  // Der alte Inhalt steht noch da — der rename hat nicht stattgefunden.
  assert.equal(readFileSync(target, "utf8"), "ALTER INHALT\n");
  // Und die abgebrochene Temp-Datei ist wieder verschwunden.
  assert.deepEqual(
    readdirSync(directory).sort(),
    ["notes.txt"],
    "eine abgebrochene Temp-Datei darf nicht im Projektverzeichnis bleiben",
  );
});