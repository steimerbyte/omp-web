import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { installFakeTerminalManager, makeTerminalInfo } from "../../../../test/fixtures/terminal/fake-manager.mjs";

/**
 * `/api/terminal/[id]` — eine Shell lesen und beenden.
 *
 * Die Besitzpruefung ist hier die interessante Stelle: eine fremde Shell
 * antwortet 404, nicht 403 (`owner-guard.ts` begruendet das). Beide Faelle
 * werden gemessen, weil "404 fuer fremd" nur dann etwas wert ist, wenn die
 * eigene Shell im selben Test 200 liefert.
 */

// Eigener Modulgraph pro Datei: der Manager-Singleton liegt sonst
// prozessweit und die Attrappe einer anderen Datei wuerde hier gelten.
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { getTerminalManager, TerminalUnavailableError } = await jiti.import("@/lib/terminal-manager.ts");
const { GET, DELETE } = await jiti.import("./route.ts");

const ALICE = { host: "localhost", "x-omp-user": "alice" };
const ADMIN = { host: "localhost", "x-omp-user": "pi", "x-omp-admin": "1" };
const ANON = { host: "localhost" };

const terminal = installFakeTerminalManager(getTerminalManager);
// Der Manager-Singleton wird von allen Dateien im Prozess geteilt.
test.beforeEach(() => {
  terminal.manager = terminal.apply();
});

function request(url, { method = "GET", headers = ALICE } = {}) {
  return new Request(`http://${headers.host ?? "localhost"}${url}`, { method, headers });
}
const params = (id) => ({ params: Promise.resolve({ id }) });

// ------------------------------------------------------------------- GET --

test("ohne Identitaet ist die Shell unbekannt", async () => {
  const res = await GET(request("/api/terminal/term-1", { headers: ANON }), params("term-1"));
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Unknown terminal" });
});

test("der Besitzer liest seine Shell samt Sandbox-Zustand", async () => {
  terminal.manager.terminals.clear();
  terminal.add(makeTerminalInfo({ id: "term-1", owner: "alice", sandboxed: true }));

  const res = await GET(request("/api/terminal/term-1"), params("term-1"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.terminal.id, "term-1");
  assert.equal(body.terminal.owner, "alice");
  assert.equal(body.terminal.sandboxed, true);
});

test("eine fremde Shell ist 404, nicht 403", async () => {
  terminal.manager.terminals.clear();
  terminal.add(makeTerminalInfo({ id: "bobs-shell", owner: "bob" }));

  const res = await GET(request("/api/terminal/bobs-shell"), params("bobs-shell"));
  assert.equal(res.status, 404);
  // Dieselbe Form wie eine Id, die es nie gab: kein Orakel.
  const unknown = await GET(request("/api/terminal/nie-da"), params("nie-da"));
  assert.equal(unknown.status, 404);
  assert.deepEqual(await res.json(), await unknown.json());
});

test("der Admin liest auch eine fremde Shell", async () => {
  terminal.manager.terminals.clear();
  terminal.add(makeTerminalInfo({ id: "bobs-shell", owner: "bob" }));

  const res = await GET(request("/api/terminal/bobs-shell", { headers: ADMIN }), params("bobs-shell"));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).terminal.owner, "bob");
});

test("eine Id, die es nicht gibt, ist fuer den Besitzer 404", async () => {
  terminal.manager.terminals.clear();
  // `isOwnedBy` ist hier false, weil die Owner-Map die Id nicht kennt.
  const res = await GET(request("/api/terminal/unbekannt"), params("unbekannt"));
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------- DELETE --

test("DELETE ohne vertrauenswuerdigen Host ist 403", async () => {
  terminal.manager.terminals.clear();
  terminal.add(makeTerminalInfo({ id: "term-1", owner: "alice" }));
  terminal.calls.killed.length = 0;

  const res = await DELETE(
    request("/api/terminal/term-1", { method: "DELETE", headers: { ...ALICE, host: "evil.example" } }),
    params("term-1"),
  );
  assert.equal(res.status, 403);
  assert.deepEqual(terminal.calls.killed, []);
});

test("DELETE einer fremden Shell toetet nichts", async () => {
  terminal.manager.terminals.clear();
  terminal.add(makeTerminalInfo({ id: "bobs-shell", owner: "bob" }));
  terminal.calls.killed.length = 0;

  const res = await DELETE(request("/api/terminal/bobs-shell", { method: "DELETE" }), params("bobs-shell"));
  assert.equal(res.status, 404);
  assert.deepEqual(terminal.calls.killed, []);
});

test("DELETE ohne Identitaet ist 404", async () => {
  const res = await DELETE(
    request("/api/terminal/term-1", { method: "DELETE", headers: ANON }),
    params("term-1"),
  );
  assert.equal(res.status, 404);
});

test("DELETE einer bereits beendeten Shell ist idempotent", async () => {
  terminal.manager.terminals.clear();
  terminal.add(makeTerminalInfo({ id: "term-1", owner: "alice" }));
  // `get` liefert nichts mehr, obwohl der Besitzer passt — der Prozess ist weg.
  const original = terminal.manager.get;
  terminal.manager.get = () => undefined;
  try {
    const res = await DELETE(request("/api/terminal/term-1", { method: "DELETE" }), params("term-1"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, alreadyGone: true });
  } finally {
    terminal.manager.get = original;
  }
});

test("DELETE beendet die eigene Shell", async () => {
  terminal.manager.terminals.clear();
  terminal.add(makeTerminalInfo({ id: "term-1", owner: "alice" }));
  terminal.calls.killed.length = 0;

  const res = await DELETE(request("/api/terminal/term-1", { method: "DELETE" }), params("term-1"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(terminal.calls.killed, ["term-1"]);
});
