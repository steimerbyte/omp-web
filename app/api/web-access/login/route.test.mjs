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
const { SESSION_COOKIE_NAME, readSession } = await jiti.import("@/lib/web-auth-session.ts");

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

test("der Login setzt den Cookie mit allen Attributen und 3600 Sekunden", async (t) => {
  await withServer(t, async () => {
    const response = await login();
    assert.equal(response.status, 200);

    const { header, value } = cookieFrom(response);
    assert.match(header, /Path=\//);
    assert.match(header, /Max-Age=3600/, "eine Stunde, nicht mehr 86400");
    assert.match(header, /HttpOnly/i);
    assert.match(header, /SameSite=strict/i);
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
    assert.match(header, /SameSite=strict/i);
    assert.match(header, /Max-Age=3600/);
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
