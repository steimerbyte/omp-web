import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `GET /api/agent/running/events` — SSE-Strom der laufenden Session-Ids.
 *
 * Der Broadcast ist prozessweit und traegt alle Ids; gefiltert wird erst im
 * Abonnenten, mit dessen Identitaet. Der Test haelt den Strom an, liest die
 * erste Momentaufnahme, aendert den Bestand und prueft, dass die naechste
 * Meldung die neue Menge fuer *diese* Identitaet enthaelt.
 */

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { GET } = await jiti.import("./route.ts");
const { notifyRunningChange } = await jiti.import("@/lib/rpc-manager");

const ALICE = { host: "localhost", "x-omp-user": "alice" };
const ANON = { host: "localhost" };
const decoder = new TextDecoder();

function session(id, running) {
  return {
    sessionId: id,
    isRunning: () => running,
    isAlive: () => true,
    inner: { sessionManager: null },
    sessionFile: `/tmp/${id}.jsonl`,
    cwd: "/tmp",
    shutdown: async () => {},
  };
}

function installRegistry(t) {
  const previousSessions = globalThis.__ompSessions;
  const previousOwners = globalThis.__ompSessionOwners;
  const previousListeners = globalThis.__ompRunningListeners;
  globalThis.__ompSessions = new Map([
    ["alice-running", session("alice-running", true)],
    ["bob-running", session("bob-running", true)],
  ]);
  globalThis.__ompSessionOwners = new Map([
    ["alice-running", "alice"],
    ["bob-running", "bob"],
  ]);
  globalThis.__ompRunningListeners = new Set();
  t.after(() => {
    globalThis.__ompSessions = previousSessions;
    globalThis.__ompSessionOwners = previousOwners;
    globalThis.__ompRunningListeners = previousListeners;
  });
}

function request(headers) {
  return new Request("http://localhost/api/agent/running/events", { headers });
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

test("der Keep-alive-Frame kommt als Kommentar-Zeile", async (t) => {
  installRegistry(t);
  const abort = new AbortController();
  const res = await withImmediateHeartbeat(() => GET(new Request("http://localhost/api/agent/running/events", {
    headers: ALICE,
    signal: abort.signal,
  })));

  const reader = res.body.getReader();
  await reader.read(); // Momentaufnahme
  assert.equal(decoder.decode((await reader.read()).value), ":\n\n");

  abort.abort();
  await reader.read();
});
test("ohne Identitaet wird kein Strom geoeffnet", async () => {
  const res = await GET(request(ANON));
  assert.equal(res.status, 403);
  assert.equal(await res.text(), "Unknown user");
});

test("der Strom schickt die eigene Menge und danach jede Aenderung", async (t) => {
  installRegistry(t);
  const abort = new AbortController();
  const res = await GET(new Request("http://localhost/api/agent/running/events", {
    headers: ALICE,
    signal: abort.signal,
  }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");

  const reader = res.body.getReader();
  const first = JSON.parse(decoder.decode((await reader.read()).value).replace(/^data: /, ""));
  // Der Broadcast traegt beide Sessions; dieser Abonnent filtert die fremde.
  assert.deepEqual(first, { type: "running", runningSessionIds: ["alice-running"] });

  // Eine neue laufende Session von alice muss als Frame ankommen, ohne dass
  // der Client fragt.
  globalThis.__ompSessions.set("alice-second", session("alice-second", true));
  globalThis.__ompSessionOwners.set("alice-second", "alice");
  notifyRunningChange();

  const frame = decoder.decode((await reader.read()).value);
  assert.match(frame, /^data: /);
  assert.deepEqual(JSON.parse(frame.replace(/^data: /, "")).runningSessionIds.sort(), [
    "alice-running",
    "alice-second",
  ]);

  // Nach dem Abbruch raeumt die Route ihren Abonnenten ab.
  abort.abort();
  const end = await reader.read();
  assert.equal(end.done, true);
  assert.equal(globalThis.__ompRunningListeners.size, 0);
});
