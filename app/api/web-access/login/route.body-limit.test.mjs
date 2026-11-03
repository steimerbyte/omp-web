import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * OMP-017: the public login route reads its body before `verifyCredential`, so
 * an unauthenticated caller could make the server buffer up to the proxy's
 * 104-MB clone. The route now answers with 413 above its own 4-KiB cap and
 * does that before any credential work.
 *
 * `crypto.scryptSync` is patched so a verification cannot hide behind the
 * 150-ms failure pause: every failed `verifyCredential` pays exactly one
 * scrypt call (OMP-020), so zero calls proves the oversized body never reached
 * it. The fixture streams one 1-KiB chunk repeatedly and never holds a body
 * worth buffering.
 */

const require = createRequire(import.meta.url);
const crypto = require("node:crypto");
const store = require("../../../../bin/web-auth-store.js");

const scryptCalls = [];
const originalScryptSync = crypto.scryptSync;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");
const { MAX_CREDENTIAL_REQUEST_BODY_BYTES } = await jiti.import("@/lib/web-access-body.ts");

const HOST = "localhost:30141";
const ORIGIN = `http://${HOST}`;
const ACCOUNT_PASSWORD = "a-long-enough-password";

function withAccount(t, run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-login-body-limit-"));
  const keys = [
    "OMP_WEB_PASSWORD", "OMP_WEB_ADMINS", "OMP_WEB_AUTH_FILE", "OMP_WEB_ACCOUNTS_FILE",
    "OMP_WEB_HOME_ROOT", "OMP_WEB_SESSION_KEY_FILE", "OMP_WEB_SESSIONS_FILE",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  process.env.OMP_WEB_ADMINS = "omp";
  delete process.env.OMP_WEB_PASSWORD;
  process.env.OMP_WEB_AUTH_FILE = join(dir, "omp-web-auth.json");
  process.env.OMP_WEB_ACCOUNTS_FILE = join(dir, "omp-web-accounts.json");
  process.env.OMP_WEB_HOME_ROOT = join(dir, "home");
  process.env.OMP_WEB_SESSION_KEY_FILE = join(dir, "session-key");
  process.env.OMP_WEB_SESSIONS_FILE = join(dir, "sessions.json");
  mkdirSync(process.env.OMP_WEB_HOME_ROOT, { recursive: true, mode: 0o700 });

  crypto.scryptSync = function patched(secret, salt, keylen, options) {
    scryptCalls.push({ secret, salt });
    return originalScryptSync.call(this, secret, salt, keylen, options);
  };

  t.after(() => {
    crypto.scryptSync = originalScryptSync;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  // The account digest itself is a scrypt call; count only request work.
  store.createWebAccount("alice", ACCOUNT_PASSWORD);
  scryptCalls.length = 0;
  return run({ dir });
}

function login(body) {
  return POST(new Request(`${ORIGIN}/api/web-access/login`, {
    method: "POST",
    headers: { host: HOST, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
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

function makeRequest(body, extraHeaders = {}) {
  return new Request(`${ORIGIN}/api/web-access/login`, {
    method: "POST",
    headers: { host: HOST, "content-type": "application/json", ...extraHeaders },
    body,
    duplex: "half",
  });
}

/**
 * A request that records any read of its body stream. Bun pulls one chunk of a
 * Request body on its own, so a pull counter cannot tell the route's `getReader`
 * apart from the runtime's pump; shadowing the `body` getter measures exactly
 * the access `readJsonBodyWithinLimit` would make.
 */
function withBodyProbe(request) {
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

function post(body, extraHeaders = {}) {
  return POST(makeRequest(body, extraHeaders));
}

test("ein chunked Body ueber dem Deckel bekommt 413, bevor verifyCredential laeuft", async (t) => {
  await withAccount(t, async () => {
    const request = makeRequest(streamedBody(MAX_CREDENTIAL_REQUEST_BODY_BYTES + 1024));
    assert.equal(request.headers.get("content-length"), null, "Fixture ist nicht chunked");

    const response = await POST(request);

    assert.equal(response.status, 413, `erwartet 413, bekam ${response.status}`);
    assert.equal(response.headers.getSetCookie().length, 0, "eine abgelehnte Anfrage setzt keinen Cookie");
    assert.equal(scryptCalls.length, 0, "verifyCredential lief fuer einen ungeparsten Body");
  });
});

test("ein deklarierter Riesen-Body bekommt 413, ohne dass der Strom gelesen wird", async (t) => {
  await withAccount(t, async () => {
    const { request, reads } = withBodyProbe(makeRequest(streamedBody(128), {
      "content-length": String(MAX_CREDENTIAL_REQUEST_BODY_BYTES + 1),
    }));
    const response = await POST(request);

    assert.equal(response.status, 413, `erwartet 413, bekam ${response.status}`);
    assert.equal(reads(), 0, "der Body wurde trotz Content-Length angefasst");
    assert.equal(scryptCalls.length, 0);
  });
});

test("ein normales Login funktioniert weiter und die 413-Antwort nennt kein Konto", async (t) => {
  await withAccount(t, async () => {
    const ok = await login({ username: "alice", password: ACCOUNT_PASSWORD });
    assert.equal(ok.status, 200, `erwartet 200, bekam ${ok.status}`);
    assert.equal((await ok.json()).user.username, "alice");
    assert.equal(ok.headers.getSetCookie().length, 1);

    // Wrong password, an ordinary bad input: 401 and one paid verification.
    scryptCalls.length = 0;
    const wrong = await login({ username: "alice", password: "wrong-password" });
    assert.equal(wrong.status, 401);
    assert.equal(scryptCalls.length, 1, "die scrypt-Sonde muss greifen");

    const tooLarge = await post(streamedBody(MAX_CREDENTIAL_REQUEST_BODY_BYTES + 1024));
    assert.equal(tooLarge.status, 413);
    const payload = await tooLarge.json();
    assert.deepEqual(payload, { error: "Request body is too large" });
    assert.doesNotMatch(
      JSON.stringify(payload),
      /alice|unknown|password|account|disabled|exists/i,
      "die 413-Antwort verraet Konto oder Zustand",
    );
  });
});

test("ein kaputtes JSON bleibt 400", async (t) => {
  await withAccount(t, async () => {
    const response = await post("{");
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Expected a JSON body" });
  });
});
