import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { installFakeTerminalManager, makeTerminalInfo, sandboxRefusal } from "../../../test/fixtures/terminal/fake-manager.mjs";

/**
 * `/api/terminal` — Liste und Spawn.
 *
 * Der Manager ist eine Attrappe (siehe Fixture): ein echter Spawn startet
 * `script(1)` und damit einen Prozess, den dieser Test nicht besitzt. Was hier
 * gemessen wird, ist die Route: wer sieht welche Shell, welche cwd wird
 * akzeptiert, wie werden cols/rows geklemmt, und wie wird eine Absage der
 * Sandbox zu 503 mit `detail` und `remediation`.
 *
 * Der Arbeitsbaum liegt in einem temporaeren Home-Root. `OMP_WEB_HOME_ROOT`
 * wird fuer jede Datei gesetzt und am Ende zurueckgegeben.
 */

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-term-route-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
mkdirSync(join(HOME_ROOT, "alice"), { recursive: true });

// Eigener Modulgraph pro Datei: der Manager-Singleton liegt sonst
// prozessweit und die Attrappe einer anderen Datei wuerde hier gelten.
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { getTerminalManager, TerminalUnavailableError } = await jiti.import("@/lib/terminal-manager.ts");
const { GET, POST } = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("@/lib/file-access.ts");
const { clearAllowedRootsCache } = await jiti.import("@/lib/allowed-roots");
const { invalidateSessionListCache } = await jiti.import("@/lib/session-reader");

const ALICE = { host: "localhost", "x-omp-user": "alice" };
const ADMIN = { host: "localhost", "x-omp-user": "pi", "x-omp-admin": "1" };
const ANON = { host: "localhost" };

const terminal = installFakeTerminalManager(getTerminalManager);
// Der Manager-Singleton wird von allen Dateien im Prozess geteilt.
test.beforeEach(() => {
  terminal.manager = terminal.apply();
});
test.after(() => {
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

function request(url, { method = "GET", headers = ALICE, body, contentType = "application/json" } = {}) {
  return new Request(`http://${headers.host ?? "localhost"}${url}`, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": contentType }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const aliceHome = join(HOME_ROOT, "alice");
allowFileRoot(aliceHome, { username: "alice", isAdmin: false });

// ------------------------------------------------------------------- GET --

// `OMP_WEB_HOME_ROOT` ist prozessweit, und `bun test` laedt die
// Testdateien im selben Prozess: eine Zuweisung auf Modulebene gilt nicht
// mehr, sobald eine andere Datei ihre eigene setzt. Deshalb pro Test.
test.beforeEach(() => {
  process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;
  // Wurzeln und Session-Liste werden prozessweit gecacht; ein Home-Root aus
  // einer anderen Testdatei wuerde sonst weiter gelten.
  clearAllowedRootsCache();
  invalidateSessionListCache();
});

test("die Liste ohne Identitaet ist 404 und nennt keine Shell", async () => {
  const res = await GET(request("/api/terminal", { headers: ANON }));
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Unknown terminal" });
});

test("ein Mandant sieht nur seine eigenen Shells", async (t) => {
  terminal.manager.terminals.clear();
  const own = terminal.add(makeTerminalInfo({ id: "own", owner: "alice" }));
  terminal.add(makeTerminalInfo({ id: "foreign", owner: "bob" }));

  const res = await GET(request("/api/terminal"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.terminals.map((entry) => entry.id), [own.id]);
  assert.deepEqual(terminal.calls.listOwnedBy, ["alice"]);
  // Der Mandant fragt nie die ungefilterte Liste ab.
  assert.equal(terminal.calls.listAll, 0);
});

test("der Admin sieht alle Shells", async (t) => {
  terminal.manager.terminals.clear();
  terminal.add(makeTerminalInfo({ id: "own", owner: "alice" }));
  terminal.add(makeTerminalInfo({ id: "other", owner: "bob" }));

  const res = await GET(request("/api/terminal", { headers: ADMIN }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.terminals.map((entry) => entry.id).sort(), ["other", "own"]);
  assert.equal(terminal.calls.listAll, 1);
});

test("die Serialisierung traegt sandboxed immer, auch wenn es false ist", async (t) => {
  terminal.manager.terminals.clear();
  terminal.add(makeTerminalInfo({ id: "plain", sandboxed: false }));

  const res = await GET(request("/api/terminal", { headers: ADMIN }));
  const [entry] = (await res.json()).terminals;
  assert.equal(entry.sandboxed, false);
  assert.equal("sandboxed" in entry, true);
});

// ------------------------------------------------------------------ POST --

test("ein Cross-Site-Request wird vor jedem Spawn abgelehnt", async () => {
  const res = await POST(request("/api/terminal", {
    method: "POST",
    headers: { ...ALICE, host: "evil.example" },
    body: {},
  }));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Untrusted API request" });
  assert.equal(terminal.calls.spawn.length, 0);
});

test("ohne JSON-Content-Type gibt es 415", async () => {
  const res = await POST(request("/api/terminal", {
    method: "POST",
    body: {},
    contentType: "text/plain",
  }));
  assert.equal(res.status, 415);
  assert.equal(terminal.calls.spawn.length, 0);
});

test("ohne Identitaet wird keine Shell gestartet", async () => {
  const res = await POST(request("/api/terminal", { method: "POST", headers: ANON, body: {} }));
  assert.equal(res.status, 404);
  assert.equal(terminal.calls.spawn.length, 0);
});

test("ein cwd ausserhalb der erlaubten Wurzeln ist 403", async () => {
  const res = await POST(request("/api/terminal", { method: "POST", body: { cwd: "/etc" } }));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Access denied for requested cwd" });
  assert.equal(terminal.calls.spawn.length, 0);
});

test("eine erlaubte Wurzel ausserhalb des eigenen Homes bleibt fuer den Mandanten 403", async () => {
  const shared = join(HOME_ROOT, "shared");
  mkdirSync(shared, { recursive: true });
  // Ein `projectRoot` aus einem verknuepften Worktree steht in den Roots —
  // die Home-Pruefung muss trotzdem greifen.
  allowFileRoot(shared, { username: "alice", isAdmin: false });

  const res = await POST(request("/api/terminal", { method: "POST", body: { cwd: shared } }));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Access denied for requested cwd" });
  assert.equal(terminal.calls.spawn.length, 0);
});

test("ohne cwd wird die Home des Kontos genommen, mit geklemmten cols und rows", async () => {
  terminal.calls.spawn.length = 0;
  const res = await POST(request("/api/terminal", {
    method: "POST",
    body: { cols: 9_999, rows: -4 },
  }));

  assert.equal(res.status, 200);
  const [spawn] = terminal.calls.spawn;
  assert.equal(spawn.cwd, aliceHome);
  assert.equal(spawn.cols, 500);
  assert.equal(spawn.rows, 1);
  assert.equal(spawn.owner, "alice");
  assert.equal(spawn.isAdmin, false);
  const body = await res.json();
  assert.equal(body.terminal.cwd, aliceHome);
});

test("nicht-numerische cols und rows fallen auf 80x24 zurueck", async () => {
  terminal.calls.spawn.length = 0;
  await POST(request("/api/terminal", { method: "POST", body: { cols: "wide", rows: null } }));
  const [spawn] = terminal.calls.spawn;
  assert.equal(spawn.cols, 80);
  assert.equal(spawn.rows, 24);
});

test("ein kaputter JSON-Body startet die Shell im Home statt zu scheitern", async () => {
  terminal.calls.spawn.length = 0;
  const res = await POST(new Request("http://localhost/api/terminal", {
    method: "POST",
    headers: { ...ALICE, "content-type": "application/json" },
    body: "{not json",
  }));
  assert.equal(res.status, 200);
  assert.equal(terminal.calls.spawn[0].cwd, aliceHome);
});

test("der Admin darf seine Shell in einem erlaubten cwd ausserhalb der Mandanten-Homes oeffnen", async () => {
  const shared = join(HOME_ROOT, "shared");
  terminal.calls.spawn.length = 0;
  // Der Admin ist der Host: fuer ihn ist `/` die Wurzel. Ein Pfad, der in den
  // Roots liegt, ist damit erlaubt.
  allowFileRoot(shared, { username: "pi", isAdmin: true });

  const res = await POST(request("/api/terminal", {
    method: "POST",
    headers: ADMIN,
    body: { cwd: shared },
  }));
  assert.equal(res.status, 200);
  assert.equal(terminal.calls.spawn[0].isAdmin, true);
});

test("eine Sandbox-Absage wird 503 mit Grund, Abhilfe und sandboxed:false", async () => {
  const reasons = [
    "bad-username",
    "home-missing",
    "admin-home",
    "cwd-outside-home",
    "bwrap-missing",
    "userns-disabled",
  ];

  for (const reason of reasons) {
    const original = terminal.manager.spawn;
    terminal.manager.spawn = async () => {
      throw sandboxRefusal(TerminalUnavailableError, reason);
    };
    try {
      const res = await POST(request("/api/terminal", { method: "POST", body: {} }));
      assert.equal(res.status, 503, `${reason}: erwartet 503, bekam ${res.status}`);
      const body = await res.json();
      assert.equal(body.reason, reason);
      assert.equal(body.sandboxed, false);
      assert.equal(body.remediation, `remediation for ${reason}`, `${reason}: die Abhilfe fehlt`);
      assert.match(body.error, new RegExp(`detail for ${reason}`));
    } finally {
      terminal.manager.spawn = original;
    }
  }
});

test("ein unerwarteter Spawn-Fehler ist 500 mit der Meldung", async () => {
  const original = terminal.manager.spawn;
  terminal.manager.spawn = async () => {
    throw new Error("script: not found");
  };
  try {
    const res = await POST(request("/api/terminal", { method: "POST", body: {} }));
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "script: not found" });
  } finally {
    terminal.manager.spawn = original;
  }
});
