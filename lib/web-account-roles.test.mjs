import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const store = createRequire(import.meta.url)("../bin/web-auth-store.js");

/**
 * Rollen in der Kontendatei.
 *
 * Vier Eigenschaften, und jede ist eine Fehlermode, den man schon einmal hatte:
 *
 *  1. **Ein Rollenwechsel wirkt im naechsten Request.** Das heisst: kein
 *     Neustart, kein Reload, und ein Cache, der die Datei nicht bemerkt, waere
 *     genauso schlimm wie gar kein Cache. Geprueft wird ueber `isAdminUsername`,
 *     also ueber genau den Aufruf, den `proxy.ts` pro Request macht.
 *  2. **Der letzte Admin bleibt Admin.** Sonst gibt es einen Zustand, in dem
 *     sich niemand anmelden und niemand die Rollen zuruecksetzen kann — auf
 *     diesem Host heisst das: zurueck auf die Konsole des Betreibers.
 *  3. **`OMP_WEB_ADMINS` entscheidet allein.** Wer die Liste beim Prozessstart
 *     festnagelt, verteidigt sie sonst nur ueber dieses Frontend.
 *  4. **Ein Konto ohne Rollenfeld bleibt Admin**, wenn es nach dem alten Schema
 *     Admin war.
 */

const PARAMS = { cost: 16, keyLength: 32 };
const PASSWORD = "a-long-enough-password";

function withAccounts(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-roles-"));
  const homeRoot = join(dir, "home");
  mkdirSync(homeRoot, { recursive: true, mode: 0o700 });
  const options = {
    env: { OMP_WEB_HOME_ROOT: homeRoot },
    file: join(dir, "omp-web-auth.json"),
    accountsFile: join(dir, "omp-web-accounts.json"),
    params: PARAMS,
  };
  store.clearAdminRoleCache();
  try {
    return run(options, homeRoot, dir);
  } finally {
    store.clearAdminRoleCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Roh auf die Platte, wie ein Operator oder ein Test es tun wuerde. */
function rawUsers(options) {
  return JSON.parse(readFileSync(options.accountsFile, "utf8")).users;
}

// ---------------------------------------------------------------------------
// 1 — Der Rollenwechsel wirkt sofort.
// ---------------------------------------------------------------------------

test("ein Rollenwechsel gilt im naechsten Aufruf, ohne Neustart und ohne Cache-Fehler", () => {
  withAccounts((options) => {
    store.createWebAccount("alice", PASSWORD, options);
    store.createWebAccount("bob", PASSWORD, options);

    // Vorher warm lesen: genau der Zustand, in dem ein Cache zu alt sein kann.
    assert.equal(store.isAdminUsername("alice", options.env, options), false);

    store.setWebAccountRole("alice", true, options);

    assert.equal(store.isAdminUsername("alice", options.env, options), true);
    assert.equal(store.isAdminUsername("bob", options.env, options), false);
    assert.equal(store.listWebAccounts(options).accounts.find((a) => a.username === "alice").isAdmin, true);
  });
});

test("auch ein Herabstufen wirkt sofort, und die Liste zeigt dieselbe Antwort wie der Proxy", () => {
  withAccounts((options) => {
    store.createWebAccount("steimerbyte", PASSWORD, options);
    store.createWebAccount("alice", PASSWORD, options);
    store.setWebAccountRole("alice", true, options);

    // Warm: beide Richtungen einmal durch den Cache.
    assert.equal(store.isAdminUsername("alice", options.env, options), true);
    store.setWebAccountRole("alice", false, options);

    assert.equal(store.isAdminUsername("alice", options.env, options), false);
    assert.equal(store.isAdminUsername("steimerbyte", options.env, options), true);
    const listed = Object.fromEntries(store.listWebAccounts(options).accounts.map((a) => [a.username, a.isAdmin]));
    assert.deepEqual(listed, { alice: false, steimerbyte: true });
  });
});

/**
 * Der Cache haengt an der mtime. Ein Ablauf, der die Datei zweimal in derselben
 * Millisekunde ersetzt, muss trotzdem die neue Rolle sehen — dafuer gibt es das
 * Loeschen in `writeWebAccounts`.
 */
test("zwei Rollenwechsel in derselben Millisekunde werden beide gesehen", () => {
  withAccounts((options) => {
    store.createWebAccount("alice", PASSWORD, options);
    store.createWebAccount("bob", PASSWORD, options);
    // `bob` ist der zweite Admin, damit `alice` herabgestuft werden darf — die
    // Sperre waere sonst die richtige Antwort und wuerde den Cache verdecken.
    store.setWebAccountRole("bob", true, options);
    store.setWebAccountRole("alice", true, options);
    assert.equal(store.isAdminUsername("alice", options.env, options), true);

    store.setWebAccountRole("alice", false, options);
    store.setWebAccountRole("alice", true, options);
    assert.equal(store.isAdminUsername("alice", options.env, options), true);

    store.setWebAccountRole("alice", false, options);
    store.setWebAccountRole("alice", false, options);
    assert.equal(store.isAdminUsername("alice", options.env, options), false);
  });
});

test("eine von Hand umgeschriebene Datei wird beim naechsten Aufruf gesehen", () => {
  withAccounts((options) => {
    store.createWebAccount("alice", PASSWORD, options);
    assert.equal(store.isAdminUsername("alice", options.env, options), false);

    const raw = JSON.parse(readFileSync(options.accountsFile, "utf8"));
    raw.users[0].isAdmin = true;
    writeFileSync(options.accountsFile, JSON.stringify(raw));
    store.clearAdminRoleCache();

    assert.equal(store.isAdminUsername("alice", options.env, options), true);
  });
});

// ---------------------------------------------------------------------------
// 2 — Der letzte Admin bleibt.
// ---------------------------------------------------------------------------

test("der letzte Admin kann nicht herabgestuft werden", () => {
  withAccounts((options) => {
    store.createWebAccount("steimerbyte", PASSWORD, options);
    store.createWebAccount("alice", PASSWORD, options);

    // `steimerbyte` ist ueber den Namensrueckfall der einzige Admin.
    assert.throws(() => store.setWebAccountRole("steimerbyte", false, options), /last administrator/);

    // Und es ist wirklich nichts passiert: die Rolle steht noch.
    assert.equal(store.isAdminUsername("steimerbyte", options.env, options), true);
    assert.equal(rawUsers(options).find((user) => user.username === "steimerbyte").isAdmin, undefined);
  });
});

test("ein zweiter Admin macht das Herabstufen moeglich", () => {
  withAccounts((options) => {
    store.createWebAccount("steimerbyte", PASSWORD, options);
    store.createWebAccount("alice", PASSWORD, options);
    store.setWebAccountRole("alice", true, options);

    store.setWebAccountRole("steimerbyte", false, options);
    assert.equal(store.isAdminUsername("steimerbyte", options.env, options), false);
    assert.equal(store.isAdminUsername("alice", options.env, options), true);
  });
});

test("der letzte Admin kann nicht deaktiviert werden", () => {
  withAccounts((options) => {
    store.createWebAccount("steimerbyte", PASSWORD, options);

    assert.throws(() => store.setWebAccountEnabled("steimerbyte", false, options), /last administrator/);
    assert.ok(store.findWebAccount("steimerbyte", options), "das Konto bleibt anmeldebar");
  });
});

test("ein deaktivierter Admin zaehlt nicht mit: der aktivierte Admin ist der letzte", () => {
  withAccounts((options) => {
    store.createWebAccount("alice", PASSWORD, options);
    store.createWebAccount("bob", PASSWORD, options);
    store.setWebAccountRole("alice", true, options);
    store.setWebAccountRole("bob", true, options);

    // `bob` wird abgeschaltet — er zaehlt danach nicht als Admin, also ist
    // `alice` der letzte und laesst sich nicht mehr abschalten. Ohne diese
    // Regel wuerde der Test durchgehen und der Host waere nicht mehr zu
    // bedienen.
    store.setWebAccountEnabled("bob", false, options);
    assert.throws(() => store.setWebAccountEnabled("alice", false, options), /last administrator/);
    // Dieselbe Rechnung fuer die Rolle, waehrend `alice` eingeschaltet ist.
    assert.throws(() => store.setWebAccountRole("alice", false, options), /last administrator/);

    // Und sie geht wieder auf, sobald ein zweiter Admin wirklich anmeldebar ist.
    store.setWebAccountEnabled("bob", true, options);
    store.setWebAccountRole("alice", false, options);
    assert.equal(store.isAdminUsername("alice", options.env, options), false);
    assert.equal(store.isAdminUsername("bob", options.env, options), true);
  });
});

// ---------------------------------------------------------------------------
// 3 — OMP_WEB_ADMINS hat Vorrang.
// ---------------------------------------------------------------------------

test("OMP_WEB_ADMINS entscheidet allein und laesst sich aus der Datei nicht widerlegen", () => {
  withAccounts((options, homeRoot) => {
    const env = { OMP_WEB_HOME_ROOT: homeRoot, OMP_WEB_ADMINS: "alice" };
    store.createWebAccount("alice", PASSWORD, options);
    store.createWebAccount("bob", PASSWORD, options);

    // `bob` behauptet per Datei, Admin zu sein. Die Environment sagt nein.
    store.setWebAccountRole("bob", true, options);
    assert.equal(store.isAdminUsername("bob", env, options), false);
    assert.equal(store.isAdminUsername("alice", env, options), true);
  });
});

test("ein von OMP_WEB_ADMINS benanntes Konto laesst sich nicht herabstufen — mit Erklaerung", () => {
  withAccounts((options, homeRoot) => {
    const env = { OMP_WEB_HOME_ROOT: homeRoot, OMP_WEB_ADMINS: "alice" };
    store.createWebAccount("alice", PASSWORD, options);

    // Wichtig: kein stillschweigendes "erledigt", obwohl sich nichts aendert.
    // Die Fehlermeldung nennt den Weg, der wirklich hilft.
    assert.throws(
      () => store.setWebAccountRole("alice", false, { ...options, env }),
      /OMP_WEB_ADMINS[\s\S]*Remove the name from OMP_WEB_ADMINS/,
    );
    assert.equal(store.isAdminUsername("alice", env, options), true);
  });
});

test("ohne gesetzte Environment entscheidet die Datei, und die Vorgabeliste gilt nur ohne Feld", () => {
  withAccounts((options) => {
    store.createWebAccount("alice", PASSWORD, options);
    store.createWebAccount("steimerbyte", PASSWORD, options);

    // Ohne Feld: der Name entscheidet.
    assert.equal(store.isAdminUsername("steimerbyte", options.env, options), true);
    // Mit explizitem Feld: die Datei entscheidet, auch gegen den Namen. Erst der
    // zweite Admin, sonst greift die Lockout-Sperre — zu Recht.
    store.setWebAccountRole("alice", true, options);
    store.setWebAccountRole("steimerbyte", false, options);
    assert.equal(store.isAdminUsername("steimerbyte", options.env, options), false);
    assert.equal(store.isAdminUsername("alice", options.env, options), true);
  });
});

// ---------------------------------------------------------------------------
// 4 — Der Rueckfall fuer Konten ohne Feld.
// ---------------------------------------------------------------------------

test("ein Konto von vor dem Rollenfeld verliert seinen Admin-Status nicht", () => {
  withAccounts((options) => {
    store.createWebAccount("steimerbyte", PASSWORD, options);

    // Ein von Hand gebautes Konto ganz ohne `isAdmin` — so sah jede Datei vor
    // dem Schemawechsel aus.
    const raw = JSON.parse(readFileSync(options.accountsFile, "utf8"));
    delete raw.users[0].isAdmin;
    writeFileSync(options.accountsFile, JSON.stringify(raw));
    store.clearAdminRoleCache();

    assert.equal(store.isAdminUsername("steimerbyte", options.env, options), true);
    assert.equal(store.listWebAccounts(options).accounts[0].isAdmin, true);
  });
});

test("ein Name ausserhalb der Kontendatei faellt auf die Namensliste zurueck", () => {
  withAccounts((options) => {
    store.createWebAccount("alice", PASSWORD, options);
    // Der Einzelbenutzer-Store kennt keine Kontendatei. Ohne Rueckfall waere
    // `omp` nach dem Wechsel der Autorisierungsquelle kein Admin mehr.
    assert.equal(store.isAdminUsername("omp", options.env, options), true);
    assert.equal(store.isAdminUsername("someone-else", options.env, options), false);
    assert.equal(store.isAdminUsername("", options.env, options), false);
    assert.equal(store.isAdminUsername(null, options.env, options), false);
  });
});

// ---------------------------------------------------------------------------
// Die Regel selbst, ohne Datei.
// ---------------------------------------------------------------------------

test("accountIsAdmin ist dieselbe Regel, die isAdminUsername anwendet", () => {
  const env = { OMP_WEB_ADMINS: "alice" };
  assert.equal(store.accountIsAdmin({ username: "alice" }, env), true);
  assert.equal(store.accountIsAdmin({ username: "alice", isAdmin: false }, env), true);
  assert.equal(store.accountIsAdmin({ username: "bob", isAdmin: true }, env), false);

  const plain = {};
  assert.equal(store.accountIsAdmin({ username: "steimerbyte" }, plain), true);
  assert.equal(store.accountIsAdmin({ username: "steimerbyte", isAdmin: false }, plain), false);
  assert.equal(store.accountIsAdmin({ username: "alice", isAdmin: true }, plain), true);
  assert.equal(store.accountIsAdmin(null, plain), false);
});

test("setWebAccountRole lehnt ab, was keine Rolle ist", () => {
  withAccounts((options) => {
    store.createWebAccount("alice", PASSWORD, options);
    for (const value of ["true", 1, 0, null, undefined, {}]) {
      assert.throws(() => store.setWebAccountRole("alice", value, options), /must be true or false/);
    }
    assert.throws(() => store.setWebAccountRole("nobody", true, options), /No such account/);
  });
});