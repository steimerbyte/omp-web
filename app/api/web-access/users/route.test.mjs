import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const store = require("../../../../bin/web-auth-store.js");

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const PASSWORD = "a-long-enough-password";
const PARAMS = { cost: 16, keyLength: 32 };

/**
 * Die Rolle als Weg durch die echte Route.
 *
 * Der Store hat eigene Tests fuer die Regel; dieser Test fragt die andere
 * Seite derselben Sache: **wer** darf sie ausloesen. Der entscheidende Fall
 * ist der Nicht-Admin, der sich selbst hochstufen will — dort muss nicht nur
 * die Antwort 403 sein, sondern danach auch die Datei unveraendert. Ein 403,
 * der trotzdem schreibt, waere der beste Test und die schlimmste Aenderung.
 *
 * Die Route ruft den Store **ohne Optionen** auf, sie liest also `process.env`.
 * Deshalb werden `OMP_WEB_ACCOUNTS_FILE` und `OMP_WEB_HOME_ROOT` gesetzt statt
 * Pfade durchgereicht zu werden — sonst pruefte der Test eine Route, die es
 * so nicht gibt.
 */
async function withUsers(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-users-roles-"));
  const homeRoot = join(dir, "home");
  mkdirSync(homeRoot, { recursive: true, mode: 0o700 });
  const accountsFile = join(dir, "omp-web-accounts.json");
  const saved = {
    OMP_WEB_ACCOUNTS_FILE: process.env.OMP_WEB_ACCOUNTS_FILE,
    OMP_WEB_HOME_ROOT: process.env.OMP_WEB_HOME_ROOT,
    OMP_WEB_ADMINS: process.env.OMP_WEB_ADMINS,
  };
  process.env.OMP_WEB_ACCOUNTS_FILE = accountsFile;
  process.env.OMP_WEB_HOME_ROOT = homeRoot;
  // Kein `OMP_WEB_ADMINS`: die Route soll die Datei benutzen, nicht eine
  // Umgebung, die es auf dem Testrechner vielleicht gibt.
  delete process.env.OMP_WEB_ADMINS;
  store.clearAdminRoleCache();

  try {
    store.createWebAccount("alice", PASSWORD, { params: PARAMS });
    store.createWebAccount("bob", PASSWORD, { params: PARAMS });
    return await run({ accountsFile, dir });
  } finally {
    store.clearAdminRoleCache();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** So setzt `proxy.ts` die Identitaet: der Name ist frei, das Kennzeichen nicht. */
function patch(body, { admin, username = "alice" }) {
  return new Request("http://localhost/api/web-access/users", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-omp-user": username,
      ...(admin ? { "x-omp-admin": "1" } : {}),
    },
    body: JSON.stringify(body),
  });
}

function readRoles(accountsFile) {
  return JSON.parse(readFileSync(accountsFile, "utf8")).users.map((user) => [user.username, user.isAdmin]);
}

test("ein Nicht-Admin kann sich nicht selbst hochstufen — 403 und unveraenderte Datei", async () => {
  await withUsers(async ({ accountsFile }) => {
    const { PATCH } = await jiti.import("./route.ts");

    const response = await PATCH(patch({ action: "set-admin", username: "bob", isAdmin: true }, { admin: false, username: "bob" }));
    assert.equal(response.status, 403);

    // Der Statuscode allein beweist nichts: es geht darum, dass nichts
    // geschrieben wurde.
    assert.deepEqual(readRoles(accountsFile), [["alice", undefined], ["bob", undefined]]);
    assert.equal(store.isAdminUsername("bob"), false);
  });
});

test("ein Nicht-Admin kann auch anderen Konten keine Rolle geben", async () => {
  await withUsers(async ({ accountsFile }) => {
    const { PATCH } = await jiti.import("./route.ts");

    const response = await PATCH(patch({ action: "set-admin", username: "bob", isAdmin: true }, { admin: false }));
    assert.equal(response.status, 403);
    assert.deepEqual(readRoles(accountsFile), [["alice", undefined], ["bob", undefined]]);
  });
});

test("der Admin kann die Rolle setzen, und sie steht im naechsten Request", async () => {
  await withUsers(async ({ accountsFile }) => {
    const { PATCH } = await jiti.import("./route.ts");

    const granted = await PATCH(patch({ action: "set-admin", username: "bob", isAdmin: true }, { admin: true }));
    assert.equal(granted.status, 200);
    assert.equal((await granted.json()).account.isAdmin, true);
    assert.deepEqual(readRoles(accountsFile), [["alice", undefined], ["bob", true]]);

    // Die Rolle wirkt ohne Neustart: `isAdminUsername` ist genau der Aufruf,
    // den `proxy.ts` fuer den naechsten Request macht.
    assert.equal(store.isAdminUsername("bob"), true);

    // Herabstufen geht, solange ein zweiter Admin da ist — deshalb vorher
    // `alice` hochstufen. `alice` ist ueber den Admin-Guard ohnehin Admin, aber
    // das zaehlt fuer den Store nicht: der kennt nur die Datei.
    await PATCH(patch({ action: "set-admin", username: "alice", isAdmin: true }, { admin: true }));
    const revoked = await PATCH(patch({ action: "set-admin", username: "bob", isAdmin: false }, { admin: true }));
    assert.equal(revoked.status, 200);
    assert.equal(store.isAdminUsername("bob"), false);
    assert.equal(store.isAdminUsername("alice"), true);
  });
});

test("set-admin verlangt ein echtes Boolean", async () => {
  await withUsers(async ({ accountsFile }) => {
    const { PATCH } = await jiti.import("./route.ts");
    for (const isAdmin of ["true", 1, null]) {
      const response = await PATCH(patch({ action: "set-admin", username: "bob", isAdmin }, { admin: true }));
      assert.equal(response.status, 400, `angenommen: ${JSON.stringify(isAdmin)}`);
    }
    assert.deepEqual(readRoles(accountsFile), [["alice", undefined], ["bob", undefined]]);
  });
});

test("der letzte Admin kann auch ueber die Route nicht herabgestuft werden", async () => {
  await withUsers(async ({ accountsFile }) => {
    const { PATCH } = await jiti.import("./route.ts");
    // `bob` wird zum Admin gemacht und ist damit der einzige in der Datei.
    // `alice` darf die Route benutzen, weil der Guard auf dem Header steht,
    // nicht auf der Rolle — dieser Test prueft genau die Luecke zwischen den
    // beiden: der Aufrufer darf es versuchen, der Store verweigert es.
    await PATCH(patch({ action: "set-admin", username: "bob", isAdmin: true }, { admin: true }));
    assert.equal(store.isAdminUsername("bob"), true);
    assert.equal(store.isAdminUsername("alice"), false);

    const response = await PATCH(patch({ action: "set-admin", username: "bob", isAdmin: false }, { admin: true }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /last administrator/);
    assert.equal(store.isAdminUsername("bob"), true, "die Rolle steht unveraendert");
    assert.deepEqual(readRoles(accountsFile), [["alice", undefined], ["bob", true]]);
  });
});

test("der letzte Admin kann auch ueber die Route nicht deaktiviert werden", async () => {
  await withUsers(async ({ accountsFile }) => {
    const { PATCH } = await jiti.import("./route.ts");
    await PATCH(patch({ action: "set-admin", username: "bob", isAdmin: true }, { admin: true }));

    const response = await PATCH(patch({ action: "set-enabled", username: "bob", enabled: false }, { admin: true }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /last administrator/);
    assert.ok(store.findWebAccount("bob"), "das Konto bleibt anmeldebar");
    assert.deepEqual(readRoles(accountsFile), [["alice", undefined], ["bob", true]]);
  });
});

/**
 * Das eigene Konto: der Request, der die Rolle wegnimmt, wird noch beantwortet.
 *
 * Die Identitaet war bewiesen, **bevor** er ankam — `requireAdmin` stand am
 * Anfang des Handlers. Ein Abbruch mitten im Klick wuerde den Admin zuerst
 * verlieren und dann die Kontenliste nicht neu laden koennen; so endet die
 * Entmachtung sauber mit dem Request, der sie ausgeloest hat, und der naechste
 * bekommt 403.
 */
test("wer sich selbst entmachtet, verliert die Rolle erst mit dem naechsten Request", async () => {
  await withUsers(async () => {
    const { GET, PATCH } = await jiti.import("./route.ts");

    // `bob` und `alice` werden beide Admin — sonst wuerde `bob` der letzte sein
    // und der Store die Entmachtung als Lockout ablehnen.
    await PATCH(patch({ action: "set-admin", username: "bob", isAdmin: true }, { admin: true }));
    await PATCH(patch({ action: "set-admin", username: "alice", isAdmin: true }, { admin: true }));

    const before = await GET(new Request("http://localhost/api/web-access/users", {
      headers: { "x-omp-user": "bob", "x-omp-admin": "1" },
    }));
    assert.equal(before.status, 200);

    const self = await PATCH(patch(
      { action: "set-admin", username: "bob", isAdmin: false },
      { admin: true, username: "bob" },
    ));
    assert.equal(self.status, 200, "der eigene Request wird noch beantwortet");

    // Ab jetzt ist `bob` ein normaler Benutzer.
    assert.equal(store.isAdminUsername("bob"), false);
    const after = await GET(new Request("http://localhost/api/web-access/users", { headers: { "x-omp-user": "bob" } }));
    assert.equal(after.status, 403);
  });
});

test("die Begruendung der ersten Regel gilt fuer die neue Aktion weiter", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

  // `requireAdmin` muss fuer **jede** Aktion vor der Verzweigung stehen, auch
  // fuer die, die es vorher nicht gab. Ein `action === "set-admin"`-Zweig, der
  // den Guard umgeht, waere exakt die Luecke, die diese Datei einmal hatte.
  const guard = source.indexOf("requireAdmin(request)");
  for (const branch of ['action === "set-enabled"', 'action === "set-admin"', "createWebAccount("]) {
    assert.ok(source.indexOf(branch) > guard, `${branch} liegt vor dem Admin-Guard`);
  }
});