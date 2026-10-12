import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React from "react";
import { createJiti } from "jiti";

/**
 * The mode check that `MotionConfig` does not do, measured rather than read.
 *
 * `MotionConfig reducedMotion` is evaluated in exactly two places inside
 * `node_modules/motion-dom/dist/cjs/index.js`: line ~3753, when an `animate`
 * target is resolved and only for `positionalKeys` (x/y/scale/rotate), and line
 * ~8997 for layout animations. A gesture runs through
 * `AnimationState.startAnimation` → `animateSingleValue` and never sees the
 * flag, and `repeat: Infinity` is not a layout animation either. So a spinner
 * or a pulse keeps moving with the setting on "Off" unless the component asks
 * for the mode itself — which is what `Pressable.tsx` and `Spin` do, and what
 * these four files now do.
 *
 * Every case is therefore measured twice: with the mode on `off` and with it on
 * `full`. The `full` run is the counter-check. Without it, "nothing moved" would
 * also be the answer for a component whose animation never ran at all, and the
 * test would pass on a broken render tree.
 */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };

// A bare proxy breaks linkedom, whose methods read internal state off `this`,
// so every function is bound to the real window. The trap exists only because
// linkedom rebuilds `window.navigator` on each access and the i18n provider
// reads `languages` while mounting.
globalThis.window = new Proxy(dom.window, {
  get(target, prop, receiver) {
    if (prop === "navigator") return fakeNavigator;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
globalThis.document = dom.document;
globalThis.navigator = fakeNavigator;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// motion and framer-motion reference DOM constructors as bare globals, and
// linkedom keeps them off `window`.
for (const [name, value] of Object.entries(linkedom)) {
  if (name === "parseHTML" || name === "default") continue;
  if (typeof value === "function" && /^[A-Z]/.test(name)) globalThis[name] = value;
}
for (const name of Object.keys(dom.window)) {
  // `dom.window.window` is the bare linkedom window; copying it would drop the
  // navigator trap set up above.
  if (name === "window") continue;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor && !descriptor.writable) continue;
  globalThis[name] = dom.window[name];
}
// Bun's own `Event` has a read-only `eventPhase`, which linkedom's
// `dispatchEvent` assigns to.
globalThis.Event = dom.window.Event;
globalThis.EventTarget = dom.window.EventTarget;

dom.window.matchMedia = () => ({
  matches: false,
  media: "",
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent() { return false; },
});
globalThis.matchMedia = dom.window.matchMedia;

// linkedom implements no layout and therefore no `getComputedStyle`. motion
// only reads the initial value of a property it has to interpolate from, and
// every element here sets its properties inline, so an empty declaration is
// the honest answer.
const computed = () => new Proxy({}, {
  get: (target, prop) => (typeof prop === "string" && prop.startsWith("get") ? () => "" : ""),
});
dom.window.getComputedStyle = computed;
globalThis.getComputedStyle = computed;

const storage = new Map();
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  clear: () => { storage.clear(); },
};
globalThis.localStorage = localStorage;
dom.window.localStorage = localStorage;

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { setAnimationMode } = await jiti.import("./motion/AnimationProvider.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const motionDom = await import("motion-dom");

/**
 * motion-dom grabs `requestAnimationFrame` once, when it is first imported, and
 * falls back to a no-op when there is none. Under `bun test` several files
 * share one module registry, so a file that imported motion earlier — before
 * this one installs the DOM globals — leaves the batcher with the no-op and no
 * animation ever renders. Whether that happened is detected rather than
 * assumed: one scheduled callback, and if it did not run, the frames are
 * pumped by hand.
 */
const STEPS_ORDER = ["setup", "read", "resolveKeyframes", "preUpdate", "update", "preRender", "render", "postRender"];

async function ensureFrameLoop() {
  let automatic = false;
  motionDom.frameSteps.render.schedule(() => { automatic = true; });
  await new Promise((r) => setTimeout(r, 60));
  if (automatic) return;

  const tick = (timestamp) => {
    const state = motionDom.frameData;
    state.timestamp = timestamp;
    state.delta = 16;
    state.isProcessing = true;
    for (const step of STEPS_ORDER) motionDom.frameSteps[step].process(state);
    state.isProcessing = false;
  };
  const start = performance.now();
  setInterval(() => tick(performance.now() + (performance.now() - start)), 16).unref?.();
}

globalThis.fetch = async (url) => {
  const href = String(url);
  if (href.includes("/api/terminal")) {
    return {
      ok: true,
      json: async () => ({
        terminals: [{ id: "t1", cwd: "/tmp", pid: 7, status: "running", shell: "bash", createdAt: 0, sandboxed: false }],
      }),
    };
  }
  return { ok: true, json: async () => ({ providers: [] }) };
};

function pointerEvent(type) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1 });
  return event;
}

async function mount(element) {
  const container = document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(I18nProvider, null, element)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
  return container;
}

/** The `transform`/`opacity` motion wrote, or the empty string if it wrote none. */
function motionState(element) {
  const style = element.getAttribute("style") ?? "";
  return {
    transform: /transform:[^;]*/.exec(style)?.[0] ?? "",
    opacity: /opacity:[^;]*/.exec(style)?.[0] ?? "",
  };
}

/**
 * Samples `transform` and `opacity` for `ms` and reports how many distinct
 * pairs were seen: 1 means the element stood still, more means it moved.
 */
async function countStates(element, ms) {
  const seen = new Set();
  const deadline = Date.now() + ms;
  do {
    const { transform, opacity } = motionState(element);
    seen.add(`${transform}|${opacity}`);
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  } while (Date.now() < deadline);
  return seen;
}

/**
 * Mounts `render` under the given mode and measures `select(container)`.
 *
 * `select` may be async and is retried: a dropdown has to fetch its list
 * first, and SyntaxHighlighter needs a tick before the preview exists.
 */
async function measure(mode, render, select, { press = false } = {}) {
  await ensureFrameLoop();
  setAnimationMode(mode);
  const container = await mount(render());
  let target;
  for (let attempt = 0; attempt < 40 && !target; attempt += 1) {
    target = await select(container);
    if (!target) await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  }
  assert.ok(target, `kein Messziel im Modus ${mode}`);
  if (press) {
    await act(async () => { target.dispatchEvent(pointerEvent("pointerdown")); });
  }
  const states = await countStates(target, 1000);
  if (press) {
    await act(async () => { target.dispatchEvent(pointerEvent("pointerup")); });
  }
  return states.size;
}

const OFF_STANDS_STILL = "steht im Modus off still, bewegt sich aber mit full";

test(`SubagentPanel: der Endlos-Spinner ${OFF_STANDS_STILL}`, async () => {
  const { SubagentPanel } = await jiti.import("./SubagentPanel.tsx");
  const render = () => React.createElement(SubagentPanel, {
    sessionId: "s1",
    subagents: [{ id: "a1", status: "running", agent: "worker", task: "t" }],
  });
  const selectSpinner = (container) =>
    [...container.querySelectorAll("svg")].find((svg) => svg.getAttribute("viewBox") === "0 0 16 16");

  const off = await measure("off", render, selectSpinner);
  const full = await measure("full", render, selectSpinner);
  assert.equal(off, 1, "der Spinner dreht sich im Modus off weiter");
  assert.ok(full > 1, "der Spinner dreht sich auch im Modus full nicht");
});

test(`TerminalDropdown: der Status-Punkt ${OFF_STANDS_STILL}`, async () => {
  const { TerminalDropdown } = await jiti.import("./TerminalDropdown.tsx");
  const render = () => React.createElement(TerminalDropdown, { onOpenTerminal: () => {} });
  const selectDot = async (container) => {
    const trigger = container.querySelector("button");
    await act(async () => { trigger.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 150)); });
    return [...container.querySelectorAll("span")].find((span) => span.getAttribute("aria-label") === "running");
  };

  const off = await measure("off", render, selectDot);
  const full = await measure("full", render, selectDot);
  assert.equal(off, 1, "der Status-Punkt pulsiert im Modus off weiter");
  assert.ok(full > 1, "der Status-Punkt pulsiert auch im Modus full nicht");
});

test(`TerminalDropdown: die Zeile ${OFF_STANDS_STILL}`, async () => {
  const { TerminalDropdown } = await jiti.import("./TerminalDropdown.tsx");
  const render = () => React.createElement(TerminalDropdown, { onOpenTerminal: () => {} });
  const selectRow = async (container) => {
    const trigger = container.querySelector("button");
    await act(async () => { trigger.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 150)); });
    return [...container.querySelectorAll('[role="menuitem"]')].find((row) => row.tagName === "DIV");
  };

  const off = await measure("off", render, selectRow, { press: true });
  const full = await measure("full", render, selectRow, { press: true });
  assert.equal(off, 1, "die Zeile skaliert im Modus off beim Druck weiter");
  assert.ok(full > 1, "die Zeile skaliert auch im Modus full nicht");
});

test(`MessageView: der Command-Cursor ${OFF_STANDS_STILL}`, async () => {
  const { MessageView } = await jiti.import("./MessageView.tsx");
  const render = () => React.createElement(MessageView, {
    message: {
      id: "m1",
      role: "assistant",
      timestamp: 0,
      content: [{ type: "toolCall", id: "t1", toolName: "bash", input: { command: "sleep 10" } }],
    },
  });
  const selectCursor = (container) => container.querySelector(".shell-output-body span");

  const off = await measure("off", render, selectCursor);
  const full = await measure("full", render, selectCursor);
  assert.equal(off, 1, "der Cursor pulsiert im Modus off weiter");
  assert.ok(full > 1, "der Cursor pulsiert auch im Modus full nicht");
});

test(`ModelsConfig: der Speichern-Knopf ${OFF_STANDS_STILL}`, async () => {
  const { ModelsConfig } = await jiti.import("./ModelsConfig.tsx");
  const render = () => React.createElement(ModelsConfig, { onClose: () => {} });
  const selectSave = async (container) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const button = [...container.querySelectorAll("button")]
        .find((el) => (el.textContent ?? "").trim().toLowerCase() === "save");
      if (button) return button;
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    }
    return undefined;
  };

  const off = await measure("off", render, selectSave, { press: true });
  const full = await measure("full", render, selectSave, { press: true });
  assert.equal(off, 1, "der Knopf skaliert im Modus off beim Druck weiter");
  assert.ok(full > 1, "der Knopf skaliert auch im Modus full nicht");
});