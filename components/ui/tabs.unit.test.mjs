import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";

/**
 * `TabsContent` zeigt seinen Inhalt nur, wenn das Tab gewaehlt ist. Das ist
 * keine Eigenschaft des Markups, sondern des Zustands: der Test montiert
 * deshalb die echte Gruppe in linkedom und klickt den Reiter, statt das
 * gerenderte HTML zu vergleichen.
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
const { Tabs, TabsList, TabsTrigger, TabsContent } = await jiti.import(`${ROOT}/components/ui/tabs.tsx`);

async function mount(element) {
  win.document.body.innerHTML = "";
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return { container, root };
}

const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };

test("nur der Inhalt des gewaehlten Reiters ist sichtbar, Klick wechselt", async () => {
  const { container, root } = await mount(React.createElement(Tabs, { defaultValue: "eins" },
    React.createElement(TabsList, null,
      React.createElement(TabsTrigger, { value: "eins" }, "Eins"),
      React.createElement(TabsTrigger, { value: "zwei" }, "Zwei"),
    ),
    React.createElement(TabsContent, { value: "eins" }, "Inhalt eins"),
    React.createElement(TabsContent, { value: "zwei" }, "Inhalt zwei"),
  ));

  assert.match(container.textContent, /Inhalt eins/);
  assert.doesNotMatch(container.textContent, /Inhalt zwei/);
  // Der gewaehlte Reiter meldet seinen Zustand ueber `aria-selected`.
  const trigger = (text) => [...container.querySelectorAll('[data-slot="tabs-trigger"]')].find((el) => el.textContent.trim() === text);
  assert.equal(trigger("Eins").getAttribute("aria-selected"), "true");
  assert.equal(trigger("Zwei").getAttribute("aria-selected"), "false");

  // Radix schaltet beim `mousedown` um (der Klick käme danach); ein reiner
  // `click` lässt den Reiter in linkedom stehen.
  await act(async () => {
    trigger("Zwei").dispatchEvent(Object.assign(new win.Event("mousedown", { bubbles: true, cancelable: true }), { button: 0, ctrlKey: false }));
  });
  await flush();

  assert.match(container.textContent, /Inhalt zwei/);
  assert.doesNotMatch(container.textContent, /Inhalt eins/);
  assert.equal(trigger("Zwei").getAttribute("aria-selected"), "true");
  assert.equal(trigger("Eins").getAttribute("aria-selected"), "false");
  // `TabsContent` traegt seinen Slot und ist dem Reiter per `aria-labelledby`
  // zugeordnet — ohne diese Verbindung findet der Screenreader den Inhalt nicht.
  const content = container.querySelector('[data-slot="tabs-content"]');
  assert.ok(content);
  assert.equal(content.getAttribute("role"), "tabpanel");
  await act(async () => { root.unmount(); });
});
