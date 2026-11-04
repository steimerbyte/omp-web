import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";

/**
 * `updateGradientBorderSettings` ist der Schreibweg des Speichers: es mischt
 * einen Ausschnitt in die geltenden Einstellungen, schreibt sie in
 * `localStorage` und benachrichtigt die Abonnenten — aber nur, wenn sich
 * wirklich etwas geaendert hat. Der Test haelt alle drei Folgen fest, weil
 * jede einzelne den Rand sichtbar falsch machen wuerde.
 */

const ROOT = process.cwd();
const jiti = createJiti(`${ROOT}/package.json`, { jsx: { runtime: "automatic" }, tsconfigPaths: true });

/* Die Globals, die diese Datei ersetzt, gehoeren ihr nicht: `bun test` faehrt
 * alle Dateien in einem Prozess, und was hier stehen bleibt, sieht die
 * naechste Datei. Der Schnappschuss entsteht vor dem ersten Eingriff. */
const ORIGINALS = {
  window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator,
  getComputedStyle: globalThis.getComputedStyle, matchMedia: globalThis.matchMedia,
  localStorage: globalThis.localStorage, Event: globalThis.Event, EventTarget: globalThis.EventTarget,
  DOMRect: globalThis.DOMRect, NodeFilter: globalThis.NodeFilter,
};
test.after(() => {
  for (const [name, value] of Object.entries(ORIGINALS)) {
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  }
});

const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
win.getComputedStyle = () => new Proxy({}, { get: (_t, p) => (typeof p === "string" && p.startsWith("get") ? () => "" : "0px") });
globalThis.window = win;
globalThis.document = win.document;
globalThis.getComputedStyle = win.getComputedStyle;
globalThis.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent() { return false; } });
win.matchMedia = globalThis.matchMedia;
for (const [name, value] of Object.entries(linkedom)) {
  if (name === "parseHTML" || name === "default") continue;
  if (typeof value === "function" && /^[A-Z]/.test(name)) globalThis[name] = value;
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => void storage.set(key, String(value)),
  removeItem: (key) => void storage.delete(key),
};
win.localStorage = globalThis.localStorage;

win.document.oninput = null;
win.document.onchange = null;
const { createRoot } = await import("react-dom/client");
const { setGradientBorderSettings, updateGradientBorderSettings, useGradientBorderSettings } =
  await jiti.import(`${ROOT}/components/motion/GradientBorder.tsx`);
const { DEFAULT_GRADIENT_BORDER_SETTINGS, GRADIENT_BORDER_STORAGE_KEY } =
  await jiti.import(`${ROOT}/components/motion/gradient-border-settings.ts`);

const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };

test("ein Ausschnitt wird gemischt, gespeichert und an die Abonnenten gemeldet", async () => {
  storage.clear();
  setGradientBorderSettings(DEFAULT_GRADIENT_BORDER_SETTINGS);

  const seen = [];
  let renders = 0;
  function Probe() {
    const settings = useGradientBorderSettings();
    renders += 1;
    seen.push(settings);
    return React.createElement("span", null, `${settings.enabled ? "an" : "aus"}:${settings.borderWidthPx}`);
  }
  win.document.body.innerHTML = "";
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(Probe)); });
  await flush();
  assert.equal(container.textContent, "aus:6");

  await act(async () => { updateGradientBorderSettings({ enabled: true, borderWidthPx: 7 }); });
  await flush();

  const current = seen.at(-1);
  assert.equal(current.enabled, true);
  assert.equal(current.borderWidthPx, 7);
  // Nicht gepatchte Felder bleiben stehen.
  assert.deepEqual(current.colors, DEFAULT_GRADIENT_BORDER_SETTINGS.colors);
  assert.equal(current.spinDurationMs, DEFAULT_GRADIENT_BORDER_SETTINGS.spinDurationMs);
  assert.equal(current.variant, DEFAULT_GRADIENT_BORDER_SETTINGS.variant);
  assert.equal(container.textContent, "an:7");

  const stored = JSON.parse(storage.get(GRADIENT_BORDER_STORAGE_KEY));
  assert.equal(stored.enabled, true);
  assert.equal(stored.borderWidthPx, 7);
  assert.equal(stored.spinDurationMs, DEFAULT_GRADIENT_BORDER_SETTINGS.spinDurationMs);

  // Ein Patch ohne Aenderung benachrichtigt niemanden — sonst liefe bei jedem
  // Tastendruck im Panel ein Render durch den ganzen Baum.
  const rendersBefore = renders;
  await act(async () => { updateGradientBorderSettings({ enabled: true, borderWidthPx: 7 }); });
  await flush();
  assert.equal(renders, rendersBefore);

  // Und ein spaeterer echter Wechsel kommt wieder an.
  await act(async () => { updateGradientBorderSettings({ variant: "rotate" }); });
  await flush();
  assert.equal(seen.at(-1).variant, "rotate");
  assert.equal(container.textContent, "an:7");
  await act(async () => { root.unmount(); });
});
