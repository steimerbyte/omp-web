import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * What `POST /api/files/**?type=upload` does with a body that is too large.
 *
 * The contract these tests pin was measured against the transport, not guessed:
 * Next does **not** refuse an oversized body. It ends its body clone silently
 * once `experimental.proxyClientMaxBodySize` is passed
 * (`next/dist/server/body-streams.js`, `cloneBodyStream`), so the handler reads
 * a body that stops in the middle of a part. On the old 32 MB ceiling a 40 MB
 * multipart upload answered HTTP 500 `FormData parse error missing final
 * boundary` — the wrong status, from the wrong layer, with a message that says
 * nothing about the file.
 *
 * Two outcomes are therefore asserted here, and both are 4xx with no file on
 * disk:
 *
 *  1. a body over the route's own limit is refused by the route (413), and
 *  2. a body that arrived short of its declared length — which is exactly what
 *     a cut clone looks like from inside the handler — is refused as 413 rather
 *     than surfacing as a parse error and a 500.
 *
 * The third test is the control: an upload inside the limit still lands, byte
 * for byte. Without it a route that refused everything would pass the first two.
 */

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-upload-limit-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;
process.env.PI_CODING_AGENT_DIR = join(HOME_ROOT, ".agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

const jiti = createJiti(import.meta.url, {
  root: process.cwd(),
  alias: { "@": process.cwd() },
  interopDefault: true,
});

const route = await jiti.import("./[...path]/route.ts");
const { NextRequest } = await jiti.import("next/server");
const {
  MAX_UPLOAD_REQUEST_BYTES,
  MAX_UPLOAD_TOTAL_BYTES,
} = await jiti.import("@/lib/file-upload.ts");
const { readConfiguredProxyBodyLimit } = await import("../../../test/proxy-body-limit.mjs");

const TENANT = "upload-limits-tenant";
const UPLOAD_DIR = join(HOME_ROOT, TENANT, "uploads");
mkdirSync(UPLOAD_DIR, { recursive: true });

test.after(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

const BOUNDARY = "omp-web-upload-limit-boundary";

/** One file, as a complete multipart body. */
function multipartBody(fileName, bytes) {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\n`
      + `Content-Disposition: form-data; name="files"; filename="${fileName}"\r\n`
      + "Content-Type: application/octet-stream\r\n\r\n",
    ),
    bytes,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

function uploadRequest(body, { declared = body.length } = {}) {
  return new NextRequest(`http://localhost/api/files${UPLOAD_DIR}?type=upload&conflict=error`, {
    method: "POST",
    headers: {
      host: "localhost",
      "x-omp-user": TENANT,
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      "content-length": String(declared),
    },
    body,
  });
}

function callUpload(request) {
  return route.POST(request, { params: Promise.resolve({ path: UPLOAD_DIR.slice(1).split("/") }) });
}

test("the proxy ceiling sits strictly above the route's own request limit", () => {
  // This is the construction that makes truncation unreachable: any body the
  // route accepts is smaller than the ceiling above which Next cuts the clone.
  // Asserted here as well as in `lib/file-upload.test.mjs`, because it is the
  // premise of both other tests in this file — if it ever inverts, they would
  // still pass while the deployed behaviour was the old 500.
  const configured = readConfiguredProxyBodyLimit();
  assert.ok(
    MAX_UPLOAD_REQUEST_BYTES < configured,
    `the route's ${MAX_UPLOAD_REQUEST_BYTES} byte limit must sit below the ${configured} byte proxy ceiling`,
  );
});

test("a body over the route limit is a 413 with the route's own message, and writes nothing", async () => {
  const bytes = Buffer.alloc(64);
  const body = multipartBody("too-big.bin", bytes);

  // Declared, not delivered: the early check must fire on the header alone, so
  // this test costs no memory and no transfer.
  const response = await callUpload(uploadRequest(body, { declared: MAX_UPLOAD_REQUEST_BYTES + 1 }));

  assert.equal(response.status, 413);
  const payload = await response.json();
  assert.equal(payload.error, `Uploads must total ${MAX_UPLOAD_TOTAL_BYTES / (1024 * 1024)}MB or less`);
  assert.deepEqual(readdirSync(UPLOAD_DIR), [], "a refused upload must leave no file behind");
});

test("a body cut short of its declared length is a 413, not a 500", async () => {
  // The clone-cut shape: the client declared a complete 40 MB body, the route's
  // own limit is far above that so nothing rejects it early, and the transport
  // delivered less. Before the fix this reached the multipart parser and came
  // out of the route's outer catch as a 500.
  const bytes = Buffer.alloc(1024, 7);
  const body = multipartBody("cut.bin", bytes);
  const declared = 40 * 1024 * 1024;
  assert.ok(declared > body.length, "precondition: fewer bytes arrive than were declared");
  assert.ok(declared < MAX_UPLOAD_REQUEST_BYTES, "precondition: the route's own limit does not fire first");

  const response = await callUpload(uploadRequest(body, { declared }));

  assert.equal(response.status, 413, `expected 413, got ${response.status}: ${await response.clone().text()}`);
  const payload = await response.json();
  assert.match(payload.error, /exceeded the 101MB transport limit/);
  assert.match(payload.error, new RegExp(`${body.length} of ${declared} bytes`));
  assert.deepEqual(readdirSync(UPLOAD_DIR), [], "a truncated upload must leave no file behind");
});

test("an upload inside the limit is stored byte for byte", async () => {
  // The control. A guard that refused every upload would satisfy both tests
  // above and be worthless.
  const bytes = Buffer.from("omp-web upload control payload\n".repeat(4096));
  const body = multipartBody("control.bin", bytes);

  const response = await callUpload(uploadRequest(body));

  assert.equal(response.status, 200, `expected 200, got ${response.status}: ${await response.clone().text()}`);
  const payload = await response.json();
  assert.deepEqual(payload, { uploaded: ["control.bin"], skipped: [], errors: [] });

  const stored = readFileSync(join(UPLOAD_DIR, "control.bin"));
  assert.equal(stored.length, bytes.length);
  assert.equal(
    createHash("sha256").update(stored).digest("hex"),
    createHash("sha256").update(bytes).digest("hex"),
    "the stored file must be identical to what was sent",
  );
});
