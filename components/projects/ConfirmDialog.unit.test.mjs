import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";

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
  const { container, root } = await mount({
    project: PROJECT,
    busy: false,
    onConfirm: () => calls.push("confirm"),
    onCancel: () => calls.push("cancel"),
  });

  const panel = container.querySelector('[role="alertdialog"]');
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
  const { container, root } = await mount({
    project: PROJECT,
    busy: false,
    onConfirm: () => {},
    onCancel: () => calls.push("cancel"),
  });

  const panel = container.querySelector('[role="alertdialog"]');
  const backdrop = panel.parentElement;
  // Der Klick im Panel darf nicht bis zum Hintergrund durchschlagen — sonst
  // schloesse der Bestaetigen-Knopf den Dialog, dem er gehoert.
  await act(async () => { panel.querySelector("h2").click(); });
  assert.deepEqual(calls, []);
  await act(async () => { backdrop.click(); });
  assert.deepEqual(calls, ["cancel"]);
  await act(async () => { root.unmount(); });
});

test("ein geschuetzter Ordner nennt den Grund und laesst sich nicht bestaetigen", async () => {
  const calls = [];
  const { container, root } = await mount({
    project: { ...PROJECT, isProtected: true },
    busy: false,
    onConfirm: () => calls.push("confirm"),
    onCancel: () => calls.push("cancel"),
  });

  const panel = container.querySelector('[role="alertdialog"]');
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
  const { container, root } = await mount({
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

  // Der Hintergrund hat waehrend der Anfrage keinen Abbruch mehr.
  const panel = container.querySelector('[role="alertdialog"]');
  await act(async () => { panel.parentElement.click(); });
  assert.deepEqual(calls, []);
  await act(async () => { root.unmount(); });
});
