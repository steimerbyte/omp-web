import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `PUT /upload/<token>` — die Byte-Seite des Uploads.
 *
 * Diese Route liegt ausserhalb des Proxy-Matchers, weil der Proxy jeden Body
 * in den Speicher klont. Autorisierung ist deshalb das Einmal-Ticket, und die
 * Tests hier halten genau das fest: ohne Ticket 404, ein zweites PUT mit
 * demselben Token 404, ein zu grosser oder zu kurzer Body 4xx und nichts auf
 * der Platte.
 */

const jiti = createJiti(import.meta.url, {
  root: process.cwd(),
  alias: { "@": process.cwd() },
  interopDefault: true,
});

const route = await jiti.import("./route.ts");
const { mintUploadTicket, takeUploadTicket } = await jiti.import("@/lib/upload-tickets.ts");

const ROOT = mkdtempSync(join(tmpdir(), "omp-web-upload-put-"));

test.after(() => rmSync(ROOT, { recursive: true, force: true }));

/** Ein eigener Zielordner je Test, damit "nichts auf der Platte" messbar bleibt. */
function freshDirectory(t) {
  const directory = mkdtempSync(join(ROOT, "case-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function ticketFor(directory, name, size, replacing = false) {
  return mintUploadTicket({ directory, fileName: name, size, replacing });
}

function put(token, body, headers = {}) {
  return route.PUT(
    new Request(`http://localhost/upload/${token}`, {
      method: "PUT",
      headers: { host: "localhost", ...headers },
      body,
      duplex: "half",
    }),
    { params: Promise.resolve({ token }) },
  );
}

function streamOf(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });
}

test("a body of the declared size lands byte for byte, and the ticket is spent", async (t) => {
  const directory = freshDirectory(t);
  const token = ticketFor(directory, "notes.txt", 5);
  const response = await put(token, "hello");
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { uploaded: ["notes.txt"], skipped: [], errors: [] });
  assert.equal(readFileSync(join(directory, "notes.txt"), "utf8"), "hello");
  assert.deepEqual(readdirSync(directory), ["notes.txt"], "kein Temp-Rest");

  const again = await put(token, "hello");
  assert.equal(again.status, 404, "derselbe Token darf kein zweites Mal schreiben");
});

test("an unknown token is a 404 and writes nothing", async (t) => {
  const directory = freshDirectory(t);
  const response = await put("does-not-exist", "x");
  assert.equal(response.status, 404);
  assert.deepEqual(readdirSync(directory), []);
});

test("a body one byte over the declared size is a 413 and leaves no file behind", async (t) => {
  const directory = freshDirectory(t);
  const token = ticketFor(directory, "big.bin", 4);
  const response = await put(token, streamOf([[1, 2, 3], [4, 5]]));
  assert.equal(response.status, 413);
  assert.deepEqual(readdirSync(directory), [], "weder Ziel noch Temp-Datei");
});

test("a body shorter than declared is a 400 and leaves no file behind", async (t) => {
  const directory = freshDirectory(t);
  const token = ticketFor(directory, "short.bin", 8);
  const response = await put(token, streamOf([[1, 2, 3]]));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /ended after 3 of 8 bytes/);
  assert.deepEqual(readdirSync(directory), []);
});

test("a Content-Length that disagrees with the ticket is refused before any byte", async (t) => {
  const directory = freshDirectory(t);
  const token = ticketFor(directory, "mismatch.bin", 8);
  const response = await put(token, "abcd", { "content-length": "4" });
  assert.equal(response.status, 400);
  assert.deepEqual(readdirSync(directory), []);
});

test("a request from an untrusted host is a 403", async (t) => {
  const directory = freshDirectory(t);
  const token = ticketFor(directory, "foreign.bin", 1);
  const response = await put(token, "x", { host: "evil.example" });
  assert.equal(response.status, 403);
  // The token was not consumed by the rejected request: only a trusted caller
  // gets to spend it.
  assert.equal(takeUploadTicket(token)?.fileName, "foreign.bin");
});

test("an empty file is a legal upload", async (t) => {
  const directory = freshDirectory(t);
  const token = ticketFor(directory, "empty.txt", 0);
  const response = await put(token, streamOf([]));
  assert.equal(response.status, 200);
  assert.equal(readFileSync(join(directory, "empty.txt"), "utf8"), "");
});
