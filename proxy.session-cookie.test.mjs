import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server";
import { forgeSession } from "./test/forge-session.mjs";

/**
 * The renewal rule at the only place where it is observable: the response
 * `proxy.ts` actually returns.
 *
 * A helper's return value would not prove this. The `Set-Cookie` has to survive
 * Next's middleware-to-response handoff, has to carry the same attributes the
 * login route writes (two headers that differ are two cookies, and the browser
 * keeps whichever came last), and must not appear on a request that was only
 * authenticated by Basic Auth or was refused outright.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { proxy } = await jiti.import("./proxy.ts");
const { SESSION_COOKIE_NAME, SESSION_TTL_MS, SESSION_RENEW_AFTER_MS, __testSessionKeySalt } = await jiti.import("./lib/web-auth-session.ts");

const PASSWORD = "correct horse battery staple";
const HOST = "localhost:30141";
const ORIGIN = `http://${HOST}`;

function withServer(t, run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-proxy-cookie-"));
  const keys = [
    "OMP_WEB_PASSWORD", "OMP_WEB_AUTH_FILE", "OMP_WEB_SESSION_KEY_FILE", "OMP_WEB_SESSIONS_FILE", "OMP_WEB_USERNAME",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  process.env.OMP_WEB_PASSWORD = PASSWORD;
  process.env.OMP_WEB_AUTH_FILE = join(dir, "omp-web-auth.json");
  process.env.OMP_WEB_SESSION_KEY_FILE = join(dir, "omp-web-session-key");
  process.env.OMP_WEB_SESSIONS_FILE = join(dir, "omp-web-sessions.json");
  delete process.env.OMP_WEB_USERNAME;

  t.after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  return run({ dir });
}

/** Wie `proxy.ts` es sieht: ein API-Request mit Cookie, ohne `Authorization`. */
function request(cookie, extraHeaders = {}) {
  return new NextRequest(`${ORIGIN}/api/whoami`, {
    headers: { host: HOST, ...(cookie ? { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } : {}), ...extraHeaders },
  });
}

/** Ein korrekt signierter Cookie mit frei gewaehltem Alter (Sekunden). */
function agedCookie(secondsAgo) {
  return forgeSession({
    // `resolveSessionSecret` im Environment-Modus, ohne Logout also Epoche 0.
    secret: `omp:${PASSWORD}|session:0`,
    salt: __testSessionKeySalt(),
    username: "omp",
    issuedAt: Date.now() - secondsAgo * 1000,
    ttlMs: SESSION_TTL_MS,
  });
}

test("ein frischer Cookie wird nicht erneuert", async (t) => {
  await withServer(t, () => {
    const cookie = agedCookie(60);
    const response = proxy(request(cookie));
    assert.equal(response.status, 200, "die Sitzung gilt");
    assert.deepEqual(response.headers.getSetCookie(), [], "kein Set-Cookie auf einem frischen Cookie");
  });
});

test("nach der halben Lebenszeit wird genau ein neuer Cookie gesetzt", async (t) => {
  await withServer(t, () => {
    // 40 Minuten: mehr als die Haelfte der Stunde, also ist die Erneuerung faellig.
    const cookie = agedCookie(40 * 60);
    const previousIssuedAt = Number(Buffer.from(cookie.split(".")[1], "base64url").toString("utf8"));
    assert.ok(Date.now() - previousIssuedAt > SESSION_RENEW_AFTER_MS, "Vorbedingung: die Erneuerung ist faellig");

    const response = proxy(request(cookie));
    assert.equal(response.status, 200, "die Erneuerung aendert den Status nicht");

    const headers = response.headers.getSetCookie();
    assert.equal(headers.length, 1, `genau ein Set-Cookie, nicht zwei: ${JSON.stringify(headers)}`);
    const header = headers[0];

    // Dieselben Attribute wie in `app/api/web-access/login/route.ts`. Fehlt
    // eines davon, legt der Browser einen zweiten Cookie desselben Namens an.
    assert.match(header, new RegExp(`^${SESSION_COOKIE_NAME}=`));
    assert.match(header, /Path=\//);
    assert.match(header, /Max-Age=3600/);
    assert.match(header, /HttpOnly/i);
    assert.match(header, /SameSite=strict/i);
    assert.doesNotMatch(header, /Secure/i, "ueber HTTP kein Secure, sonst verwirft der Browser ihn");
    assert.doesNotMatch(header, /Domain=/i, "host-only: kein Domain-Attribut");

    const renewed = header.slice(header.indexOf("=") + 1, header.indexOf(";"));
    assert.notEqual(renewed, cookie, "der Wert ist ein neuer Cookie");

    // Der neue Cookie traegt ein frisches `issuedAt` — und deshalb ist der
    // naechste Request wieder still. Das ist die Drosselung, um die es geht.
    const fresh = proxy(request(renewed));
    assert.equal(fresh.status, 200, "der erneuerte Cookie authentifiziert");
    assert.deepEqual(fresh.headers.getSetCookie(), [], "und ein frischer Cookie erneuert nicht wieder");
  });
});

test("hinter HTTPS traegt die Erneuerung Secure", async (t) => {
  await withServer(t, () => {
    const response = proxy(request(agedCookie(40 * 60), { "x-forwarded-proto": "https" }));
    const headers = response.headers.getSetCookie();
    assert.equal(headers.length, 1);
    assert.match(headers[0], /Secure/i);
  });
});

test("ein abgelehnter Request bekommt kein Set-Cookie", async (t) => {
  await withServer(t, () => {
    const response = proxy(request(null));
    assert.equal(response.status, 401);
    assert.deepEqual(response.headers.getSetCookie(), [], "sonst verlaengert ein gestohlener Cookie sich durch Klopfen");
  });
});

test("die ausgenommenen Pfade gleiten nicht", async (t) => {
  await withServer(t, () => {
    // `/login` laeuft bewusst mit `identity === null` durch (proxy.ts:119-124).
    // Wuerde dort gleiten, traege eine oeffentliche Seite einen Set-Cookie —
    // und sie ist im Betrieb teilbar gecacht (`s-maxage`).
    const request = new NextRequest(`${ORIGIN}/login`, { headers: { host: HOST, cookie: `${SESSION_COOKIE_NAME}=${agedCookie(40 * 60)}` } });
    const response = proxy(request);
    assert.equal(response.status, 200);
    assert.deepEqual(response.headers.getSetCookie(), [], "kein Set-Cookie auf /login");
  });
});

test("Basic Auth wird nicht verlaengert: dort gibt es keine Sitzung", async (t) => {
  await withServer(t, () => {
    const basic = `Basic ${Buffer.from(`omp:${PASSWORD}`, "utf8").toString("base64")}`;
    const response = proxy(request(null, { authorization: basic }));
    assert.equal(response.status, 200);
    assert.deepEqual(response.headers.getSetCookie(), []);
  });
});
