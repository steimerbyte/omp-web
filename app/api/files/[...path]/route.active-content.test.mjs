import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { createJiti } from "jiti";

/**
 * `?type=read` darf aktive Inhalte nicht als Dokument in dieser Origin
 * ausliefern.
 *
 * OMP-009: eine SVG-Datei kam mit `Content-Disposition: inline`, ohne CSP und
 * ohne `nosniff` an, und Headless-Chrome fuehrte das `<script>` darin aus —
 * `fetch('/api/whoami')` antwortete mit den Cookies der Sitzung. Der Test misst
 * die Antwort-Header, weil genau sie darueber entscheiden, ob der Browser die
 * Datei als Dokument rendert oder als Download behandelt. Rasterbilder muessen
 * inline bleiben, sonst verliert die Vorschau ihr normales Bild.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-active-content-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const HOME = join(HOME_ROOT, "alice");
mkdirSync(HOME, { recursive: true });

const filesRoute = await jiti.import("./route.ts");
// An explicit grant, like the other route tests: the account home is normally a
// root via `OMP_WEB_HOME_ROOT`, but that variable is process-wide and another
// test file in the same run may repoint it. The grant keeps this fixture
// readable without relying on file order.
const { allowFileRoot } = await jiti.import("@/lib/file-access");
allowFileRoot(HOME, { username: "alice", isAdmin: false });

const ORIGIN = "http://localhost:30141";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>document.title="SVG-EXEC:pi"</script></svg>';
/** Smallest valid PNG: signature + IHDR/IDAT/IEND, decoders only need the header here. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082",
  "hex",
);

function write(name, bytes) {
  const filePath = join(HOME, name);
  writeFileSync(filePath, bytes);
  return filePath;
}

function request(filePath, type, headers = {}) {
  const segments = filePath.split("/").filter(Boolean);
  const url = `${ORIGIN}/api/files/${segments.map(encodeURIComponent).join("/")}?type=${type}`;
  return filesRoute.GET(
    new NextRequest(url, {
      headers: { host: "localhost:30141", "x-omp-user": "alice", ...headers },
    }),
    { params: Promise.resolve({ path: segments }) },
  );
}

test.after(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

test("eine SVG-Datei kommt als Anhang mit sandbox-CSP und nosniff", async () => {
  const filePath = write("evil.svg", SVG);

  const response = await request(filePath, "read");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/svg+xml");
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /^attachment;/,
    "an active document must not be navigated to inline",
  );
  assert.equal(response.headers.get("content-security-policy"), "sandbox; default-src 'none'");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await response.text(), SVG, "the bytes are still served, just not as a document");
});

test("ein Rasterbild bleibt inline und ohne aktive-Content-Header", async () => {
  const filePath = write("pixel.png", PNG);

  const response = await request(filePath, "read");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.match(response.headers.get("content-disposition") ?? "", /^inline;/);
  assert.equal(response.headers.get("content-security-policy"), null);
  assert.equal(response.headers.get("x-content-type-options"), null);
  // The bytes come from the authorized descriptor; a stream that lost the fd
  // would fail here rather than in a browser.
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);

  const ranged = await request(filePath, "read", { range: "bytes=0-3" });
  assert.equal(ranged.status, 206);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), PNG.subarray(0, 4));
});

test("ein Symlink innerhalb der Home bleibt lesbar", async () => {
  const target = write("notes.txt", "inside the home");
  const link = join(HOME, "notes-link.txt");
  symlinkSync(target, link);

  const response = await request(link, "read");

  assert.equal(response.status, 200);
  assert.equal((await response.json()).content, "inside the home");
});
