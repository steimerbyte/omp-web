import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";

/**
 * The animation switch, measured on the control and on what it persists.
 *
 * The panel is the only place the three modes are explained, and the store is
 * what the rest of the surface reads (`document.documentElement.dataset`), so a
 * test that only clicked the radio would miss a mode that is saved but never
 * applied.
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
const { AnimationsConfig } = await jiti.import("./AnimationsConfig.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { createRoot } = await import("react-dom/client");

async function mount() {
  win.document.body.innerHTML = "";
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(AnimationsConfig)));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return { container, root };
}

function radio(container, label) {
  return container.querySelector(`input[type="radio"][aria-label="${label}"]`);
}

test("renders the three modes with the stored one selected", async () => {
  storage.set("omp-animations", "reduced");
  const { container, root } = await mount();
  const labels = [...container.querySelectorAll('input[type="radio"]')].map((node) => node.getAttribute("aria-label"));
  assert.deepEqual(labels, ["Full", "Reduced", "Off"]);
  assert.equal(radio(container, "Reduced").checked, true);
  assert.equal(radio(container, "Full").checked, false);
  assert.match(container.textContent, /Stored in this browser only/);
  await act(async () => { root.unmount(); });
});

test("choosing Off persists it and applies the document attribute", async () => {
  storage.set("omp-animations", "full");
  const { container, root } = await mount();
  assert.equal(radio(container, "Full").checked, true);

  await act(async () => { radio(container, "Off").click(); });
  assert.equal(radio(container, "Off").checked, true);
  assert.equal(storage.get("omp-animations"), "off");
  assert.equal(win.document.documentElement.dataset.ompAnimations, "off");
  await act(async () => { root.unmount(); });
});

test("the selected mode survives a remount", async () => {
  storage.set("omp-animations", "reduced");
  const first = await mount();
  await act(async () => { radio(first.container, "Off").click(); });
  await act(async () => { first.root.unmount(); });

  const second = await mount();
  assert.equal(radio(second.container, "Off").checked, true);
  await act(async () => { second.root.unmount(); });
});
