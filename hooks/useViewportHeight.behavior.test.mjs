// Der bestehende Test prueft nur shouldUseVisualViewportHeight (pure). Hier
// laeuft der Hook: rAF-Entprellung, Fokus-Erkennung, CSS-Variable, Scroll-Reset
// und das Aufraeumen beim Unmount.
import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

const ROOT = new globalThis.URL("..", import.meta.url).pathname;
const jiti = createJiti(`${ROOT}package.json`, { jsx: { runtime: "automatic" }, tsconfigPaths: true });

const dom = linkedom.parseHTML("<!doctype html><html><body><input id=\"field\"><textarea id=\"area\"></textarea></body></html>");
const win = dom.window;
const ORIGINALS = {
  window: globalThis.window,
  document: globalThis.document,
  HTMLElement: globalThis.HTMLElement,
};
const scrolled = [];
let rafId = 0;
const rafQueue = new Map();
const viewportListeners = new Map();
const viewport = {
  height: 800,
  scale: 1,
  addEventListener: (type, cb) => { viewportListeners.set(type, cb); },
  removeEventListener: () => { viewportListeners.delete("resize"); },
};
const field = win.document.getElementById("field");
const area = win.document.getElementById("area");
let activeElement = win.document.body;
Object.defineProperty(win.document, "activeElement", { get: () => activeElement, configurable: true });
Object.defineProperty(win.document, "visibilityState", { value: "visible", configurable: true });

win.visualViewport = viewport;
win.innerHeight = 800;
win.scrollX = 0;
win.scrollY = 0;
win.scrollTo = (x, y) => { scrolled.push([x, y]); win.scrollX = x; win.scrollY = y; };
win.requestAnimationFrame = (cb) => { const id = ++rafId; rafQueue.set(id, cb); return id; };
win.cancelAnimationFrame = (id) => { rafQueue.delete(id); };

globalThis.window = win;
globalThis.document = win.document;
globalThis.HTMLElement = win.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { useViewportHeight } = await jiti.import(`${ROOT}hooks/useViewportHeight.ts`);

const flushFrames = async () => {
  await act(async () => {
    const pending = [...rafQueue.values()];
    rafQueue.clear();
    for (const cb of pending) cb();
  });
};

test.after(() => {
  for (const [key, value] of Object.entries(ORIGINALS)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});

test("setzt die Tastaturhoehe nur bei fokussiertem Feld und entspart sie danach", async () => {
  const root = win.document.documentElement;
  const container = win.document.createElement("div");
  const reactRoot = createRoot(container);
  await act(async () => { reactRoot.render(React.createElement(function Probe() { useViewportHeight(); return null; })); });
  // Der Mount-Zeitplan wird beim ersten Frame ausgefuehrt (800 = 800 -> keine Variable).
  await flushFrames();
  assert.equal(root.style.getPropertyValue("--app-viewport-height"), "");

  // Tastatur offen: INPUT fokussiert, visualViewport schrumpft.
  activeElement = field;
  viewport.height = 500;
  win.scrollY = 40;
  viewportListeners.get("resize")();
  // Zweiter Aufruf vor dem Frame muss den ersten verwerfen (cancelAnimationFrame).
  viewportListeners.get("resize")();
  assert.equal(rafQueue.size, 1);
  await flushFrames();
  assert.equal(root.style.getPropertyValue("--app-viewport-height"), "500px");
  assert.deepEqual(scrolled.at(-1), [0, 0]);

  // Feld verliert den Fokus -> die Variable verschwindet.
  activeElement = win.document.body;
  viewport.height = 800;
  viewportListeners.get("scroll")();
  await flushFrames();
  assert.equal(root.style.getPropertyValue("--app-viewport-height"), "");

  // Auch ein TextArea zaehlt als editierbar.
  activeElement = area;
  viewport.height = 400;
  viewportListeners.get("resize")();
  await flushFrames();
  assert.equal(root.style.getPropertyValue("--app-viewport-height"), "400px");

  await act(async () => { reactRoot.unmount(); });
  assert.equal(root.style.getPropertyValue("--app-viewport-height"), "");
});

test("ohne visualViewport passiert nichts", async () => {
  delete win.visualViewport;
  const root = win.document.documentElement;
  root.style.setProperty("--app-viewport-height", "123px");
  const reactRoot = createRoot(win.document.createElement("div"));
  await act(async () => { reactRoot.render(React.createElement(function Probe() { useViewportHeight(); return null; })); });
  await flushFrames();
  assert.equal(root.style.getPropertyValue("--app-viewport-height"), "123px");
  await act(async () => { reactRoot.unmount(); });
  root.style.removeProperty("--app-viewport-height");
});
