import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";

/**
 * Der Vertrauens-Dialog: solange die Anfrage laeuft, darf weder Escape noch
 * ein Klick daneben ihn schliessen — der Nutzer hat gerade "vertrauen"
 * gedrueckt, und ein zweiter, versehentlicher Klick soll die Antwort nicht
 * verwerfen. Genau diesen Guard (`blockWhileBusy`) prueft der Test an den
 * echten Ereignissen, die Radix' DismissableLayer liest.
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
globalThis.NodeFilter = win.NodeFilter ?? { SHOW_ELEMENT: 1 };
globalThis.DOMRect = class DOMRect {
  constructor(x = 0, y = 0, width = 0, height = 0) { Object.assign(this, { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height }); }
  static fromRect(rect = {}) { return new DOMRect(rect.x, rect.y, rect.width, rect.height); }
};
const storage = new Map([["pi-locale", "de"]]);
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => void storage.set(key, String(value)),
  removeItem: (key) => void storage.delete(key),
  clear: () => storage.clear(),
};
win.localStorage = globalThis.localStorage;

win.document.oninput = null;
win.document.onchange = null;
const { createRoot } = await import("react-dom/client");
const { ProjectTrustDialog } = await jiti.import(`${ROOT}/components/ProjectTrustDialog.tsx`);
const { I18nProvider } = await jiti.import(`${ROOT}/hooks/useI18n.tsx`);
const { deLocale } = await jiti.import(`${ROOT}/lib/i18n/messages/de.ts`);
const de = deLocale.messages;

const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); }); };
const buttons = () => [...win.document.querySelectorAll("button")];
const buttonWith = (text) => buttons().find((button) => button.textContent.trim() === text);
const escape = () => Object.assign(new win.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape", code: "Escape" });
const pointerDownOutside = () => Object.assign(new win.Event("pointerdown", { bubbles: true, cancelable: true }), { button: 0, pointerType: "mouse" });

async function mount(props) {
  win.document.body.innerHTML = "";
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(ProjectTrustDialog, {
      cwd: "/home/alice/workspace/demo",
      busy: false,
      error: null,
      onCancel: () => {},
      onConfirm: () => {},
      ...props,
    })));
  });
  await flush();
  return { container, root };
}

test("zeigt den Ordner, den Titel und den Fehler, wenn einer da ist", async () => {
  win.document.body.innerHTML = "";
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(ProjectTrustDialog, {
      cwd: "/home/alice/workspace/demo",
      busy: false,
      error: "Netzwerk nicht erreichbar",
      onCancel: () => {},
      onConfirm: () => {},
    })));
  });
  await flush();

  const dialog = win.document.querySelector('[data-slot="dialog-content"]');
  assert.ok(dialog, "der Dialog wurde nicht gerendert");
  assert.match(win.document.body.textContent, new RegExp(de["trust.dialogTitle"]));
  assert.match(win.document.body.textContent, new RegExp(de["trust.dialogBody"]));
  assert.match(win.document.body.textContent, /\/home\/alice\/workspace\/demo/);
  const alert = win.document.querySelector('[role="alert"]');
  assert.ok(alert, "die Fehlermeldung fehlt");
  assert.match(alert.textContent, /Netzwerk nicht erreichbar/);

  assert.ok(buttonWith(de["trust.trustProject"]), "der Bestaetigen-Knopf fehlt");
  assert.ok(buttonWith(de["trust.cancel"]), "der Abbrechen-Knopf fehlt");
  await act(async () => { root.unmount(); });
});

test("Bestaetigen und Abbrechen melden genau ihre Aktion", async () => {
  const calls = [];
  const { root } = await mount({
    onConfirm: () => calls.push("confirm"),
    onCancel: () => calls.push("cancel"),
  });

  await act(async () => { buttonWith(de["trust.trustProject"]).click(); });
  assert.deepEqual(calls, ["confirm"]);
  await act(async () => { buttonWith(de["trust.cancel"]).click(); });
  assert.deepEqual(calls, ["confirm", "cancel"]);
  await act(async () => { root.unmount(); });
});

test("waehrend busy blockiert Escape den Abbruch", async () => {
  const calls = [];
  const { root } = await mount({ busy: true, onCancel: () => calls.push("cancel") });
  assert.ok(buttonWith(de["trust.trusting"]), "der laufende Zustand hat keinen eigenen Text");

  await act(async () => { win.document.dispatchEvent(escape()); });
  await flush();
  assert.deepEqual(calls, [], "Escape hat den Dialog trotz laufender Anfrage geschlossen");

  // Auch der Klick daneben bricht nicht ab.
  await act(async () => { win.document.body.dispatchEvent(pointerDownOutside()); });
  await flush();
  assert.deepEqual(calls, [], "ein Klick daneben hat den Dialog trotz laufender Anfrage geschlossen");
  await act(async () => { root.unmount(); });
});

test("ohne busy schliesst Escape den Dialog", async () => {
  const calls = [];
  const { root } = await mount({ onCancel: () => calls.push("cancel") });

  await act(async () => { win.document.dispatchEvent(escape()); });
  await flush();
  assert.deepEqual(calls, ["cancel"]);
  await act(async () => { root.unmount(); });
});
