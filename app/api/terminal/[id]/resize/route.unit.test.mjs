import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { installFakeTerminalManager, makeTerminalInfo } from "../../../../../test/fixtures/terminal/fake-manager.mjs";

/**
 * `POST /api/terminal/[id]/resize` — Groesse einer laufenden Shell.
 *
 * Gemessen wird die Route: wer darf, was passiert mit einer fremden Id, und was
 * mit einem Body, dessen cols/rows keine Zahlen sind. Der Manager ist eine
 * Attrappe; ein echtes `resize` gibt es ohne PTY nicht.
 */

// Eigener Modulgraph pro Datei: der Manager-Singleton liegt sonst
// prozessweit und die Attrappe einer anderen Datei wuerde hier gelten.
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { getTerminalManager } = await jiti.import("@/lib/terminal-manager.ts");
const { POST } = await jiti.import("./route.ts");

const ALICE = { host: "localhost", "x-omp-user": "alice" };
const ADMIN = { host: "localhost", "x-omp-user": "pi", "x-omp-admin": "1" };
const ANON = { host: "localhost" };

const terminal = installFakeTerminalManager(getTerminalManager);
// Der Manager-Singleton wird von allen Dateien im Prozess geteilt.
test.beforeEach(() => {
  terminal.manager = terminal.apply();
});

function request(url, { headers = ALICE, body = { cols: 120, rows: 40 }, contentType = "application/json" } = {}) {
  return new Request(`http://${headers.host ?? "localhost"}${url}`, {
    method: "POST",
    headers: { ...headers, "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const params = (id) => ({ params: Promise.resolve({ id }) });

function ownedTerminal(overrides = {}) {
  terminal.manager.terminals.clear();
  return terminal.add(makeTerminalInfo({ id: "term-1", owner: "alice", ...overrides }));
}

test("ein Cross-Site-Request wird abgelehnt", async () => {
  ownedTerminal();
  const res = await POST(
    request("/api/terminal/term-1/resize", { headers: { ...ALICE, host: "evil.example" } }),
    params("term-1"),
  );
  assert.equal(res.status, 403);
  assert.deepEqual(terminal.calls.resizes, []);
});

test("ohne JSON-Content-Type gibt es 415", async () => {
  ownedTerminal();
  const res = await POST(
    request("/api/terminal/term-1/resize", { contentType: "application/x-www-form-urlencoded" }),
    params("term-1"),
  );
  assert.equal(res.status, 415);
  assert.deepEqual(terminal.calls.resizes, []);
});

test("ohne Identitaet ist die Shell unbekannt", async () => {
  ownedTerminal();
  const res = await POST(request("/api/terminal/term-1/resize", { headers: ANON }), params("term-1"));
  assert.equal(res.status, 404);
  assert.deepEqual(terminal.calls.resizes, []);
});

test("eine fremde Shell wird nicht angefasst", async () => {
  terminal.manager.terminals.clear();
  terminal.add(makeTerminalInfo({ id: "bobs-shell", owner: "bob" }));
  const res = await POST(request("/api/terminal/bobs-shell/resize"), params("bobs-shell"));
  assert.equal(res.status, 404);
  assert.deepEqual(terminal.calls.resizes, []);
});

test("eine Id ohne Shell ist 404, auch fuer den Admin", async () => {
  terminal.manager.terminals.clear();
  const res = await POST(
    request("/api/terminal/gibtsnicht/resize", { headers: ADMIN }),
    params("gibtsnicht"),
  );
  assert.equal(res.status, 404);
});

test("kaputtes JSON ist 400", async () => {
  ownedTerminal();
  const res = await POST(request("/api/terminal/term-1/resize", { body: "{" }), params("term-1"));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Invalid JSON body" });
});

test("cols und rows muessen Zahlen sein", async () => {
  ownedTerminal();
  for (const body of [{ cols: "wide", rows: 40 }, { cols: 120 }, { rows: 40 }]) {
    const res = await POST(request("/api/terminal/term-1/resize", { body }), params("term-1"));
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(await res.json(), { error: "cols and rows must be numbers" });
  }
  assert.deepEqual(terminal.calls.resizes, []);
});

test("die Groesse wird an den Manager weitergereicht", async () => {
  ownedTerminal();
  terminal.calls.resizes.length = 0;

  const res = await POST(request("/api/terminal/term-1/resize", { body: { cols: 120, rows: 40 } }), params("term-1"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(terminal.calls.resizes, [["term-1", 120, 40]]);
});
