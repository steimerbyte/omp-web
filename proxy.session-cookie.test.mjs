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

async function withServer(t, run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-proxy-cookie-"));
  const keys = [
    "OMP_WEB_PASSWORD", "OMP_WEB_AUTH_FILE", "OMP_WEB_SESSION_KEY_FILE", "OMP_WEB_SESSIONS_FILE", "OMP_WEB_USERNAME",
    "OMP_WEB_SECRETS_FILE", "OMP_WEB_TRUST_PROXY",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  process.env.OMP_WEB_PASSWORD = PASSWORD;
  process.env.OMP_WEB_AUTH_FILE = join(dir, "omp-web-auth.json");
  process.env.OMP_WEB_SESSION_KEY_FILE = join(dir, "omp-web-session-key");
  process.env.OMP_WEB_SESSIONS_FILE = join(dir, "omp-web-sessions.json");
  delete process.env.OMP_WEB_USERNAME;
  // Eine leere Geheimnisdatei, damit ein `OMP_WEB_TRUST_PROXY` aus der echten
  // /etc/omp-web.env den Test auf einem Server anders ausgehen liesse als hier.
  process.env.OMP_WEB_SECRETS_FILE = join(dir, "omp-web.env");
  delete process.env.OMP_WEB_TRUST_PROXY;

  t.after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  return await run({ dir });
}

/** Wie `proxy.ts` es sieht: ein API-Request mit Cookie, ohne `Authorization`. */
function request(cookie, extraHeaders = {}, origin = ORIGIN) {
  return new NextRequest(`${origin}/api/whoami`, {
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
  await withServer(t, async () => {
    const cookie = agedCookie(60);
    const response = await proxy(request(cookie));
    assert.equal(response.status, 200, "die Sitzung gilt");
    assert.deepEqual(response.headers.getSetCookie(), [], "kein Set-Cookie auf einem frischen Cookie");
  });
});

/** Ein Cookie, das die Erneuerung ausloest: aelter als die halbe Lebenszeit. */
const dueCookie = () => agedCookie(SESSION_RENEW_AFTER_MS / 1000 + 60);

test("nach der halben Lebenszeit wird genau ein neuer Cookie gesetzt", async (t) => {
  await withServer(t, async () => {
    // Aelter als die Haelfte der Lebenszeit, also ist die Erneuerung faellig.
    const cookie = dueCookie();
    const previousIssuedAt = Number(Buffer.from(cookie.split(".")[1], "base64url").toString("utf8"));
    assert.ok(Date.now() - previousIssuedAt > SESSION_RENEW_AFTER_MS, "Vorbedingung: die Erneuerung ist faellig");

    const response = await proxy(request(cookie));
    assert.equal(response.status, 200, "die Erneuerung aendert den Status nicht");

    const headers = response.headers.getSetCookie();
    assert.equal(headers.length, 1, `genau ein Set-Cookie, nicht zwei: ${JSON.stringify(headers)}`);
    const header = headers[0];

    // Dieselben Attribute wie in `app/api/web-access/login/route.ts`. Fehlt
    // eines davon, legt der Browser einen zweiten Cookie desselben Namens an.
    assert.match(header, new RegExp(`^${SESSION_COOKIE_NAME}=`));
    assert.match(header, /Path=\//);
    // Die Lebensdauer steht an genau einer Stelle: hier wird sie aus der
    // Konstante gebaut, nicht abgeschrieben.
    assert.match(header, new RegExp(`Max-Age=${SESSION_TTL_MS / 1000}`));
    // Und `Expires` gehoert dazu: ohne beide Attribute ist der Cookie ein
    // Session-Cookie und der Browser wirft ihn beim naechsten Start weg.
    assert.match(header, /Expires=[^;]+GMT/, "ein Cookie ohne Expires ueberlebt den Browserstart nicht");
    assert.match(header, /HttpOnly/i);
    assert.match(header, /SameSite=Lax/i, "Lax, nicht Strict: ein Link aus einer anderen App ist eine Cross-Site-Navigation");
    assert.doesNotMatch(header, /Secure/i, "ueber HTTP kein Secure, sonst verwirft der Browser ihn");
    assert.doesNotMatch(header, /Domain=/i, "host-only: kein Domain-Attribut");

    const renewed = header.slice(header.indexOf("=") + 1, header.indexOf(";"));
    assert.notEqual(renewed, cookie, "der Wert ist ein neuer Cookie");

    // Der neue Cookie traegt ein frisches `issuedAt` — und deshalb ist der
    // naechste Request wieder still. Das ist die Drosselung, um die es geht.
    const fresh = await proxy(request(renewed));
    assert.equal(fresh.status, 200, "der erneuerte Cookie authentifiziert");
    assert.deepEqual(fresh.headers.getSetCookie(), [], "und ein frischer Cookie erneuert nicht wieder");
  });
});

test("die Erneuerung folgt dem Ursprung, nicht dem Client-Header", async (t) => {
  await withServer(t, async () => {
    // TLS terminiert vor dem Prozess: der Ursprung ist https.
    const response = await proxy(request(dueCookie(), {}, `https://${HOST}`));
    const headers = response.headers.getSetCookie();
    assert.equal(headers.length, 1);
    assert.match(headers[0], /Secure/i);

    // Ein Client-Header ist keine zweite Quelle: derselbe http-Ursprung mit
    // `x-forwarded-proto: https` bekommt kein Secure.
    const spoofed = await proxy(request(dueCookie(), { "x-forwarded-proto": "https" }));
    assert.doesNotMatch(spoofed.headers.getSetCookie()[0], /Secure/i);
  });
});

test("ein Tab, der eine Stunde geschlossen war, ist keine Abmeldung", async (t) => {
  await withServer(t, async () => {
    // Der gemeldete Fehler: Handy, Tab zu, 61 Minuten spaeter wieder auf, und
    // `/` schickt nach `/login`. Der Proxy war nie die Ursache — der Browser
    // hatte den Cookie verworfen, weil seine Lebensdauer abgelaufen war. Mit
    // einer Stunde TTL faellt dieser Test an der 401, mit Tagen nicht.
    const response = await proxy(request(agedCookie(61 * 60)));
    assert.equal(response.status, 200, "61 Minuten duerfen keine Abmeldung sein");
    // Und weil eine Stunde weit unter der halben Lebensdauer liegt, wird auch
    // nicht neu ausgestellt: kein Schreibzugriff fuer eine blosse Rueckkehr.
    assert.deepEqual(response.headers.getSetCookie(), [], "keine Erneuerung nach einer Stunde");
  });
});

test("ein gueltiger Cookie kauft einem Cross-Site-POST nichts", async (t) => {
  await withServer(t, async () => {
    // `sameSite: lax` laesst den Cookie auf einer Top-Level-GET-Navigation
    // mitreisen — das ist der Link in der Mail, und ohne ihn landet ein Handy
    // mit gueltiger Sitzung auf `/login`. Auf einem Cross-Site-POST schickt der
    // Browser ihn nicht; und selbst wenn er es taete, weist
    // `isApiRequestAllowed()` (`sec-fetch-site: cross-site`) den Request ab,
    // bevor `proxy.ts` den Cookie liest. Beides wird hier gemessen, damit die
    // eine Zeile `sameSite: "lax"` nicht als CSRF-Loch durchgeht.
    const post = (cookie, extraHeaders) => new NextRequest(`${ORIGIN}/api/skills/install`, {
      method: "POST",
      headers: {
        host: HOST,
        "content-type": "application/json",
        ...extraHeaders,
        cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
      },
      body: "{}",
    });

    const crossSite = await proxy(post(dueCookie(), {
      origin: "https://attacker.example", "sec-fetch-site": "cross-site",
    }));
    assert.equal(crossSite.status, 403, "Cross-Site bleibt abgelehnt, auch mit gueltigem Cookie");
    assert.deepEqual(crossSite.headers.getSetCookie(), [], "und nichts, was der Angreifer setzen koennte");

    // Die Kontrolle: derselbe POST aus der eigenen Seite kommt durch. Sonst
    // waere die Assertion oben nur die Aussage "POST geht nie".
    const sameOrigin = await proxy(post(dueCookie(), {
      origin: ORIGIN, "sec-fetch-site": "same-origin",
    }));
    assert.equal(sameOrigin.status, 200, "der eigene POST bleibt erlaubt");
  });
});

test("ein abgelehnter Request bekommt kein Set-Cookie", async (t) => {
  await withServer(t, async () => {
    const response = await proxy(request(null));
    assert.equal(response.status, 401);
    assert.deepEqual(response.headers.getSetCookie(), [], "sonst verlaengert ein gestohlener Cookie sich durch Klopfen");
  });
});

test("die ausgenommenen Pfade gleiten nicht", async (t) => {
  await withServer(t, async () => {
    // `/login` laeuft bewusst mit `identity === null` durch (proxy.ts:119-124).
    // Wuerde dort gleiten, traege eine oeffentliche Seite einen Set-Cookie —
    // und sie ist im Betrieb teilbar gecacht (`s-maxage`).
    const request = new NextRequest(`${ORIGIN}/login`, { headers: { host: HOST, cookie: `${SESSION_COOKIE_NAME}=${dueCookie()}` } });
    const response = await proxy(request);
    assert.equal(response.status, 200);
    assert.deepEqual(response.headers.getSetCookie(), [], "kein Set-Cookie auf /login");
  });
});

test("Basic Auth wird nicht verlaengert: dort gibt es keine Sitzung", async (t) => {
  await withServer(t, async () => {
    const basic = `Basic ${Buffer.from(`omp:${PASSWORD}`, "utf8").toString("base64")}`;
    const response = await proxy(request(null, { authorization: basic }));
    assert.equal(response.status, 200);
    assert.deepEqual(response.headers.getSetCookie(), []);
  });
});
