// Zweite Haelfte von useAgentSession: die Ablaeufe, die einen Stream und
// mehrere Runden brauchen — Verbindungsaufbau (settle), der Settle-Pfad nach
// einem Slash-Prompt (delay/waitForPromptSettlement), die Idle-Grace
// (checkServerIdle), Reconciler/Visibility und die eingebauten Slash-Befehle
// (complete).
import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

const ROOT = new globalThis.URL("..", import.meta.url).pathname;
const jiti = createJiti(`${ROOT}package.json`, { jsx: { runtime: "automatic" }, tsconfigPaths: true });

const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
const ORIGINALS = {
  window: globalThis.window,
  document: globalThis.document,
  HTMLElement: globalThis.HTMLElement,
  Element: globalThis.Element,
  EventSource: globalThis.EventSource,
  navigator: globalThis.navigator,
  fetch: globalThis.fetch,
  setTimeout: globalThis.setTimeout,
  setInterval: globalThis.setInterval,
};
globalThis.window = win;
globalThis.document = win.document;
globalThis.HTMLElement = win.HTMLElement;
globalThis.Element = win.Element;
Object.defineProperty(win.document, "visibilityState", { value: "visible", configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Lange Wartezeiten (30 s Grace, 5 s Connect-Timeout, 800 ms Settlement,
// 1 s/15 s Reconciler) werden auf wenige Millisekunden gestaucht.
const realSetTimeout = ORIGINALS.setTimeout;
const realSetInterval = ORIGINALS.setInterval;
const realClearTimeout = globalThis.clearTimeout;
const realClearInterval = globalThis.clearInterval;
const clamp = (ms) => (typeof ms === "number" && ms >= 100 ? 5 : ms);
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, clamp(ms), ...args);
globalThis.setInterval = (fn, ms, ...args) => realSetInterval(fn, clamp(ms), ...args);

/* ------------------------ EventSource-Stub ------------------------------ */

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances = [];
  static mode = "connect"; // connect | closed | silent
  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.onmessage = null;
    this.onerror = null;
    this.closed = false;
    FakeEventSource.instances.push(this);
    queueMicrotask(() => {
      if (this.closed) return;
      if (FakeEventSource.mode === "connect") {
        this.readyState = 1;
        this.onmessage?.({ data: JSON.stringify({ type: "connected" }) });
      } else if (FakeEventSource.mode === "closed") {
        this.readyState = 2;
        this.onerror?.();
      }
      // "silent": der Timeout in connectEvents entscheidet.
    });
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

const copied = [];
globalThis.navigator = { clipboard: { writeText: async (text) => { copied.push(text); } }, languages: ["de"] };
globalThis.EventSource = FakeEventSource;

/* ---------------------------- Fixtures ---------------------------------- */

const SESSION = {
  id: "s1", path: "/home/pi/s1.jsonl", cwd: "/projekt", name: "Test",
  created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z",
  messageCount: 1, firstMessage: "hi",
};
const sessionData = {
  sessionId: "s1", filePath: "/home/pi/s1.jsonl", totalActiveMs: 10, tree: [], leafId: "e1",
  contextUsage: { percent: 5, contextWindow: 1000, tokens: 50 },
  context: {
    messages: [{ role: "user", content: "hi", timestamp: 1 }], entryIds: ["e1"],
    thinkingLevel: "low", configuredThinkingLevel: "low", model: { provider: "p", modelId: "m" },
  },
};
const modelsData = {
  models: {}, modelList: [], defaultModel: null, modelError: null, modelScopeWarnings: [],
  thinkingLevels: {}, thinkingLevelMaps: {}, roles: [], thinkingLevelPins: {},
};
let agentGet = async () => ({ running: false, state: {} });
let postReply = async (body) => ({ data: null });
const requests = [];

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = (init.method ?? "GET").toUpperCase();
  requests.push([method, url, init]);
  const body = init.body ? JSON.parse(init.body) : null;
  const reply = (payload) => ({ ok: true, status: 200, json: async () => payload });

  if (method === "GET" && url.startsWith("/api/sessions/s1/state")) {
    return reply({ running: false, state: {} });
  }
  if (method === "GET" && url.startsWith("/api/sessions/s1/context")) {
    return reply({ context: { messages: [], entryIds: [] } });
  }
  if (method === "GET" && url.startsWith("/api/sessions/s1")) return reply(sessionData);
  if (method === "GET" && url.startsWith("/api/models")) return reply(modelsData);
  if (method === "GET" && url.startsWith("/api/agent/s1")) return reply(await agentGet());
  if (method === "POST" && url.startsWith("/api/agent/s1")) return reply(await postReply(body));
  return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
};

const { useAgentSession } = await jiti.import(`${ROOT}hooks/useAgentSession.ts`);

test.after(() => {
  globalThis.setTimeout = ORIGINALS.setTimeout;
  globalThis.setInterval = ORIGINALS.setInterval;
  globalThis.clearTimeout = realClearTimeout;
  globalThis.clearInterval = realClearInterval;
  for (const [key, value] of Object.entries(ORIGINALS)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});

const flush = async (ms = 0) => {
  await new Promise((resolve) => realSetTimeout(resolve, ms));
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => realSetTimeout(resolve, 0));
};

async function mount(extra = {}) {
  const seen = [];
  const chatInput = {
    inserted: [], insertedIfEmpty: [], restored: [], prepended: [],
    insertText: (text) => chatInput.inserted.push(text),
    insertIfEmpty: (text) => chatInput.insertedIfEmpty.push(text),
    restoreSubmission: (...args) => chatInput.restored.push(args),
    prependText: (text) => chatInput.prepended.push(text),
  };
  const endings = [];
  const options = {
    session: SESSION, newSessionCwd: null, chatInputRef: { current: chatInput },
    onAgentEnd: () => endings.push("end"),
    ...extra,
  };
  function Probe() {
    seen.push(useAgentSession(options));
    return null;
  }
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(Probe)); });
  await act(flush);
  return { seen, latest: () => seen.at(-1), root, chatInput, endings };
}

test("Verbindungsaufbau: settle ueber 'connected', Settlement nach Slash-Prompt, Grace schliesst", async () => {
  FakeEventSource.mode = "connect";
  FakeEventSource.instances.length = 0;
  agentGet = async () => ({ running: false, state: {} });
  postReply = async () => ({ data: null });
  requests.length = 0;
  const { latest, root, endings } = await mount();

  await act(async () => { await latest().handleSend("/hilfe"); });
  await act(async () => { await flush(25); });

  const sends = requests.filter(([m, url]) => m === "POST" && url === "/api/agent/s1");
  assert.equal(sends.length, 1);
  assert.equal(JSON.parse(sends[0][2].body).type, "prompt");
  // waitForPromptSettlement -> fetch auf /api/agent/s1, dann settle + Grace.
  assert.ok(requests.some(([m, url]) => m === "GET" && url === "/api/agent/s1"));
  assert.equal(FakeEventSource.instances[0].url, "/api/agent/s1/events");
  assert.equal(FakeEventSource.instances[0].closed, true);
  assert.equal(latest().agentRunning, false);
  assert.equal(endings.length, 1);

  await act(async () => { root.unmount(); });
});

test("ein geschlossener Stream wirft EventStreamConnectionError und stellt den Text wieder her", async () => {
  FakeEventSource.mode = "closed";
  FakeEventSource.instances.length = 0;
  requests.length = 0;
  const { latest, root, chatInput } = await mount();

  await act(async () => { await latest().handleSend("/verbinde"); });
  await act(async () => { await flush(10); });

  assert.equal(requests.filter(([m, url]) => m === "POST" && url === "/api/agent/s1").length, 0);
  assert.equal(latest().notices.at(-1).type, "error");
  assert.match(latest().notices.at(-1).message, /Failed to connect to the agent event stream/);
  assert.deepEqual(chatInput.restored[0][0], "/verbinde");
  assert.equal(latest().agentRunning, false);

  await act(async () => { root.unmount(); });
});

test("ein stiller Stream laeuft in den Timeout-Zweig", async () => {
  FakeEventSource.mode = "silent";
  FakeEventSource.instances.length = 0;
  const { latest, root } = await mount();

  await act(async () => { await latest().handleSend("/timeout"); });
  await act(async () => { await flush(15); });

  assert.match(latest().notices.at(-1).message, /Timed out connecting to the agent event stream/);

  await act(async () => { root.unmount(); });
});

test("Idle-Grace: laufender Prompt, Kompaktierung, Hintergrundarbeit und Fehler", async () => {
  FakeEventSource.mode = "connect";
  const { latest, root } = await mount();

  // (a) Prompt laeuft: Grace beendet sich nicht, der Agent bleibt sichtbar.
  agentGet = async () => ({ running: true, state: { isStreaming: true, isPromptRunning: false, isHandoffRunning: false } });
  await act(async () => { latest().handleAgentEventRef.current({ type: "agent_start" }); });
  await act(async () => { latest().handleAgentEventRef.current({ type: "agent_settled" }); });
  await act(async () => { await flush(20); });
  assert.equal(latest().agentRunning, true);
  assert.deepEqual(latest().agentPhase, { kind: "waiting_model" });

  // (b) Kompaktierung: pollt weiter, dann Hintergrundarbeit, dann idle.
  const queue = [
    { running: true, state: { isCompacting: true } },
    { running: true, state: {} },
    { running: false, state: {} },
  ];
  agentGet = async () => queue.shift() ?? { running: false, state: {} };
  await act(async () => { latest().handleAgentEventRef.current({ type: "agent_start" }); });
  await act(async () => { latest().handleAgentEventRef.current({ type: "agent_settled" }); });
  await act(async () => { await flush(30); });
  assert.equal(latest().isCompacting, true);

  // (c) fetch-Fehler: der Stream bleibt offen und pollt erneut, bis idle.
  let thrown = false;
  agentGet = async () => {
    if (!thrown) {
      thrown = true;
      throw new Error("offline");
    }
    return { running: false, state: {} };
  };
  await act(async () => { latest().handleAgentEventRef.current({ type: "agent_start" }); });
  await act(async () => { latest().handleAgentEventRef.current({ type: "agent_settled" }); });
  await act(async () => { await flush(30); });
  assert.equal(thrown, true);

  await act(async () => { root.unmount(); });
});

test("refresh, reconcile und visibilitychange laufen waehrend einer Runde", async () => {
  FakeEventSource.mode = "connect";
  requests.length = 0;
  agentGet = async () => ({
    running: true,
    state: {
      isStreaming: true,
      contextUsage: { percent: 40, contextWindow: 1000, tokens: 400 },
      queuedMessages: { steering: ["q"], followUp: [] },
      subagents: [{ id: "r1", index: 0, agent: "x", agentSource: "bundled", status: "running", lastUpdate: 2 }],
    },
  });
  const { latest, root } = await mount();
  await act(async () => { latest().handleAgentEventRef.current({ type: "agent_start" }); });
  await act(async () => { await flush(20); });

  assert.equal(latest().contextUsage.tokens, 400);
  assert.ok(latest().subagents.some((s) => s.id === "r1"));
  const before = requests.filter(([m, url]) => m === "GET" && url === "/api/agent/s1").length;
  assert.ok(before > 0, "refresh pollt den Zustand");

  win.document.dispatchEvent(new win.Event("visibilitychange"));
  win.dispatchEvent(new win.Event("online"));
  await act(async () => { await flush(20); });
  assert.ok(requests.filter(([m, url]) => m === "GET" && url === "/api/agent/s1").length > before);

  // Der Reconciler beendet die Runde, wenn der Server idle meldet.
  agentGet = async () => ({ running: false, state: {} });
  await act(async () => { await flush(30); });
  assert.equal(latest().agentRunning, false);

  await act(async () => { root.unmount(); });
});

test("eingebaute Slash-Befehle: name, copy, session, compact, reload, handoff, unbekannt", async () => {
  FakeEventSource.mode = "connect";
  copied.length = 0;
  let statsPanel = 0;
  postReply = async (body) => {
    switch (body?.type) {
      case "set_session_name": return { data: null };
      case "get_last_assistant_text": return { data: { text: "letzte Antwort" } };
      case "get_session_stats": return { data: { sessionId: "s1", userMessages: 1 } };
      case "compact": return { data: { tokensBefore: 500, estimatedTokensAfter: 50 } };
      case "reload": return { data: null };
      case "handoff": return { data: { cancelled: false } };
      case "execute_slash_command": return { data: { handled: false } };
      default: return { data: null };
    }
  };
  const { latest, root, chatInput } = await mount({ onSessionStatsPanelOpen: () => { statsPanel += 1; } });

  let result = await act(async () => latest().handleBuiltinSlashCommand("/name Neuer Name"));
  assert.deepEqual(result, { handled: true, message: "Session renamed to Neuer Name" });
  assert.equal(latest().notices.at(-1).type, "success");

  result = await act(async () => latest().handleBuiltinSlashCommand("/copy"));
  assert.deepEqual(result, { handled: true, message: "Copied last assistant message" });
  assert.deepEqual(copied, ["letzte Antwort"]);

  result = await act(async () => latest().handleBuiltinSlashCommand("/session"));
  assert.deepEqual(result, { handled: true, action: "openSessionStats" });
  assert.equal(statsPanel, 1);

  result = await act(async () => latest().handleBuiltinSlashCommand("/compact jetzt"));
  assert.deepEqual(result, { handled: true, message: "Compacted context" });
  assert.deepEqual(latest().compactResult, { reason: "manual", tokensBefore: 500, estimatedTokensAfter: 50 });

  result = await act(async () => latest().handleBuiltinSlashCommand("/reload"));
  assert.deepEqual(result, { handled: true, message: "Reloaded session resources" });

  result = await act(async () => latest().handleBuiltinSlashCommand("/handoff"));
  assert.deepEqual(result, { handled: true, message: "Context handed off and compacted in place" });

  result = await act(async () => latest().handleBuiltinSlashCommand("/gibtsnicht"));
  assert.deepEqual(result, { handled: true, error: "Unknown command: /gibtsnicht" });
  // Bei fuenf sichtbaren Notices wartet die sechste in pending und rueckt erst
  // nach der Ausblendanimation nach.
  await act(async () => { await flush(20); });
  assert.ok(latest().notices.some((notice) => notice.type === "error"));

  // Befehle, die einen Prompt zurueckgeben, laufen nicht durch `complete`.
  postReply = async (body) => body?.type === "goal"
    ? { data: { status: { active: true }, message: "zeile1\nzeile2", prompt: "nimm das" } }
    : { data: null };
  result = await act(async () => latest().handleBuiltinSlashCommand("/goal"));
  assert.deepEqual(result, { handled: true, prompt: "nimm das" });
  assert.equal(latest().messages.at(-1).role, "custom");
  assert.match(latest().messages.at(-1).content, /zeile1/);

  // Ein Fehler im Befehl landet als Notice statt als Throw.
  postReply = async () => { throw new Error("kaputt"); };
  result = await act(async () => latest().handleBuiltinSlashCommand("/name x"));
  assert.deepEqual(result, { handled: true, error: "kaputt" });
  assert.equal(chatInput.restored.length, 0);

  await act(async () => { root.unmount(); });
});

test("eine eingeschobene Nachricht laesst die eigene User-Nachricht nicht doppelt erscheinen", async () => {
  FakeEventSource.mode = "connect";
  FakeEventSource.instances.length = 0;
  agentGet = async () => ({ running: true, state: { isStreaming: true, isPromptRunning: true } });
  postReply = async () => ({ data: null });
  requests.length = 0;
  const { latest, root } = await mount();
  const fire = async (event) => {
    await act(async () => { latest().handleAgentEventRef.current(event); });
  };

  await act(async () => { await latest().handleSend("Bitte immer prasent"); });
  const own = () => latest().messages.filter(
    (message) => message.role === "user" && message.content === "Bitte immer prasent",
  );
  assert.equal(own().length, 1);

  // Der abgebrochene Turn schreibt eine leere Assistant-Nachricht zwischen den
  // optimistischen Bubble und die echte User-Nachricht — wie in den Dateien auf
  // dem Live-Host (stopReason "aborted", content []).
  await fire({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted", timestamp: 2 } });
  await fire({ type: "message_end", message: { role: "user", content: "Bitte immer prasent", timestamp: 3 } });
  assert.equal(own().length, 1);

  // Eine echte Queue-Zustellung mit eigenem Text kommt weiterhin an.
  await fire({ type: "message_end", message: { role: "user", content: "und jetzt anders", timestamp: 4 } });
  assert.equal(latest().messages.filter((message) => message.role === "user").length, 3);

  await act(async () => { root.unmount(); });
});

// Gemessen auf dem Live-Host: omp schickt den Prompt eines abgebrochenen Turns
// als Steering-Nachricht erneut, und zwar nachdem der optimistische Bubble
// bereits durch die echte Nachricht ersetzt wurde (kein offener Key mehr). Die
// alte Regel haengte den Text dann ein zweites Mal an — fuer den Operator sah
// das aus, als haette das System seine Nachricht wiederholt geschickt.
test("ein Steering-Echo desselben Prompts haengt keine zweite User-Zeile an", async () => {
  FakeEventSource.mode = "connect";
  FakeEventSource.instances.length = 0;
  agentGet = async () => ({ running: true, state: { isStreaming: true, isPromptRunning: true } });
  postReply = async () => ({ data: null });
  requests.length = 0;
  const { latest, root } = await mount();
  const fire = async (event) => {
    await act(async () => { latest().handleAgentEventRef.current(event); });
  };
  const own = () => latest().messages.filter(
    (message) => message.role === "user" && message.content === "Bitte immer prasent",
  );

  await act(async () => { await latest().handleSend("Bitte immer prasent"); });
  // Die echte Prompt-Nachricht ersetzt den optimistischen Bubble.
  await fire({ type: "message_end", message: { role: "user", content: "Bitte immer prasent", timestamp: 2 } });
  await fire({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted", timestamp: 3 } });
  // Das Echo traegt das Steering-Flag — dieselbe Nachricht, kein zweiter Prompt.
  await fire({ type: "message_end", message: { role: "user", content: "Bitte immer prasent", steering: true, timestamp: 4 } });
  assert.equal(own().length, 1);

  // Ein echter Steering-Prompt mit eigenem Text bleibt eine Zeile.
  await fire({ type: "message_end", message: { role: "user", content: "Bitte immer prasent, aber kurz", steering: true, timestamp: 5 } });
  assert.equal(
    latest().messages.filter((message) => message.role === "user" && message.content === "Bitte immer prasent, aber kurz").length,
    1,
  );
  assert.equal(own().length, 1);

  await act(async () => { root.unmount(); });
});
