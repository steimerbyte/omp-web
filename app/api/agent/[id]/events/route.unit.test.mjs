import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `GET /api/agent/[id]/events` — SSE-Strom der Agent-Ereignisse.
 *
 * `events-route.test.mjs` prueft die Projektion am Quelltext. Hier laeuft sie:
 * ein Ereignis, das der Client nie sehen darf (`turn_start`), wird verworfen;
 * `message_update` verliert `assistantMessageEvent`; `agent_end` wird auf
 * `{ type: "agent_end" }` reduziert; alles andere geht unveraendert durch.
 *
 * Die Session kommt aus der Registry in `globalThis`, wie in
 * `app/api/sessions/runtime-route.test.mjs`; ein echter Agent wird nicht
 * gestartet.
 */

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { GET } = await jiti.import("./route.ts");
const { SessionManager } = await jiti.import("@oh-my-pi/pi-coding-agent");
const { clearAllowedRootsCache } = await jiti.import("@/lib/allowed-roots");
const { invalidateSessionListCache } = await jiti.import("@/lib/session-reader");

const LIVE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PERSISTED_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FOREIGN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const ALICE = { host: "localhost", "x-omp-user": "alice" };
const BOB = { host: "localhost", "x-omp-user": "bob" };
const ANON = { host: "localhost" };

const homeRoot = mkdtempSync(join(tmpdir(), "omp-web-agent-events-"));
const brokenSessionPath = join(homeRoot, "alice", "broken.jsonl");
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
mkdirSync(join(homeRoot, "alice"), { recursive: true });
mkdirSync(join(homeRoot, "bob"), { recursive: true });
// Eine „Session-Datei", die sich nicht als Datei oeffnen laesst.
mkdirSync(brokenSessionPath, { recursive: true });

const decoder = new TextDecoder();

function liveSession(listeners, owner) {
  return {
    sessionId: LIVE_ID,
    isAlive: () => true,
    isRunning: () => true,
    inner: { sessionManager: null },
    sessionFile: "/tmp/live-agent-events.jsonl",
    cwd: join(homeRoot, owner),
    onEvent(callback) {
      listeners.push(callback);
      return () => {
        const index = listeners.indexOf(callback);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    shutdown: async () => {},
  };
}

const listeners = [];
const previousSessions = globalThis.__ompSessions;
const previousOwners = globalThis.__ompSessionOwners;
globalThis.__ompSessions = new Map([[LIVE_ID, liveSession(listeners, "alice")]]);
globalThis.__ompSessionOwners = new Map([[LIVE_ID, "alice"]]);

// Der persistierte Zweig: `resolveSessionPath` findet eine Session, deren
// Datei sich nicht oeffnen laesst (ein Verzeichnis mit dem Namen einer
// Session-Datei) — `startRpcSession` scheitert dann, und die Route antwortet
// 500 statt zu haengen. Ein fehlender Pfad taugt nicht: `resolveSessionPath`
// verwirft einen Cache-Eintrag, dessen Datei nicht existiert.
const originalListAll = SessionManager.listAll;
SessionManager.listAll = async () => [{
  id: PERSISTED_ID,
  path: brokenSessionPath,
  cwd: join(homeRoot, "alice"),
  title: null,
  created: new Date(0),
  modified: new Date(0),
  messageCount: 0,
  firstMessage: "",
}];

// `OMP_WEB_HOME_ROOT` ist prozessweit, und `bun test` laedt die
// Testdateien im selben Prozess: eine Zuweisung auf Modulebene gilt nicht
// mehr, sobald eine andere Datei ihre eigene setzt. Deshalb pro Test.
test.beforeEach(() => {
  process.env.OMP_WEB_HOME_ROOT = homeRoot;
  // Wurzeln und Session-Liste werden prozessweit gecacht; ein Home-Root aus
  // einer anderen Testdatei wuerde sonst weiter gelten.
  clearAllowedRootsCache();
  invalidateSessionListCache();
});

test.after(() => {
  SessionManager.listAll = originalListAll;
  globalThis.__ompSessions = previousSessions;
  globalThis.__ompSessionOwners = previousOwners;
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  rmSync(homeRoot, { recursive: true, force: true });
});

function get(id, { headers = ALICE, signal } = {}) {
  return GET(
    new Request(`http://localhost/api/agent/${id}/events`, { headers, signal }),
    { params: Promise.resolve({ id }) },
  );
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
  const abort = new AbortController();
  const res = await withImmediateHeartbeat(() => get(LIVE_ID, { signal: abort.signal }));
  const reader = res.body.getReader();
  await reader.read(); // connected
  assert.equal(decoder.decode((await reader.read()).value), ":\n\n");

  abort.abort();
  await reader.read();
});
test("ein Cross-Site-Request oeffnet keinen Strom", async () => {
  const res = await get(LIVE_ID, { headers: { ...ALICE, host: "evil.example" } });
  assert.equal(res.status, 403);
  assert.equal(await res.text(), "Untrusted API request");
});

test("ohne Identitaet gibt es 401, keine Session-Ids", async () => {
  const res = await get(LIVE_ID, { headers: ANON });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Authentication is required." });
});

test("eine fremde Session ist 404, ihre Ereignisse werden nicht angehaengt", async () => {
  const before = listeners.length;
  const res = await get(LIVE_ID, { headers: BOB });
  assert.equal(res.status, 404);
  assert.equal(listeners.length, before, "die fremde Session wurde abonniert");
});

test("eine unbekannte Session ist 404", async () => {
  const res = await get(FOREIGN_ID);
  assert.equal(res.status, 404);
});

test("ein Startfehler ist 500, kein haengender Strom", async () => {
  const res = await get(PERSISTED_ID);
  assert.equal(res.status, 500);
});

test("der Strom projiziert Agent-Ereignisse auf die Client-Form", async () => {
  const abort = new AbortController();
  const res = await get(LIVE_ID, { signal: abort.signal });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");

  const reader = res.body.getReader();
  const connected = decoder.decode((await reader.read()).value);
  assert.deepEqual(JSON.parse(connected.replace(/^data: /, "")), { type: "connected", sessionId: LIVE_ID });

  // Der Strom haengt an der Session; jedes Ereignis geht durch `toClientEvent`.
  assert.equal(listeners.length, 1);
  const emit = (event) => listeners[0](event);

  // `turn_start` ist ein Lebenszyklus-Ereignis, das der Client nicht braucht —
  // es darf keinen Frame erzeugen. Gemessen wird das am naechsten Frame:
  // waere `turn_start` durchgelaufen, stuende er hier.
  emit({ type: "turn_start" });
  emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "hi" },
    message: { role: "assistant" },
  });
  const messageFrame = JSON.parse(decoder.decode((await reader.read()).value).replace(/^data: /, ""));
  assert.equal(messageFrame.type, "message_update");
  assert.equal("assistantMessageEvent" in messageFrame, false, "der rohe SDK-Event darf nicht mitgehen");
  assert.deepEqual(messageFrame.message, { role: "assistant" });

  // `agent_end` wird auf den Typ reduziert — der Rest des SDK-Ereignisses
  // (Nutzlast, Zeitstempel) ist fuer den Client nicht Teil des Vertrags.
  emit({ type: "agent_end", messages: [{ role: "assistant", content: "x" }], duration: 12 });
  const endFrame = JSON.parse(decoder.decode((await reader.read()).value).replace(/^data: /, ""));
  assert.deepEqual(endFrame, { type: "agent_end" });

  // Alles andere geht unveraendert durch.
  emit({ type: "tool_start", toolName: "bash" });
  const toolFrame = JSON.parse(decoder.decode((await reader.read()).value).replace(/^data: /, ""));
  assert.deepEqual(toolFrame, { type: "tool_start", toolName: "bash" });

  abort.abort();
  const end = await reader.read();
  assert.equal(end.done, true);
  assert.deepEqual(listeners, [], "der Abonnent muss beim Abbruch abgemeldet werden");
});
