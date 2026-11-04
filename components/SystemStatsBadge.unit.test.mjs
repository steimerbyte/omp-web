import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

/**
 * SystemStatsBadge: Tooltip-Text, Kennzahlen im Kopf und das Popover mit den
 * drei Sparklines. Die Messung ist Verhalten am DOM (Text, `aria-expanded`,
 * geoeffnetes Dialog-Element, Anzahl der Sparklines), keine Quelltextpruefung.
 */

const ROOT = process.cwd();
const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
restoreLinkedomPrototypesOnExit(win);

const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US" };
const storage = new Map();
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => void storage.set(key, String(value)),
  removeItem: (key) => void storage.delete(key),
  clear: () => storage.clear(),
};

const ORIGINALS = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
  localStorage: globalThis.localStorage,
  fetch: globalThis.fetch,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
};

win.innerWidth = 1200;
win.innerHeight = 800;
win.localStorage = localStorage;
win.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {} });
globalThis.window = new Proxy(win, {
  get(target, property) {
    if (property === "navigator") return fakeNavigator;
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
  has(target, property) {
    return property === "navigator" || Reflect.has(target, property);
  },
});
globalThis.document = win.document;
globalThis.navigator = fakeNavigator;
globalThis.localStorage = localStorage;
for (const [name, value] of Object.entries(linkedom)) {
  if (name === "parseHTML" || name === "default") continue;
  if (typeof value === "function" && /^[A-Z]/.test(name)) globalThis[name] = value;
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
win.getComputedStyle = () => new Proxy({}, { get: (_target, property) => (typeof property === "string" && property.startsWith("get") ? () => "" : "0px") });
globalThis.getComputedStyle = win.getComputedStyle;

const mounted = [];
test.after(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  for (const key of ["window", "document", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"]) {
    const value = ORIGINALS[key];
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});

const jiti = createJiti(`${ROOT}/package.json`, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { SystemStatsBadge } = await jiti.import(`${ROOT}/components/SystemStatsBadge.tsx`);

const STATS = {
  cpuPercent: 42,
  cpuCores: 8,
  cpuCoresSource: "cgroup",
  loadAvg: { "1m": 0.5, "5m": 0.4, "15m": 0.3 },
  memory: { totalBytes: 2 ** 34, usedBytes: 2 ** 33, usedPercent: 50, totalSource: "cgroup" },
  gpu: {
    present: true,
    vendor: "nvidia",
    utilizationPercent: 73.4,
    memoryUsedBytes: 2 ** 31,
    memoryTotalBytes: 2 ** 32,
    source: "nvidia-smi",
  },
  process: { pid: 1234, rssBytes: 512 * 1024 * 1024, heapBytes: 1024, uptimeSec: 10 },
  sampledAt: Date.now(),
};

function installFetch(payload) {
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "/api/system-stats");
    return { ok: true, status: 200, json: async () => payload };
  };
}

function fire(target, type, props = {}) {
  const event = new win.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(event, key, { value, configurable: true });
  }
  target.dispatchEvent(event);
  return event;
}

async function click(target, props = {}) {
  await act(async () => {
    fire(target, "click", props);
  });
}

async function mount() {
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    root.render(React.createElement(SystemStatsBadge));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  mounted.push({ root, container });
  return { root, container };
}

test("zeigt CPU, RAM und GPU und oeffnet die History mit 10-Sekunden-Fenster", async () => {
  installFetch(STATS);
  const { root, container } = await mount();

  const button = container.querySelector("button");
  assert.ok(button, "der Badge-Knopf fehlt");
  assert.match(button.textContent, /CPU42%8c/);
  assert.match(button.textContent, /RAM50%16\.0 GB/);
  assert.match(button.textContent, /GPU73%nvidia/);
  assert.match(button.getAttribute("title"), /CPU: 42\.0% across 8 cores/);
  assert.match(button.getAttribute("title"), /memory 8\.0 GB of 16\.0 GB/);
  assert.match(button.getAttribute("title"), /GPU: 73\.4% · 2\.0 GB of 4\.0 GB/);
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(container.querySelector('[role="dialog"]'), null);

  await act(async () => {
    fire(button, "mouseover", { relatedTarget: win.document.body });
    fire(button, "mouseout", { relatedTarget: win.document.body });
  });

  await click(button);

  const dialog = container.querySelector('[role="dialog"]');
  assert.ok(dialog, "das Popover wurde nicht geoeffnet");
  assert.equal(dialog.getAttribute("aria-label"), "System resource history");
  assert.match(dialog.textContent, /last 10s · [12] samples/);
  assert.match(dialog.textContent, /cores: 8 · loadavg 0\.50 \/ 0\.40 \/ 0\.30/);
  assert.match(dialog.textContent, /mem: 8\.0 GB \/ 16\.0 GB/);
  assert.match(dialog.textContent, /gpu: 73% · 2\.0 GB \/ 4\.0 GB vram/);
  assert.match(dialog.textContent, /pid: 1234 · rss: 512 MB/);
  assert.match(dialog.textContent, /total ram: cgroup/);
  assert.match(dialog.textContent, /core count: cgroup/);
  assert.match(dialog.textContent, /gpu source: nvidia-smi/);

  const sparklines = dialog.querySelectorAll('svg[role="img"]');
  assert.equal(sparklines.length, 3, "CPU, RAM und GPU brauchen je eine Sparkline");
  assert.equal(sparklines[0].getAttribute("aria-label"), "last 10 seconds");
  assert.ok(sparklines[0].querySelector("circle"), "der letzte Messpunkt fehlt");

  const close = [...dialog.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === "Close");
  assert.ok(close);
  await click(close);
  assert.equal(container.querySelector('[role="dialog"]'), null);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Escape und ein Klick ausserhalb schliessen das Popover", async () => {
  installFetch(STATS);
  const { root, container } = await mount();
  const button = container.querySelector("button");

  await click(button);
  assert.ok(container.querySelector('[role="dialog"]'));

  await act(async () => {
    fire(win.document, "keydown", { key: "Escape" });
  });
  assert.equal(container.querySelector('[role="dialog"]'), null);

  await click(button);
  assert.ok(container.querySelector('[role="dialog"]'));

  await act(async () => {
    fire(win.document.body, "mousedown");
  });
  assert.equal(container.querySelector('[role="dialog"]'), null);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("ohne GPU und ohne Messwerte bleibt der Kopf bei Gedankenstrichen", async () => {
  installFetch({
    ...STATS,
    cpuPercent: null,
    gpu: { present: false, vendor: null, utilizationPercent: null, memoryUsedBytes: null, memoryTotalBytes: null, source: null },
  });
  const { root, container } = await mount();
  const button = container.querySelector("button");

  assert.match(button.textContent, /CPU—8c/);
  assert.match(button.textContent, /GPU—/);
  assert.match(button.getAttribute("title"), /no GPU detected/);
  assert.doesNotMatch(button.getAttribute("title"), /vram/);

  await click(button);
  const dialog = container.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /gpu: none detected/);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("zeigt collecting… solange kein Messwert da ist", async () => {
  globalThis.fetch = () => new Promise(() => {});
  const { root, container } = await mount();
  const button = container.querySelector("button");

  await click(button);
  const dialog = container.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.match(dialog.textContent, /last 10s · 0 samples/);
  assert.equal(dialog.querySelectorAll("text").length, 3, "jede leere Sparkline zeigt collecting…");

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("ein Netzfehler laesst den letzten Messwert stehen", async () => {
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  const { root, container } = await mount();
  const button = container.querySelector("button");

  assert.match(button.textContent, /CPU—/);
  assert.match(button.getAttribute("title"), /Loading…/);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Intel-GPU: Praesenz ohne Lastzaehler wird benannt", async () => {
  installFetch({
    ...STATS,
    gpu: { present: true, vendor: "intel", utilizationPercent: null, memoryUsedBytes: null, memoryTotalBytes: null, source: "sysfs" },
  });
  const { root, container } = await mount();
  const button = container.querySelector("button");

  assert.match(button.getAttribute("title"), /intel gpu, driver exposes no load counter/);
  await click(button);
  const dialog = container.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /gpu: intel, no load counter exposed/);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("GPU mit Last aber ohne Speicherzaehler bleibt bei der Prozentzahl", async () => {
  installFetch({
    ...STATS,
    gpu: { present: true, vendor: "nvidia", utilizationPercent: 55, memoryUsedBytes: null, memoryTotalBytes: null, source: "nvidia-smi" },
  });
  const { root, container } = await mount();
  const button = container.querySelector("button");

  assert.match(button.getAttribute("title"), /GPU: 55\.0%/);
  assert.doesNotMatch(button.getAttribute("title"), /vram/);
  await click(button);
  const dialog = container.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /gpu: 55%/);
  assert.doesNotMatch(dialog.textContent, /vram/);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});
