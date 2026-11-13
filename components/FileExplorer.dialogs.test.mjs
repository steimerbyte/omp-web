import assert from "node:assert/strict";
import test from "node:test";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";
import * as linkedom from "linkedom";
import React from "react";
import { createJiti } from "jiti";

/**
 * Die beiden Explorer-Dialoge am `Dialog`-Primitiv: Fokus im Dialog, Escape
 * schliesst, der Fokus geht an den Ausloeser zurueck — und die Verschachtelung
 * bleibt sortiert. Im Fenster liegen zwei Arten von Ebenen: der
 * Eigenschaften-Dialog (inzwischen selbst Radix) und der Zielordner-Dialog
 * (`FileBrowserDialog`, noch ein eigenes Overlay mit eigenem Escape-Listener).
 * Ein Tastendruck darf immer nur die oberste schliessen.
 *
 * `linkedom` hat keinen Fokus; `activeElement` und `focus()` werden deshalb
 * nachgebaut, wie in `DialogFocus.test.mjs` beschrieben.
 */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const win = dom.window;
restoreLinkedomPrototypesOnExit(win);

const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };
const computed = () => new Proxy({}, { get: (_target, prop) => (typeof prop === "string" && prop.startsWith("get") ? () => "" : "0px") });
win.getComputedStyle = computed;
win.matchMedia = () => ({
  matches: false, media: "", addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {}, onchange: null, dispatchEvent() { return false; },
});
globalThis.window = new Proxy(win, {
  get(target, prop) {
    if (prop === "navigator") return fakeNavigator;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
globalThis.document = win.document;
globalThis.navigator = fakeNavigator;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
globalThis.IntersectionObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
for (const [name, value] of Object.entries(linkedom)) {
  if (name === "parseHTML" || name === "default") continue;
  if (typeof value === "function" && /^[A-Z]/.test(name)) globalThis[name] = value;
}
for (const name of Object.keys(win)) {
  if (name === "window") continue;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor && !descriptor.writable) continue;
  globalThis[name] = win[name];
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// react-dnd (Arborist) legt beim Mounten ein leeres Ziehbild an.
globalThis.Image = class {
  constructor() { this.src = ""; this.width = 1; this.height = 1; }
  set src(value) { this._src = value; }
  get src() { return this._src ?? ""; }
};
win.Element.prototype.scrollIntoView = function scrollIntoView() {};
win.HTMLElement.prototype.getBoundingClientRect = function rect() {
  return { top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 };
};
Object.defineProperty(win.Element.prototype, "clientHeight", { get: () => 600, configurable: true });
Object.defineProperty(win.Element.prototype, "scrollHeight", { get: () => 600, configurable: true });
Object.defineProperty(win.Element.prototype, "scrollTop", { get: () => 0, set: () => {}, configurable: true });

// Fokus wie in Chromium: ein `div` ohne `tabindex` ist nicht fokussierbar, und
// ein ausgebautes Element gibt den Fokus an `body` zurueck.
let activeElement = win.document.body;
const setActive = (element) => { activeElement = element; };
const resolveActive = () => (activeElement && activeElement.isConnected === false ? win.document.body : activeElement);
Object.defineProperty(win.document, "activeElement", { get: resolveActive, configurable: true });
win.HTMLElement.prototype.focus = function focus() {
  const tag = this.tagName;
  const nativelyFocusable = tag === "BUTTON" || tag === "INPUT" || tag === "TEXTAREA" || tag === "A" || tag === "SELECT";
  if (!nativelyFocusable && !this.hasAttribute("tabindex")) return;
  setActive(this);
};

const CWD = "/work";
const ROOT_PAGE = {
  entries: [
    { name: "src", isDir: true, size: 0, modified: "" },
    { name: "notes.txt", isDir: false, size: 1536, modified: "" },
  ],
  path: "/work",
  parentPath: "/",
  ancestors: ["/"],
};
const SRC_PAGE = {
  entries: [{ name: "inner.txt", isDir: false, size: 10, modified: "" }],
  path: "/work/src",
  parentPath: "/work",
  ancestors: ["/", "/work"],
};
const ORIGINAL_FETCH = globalThis.fetch;
function installFetch() {
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/api/files/work/src?type=list")) return { ok: true, status: 200, json: async () => SRC_PAGE };
    if (href.includes("type=list")) return { ok: true, status: 200, json: async () => ROOT_PAGE };
    if (href.includes("/api/git/status")) {
      return { ok: true, status: 200, json: async () => ({ isGitRepository: false, repositoryRoot: "/work", files: [], additions: 0, deletions: 0 }) };
    }
    if (href.includes("/api/home")) return { ok: true, status: 200, json: async () => ({ home: "/home/user" }) };
    if (href.includes("type=meta")) return { ok: true, status: 200, json: async () => ({ size: 1536, mime: "text/plain", language: "text" }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { FileExplorer } = await jiti.import("./FileExplorer.tsx");
const ReactDOM = await import("react-dom/client");
const { act } = await import("react");

const mountedRoots = [];
test.after(async () => {
  for (const root of mountedRoots.splice(0)) {
    await act(async () => { root.unmount(); });
  }
  globalThis.fetch = ORIGINAL_FETCH;
});

function settle(ms = 60) {
  return act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

async function mount() {
  installFetch();
  win.document.body.innerHTML = "";
  activeElement = win.document.body;
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null,
      React.createElement(FileExplorer, { cwd: CWD, onOpenFile: () => {}, changesCollapsed: true })));
  });
  await settle(40);
  return container;
}

const dialogContents = () => [...win.document.querySelectorAll('[data-slot="dialog-content"]')];

function fire(target, type, props = {}) {
  const event = new win.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(event, key, { value, configurable: true });
  }
  target.dispatchEvent(event);
  return event;
}

/**
 * Waehlt Knoten im Baum der `scope`-Instanz, wie es ein Ctrl-Klick tut. Der
 * Arborist-Aufruf wird direkt aus den React-Props genommen: `node.focus()` aus
 * dem echten Klickpfad ist in linkedom nicht nachstellbar.
 */
function invokeTreeSelect(scope, ids) {
  let props = null;
  for (const element of scope.querySelectorAll("*")) {
    const key = Object.keys(element).find((name) => name.startsWith("__reactFiber"));
    let fiber = key ? element[key] : null;
    for (let depth = 0; fiber && depth < 80; depth += 1) {
      const candidate = fiber.memoizedProps;
      if (candidate && typeof candidate.onSelect === "function" && Array.isArray(candidate.data)) {
        props = candidate;
        break;
      }
      fiber = fiber.return;
    }
    if (props) break;
  }
  assert.ok(props, "die Arborist-Props mit onSelect fehlen");
  props.onSelect(ids.map((id) => ({ id, data: { name: id.split("/").pop(), isDir: id === "/work/src" } })));
}

async function openWindow(container) {
  const open = container.querySelector('[title="Open explorer in a large window"]');
  assert.ok(open, "der Knopf zum grossen Fenster fehlt");
  open.focus();
  await act(async () => { open.click(); });
  await settle();
  const popup = dialogContents().at(-1);
  assert.ok(popup, "das grosse Fenster wurde nicht geoeffnet");
  return { open, popup };
}

test("Eigenschaften: Fokus liegt im Dialog, Escape schliesst und gibt ihn an den Ausloeser zurueck", async () => {
  const container = await mount();
  await act(async () => { invokeTreeSelect(container, ["/work/notes.txt"]); });

  const properties = container.querySelector('[title="Properties"]');
  assert.ok(properties, "der Properties-Knopf fehlt nach der Auswahl");
  properties.focus();
  await act(async () => { properties.click(); });
  await settle();

  const dialog = win.document.querySelector('[data-slot="dialog-content"]');
  assert.ok(dialog, "der Eigenschaften-Dialog fehlt");
  assert.match(dialog.textContent, /notes\.txt/);
  const focused = resolveActive();
  assert.ok(dialog.contains(focused), "der Fokus steht nicht im Dialog");
  assert.equal(focused.tagName, "BUTTON", "der erste fokussierbare Punkt ist der Abbrechen-Knopf");

  await act(async () => { fire(focused, "keydown", { key: "Escape" }); });
  await settle();
  assert.equal(win.document.querySelector('[data-slot="dialog-content"]'), null, "Escape schliesst den Eigenschaften-Dialog");
  assert.equal(resolveActive(), properties, "der Fokus landet wieder auf dem Knopf, der den Dialog geoeffnet hat");
});

test("Grosses Fenster: Fokus liegt im Fenster, Escape schliesst und gibt ihn an den Ausloeser zurueck", async () => {
  const container = await mount();
  const { open, popup } = await openWindow(container);
  assert.ok(popup.querySelectorAll('[role="treeitem"]').length > 0, "das Fenster zeigt keinen Baum");
  assert.ok(popup.contains(resolveActive()), "der Fokus steht nicht im Fenster");

  await act(async () => { fire(resolveActive(), "keydown", { key: "Escape" }); });
  await settle();
  assert.equal(dialogContents().length, 0, "Escape schliesst das Fenster");
  assert.equal(resolveActive(), open, "der Fokus landet wieder auf dem Knopf, der das Fenster geoeffnet hat");
});

test("Verschachtelt: Escape schliesst im Fenster zuerst die Eigenschaften und dann erst das Fenster", async () => {
  const container = await mount();
  const { popup } = await openWindow(container);

  await act(async () => { invokeTreeSelect(popup, ["/work/notes.txt"]); });
  const popupProperties = popup.querySelector('[title="Properties"]');
  assert.ok(popupProperties, "die Auswahl im Fenster zeigt keine Werkzeuge");
  popupProperties.focus();
  await act(async () => { popupProperties.click(); });
  await settle();

  assert.equal(dialogContents().length, 2, "Fenster und Eigenschaften stehen zusammen offen");
  const properties = dialogContents().at(-1);
  assert.match(properties.textContent, /notes\.txt/);
  assert.ok(properties.contains(resolveActive()));

  await act(async () => { fire(resolveActive(), "keydown", { key: "Escape" }); });
  await settle();
  assert.equal(dialogContents().length, 1, "nur die oberste Ebene schliesst");
  assert.equal(resolveActive(), popupProperties, "der Fokus geht in das Fenster zurueck");
  assert.match(dialogContents()[0].textContent, /Explorer:/, "das Fenster bleibt offen");

  await act(async () => { fire(resolveActive(), "keydown", { key: "Escape" }); });
  await settle();
  assert.equal(dialogContents().length, 0, "der zweite Tastendruck schliesst das Fenster");
});

test("Verschachtelt mit dem Zielordner-Dialog: ein Escape schliesst nur ihn, nicht das Fenster", async () => {
  const container = await mount();
  const { popup } = await openWindow(container);

  await act(async () => { invokeTreeSelect(popup, ["/work/notes.txt"]); });
  const copyTo = [...popup.querySelectorAll("button")].find((node) => node.getAttribute("title") === "Copy to…");
  assert.ok(copyTo, "der Kopieren-Knopf fehlt");
  await act(async () => { copyTo.click(); });
  await settle();

  const picker = popup.querySelector('[role="dialog"]');
  assert.ok(picker, "der Zielordner-Dialog fehlt");
  assert.match(picker.textContent, /notes\.txt/);
  const focused = resolveActive();
  assert.equal(focused, picker, "der Zielordner-Dialog haelt den Fokus");
  assert.ok(focused.closest("[data-nested-overlay]"), "der Zielordner-Dialog ist als eigene Ebene markiert");

  await act(async () => { fire(focused, "keydown", { key: "Escape" }); });
  await settle();
  assert.equal(popup.querySelector('[role="dialog"]'), null, "der Zielordner-Dialog schliesst");
  assert.equal(dialogContents().length, 1, "das Fenster bleibt offen");
  assert.match(dialogContents()[0].textContent, /Explorer:/);
});
