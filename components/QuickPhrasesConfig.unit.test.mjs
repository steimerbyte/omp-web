import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";

/**
 * Quick phrases, mounted with a stubbed `/api/quick-phrases`.
 *
 * The screen edits a store that is written in three different rhythms: typing
 * is debounced, blur and unmount flush a pending write at once, and delete
 * bypasses the timer so the row cannot come back. All three are measured here
 * with a manual clock, because a real 400 ms wait would make the difference
 * between "flushed" and "not yet" invisible.
 */

const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
restoreLinkedomPrototypesOnExit(win);
const nav = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };
win.getComputedStyle = () => new Proxy({}, { get: (_t, p) => (typeof p === "string" && p.startsWith("get") ? () => "" : "0px") });
win.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
globalThis.window = new Proxy(win, {
  get(target, prop) {
    if (prop === "navigator") return nav;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
globalThis.document = win.document;
globalThis.navigator = nav;
globalThis.matchMedia = win.matchMedia;
for (const [name, value] of Object.entries(linkedom)) {
  if (name === "parseHTML" || name === "default") continue;
  if (typeof value === "function" && /^[A-Z]/.test(name)) globalThis[name] = value;
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
win.document.oninput = null;

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  clear: () => storage.clear(),
};
win.localStorage = globalThis.localStorage;

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { QuickPhrasesConfig } = await jiti.import("./QuickPhrasesConfig.tsx");
const { loadQuickPhrases } = await jiti.import("../hooks/useQuickPhrases.ts");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { createRoot } = await import("react-dom/client");

const PHRASES = [
  { label: "Explain", text: "Explain this code." },
  { label: "", text: "Write a test for the selected code." },
];

function json(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

/** Captures only the 400 ms debounce timer, leaving React's own timers alone. */
function installClock() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  let nextHandle = 1;
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === 400) {
      const handle = nextHandle++;
      timers.set(handle, () => fn(...args));
      return handle;
    }
    return realSetTimeout(fn, ms, ...args);
  };
  globalThis.clearTimeout = (handle) => {
    if (timers.delete(handle)) return;
    realClearTimeout(handle);
  };
  return {
    pending: () => timers.size,
    async fire() {
      const due = [...timers.values()];
      timers.clear();
      await act(async () => {
        due.forEach((fn) => fn());
        await new Promise((resolve) => realSetTimeout(resolve, 20));
      });
    },
    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

async function mount({ respond } = {}) {
  win.document.body.innerHTML = "";
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const call = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    if (respond) return respond(call);
    if (call.method === "GET") return json({ exists: true, phrases: PHRASES });
    return json({ phrases: call.body.phrases.filter((phrase) => phrase.text.length > 0) });
  };
  // Load once before rendering so the one-shot hydration in the component sees
  // this fixture, not a list left over from an earlier test in this file.
  await act(async () => { await loadQuickPhrases(); });
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(QuickPhrasesConfig)));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  return {
    container,
    calls,
    async unmount() {
      await act(async () => { root.unmount(); });
      // The unmount flush schedules its PUT on the write chain; let it reach
      // the stub before the stub is removed.
      await new Promise((resolve) => setTimeout(resolve, 20));
      globalThis.fetch = originalFetch;
    },
  };
}

function button(container, text) {
  return [...container.querySelectorAll("button")].find((node) => (node.textContent ?? "").trim() === text);
}

function reactProps(element) {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps"));
  return key ? element[key] : null;
}

async function type(element, value) {
  await act(async () => {
    const prototype = element.tagName === "TEXTAREA"
      ? win.HTMLTextAreaElement.prototype
      : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    reactProps(element)?.onChange?.({ target: element, currentTarget: element, preventDefault() {}, stopPropagation() {} });
  });
}

function rowsOf(container) {
  return [...container.querySelectorAll('button[aria-label="Delete phrase"]')].map((button) => button.parentElement);
}

function fieldValues(container) {
  return rowsOf(container).map((row) => {
    const [label, text] = row.querySelectorAll("input, textarea");
    return [reactProps(label)?.value, reactProps(text)?.value];
  });
}

test("renders both fields of every stored phrase", async () => {
  const { container, calls, unmount } = await mount();
  assert.match(container.textContent, /Quick phrases/);
  assert.match(container.textContent, /Button label/);
  assert.match(container.textContent, /Inserted text/);
  assert.deepEqual(fieldValues(container), PHRASES.map((phrase) => [phrase.label, phrase.text]));
  assert.equal(calls.filter((call) => call.method === "GET").length >= 1, true);
  await unmount();
});

test("a new row is not written until the debounce fires", async () => {
  const clock = installClock();
  try {
    const { container, calls, unmount } = await mount();
    await act(async () => { button(container, "Add phrase").click(); });
    assert.equal(fieldValues(container).length, PHRASES.length + 1);
    assert.equal(clock.pending(), 1);
    assert.equal(calls.filter((call) => call.method === "PUT").length, 0);

    const rows = fieldValues(container);
    const [, text] = rowsOf(container).at(-1).querySelectorAll("input, textarea");
    await type(text, "Fresh phrase text");
    assert.equal(clock.pending(), 1, "der Timer wurde nicht neu gesetzt");

    await clock.fire();
    const put = calls.find((call) => call.method === "PUT");
    assert.deepEqual(put.body.phrases, [...PHRASES, { label: "", text: "Fresh phrase text" }]);
    assert.equal(rows.length, PHRASES.length + 1);
  } finally {
    clock.restore();
  }
  await mount().then(({ unmount }) => unmount());
});

test("blur writes a pending edit immediately", async () => {
  const clock = installClock();
  try {
    const { container, calls, unmount } = await mount();
    const label = container.querySelector("input");
    await type(label, "Explained");
    assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
    await act(async () => {
      reactProps(label)?.onBlur?.({ target: label, currentTarget: label, preventDefault() {}, stopPropagation() {} });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.deepEqual(calls.find((call) => call.method === "PUT").body.phrases[0], { label: "Explained", text: PHRASES[0].text });
    assert.equal(clock.pending(), 0, "der Timer läuft nach dem Flush weiter");
    await unmount();
  } finally {
    clock.restore();
  }
});

test("delete bypasses the timer", async () => {
  const clock = installClock();
  try {
    const { container, calls, unmount } = await mount();
    await act(async () => { container.querySelector('button[aria-label="Delete phrase"]').click(); });
    assert.equal(calls.filter((call) => call.method === "PUT").length, 1);
    assert.deepEqual(calls.find((call) => call.method === "PUT").body.phrases, [PHRASES[1]]);
    assert.deepEqual(fieldValues(container), [[PHRASES[1].label, PHRASES[1].text]]);
    assert.equal(clock.pending(), 0);
    await unmount();
  } finally {
    clock.restore();
  }
});

test("closing the dialog flushes what the timer has not written", async () => {
  const clock = installClock();
  try {
    const { container, calls, unmount } = await mount();
    await act(async () => { button(container, "Add phrase").click(); });
    const text = [...container.querySelectorAll("textarea")].at(-1);
    await type(text, "Kept on close");
    assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
    assert.equal(clock.pending(), 1);
    await unmount();
    assert.equal(calls.filter((call) => call.method === "PUT").length, 1);
    assert.deepEqual(calls.find((call) => call.method === "PUT").body.phrases.at(-1), { label: "", text: "Kept on close" });
  } finally {
    clock.restore();
  }
});

test("a failed load is shown and leaves the editor usable", async () => {
  const { container, unmount } = await mount({
    respond: (call) => call.method === "GET"
      ? json({ error: "disk unavailable" }, false, 500)
      : json({ phrases: [] }),
  });
  assert.match(container.textContent, /Could not save quick phrases \(HTTP 500\)/);
  assert.ok(button(container, "Add phrase"));
  await unmount();
});

test("a failed write keeps the list and explains that it was not stored", async () => {
  const { container, calls, unmount } = await mount({
    respond: (call) => call.method === "PUT"
      ? json({ error: "write protected" }, false, 500)
      : json({ exists: true, phrases: PHRASES }),
  });
  await act(async () => { container.querySelector('button[aria-label="Delete phrase"]').click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /Could not save quick phrases \(HTTP 500\)/);
  assert.equal(fieldValues(container).length, 1);
  assert.equal(calls.filter((call) => call.method === "PUT").length, 1);
  await unmount();
});

test("an unfinished row stays visible but is not persisted", async () => {
  const clock = installClock();
  try {
    const { container, calls, unmount } = await mount();
    await act(async () => { button(container, "Add phrase").click(); });
    await clock.fire();
    assert.deepEqual(calls.find((call) => call.method === "PUT").body.phrases, PHRASES);
    assert.equal(fieldValues(container).length, PHRASES.length + 1);
    await unmount();
  } finally {
    clock.restore();
  }
});
