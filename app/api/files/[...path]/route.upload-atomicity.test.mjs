import assert from "node:assert/strict";
import fs from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { createJiti } from "jiti";

/**
 * Ein Upload mit `conflict=overwrite` loescht die alte Datei, BEVOR die neue
 * geschrieben ist:
 *
 *     if (conflictSet.has(file.name)) {
 *       fs.unlinkSync(destination);          // <-- alte Datei ist weg
 *     }
 *     fs.writeFileSync(destination, bytes, { flag: "wx" });   // <-- und das kann scheitern
 *
 * Scheitert der Schreibvorgang — kein Platz mehr, EROFS, ein `wx`-Konflikt,
 * weil zwischen der Pruefung und dem Schreiben jemand anderes dieselbe Datei
 * angelegt hat —, ist die alte Datei bereits geloescht und die Antwort meldet
 * nur noch einen Fehler. Der Nutzer verliert den Inhalt unwiederbringlich.
 *
 * Der Fehler ist hier ohne eine zweite Session reproduzierbar: der Schreibpfad
 * laesst sich gezielt unmoeglich machen. Der Test macht es so, wie es in der
 * Praxis passiert — `writeFileSync` scheitert genau fuer diesen einen Zielpfad,
 * wie es bei ENOSPC, EROFS oder einem `wx`-Konflikt mitten im Schreiben tut.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-upload-atomic-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const HOME = join(HOME_ROOT, "uploader");
mkdirSync(HOME, { recursive: true });

const filesRoute = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("@/lib/file-access");
allowFileRoot(HOME, { username: "uploader", isAdmin: false });

const ORIGIN = "http://localhost:30141";

function uploadRequest(directory, formData, conflict) {
  const segments = directory.split("/").filter(Boolean);
  const url = `${ORIGIN}/api/files/${segments.map(encodeURIComponent).join("/")}?type=upload&conflict=${conflict}`;
  return filesRoute.POST(
    new NextRequest(url, {
      method: "POST",
      headers: { host: "localhost:30141", "x-omp-user": "uploader" },
      body: formData,
    }),
    { params: Promise.resolve({ path: segments }) },
  );
}

function formWith(name, text) {
  const form = new FormData();
  form.append("files", new File([text], name, { type: "text/plain" }));
  return form;
}

// A marker string that occurs nowhere else in this process, so a write carrying
// it can only be this test's upload landing. That makes the injected failure
// independent of *where* the implementation writes — target file, sibling temp
// file — which is what keeps the test from encoding the fix it is meant to test.
// The route hands the bytes over as a Buffer, the test fixtures as a string.
const UPLOAD_MARKER = "omp-web-upload-marker-4f2a9c";
function writesThisUpload(data) {
  return (
    typeof data === "string" && data.includes(UPLOAD_MARKER)
  ) || (
    data instanceof Uint8Array && Buffer.from(data).includes(UPLOAD_MARKER)
  );
}

test.after(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

test("ein fehlgeschlagener Overwrite laesst die alte Datei unangetastet", async () => {
  const directory = join(HOME, "projects", "overwrite-fail");
  mkdirSync(directory, { recursive: true });
  const target = join(directory, "notes.txt");
  writeFileSync(target, "ALTER, WICHTIGER INHALT\n");

  // Der Schreibvorgang, der die neuen Bytes ablegt, scheitert — ENOSPC ist der
  // haeufigste Fall, aber jeder Fehler trifft denselben Zweig. Die Injection
  // haengt an den *Inhalten*, nicht an einem Pfad: sie trifft den Schreibvorgang,
  // egal ob die Implementierung direkt ins Ziel oder zuerst in eine Temp-Datei
  // schreibt. Genau das macht den Test unabhaengig von der Fix-Implementierung,
  // waehrend er die Ursache bleibt ("die neuen Bytes kommen nicht an").
  const realWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function patched(file, data, ...rest) {
    if (writesThisUpload(data)) {
      const error = new Error("ENOSPC: no space left on device");
      error.code = "ENOSPC";
      throw error;
    }
    return realWriteFileSync.call(fs, file, data, ...rest);
  };

  let res;
  try {
    res = await uploadRequest(directory, formWith("notes.txt", `NEUER INHALT ${UPLOAD_MARKER}\n`), "overwrite");
  } finally {
    fs.writeFileSync = realWriteFileSync;
  }

  const body = await res.json();
  assert.equal(body.uploaded.includes("notes.txt"), false, "der Upload darf sich nicht als erfolgreich melden");
  assert.equal(body.errors.length, 1);

  // Der eigentliche Befund: die alte Datei ist noch da, mit ihrem Inhalt.
  assert.equal(readFileSync(target, "utf8"), "ALTER, WICHTIGER INHALT\n");
});

test("der Ordner eines fehlgeschlagenen Overwrites bleibt frei von Temp-Dateien", async () => {
  const directory = join(HOME, "projects", "overwrite-temp");
  mkdirSync(directory, { recursive: true });
  const target = join(directory, "notes.txt");
  writeFileSync(target, "ALT\n");

  const realWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function patched(file, data, ...rest) {
    if (writesThisUpload(data)) {
      const error = new Error("ENOSPC: no space left on device");
      error.code = "ENOSPC";
      throw error;
    }
    return realWriteFileSync.call(fs, file, data, ...rest);
  };

  try {
    await uploadRequest(directory, formWith("notes.txt", `NEU ${UPLOAD_MARKER}\n`), "overwrite");
  } finally {
    fs.writeFileSync = realWriteFileSync;
  }

  assert.deepEqual(readdirSync(directory).sort(), ["notes.txt"]);
});

test("ein erfolgreicher Overwrite ersetzt den Inhalt und legt nichts daneben", async () => {
  const directory = join(HOME, "projects", "overwrite-ok");
  mkdirSync(directory, { recursive: true });
  const target = join(directory, "notes.txt");
  writeFileSync(target, "ALT\n");

  const res = await uploadRequest(directory, formWith("notes.txt", "NEU\n"), "overwrite");

  const body = await res.json();
  assert.deepEqual(body.errors, []);
  assert.deepEqual(body.uploaded, ["notes.txt"]);
  assert.equal(readFileSync(target, "utf8"), "NEU\n");
  assert.deepEqual(readdirSync(directory).sort(), ["notes.txt"]);
});

test("der Overwrite behaelt die Dateirechte der alten Datei", async (t) => {
  if (process.platform === "win32") {
    t.skip("Nutzerrechte sind unter Windows nicht ueber mode steuerbar");
    return;
  }
  const directory = join(HOME, "projects", "overwrite-mode");
  mkdirSync(directory, { recursive: true });
  const target = join(directory, "script.sh");
  writeFileSync(target, "#!/bin/sh\necho alt\n");
  chmodSync(target, 0o755);

  const res = await uploadRequest(directory, formWith("script.sh", "#!/bin/sh\necho neu\n"), "overwrite");
  const body = await res.json();

  assert.deepEqual(body.errors, [], "der Overwrite muss gelingen");
  assert.equal(readFileSync(target, "utf8"), "#!/bin/sh\necho neu\n");
  // Eine heruntergeladene Datei ersetzt das Ziel ueber eine Temp-Datei. Ohne ein
  // chmod auf die Temp-Datei traegt das Ergebnis die Rechte der Temp-Datei
  // (0600) und nicht die der Datei, die gerade ueberschrieben wurde — ein
  // ausfuehrbares Skript verliert damit sein +x.
  const statSync = fs.statSync;
  assert.equal(statSync(target).mode & 0o777, 0o755, "ein ueberschriebenes Skript muss ausfuehrbar bleiben");
});