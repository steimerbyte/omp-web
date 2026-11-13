// Der bestehende useAgentSession-Test liest nur den Quelltext; hier laeuft der
// Hook. Der Event-Handler wird direkt ueber den zurueckgegebenen Ref gerufen —
// das ist derselbe Pfad, den die SSE-Verbindung nimmt, ohne einen Server.
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
};

globalThis.window = win;
globalThis.document = win.document;
globalThis.HTMLElement = win.HTMLElement;
globalThis.Element = win.Element;
Object.defineProperty(win.document, "visibilityState", { value: "visible", configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Der Notice-Lebenszyklus haengt an 5 s und 180 ms. Statt zu warten, werden
// alle langen Timer eingesammelt und im Test von Hand ausgefuehrt.
const manualTimers = new Map();
let timerSeq = 0;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  if (typeof ms === "number" && ms >= 100) {
    const id = ++timerSeq;
    manualTimers.set(id, () => fn(...args));
    return id;
  }
  return realSetTimeout(fn, ms, ...args);
};
globalThis.clearTimeout = (id) => {
  if (manualTimers.delete(id)) return;
  realClearTimeout(id);
};
const runTimers = () => {
  for (const [id, fn] of [...manualTimers]) {
    manualTimers.delete(id);
    fn();
  }
};

/* ---------------------------- fetch Fixtures ---------------------------- */

const SESSION = {
  id: "s1", path: "/home/pi/s1.jsonl", cwd: "/projekt", name: "Test",
  created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z",
  messageCount: 1, firstMessage: "hi",
};
const sessionData = {
  sessionId: "s1",
  filePath: "/home/pi/s1.jsonl",
  totalActiveMs: 1234,
  tree: [{ id: "e1" }],
  leafId: "e1",
  contextUsage: { percent: 10, contextWindow: 1000, tokens: 100 },
  context: {
    messages: [{ role: "user", content: "hi", timestamp: 1 }],
    entryIds: ["e1"],
    thinkingLevel: "low",
    configuredThinkingLevel: "low",
    model: { provider: "p", modelId: "m" },
  },
};
const modelsData = {
  models: { m: "M" },
  modelList: [{ id: "m", name: "M", provider: "p" }],
  defaultModel: null,
  modelError: null,
  modelScopeWarnings: [],
  thinkingLevels: {},
  thinkingLevelMaps: {},
  roles: [],
  thinkingLevelPins: {},
};
let sessionState = {
  running: false,
  state: {
    contextUsage: { percent: 20, contextWindow: 1000, tokens: 200 },
    systemPrompt: "sys",
    thinkingLevel: "low",
    configuredThinkingLevel: "medium",
    model: { id: "m", provider: "p" },
    extensionWidgets: [{ key: "w", lines: ["a"], placement: "aboveEditor" }],
    queuedMessages: { steering: ["wartet"], followUp: [] },
    subagents: [{ id: "a-state", index: 0, agent: "x", agentSource: "bundled", status: "completed", lastUpdate: 5 }],
    goal: { active: true, text: "ziel" },
    vibe: { active: false },
    isCompacting: false,
    isBashRunning: false,
  },
};
let agentState = { running: false, state: {} };
const commands = [];
const requests = [];

const commandReply = (body) => {
  commands.push(body);
  switch (body?.type) {
    case "get_tools": return { data: [] };
    case "get_commands": return { data: { commands: [{ name: "help" }] } };
    case "compact": return { data: { tokensBefore: 900, estimatedTokensAfter: 100 } };
    case "get_last_assistant_text": return { data: { text: "letzte Antwort" } };
    case "get_session_stats": return { data: { sessionId: "s1", userMessages: 1, assistantMessages: 1 } };
    case "execute_slash_command": return { data: { handled: false } };
    default: return { data: null };
  }
};

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = (init.method ?? "GET").toUpperCase();
  requests.push([method, url, init]);
  const body = init.body ? JSON.parse(init.body) : null;
  const reply = (payload) => ({ ok: true, status: 200, json: async () => payload });

  if (method === "GET" && url.startsWith("/api/sessions/s1/state")) return reply(sessionState);
  if (method === "GET" && url.startsWith("/api/sessions/s1/context")) {
    return reply({ context: { messages: [{ role: "user", content: "kontext", timestamp: 9 }], entryIds: ["e2"] } });
  }
  if (method === "GET" && url.startsWith("/api/sessions/s1")) return reply(sessionData);
  if (method === "GET" && url.startsWith("/api/models")) return reply(modelsData);
  if (method === "GET" && url.startsWith("/api/agent/s1")) return reply(agentState);
  if (method === "POST" && url.startsWith("/api/agent/s1")) return reply(commandReply(body));
  return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
};

const { useAgentSession } = await jiti.import(`${ROOT}hooks/useAgentSession.ts`);

test.after(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  for (const [key, value] of Object.entries(ORIGINALS)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => realSetTimeout(resolve, 0));
};

async function mount(extra = {}) {
  const seen = [];
  const chatInput = {
    insertText: (text) => { chatInput.inserted.push(text); },
    insertIfEmpty: (text) => { chatInput.insertedIfEmpty.push(text); },
    restoreSubmission: (...args) => { chatInput.restored.push(args); },
    prependText: (text) => { chatInput.prepended.push(text); },
    inserted: [], insertedIfEmpty: [], restored: [], prepended: [],
  };
  const options = {
    session: SESSION,
    newSessionCwd: null,
    chatInputRef: { current: chatInput },
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
  const latest = () => seen.at(-1);
  const fire = async (event) => {
    await act(async () => { latest().handleAgentEventRef.current(event); });
  };
  return { seen, latest, fire, root, chatInput };
}

test("event handler: streaming, messages, tools, notices, subagents, compaction, extension UI", async () => {
  const notices = [];
  const ends = [];
  const attention = [];
  const { latest, fire, root, chatInput, seen } = await mount({
    onAgentEnd: () => ends.push("end"),
    onAttentionNeeded: (request) => attention.push(request),
  });

  // Reducer-Default: ein unbekannter Dispatch aendert nichts.
  await act(async () => { latest().dispatch({ type: "unbekannt" }); });
  assert.equal(latest().streamState.isStreaming, false);

  await fire({ type: "agent_start" });
  assert.equal(latest().agentRunning, true);
  assert.deepEqual(latest().agentPhase, { kind: "waiting_model" });

  await fire({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "hallo" }], timestamp: 1 } });
  assert.equal(latest().streamState.isStreaming, true);

  await fire({ type: "message_update", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { cmd: "ls" } }] } });
  assert.equal(latest().streamState.streamingMessage.content[0].toolCallId, "t1");

  // Ein User-Streaming-Event wird ignoriert.
  await fire({ type: "message_update", message: { role: "user", content: "nein" } });
  assert.equal(latest().streamState.streamingMessage.content[0].toolCallId, "t1");

  // User-Message mit String-Inhalt (extractMessageText, userMessageKey-String).
  await fire({ type: "message_end", message: { role: "user", content: "hallo", timestamp: 2 } });
  assert.equal(latest().messages.at(-1).content, "hallo");

  // User-Message mit Text + allen drei Bildformen (imageSignature-Zweige).
  await fire({
    type: "message_end",
    message: {
      role: "user",
      timestamp: 3,
      content: [
        { type: "text", text: "sieh" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
        { type: "image", source: { type: "url", url: "https://x/y.png" } },
        { type: "image", data: "BBB", mimeType: "image/jpeg" },
        { type: "text", text: 42 },
      ],
    },
  });
  assert.equal(latest().messages.at(-1).content.length, 5);

  // Ohne Content: extractMessageText liefert "".
  await fire({ type: "message_end", message: { role: "user", timestamp: 4 } });
  assert.equal(latest().messages.length, 4);

  // Assistant-Message: landet im Transkript, Stream wird zurueckgesetzt.
  await fire({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "antwort" }], timestamp: 5 } });
  assert.equal(latest().messages.length, 5);
  assert.equal(latest().streamState.isStreaming, false);
  assert.deepEqual(latest().agentPhase, { kind: "waiting_model" });

  // Tool-Phasen.
  await fire({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" });
  assert.equal(latest().agentPhase.kind, "running_tools");
  await fire({ type: "tool_execution_start", toolCallId: "t2", toolName: "read" });
  await fire({ type: "tool_execution_end", toolCallId: "t1" });
  assert.deepEqual(latest().agentPhase.tools.map((t) => t.id), ["t2"]);
  await fire({ type: "tool_execution_end", toolCallId: "t2" });
  assert.deepEqual(latest().agentPhase, { kind: "waiting_model" });
  await fire({ type: "tool_execution_end", toolCallId: "t3" });
  assert.deepEqual(latest().agentPhase, { kind: "waiting_model" });

  // Notices: prompt_error/extension_error + die fünf Extension-UI-Methoden.
  await fire({ type: "prompt_error" });
  assert.equal(latest().notices.at(-1).message, "Command failed");
  await fire({ type: "extension_error", error: "kaputt" });
  assert.equal(latest().notices.at(-1).type, "error");
  await fire({ type: "extension_ui_request", method: "notify", id: "n1", message: "Hinweis", notifyType: "warning" });
  assert.equal(latest().notices.at(-1).message, "Hinweis");
  await fire({ type: "extension_ui_request", method: "setWidget", widgetKey: "w1", widgetLines: ["a", "b"] });
  assert.equal(latest().extensionWidgets.at(-1).placement, "aboveEditor");
  await fire({ type: "extension_ui_request", method: "setWidget", widgetKey: "w1" });
  assert.deepEqual(latest().extensionWidgets, [{ key: "w", lines: ["a"], placement: "aboveEditor" }]);
  await fire({ type: "extension_ui_request", method: "setTitle", title: "Neuer Titel" });
  assert.equal(win.document.title, "Neuer Titel");
  await fire({ type: "extension_ui_request", method: "set_editor_text", text: "eingefuegt" });
  assert.deepEqual(chatInput.inserted, ["eingefuegt"]);

  // Blockierender Dialog + Antwort.
  const dialog = { method: "confirm", id: "q1", title: "Weiter?", message: "sicher" };
  await fire({ type: "extension_ui_request", ...dialog });
  assert.deepEqual(attention.map((r) => r.id), ["q1"]);
  assert.equal(latest().extensionDialog.id, "q1");
  await act(async () => { await latest().respondToExtensionUi(dialog, { confirmed: true }); });
  assert.equal(latest().extensionDialog, null);
  assert.equal(commands.at(-1).type, "extension_ui_response");
  await act(async () => { await latest().sendExtensionCustomInput({ method: "custom", id: "c1" }, "abc"); });
  assert.equal(commands.at(-1).type, "extension_ui_input");

  const custom = { method: "custom", id: "c1", closed: false };
  await fire({ type: "extension_ui_request", ...custom });
  assert.equal(latest().extensionCustomUi.id, "c1");
  await fire({ type: "extension_ui_request", method: "custom", id: "c1", closed: true });
  assert.equal(latest().extensionCustomUi, null);
  await fire({ type: "extension_ui_request", method: "select", id: "q2", options: [] });
  assert.equal(latest().extensionDialog.id, "q2");

  // Queue, Retry, Goal, Vibe.
  await fire({ type: "queue_update", steering: ["a"], followUp: ["b"] });
  assert.deepEqual(latest().queuedMessages, { steering: ["a"], followUp: ["b"] });
  await fire({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "rate" });
  assert.equal(latest().retryInfo.attempt, 1);
  await fire({ type: "auto_retry_end" });
  assert.equal(latest().retryInfo, null);
  await fire({ type: "goal_status", status: { active: true } });
  assert.deepEqual(latest().goalStatus, { active: true });
  await fire({ type: "vibe_status", status: { active: true } });
  assert.deepEqual(latest().vibeStatus, { active: true });

  // Subagenten: start, progress, terminal (completed/failed/aborted).
  await fire({ type: "subagent_lifecycle", payload: { id: "sa1", index: 1, agent: "recherche", status: "started" } });
  assert.equal(latest().subagents.find((s) => s.id === "sa1").status, "running");
  await fire({
    type: "subagent_progress",
    payload: {
      index: 1, agent: "recherche",
      progress: { id: "sa1", index: 1, agent: "recherche", status: "running", description: "sucht", lastUpdate: 1, task: "t" },
    },
  });
  assert.equal(latest().subagents.find((s) => s.id === "sa1").progress.description, "sucht");
  await fire({ type: "subagent_lifecycle", payload: { id: "sa1", status: "completed" } });
  assert.equal(latest().subagents.find((s) => s.id === "sa1").status, "completed");
  await fire({ type: "subagent_lifecycle", payload: { id: "sa2", status: "failed" } });
  assert.equal(latest().subagents.find((s) => s.id === "sa2").status, "failed");
  await fire({ type: "subagent_lifecycle", payload: { id: "sa3", status: "aborted" } });
  assert.equal(latest().subagents.find((s) => s.id === "sa3").status, "aborted");
  await fire({ type: "subagent_lifecycle", payload: { id: "sa4" } });
  await fire({ type: "subagent_progress", payload: {} });

  // Kompaktierung: Start, gueltiges Ergebnis, Fehler, Abbruch, ungueltiges
  // Ergebnis (readCompactResult -> null).
  await fire({ type: "compaction_start" });
  assert.equal(latest().isCompacting, true);
  await fire({ type: "compaction_end", result: { tokensBefore: 900, estimatedTokensAfter: 100 }, reason: "auto" });
  assert.deepEqual(latest().compactResult, { reason: "auto", tokensBefore: 900, estimatedTokensAfter: 100 });
  await fire({ type: "auto_compaction_start" });
  await fire({ type: "auto_compaction_end", errorMessage: "kein Platz" });
  assert.equal(latest().compactError, "kein Platz");
  await fire({ type: "compaction_end", aborted: true });
  await fire({ type: "compaction_end", result: null, reason: "manual" });
  assert.equal(latest().compactResult, null);

  // agent_end liest den Zustand nach; agent_settled schliesst ab.
  agentState = {
    running: true,
    state: {
      contextUsage: { percent: 30, contextWindow: 1000, tokens: 300 },
      systemPrompt: "nachher",
      extensionWidgets: [],
      subagents: [{ id: "a-state2", index: 2, agent: "y", agentSource: "user", status: "running", lastUpdate: 7 }],
      goal: { active: false },
      vibe: null,
      queuedMessages: { steering: [], followUp: ["f"] },
    },
  };
  await fire({ type: "agent_end" });
  await act(flush);
  assert.equal(latest().systemPrompt, "nachher");
  assert.equal(latest().queuedMessages.followUp.length, 1);
  assert.ok(latest().subagents.some((s) => s.id === "a-state2"));
  assert.equal(latest().contextUsage.tokens, 300);

  await fire({ type: "agent_settled" });
  assert.equal(latest().agentRunning, false);
  assert.equal(ends.length >= 1, true);

  await fire({ type: "prompt_done" });
  await act(flush);

  await act(async () => { root.unmount(); });
});

test("Notice-Ueberlauf: pending rueckt nach, sobald der aelteste ausblendet", async () => {
  manualTimers.clear();
  const { latest, fire, root } = await mount();
  for (let i = 1; i <= 6; i += 1) {
    await fire({ type: "extension_ui_request", method: "notify", id: `n${i}`, message: `M${i}`, notifyType: "info" });
  }
  assert.equal(latest().notices.length, 5);
  assert.equal(latest().notices[0].message, "M1");
  assert.equal(latest().notices[0].exiting, true);
  // Noch nichts nachgerueckt: M6 wartet in pending.
  assert.equal(latest().notices.some((n) => n.message === "M6"), false);

  // 180-ms-Timer: entfernen, dann M6 nachruecken lassen.
  await act(async () => { runTimers(); });
  assert.equal(latest().notices.some((n) => n.message === "M1"), false);
  assert.equal(latest().notices.some((n) => n.message === "M6"), true);
  assert.equal(latest().notices.length, 5);

  // 5-s-Timer: der aelteste beginnt auszublenden.
  await act(async () => { runTimers(); });
  assert.equal(latest().notices[0].exiting, true);
  await act(async () => { runTimers(); });
  assert.equal(latest().notices.length, 4);

  await act(async () => { root.unmount(); });
});
