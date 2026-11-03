import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * OMP-020: die Login-Antwort darf nicht verraten, ob ein Kontoname existiert.
 *
 * Gemessen war der Unterschied die scrypt-Verzweigung: ein existierender Name
 * bezahlte sie, ein unbekannter nicht (36,06 ms gegen 0,10 ms in
 * `verifyCredential`), und die 150-ms-Pause der Route deckte das nicht zu.
 *
 * Der Test misst deshalb nicht die Uhr, sondern die teure primitive Operation
 * selbst: `crypto.scryptSync` wird ersetzt, und jeder Fehlversuch muss genau
 * einen Aufruf ausloesen — gegen das echte Konto-Digest bzw. gegen denselben
 * festen Dummy-Digest. Der Patch sitzt auf dem eingebauten Modul, damit er
 * unabhaengig davon greift, welche Modulkopie Store und Route geladen haben.
 */

const require = createRequire(import.meta.url);
const crypto = require("node:crypto");
const store = require("../../../../bin/web-auth-store.js");

const scryptCalls = [];
const originalScryptSync = crypto.scryptSync;
crypto.scryptSync = function patched(secret, salt, keylen, options) {
  scryptCalls.push({ secret, salt: Buffer.isBuffer(salt) ? Buffer.from(salt) : salt });
  return originalScryptSync.call(this, secret, salt, keylen, options);
};

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");

const HOST = "localhost:30141";
const ORIGIN = `http://${HOST}`;
const ACCOUNT_PASSWORD = "a-long-enough-password";

function login(username, password) {
  return POST(new Request(`${ORIGIN}/api/web-access/login`, {
    method: "POST",
    headers: { host: HOST, "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  }));
}

test("unbekannter, deaktivierter und existierender Name zahlen dieselbe scrypt-Pruefung", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-login-equal-"));
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

  t.after(() => {
    crypto.scryptSync = originalScryptSync;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const alice = store.createWebAccount("alice", ACCOUNT_PASSWORD);
  store.createWebAccount("carol", ACCOUNT_PASSWORD);
  store.setWebAccountEnabled("carol", false);
  const aliceSalt = Buffer.from(alice.password.salt, "base64");

  /** Die scrypt-Aufrufe waehrend eines Requests. */
  async function attempt(username) {
    scryptCalls.length = 0;
    const response = await login(username, "wrong-password");
    const calls = scryptCalls.splice(0);
    return { response, calls, body: await response.json() };
  }

  const known = await attempt("alice");
  const unknown = await attempt("nobody");
  const disabled = await attempt("carol");

  assert.equal(known.response.status, 401);
  assert.equal(unknown.response.status, 401);
  assert.equal(disabled.response.status, 401);
  // Dieselbe generische Antwort auf allen drei Wegen.
  assert.deepEqual(known.body, unknown.body);
  assert.deepEqual(unknown.body, disabled.body);

  // Existierender Name: genau eine scrypt-Rechnung, gegen sein echtes Salz.
  assert.equal(known.calls.length, 1, "existing account: one scrypt verification");
  assert.deepEqual(known.calls[0].salt, aliceSalt);

  // Unbekannter und deaktivierter Name: ebenfalls genau eine scrypt-Rechnung.
  // Frueher waren es null — der Zeitunterschied, den OMP-020 beschreibt.
  assert.equal(unknown.calls.length, 1, "unknown account: one scrypt verification against the dummy digest");
  assert.equal(disabled.calls.length, 1, "disabled account: one scrypt verification against the dummy digest");

  // Beide laufen gegen denselben Dummy, nicht gegen ein echtes Konto.
  assert.notDeepEqual(unknown.calls[0].salt, aliceSalt);
  assert.deepEqual(unknown.calls[0].salt, disabled.calls[0].salt, "same dummy digest for both");
});
