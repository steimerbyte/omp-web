import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React from "react";
import { createJiti } from "jiti";

/**
 * The React binding of the gradient border.
 *
 * The store is measured, not read: a change has to reach the subscribers, and
 * the bar has to carry the class exactly while an agent works and the effect
 * is switched on. The counter-check runs with the same component and the same
 * settings, so "no class" cannot be the answer of a component that never
 * rendered.
 */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
globalThis.window = dom.window;
globalThis.document = dom.document;
globalThis.navigator = { userAgent: "test", languages: ["en-US"], language: "en-US" };

const storage = new Map();
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  clear: () => { storage.clear(); },
};
globalThis.localStorage = localStorage;
dom.window.localStorage = localStorage;

// A browser that can paint a cone and animate a registered custom property.
globalThis.CSS = {
  supports: () => true,
  registerProperty: () => {},
};

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { setGradientBorderSettings, useGradientBorderBar, useGradientBorderSettings } =
  await jiti.import("./GradientBorder.tsx");
const { DEFAULT_GRADIENT_BORDER_SETTINGS } = await jiti.import("./gradient-border-settings.ts");
const { setAnimationMode } = await jiti.import("./AnimationProvider.tsx");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

function Probe({ running, suppressed }) {
  const settings = useGradientBorderSettings();
  const bar = useGradientBorderBar({ running, suppressed });
  return React.createElement("div", {
    id: "probe",
    "data-class": bar.className,
    "data-active": String(bar.active),
    "data-variant": bar.variant,
    "data-enabled": String(settings.enabled),
    "data-width": String(settings.borderWidthPx),
  });
}

const mountedRoots = [];

async function mount(element) {
  const container = document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => { root.render(element); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return container;
}

function probe(container) {
  return container.querySelector("#probe");
}

// Every root is unmounted after its test. A root that stays mounted would
// still hear the store of the next test, and its update would land outside
// `act` — a warning that says nothing about the code under test.
test.afterEach(async () => {
  for (const root of mountedRoots.splice(0)) {
    await act(async () => { root.unmount(); });
  }
});

test.after(() => {
  setGradientBorderSettings(DEFAULT_GRADIENT_BORDER_SETTINGS);
  setAnimationMode("full");
  globalThis.CSS = { supports: () => true, registerProperty: () => {} };
});

test("the hook hands out the values that were stored", async () => {
  setGradientBorderSettings({ ...DEFAULT_GRADIENT_BORDER_SETTINGS, enabled: true, borderWidthPx: 5 });
  const container = await mount(React.createElement(Probe, { running: true }));
  assert.equal(probe(container).getAttribute("data-enabled"), "true");
  assert.equal(probe(container).getAttribute("data-width"), "5");
});

test("a change reaches the subscribers and the component", async () => {
  setGradientBorderSettings(DEFAULT_GRADIENT_BORDER_SETTINGS);
  const container = await mount(React.createElement(Probe, { running: true }));
  assert.equal(probe(container).getAttribute("data-enabled"), "false", "the counter-check: the probe does render");

  await act(async () => {
    setGradientBorderSettings({ ...DEFAULT_GRADIENT_BORDER_SETTINGS, enabled: true });
  });

  assert.equal(probe(container).getAttribute("data-enabled"), "true", "the change reached the component");
  const stored = JSON.parse(storage.get("omp-gradient-border"));
  assert.equal(stored.enabled, true, "the change was written to the storage of the surface preferences");
});

test("the bar carries the ring while an agent works and the effect is on", async () => {
  setGradientBorderSettings({ ...DEFAULT_GRADIENT_BORDER_SETTINGS, enabled: true });
  const container = await mount(React.createElement(Probe, { running: true }));
  const className = probe(container).getAttribute("data-class");
  assert.match(className, /omp-gradient-border/, "the bar carries the ring");
  assert.match(className, /is-running/, "the ring turns while the agent works");
  assert.equal(probe(container).getAttribute("data-active"), "true");
});

test("no agent, no ring", async () => {
  setGradientBorderSettings({ ...DEFAULT_GRADIENT_BORDER_SETTINGS, enabled: true });
  const container = await mount(React.createElement(Probe, { running: false }));
  assert.equal(probe(container).getAttribute("data-class"), "", "an idle bar keeps its own border");
  assert.equal(probe(container).getAttribute("data-active"), "false");
});

test("the effect switched off leaves the bar alone", async () => {
  setGradientBorderSettings({ ...DEFAULT_GRADIENT_BORDER_SETTINGS, enabled: false });
  const container = await mount(React.createElement(Probe, { running: true }));
  assert.equal(probe(container).getAttribute("data-class"), "", "an effect that is off paints no ring");
  assert.equal(probe(container).getAttribute("data-active"), "false");
});

test("a ring of no width paints nothing", async () => {
  setGradientBorderSettings({ ...DEFAULT_GRADIENT_BORDER_SETTINGS, enabled: true, borderWidthPx: 0 });
  const container = await mount(React.createElement(Probe, { running: true }));
  assert.equal(probe(container).getAttribute("data-class"), "");
});

test("the shell mode keeps the bar to itself", async () => {
  setGradientBorderSettings({ ...DEFAULT_GRADIENT_BORDER_SETTINGS, enabled: true });
  const container = await mount(React.createElement(Probe, { running: true, suppressed: true }));
  assert.equal(probe(container).getAttribute("data-class"), "", "a shell command is not an agent");
});

test("the animations switched off stop the ring", async () => {
  setGradientBorderSettings({ ...DEFAULT_GRADIENT_BORDER_SETTINGS, enabled: true });
  setAnimationMode("off");
  const container = await mount(React.createElement(Probe, { running: true }));
  assert.equal(probe(container).getAttribute("data-class"), "", "nothing turns while the animations are off");
  assert.equal(probe(container).getAttribute("data-active"), "false");
});

test("a browser without a cone paints no ring at all", async () => {
  setAnimationMode("full");
  setGradientBorderSettings({ ...DEFAULT_GRADIENT_BORDER_SETTINGS, enabled: true });
  globalThis.CSS = { supports: () => false };
  const container = await mount(React.createElement(Probe, { running: true }));
  assert.equal(probe(container).getAttribute("data-class"), "", "the bar keeps its border instead of a transparent one");
});

test("a browser that cannot animate an angle turns the layer instead", async () => {
  setAnimationMode("full");
  setGradientBorderSettings({ ...DEFAULT_GRADIENT_BORDER_SETTINGS, enabled: true, variant: "angle" });
  globalThis.CSS = { supports: () => true };
  const container = await mount(React.createElement(Probe, { running: true }));
  assert.equal(probe(container).getAttribute("data-variant"), "rotate", "the layer is the variant that works there");
  assert.match(probe(container).getAttribute("data-class"), /omp-gradient-rotate/, "the bar asks for the layer");
});
