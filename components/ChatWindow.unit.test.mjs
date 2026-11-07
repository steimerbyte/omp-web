import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";

/**
 * `ChatWindow` end-to-end auf einem gemounteten DOM.
 *
 * Der Hook `useAgentSession` laeuft wirklich: `fetch` beantwortet den
 * Sitzungs- und Zustandsabruf, `EventSource` ist eine Attrappe, deren
 * `onmessage` die Tests direkt fuettern. Damit laufen die drei bisher
 * ungedeckten Stuecke des Fensters durch echte Zustaende:
 *
 *  - `phaseLabel` ueber die Phasen waiting_model, running_command und
 *    running_tools (1, 2 und >3 Werkzeuge);
 *  - `ProcessDetailsGroup` ueber einen abgeschlossenen Turn mit Antwort
 *    (eingeklappt, Klick klappt auf) und einen Turn ohne Antwort (offen);
 *  - `ExtensionDialog` (select/confirm/input/editor/ask/plan_review) sowie
 *    `ExtensionCustomPanel` inklusive `renderAnsiLine`.
 */
const ORIGINALS = {
  fetch: globalThis.fetch,
  EventSource: globalThis.EventSource,
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
};
const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
restoreLinkedomPrototypesOnExit(win);
win.Element.prototype.scrollTo = function scrollTo() {};
win.Element.prototype.scrollIntoView = function scrollIntoView() {};
win.HTMLElement.prototype.focus = function focus() {
  Object.defineProperty(win.document, "activeElement", { configurable: true, value: this });
};
win.window = win;
const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux", clipboard: { writeText: async () => {} } };
globalThis.window = new Proxy(win, {
  get(target, prop) {
    if (prop === "navigator") return fakeNavigator;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
globalThis.document = win.document;
globalThis.navigator = fakeNavigator;
win.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null });
globalThis.matchMedia = win.matchMedia;
win.getComputedStyle = () => new Proxy({}, { get: (_t, p) => (typeof p === "string" && p.startsWith("get") ? () => "" : "0px") });
win.innerHeight = 900;
win.innerWidth = 1200;
win.scrollTo = () => {};
for (const [key, value] of Object.entries(linkedom)) {
  if (key !== "parseHTML" && key !== "default" && typeof value === "function" && /^[A-Z]/.test(key)) {
    globalThis[key] = value;
  }
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
};
win.localStorage = globalThis.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = FakeEventSource.OPEN;
  onmessage = null;
  onerror = null;
  constructor(url) {
    this.url = url;
    instances.push(this);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}
const instances = [];
globalThis.EventSource = FakeEventSource;
win.EventSource = FakeEventSource;

/* ── Fixtures ──────────────────────────────────────────────────────────── */

const at = (minute) => Date.UTC(2026, 0, 1, 12, minute);
const user = (text, minute) => ({ role: "user", content: text, timestamp: at(minute) });
const assistant = (content, minute) => ({ role: "assistant", provider: "test", model: "m", content, timestamp: at(minute) });
const result = (toolCallId, toolName, text, minute) => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content: [{ type: "text", text }],
  timestamp: at(minute),
});

const MESSAGES = [
  user("first question", 0),
  assistant([{ type: "toolCall", toolCallId: "t1", toolName: "read", input: { path: "/a" } }], 1),
  result("t1", "read", "file body", 1),
  assistant([{ type: "text", text: "first answer" }], 2),
  user("second question", 3),
  assistant([{ type: "text", text: "second answer" }], 4),
  user("third question", 5),
  assistant([{ type: "toolCall", toolCallId: "t2", toolName: "grep", input: { pattern: "x" } }], 6),
  result("t2", "grep", "match", 6),
];
const ENTRY_IDS = MESSAGES.map((_, index) => `e${index}`);

const SESSION = { id: "sess-1", path: "/sessions/sess-1.jsonl", cwd: "/work", name: "Demo" };

const fetchCalls = [];
let agentState = {
  running: true,
  state: { isStreaming: true, isPromptRunning: false },
};
globalThis.fetch = async (url, init = {}) => {
  fetchCalls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
  const path = String(url);
  if (path.startsWith("/api/sessions/sess-1/state")) {
    return { ok: true, status: 200, json: async () => agentState };
  }
  if (path.startsWith("/api/sessions/sess-1?")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        leafId: "e8",
        context: { messages: MESSAGES, entryIds: ENTRY_IDS, thinkingLevel: "medium" },
        contextUsage: { percent: 10, contextWindow: 200000, tokens: 20000 },
      }),
    };
  }
  if (path.startsWith("/api/sessions/")) {
    return { ok: true, status: 200, json: async () => ({ context: { messages: MESSAGES, entryIds: ENTRY_IDS } }) };
  }
  if (path.startsWith("/api/branch-tree") || path.includes("get_branch")) {
    return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) };
  }
  return { ok: true, status: 200, json: async () => ({ success: true, data: null }) };
};

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ChatWindow } = await jiti.import("./ChatWindow.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

function reactProps(element) {
  const key = Object.keys(element).find((k) => k.startsWith("__reactProps"));
  assert.ok(key, "kein React-Props-Objekt am Knoten");
  return element[key];
}

async function tick(ms = 20) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

async function mountChatWindow() {
  win.document.body.replaceChildren();
  instances.length = 0;
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(ChatWindow, { session: SESSION })));
  });
  await tick(60);
  return { container, root };
}

async function sendEvent(event) {
  const source = instances.at(-1);
  assert.ok(source, "die Ereignisquelle ist verbunden");
  await act(async () => {
    source.onmessage({ data: JSON.stringify(event) });
  });
  await tick(10);
}

async function click(element, extra = {}) {
  const handler = reactProps(element).onClick;
  assert.equal(typeof handler, "function", "der Knoten hat einen onClick-Handler");
  await act(async () => {
    handler({ target: element, currentTarget: element, preventDefault() {}, ...extra });
  });
  await tick(10);
}

function buttonByText(container, text) {
  return [...container.querySelectorAll("button")].find((button) => button.textContent.trim() === text);
}

test.after(() => {
  globalThis.fetch = ORIGINALS.fetch;
  globalThis.EventSource = ORIGINALS.EventSource;
  for (const key of ["window", "document", "navigator"]) {
    if (ORIGINALS[key] === undefined) delete globalThis[key];
    else globalThis[key] = ORIGINALS[key];
  }
});

/* ── Prozessdetails ───────────────────────────────────────────────────── */

test("every turn folds its process messages, including one without a final answer", { timeout: 30_000 }, async () => {
  // Ohne laufenden Agenten ist kein Turn der Live-Schwanz; beide Tuernen mit
  // Prozessnachrichten bekommen ihre Gruppe — und beide starten zugeklappt.
  agentState = { running: false };
  const { container, root } = await mountChatWindow();

  const groupButtons = [...container.querySelectorAll('button[aria-expanded]')]
    .filter((button) => button.textContent.includes("Process"));
  assert.equal(groupButtons.length, 2, "beide Tuernen mit Prozessnachrichten haben eine Gruppe");
  const [folded, withoutAnswer] = groupButtons;
  for (const button of groupButtons) {
    assert.equal(button.getAttribute("aria-expanded"), "false", "keine Gruppe startet aufgeklappt");
  }
  assert.match(folded.textContent, /Process details/);

  await click(folded);
  assert.equal(folded.getAttribute("aria-expanded"), "true");
  assert.match(container.textContent, /read/);
  assert.match(container.textContent, /call · |1 tool call/);

  // Ein zweiter Klick klappt wieder ein.
  await click(folded);
  assert.equal(folded.getAttribute("aria-expanded"), "false");

  // Der Turn ohne Antwort ist genau einen Klick entfernt: zugeklappt steht
  // "grep" nicht im DOM, aufgeklappt schon.
  assert.equal(container.textContent.includes("grep"), false);
  await click(withoutAnswer);
  assert.equal(withoutAnswer.getAttribute("aria-expanded"), "true");
  assert.match(container.textContent, /grep/);
  await act(async () => { root.unmount(); });
});

test("an answer is a one-line row; a click unmounts and remounts its body", { timeout: 30_000 }, async () => {
  agentState = { running: false };
  const { container, root } = await mountChatWindow();

  // Die Fixture ist von Januar: die erste Antwort ist alt genug fuer die
  // Altersregel und steht nur als Zeile im DOM, die neueste bleibt offen.
  const row = container.querySelector('button[aria-controls="output-e3"]');
  assert.ok(row, "die Zusammenfassungszeile der ersten Antwort fehlt");
  assert.equal(row.getAttribute("aria-expanded"), "false");
  assert.match(row.textContent, /first answer/);
  assert.equal(container.querySelector("#output-e3").innerHTML, "", "zugeklappt steht der Inhalt nicht mehr im DOM");

  const newest = container.querySelector('button[aria-controls="output-e5"]');
  assert.equal(newest.getAttribute("aria-expanded"), "true", "die neueste Ausgabe klappt nicht zu");
  assert.match(container.querySelector("#output-e5").innerHTML, /second answer/);

  // Ein Klick des Nutzers gewinnt gegen die Regel und mountet den Inhalt.
  await click(row);
  assert.equal(row.getAttribute("aria-expanded"), "true");
  assert.match(container.querySelector("#output-e3").innerHTML, /first answer/);

  // Und wieder zu: der Inhalt verlaesst den DOM.
  await click(row);
  assert.equal(row.getAttribute("aria-expanded"), "false");
  assert.equal(container.querySelector("#output-e3").innerHTML, "", "zugeklappt steht der Inhalt nicht mehr im DOM");
  await act(async () => { root.unmount(); });
});

/* ── Phasen ───────────────────────────────────────────────────────────── */

test("the waiting phase and tool phases are labelled live", { timeout: 30_000 }, async () => {
  agentState = { running: true, state: { isStreaming: true, isPromptRunning: true } };
  const { container, root } = await mountChatWindow();

  // isStreaming -> waiting_model before any streaming text arrives.
  assert.match(container.textContent, /Waiting for model|waiting for model/i);

  const start = (id, name) => ({ type: "tool_execution_start", toolCallId: id, toolName: name });
  await sendEvent(start("a", "read"));
  assert.match(container.textContent, /Running read\.\.\./);

  await sendEvent(start("b", "grep"));
  assert.match(container.textContent, /Running read, grep\.\.\./);

  await sendEvent(start("c", "edit"));
  assert.match(container.textContent, /Running read, grep, edit\.\.\./);

  await sendEvent(start("d", "write"));
  assert.match(container.textContent, /Running read, grep \(\+2\)\.\.\./);

  await sendEvent({ type: "tool_execution_end", toolCallId: "d" });
  assert.match(container.textContent, /Running read, grep, edit\.\.\./);
  await sendEvent({ type: "tool_execution_end", toolCallId: "c" });
  assert.match(container.textContent, /Running read, grep\.\.\./);
  await sendEvent({ type: "tool_execution_end", toolCallId: "b" });
  assert.match(container.textContent, /Running read\.\.\./);
  await sendEvent({ type: "tool_execution_end", toolCallId: "a" });
  assert.match(container.textContent, /Waiting for model|waiting for model/i);
  await act(async () => { root.unmount(); });
});

test("a running shell prompt is labelled as a command phase", { timeout: 30_000 }, async () => {
  agentState = { running: true, state: { isStreaming: false, isPromptRunning: true } };
  const { container, root } = await mountChatWindow();
  assert.match(container.textContent, /Running command|running command/i);
  await act(async () => { root.unmount(); });
});

/* ── ExtensionDialog ──────────────────────────────────────────────────── */

test("a select request renders its options and answers with the chosen one", { timeout: 30_000 }, async () => {
  agentState = { running: true, state: { isStreaming: true, isPromptRunning: true } };
  const { container, root } = await mountChatWindow();
  fetchCalls.length = 0;

  await sendEvent({ type: "extension_ui_request", id: "sel-1", method: "select", title: "Pick one", options: ["Rot", "Gruen"] });
  const dialog = container.querySelector('[role="dialog"]');
  assert.ok(dialog, "der Auswahldialog ist da");
  assert.match(dialog.textContent, /Pick one/);
  const option = buttonByText(dialog, "Gruen");
  assert.ok(option);
  await click(option);

  assert.equal(container.querySelector('[role="dialog"]'), null);
  const command = fetchCalls.find((call) => call.body?.type === "extension_ui_response");
  assert.equal(command.body.id, "sel-1");
  assert.equal(command.body.value, "Gruen");
  await act(async () => { root.unmount(); });
});

test("confirm answers with confirmed:true and cancel with cancelled:true", { timeout: 30_000 }, async () => {
  agentState = { running: true, state: { isStreaming: true, isPromptRunning: true } };
  const { container, root } = await mountChatWindow();
  fetchCalls.length = 0;

  await sendEvent({ type: "extension_ui_request", id: "con-1", method: "confirm", title: "Really?", message: "Delete it" });
  assert.match(container.textContent, /Delete it/);
  await click(buttonByText(container, "Confirm"));
  let command = fetchCalls.find((call) => call.body?.type === "extension_ui_response");
  assert.equal(command.body.id, "con-1");
  assert.equal(command.body.confirmed, true);

  await sendEvent({ type: "extension_ui_request", id: "con-2", method: "confirm", title: "Again?", message: "Sure" });
  await click(buttonByText(container, "Cancel"));
  command = fetchCalls.filter((call) => call.body?.type === "extension_ui_response").at(-1);
  assert.equal(command.body.id, "con-2");
  assert.equal(command.body.cancelled, true);
  await act(async () => { root.unmount(); });
});

test("input and editor requests submit typed text, Escape cancels", { timeout: 30_000 }, async () => {
  agentState = { running: true, state: { isStreaming: true, isPromptRunning: true } };
  const { container, root } = await mountChatWindow();
  fetchCalls.length = 0;

  await sendEvent({ type: "extension_ui_request", id: "in-1", method: "input", title: "Name", placeholder: "your name" });
  const field = container.querySelector('input[placeholder="your name"]');
  assert.ok(field);
  await act(async () => { reactProps(field).onChange({ target: { value: "Ada" } }); });
  await click(buttonByText(container, "Submit"));
  let command = fetchCalls.filter((call) => call.body?.type === "extension_ui_response").at(-1);
  assert.equal(command.body.value, "Ada");

  await sendEvent({ type: "extension_ui_request", id: "ed-1", method: "editor", title: "Edit", prefill: "start" });
  const area = container.querySelector("textarea");
  assert.equal(area.value, "start");
  await act(async () => { area.value = "changed"; reactProps(area).onChange({ target: { value: "changed" } }); });
  const { onKeyDown } = reactProps(area);
  await act(async () => { onKeyDown({ key: "x", preventDefault() {} }); });
  await click(buttonByText(container, "Submit"));
  command = fetchCalls.filter((call) => call.body?.type === "extension_ui_response").at(-1);
  assert.equal(command.body.value, "changed");

  await sendEvent({ type: "extension_ui_request", id: "in-2", method: "input", title: "Cancel me" });
  const cancelArea = container.querySelector("input:not([type])");
  await act(async () => { reactProps(cancelArea).onKeyDown({ key: "Escape", preventDefault() {} }); });
  command = fetchCalls.filter((call) => call.body?.type === "extension_ui_response").at(-1);
  assert.equal(command.body.cancelled, true);
  await act(async () => { root.unmount(); });
});

test("an ask request preselects recommendations, toggles multi options and submits labels", { timeout: 30_000 }, async () => {
  agentState = { running: true, state: { isStreaming: true, isPromptRunning: true } };
  const { container, root } = await mountChatWindow();
  fetchCalls.length = 0;

  await sendEvent({
    type: "extension_ui_request",
    method: "ask",
    id: "ask-1",
    questions: [
      {
        id: "q1",
        question: "Which database?",
        header: "Storage",
        options: [{ label: "SQLite", preview: "single file" }, { label: "Postgres" }],
        recommended: 0,
      },
      {
        id: "q2",
        question: "Which extras?",
        multi: true,
        options: [{ label: "Cache" }, { label: "Queue" }, { label: "Search" }],
      },
    ],
  });

  const dialog = container.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.match(dialog.textContent, /Which database\?/);
  assert.match(dialog.textContent, /Recommended/);
  assert.match(dialog.textContent, /single file/);
  assert.equal(dialog.querySelectorAll('[role="radio"]').length, 2);
  assert.equal(dialog.querySelectorAll('[role="checkbox"]').length, 3);
  assert.match(dialog.querySelector('[role="radio"][aria-checked="true"]').textContent, /^SQLite/);

  // Multi: Cache an, Queue an, Cache wieder aus.
  const checkboxes = [...dialog.querySelectorAll('[role="checkbox"]')];
  await click(checkboxes[0]);
  await click(checkboxes[1]);
  await click(checkboxes[0]);

  // Freitext fuer die zweite Frage.
  const custom = [...dialog.querySelectorAll('input[aria-label]')].find((input) => input.getAttribute("aria-label") === "Other response (optional)");
  await act(async () => { reactProps(custom).onChange({ target: { value: "  " } }); });

  const submit = buttonByText(dialog, "Submit answer");
  assert.equal(submit.disabled, false);
  await click(submit);
  const command = fetchCalls.filter((call) => call.body?.type === "extension_ui_response").at(-1);
  const payload = JSON.parse(command.body.value);
  assert.equal(payload.kind, "submit");
  assert.deepEqual(payload.results[0].selectedOptions, ["SQLite"]);
  assert.deepEqual(payload.results[1].selectedOptions, ["Queue"]);

  // Ohne Auswahl und ohne Freitext ist der Submit-Knopf gesperrt.
  await sendEvent({ type: "extension_ui_request", method: "ask", id: "ask-2", questions: [{ id: "q3", question: "Choose", options: [{ label: "A" }] }] });
  await act(async () => {
    const empty = buttonByText(container, "Submit answer");
    assert.equal(empty.disabled, true);
    let node = container.querySelector('[role="dialog"]');
    while (node && typeof reactProps(node).onKeyDown !== "function") node = node.parentElement;
    assert.ok(node, "der Escape-Handler sitzt auf dem Dialog-Rahmen");
    reactProps(node).onKeyDown({ key: "Escape", preventDefault() {} });
  });
  await tick(10);
  assert.equal(container.querySelector('[role="dialog"]'), null);
  await act(async () => { root.unmount(); });
});

test("a plan review offers approve and refine with feedback", { timeout: 30_000 }, async () => {
  agentState = { running: true, state: { isStreaming: true, isPromptRunning: true } };
  const { container, root } = await mountChatWindow();
  fetchCalls.length = 0;

  await sendEvent({
    type: "extension_ui_request",
    method: "plan_review",
    id: "plan-1",
    title: "Plan v2",
    planFilePath: "/work/PLAN.md",
    planContent: "# Steps\n\n- one\n- two",
  });
  const dialog = container.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /Plan v2/);
  assert.match(dialog.textContent, /Steps/);

  const feedback = dialog.querySelector("textarea");
  await act(async () => { reactProps(feedback).onChange({ target: { value: "add tests" } }); });
  await click(buttonByText(dialog, "Continue planning"));
  let command = fetchCalls.filter((call) => call.body?.type === "extension_ui_response").at(-1);
  assert.deepEqual(JSON.parse(command.body.value), { action: "refine", feedback: "add tests" });

  await sendEvent({
    type: "extension_ui_request",
    method: "plan_review",
    id: "plan-2",
    title: "Plan v3",
    planFilePath: "/work/PLAN.md",
    planContent: "done",
  });
  await click(buttonByText(container, "Approve and implement"));
  command = fetchCalls.filter((call) => call.body?.type === "extension_ui_response").at(-1);
  assert.deepEqual(JSON.parse(command.body.value), { action: "approve" });
  await act(async () => { root.unmount(); });
});

/* ── ExtensionCustomPanel ─────────────────────────────────────────────── */

test("a custom extension panel renders ANSI lines and forwards key, paste and text input", { timeout: 30_000 }, async () => {
  agentState = { running: true, state: { isStreaming: true, isPromptRunning: true } };
  const { container, root } = await mountChatWindow();
  fetchCalls.length = 0;

  await sendEvent({
    type: "extension_ui_request",
    method: "custom",
    id: "custom-1",
    lines: [
      "\u001b[31mred line\u001b[0m plain",
      "│ framed │",
      "┌────┐",
    ],
  });

  const dialog = container.querySelector('[role="dialog"]');
  assert.ok(dialog, "das Custom-Panel ist da");
  // renderAnsiLine: der Farbabschnitt ist ein span mit Farbe, der Rest Text.
  const colored = [...dialog.querySelectorAll("span")].find((span) => span.textContent === "red line");
  assert.ok(colored, "der ANSI-Text ist ein eigenes Element");
  assert.match(colored.getAttribute("style") ?? "", /color/);
  assert.match(dialog.textContent, /framed/);
  assert.doesNotMatch(dialog.textContent, /\u001b/);
  // Eine reine Rahmenlinie wird verworfen.
  assert.doesNotMatch(dialog.textContent, /┌────┐/);

  const input = dialog.querySelector("textarea");
  assert.ok(input);
  const props = reactProps(input);
  await act(async () => {
    props.onKeyDown({ key: "Tab", preventDefault() {}, stopPropagation() {}, nativeEvent: { isComposing: false } });
  });
  let command = fetchCalls.filter((call) => call.body?.type === "extension_ui_input").at(-1);
  assert.equal(command.body.id, "custom-1");
  assert.equal(typeof command.body.data, "string");

  await act(async () => {
    props.onPaste({ preventDefault() {}, clipboardData: { getData: () => "pasted" } });
  });
  command = fetchCalls.filter((call) => call.body?.type === "extension_ui_input").at(-1);
  assert.match(command.body.data, /pasted/);

  await act(async () => {
    props.onInput({ currentTarget: { value: "typed" }, nativeEvent: { isComposing: false } });
  });
  command = fetchCalls.filter((call) => call.body?.type === "extension_ui_input").at(-1);
  assert.equal(command.body.data, "typed");

  // IME: waehrend der Komposition wird nichts gesendet, danach der Text.
  const before = fetchCalls.length;
  await act(async () => { props.onKeyDown({ key: "a", preventDefault() {}, nativeEvent: { isComposing: true } }); });
  assert.equal(fetchCalls.length, before, "waehrend der Komposition kein Tastatur-Input");
  await act(async () => { props.onCompositionStart(); });
  const inputEl = dialog.querySelector("textarea");
  inputEl.value = "ime text";
  await act(async () => { props.onCompositionEnd({ currentTarget: inputEl }); });
  await tick(0);
  command = fetchCalls.filter((call) => call.body?.type === "extension_ui_input").at(-1);
  assert.equal(command.body.data, "ime text");

  // Klick ins Panel ohne Knopf setzt den Fokus.
  await act(async () => { reactProps(dialog).onClick({ target: dialog }); });

  await sendEvent({ type: "extension_ui_request", method: "custom", id: "custom-1", lines: [], closed: true });
  assert.equal(container.querySelector('[role="dialog"]'), null);
  await act(async () => { root.unmount(); });
});
