import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React from "react";
import { createJiti } from "jiti";

/**
 * The bar of the chat input and the gradient border.
 *
 * What is asserted is the behaviour the user sees: the ring is on the bar
 * while an agent works, it is not on the bar otherwise, and the border of the
 * bar keeps its width while the ring is painted — the bar must not move.
 */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };

// A bare proxy breaks linkedom, whose methods read internal state off `this`,
// so every function is bound to the real window. The trap exists only because
// linkedom rebuilds `window.navigator` on each access and the i18n provider
// reads `languages` while mounting.
globalThis.window = new Proxy(dom.window, {
  get(target, prop) {
    if (prop === "navigator") return fakeNavigator;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
globalThis.document = dom.document;
globalThis.navigator = fakeNavigator;

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

globalThis.fetch = async (url) => {
  const href = String(url);
  if (href.includes("/api/quick-phrases")) {
    return { ok: true, json: async () => ({ phrases: [] }) };
  }
  return { ok: true, json: async () => ({}) };
};

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { setGradientBorderSettings } = await jiti.import("./motion/GradientBorder.tsx");
const { DEFAULT_GRADIENT_BORDER_SETTINGS } = await jiti.import("./motion/gradient-border-settings.ts");
const { setAnimationMode } = await jiti.import("./motion/AnimationProvider.tsx");
const { setDraft, clearDraft } = await jiti.import("../lib/draft-store.ts");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

const mountedRoots = [];

async function mountInput(props) {
  const container = document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      modelList: [],
      modelNames: {},
      ...props,
    })));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return container;
}

/** The bar is the element the text field sits in. */
function bar(container) {
  const textarea = container.querySelector("textarea");
  assert.ok(textarea, "the input field was rendered");
  return textarea.parentElement;
}

test.afterEach(async () => {
  for (const root of mountedRoots.splice(0)) {
    await act(async () => { root.unmount(); });
  }
  clearDraft("gradient-border-test");
});

test.after(() => {
  setGradientBorderSettings(DEFAULT_GRADIENT_BORDER_SETTINGS);
  setAnimationMode("full");
});

test("the bar carries the ring while an agent works", async () => {
  setAnimationMode("full");
  setGradientBorderSettings({ ...DEFAULT_GRADIENT_BORDER_SETTINGS, enabled: true });
  const container = await mountInput({ isStreaming: false, isAgentRunning: true });
  const element = bar(container);
  assert.match(element.getAttribute("class") ?? "", /omp-gradient-border/, "the bar carries the ring");
  assert.match(element.getAttribute("class") ?? "", /is-running/, "the ring turns while the agent works");
});

test("the ring replaces the border colour and keeps the border width", async () => {
  setAnimationMode("full");
  setGradientBorderSettings({ ...DEFAULT_GRADIENT_BORDER_SETTINGS, enabled: true });
  const container = await mountInput({ isStreaming: false, isAgentRunning: true });
  const style = bar(container).getAttribute("style") ?? "";
  assert.match(style, /border:\s*1px solid transparent/, "the border gives its colour to the ring");
  assert.match(style, /border:\s*1px/, "the border keeps its width, so the bar does not move");
  assert.match(style, /padding:\s*10px 10px 10px 14px/, "the padding of the bar is untouched");
});

test("the amber border of a running agent is gone while the ring is on", async () => {
  setAnimationMode("full");
  setGradientBorderSettings({ ...DEFAULT_GRADIENT_BORDER_SETTINGS, enabled: true });
  const container = await mountInput({
    isStreaming: true,
    isAgentRunning: true,
    onSteer() {},
    onFollowUp() {},
  });
  const style = bar(container).getAttribute("style") ?? "";
  assert.doesNotMatch(style, /rgba\(234,\s*179,\s*8/, "the amber border does not fight the ring");
  assert.match(style, /border:\s*1px solid transparent/);
});

test("the amber border is still there when the ring is not", async () => {
  setAnimationMode("full");
  setGradientBorderSettings({ ...DEFAULT_GRADIENT_BORDER_SETTINGS, enabled: false });
  const container = await mountInput({
    isStreaming: true,
    isAgentRunning: true,
    onSteer() {},
    onFollowUp() {},
  });
  const element = bar(container);
  const style = element.getAttribute("style") ?? "";
  assert.doesNotMatch(element.getAttribute("class") ?? "", /omp-gradient-border/, "no ring without the effect");
  assert.match(style, /rgba\(234,\s*179,\s*8,\s*0\.4\)/, "the amber border keeps its place");
});

test("an idle bar keeps its own border", async () => {
  setAnimationMode("full");
  setGradientBorderSettings({ ...DEFAULT_GRADIENT_BORDER_SETTINGS, enabled: true });
  const container = await mountInput({ isStreaming: false, isAgentRunning: false });
  const element = bar(container);
  assert.doesNotMatch(element.getAttribute("class") ?? "", /omp-gradient-border/);
  assert.match(element.getAttribute("style") ?? "", /color-mix\(in srgb, var\(--border\)/);
});

test("the shell mode keeps the bar to itself", async () => {
  setAnimationMode("full");
  setGradientBorderSettings({ ...DEFAULT_GRADIENT_BORDER_SETTINGS, enabled: true });
  setDraft("gradient-border-test", { value: "!ls", images: [] });
  const container = await mountInput({ isStreaming: false, isAgentRunning: true, draftKey: "gradient-border-test" });
  const element = bar(container);
  assert.doesNotMatch(element.getAttribute("class") ?? "", /omp-gradient-border/, "a shell command is not an agent");
  assert.match(element.getAttribute("style") ?? "", /border:\s*1px solid var\(--tool-bg\)/);
});

test("the animations switched off leave the bar with its own border", async () => {
  setAnimationMode("off");
  setGradientBorderSettings({ ...DEFAULT_GRADIENT_BORDER_SETTINGS, enabled: true });
  const container = await mountInput({ isStreaming: false, isAgentRunning: true });
  const element = bar(container);
  assert.doesNotMatch(element.getAttribute("class") ?? "", /omp-gradient-border/);
  assert.doesNotMatch(element.getAttribute("style") ?? "", /border:\s*1px solid transparent/);
});
