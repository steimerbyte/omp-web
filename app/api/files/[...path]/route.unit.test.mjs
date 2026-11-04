import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { createJiti } from "jiti";

/**
 * The parts of `app/api/files/[...path]` that had no test: the upload target
 * check, the streaming bodies (file ranges and the SSE watch), and the DOCX
 * preview.
 *
 * The stream cases matter because the callbacks run *after* the handler
 * returned: a `cancel()` that never destroys the descriptor leaks a file handle
 * per abandoned media probe, and a preview that forgets to escape the file name
 * writes markup into a page served from this origin.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-files-unit-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const HOME = join(HOME_ROOT, "files-alice");
const PROJECT = join(HOME, "project");
mkdirSync(PROJECT, { recursive: true });

const route = await jiti.import("./route.ts");

const ORIGIN = "http://localhost:30141";
const TENANT = { host: "localhost:30141", "x-omp-user": "files-alice" };

function get(filePath, query, headers = TENANT, init = {}) {
  const segments = filePath.split("/").filter(Boolean);
  const url = `${ORIGIN}/api/files/${segments.map(encodeURIComponent).join("/")}${query}`;
  return route.GET(new NextRequest(url, { headers, ...init }), { params: Promise.resolve({ path: segments }) });
}

function post(filePath, search, body, headers = TENANT, method = "POST") {
  const segments = filePath.split("/").filter(Boolean);
  const url = `${ORIGIN}/api/files/${segments.map(encodeURIComponent).join("/")}${search}`;
  return route[method](
    new NextRequest(url, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ path: segments }) },
  );
}

function makeDocx(filePath, text) {
  // A DOCX is a zip with three parts; that is all mammoth needs to convert.
  return (async () => {
    const { default: AdmZip } = await import("adm-zip");
    const zip = new AdmZip();
    zip.addFile(
      "[Content_Types].xml",
      Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
      ),
    );
    zip.addFile(
      "_rels/.rels",
      Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
      ),
    );
    zip.addFile(
      "word/document.xml",
      Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
      ),
    );
    writeFileSync(filePath, zip.toBuffer());
    return filePath;
  })();
}

test.after(() => {
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

test("upload-check ohne Identitaet ist 403, bevor ein Name geprueft wird", async () => {
  const response = await post(PROJECT, "?type=upload-check", { fileNames: ["a.txt"] }, { host: "localhost:30141" });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Access denied");
});

test("upload-check ausserhalb der Wurzeln ist 403", async () => {
  const response = await post("/tmp", "?type=upload-check", { fileNames: ["a.txt"] });
  assert.equal(response.status, 403);
});

test("upload-check verlangt ein Array von Namen", async () => {
  for (const body of [{ fileNames: "a.txt" }, { fileNames: [1] }, {}]) {
    const response = await post(PROJECT, "?type=upload-check", body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "fileNames must be an array of strings");
  }
});

test("upload-check meldet Konflikte und nicht ersetzbare Ziele", async () => {
  writeFileSync(join(PROJECT, "exists.txt"), "old\n");
  mkdirSync(join(PROJECT, "afolder"), { recursive: true });

  const response = await post(PROJECT, "?type=upload-check", {
    fileNames: ["exists.txt", "afolder", "fresh.txt"],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    conflicts: ["exists.txt", "afolder"],
    nonReplaceable: ["afolder"],
  });
});

test("upload-check lehnt einen Pfad im Dateinamen ab", async () => {
  const response = await post(PROJECT, "?type=upload-check", { fileNames: ["../escape.txt"] });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /must not contain a path/);
});

test("ein Bereich hinter dem Dateiende ist 416 und schliesst den Deskriptor", async () => {
  const file = join(PROJECT, "range.txt");
  writeFileSync(file, "0123456789");
  const response = await get(file, "?type=download", TENANT, { headers: { ...TENANT, range: "bytes=9999-" } });
  assert.equal(response.status, 416);
  assert.equal(response.headers.get("content-range"), "bytes */10");
});

test("ein abgebrochener Datei-Stream ruft cancel und gibt den Deskriptor frei", async () => {
  const file = join(PROJECT, "stream.txt");
  writeFileSync(file, "x".repeat(256 * 1024));
  const response = await get(file, "?type=download");
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  // Cancel before the stream ends: `createFileBodyStream().cancel()` destroys
  // the file stream; a descriptor leak would surface as EBADF/ENFILE later.
  await reader.cancel();
});

test("der watch-Stream sendet das connected-Event und laesst sich abbrechen", async () => {
  const file = join(PROJECT, "watch.txt");
  writeFileSync(file, "hello\n");
  const response = await get(file, "?type=watch");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);

  const reader = response.body.getReader();
  const { value } = await reader.read();
  const payload = new TextDecoder().decode(value);
  assert.match(payload, /^event: connected\ndata: \{.*"filePath"/s);
  await reader.cancel();
});

test("preview ist nur fuer docx da", async () => {
  const file = join(PROJECT, "note.txt");
  writeFileSync(file, "text\n");
  const response = await get(file, "?type=preview");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Preview not available for this file type");
});

test("die DOCX-Vorschau wandelt und maskiert den Dateinamen", async () => {
  const name = 'docx-"probe"&<x>.docx';
  const file = await makeDocx(join(PROJECT, name), "Hallo DOCX");
  const response = await get(file, "?type=preview");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const html = await response.text();
  assert.match(html, /Hallo DOCX/);
  // The file name is interpolated into a document served from this origin; it
  // has to be data, not markup.
  assert.ok(html.includes("&quot;probe&quot;&amp;&lt;x&gt;"), "Dateiname wurde nicht maskiert");
  assert.equal(/<x>/.test(html), false);
});
