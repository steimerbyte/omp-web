import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const store = require("../../../bin/web-auth-store.js");

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const PASSWORD = "a-long-enough-password";

/**
 * Dieser Test ruft die ROUTE auf, nicht den Guard.
 *
 * Das ist der ganze Punkt: die Luecke kam nicht von einem falschen Guard
 * zustande, sondern von einer Route, die keinen aufrief. Ein Test, der
 * `requireAdmin` direkt prueft, waere gruen geblieben, waehrend `bob` weiter
 * den Passwort-Store abgeschaltet haette. Deshalb geht hier jeder Fall ueber
 * `GET`/`PUT` der echten Handler, mit den Headern, die `proxy.ts` setzt.
 *
 * `bob` ist bewusst kein Admin. Er steht in keiner Admin-Liste, und
 * `OMP_WEB_ADMINS` wird im Test gesetzt, damit das nicht vom Host abhaengt,
 * auf dem der Test laeuft.
 */
async function withLock(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-access-guard-"));
  const file = join(dir, "omp-web-auth.json");
  const saved = {
    OMP_WEB_AUTH_FILE: process.env.OMP_WEB_AUTH_FILE,
    OMP_WEB_PASSWORD: process.env.OMP_WEB_PASSWORD,
    OMP_WEB_ADMINS: process.env.OMP_WEB_ADMINS,
  };

  // Der Store liest `OMP_WEB_AUTH_FILE` bei jedem Aufruf neu; die Route ruft
  // `getWebAuthStatus()` ohne Optionen auf, also greift genau dieser Pfad.
  process.env.OMP_WEB_AUTH_FILE = file;
  delete process.env.OMP_WEB_PASSWORD;
  process.env.OMP_WEB_ADMINS = "omp";

  try {
    // `set-password` schaltet die Sperre ein und legt einen Digest an. Ohne sie
    // waere `enable` ein 400 und `clear` loeschte nichts, und ein 403 waere an
    // diesen beiden Aktionen nicht von einem Fehler zu unterscheiden.
    store.setWebPassword(PASSWORD, { file, env: {}, params: { cost: 16, keyLength: 32 } });
    assert.equal(store.getWebAuthStatus({ file, env: {} }).enabled, true);
    assert.equal(store.isAdminUsername("bob"), false, "bob darf in diesem Test kein Admin sein");
    return await run(file);
  } finally {
    for (const [key, value] of [
      ["OMP_WEB_AUTH_FILE", saved.OMP_WEB_AUTH_FILE],
      ["OMP_WEB_PASSWORD", saved.OMP_WEB_PASSWORD],
      ["OMP_WEB_ADMINS", saved.OMP_WEB_ADMINS],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function request(body, { admin }) {
  return new Request("http://localhost/api/web-access", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      // So setzt `proxy.ts` die Identitaet: der Name ist frei gewaehlbar, das
      // Admin-Kennzeichen nicht.
      "x-omp-user": "bob",
      ...(admin ? { "x-omp-admin": "1" } : {}),
    },
    body: JSON.stringify(body),
  });
}

function getRequest({ admin }) {
  return new Request("http://localhost/api/web-access", {
    headers: { "x-omp-user": "bob", ...(admin ? { "x-omp-admin": "1" } : {}) },
  });
}

test("ein Nicht-Admin kann die Sperre nicht abschalten, loeschen oder neu setzen", async () => {
  await withLock(async (file) => {
    const { PUT } = await jiti.import("./route.ts");
    const status = () => store.getWebAuthStatus({ file, env: {} });

    // Genau die vier Aktionen, mit denen `bob` am 12.10.2026 gemessen den
    // Host entsperrt hat. Jede einzelne muss 403 sein.
    for (const body of [
      { action: "disable" },
      { action: "clear" },
      { action: "set-password", password: "another-long-password" },
      { action: "enable" },
    ]) {
      const response = await PUT(request(body, { admin: false }));
      assert.equal(response.status, 403, `Nicht-Admin bekommt 403 bei ${body.action}`);

      // Der 403 allein reicht nicht: die Sperre muss danach unveraendert stehen.
      assert.equal(status().enabled, true, `Sperre steht nach ${body.action} weiter`);
      assert.equal(status().configured, true, `Digest steht nach ${body.action} weiter`);
      assert.equal(store.resolveWebAuthPolicy({ file, env: {} }).mode, "stored");
    }
  });
});

test("derselbe Nicht-Admin darf den Status des Locks auch nicht lesen", async () => {
  await withLock(async () => {
    const { GET } = await jiti.import("./route.ts");
    const response = await GET(getRequest({ admin: false }));

    assert.equal(response.status, 403);
    const body = await response.json();
    // Kein `username`, kein `file`: die Ablehnung traegt nichts aus dem Store.
    assert.equal(body.username, undefined);
    assert.equal(body.file, undefined);
  });
});

test("der Admin kann dieselben Aktionen ausfuehren", async () => {
  await withLock(async (file) => {
    const { GET, PUT } = await jiti.import("./route.ts");
    const status = () => store.getWebAuthStatus({ file, env: {} });

    const read = await GET(getRequest({ admin: true }));
    assert.equal(read.status, 200);
    assert.equal((await read.json()).enabled, true);

    const disabled = await PUT(request({ action: "disable" }, { admin: true }));
    assert.equal(disabled.status, 200);
    assert.equal(status().enabled, false, "der Admin hat die Sperre abgeschaltet");

    const enabled = await PUT(request({ action: "enable" }, { admin: true }));
    assert.equal(enabled.status, 200);
    assert.equal(status().enabled, true, "und wieder eingeschaltet");

    const cleared = await PUT(request({ action: "clear" }, { admin: true }));
    assert.equal(cleared.status, 200);
    assert.equal(status().configured, false, "der Admin hat den Digest geloescht");
  });
});

test("der Kommentar, der die Luecke erklaert hat, ist nicht mehr da", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

  // Nicht nur der Satz: eine Begruendung, die wiederkehrt, erzeugt die naechste
  // Route mit derselben Luecke. "Authenticated" ist nicht "Administrator".
  assert.doesNotMatch(source, /has already passed `proxy\.ts`/);
  assert.doesNotMatch(source, /only has to police the payload/);
  assert.match(source, /`proxy\.ts` authorises nobody here/);
});