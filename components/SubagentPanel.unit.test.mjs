import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

/**
 * `SubagentPanel` und `SubagentAgentButton` in einem gemounteten DOM.
 *
 * Der Panel-Teil ist reine Liste plus ein Detail, das sein Transkript per
 * `sendAgentCommand` (POST /api/agent/<id>) nachlaedt. `fetch` wird deshalb
 * explizit gestubbt und in `test.after` zurueckgegeben; `EventSource` und
 * `localStorage` braucht das Modul nicht, `MessageView` darin aber ein
 * vollstaendiges Fenster (daher der uebliche Harness).
 */
const ORIGINALS = {
  fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document,
  requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame,
};
/* Buns `requestAnimationFrame` feuert nach ~16 ms; der Scroll-Effekt im Panel
 * cancelt ihn beim Unmount. Je nach Last lief der Callback also mal und mal
 * nicht, und die Funktions-Coverage schwankte um eins. Eine Makrotask ist
 * deterministisch, aber nicht synchron: `motion-dom` plant im Frame den
 * naechsten und liefe bei einem direkten Aufruf in den Stack. */
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };
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
for (const [key, value] of Object.entries(linkedom)) {
  if (key !== "parseHTML" && key !== "default" && typeof value === "function" && /^[A-Z]/.test(key)) {
    globalThis[key] = value;
  }
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
};
win.localStorage = globalThis.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { SubagentPanel, SubagentAgentButton } = await jiti.import("./SubagentPanel.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

const calls = [];
globalThis.fetch = async (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : null;
  calls.push({ url: String(url), body });
  if (String(url).includes("/api/agent/")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          fromByte: 0,
          nextByte: 42,
          reset: false,
          entries: [
            { id: "e1", type: "message", message: { role: "user", content: "Inspect the logs" } },
            { id: "e2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Found three errors" }] } },
            { id: "e3", type: "session_info" },
          ],
        },
      }),
    };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const running = {
  id: "sub-1",
  agent: "task",
  task: "Scan the repository",
  status: "running",
  progress: { durationMs: 65_000, toolCount: 4, tokens: 1234, resolvedModel: "test/model", currentTool: "grep", lastIntent: "" },
};
const finished = {
  id: "sub-2",
  agent: "task",
  assignment: "Write the summary",
  status: "failed",
  progress: { durationMs: 5_000, toolCount: 0, tokens: 10, retryState: { attempt: 2, maxAttempts: 3 } },
  parentToolCallId: "batch-1",
};
const finishedTwo = {
  id: "sub-3",
  agent: "task",
  description: "A third one",
  status: "completed",
  progress: { durationMs: 125_000, toolCount: 1, tokens: 99 },
  parentToolCallId: "batch-1",
};

function reactProps(element) {
  const key = Object.keys(element).find((k) => k.startsWith("__reactProps"));
  assert.ok(key, "kein React-Props-Objekt am Knoten");
  return element[key];
}

async function mount(element) {
  // Radix portalt Dialoge nach document.body; Reste eines vorigen Tests
  // wuerden sonst als zweiter Dialog gefunden.
  win.document.body.replaceChildren();
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, element));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  return { container, root };
}

test("live and finished subagents are grouped, labelled and counted", async () => {
  const { container, root } = await mount(React.createElement(SubagentPanel, {
    sessionId: "sess-1",
    subagents: [finishedTwo, running, finished],
  }));

  assert.match(container.textContent, /SUBAGENTS|Subagents/i);
  assert.match(container.textContent, /1 running/);
  assert.match(container.textContent, /2 finished/);
  // The running row shows its current tool and its minute-padded duration.
  assert.match(container.textContent, /sub-1/);
  assert.match(container.textContent, /1m 05s/);
  assert.match(container.textContent, /grep|Using/);
  // The finished rows: retry state wins over "failed", completed is "finished".
  assert.match(container.textContent, /sub-2/);
  assert.match(container.textContent, /Retrying|retrying/);
  assert.match(container.textContent, /sub-3/);
  assert.match(container.textContent, /2m 05s/);
  assert.equal(container.querySelectorAll('[role="listitem"]').length, 3);
  await act(async () => { root.unmount(); });
});

test("selecting a row loads its transcript and Escape goes back", async () => {
  calls.length = 0;
  const { container, root } = await mount(React.createElement(SubagentPanel, {
    sessionId: "sess-1",
    cwd: "/work",
    subagents: [finished],
  }));

  const row = container.querySelector('[role="listitem"]');
  await act(async () => { reactProps(row).onClick(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/agent/sess-1");
  assert.deepEqual(calls[0].body, { type: "get_subagent_messages", subagentId: "sub-2", fromByte: 0 });

  const dialog = container.querySelector('[role="dialog"]');
  assert.ok(dialog, "das Detail ist ein Dialog");
  assert.match(dialog.textContent, /Inspect the logs/);
  assert.match(dialog.textContent, /Found three errors/);
  assert.match(dialog.textContent, /sub-2/);
  assert.match(dialog.textContent, /test\/model|1m 05s|5s/);

  const back = dialog.querySelector('[aria-label="Back"], button');
  assert.ok(back);
  await act(async () => {
    const event = new win.Event("keydown");
    Object.defineProperty(event, "key", { value: "Escape" });
    win.dispatchEvent(event);
  });
  assert.equal(container.querySelector('[role="dialog"]'), null);

  await act(async () => { root.unmount(); });
});

test("a failing transcript request keeps the detail open with an error note", async () => {
  const failing = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network down"); };
  try {
    const { container, root } = await mount(React.createElement(SubagentPanel, {
      sessionId: "sess-2",
      subagents: [finishedTwo],
    }));
    await act(async () => { reactProps(container.querySelector('[role="listitem"]')).onClick(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    assert.match(container.textContent, /transcript/i);
    assert.match(container.textContent, /not available|unavailable/i);
    await act(async () => { root.unmount(); });
  } finally {
    globalThis.fetch = failing;
  }
});

test("recent output stands in when no transcript entry arrived yet", async () => {
  const empty = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: { fromByte: 0, nextByte: 0, reset: true, entries: [] } }),
  });
  try {
    const withOutput = { ...finishedTwo, progress: { ...finishedTwo.progress, recentOutput: ["line from the agent", "second line"] } };
    const { container, root } = await mount(React.createElement(SubagentPanel, {
      sessionId: "sess-3",
      subagents: [withOutput],
    }));
    await act(async () => { reactProps(container.querySelector('[role="listitem"]')).onClick(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    assert.match(container.textContent, /line from the agent/);
    assert.match(container.textContent, /second line/);
    await act(async () => { root.unmount(); });
  } finally {
    globalThis.fetch = empty;
  }
});

test("the panel is absent without a session or without subagents", () => {
  const ReactWithNoSession = React.createElement(SubagentPanel, { sessionId: null, subagents: [running] });
  const ReactWithNoRows = React.createElement(SubagentPanel, { sessionId: "s", subagents: [] });
  assert.equal(renderToStaticMarkup(React.createElement(I18nProvider, null, ReactWithNoSession)), "");
  assert.equal(renderToStaticMarkup(React.createElement(I18nProvider, null, ReactWithNoRows)), "");
});

test("without running work there is no button — finished rows alone are history", async () => {
  win.document.body.replaceChildren();
  const root = createRoot(win.document.createElement("div"));
  await act(async () => {
    root.render(React.createElement(I18nProvider, null,
      React.createElement(SubagentAgentButton, { sessionId: "s", subagents: [finished, finishedTwo] })));
  });
  assert.equal(win.document.querySelector('[aria-haspopup="dialog"]'), null);
  await act(async () => { root.unmount(); });

  assert.equal(
    renderToStaticMarkup(React.createElement(I18nProvider, null,
      React.createElement(SubagentAgentButton, { sessionId: "s", subagents: [] }))),
    "",
    "ohne Sitzung oder ohne Arbeit entsteht kein Knopf",
  );
  assert.equal(
    renderToStaticMarkup(React.createElement(I18nProvider, null,
      React.createElement(SubagentAgentButton, { sessionId: "s", subagents: [finished] }))),
    "",
    "abgeschlossene Zeilen allein zeigen keinen Knopf",
  );
});

test("the button counts live work and opens one dialog with the list", async () => {
  const { container, root } = await mount(React.createElement(SubagentAgentButton, {
    sessionId: "sess-4",
    subagents: [running, finished],
  }));

  const button = container.querySelector('button[aria-haspopup="dialog"]');
  assert.ok(button, "der Einstieg in die Hintergrundarbeit fehlt");
  assert.match(button.getAttribute("aria-label"), /Subagents: 1 running/);
  assert.equal(button.getAttribute("title"), button.getAttribute("aria-label"));
  // 40x40 mit eigener Form: ein Knopf, keine Pille.
  assert.equal(button.style.width, "40px");
  assert.equal(button.style.height, "40px");
  assert.equal(button.style.borderRadius, "10px");

  await act(async () => { reactProps(button).onClick(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  const dialog = win.document.querySelector('[role="dialog"]');
  assert.ok(dialog, "der Dialog ist nicht aufgegangen");
  assert.match(dialog.textContent, /SUBAGENTS|Subagents/i);
  assert.match(dialog.textContent, /sub-1/);
  assert.match(dialog.textContent, /sub-2/);
  // collapsible={false}: der Listenkopf ist kein Klapp-Knopf.
  assert.equal(dialog.querySelector('[aria-expanded]'), null);

  const close = dialog.querySelector('[aria-label="Close"]');
  assert.ok(close, "der Schliessen-Knopf fehlt");
  await act(async () => { reactProps(close).onClick(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  assert.equal(win.document.querySelector('[role="dialog"]'), null);
  await act(async () => { root.unmount(); });
});

test("vibe workers alone open the dialog with an honest note, not a dead row", async () => {
  const { container, root } = await mount(React.createElement(SubagentAgentButton, {
    sessionId: "sess-5",
    subagents: [],
    vibeWorkers: 2,
  }));

  const button = container.querySelector('button[aria-haspopup="dialog"]');
  assert.ok(button, "ohne Subagenten, aber mit Vibe-Arbeitern fehlt der Knopf");
  assert.match(button.getAttribute("aria-label"), /Subagents: 2 running/);

  await act(async () => { reactProps(button).onClick(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  const dialog = win.document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.match(dialog.textContent, /Vibe mode is driving 2 worker sessions/);
  assert.equal(dialog.querySelectorAll('[role="listitem"]').length, 0, "keine Zeile ohne Session");
  await act(async () => { root.unmount(); });
});

test("the button follows the work, and an open dialog survives the last worker ending", async () => {
  const component = (subagents) => React.createElement(I18nProvider, null,
    React.createElement(SubagentAgentButton, { sessionId: "sess-7", subagents }));
  const { container, root } = await mount(component([finished]));
  const findButton = () => container.querySelector('button[aria-haspopup="dialog"]');
  assert.equal(findButton(), null, "fertige Zeilen allein zeigen keinen Knopf");

  await act(async () => { root.render(component([running])); });
  assert.ok(findButton(), "ein laufender Subagent fehlt");

  await act(async () => { reactProps(findButton()).onClick(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  assert.ok(win.document.querySelector('[role="dialog"]'), "der Dialog ist nicht aufgegangen");

  // Der letzte Lauf endet, waehrend das Transkript gelesen wird.
  await act(async () => { root.render(component([finished])); });
  assert.ok(findButton(), "der Knopf verschwand unter dem offenen Dialog");
  assert.ok(win.document.querySelector('[role="dialog"]'), "der offene Dialog wurde geschlossen");

  const close = win.document.querySelector('[role="dialog"] [aria-label="Close"]');
  await act(async () => { reactProps(close).onClick(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.equal(findButton(), null, "nach dem Schliessen bleibt kein Knopf ohne Arbeit");
  await act(async () => { root.unmount(); });
});

test("a row opens the live transcript and closing hands focus back to the button", async () => {
  calls.length = 0;
  const { container, root } = await mount(React.createElement(SubagentAgentButton, {
    sessionId: "sess-6",
    cwd: "/work",
    // Ein fertiger Lauf reicht fuer den Knopf nicht mehr; der offene Lauf
    // traegt ihn, und die Transkript-Zeile ist die abgeschlossene.
    subagents: [running, finished],
  }));

  const button = container.querySelector('button[aria-haspopup="dialog"]');
  await act(async () => { reactProps(button).onClick(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

  const dialog = win.document.querySelector('[role="dialog"]');
  const row = [...dialog.querySelectorAll('[role="listitem"]')].find((node) => (node.textContent ?? "").includes("sub-2"));
  assert.ok(row, "die abgeschlossene Zeile fehlt");
  await act(async () => { reactProps(row).onClick(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { type: "get_subagent_messages", subagentId: "sub-2", fromByte: 0 });
  assert.match(win.document.body.textContent, /Found three errors/);

  let focused = 0;
  button.focus = () => { focused += 1; };
  const close = dialog.querySelector('[aria-label="Close"]');
  await act(async () => { reactProps(close).onClick(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.equal(focused, 1, "der Fokus blieb nicht am Einstieg");
  await act(async () => { root.unmount(); });
});

test.after(() => {
  globalThis.fetch = ORIGINALS.fetch;
  if (ORIGINALS.requestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
  else globalThis.requestAnimationFrame = ORIGINALS.requestAnimationFrame;
  if (ORIGINALS.cancelAnimationFrame === undefined) delete globalThis.cancelAnimationFrame;
  else globalThis.cancelAnimationFrame = ORIGINALS.cancelAnimationFrame;
  if (ORIGINALS.window === undefined) delete globalThis.window;
  else globalThis.window = ORIGINALS.window;
  if (ORIGINALS.document === undefined) delete globalThis.document;
  else globalThis.document = ORIGINALS.document;
});
