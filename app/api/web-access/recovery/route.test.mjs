import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * OMP-017: `/api/web-access/recovery` is public, reads its body before it
 * asks the store anything, and had no ceiling of its own. Above 4 KiB the
 * route now answers 413 before `getWebAccessStatus` or any action runs, so no
 * recovery code can be minted from a body worth buffering.
 *
 * The fixture streams one 1-KiB chunk repeatedly and never holds a large body.
 */

const require = createRequire(import.meta.url);
const store = require("../../../../bin/web-auth-store.js");

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");
const { MAX_CREDENTIAL_REQUEST_BODY_BYTES } = await jiti.import("@/lib/web-access-body.ts");

const ORIGIN = "http://localhost:30141";
const PASSWORD = "a-long-enough-password";

function withStore(t, run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-recovery-body-limit-"));
  const keys = ["OMP_WEB_PASSWORD", "OMP_WEB_SECRETS_FILE", "OMP_WEB_AUTH_FILE"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  delete process.env.OMP_WEB_PASSWORD;
  process.env.OMP_WEB_SECRETS_FILE = join(dir, "omp-web.env");
  process.env.OMP_WEB_AUTH_FILE = join(dir, "omp-web-auth.json");

  t.after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  store.setWebPassword(PASSWORD, {
    file: process.env.OMP_WEB_AUTH_FILE,
    env: {},
    params: { cost: 16, keyLength: 32 },
  });
  return run({ dir });
}

function makeRequest(body, extraHeaders = {}) {
  return new Request(`${ORIGIN}/api/web-access/recovery`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body,
    duplex: "half",
  });
}

function post(body, extraHeaders = {}) {
  return POST(makeRequest(body, extraHeaders));
}

/** One 1-KiB chunk enqueued repeatedly; the fixture never holds the whole body. */
function streamedBody(totalBytes) {
  const chunk = new Uint8Array(1024).fill(0x20);
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
}

/**
 * A request that records any read of its body stream. Bun pulls one chunk of a
 * Request body on its own, so a pull counter cannot tell the route's `getReader`
 * apart from the runtime's pump; shadowing the `body` getter measures exactly
 * the access `readJsonBodyWithinLimit` would make.
 */
function requestWithBodyProbe(body, extraHeaders = {}) {
  const request = makeRequest(body, extraHeaders);
  const state = { reads: 0 };
  Object.defineProperty(request, "body", {
    configurable: true,
    get() {
      state.reads += 1;
      return null;
    },
  });
  return { request, reads: () => state.reads };
}

function complete() {
  return post(JSON.stringify({ action: "complete", code: "000000", password: PASSWORD }));
}

test("ein chunked Body ueber dem Deckel bekommt 413 und mintet keinen Code", async (t) => {
  await withStore(t, async () => {
    const request = makeRequest(streamedBody(MAX_CREDENTIAL_REQUEST_BODY_BYTES + 1024));
    assert.equal(request.headers.get("content-length"), null, "Fixture ist nicht chunked");
    assert.match(request.headers.get("content-type"), /application\/json/);

    const response = await POST(request);

    assert.equal(response.status, 413, `erwartet 413, bekam ${response.status}`);

    // Had the oversized body been parsed and dispatched, a recovery code would
    // be pending and this would be 403 invalid-code instead of 409 no-code.
    const followUp = await complete();
    assert.equal(followUp.status, 409);
    assert.deepEqual(await followUp.json(), { error: "No recovery code is pending. Request one first." });
  });
});

test("ein normaler Body erreicht weiterhin die Aktionspruefung", async (t) => {
  await withStore(t, async () => {
    const response = await complete();
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "No recovery code is pending. Request one first." });
  });
});

test("ein deklarierter Riesen-Body bekommt 413, ohne dass der Strom gelesen wird", async (t) => {
  await withStore(t, async () => {
    const { request, reads } = requestWithBodyProbe(streamedBody(128), {
      "content-length": String(MAX_CREDENTIAL_REQUEST_BODY_BYTES + 1),
    });
    const response = await POST(request);

    assert.equal(response.status, 413, `erwartet 413, bekam ${response.status}`);
    assert.equal(reads(), 0, "der Body wurde trotz Content-Length angefasst");

    const payload = await response.json();
    assert.deepEqual(payload, { error: "Request body is too large" });
    assert.doesNotMatch(JSON.stringify(payload), /password|code|account|store|state/i);
  });
});

test("ein kaputtes JSON bleibt 400", async (t) => {
  await withStore(t, async () => {
    const response = await post("{");
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Expected a JSON body" });
  });
});
