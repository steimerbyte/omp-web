import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `GET /api/home` liefert die Home des Aufrufers, nicht die des Prozesses.
 *
 * Der Wert ist kein Geheimnis (eigene Wurzel des Aufrufers), aber er entscheidet
 * in der Oberflaeche, wohin der "Home"-Knopf springt und welches Praefix
 * `SessionSidebar.displayCwd` setzt. Die Route wird ueber `jiti` geladen und mit
 * einem `Request` aufgerufen — der Pfad, den `proxy.ts` im Betrieb setzt, aber
 * ohne einen Server zu starten.
 *
 * Kein echtes Konto noetig: `getUserHome` rechnet nur (`OMP_WEB_HOME_ROOT` +
 * `join`), es wird nichts angelegt und nichts gelesen.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const homeRoute = await jiti.import("./route.ts");

const HOME_ROOT = "/tmp/omp-web-home-root-test";

const get = (headers) => homeRoute.GET(new Request("http://localhost/api/home", { headers }));

test("a tenant gets its own home, the operator and an anonymous request the process home", async (t) => {
  const previous = process.env.OMP_WEB_HOME_ROOT;
  process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;
  t.after(() => {
    if (previous === undefined) delete process.env.OMP_WEB_HOME_ROOT;
    else process.env.OMP_WEB_HOME_ROOT = previous;
  });

  const tenant = await (await get({ host: "localhost", "x-omp-user": "alice" })).json();
  assert.equal(tenant.home, join(HOME_ROOT, "alice"));

  // Admin: `getUserHome` waere `/`, und `/` ist keine Home — jeder absolute
  // Pfad faengt damit an, also wuerde `displayCwd` ueberall `~` voranstellen.
  const admin = await (await get({ host: "localhost", "x-omp-user": "pi", "x-omp-admin": "1" })).json();
  assert.equal(admin.home, homedir());

  // Modus `open` (kein Passwort gesetzt, keine Identitaet): unveraendert, keine
  // neue 401-Flaeche fuer die Ein-Konto-Installation.
  const anonymous = await get({ host: "localhost" });
  assert.equal(anonymous.status, 200);
  assert.equal((await anonymous.json()).home, homedir());
});
