import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

/**
 * The key file is the difference between "a restart is a logout" and a session
 * that survives the ~10 restarts the live unit performs per day. These tests
 * reach across *processes*, because that is the only way to observe the
 * property: a second import in the same process would share the memoized salt
 * and prove nothing.
 */

const PASSWORD = "correct horse battery staple";
const ABSENT_FILE = "/nonexistent/omp-web-session-key-test.json";
const MODULE_URL = new URL("../lib/web-auth-session.ts", import.meta.url).href;

const SANDBOX = mkdtempSync(join(tmpdir(), "omp-web-session-key-"));
after(() => rmSync(SANDBOX, { recursive: true, force: true }));

/**
 * A second Bun process, because `process.execPath` is the bun binary running
 * this suite — no assumption about PATH.
 *
 * `mint` prints a cookie; `verify` prints "true" or "false" for the cookie it
 * was given. The env is built from scratch: inheriting the developer's
 * `OMP_WEB_*` would make a failure depend on the machine.
 */
const SCRIPT = join(SANDBOX, "child.mjs");
writeFileSync(SCRIPT, [
  `const [mode, cookie] = process.argv.slice(2);`,
  `const mod = await import(${JSON.stringify(MODULE_URL)});`,
  `if (mode === "mint") process.stdout.write(mod.issueSessionCookie({ env: process.env }) ?? "null");`,
  `else process.stdout.write(String(mod.verifySessionCookie(cookie, { env: process.env })));`,
  "",
].join("\n"));

function child(mode, cookie, env) {
  const result = Bun.spawnSync([process.execPath, SCRIPT, mode, ...(cookie ? [cookie] : [])], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.equal(result.exitCode, 0, `child failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

function envFor(dir, overrides = {}) {
  return {
    OMP_WEB_PASSWORD: PASSWORD,
    OMP_WEB_AUTH_FILE: ABSENT_FILE,
    OMP_WEB_SESSION_KEY_FILE: join(dir, "omp-web-session-key"),
    OMP_WEB_SESSIONS_FILE: join(dir, "omp-web-sessions.json"),
    ...overrides,
  };
}

function freshDir(name) {
  const dir = join(SANDBOX, name);
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

test("der Schluessel liegt als 0600-Datei neben dem Credential und wird nicht ueberschrieben", async () => {
  const dir = freshDir("mode");
  const env = envFor(dir);

  const cookie = child("mint", null, env);
  assert.match(cookie, /^1\./, "ein Kind-Prozess stellt einen Cookie aus");

  const file = env.OMP_WEB_SESSION_KEY_FILE;
  assert.equal(statSync(file).mode & 0o777, 0o600, "nur der Dienstbenutzer darf den Schluessel lesen");
  assert.ok(readFileSync(file, "utf8").trim().length >= 32, "der Schluessel steht in der Datei");

  // A second process must adopt the file, not replace it: the whole point is
  // that the salt outlives the process.
  const before = readFileSync(file, "utf8");
  child("mint", null, env);
  assert.equal(readFileSync(file, "utf8"), before, "ein zweiter Start schreibt den Schluessel nicht neu");
});

test("ein Cookie ueberlebt einen Prozess-Neustart, wenn die Schluesseldatei bleibt", () => {
  const dir = freshDir("restart");
  const env = envFor(dir);

  const first = child("mint", null, env);
  // Prozess 2: frisches Kind, gleiche Datei, gleiches Passwort. Vor dieser
  // Änderung war das ein 401, weil jeder Kaltstart einen neuen Salt zog.
  assert.equal(child("verify", first, env), "true", "der Cookie aus Prozess 1 gilt in Prozess 2");
});

test("eine andere Schluesseldatei macht den Cookie ungueltig", () => {
  const env = envFor(freshDir("key-a"));
  const other = envFor(freshDir("key-b"));

  const cookie = child("mint", null, env);
  assert.equal(child("verify", cookie, other), "false", "der Salt ist die Bindung, nicht der Cookie");
});

test("OMP_WEB_SESSION_KEY_EPHEMERAL=1 ist der Ausstieg: Neustart meldet wieder ab", () => {
  const dir = freshDir("ephemeral");
  const env = envFor(dir, { OMP_WEB_SESSION_KEY_EPHEMERAL: "1" });

  const cookie = child("mint", null, env);
  assert.equal(child("verify", cookie, env), "false", "ephemeral heisst: kein Cookie ueberlebt den Prozess");
  assert.throws(() => statSync(env.OMP_WEB_SESSION_KEY_FILE), "und es entsteht keine Datei");
  // Mit dem Schalter aus gilt derselbe Cookie wieder nicht — er wurde unter
  // einem anderen Salt signiert als dem aus der Datei.
  assert.equal(child("verify", cookie, envFor(dir)), "false");
});
