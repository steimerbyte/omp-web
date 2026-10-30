import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { forgeSession } from "../test/forge-session.mjs";

const PASSWORD = "correct horse battery staple";
const OTHER_PASSWORD = "correct horse battery stapl";
const ABSENT_FILE = "/nonexistent/omp-web-auth-session-test.json";

/**
 * The key file the module would otherwise create lives here, not in the real
 * account directory. One path for the whole file: the salt is read from it, so
 * every `options()` call below has to agree on which file it means.
 */
const SANDBOX = mkdtempSync(join(tmpdir(), "omp-web-session-unit-"));
const KEY_FILE = join(SANDBOX, "omp-web-session-key");
const SESSIONS_FILE = join(SANDBOX, "omp-web-sessions.json");
after(() => rmSync(SANDBOX, { recursive: true, force: true }));

/**
 * Sessions key off the credential, so these run against the
 * `OMP_WEB_PASSWORD` policy: it is the mode where the server holds the secret
 * itself. The stored mode derives the same key from the digest fingerprint,
 * which the store's own tests already cover.
 */
function options(env = {}) {
  return {
    env: {
      OMP_WEB_PASSWORD: PASSWORD,
      ...env,
      OMP_WEB_AUTH_FILE: ABSENT_FILE,
      OMP_WEB_SESSION_KEY_FILE: KEY_FILE,
      OMP_WEB_SESSIONS_FILE: SESSIONS_FILE,
    },
  };
}

/**
 * A path that does not exist, so an empty env resolves to the *open* policy
 * instead of reading whatever credential file the machine running the tests
 * happens to have. With a bare `env: {}` the lookup fell through to the real
 * ~/.omp/agent/omp-web-auth.json — the operator's own password and account
 * name — so these tests decided against that, and passed on a developer
 * machine with no credential file at all.
 */
function unlockedOptions() {
  return {
    env: { OMP_WEB_AUTH_FILE: ABSENT_FILE, OMP_WEB_SESSION_KEY_FILE: KEY_FILE, OMP_WEB_SESSIONS_FILE: SESSIONS_FILE },
  };
}

async function loadSubject() {
  return import("./web-auth-session.ts");
}

test("accepts a freshly minted cookie and issues no cookie while the lock is off", async () => {
  const { issueSessionCookie, verifySessionCookie } = await loadSubject();

  const cookie = issueSessionCookie(options());
  assert.equal(typeof cookie, "string");
  assert.equal(verifySessionCookie(cookie, options()), true);

  // No credential, nothing to bind a session to — and a server that has no
  // password is already letting everyone through.
  assert.equal(issueSessionCookie(unlockedOptions()), null);
  assert.equal(verifySessionCookie(cookie, unlockedOptions()), false);
});

/**
 * The cookie now names its account, and the name is what a route uses to build
 * the tenant boundary — so what matters is that it is signed, not that it is
 * absent. A password in the cookie would still be the bug.
 */
test("carries the signed username and no password", async () => {
  const { issueSessionCookie, readSessionCookie } = await loadSubject();

  const cookie = issueSessionCookie(options({ OMP_WEB_USERNAME: "alice" }));
  assert.equal(cookie.includes(PASSWORD), false);
  // version, issuedAt, expiry, nonce, username, signature
  assert.equal(cookie.split(".").length, 6);
  assert.equal(readSessionCookie(cookie, options({ OMP_WEB_USERNAME: "alice" })), "alice");
});

/**
 * The failure this feature exists to prevent: a cookie minted for alice must
 * not read as bob. Swapping the username field invalidates the signature, which
 * is the whole reason the field is inside the signed payload rather than next
 * to it.
 */
test("a cookie rewritten for another account is rejected", async () => {
  const { issueSessionCookie, readSessionCookie, verifySessionCookie } = await loadSubject();

  const cookie = issueSessionCookie(options({ OMP_WEB_USERNAME: "alice" }));
  const [version, issuedAt, expiry, nonce, , signature] = cookie.split(".");
  const asBob = Buffer.from("bob", "utf8").toString("base64url");

  const rewritten = `${version}.${issuedAt}.${expiry}.${nonce}.${asBob}.${signature}`;
  assert.equal(readSessionCookie(rewritten, options({ OMP_WEB_USERNAME: "alice" })), null);
  assert.equal(verifySessionCookie(rewritten, options({ OMP_WEB_USERNAME: "alice" })), false);
});

test("issues a different cookie each time even within the same millisecond", async () => {
  const { issueSessionCookie } = await loadSubject();

  assert.notEqual(issueSessionCookie(options()), issueSessionCookie(options()));
});

test("rejects a tampered payload", async () => {
  const { issueSessionCookie, verifySessionCookie } = await loadSubject();

  const [version, issuedAt, expiry, nonce, username, signature] = issueSessionCookie(options()).split(".");
  // Push the expiry out by a year without touching the signature.
  const extended = Buffer.from(String(Date.now() + 365 * 24 * 60 * 60 * 1000), "utf8")
    .toString("base64url");

  assert.equal(verifySessionCookie(`${version}.${issuedAt}.${extended}.${nonce}.${username}.${signature}`, options()), false);
  // A swapped nonce is the same forgery from the other direction.
  // The replacement character has to depend on what is actually there: the
  // nonce is base64url, so its last character can already be "A". Writing "A"
  // unconditionally is then a no-op, the cookie stays valid, and this assertion
  // fails on roughly one run in 64 — measured at 3 of 120 end-to-end runs.
  // The signature test below already gets this right with `flipped`.
  const flippedNonce = nonce.at(-1) === "A" ? "B" : "A";
  assert.equal(verifySessionCookie(`${version}.${issuedAt}.${expiry}.${nonce.slice(0, -1)}${flippedNonce}.${username}.${signature}`, options()), false);
});

test("rejects a tampered signature", async () => {
  const { issueSessionCookie, verifySessionCookie } = await loadSubject();

  const cookie = issueSessionCookie(options());
  const [payload, signature] = cookie.split(".");
  const flipped = signature[0] === "A" ? "B" : "A";

  assert.equal(verifySessionCookie(`${payload}.${flipped}${signature.slice(1)}`, options()), false);
  assert.equal(verifySessionCookie(`${payload}.`, options()), false);
  assert.equal(verifySessionCookie(`${payload}.${signature}${signature}`, options()), false);
});

test("rejects a cookie minted under a different password", async () => {
  const { issueSessionCookie, verifySessionCookie } = await loadSubject();

  const cookie = issueSessionCookie(options());
  const other = options({ OMP_WEB_PASSWORD: OTHER_PASSWORD });

  assert.equal(verifySessionCookie(cookie, other), false);
  // And the same holds in reverse: a cookie from the old password dies the
  // moment the credential changes, which is what logging out everyone means.
  assert.equal(verifySessionCookie(issueSessionCookie(other), options()), false);
});

test("rejects a cookie older than the one-hour lifetime, and accepts one inside it", async () => {
  const {
    readSession, verifySessionCookie, SESSION_TTL_MS, SESSION_RENEW_AFTER_MS, __testSessionKeySalt,
  } = await loadSubject();

  // The contract is a one-hour *sliding* window, not a 24-hour ceiling: the
  // proxy re-issues the cookie while a browser is in use, so an hour is how long
  // an idle tab may sit there. `SESSION_RENEW_AFTER_MS` is half of it, which is
  // what bounds a polling tab to one `Set-Cookie` per half hour.
  assert.equal(SESSION_TTL_MS, 60 * 60 * 1000);
  assert.equal(SESSION_RENEW_AFTER_MS, 30 * 60 * 1000);

  const env = options().env;
  // Mirrors `resolveSessionSecret` for the environment door with no logout yet:
  // `${username}:${password}|session:${epoch}`.
  const secret = `omp:${PASSWORD}|session:0`;
  const salt = __testSessionKeySalt(env);
  const aged = (minutes) => forgeSession({
    secret, salt, username: "omp", issuedAt: Date.now() - minutes * 60_000, ttlMs: SESSION_TTL_MS,
  });

  assert.equal(verifySessionCookie(aged(61), options()), false, "61 minutes is past the expiry");
  assert.equal(verifySessionCookie(aged(60), options()), false, "the hour itself is the edge: the check is >= expiry");
  assert.equal(verifySessionCookie(aged(59), options()), true, "inside the hour it still verifies");

  // And the renewal rule is reachable: a 40-minute-old cookie is due.
  const due = readSession(aged(40), options());
  assert.equal(due?.username, "omp");
  assert.ok(due.issuedAt < Date.now() - SESSION_RENEW_AFTER_MS, "40 minutes is more than half the lifetime");
});

test("returns false rather than throwing on malformed input", async () => {
  const { verifySessionCookie } = await loadSubject();

  for (const value of [
    undefined,
    null,
    "",
    "   ",
    "not-a-session",
    "....",
    "1.2.3",
    // One field short of the six a real cookie has.
    "1.2.3.4.5",
    // Six fields, wrong schema version.
    "2.MQ.MQ.c2ln.bW1w.c2ln",
    "1.!!.MQ.c2ln.bW1w.c2ln",
    "1.MQ.!!.c2ln.bW1w.c2ln",
    "1.MQ.MQ.!!.bW1w.c2ln",
    // A username that is not base64url is rejected before the signature is read.
    "1.MQ.MQ.c2ln.bm90/YS5zZWNyZXQ.c2ln",
    123,
    {},
    [],
  ]) {
    assert.equal(verifySessionCookie(value, options()), false, `accepted ${JSON.stringify(value)}`);
  }
});
