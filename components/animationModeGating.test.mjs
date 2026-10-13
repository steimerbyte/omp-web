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
 *
 * **Motion is observed, not sampled.** The measurement used to read
 * `getAttribute("style")` every 25 ms and count the distinct strings it saw.
 * That is a race, and it lost: the ModelsConfig save button failed in roughly
 * a third of all runs with "skaliert auch im Modus full nicht". Instrumenting
 * the writes showed why — the press animation is `DURATION_FAST`, 120 ms, and
 * it is *written* within about 1 ms of the press, landing on two values
 * (`transform: scale(0.999…)` then `transform: scale(0.96)`). Whether the 25 ms
 * poll caught the intermediate value or only the settled one was decided by
 * where the sampler happened to land: measured `distinct` was 2 when the poll
 * split the two writes and 1 when it did not, and the assertion `full > 1` then
 * failed although motion had demonstrably animated. Nothing about the app
 * varied between those runs.
 *
 * So `recordWrites` intercepts the assignments themselves and `waitForMotion`
 * returns on the first one, with a timeout as the ceiling rather than as the
 * wait. The `off` case still sits out the full second — a negative is only
 * established by watching — which is what keeps it a real check rather than a
 * race that happens to pass.
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
  // `performance.now()`, plain. Adding the elapsed time again — as this once
  // did — hands motion a clock running at twice wall speed, so `delta` becomes
  // the gap between two inflated stamps (32 ms per 16 ms tick) and every
  // duration in the app is silently halved.
  setInterval(() => tick(performance.now()), 16).unref?.();
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

/**
 * `bun test` laesst alle Dateien in einem Prozess laufen. Ein nicht
 * abgemeldeter Root bleibt am 16-ms-Frame-Loop haengen und ruft nach dem Ende
 * dieses Tests weiter `setState` auf einem Baum, dessen `terminals`-Zustand
 * die naechste Datei schon abgebaut hat — das schlug als
 * `terminals.filter is not a function` in `lib/write-access.identity.test.mjs`
 * durch, also scheinbar ein Fehler dieser Datei. Die Wurzeln werden deshalb
 * nach dem Lauf abgemeldet.
 */
const mountedRoots = [];

async function mount(element) {
  const container = document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => { root.render(React.createElement(I18nProvider, null, element)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
  return container;
}

test.after(async () => {
  for (const root of mountedRoots.splice(0)) {
    await act(async () => { root.unmount(); });
  }
});

/**
 * Records every value motion writes to `element`'s inline style.
 *
 * Neither of the two obvious observers works here. `MutationObserver`
 * coalesces a burst of writes into a single record, so it cannot count them —
 * measured: four consecutive writes, one record — and motion assigns
 * camelCase properties straight onto the style object instead of going through
 * `setProperty`, so patching that method records nothing. The proxy sees every
 * assignment, including the ones that land between two sampling ticks.
 */
function recordWrites(element) {
  const writes = [];
  const proxy = new Proxy(element.style, {
    set(target, prop, value) {
      writes.push(`${String(prop)}:${String(value)}`);
      target[prop] = value;
      return true;
    },
    get(target, prop) {
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  Object.defineProperty(element, "style", { value: proxy, writable: true, configurable: true });
  return writes;
}

/** The recorded writes that actually moved the element, i.e. the ones under test. */
function movedWrites(writes) {
  return writes.filter((write) => write.startsWith("transform:") || write.startsWith("opacity:"));
}

/**
 * Waits until motion has written a `transform`/`opacity` value, then returns.
 * `timeout` is the upper bound, not a fixed wait: the call returns the moment
 * the state is reached, and only runs out the clock when nothing is coming.
 */
async function waitForMotion(writes, timeout) {
  const deadline = Date.now() + timeout;
  while (movedWrites(writes).length === 0 && Date.now() < deadline) {
    await act(async () => { await new Promise((r) => setTimeout(r, 16)); });
  }
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
  const writes = recordWrites(target);
  if (press) {
    await act(async () => { target.dispatchEvent(pointerEvent("pointerdown")); });
  }
  // With `full` this returns the instant motion writes; with `off` nothing ever
  // arrives, so it sits out the whole window. That asymmetry is the point: the
  // negative case is only established by watching, the positive one by arrival.
  await waitForMotion(writes, 1000);
  if (press) {
    await act(async () => { target.dispatchEvent(pointerEvent("pointerup")); });
  }
  return movedWrites(writes).length;
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
  assert.equal(off, 0, "der Spinner dreht sich im Modus off weiter");
  assert.ok(full > 0, "der Spinner dreht sich auch im Modus full nicht");
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
  assert.equal(off, 0, "der Status-Punkt pulsiert im Modus off weiter");
  assert.ok(full > 0, "der Status-Punkt pulsiert auch im Modus full nicht");
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
  assert.equal(off, 0, "die Zeile skaliert im Modus off beim Druck weiter");
  assert.ok(full > 0, "die Zeile skaliert auch im Modus full nicht");
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
  assert.equal(off, 0, "der Cursor pulsiert im Modus off weiter");
  assert.ok(full > 0, "der Cursor pulsiert auch im Modus full nicht");
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
  assert.equal(off, 0, "der Knopf skaliert im Modus off beim Druck weiter");
  assert.ok(full > 0, "der Knopf skaliert auch im Modus full nicht");
});