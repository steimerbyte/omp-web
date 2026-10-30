import { createHmac, scryptSync } from "node:crypto";

/**
 * A correctly signed `omp_session` value with a chosen `issuedAt`.
 *
 * Tests need cookies that are old without waiting an hour, and a real one
 * cannot be backdated: the timestamp is inside the signed payload. Forging is
 * therefore the only way to reach the renewal branch and the expiry branch, and
 * the forge has to mirror `sign` in `lib/web-auth-session.ts` — same payload
 * order, same `scrypt` parameters. `secret` is spelled out by the caller
 * because that is where the test says which credential and which revocation
 * epoch it means.
 */
export function forgeSession({ secret, salt, username, issuedAt = Date.now(), ttlMs, version = "1" }) {
  const encode = (value) => Buffer.from(String(value), "utf8").toString("base64url");
  const payload = [
    version,
    encode(issuedAt),
    encode(issuedAt + ttlMs),
    // Any base64url nonce: the nonce only has to differ between logins.
    "c2lnbmF0dXJlLW5vbmNl",
    encode(username),
  ].join(".");
  const key = scryptSync(secret, salt, 64, { N: 16_384, r: 8, p: 1 });
  return `${payload}.${createHmac("sha256", key).update(payload, "utf8").digest("base64url")}`;
}
