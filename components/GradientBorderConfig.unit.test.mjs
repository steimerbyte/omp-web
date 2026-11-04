import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";

/**
 * The gradient-border settings, mounted against the real store.
 *
 * Every control writes the same `localStorage` record the chat bar reads, so
 * the test asserts both halves: the value in storage and the label the next
 * render shows. The colour/slider inputs are driven through the native setter
 * because React's controlled-input tracker ignores a plain `value = …`.
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
globalThis.CSS = { supports: () => true, registerProperty: () => {} };

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  clear: () => storage.clear(),
};
win.localStorage = globalThis.localStorage;

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { GradientBorderConfig } = await jiti.import("./GradientBorderConfig.tsx");
const { DEFAULT_GRADIENT_BORDER_SETTINGS } = await jiti.import("./motion/gradient-border-settings.ts");
const { setGradientBorderSettings } = await jiti.import("./motion/GradientBorder.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { createRoot } = await import("react-dom/client");

function stored() {
  return JSON.parse(storage.get("omp-gradient-border"));
}

async function mount(settings = DEFAULT_GRADIENT_BORDER_SETTINGS) {
  // Reset the module store through its public setter so one test cannot leak
  // into the next; the mount effect then reads the same record from storage.
  setGradientBorderSettings(settings);
  win.document.body.innerHTML = "";
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(GradientBorderConfig)));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return { container, root };
}

function button(container, text) {
  return [...container.querySelectorAll("button")].find((node) => (node.textContent ?? "").trim() === text);
}

function choiceSelected(container, label) {
  const toggle = button(container, label);
  assert.ok(toggle, `preset ${label} fehlt`);
  return toggle.parentElement.getAttribute("data-selected");
}

function options(container) {
  return [...container.querySelectorAll('[data-selected]')].map((node) => ({
    text: (node.textContent ?? "").trim(),
    selected: node.getAttribute("data-selected"),
  }));
}

async function setInput(input, value) {
  await act(async () => {
    const prototype = input.type === "range" || input.type === "color" ? win.HTMLInputElement.prototype : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    input.dispatchEvent(new win.Event("change", { bubbles: true }));
  });
}

test("the default record selects the omphie preset and a disabled switch", async () => {
  const { container, root } = await mount();
  assert.equal(choiceSelected(container, "Omphie"), "true");
  assert.equal(container.querySelector('[data-on="false"]') !== null, true);
  assert.match(container.textContent, /Glow/);
  assert.match(container.textContent, /6px/);
  assert.match(container.textContent, /2.4s/);
  assert.match(container.textContent, /0.25/);
  await act(async () => { root.unmount(); });
});

test("toggling enabled writes the record and the switch state", async () => {
  const { container, root } = await mount();
  const toggle = container.querySelector("button[aria-pressed]");
  await act(async () => { toggle.click(); });
  assert.equal(stored().enabled, true);
  assert.equal(container.querySelector("button[aria-pressed]").getAttribute("aria-pressed"), "true");
  await act(async () => { root.unmount(); });
});

test("presets replace all four colours and clear the custom marker", async () => {
  const { container, root } = await mount();
  await act(async () => { button(container, "Warning").click(); });
  assert.deepEqual(stored().colors, ["#d4c090", "#ffb347", "#ff7a45", "#ff4757"]);
  assert.equal(choiceSelected(container, "Warning"), "true");
  assert.equal(options(container).some((option) => option.text === "Custom"), false);
  await act(async () => { root.unmount(); });
});

test("a hand-edited colour is marked custom", async () => {
  const { container, root } = await mount();
  const colourInput = container.querySelectorAll('input[type="color"]')[1];
  await setInput(colourInput, "#123456");
  assert.equal(stored().colors[1], "#123456");
  const custom = options(container).find((option) => option.text === "Custom");
  assert.ok(custom, "der Custom-Marker fehlt");
  assert.equal(custom.selected, "true");
  await act(async () => { root.unmount(); });
});

test("sliders write pixels, seconds and opacity", async () => {
  const { container, root } = await mount();
  const [width, duration] = container.querySelectorAll('input[type="range"]');
  await setInput(width, "8");
  assert.equal(stored().borderWidthPx, 8);
  assert.match(container.textContent, /8px/);

  await setInput(duration, "1.2");
  assert.equal(stored().spinDurationMs, 1200);
  assert.match(container.textContent, /1.2s/);

  const opacity = container.querySelectorAll('input[type="range"]')[2];
  await setInput(opacity, "0.5");
  assert.equal(stored().glowOpacity, 0.5);
  assert.match(container.textContent, /0.50/);
  await act(async () => { root.unmount(); });
});

test("the glow switch and the variant buttons update the record", async () => {
  const { container, root } = await mount();
  const switches = container.querySelectorAll("button[aria-pressed]");
  await act(async () => { switches[1].click(); });
  assert.equal(stored().glowEnabled, false);

  await act(async () => { button(container, "Rotating layer").click(); });
  assert.equal(stored().variant, "rotate");
  const rotateChoice = button(container, "Rotating layer").parentElement;
  assert.equal(rotateChoice.getAttribute("data-selected"), "true");
  await act(async () => { root.unmount(); });
});

test("a browser without animatable angles forces the rotate variant", async () => {
  const css = globalThis.CSS;
  globalThis.CSS = { supports: () => true };
  try {
    const { container, root } = await mount({ ...DEFAULT_GRADIENT_BORDER_SETTINGS, enabled: true, variant: "angle" });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.match(container.textContent, /This browser cannot animate the gradient angle/);
    const rotate = button(container, "Rotating layer").parentElement;
    assert.equal(rotate.getAttribute("data-selected"), "true");
    await act(async () => { root.unmount(); });
  } finally {
    globalThis.CSS = css;
  }
});
