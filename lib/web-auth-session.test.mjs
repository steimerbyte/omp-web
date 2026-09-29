import assert from "node:assert/strict";
import { createHmac, scryptSync } from "node:crypto";
import test from "node:test";

const PASSWORD = "correct horse battery staple";
const OTHER_PASSWORD = "correct horse battery stapl";
const TTL_MS = 8 * 60 * 60 * 1000;

/**
 * Sessions key off the credential, so these run against the
 * `OMP_WEB_PASSWORD` policy: it is the mode where the server holds the secret
 * itself. The stored mode derives the same key from the digest fingerprint,
 * which the store's own tests already cover.
 */
function options(env = {}) {
  return { env: { OMP_WEB_PASSWORD: PASSWORD, ...env } };
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
  assert.equal(issueSessionCookie({ env: {} }), null);
  assert.equal(verifySessionCookie(cookie, { env: {} }), false);
});

test("carries no user data and nothing password-shaped in the cookie", async () => {
  const { issueSessionCookie } = await loadSubject();

  const cookie = issueSessionCookie(options());
  assert.equal(cookie.includes(PASSWORD), false);
  // version, issuedAt, expiry, nonce, signature
  assert.equal(cookie.split(".").length, 5);
});

test("issues a different cookie each time even within the same millisecond", async () => {
  const { issueSessionCookie } = await loadSubject();

  assert.notEqual(issueSessionCookie(options()), issueSessionCookie(options()));
});

test("rejects a tampered payload", async () => {
  const { issueSessionCookie, verifySessionCookie } = await loadSubject();

  const [version, issuedAt, expiry, nonce, signature] = issueSessionCookie(options()).split(".");
  // Push the expiry out by a year without touching the signature.
  const extended = Buffer.from(String(Date.now() + 365 * 24 * 60 * 60 * 1000), "utf8")
    .toString("base64url");

  assert.equal(verifySessionCookie(`${version}.${issuedAt}.${extended}.${nonce}.${signature}`, options()), false);
  // A swapped nonce is the same forgery from the other direction.
  assert.equal(verifySessionCookie(`${version}.${issuedAt}.${expiry}.${nonce.slice(0, -1)}A.${signature}`, options()), false);
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

test("rejects a cookie past its expiry", async () => {
  const { issueSessionCookie, verifySessionCookie, SESSION_TTL_MS, __testKeySalt } = await loadSubject();

  assert.equal(SESSION_TTL_MS, TTL_MS);

  const [version, issuedAt, , nonce] = issueSessionCookie(options()).split(".");

  /** A correctly signed cookie that expired at `at`, forged because a real one
   *  cannot be waited out in a test. */
  const expiringAt = (at) => {
    const payload = `${version}.${issuedAt}.${Buffer.from(String(at), "utf8").toString("base64url")}.${nonce}`;
    // The session key is derived from the (username, password) pair plus the
    // process's boot salt. Pull the salt from the module so the forge lines
    // up with what the production code derives — and so this test still works
    // after the salt became random per process.
    const key = scryptSync(`omp:${PASSWORD}`, __testKeySalt, 64, { N: 16384, r: 8, p: 1 });
    return `${payload}.${createHmac("sha256", key).update(payload, "utf8").digest("base64url")}`;
  };

  assert.equal(verifySessionCookie(expiringAt(Date.now() - 1), options()), false);
  // One millisecond ahead is still inside the window, which shows the rejection
  // above is the expiry and not a broken forge.
  assert.equal(verifySessionCookie(expiringAt(Date.now() + 60_000), options()), true);
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
    "1.2.3.4.5.6",
    "2.MQ.MQ.c2ln.bm90LWEtc2lnbmF0dXJl",
    "1.!!.MQ.c2ln.bm90LWEtc2lnbmF0dXJl",
    "1.MQ.!!.c2ln.bm90LWEtc2lnbmF0dXJl",
    "1.MQ.MQ.!!.bm90LWEtc2lnbmF0dXJl",
    123,
    {},
    [],
  ]) {
    assert.equal(verifySessionCookie(value, options()), false, `accepted ${JSON.stringify(value)}`);
  }
});

test("rejects a cookie minted for a different configured username", async () => {
  const { issueSessionCookie, verifySessionCookie } = await loadSubject();

  const aliceCookie = issueSessionCookie(options({ OMP_WEB_USERNAME: "alice" }));
  const bobOptions = options({ OMP_WEB_USERNAME: "bob" });

  assert.equal(typeof aliceCookie, "string");
  assert.equal(verifySessionCookie(aliceCookie, bobOptions), false);
  // And the reverse — a fresh cookie from `bob` does not verify back on `alice`,
  // which is what signing everyone out on a username change actually means.
  assert.equal(verifySessionCookie(issueSessionCookie(bobOptions), options({ OMP_WEB_USERNAME: "alice" })), false);
});

test("rejects a cookie when the configured password changes", async () => {
  const { issueSessionCookie, verifySessionCookie } = await loadSubject();

  const cookie = issueSessionCookie(options({ OMP_WEB_PASSWORD: PASSWORD }));
  const changed = options({ OMP_WEB_PASSWORD: OTHER_PASSWORD });

  assert.equal(verifySessionCookie(cookie, changed), false);
  // Same in reverse: a cookie minted under the new password must not verify
  // against the previous password's environment.
  assert.equal(verifySessionCookie(issueSessionCookie(changed), options()), false);
});

test("treats an empty-string OMP_WEB_USERNAME as the default 'omp'", async () => {
  const { issueSessionCookie, verifySessionCookie } = await loadSubject();

  // A cookie minted under the default username (`OMP_WEB_USERNAME` unset).
  const cookie = issueSessionCookie(options());
  // ...must still verify when the operator has explicitly set the env var to
  // an empty string, so existing cookies survive the cosmetic change of
  // pinning the default into the environment.
  const emptyUsername = options({ OMP_WEB_USERNAME: "" });
  assert.equal(verifySessionCookie(cookie, emptyUsername), true);

  // Whitespace-only is also treated as the default.
  const whitespace = options({ OMP_WEB_USERNAME: "   " });
  assert.equal(verifySessionCookie(cookie, whitespace), true);

  // Sanity: a non-default username still invalidates the cookie, so the
  // empty-as-default behaviour above isn't a free pass for any value.
  assert.equal(verifySessionCookie(cookie, options({ OMP_WEB_USERNAME: "alice" })), false);
});
