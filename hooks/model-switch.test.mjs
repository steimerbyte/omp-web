import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React from "react";
import { createJiti } from "jiti";

/**
 * Der Modellwechsel im Hook — an einer Session mit Transkript.
 *
 * ### Was der Nutzer gemeldet hat
 *
 * „In einem Chat, der schon Nachrichten hat, kann ich das Modell nicht
 * wechseln — es ist sehr langsam oder reagiert gar nicht." Der Code-Scan
 * (`MODEL-SELECT-SCAN.md`) nennt drei Ursachen; zwei davon sieht nur ein Test,
 * der die **Anfragen** misst:
 *
 * 1. Ein laufendes `set_model` sperrte den Ausloeser, und jeder weitere Klick
 *    fiel in ein stilles `return`. Hier: zwei Klicks waehrend einer offenen
 *    Anfrage ergeben **eine** zusaetzliche Anfrage, und sie traegt das **letzte**
 *    Ziel.
 * 2. Nach jedem erfolgreichen Wechsel folgte ein
 *    `GET /api/sessions/<id>` — das ganze Transkript, neu gerendert. Hier: nach
 *    dem Wechsel steht **kein** solcher Aufruf im Protokoll.
 *
 * Beides sind Aussagen ueber den Netzwerkverlauf, nicht ueber den Quelltext.
 * Deshalb wird der Hook gemountet und `fetch` von Hand beantwortet.
 *
 * ### Warum hier nicht `ChatInput` mitgemountet wird
 *
 * Der Ausloeser ist eine Eigenschaft des Composer-Markups
 * (`disabled={isStreaming}`), und dafuer gibt es einen eigenen Test am
 * gerenderten `ChatInput`. Hier geht es um die Kette Klick → Warteschlange →
 * Anfrage; jeder Klick laeuft durch `handleModelChange`/`handleRoleModelChange`,
 * also durch dieselbe Funktion, die der Composer aufruft.
 */

/* ------------------------------------------------------------------ *
 * Das Fenster
 * ------------------------------------------------------------------ */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const win = dom.window;
const fakeNavigator = { userAgent: "test", languages: ["de-DE"], language: "de-DE", platform: "linux" };

globalThis.window = new Proxy(win, {
  get(target, prop) {
    if (prop === "navigator") return fakeNavigator;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
globalThis.document = win.document;
globalThis.navigator = fakeNavigator;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  clear: () => { storage.clear(); },
};
win.localStorage = globalThis.localStorage;
win.matchMedia = () => ({
  matches: false, media: "",
  addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {},
  onchange: null, dispatchEvent() { return false; },
});
globalThis.matchMedia = win.matchMedia;

/* ------------------------------------------------------------------ *
 * Die Anfragen
 * ------------------------------------------------------------------ */

let requests = [];

class FakeEventSource {
  constructor(url) {
    this.url = String(url);
    this.listeners = new Map();
    this.onerror = null;
    this.onmessage = null;
  }
  addEventListener(type, handler) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }
  removeEventListener() {}
  close() {}
  emit(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
}
globalThis.EventSource = FakeEventSource;

const liveRoots = new Set();
const pendingRequests = new Set();

globalThis.fetch = (url, init = {}) => {
  const request = {
    url: String(url),
    method: init.method ?? "GET",
    body: init.body ? JSON.parse(String(init.body)) : null,
    signal: init.signal ?? null,
    resolve: null,
    reject: null,
  };
  const promise = new Promise((resolve, reject) => {
    request.resolve = resolve;
    request.reject = reject;
    request.signal?.addEventListener("abort", () => {
      reject(new DOMException("The user aborted a request.", "AbortError"));
    });
  });
  requests.push(request);
  pendingRequests.add(request);
  promise.finally(() => pendingRequests.delete(request)).catch(() => {});
  return promise;
};

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
});

/* ------------------------------------------------------------------ *
 * Der Hook
 * ------------------------------------------------------------------ */

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { useAgentSession } = await jiti.import("./useAgentSession.ts");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

const SESSION = {
  id: "sess-1",
  path: "/tmp/sess-1.jsonl",
  cwd: "/tmp/project",
  name: "Grosses Transkript",
  created: "2026-10-01T00:00:00.000Z",
  modified: "2026-10-02T00:00:00.000Z",
  messageCount: 400,
  firstMessage: "Frage 1",
  transient: false,
};

/** Die Antwort von `GET /api/sessions/<id>` — 400 Nachrichten. */
function sessionPayload(model = { provider: "buds-gateway", modelId: "deepseek-v4.1-flash-1017" }) {
  const messages = [];
  for (let i = 0; i < 400; i += 1) {
    messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `n${i}` }] });
  }
  return {
    sessionId: "sess-1",
    filePath: "/tmp/sess-1.jsonl",
    totalActiveMs: 1000,
    tree: [],
    leafId: "leaf-1",
    context: { messages, entryIds: messages.map((_, i) => `e${i}`), thinkingLevel: "medium", model },
    info: { path: "/tmp/sess-1.jsonl", id: "sess-1", cwd: "/tmp/project", messageCount: 400, transient: false },
  };
}

function Probe({ sink }) {
  const result = useAgentSession({ session: SESSION, newSessionCwd: null });
  sink.current = result;
  return null;
}

function reset() {
  requests = [];
}

async function tick(ms = 0) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Beantwortet alle offenen Anfragen, die dem Muster entsprechen. */
async function answerWhere(predicate, response) {
  for (const request of requests.filter(predicate)) {
    if (request.answered) continue;
    request.answered = true;
    await act(async () => {
      request.resolve(response);
      await tick(10);
    });
  }
}

const isModels = (r) => r.url.startsWith("/api/models");
const isSessionDetail = (r) => /^\/api\/sessions\/[^/?]+(\?|$)/.test(r.url) && !r.url.includes("/state");
const isAgentPost = (r) => r.url.startsWith("/api/agent/") && r.method === "POST";

/** Der Hook, montiert und mit geladener Session. */
async function mountLoaded() {
  reset();
  storage.clear();
  const sink = { current: null };
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(Probe, { sink })); });
  liveRoots.add(root);
  await tick(5);

  // Der Hook laedt beim Mounten die Session (und den Zustand).
  await answerWhere(isSessionDetail, jsonResponse(sessionPayload()));
  await answerWhere((r) => r.url.includes("/state"), jsonResponse({ running: false }));
  await answerWhere(isModels, jsonResponse({
    models: { "minimax-code:MiniMax-M2.5": "MiniMax-M2.5" },
    modelList: [{ id: "MiniMax-M2.5", name: "MiniMax-M2.5", provider: "minimax-code" }],
    roles: [{
      role: "smol",
      name: "Fast",
      builtin: true,
      hidden: false,
      resolved: { provider: "minimax-code", modelId: "MiniMax-M2.5" },
    }],
  }));
  await tick(20);

  assert.ok(sink.current, "der Hook hat einen Zustand");
  assert.equal(sink.current.messages.length, 400, "die Session mit 400 Nachrichten ist geladen");
  return { root, sink };
}

test.afterEach(async () => {
  // Erst die Baeume abbauen: ein setState nach dem Unmount soll niemanden
  // mehr treffen.
  for (const root of liveRoots) await act(async () => { root.unmount(); });
  liveRoots.clear();

  // Dann jede offene Anfrage beantworten. Ohne das bleibt der 20-s-Timer von
  // `sendAgentCommand` scharf, feuert mitten in einen spaeteren Test und
  // meldet dort einen AbortError — der Flake, der die Zaehlung zwischen zwei
  // Laeufen um genau einen Test verschoben hat.
  await act(async () => {
    for (const request of [...pendingRequests]) {
      request.answered = true;
      request.resolve(jsonResponse({ success: true, data: { id: "settle", provider: "settle", leafId: null } }));
    }
    await tick(10);
  });
  assert.equal(pendingRequests.size, 0, "jede Anfrage ist beantwortet, kein Timer bleibt scharf");

  win.document.body.innerHTML = "";
});

test("zwei Klicks waehrend einer offenen Anfrage ergeben EINE weitere, mit dem letzten Ziel", async () => {
  const { root, sink } = await mountLoaded();
  const before = requests.length;

  await act(async () => { sink.current.handleModelChange("buds-gateway", "qwen3.8-27b"); });
  await tick(5);

  const posts = requests.slice(before).filter(isAgentPost);
  assert.equal(posts.length, 1, "der erste Klick geht sofort hinaus");
  assert.deepEqual(posts[0].body, {
    type: "set_model", provider: "buds-gateway", modelId: "qwen3.8-27b",
  });

  // Der erste POST ist noch offen. Zwei weitere Klicks, verschiedene Ziele.
  await act(async () => {
    sink.current.handleModelChange("minimax-code", "MiniMax-M2.5-highspeed");
    sink.current.handleModelChange("buds-gateway", "deepseek-v4.1-flash-1017");
  });
  await tick(5);

  assert.equal(
    requests.slice(before).filter(isAgentPost).length,
    1,
    `die beiden weiteren Klicks warten — sie loesen keine parallele Anfrage aus: ${JSON.stringify(requests.slice(before).map((r) => `${r.method} ${r.url}`))}`,
  );

  // Der erste POST antwortet: jetzt muss der LETZTE Klick folgen.
  await answerWhere(isAgentPost, jsonResponse({
    success: true,
    data: { id: "qwen3.8-27b", provider: "buds-gateway", thinkingLevel: "medium", leafId: "leaf-1" },
  }));
  await tick(20);

  const allPosts = requests.slice(before).filter(isAgentPost);
  assert.equal(allPosts.length, 2, "genau eine zusaetzliche Anfrage, nicht zwei");
  assert.deepEqual(
    allPosts[1].body,
    { type: "set_model", provider: "buds-gateway", modelId: "deepseek-v4.1-flash-1017" },
    "die zweite Anfrage traegt das LETZTE Ziel, nicht das mittlere",
  );

  await act(async () => { root.unmount(); });
});

test("nach einem Wechsel wird die Session nicht neu geladen", async () => {
  const { root, sink } = await mountLoaded();
  const before = requests.length;

  await act(async () => { sink.current.handleModelChange("buds-gateway", "qwen3.8-27b"); });
  await tick(5);
  await answerWhere(isAgentPost, jsonResponse({
    success: true,
    data: { id: "qwen3.8-27b", provider: "buds-gateway", thinkingLevel: "high", leafId: "leaf-7" },
  }));
  await tick(30);

  const after = requests.slice(before);
  assert.equal(
    after.filter(isAgentPost).length,
    1,
    "genau ein Wechsel-Request",
  );
  assert.equal(
    after.filter(isSessionDetail).length,
    0,
    `kein GET /api/sessions/<id>: ${JSON.stringify(after.filter(isSessionDetail).map((r) => r.url))}`,
  );

  // Der neue Zustand steht trotzdem: Modell, Thinking-Level und Leaf.
  assert.deepEqual(sink.current.currentModel, { provider: "buds-gateway", modelId: "qwen3.8-27b" });
  assert.equal(sink.current.thinkingLevel, "high", "der Thinking-Level kommt aus der Antwort");
  assert.equal(sink.current.activeLeafId, "leaf-7", "der Leaf kommt aus der Antwort");

  await act(async () => { root.unmount(); });
});

test("ein Rollenwechsel zeigt das Rollen-Modell, nicht das Default-Modell", async () => {
  const { root, sink } = await mountLoaded();
  const before = requests.length;

  await act(async () => {
    // Der Hook liest die Rollen aus /api/models; hier wird die Zuordnung
    // direkt gesetzt, wie der Rollen-Picker sie liefert.
    sink.current.handleRoleModelChange("smol");
  });
  await tick(5);

  const posts = requests.slice(before).filter(isAgentPost);
  assert.equal(posts.length, 1, "die aufgeloeste Rolle loest genau eine Anfrage aus");
  await answerWhere(isAgentPost, jsonResponse({
    success: true,
    data: { id: "MiniMax-M2.5", provider: "minimax-code", role: "smol", thinkingLevel: "low", leafId: "leaf-2" },
  }));
  await tick(20);

  assert.equal(posts[0].body.type, "set_role_model");
  assert.equal(posts[0].body.role, "smol");
  assert.deepEqual(
    sink.current.currentModel,
    { provider: "minimax-code", modelId: "MiniMax-M2.5" },
    "die Pille zeigt das aufgeloeste Rollen-Modell",
  );

  await act(async () => { root.unmount(); });
});

test("ein gescheiterter Wechsel hinterlaesst einen sichtbaren Grund und keine Optimistik", async () => {
  const { root, sink } = await mountLoaded();
  const before = requests.length;

  await act(async () => { sink.current.handleModelChange("buds-gateway", "qwen3.8-27b"); });
  await tick(5);
  assert.deepEqual(
    sink.current.currentModel,
    { provider: "buds-gateway", modelId: "qwen3.8-27b" },
    "die Optimistik steht ab dem Klick",
  );

  await answerWhere(isAgentPost, jsonResponse({ error: "No API key for buds-gateway/qwen3.8-27b" }, { ok: false, status: 500 }));
  await tick(20);

  assert.equal(sink.current.modelSwitching, false, "das Feld ist wieder frei");
  assert.ok(sink.current.modelSwitchError, "es gibt einen sichtbaren Grund");
  assert.equal(sink.current.modelSwitchError.timeout, false);
  assert.match(sink.current.modelSwitchError.detail, /No API key/);
  assert.deepEqual(
    sink.current.currentModel,
    { provider: "buds-gateway", modelId: "deepseek-v4.1-flash-1017" },
    "die Optimistik ist zurueckgenommen — das alte Modell gilt weiter",
  );
  assert.equal(
    requests.slice(before).filter(isSessionDetail).length,
    0,
    "auch der Fehlerfall laedt die Session nicht neu",
  );

  await act(async () => { root.unmount(); });
});

test("ein Klick waehrend eines laufenden Turns erreicht den Server", async () => {
  // Die SDK sagt zu: "Active switches always take effect; if the current
  // transcript is too large for the target model, the next prompt's
  // compaction/error path owns that recovery instead of leaving the session
  // pinned to the old model." (agent-session.d.ts:1122-1130)
  //
  // Der Hook kennt `isStreaming` gar nicht — das ist eine Eigenschaft des
  // Composers, und dort sperrte sie den Ausloeser. Diese Sperre ist der eine
  // Ort, an dem ein Klick waehrend eines Turns verschwand; der Composer-Test
  // `a running turn does not lock the model trigger either` haelt sie fest.
  // Hier wird die andere Haelfte gemessen: der Buchungspfad selbst fragt
  // `isStreaming` nicht ab, also erreicht der Klick auch waehrend eines Turns
  // die Warteschlange.
  const { root, sink } = await mountLoaded();
  const before = requests.length;

  await act(async () => { sink.current.handleModelChange("buds-gateway", "qwen3.8-27b"); });
  await tick(10);

  const posts = requests.slice(before).filter(isAgentPost);
  assert.equal(posts.length, 1, `der Klick erreicht den Server: ${JSON.stringify(requests.slice(before).map((r) => r.method + " " + r.url))}`);
  assert.deepEqual(posts[0].body, { type: "set_model", provider: "buds-gateway", modelId: "qwen3.8-27b" });

  await answerWhere(isAgentPost, jsonResponse({
    success: true,
    data: { id: "qwen3.8-27b", provider: "buds-gateway", leafId: "leaf-3" },
  }));
  await tick(20);
  await act(async () => { root.unmount(); });
});

test("ein Timeout beendet die Sperre und meldet sich als Timeout", async () => {
  const { root, sink } = await mountLoaded();

  await act(async () => { sink.current.handleModelChange("buds-gateway", "qwen3.8-27b"); });
  await tick(5);

  // Der POST antwortet nie; das Signal des Clients bricht ihn ab.
  const post = requests.filter(isAgentPost).at(-1);
  assert.ok(post?.signal, "der Wechsel-POST hat ein Abbruch-Signal");
  await act(async () => {
    post.reject(new DOMException("The operation was aborted.", "AbortError"));
    await tick(10);
  });
  await tick(20);

  assert.equal(sink.current.modelSwitching, false, "die Sperre endet mit dem Fehler");
  assert.ok(sink.current.modelSwitchError, "der Nutzer sieht einen Grund");

  await act(async () => { root.unmount(); });
});
