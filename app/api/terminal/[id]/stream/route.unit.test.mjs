import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { installFakeTerminalManager, makeTerminalInfo } from "../../../../../test/fixtures/terminal/fake-manager.mjs";

/**
 * `GET /api/terminal/[id]/stream` — SSE-Ausgabe einer Shell.
 *
 * Die Frames sind der Vertrag: `connected` mit den Metadaten, `output` als
 * Byte-Array, und ein `cancel()` des Clients haengt den Schreiber ab. Der
 * Manager ist eine Attrappe; sie merkt sich den Writer, damit der Test einen
 * echten Frame durch die Route schicken kann.
 */

// Eigener Modulgraph pro Datei: der Manager-Singleton liegt sonst
// prozessweit und die Attrappe einer anderen Datei wuerde hier gelten.
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { getTerminalManager, TerminalUnavailableError } = await jiti.import("@/lib/terminal-manager.ts");
const { GET } = await jiti.import("./route.ts");

const ALICE = { host: "localhost", "x-omp-user": "alice" };
const ADMIN = { host: "localhost", "x-omp-user": "pi", "x-omp-admin": "1" };
const ANON = { host: "localhost" };

const terminal = installFakeTerminalManager(getTerminalManager);
// Der Manager-Singleton wird von allen Dateien im Prozess geteilt.
test.beforeEach(() => {
  terminal.manager = terminal.apply();
});

const params = (id) => ({ params: Promise.resolve({ id }) });
const decoder = new TextDecoder();

function request(id, { headers = ALICE, signal } = {}) {
  return new Request(`http://${headers.host ?? "localhost"}/api/terminal/${id}/stream`, {
    headers,
    signal,
  });
}

function ownedTerminal(overrides = {}) {
  terminal.manager.terminals.clear();
  return terminal.add(makeTerminalInfo({ id: "term-1", owner: "alice", ...overrides }));
}


/**
 * Laesst den Keep-alive-Interval genau einmal laufen.
 *
 * Die Route setzt ihn auf 30 s; ein Test, der wartet, waere langsamer als die
 * ganze Suite. Ersetzt wird nur das globale `setInterval` fuer die Dauer des
 * Aufrufs, damit der Callback wirklich ausgefuehrt wird.
 */
async function withImmediateHeartbeat(run) {
  const original = globalThis.setInterval;
  globalThis.setInterval = (callback) => {
    callback();
    return 0;
  };
  try {
    return await run();
  } finally {
    globalThis.setInterval = original;
  }
}

test("der Keep-alive-Frame kommt als Kommentar-Zeile", async () => {
  ownedTerminal();
  terminal.calls.attached.length = 0;
  const abort = new AbortController();

  const res = await withImmediateHeartbeat(() => GET(request("term-1", { signal: abort.signal }), params("term-1")));
  const reader = res.body.getReader();
  await reader.read(); // connected
  const keepAlive = decoder.decode((await reader.read()).value);
  assert.equal(keepAlive, ": keep-alive\n\n");

  abort.abort();
  await reader.read();
});
test("ein Cross-Site-Request bekommt keinen Strom", async () => {
  ownedTerminal();
  const res = await GET(request("term-1", { headers: { ...ALICE, host: "evil.example" } }), params("term-1"));
  assert.equal(res.status, 403);
});

test("ohne Identitaet ist die Shell unbekannt", async () => {
  ownedTerminal();
  const res = await GET(request("term-1", { headers: ANON }), params("term-1"));
  assert.equal(res.status, 404);
});

test("eine fremde Shell wird nicht angehaengt", async () => {
  terminal.manager.terminals.clear();
  terminal.add(makeTerminalInfo({ id: "bobs-shell", owner: "bob" }));
  terminal.calls.attached.length = 0;
  const res = await GET(request("bobs-shell"), params("bobs-shell"));
  assert.equal(res.status, 404);
  assert.deepEqual(terminal.calls.attached, []);
});

test("eine Id ohne Shell ist 404, auch fuer den Admin", async () => {
  terminal.manager.terminals.clear();
  const res = await GET(request("gibtsnicht", { headers: ADMIN }), params("gibtsnicht"));
  assert.equal(res.status, 404);
});

test("der Strom sendet connected, dann die Bytes, und endet beim Abbruch", async () => {
  ownedTerminal();
  terminal.calls.attached.length = 0;
  terminal.calls.detached = 0;
  const abort = new AbortController();

  const res = await GET(request("term-1", { signal: abort.signal }), params("term-1"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(res.headers.get("x-accel-buffering"), "no");
  assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");

  const reader = res.body.getReader();
  const connected = decoder.decode((await reader.read()).value);
  assert.match(connected, /^event: connected\ndata: /);
  assert.match(connected, /"id":"term-1"/);
  assert.match(connected, /"cols":80/);

  // Der Manager haelt den Writer; ein Schreibvorgang muss als `output`-Frame
  // ankommen, nicht als Rohbyte.
  const { writer } = terminal.calls.attached.at(-1);
  await writer.write(new Uint8Array([104, 105]));
  const output = decoder.decode((await reader.read()).value);
  assert.match(output, /^event: output\ndata: \[104,105\]\n\n$/);

  abort.abort();
  const end = await reader.read();
  assert.equal(end.done, true, "der Strom muss nach dem Abbruch schliessen");
  assert.equal(terminal.calls.detached, 1);
  // `close()` des Writers ist Teil des Vertrags, auch wenn die Route ihn nicht
  // selbst ruft: der Manager bekommt ein vollstaendiges Writer-Objekt.
  await writer.close();
});

test("cancel() haengt den Schreiber ab", async () => {
  ownedTerminal();
  terminal.calls.attached.length = 0;
  terminal.calls.detached = 0;
  const abort = new AbortController();

  const res = await GET(request("term-1", { signal: abort.signal }), params("term-1"));
  const reader = res.body.getReader();
  await reader.read(); // connected
  await reader.cancel();
  assert.equal(terminal.calls.detached, 1);

  // Der Keep-alive-Interval wird nur vom abort-Zweig geraeumt; ohne ihn liefe er
  // nach dem Test weiter.
  abort.abort();
});

test("ein Schreibvorgang nach dem Abbruch wird verworfen", async () => {
  ownedTerminal();
  terminal.calls.attached.length = 0;
  const abort = new AbortController();

  const res = await GET(request("term-1", { signal: abort.signal }), params("term-1"));
  const reader = res.body.getReader();
  await reader.read();
  const { writer } = terminal.calls.attached.at(-1);

  abort.abort();
  await reader.read(); // done
  // Kein Fehler, kein Frame: `closed` ist gesetzt.
  await writer.write(new Uint8Array([120]));
});

test("schliesst der Manager den Schreiber, endet der Strom mit einem exit-Frame", async () => {
  const info = ownedTerminal();
  terminal.calls.attached.length = 0;
  const abort = new AbortController();

  const res = await GET(request("term-1", { signal: abort.signal }), params("term-1"));
  const reader = res.body.getReader();
  await reader.read(); // connected

  // Der Manager setzt den Exit-Code vor dem close(); genau so macht es der
  // child.exited-Zweig.
  info.status = "exited";
  info.exitCode = 7;
  const { writer } = terminal.calls.attached.at(-1);
  await writer.close();

  const exit = decoder.decode((await reader.read()).value);
  assert.equal(exit, `event: exit\ndata: {"exitCode":7}\n\n`);
  assert.equal((await reader.read()).done, true, "der Strom muss nach dem exit-Frame schliessen");

  // Ein zweites close(), etwa aus dem abort-Zweig, ist folgenlos.
  await writer.close();
  abort.abort();
});

test("ein schon beendeter Prozess bekommt sofort einen exit-Frame", async () => {
  ownedTerminal({ status: "exited", exitCode: 0 });
  terminal.calls.attached.length = 0;

  const res = await GET(request("term-1"), params("term-1"));
  const reader = res.body.getReader();
  await reader.read(); // connected
  assert.equal(decoder.decode((await reader.read()).value), `event: exit\ndata: {"exitCode":0}\n\n`);
  assert.equal((await reader.read()).done, true);
});
