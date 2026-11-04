import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { installFakeTerminalManager, makeTerminalInfo } from "../../../../../test/fixtures/terminal/fake-manager.mjs";

/**
 * `POST /api/terminal/[id]/input` — Tastatureingaben in eine laufende Shell.
 *
 * Die Reihenfolge ist Teil des Vertrags: Besitzpruefung vor dem Body-Parsing und
 * vor jedem Zustandszugriff (`route.ts` sagt das ausdruecklich). Ein fremder
 * Aufrufer darf deshalb weder an `write` noch an eine 400-Meldung kommen, die
 * ihm verraet, ob die Shell existiert.
 */

// Eigener Modulgraph pro Datei: der Manager-Singleton liegt sonst
// prozessweit und die Attrappe einer anderen Datei wuerde hier gelten.
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { getTerminalManager } = await jiti.import("@/lib/terminal-manager.ts");
const { POST } = await jiti.import("./route.ts");

const ALICE = { host: "localhost", "x-omp-user": "alice" };
const ANON = { host: "localhost" };

const terminal = installFakeTerminalManager(getTerminalManager);
// Der Manager-Singleton wird von allen Dateien im Prozess geteilt.
test.beforeEach(() => {
  terminal.manager = terminal.apply();
});

function request(url, { headers = ALICE, body = { data: "ls\n" }, contentType = "application/json" } = {}) {
  return new Request(`http://${headers.host ?? "localhost"}${url}`, {
    method: "POST",
    headers: { ...headers, "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const params = (id) => ({ params: Promise.resolve({ id }) });

function runningTerminal(overrides = {}) {
  terminal.manager.terminals.clear();
  return terminal.add(makeTerminalInfo({ id: "term-1", owner: "alice", status: "running", ...overrides }));
}

test("ein Cross-Site-Request wird abgelehnt", async () => {
  runningTerminal();
  const res = await POST(
    request("/api/terminal/term-1/input", { headers: { ...ALICE, host: "evil.example" } }),
    params("term-1"),
  );
  assert.equal(res.status, 403);
  assert.deepEqual(terminal.calls.writes, []);
});

test("ohne JSON-Content-Type gibt es 415", async () => {
  runningTerminal();
  const res = await POST(
    request("/api/terminal/term-1/input", { contentType: "text/plain" }),
    params("term-1"),
  );
  assert.equal(res.status, 415);
  assert.deepEqual(terminal.calls.writes, []);
});

test("ohne Identitaet ist die Shell unbekannt", async () => {
  runningTerminal();
  const res = await POST(request("/api/terminal/term-1/input", { headers: ANON }), params("term-1"));
  assert.equal(res.status, 404);
  assert.deepEqual(terminal.calls.writes, []);
});

test("eine fremde Shell bekommt kein Byte", async () => {
  terminal.manager.terminals.clear();
  terminal.add(makeTerminalInfo({ id: "bobs-shell", owner: "bob" }));
  const res = await POST(request("/api/terminal/bobs-shell/input"), params("bobs-shell"));
  assert.equal(res.status, 404);
  assert.deepEqual(terminal.calls.writes, []);
});

test("eine beendete Shell ist 410", async () => {
  runningTerminal({ status: "exited", exitCode: 1 });
  const res = await POST(request("/api/terminal/term-1/input"), params("term-1"));
  assert.equal(res.status, 410);
  assert.deepEqual(await res.json(), { error: "Terminal has exited" });
  assert.deepEqual(terminal.calls.writes, []);
});

test("kaputtes JSON ist 400", async () => {
  runningTerminal();
  const res = await POST(
    request("/api/terminal/term-1/input", { body: "{nope" }),
    params("term-1"),
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Invalid JSON body" });
  assert.deepEqual(terminal.calls.writes, []);
});

test("data muss ein String sein", async () => {
  runningTerminal();
  for (const body of [{ data: 42 }, { data: null }, {}]) {
    const res = await POST(request("/api/terminal/term-1/input", { body }), params("term-1"));
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(await res.json(), { error: "data must be a string" });
  }
  assert.deepEqual(terminal.calls.writes, []);
});

test("die Eingabe landet beim Manager", async () => {
  runningTerminal();
  terminal.calls.writes.length = 0;

  const res = await POST(request("/api/terminal/term-1/input", { body: { data: "echo hi\n" } }), params("term-1"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(terminal.calls.writes, [["term-1", "echo hi\n"]]);
});
