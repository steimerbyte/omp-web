import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server";

const require = createRequire(import.meta.url);
const store = require("./bin/web-auth-store.js");

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { proxy } = await jiti.import("./proxy.ts");
const { SESSION_COOKIE_NAME, issueSessionCookie } = await jiti.import("./lib/web-auth-session.ts");

const ORIGIN = "http://localhost:30141";

/**
 * Die Kette, von der die Admin-Regel abhaengt, an ihrem letzten Glied.
 *
 * `lib/web-account-roles.test.mjs` beweist, dass `isAdminUsername` die Datei
 * richtig liest. Das ist nicht dasselbe wie "der Proxy setzt danach auch den
 * Header": dazwischen liegen `withIdentity`, das Loeschen des mitgelieferten
 * Werts und `getRequestIdentity` auf der anderen Seite. Diese Datei schliesst
 * die Kette von hinten — sie schaut auf den Header, den `proxy.ts` wirklich
 * schreibt, und nicht auf eine Funktion, die man sich daneben vorstellt.
 *
 * Zwei Dinge werden hier gleichzeitig geprueft, weil sie dieselbe Zeile betreffen:
 * ein Rollenwechsel wirkt **ohne Neustart**, und ein `x-omp-admin`, den der
 * Client selbst mitschickt, kommt **nicht** wieder heraus.
 */

/** So uebergibt Next die umgeschriebenen Request-Header an den Handler. */
function forwarded(response, name) {
  return response.headers.get(`x-middleware-request-${name}`);
}

function withServer(t, run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-proxy-role-"));
  const homeRoot = join(dir, "home");
  mkdirSync(homeRoot, { recursive: true, mode: 0o700 });
  const keys = ["OMP_WEB_ACCOUNTS_FILE", "OMP_WEB_HOME_ROOT", "OMP_WEB_ADMINS", "OMP_WEB_PASSWORD"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  process.env.OMP_WEB_ACCOUNTS_FILE = join(dir, "omp-web-accounts.json");
  process.env.OMP_WEB_HOME_ROOT = homeRoot;
  // Kein `OMP_WEB_ADMINS`: der Test prueft die Datei, nicht die Environment.
  delete process.env.OMP_WEB_ADMINS;
  // Gesperrt, damit der Proxy ueberhaupt eine Identitaet behaelt. Ohne Sperre
  // laeuft jeder Request als `allow` mit `identity === null` durch.
  process.env.OMP_WEB_PASSWORD = "correct horse battery staple";
  store.clearAdminRoleCache();
  store.createWebAccount("bob", "a-long-enough-password", { params: { cost: 16, keyLength: 32 } });
  store.createWebAccount("alice", "a-long-enough-password", { params: { cost: 16, keyLength: 32 } });

  t.after(() => {
    store.clearAdminRoleCache();
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  return run({ dir, homeRoot });
}

/** Ein Browser-Request mit gueltiger Sitzung fuer `username`. */
function signedIn(username, extraHeaders = {}) {
  // Genau so, wie die Login-Route es macht: der Name wandert in die signierte
  // Nutzlast. Ohne ihn stuende `omp` im Keks — und `omp` ist in der
  // Vorgabeliste, jeder dieser Tests waere gruen, ohne etwas zu pruefen.
  const cookie = issueSessionCookie({ username });
  return new NextRequest(`${ORIGIN}/api/web-access/users`, {
    headers: { host: "localhost:30141", cookie: `${SESSION_COOKIE_NAME}=${cookie}`, ...extraHeaders },
  });
}

test("ein Konto ohne Admin-Rolle bekommt keinen x-omp-admin vom Proxy", (t) => {
  withServer(t, () => {
    const response = proxy(signedIn("bob"));
    assert.equal(response.status, 200, "der Request ist erlaubt, nur nicht als Admin");
    assert.equal(forwarded(response, "x-omp-user"), "bob");
    assert.equal(forwarded(response, "x-omp-admin"), null);
  });
});

test("die Rolle aus der Kontendatei landet im Header, ohne Neustart", (t) => {
  withServer(t, () => {
    assert.equal(forwarded(proxy(signedIn("alice")), "x-omp-admin"), null, "alice ist kein Admin");

    // `alice` wird mit hochgestuft, damit `bob` wieder herabgestuft werden
    // darf — der Store verweigert die Entmachtung des letzten Admins, und das
    // ist hier nicht die Eigenschaft, die dieser Test zeigen soll.
    store.setWebAccountRole("alice", true);
    store.setWebAccountRole("bob", true);

    const asAdmin = proxy(signedIn("bob"));
    assert.equal(forwarded(asAdmin, "x-omp-user"), "bob");
    assert.equal(forwarded(asAdmin, "x-omp-admin"), "1");

    // Und wieder zurueck, im naechsten Request — nicht erst nach einem Neustart.
    store.setWebAccountRole("bob", false);
    assert.equal(forwarded(proxy(signedIn("bob")), "x-omp-admin"), null);
    assert.equal(forwarded(proxy(signedIn("alice")), "x-omp-admin"), "1", "die andere Rolle steht");
  });
});

test("der Sessionname allein macht niemanden zum Admin", (t) => {
  withServer(t, () => {
    // Der Keks nennt nur `bob`. Die Rolle kommt aus der Datei, und die sagt
    // nein — ohne den zweiten Blick in den Namen waere jedes Konto so gut wie
    // ein Admin.
    const response = proxy(signedIn("bob"));
    assert.equal(forwarded(response, "x-omp-user"), "bob");
    assert.equal(forwarded(response, "x-omp-admin"), null);
  });
});

test("ein x-omp-admin vom Client wird geloescht, auch wenn die Rolle passt", (t) => {
  withServer(t, () => {
    store.setWebAccountRole("bob", true);

    const response = proxy(signedIn("bob", { "x-omp-admin": "1" }));
    // Der Client darf den Wert mitschicken; entschieden wird er hier. Dass er
    // gleich aussieht, ist kein Zufall, sondern der Nachweis, dass `bob` die
    // Rolle wirklich aus der Datei hat.
    assert.equal(forwarded(response, "x-omp-admin"), "1");

    // Fuer ein Nicht-Admin ist derselbe Request die eigentliche Probe: der
    // mitgelieferte Wert darf nicht durchkommen, sonst waere jeder Mandant ein
    // Einzeiler.
    const denied = proxy(signedIn("alice", { "x-omp-admin": "1" }));
    assert.equal(forwarded(denied, "x-omp-admin"), null);
    assert.equal(denied.headers.get("x-omp-admin"), null, "und er landet auch nicht in der Antwort");
  });
});