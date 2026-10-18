import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { createJiti } from "jiti";

/**
 * `?type=read` und `?type=meta` muessen eine Datei an ihrem Inhalt messen.
 *
 * Beide Zweige entschieden bisher allein nach der Endung. Eine Datei ohne
 * Endungseintrag galt damit als Text, und `readFileSync(path, "utf-8")` lieferte
 * fuer ein WebAssembly-Modul NUL-Bytes und U+FFFD als `content` zurueck. Im
 * Explorer landet das im Quelltext-Viewer: der Agent und der Nutzer sehen eine
 * Seite Muell, `language` sagt "text", und der Viewer bietet an, das zu
 * bearbeiten und zu speichern. `meta` behauptet fuer dieselbe Datei
 * `mime: "text/plain"` — die Properties-Box im Explorer.
 *
 * Der Test ruft die **Route** auf, nicht `headLooksLikeText`. Dass die
 * Pruefung an anderer Stelle richtig arbeitet, beweist nicht, dass sie hier
 * ueberhaupt stattfindet — genau das war die Luecke.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-binread-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const HOME = join(HOME_ROOT, "alice");
mkdirSync(HOME, { recursive: true });

const filesRoute = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("@/lib/file-access");
allowFileRoot(HOME, { username: "alice", isAdmin: false });

const ORIGIN = "http://localhost:30141";
/** 0x00 asm 0x01 — the magic of every WebAssembly module, no control text. */
const WASM_HEAD = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xff, 0xfe, 0x01]);

function write(name, bytes) {
  const filePath = join(HOME, name);
  writeFileSync(filePath, bytes);
  return filePath;
}

function request(filePath, type) {
  const segments = filePath.split("/").filter(Boolean);
  const url = `${ORIGIN}/api/files/${segments.map(encodeURIComponent).join("/")}?type=${type}`;
  return filesRoute.GET(
    new NextRequest(url, { headers: { host: "localhost:30141", "x-omp-user": "alice" } }),
    { params: Promise.resolve({ path: segments }) },
  );
}

test.after(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

test("eine Binaerdatei ohne Endungseintrag wird nicht als Quelltext ausgeliefert", async () => {
  const wasm = write("module.wasm", WASM_HEAD);

  const res = await request(wasm, "read");
  const body = await res.json();

  assert.equal(res.status, 415);
  assert.equal(body.binary, true);
  assert.equal(body.error, "Binary file cannot be displayed");
  // The mojibake payload must be gone, not merely flagged alongside.
  assert.equal("content" in body, false);
});

test("der Properties-Dialog nennt fuer dieselbe Datei application/octet-stream", async () => {
  const wasm = write("module.wasm", WASM_HEAD);

  const res = await request(wasm, "meta");
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.mime, "application/octet-stream");
});

test("eine Quelltextdatei ohne Endungseintrag bleibt lesbar", async () => {
  const script = write("Makefile.am", Buffer.from("all:\n\techo hi\n", "utf8"));

  const res = await request(script, "read");
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.content, "all:\n\techo hi\n");

  const meta = await request(script, "meta");
  assert.equal((await meta.json()).mime, "text/plain");
});

test("eine leere Datei ist Text und wird nicht als binaer abgewiesen", async () => {
  const empty = write("empty.log", Buffer.alloc(0));

  const res = await request(empty, "read");
  const body = await res.json();

  // `headLooksLikeText` hat kein Sample und antwortet `false`. Fuer eine Datei
  // mit 0 Byte ist das die falsche Antwort.
  assert.equal(res.status, 200);
  assert.equal(body.content, "");
  assert.equal((await (await request(empty, "meta")).json()).mime, "text/plain");
});

test("Umlaute und mehrsprachiger Quelltext bleiben unangetastet", async () => {
  const source = write("Notiz.txt", Buffer.from("grüße — 日本語 — ✓\n", "utf8"));

  const res = await request(source, "read");
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.content, "grüße — 日本語 — ✓\n");
});