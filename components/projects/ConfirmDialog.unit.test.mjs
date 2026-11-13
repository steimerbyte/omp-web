import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";
import { restoreLinkedomPrototypesOnExit } from "../../lib/test-linkedom.mjs";

/**
 * Der Loesch-Dialog ist die Rueckfrage, nicht der Schutz (der liegt in der
 * Route). Was hier zaehlt, ist deshalb genau das, was der Nutzer drueckt:
 * Bestaetigen ruft `onConfirm`, Abbrechen und der Klick daneben rufen
 * `onCancel`, ein geschuetzter Ordner laesst sich nicht bestaetigen, und
 * waehrend einer laufenden Anfrage tut keiner der Wege etwas.
 *
 * Die Texte kommen aus dem deutschen Sprachpaket — der Test schreibt sie
 * nicht ab, sondern vergleicht gegen die Quelle.
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
restoreLinkedomPrototypesOnExit(win);
const fakeNavigator = { userAgent: "test", languages: ["de-DE"], language: "de-DE", platform: "linux" };
win.getComputedStyle = () => new Proxy({}, { get: (_t, p) => (typeof p === "string" && p.startsWith("get") ? () => "" : "0px") });
// linkedom hat keinen Fokus: `document.activeElement` ist `undefined` und
// `focus()` tut nichts. Beides wird hier ersetzt, sonst ist der Rueckweg des
// Fokus auf den Ausloeser nicht messbar. Ein Element, das ausgebaut wurde,
// verliert den Fokus wie in Chromium.
let activeElement = win.document.body;
Object.defineProperty(win.document, "activeElement", {
  get: () => (activeElement?.isConnected === false ? win.document.body : activeElement),
  configurable: true,
});
/** Eigener Setter statt `activeElement = this`: `no-this-alias` verbietet das. */
function setActive(element) {
  activeElement = element;
}
win.HTMLElement.prototype.focus = function focus() {
  const tag = this.tagName;
  if (!(tag === "BUTTON" || tag === "INPUT" || tag === "TEXTAREA" || tag === "A" || tag === "SELECT") && !this.hasAttribute("tabindex")) return;
  setActive(this);
};
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
const { ConfirmDialog } = await jiti.import(`${ROOT}/components/projects/ConfirmDialog.tsx`);
const { I18nProvider } = await jiti.import(`${ROOT}/hooks/useI18n.tsx`);
const { deLocale } = await jiti.import(`${ROOT}/lib/i18n/messages/de.ts`);
const de = deLocale.messages;

const PROJECT = {
  root: "/home/alice/workspace/demo",
  name: "demo",
  priority: "later",
  openTodos: 2,
  status: "green",
  createdAt: "2026-01-01T00:00:00Z",
  lastTouchedAt: "2026-01-02T00:00:00Z",
  lastSessionAt: null,
  lastActivityAt: "2026-01-02T00:00:00Z",
  chatCount: 3,
  isGit: false,
  branch: null,
};

const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); }); };
const buttons = () => [...win.document.querySelectorAll("button")];
const buttonWith = (text) => buttons().find((button) => button.textContent.trim() === text);
// Radix haengt den Dialog als Portal an `document.body`; der Komponenten-
// Container enthaelt ihn also nicht mehr.
const dialog = () => win.document.querySelector('[role="alertdialog"]');
const escape = () => Object.assign(new win.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape", code: "Escape" });
// `button: 1` statt 0: bei der linken Taste wartet Radix' `DismissableLayer`
// auf den folgenden `click` und liest dabei das `target` des weggeworfenen
// `pointerdown`. linkedom setzt `target` nur waehrend des Versands zurueck,
// danach ist es `undefined` — die mittlere Taste nimmt den direkten Weg, der
// dieselbe Absicht prueft (" pointerdown ausserhalb").
const pointerDownOutside = () => Object.assign(new win.Event("pointerdown", { bubbles: true, cancelable: true }), { button: 1, pointerType: "mouse" });

async function mount(props) {
  win.document.body.innerHTML = "";
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(ConfirmDialog, props)));
  });
  await flush();
  return { container, root };
}

test("nennt Titel, Chatzahl und den Ordner und bestaetigt per Klick", async () => {
  const calls = [];
  const { root } = await mount({
    project: PROJECT,
    busy: false,
    onConfirm: () => calls.push("confirm"),
    onCancel: () => calls.push("cancel"),
  });

  const panel = dialog();
  assert.ok(panel, "der Dialog wurde nicht gerendert");
  assert.equal(panel.getAttribute("aria-modal"), "true");
  assert.equal(panel.getAttribute("aria-label"), de["projects.delete.title"]);
  assert.match(panel.textContent, new RegExp(de["projects.delete.title"]));
  // Die Zahl der Chats steht im Satz, nicht nur im Objekt.
  assert.match(panel.textContent, new RegExp(de["projects.delete.body"].replace("{n}", "3")));
  assert.match(panel.textContent, /\/home\/alice\/workspace\/demo/);

  const confirm = buttonWith(de["projects.delete.confirm"]);
  assert.ok(confirm, "der Bestaetigen-Knopf fehlt");
  await act(async () => { confirm.click(); });
  assert.deepEqual(calls, ["confirm"]);

  const cancel = buttonWith(de["common.cancel"]);
  assert.ok(cancel, "der Abbrechen-Knopf fehlt");
  await act(async () => { cancel.click(); });
  assert.deepEqual(calls, ["confirm", "cancel"]);
  await act(async () => { root.unmount(); });
});

test("ein Klick auf das Panel selbst bricht nicht ab, der Hintergrund schon", async () => {
  const calls = [];
  const { root } = await mount({
    project: PROJECT,
    busy: false,
    onConfirm: () => {},
    onCancel: () => calls.push("cancel"),
  });

  const panel = dialog();
  // Der Klick im Panel darf nicht bis zum Hintergrund durchschlagen — sonst
  // schloesse der Bestaetigen-Knopf den Dialog, dem er gehoert. Radix liest
  // dafuer `pointerdown`, nicht `click`.
  await act(async () => { panel.querySelector("h2").dispatchEvent(pointerDownOutside()); });
  assert.deepEqual(calls, []);
  await act(async () => { win.document.body.dispatchEvent(pointerDownOutside()); });
  assert.deepEqual(calls, ["cancel"]);
  await act(async () => { root.unmount(); });
});

test("Escape schliesst den Dialog", async () => {
  const calls = [];
  const { root } = await mount({
    project: PROJECT,
    busy: false,
    onConfirm: () => {},
    onCancel: () => calls.push("cancel"),
  });

  await act(async () => { win.document.dispatchEvent(escape()); });
  await flush();
  assert.deepEqual(calls, ["cancel"]);
  await act(async () => { root.unmount(); });
});

test("der Fokus steht im Dialog und nach dem Schliessen wieder auf dem Ausloeser", async () => {
  win.document.body.innerHTML = "";
  const trigger = win.document.createElement("button");
  trigger.id = "delete-demo";
  trigger.textContent = "delete";
  win.document.body.appendChild(trigger);
  trigger.focus();
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(ConfirmDialog, {
      project: PROJECT,
      busy: false,
      onConfirm: () => {},
      onCancel: () => {},
    })));
  });
  await flush();

  const panel = dialog();
  assert.ok(panel.contains(win.document.activeElement), `Fokus liegt ausserhalb des Dialogs: ${win.document.activeElement?.tagName}`);

  await act(async () => { root.unmount(); });
  await flush();
  assert.equal(win.document.activeElement, trigger, "der Fokus ist nicht zum Ausloeser zurueckgekehrt");
});

test("ein geschuetzter Ordner nennt den Grund und laesst sich nicht bestaetigen", async () => {
  const calls = [];
  const { root } = await mount({
    project: { ...PROJECT, isProtected: true },
    busy: false,
    onConfirm: () => calls.push("confirm"),
    onCancel: () => calls.push("cancel"),
  });

  const panel = dialog();
  assert.match(panel.textContent, new RegExp(de["projects.delete.protected"]));
  // Die Warnung ueber das Loeschen waere hier eine Luege: es wird nicht geloescht.
  assert.doesNotMatch(panel.textContent, /Dies kann nicht rückgängig gemacht werden/);

  const confirm = buttonWith(de["projects.delete.confirm"]);
  assert.equal(confirm.disabled, true);
  await act(async () => { confirm.click(); });
  assert.deepEqual(calls, []);
  await act(async () => { root.unmount(); });
});

test("waehrend der Anfrage ist jeder Weg blockiert", async () => {
  const calls = [];
  const { root } = await mount({
    project: PROJECT,
    busy: true,
    onConfirm: () => calls.push("confirm"),
    onCancel: () => calls.push("cancel"),
  });

  const working = buttonWith(de["projects.delete.working"]);
  assert.ok(working, "der laufende Zustand hat keinen eigenen Text");
  assert.equal(working.disabled, true);
  await act(async () => { working.click(); });
  const cancel = buttonWith(de["common.cancel"]);
  assert.equal(cancel.disabled, true);
  await act(async () => { cancel.click(); });

  // Der Hintergrund und Escape haben waehrend der Anfrage keinen Abbruch mehr.
  await act(async () => { win.document.body.dispatchEvent(pointerDownOutside()); });
  await act(async () => { win.document.dispatchEvent(escape()); });
  await flush();
  assert.deepEqual(calls, []);
  await act(async () => { root.unmount(); });
});
