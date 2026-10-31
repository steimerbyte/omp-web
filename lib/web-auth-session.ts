import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  findWebAccount,
  readSessionEpoch,
  resolveWebAuthFile,
  resolveWebAuthPolicy,
  validateAccountName,
  type WebAuthStoreOptions,
} from "../bin/web-auth-store.js";
import { getExpectedUsername } from "./web-auth";
import { webAuthEnv } from "./runtime-secrets";

/**
 * Signed session cookies for the web lock.
 *
 * Basic Auth still works — curl, the reverse proxy, and every existing client
 * rely on it. This is the browser-friendly second door: `POST`
 * `/api/web-access/login` exchanges the password for an `httpOnly` cookie that
 * `proxy.ts` then accepts. There is no JWT and no dependency: the cookie is a
 * signed nonce with an expiry, and it carries nothing about the user.
 *
 * The signature is keyed on the active credential and the user's revocation
 * epoch, which is what makes sessions die with the password and with a logout —
 * see `resolveSessionSecret`. The lifetime is one hour and slides: `proxy.ts`
 * re-issues the cookie while a browser is in use.
 *
 * The cookie carries the signed username. That is the whole point of the
 * change: a session is not "the server is unlocked" but "this person is logged
 * in", and `proxy.ts` needs the name to build the request identity. Signing it
 * is what keeps a cookie minted for alice from being accepted for bob — an
 * unsigned username field would be a header an attacker simply rewrites.
 */

export const SESSION_COOKIE_NAME = "omp_session";

/**
 * Thirty days, sliding.
 *
 * The point of the cookie is that the operator does not retype the password on
 * a device he keeps, and the device that matters is a phone. Thirty days is
 * that number, and it is the idle timeout, not a session length: `proxy.ts`
 * re-issues the cookie once half of it has passed, so a browser that is used
 * never expires and one that is not sends no request and is never renewed.
 *
 * It was one hour, and an hour is wrong for exactly this device. A closed tab
 * makes no requests, so the sliding rule cannot reach it: measured on a
 * phone-shaped browser, a session that had sat for 61 minutes came back to
 * `/login` — not because the server rejected it, but because the browser had
 * already dropped a cookie whose `Max-Age` was spent. A phone that is opened
 * twice a week is the normal case, and one hour is shorter than that.
 *
 * What it costs: the cookie is the only thing a browser holds — the key is
 * derived from the stored digest — so a copied cookie is a copied session
 * until its own expiry, and that window is now thirty days instead of one
 * hour. The ways out do not depend on the expiry and are unchanged: a logout
 * bumps the account's epoch, a password change rotates the key, and deleting
 * the key file and restarting signs every device out at once.
 *
 * This is the *only* TTL. `expiry` in the token, `Max-Age` and `Expires` in the
 * header and the renewal threshold below are all derived from it.
 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Renewal threshold: `proxy.ts` re-issues the cookie once more than half its
 * lifetime has passed since `issuedAt`. That is the rule that keeps a busy tab
 * from setting a cookie per request: a renewal resets `issuedAt`, so one client
 * gets at most one `Set-Cookie` per half-life no matter how often it polls.
 */
export const SESSION_RENEW_AFTER_MS = SESSION_TTL_MS / 2;

/** Payload schema version, so an old cookie is rejected rather than misread. */
const SESSION_VERSION = "1";

/** Filename of the persisted key, next to the credential file. */
const SESSION_KEY_FILENAME = "omp-web-session-key";

/**
 * Opt-out to the old behaviour: `1` keeps the key in memory only, so a restart
 * ends every session again. Documented in `docs/authentication.md`; the file is
 * the default because a `Restart=always` unit was logging people out ten times
 * a day (measured, see the CHANGELOG).
 */
const EPHEMERAL_KEY_ENV = "OMP_WEB_SESSION_KEY_EPHEMERAL";

/**
 * Where the key lives: `OMP_WEB_SESSION_KEY_FILE`, otherwise next to the
 * credential file.
 *
 * Not under `OMP_WEB_HOME_ROOT`: that is the root the *accounts'* home
 * directories are created in, and the store's own `checkHomeRootWritable` exists
 * because it is frequently root-owned and unwritable for the service user. The
 * credential's directory is the one place this process already writes a secret
 * to (`writeWebAuthConfig` creates it with mode 0700).
 */
/** Wo der Sitzungsschluessel liegt — auch fuer Aufrufer, die ihn nur verstecken wollen. */
export function sessionKeyFile(env: NodeJS.ProcessEnv = process.env): string {
  return resolveSessionKeyFile(env);
}

function resolveSessionKeyFile(env: NodeJS.ProcessEnv): string {
  const explicit = env.OMP_WEB_SESSION_KEY_FILE;
  if (typeof explicit === "string" && explicit.trim().length > 0) return resolve(explicit.trim());
  return join(dirname(resolveWebAuthFile(env)), SESSION_KEY_FILENAME);
}

declare global {
  var __ompSessionKeySalts: Map<string, string> | undefined;
}

/** One salt per key file, for the lifetime of the process. */
function getSaltCache(): Map<string, string> {
  if (!globalThis.__ompSessionKeySalts) globalThis.__ompSessionKeySalts = new Map();
  return globalThis.__ompSessionKeySalts;
}

/**
 * Read the key file, or create it with `wx` so a second process cannot clobber
 * the first one's key.
 *
 * An unwritable location falls back to a per-process salt instead of throwing:
 * login keeps working, sessions just die with the process, which is exactly the
 * behaviour this change replaces. Failing the request instead would take a
 * working installation down over a directory permission.
 */
function loadOrCreateSessionKey(file: string): string {
  const existing = readKeyFile(file);
  if (existing !== null) return existing;

  const created = randomBytes(32).toString("base64url");
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${created}\n`, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
    return created;
  } catch (error) {
    if (error && (error as NodeJS.ErrnoException).code === "EEXIST") {
      // A sibling process won the race; its key is the one to use.
      const winner = readKeyFile(file);
      if (winner !== null) return winner;
    }
    return randomBytes(32).toString("base64url");
  }
}

function readKeyFile(file: string): string | null {
  try {
    const value = readFileSync(file, "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * The signing salt.
 *
 * It used to be `randomBytes(32)` at module scope, which made a restart a
 * logout. Persisting it is a deliberate reversal of that decision: the live
 * unit restarts about ten times a day (deploys and a five-minute healthcheck,
 * measured 2026-10-30), so the "session ends with the process" rule was, in
 * practice, a session that ended at a random point in the hour. What a stolen
 * key file means is written down in `docs/inventory-auth.md`.
 *
 * Memoized per file on `globalThis` like the derived-key cache below, because
 * dev-server reloads re-evaluate this module and must not mint a new salt.
 */
function sessionKeySalt(env: NodeJS.ProcessEnv): string {
  const file = env[EPHEMERAL_KEY_ENV] === "1" ? "" : resolveSessionKeyFile(env);
  const cache = getSaltCache();
  const cached = cache.get(file);
  if (cached !== undefined) return cached;

  const salt = file === "" ? randomBytes(32).toString("base64url") : loadOrCreateSessionKey(file);
  cache.set(file, salt);
  return salt;
}

/** Exported so a test can forge a correctly signed cookie, as the expiry test does. */
export function __testSessionKeySalt(env: NodeJS.ProcessEnv = process.env): string {
  return sessionKeySalt(env);
}

/** scrypt cost for the session key, matching the credential store's own. */
const KEY_PARAMS = { N: 16_384, r: 8, p: 1, keyLength: 64 };

/** Nonce length in bytes. Long enough that two logins in the same ms differ. */
const NONCE_BYTES = 12;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

declare global {
  var __ompSessionKeyCache: Map<string, Buffer> | undefined;
}

/**
 * scrypt is deliberately slow (~50-100 ms at N=16384), and `proxy.ts` pays that
 * cost on every authenticated request. Memoizing the derived key on
 * `globalThis` — the pattern this repo already uses for the session registry,
 * the file-index cache, and the models cache — makes it a once-per-password
 * cost. `globalThis` rather than a module-level `Map` because it survives the
 * dev-server reload that would otherwise re-derive the key.
 */
function getSessionKeyCache(): Map<string, Buffer> {
  if (!globalThis.__ompSessionKeyCache) globalThis.__ompSessionKeyCache = new Map();
  return globalThis.__ompSessionKeyCache;
}

function deriveSessionKey(salt: string, secret: string): Buffer {
  const cache = getSessionKeyCache();
  // The salt is in the cache key because a process can be pointed at more than
  // one key file (tests do); a key derived under another salt must not be
  // served from here. base64url contains no `|`.
  const cacheKey = `${salt}|${secret}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const key = scryptSync(secret, salt, KEY_PARAMS.keyLength, {
    N: KEY_PARAMS.N,
    r: KEY_PARAMS.r,
    p: KEY_PARAMS.p,
  });
  cache.set(cacheKey, key);
  return key;
}

/**
 * The active credential, as a stable server-side secret.
 *
 * `OMP_WEB_PASSWORD` hands over the plaintext, but a stored credential does
 * not: the file holds a scrypt digest and omp-web cannot read a password back.
 * All three modes therefore key on whatever identifies the credential uniquely
 * and changes with it — the environment value itself, or the stored digest's
 * `salt:hash` fingerprint. Either way a new password means a new key, so every
 * cookie signed by the old one stops verifying.
 *
 * `username` selects an account. That is what makes a per-account session
 * possible on an *unlocked* server, where there is no password to bind to at
 * all: without this branch the admin who created accounts from the settings
 * panel would find that none of them can sign in, because the server never
 * demanded a credential. The account's own digest is the right key — unique to
 * that account, and it rotates with the password.
 *
 * The revocation epoch is appended to every variant. It is the only thing that
 * can end a session without touching the credential, which is what a logout has
 * to do: the cookie is self-contained, so "sign out" can only mean "the key
 * that verifies it is gone". `bumpSessionEpoch` in the store turns it, and every
 * cookie of that user stops verifying on the next request.
 */
/**
 * Die Optionen, mit denen ein Cookie geprueft wird — mit der Geheimnisdatei.
 *
 * `bin/web-auth-store.js` liest das Passwort aus der env, die es bekommt. Es
 * hier in die Optionen zu mischen und nicht als Default-Argument zu setzen ist
 * Absicht: ein Aufrufer, der nur `{ username }` uebergibt — die Login-Route tut
 * genau das —, wuerde ein Default sonst vollstaendig ersetzen. Dann faende die
 * Sitzung das Datei-Passwort nicht mehr, `resolveSessionSecret` lieferte `null`,
 * und die Anmeldung waere auf einer umgestellten Installation kaputt, obwohl die
 * Pruefung selbst den Benutzer gerade akzeptiert hat.
 */
function withAuthEnv(options: WebAuthStoreOptions): WebAuthStoreOptions {
  return options.env ? options : { ...options, env: webAuthEnv() };
}

function resolveSessionSecret(options: WebAuthStoreOptions): string | null {
  options = withAuthEnv(options);
  const policy = resolveWebAuthPolicy(options);

  if (typeof options.username === "string" && options.username.length > 0) {
    const account = findWebAccount(options.username, options);
    if (account) return withEpoch(`account:${account.username}|${account.password.salt}:${account.password.hash}`, account.username, options);
  }

  const username = getExpectedUsername(options.env);
  if (policy.mode === "environment") return withEpoch(`${username}:${policy.password}`, username, options);
  if (policy.mode === "stored") return withEpoch(`${username}|stored:${policy.digest.salt}:${policy.digest.hash}`, username, options);
  // `open` with no account behind it has no credential to bind to, and
  // `unavailable` has no readable one. Either way there is nothing to sign.
  return null;
}

function withEpoch(secret: string, username: string, options: WebAuthStoreOptions): string {
  return `${secret}|session:${readSessionEpoch(username, options)}`;
}

/**
 * The decoded username field, or `null` if the cookie is not shaped like one.
 *
 * Read *before* the signature check and therefore trusted for nothing. It only
 * decides which key to verify with: the name is an input to `resolveSessionSecret`
 * the same way a database row id is, and a name that resolves to no credential
 * simply produces no key, which fails the check. A cookie claiming to be
 * `steimerbyte` on a server that has no such account cannot get past this.
 *
 * It is decoded rather than taken from an option because the verifier does not
 * know who the cookie claims to be — the cookie is the only place that can say.
 */
function readCookieUsername(value: unknown, env: NodeJS.ProcessEnv): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parts = value.split(".");
  if (parts.length !== 6) return null;
  if (!BASE64URL.test(parts[4])) return null;

  const username = Buffer.from(parts[4], "base64url").toString("utf8");
  // Der `env` des Aufrufers, nicht `process.env`: die Namen, die dieser Vergleich
  // gegen den Default haelt, sind eine Eigenschaft der Optionen, mit denen das
  // Cookie ausgestellt wurde. Ohne den Durchreich liest ein Aufrufer mit
  // synthetischem `env` hier den Namen des Prozesses und weist jeden Cookie
  // zurueck, der fuer einen anderen Benutzer ausgestellt wurde — die Signatur
  // wird dann nie geprueft, der Fehler sieht wie ein falsches Passwort aus.
  if (validateAccountName(username) !== null && username !== getExpectedUsername(env)) return null;
  return username;
}

function sign(payload: string, secret: string, salt: string): string {
  return createHmac("sha256", deriveSessionKey(salt, secret)).update(payload, "utf8").digest("base64url");
}

/** A timestamp rides in the cookie as base64url so the payload stays one token. */
function encodeTimestamp(value: number): string {
  return Buffer.from(String(value), "utf8").toString("base64url");
}

/** A cookie read off the wire is untrusted: shape is checked before it is used. */
function decodeTimestamp(field: string): number | null {
  if (!BASE64URL.test(field)) return null;
  const decoded = Buffer.from(field, "base64url").toString("utf8");
  if (!/^\d+$/.test(decoded)) return null;
  const value = Number(decoded);
  return Number.isSafeInteger(value) ? value : null;
}

function buildSessionValue(secret: string, username: string, salt: string): string {
  const issuedAt = Date.now();
  const payload = [
    SESSION_VERSION,
    encodeTimestamp(issuedAt),
    encodeTimestamp(issuedAt + SESSION_TTL_MS),
    randomBytes(NONCE_BYTES).toString("base64url"),
    Buffer.from(username, "utf8").toString("base64url"),
  ].join(".");
  return `${payload}.${sign(payload, secret, salt)}`;
}

/**
 * Mint a session cookie for the active credential, or `null` when the lock is
 * off and there is nothing to sign.
 *
 * `username` goes into the signed payload, not into the key. The key decides
 * *which credential* a cookie belongs to; the payload field is what
 * `readSessionCookie` hands back so `proxy.ts` knows who is logged in. Putting
 * the name in the key instead would make the cookie unverifiable for exactly
 * the person it was minted for.
 */
export function issueSessionCookie(options: WebAuthStoreOptions = {}): string | null {
  options = withAuthEnv(options);
  // Der Name wird auch dann aufgeloest, wenn ihn der Aufrufer nicht mitgibt —
  // und zwar fuer den Schluessel, nicht nur fuer die Nutzlast. `resolveSessionSecret`
  // nimmt einen Kontonamen als Konto- statt als Single-User-Credential, und
  // `readSessionCookie` laesst den Namen **immer** aus dem Cookie in denselben
  // Aufruf laufen. Ohne dieses Durchreichen mintet ein Aufrufer ohne `username`
  // einen Konto-Schluessel nie und liefert einen Cookie, den derselbe Server
  // im naechsten Request wieder verwirft: der Fehler faellt dann wie ein
  // abgelaufenes Passwort aus.
  const username = options.username ?? getExpectedUsername(options.env);
  const secret = resolveSessionSecret({ ...options, username });
  if (secret === null) return null;
  return buildSessionValue(secret, username, sessionKeySalt(options.env ?? process.env));
}

/**
 * Check a cookie against the active credential. Returns `false` — never throws
 * — for anything malformed, expired, or signed with a different password.
 */
export function verifySessionCookie(
  value: unknown,
  options: WebAuthStoreOptions = {},
): boolean {
  return readSessionCookie(value, withAuthEnv(options)) !== null;
}

/** What a verified cookie says. `issuedAt` is what the renewal rule reads. */
export interface SessionClaims {
  username: string;
  issuedAt: number;
  expiresAt: number;
}

/**
 * A verified cookie, or `null` for anything malformed, expired, revoked, or
 * signed with a different credential.
 *
 * The returned name is *verified*, not decoded-and-hoped: the signature covers
 * the username field, so swapping alice's name into bob's cookie breaks the
 * signature rather than granting alice bob's session. That is the difference
 * between this and a plain field in the cookie, which is a header the client
 * owns.
 */
export function readSession(
  value: unknown,
  options: WebAuthStoreOptions = {},
): SessionClaims | null {
  options = withAuthEnv(options);
  const username = readCookieUsername(value, options.env ?? process.env);
  if (username === null) return null;

  const [version, issuedAtField, expiry, nonce, encodedUser, signature] = (value as string).split(".");
  if (version !== SESSION_VERSION) return null;
  if (!BASE64URL.test(issuedAtField) || !BASE64URL.test(nonce) || !BASE64URL.test(signature)) {
    return null;
  }

  const issuedAt = decodeTimestamp(issuedAtField);
  const expiresAt = decodeTimestamp(expiry);
  if (issuedAt === null || expiresAt === null || Date.now() >= expiresAt) return null;

  // The name from the cookie picks the key. It is untrusted input at this point
  // and is treated as such: it selects a *stored* credential or nothing, and the
  // signature below still has to match before the name is handed back.
  const secret = resolveSessionSecret({ ...options, username });
  if (secret === null) return null;

  const payload = `${version}.${issuedAtField}.${expiry}.${nonce}.${encodedUser}`;
  const salt = sessionKeySalt(options.env ?? process.env);
  const expected = Buffer.from(sign(payload, secret, salt), "utf8");
  const actual = Buffer.from(signature, "utf8");
  // `timingSafeEqual` throws on a length mismatch, and the signature comes off
  // the wire, so the lengths are compared before it is reached.
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  return { username, issuedAt, expiresAt };
}

/** Which account a session cookie belongs to, or `null`. See `readSession`. */
export function readSessionCookie(
  value: unknown,
  options: WebAuthStoreOptions = {},
): string | null {
  return readSession(value, options)?.username ?? null;
}

/**
 * The attributes of the `omp_session` cookie, in one place.
 *
 * Login, the proxy's renewal and the logout must write the same cookie: two
 * `Set-Cookie` headers that differ in an attribute are two cookies, and which
 * one the browser keeps is a matter of header order. `secure` follows the
 * request instead of a constant — the deployment serves plain HTTP on `:8788`
 * and HTTPS in front of it, and a `secure` cookie would be dropped on the
 * first. Never `domain`-scoped: a host-only cookie cannot be widened by a
 * hostile parent domain.
 *
 * `sameSite` is `lax`, not `strict`, and the difference is the phone this
 * cookie exists for. A link tapped in a mail or a messenger is a **cross-site**
 * top-level navigation, and `strict` withholds the cookie on exactly that
 * request: the proxy sees no identity and answers `302 /login` while a
 * perfectly valid cookie sits in the browser. Measured with a real cross-site
 * link and `Sec-Fetch-Site: cross-site` on the wire: `strict` landed on
 * `/login` with the session in the jar, `lax` lands on the app.
 *
 * What `lax` still withholds is the part that matters: the cookie does not ride
 * along on cross-site subrequests or on cross-site POSTs. The API is covered
 * twice over anyway — `isApiRequestAllowed()` (`lib/request-security.ts`)
 * refuses `sec-fetch-site: cross-site` before `proxy.ts` ever reads the cookie,
 * and `HttpOnly` keeps it out of reach of script. A cookie attribute cannot be
 * the only lock on a mutating endpoint, and here it is not.
 */
export function sessionCookieOptions(url: URL | string, headers?: Headers) {
  const protocol = typeof url === "string" ? new URL(url).protocol : url.protocol;
  const forwarded = headers?.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    secure: protocol === "https:" || forwarded === "https",
  };
}
