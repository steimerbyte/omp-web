import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { createJiti } from "jiti";

/**
 * Der Upload ersetzt eine vorhandene Datei nie, bevor die neue vollstaendig da
 * ist.
 *
 * Die Bytes laufen heute erst in eine Nachbardatei (`.name.<uuid>.upload`) im
 * Zielordner und werden danach in einem Schritt eingehaengt. Ein Upload, der
 * mittendrin scheitert, darf die alte Datei deshalb nicht anfassen und keine
 * Temp-Datei hinterlassen.
 *
 * Der Fehler wird hier so erzeugt, wie er im Alltag aussieht: der Client
 * kuendigt eine Groesse an und die Verbindung endet vorher. Frueher fuehrte das
 * zu einem abgeschnittenen Multipart-Body; heute bricht der PUT ab, bevor
 * irgendetwas einghaengt wird.
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
const putRoute = await jiti.import("../../../upload/[token]/route.ts");
const { allowFileRoot } = await jiti.import("@/lib/file-access");
allowFileRoot(HOME, { username: "uploader", isAdmin: false });

const ORIGIN = "http://localhost:30141";

function segmentsOf(directory) {
  return directory.split("/").filter(Boolean);
}

async function mintTicket(directory, name, size, conflict) {
  const segments = segmentsOf(directory);
  const url = `${ORIGIN}/api/files/${segments.map(encodeURIComponent).join("/")}?type=upload-ticket&conflict=${conflict}`;
  const response = await filesRoute.POST(
    new NextRequest(url, {
      method: "POST",
      headers: {
        host: "localhost:30141",
        "x-omp-user": "uploader",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name, size }),
    }),
    { params: Promise.resolve({ path: segments }) },
  );
  return { status: response.status, body: await response.json() };
}

async function putBody(token, bytes) {
  const response = await putRoute.PUT(
    new Request(`${ORIGIN}/upload/${token}`, {
      method: "PUT",
      headers: { host: "localhost:30141", "content-type": "application/octet-stream" },
      body: bytes,
    }),
    { params: Promise.resolve({ token }) },
  );
  return { status: response.status, body: await response.json() };
}

test.after(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

test("ein abgebrochener Overwrite laesst die alte Datei unangetastet", async () => {
  const directory = join(HOME, "projects", "overwrite-fail");
  mkdirSync(directory, { recursive: true });
  const target = join(directory, "notes.txt");
  writeFileSync(target, "ALTER, WICHTIGER INHALT\n");

  const minted = await mintTicket(directory, "notes.txt", 64, "overwrite");
  assert.equal(minted.status, 200, JSON.stringify(minted.body));
  assert.equal(typeof minted.body.token, "string");

  // Der Client kuendigt 64 Bytes an und schickt weniger: die Verbindung ist
  // mittendrin gestorben, und der PUT muss ablehnen.
  const failed = await putBody(minted.body.token, new Uint8Array(16).fill(0x61));
  assert.ok(failed.status >= 400, `expected a refusal, got ${failed.status}`);

  // Der eigentliche Befund: die alte Datei ist noch da, mit ihrem Inhalt.
  assert.equal(readFileSync(target, "utf8"), "ALTER, WICHTIGER INHALT\n");
});

test("ein gescheiterter Upload hinterlaesst keine Temp-Datei im Ordner", async () => {
  const directory = join(HOME, "projects", "overwrite-temp");
  mkdirSync(directory, { recursive: true });
  const target = join(directory, "notes.txt");
  writeFileSync(target, "ALT\n");

  const minted = await mintTicket(directory, "notes.txt", 64, "overwrite");
  await putBody(minted.body.token, new Uint8Array(16).fill(0x62));

  assert.deepEqual(readdirSync(directory).sort(), ["notes.txt"]);
});

test("ein erfolgreicher Overwrite ersetzt den Inhalt und legt nichts daneben", async () => {
  const directory = join(HOME, "projects", "overwrite-ok");
  mkdirSync(directory, { recursive: true });
  const target = join(directory, "notes.txt");
  writeFileSync(target, "ALT\n");

  const payroll = Buffer.from("NEU\n");
  const minted = await mintTicket(directory, "notes.txt", payroll.length, "overwrite");
  const result = await putBody(minted.body.token, payroll);

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.errors, []);
  assert.deepEqual(result.body.uploaded, ["notes.txt"]);
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

  const script = Buffer.from("#!/bin/sh\necho neu\n");
  const minted = await mintTicket(directory, "script.sh", script.length, "overwrite");
  const result = await putBody(minted.body.token, script);

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(readFileSync(target, "utf8"), "#!/bin/sh\necho neu\n");
  // Eine heruntergeladene Datei ersetzt das Ziel ueber eine Temp-Datei. Ohne ein
  // chmod auf die Temp-Datei traegt das Ergebnis die Rechte der Temp-Datei
  // (0600) und nicht die der Datei, die gerade ueberschrieben wurde — ein
  // ausfuehrbares Skript verliert damit sein +x.
  assert.equal(statSync(target).mode & 0o777, 0o755, "ein ueberschriebenes Skript muss ausfuehrbar bleiben");
});
