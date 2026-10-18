import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { createJiti } from "jiti";

/**
 * Der Editor liest mit `bytes.toString("utf-8")` und schreibt mit
 * `Buffer.from(body.content, "utf-8")`. Das ist nur verlustfrei, wenn die Datei
 * auch wirklich UTF-8 ist.
 *
 * `headLooksLikeText` entscheidet anhand von NUL-Bytes und Steuerzeichen, nicht
 * anhand der Kodierung. Eine Latin-1-Datei mit einem 0xE4 ist also "Text", wird
 * ausgegeben und laesst sich bearbeiten — aber `0xE4` ist in UTF-8 kein gültiges
 * Byte. Die Decodierung ersetzt es durch U+FFFD, und das Zurueckschreiben legt
 * `EF BF BD` in die Datei. Das Original ist danach nicht wiederherstellbar: der
 * Nutzer hat beim Speichern einer Datei Inhalt zerstoert, die er nie falsch
 * gelesen hat, sondern nur nicht lesen konnte.
 *
 * Der Test haelt beide Haelften fest: die Route darf eine Datei, die nicht
 * verlustfrei als UTF-8 darstellbar ist, gar nicht erst zum Bearbeiten
 * anbieten — und der Read-only-Pfad liefert weiterhin echten Quelltext.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-encoding-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const HOME = join(HOME_ROOT, "reader");
mkdirSync(HOME, { recursive: true });

const filesRoute = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("@/lib/file-access");
allowFileRoot(HOME, { username: "reader", isAdmin: false });

const ORIGIN = "http://localhost:30141";

function request(filePath, type) {
  const segments = filePath.split("/").filter(Boolean);
  const url = `${ORIGIN}/api/files/${segments.map(encodeURIComponent).join("/")}?type=${type}`;
  return filesRoute.GET(
    new NextRequest(url, { headers: { host: "localhost:30141", "x-omp-user": "reader" } }),
    { params: Promise.resolve({ path: segments }) },
  );
}

test.after(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

test("eine Datei mit ungueltiger UTF-8-Sequenz wird nicht als Quelltext angeboten", async () => {
  const directory = join(HOME, "projects", "latin1");
  mkdirSync(directory, { recursive: true });
  // "Stra<0xE4>e" in ISO-8859-1 — ein ganzes Byte, kein gueltiges UTF-8.
  const latin1 = Buffer.from([0x53, 0x74, 0x72, 0x61, 0xE4, 0x65]);
  const target = join(directory, "adresse.txt");
  writeFileSync(target, latin1);

  const res = await request(target, "read");
  const body = await res.json();

  // Der entscheidende Punkt: was der Viewer anzeigt, muss sich unveraendert
  // zurueckschreiben lassen. Solange `content` U+FFFD enthaelt, ist jeder
  // Speichervorgang eine Zerstoerung, also darf `content` hier nicht geliefert
  // werden.
  if (res.status === 200) {
    const roundTrip = Buffer.from(body.content, "utf-8");
    assert.equal(
      roundTrip.equals(latin1),
      true,
      "der gelieferte Inhalt muss verlustfrei zurueckschreibbar sein — sonst wird die Datei beim Speichern zerstoert",
    );
  } else {
    assert.equal(res.status, 415, "eine nicht darstellbare Datei wird abgewiesen");
    assert.equal("content" in body, false, "im Ablehnungsfall gibt es keinen Inhalt zum Anzeigen");
  }
});

test("echter UTF-8-Quelltext mit Umlauten bleibt lesbar und unveraendert", async () => {
  const directory = join(HOME, "projects", "utf8");
  mkdirSync(directory, { recursive: true });
  const utf8 = Buffer.from("Grüße aus München\n", "utf-8");
  const target = join(directory, "gruesse.txt");
  writeFileSync(target, utf8);

  const res = await request(target, "read");
  const body = await res.json();

  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.content, "Grüße aus München\n");
  // Die Runde muss exakt aufgehen — sonst waere auch der Normalfall betroffen.
  assert.equal(Buffer.from(body.content, "utf-8").equals(utf8), true);
});

test("eine abgeschnittene UTF-8-Sequenz am Dateiende wird nicht angeboten", async () => {
  const directory = join(HOME, "projects", "truncated");
  mkdirSync(directory, { recursive: true });
  // 0xE4 am Ende: unvollstaendige Sequenz, ein echter haeufiger Fall bei
  // abgeschnittenen Logzeilen.
  const truncated = Buffer.from([0x61, 0x62, 0xE4]);
  const target = join(directory, "log.txt");
  writeFileSync(target, truncated);

  const res = await request(target, "read");
  const body = await res.json();

  if (res.status === 200) {
    assert.equal(
      Buffer.from(body.content, "utf-8").equals(truncated),
      true,
      "eine abgeschnittene Sequenz darf nicht stillschweigend zu U+FFFD werden",
    );
  } else {
    assert.equal(res.status, 415);
    assert.equal("content" in body, false);
  }
});

test("das Original bleibt auf der Platte unangetastet", async () => {
  const directory = join(HOME, "projects", "latin1-untouched");
  mkdirSync(directory, { recursive: true });
  const latin1 = Buffer.from([0x53, 0x74, 0x72, 0x61, 0xE4, 0x65]);
  const target = join(directory, "adresse.txt");
  writeFileSync(target, latin1);

  await request(target, "read");

  assert.equal(readFileSync(target).equals(latin1), true, "ein Lesevorgang veraendert die Datei nicht");
});