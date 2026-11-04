import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";

/**
 * `DialogTrigger` und `DialogClose` sind die beiden Knoepfe, die den Dialog
 * von aussen oeffnen und von innen schliessen. Der Test montiert einen
 * gesteuerten Dialog: nur so ist zu sehen, dass der Klick wirklich
 * `onOpenChange` erreicht und der Inhalt danach verschwindet — ein
 * statisches HTML koennte beides nicht zeigen.
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
const { Dialog, DialogTrigger, DialogContent, DialogClose, DialogHeader, DialogFooter, DialogTitle, DialogDescription } = await jiti.import(`${ROOT}/components/ui/dialog.tsx`);

const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); }); };

function ControlledDialog({ log }) {
  const [open, setOpen] = React.useState(false);
  return React.createElement(Dialog, {
    open,
    onOpenChange(next) { log.push(next); setOpen(next); },
  },
    React.createElement(DialogTrigger, null, "Öffnen"),
    open
      ? React.createElement(DialogContent, null,
        React.createElement(DialogHeader, null,
          React.createElement(DialogTitle, null, "Titel"),
          React.createElement(DialogDescription, null, "Beschreibung"),
        ),
        "Inhalt",
        React.createElement(DialogFooter, null,
          React.createElement(DialogClose, null, "Schließen"),
        ),
      )
      : null,
  );
}

test("Trigger oeffnet, Close schliesst und meldet den Wunsch nach oben", async () => {
  win.document.body.innerHTML = "";
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  const log = [];
  await act(async () => { root.render(React.createElement(ControlledDialog, { log })); });
  await flush();

  const trigger = container.querySelector('[data-slot="dialog-trigger"]');
  assert.ok(trigger, "der Trigger wurde nicht gerendert");
  assert.equal(trigger.tagName, "BUTTON");
  assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(win.document.querySelector('[data-slot="dialog-content"]'), null);

  await act(async () => { trigger.click(); });
  await flush();

  const content = win.document.querySelector('[data-slot="dialog-content"]');
  assert.ok(content, "der Dialog wurde durch den Trigger nicht geoeffnet");
  assert.match(content.textContent, /Inhalt/);
  assert.match(content.textContent, /Titel/);
  assert.equal(content.querySelector('[data-slot="dialog-header"]')?.textContent, "TitelBeschreibung");
  assert.equal(content.querySelector('[data-slot="dialog-title"]')?.getAttribute("id"), content.getAttribute("aria-labelledby"));
  assert.match(content.querySelector('[data-slot="dialog-footer"]')?.textContent ?? "", /Schließen/);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.deepEqual(log, [true]);

  const close = content.querySelector('[data-slot="dialog-footer"] [data-slot="dialog-close"]');
  assert.ok(close, "der Close-Knopf wurde nicht gerendert");
  await act(async () => { close.click(); });
  await flush();

  assert.deepEqual(log, [true, false]);
  assert.equal(win.document.querySelector('[data-slot="dialog-content"]'), null, "der Dialog blieb offen");
  await act(async () => { root.unmount(); });
});
