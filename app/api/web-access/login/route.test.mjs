import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server";

/**
 * The login door, from the response the browser gets.
 *
 * Two things live here. The attributes of the cookie are asserted here because
 * no test anywhere did before, and the proxy's renewal writes the same header
 * from a different file — a divergence between the two is a second cookie with
 * the same name. And the logout is measured rather than assumed: a copy of the
 * cookie that existed *before* the call must stop working, which the old code
 * did not do at all.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST, DELETE } = await jiti.import("./route.ts");
const { proxy } = await jiti.import("@/proxy.ts");
const { SESSION_COOKIE_NAME, SESSION_TTL_MS, SESSION_RENEW_AFTER_MS, __testSessionKeySalt, readSession } = await jiti.import("@/lib/web-auth-session.ts");
const { forgeSession } = await jiti.import("@/test/forge-session.mjs");

const PASSWORD = "correct horse battery staple";
const HOST = "localhost:30141";
const ORIGIN = `http://${HOST}`;

function withServer(t, run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-login-route-"));
  const keys = ["OMP_WEB_PASSWORD", "OMP_WEB_AUTH_FILE", "OMP_WEB_SESSION_KEY_FILE", "OMP_WEB_SESSIONS_FILE"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  process.env.OMP_WEB_PASSWORD = PASSWORD;
  process.env.OMP_WEB_AUTH_FILE = join(dir, "omp-web-auth.json");
  process.env.OMP_WEB_SESSION_KEY_FILE = join(dir, "omp-web-session-key");
  process.env.OMP_WEB_SESSIONS_FILE = join(dir, "omp-web-sessions.json");

  t.after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  return run({ dir });
}

function login(extraHeaders = {}) {
  return POST(new Request(`${ORIGIN}/api/web-access/login`, {
    method: "POST",
    headers: { host: HOST, "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify({ password: PASSWORD }),
  }));
}

/** Der Cookie-Wert aus dem Set-Cookie einer Antwort. */
function cookieFrom(response) {
  const headers = response.headers.getSetCookie();
  assert.equal(headers.length, 1, `genau ein Set-Cookie: ${JSON.stringify(headers)}`);
  const header = headers[0];
  assert.match(header, new RegExp(`^${SESSION_COOKIE_NAME}=`));
  return { header, value: header.slice(header.indexOf("=") + 1, header.indexOf(";")) };
}

function asRequest(cookie) {
  return new NextRequest(`${ORIGIN}/api/whoami`, { headers: { host: HOST, cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });
}

test("der Login setzt den Cookie mit allen Attributen und der Lebensdauer aus SESSION_TTL_MS", async (t) => {
  await withServer(t, async () => {
    const response = await login();
    assert.equal(response.status, 200);

    const { header, value } = cookieFrom(response);
    assert.match(header, /Path=\//);
    assert.match(header, new RegExp(`Max-Age=${SESSION_TTL_MS / 1000}`), "die Lebensdauer, nicht eine zweite Zahl");
    assert.match(header, /Expires=[^;]+GMT/, "ohne Expires ueberlebt der Cookie den Browserstart nicht");
    assert.match(header, /HttpOnly/i);
    assert.match(header, /SameSite=Lax/i, "Lax, nicht Strict: ein Link aus einer anderen App ist eine Cross-Site-Navigation");
    assert.doesNotMatch(header, /Secure/i, "ueber HTTP darf kein Secure-Cookie entstehen");
    assert.doesNotMatch(header, /Domain=/i);
    assert.equal(readSession(value)?.username, "omp");
  });
});

test("hinter TLS traegt derselbe Login Secure", async (t) => {
  await withServer(t, async () => {
    const { header } = cookieFrom(await login({ "x-forwarded-proto": "https" }));
    assert.match(header, /Secure/i);
    // Und die uebrigen Attribute bleiben, sonst waere es ein zweiter Cookie.
    assert.match(header, /SameSite=Lax/i, "Lax, nicht Strict: ein Link aus einer anderen App ist eine Cross-Site-Navigation");
    assert.match(header, new RegExp(`Max-Age=${SESSION_TTL_MS / 1000}`));
  });
});

/** Die Attributnamen eines `Set-Cookie`, ohne Wert und ohne Zeitstempel. */
function attributeNames(header) {
  return header.slice(header.indexOf(";") + 1).split(/;\s*/).map((part) => part.split("=")[0].trim().toLowerCase()).sort();
}

function attributeValue(header, name) {
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`, "i"));
  return match ? match[1].trim() : null;
}

test("die Erneuerung schreibt denselben Cookie wie der Login", async (t) => {
  await withServer(t, async () => {
    const { header: loginHeader } = cookieFrom(await login());

    // Dieselbe Signatur wie der Login, nur so alt, dass die Gleitfrist faellig
    // ist und die Lebensdauer noch nicht abgelaufen: dann schreibt der Proxy.
    const agedSecondsAgo = (SESSION_TTL_MS - 60_000) / 1000;
    assert.ok(agedSecondsAgo * 1000 > SESSION_RENEW_AFTER_MS, "Vorbedingung: die Erneuerung ist faellig");
    const aged = forgeSession({
      secret: `omp:${PASSWORD}|session:0`,
      salt: __testSessionKeySalt(),
      username: "omp",
      issuedAt: Date.now() - agedSecondsAgo * 1000,
      ttlMs: SESSION_TTL_MS,
    });
    const renewed = proxy(asRequest(aged)).headers.getSetCookie();
    assert.equal(renewed.length, 1, `genau ein Set-Cookie aus der Erneuerung: ${JSON.stringify(renewed)}`);

    // Namen *und* die Lebensdauer-Attribute. Ein Attribut, das nur einer der
    // beiden Pfade setzt, ist ein zweiter Cookie desselben Namens, und welchen
    // der Browser behaelt, haengt an der Reihenfolge der Header.
    assert.deepEqual(attributeNames(renewed[0]), attributeNames(loginHeader),
      "Login und Erneuerung muessen dieselben Attribute tragen");
    assert.equal(attributeValue(renewed[0], "Max-Age"), attributeValue(loginHeader, "Max-Age"),
      "die Erneuerung darf die Lebensdauer nicht verkuerzen");
    assert.equal(attributeValue(loginHeader, "Max-Age"), String(SESSION_TTL_MS / 1000));
    assert.ok(attributeValue(renewed[0], "Expires"), "die Erneuerung verliert Expires nicht");
    assert.ok(attributeValue(loginHeader, "Expires"), "der Login setzt Expires");
  });
});

test("der Logout widerruft die Kopie, die schon draussen ist", async (t) => {
  await withServer(t, async () => {
    const { value: stolen } = cookieFrom(await login());
    assert.equal(proxy(asRequest(stolen)).status, 200, "Vorbedingung: der Cookie gilt");

    const response = await DELETE(new NextRequest(`${ORIGIN}/api/web-access/login`, {
      method: "DELETE",
      headers: { host: HOST, cookie: `${SESSION_COOKIE_NAME}=${stolen}` },
    }));
    assert.equal(response.status, 200);

    const cleared = cookieFrom(response);
    assert.match(cleared.header, /Max-Age=0/, "der Browser wirft seine Kopie weg");

    // Das ist der Punkt: nicht der Browser, der Server weist die alte Kopie ab.
    assert.equal(readSession(stolen), null, "die alte Kopie verifiziert nicht mehr");
    assert.equal(proxy(asRequest(stolen)).status, 401, "und der Proxy laesst sie nicht mehr durch");

    // Ein neuer Login funktioniert weiterhin — der Widerruf trifft die alten
    // Cookies, nicht das Konto.
    const again = cookieFrom(await login()).value;
    assert.notEqual(again, stolen);
    assert.equal(proxy(asRequest(again)).status, 200);
  });
});
