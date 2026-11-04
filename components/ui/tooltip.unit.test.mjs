import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";

/**
 * Der Tooltip oeffnet sich per Tastaturfokus, nicht per Hover — das ist der
 * Weg, den ein Screenreader-Nutzer nimmt, und der einzige, den linkedom ohne
 * PointerEvent ausloesen kann. Der Test montiert deshalb die ganze Kette
 * (Provider → Root → Trigger → Content) und prueft das Portal.
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
const fakeNavigator = { userAgent: "test", languages: ["de-DE"], language: "de-DE", platform: "linux" };
win.getComputedStyle = () => new Proxy({}, { get: (_t, p) => (typeof p === "string" && p.startsWith("get") ? () => "" : "0px") });
globalThis.window = new Proxy(win, {
  get(target, prop) {
    if (prop === "navigator") return fakeNavigator;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
  has(target, prop) { return prop === "navigator" || Reflect.has(target, prop); },
});
globalThis.document = win.document;
globalThis.navigator = fakeNavigator;
globalThis.getComputedStyle = win.getComputedStyle;
globalThis.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent() { return false; } });
win.matchMedia = globalThis.matchMedia;
for (const [name, value] of Object.entries(linkedom)) {
  if (name === "parseHTML" || name === "default") continue;
  if (typeof value === "function" && /^[A-Z]/.test(name)) globalThis[name] = value;
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
globalThis.DOMRect = class DOMRect {
  constructor(x = 0, y = 0, width = 0, height = 0) { Object.assign(this, { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height }); }
  static fromRect(rect = {}) { return new DOMRect(rect.x, rect.y, rect.width, rect.height); }
};

win.document.oninput = null;
win.document.onchange = null;
const { createRoot } = await import("react-dom/client");
const { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } = await jiti.import(`${ROOT}/components/ui/tooltip.tsx`);

const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); }); };

test("Fokus oeffnet den Tooltip, Fokusverlust schliesst ihn", async () => {
  win.document.body.innerHTML = "";
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(TooltipProvider, { delayDuration: 0 },
      React.createElement(Tooltip, null,
        React.createElement(TooltipTrigger, null, "Fokus"),
        React.createElement(TooltipContent, { sideOffset: 4 }, "Hinweis"),
      ),
    ));
  });
  await flush();

  const trigger = container.querySelector('[data-slot="tooltip-trigger"]');
  assert.ok(trigger, "der Trigger wurde nicht gerendert");
  assert.equal(win.document.querySelector('[role="tooltip"]'), null, "der Tooltip ist ohne Fokus bereits offen");

  await act(async () => { trigger.dispatchEvent(new win.Event("focusin", { bubbles: true })); });
  await flush();

  const tooltip = win.document.querySelector('[role="tooltip"]');
  assert.ok(tooltip, "der Tooltip wurde durch den Fokus nicht geoeffnet");
  assert.match(tooltip.textContent, /Hinweis/);
  assert.equal(tooltip.getAttribute("data-slot"), "tooltip-content");
  // Der Trigger verweist auf den Inhalt — ohne `aria-describedby` wird der
  // Hinweis nicht vorgelesen.
  assert.ok(trigger.getAttribute("aria-describedby"));
  assert.equal(trigger.getAttribute("aria-describedby"), tooltip.getAttribute("id"));

  await act(async () => { trigger.dispatchEvent(new win.Event("focusout", { bubbles: true })); });
  await flush();
  assert.equal(win.document.querySelector('[role="tooltip"]'), null, "der Tooltip blieb nach dem Fokusverlust offen");
  await act(async () => { root.unmount(); });
});
