import assert from "node:assert/strict";
import test from "node:test";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";
import * as linkedom from "linkedom";
import React from "react";
import { createJiti } from "jiti";

/**
 * DER BEFUND: eine ZIP-Zeile im Explorer hatte keinen Download-Knopf.
 *
 * Der Knopf existierte, hing aber an `hovered`. Auf einem Telefon gibt es
 * kein Darueberfahren — die Zeile wird getippt —, also blieb der Knopf
 * unsichtbar und die Datei kam nie an. Es gibt ausserdem keinen Viewer, in
 * den ein Klick auf die Zeile laufen koennte: `handleRowClick` ruft
 * `onOpenFile`, und fuer ein Archiv hat `FileViewer` nichts.
 *
 * Seit die Werkzeuge in einem Drei-Punkte-Menue stehen, gilt derselbe Satz
 * fuer das Menue: der Knopf ist ohne Hover da (er traegt die 44-px-Regel aus
 * globals.css), und der Download-Eintrag darin ist derselbe Anker mit
 * derselben Route. Gemessen wird wieder nur, was im DOM steht, ohne dass ein
 * Zeiger die Zeile je beruehrt.
 */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const win = dom.window;
// linkedom teilt die Prototypen prozessweit; nach dieser Datei zurueckgeben.
restoreLinkedomPrototypesOnExit(win);
const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };

const computed = () => new Proxy({}, {
  get: (_target, prop) => (typeof prop === "string" && prop.startsWith("get") ? () => "" : "0px"),
});
win.getComputedStyle = computed;
win.matchMedia = () => ({
  matches: false,
  media: "",
  addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {},
  onchange: null, dispatchEvent() { return false; },
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
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
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
globalThis.matchMedia = win.matchMedia;

globalThis.Image = class {
  constructor() { this.src = ""; this.width = 1; this.height = 1; }
  set src(value) { this._src = value; }
  get src() { return this._src ?? ""; }
};

if (!globalThis.customElements) {
  globalThis.customElements = {
    registry: new Map(),
    get: (name) => globalThis.customElements.registry.get(name),
    define: (name, ctor) => { globalThis.customElements.registry.set(name, ctor); },
    whenDefined: () => Promise.resolve(),
    upgrade: () => {},
  };
}

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  clear: () => { storage.clear(); },
};
win.localStorage = globalThis.localStorage;

// Ohne diese Masse virtualisiert `react-window` auf null Zeilen, und der Test
// wuerde den Produktfehler mit einem Harness-Fehler verwechseln.
win.HTMLElement.prototype.getBoundingClientRect = function rect() {
  return { top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 };
};
Object.defineProperty(win.Element.prototype, "clientHeight", { get: () => 600, configurable: true });
Object.defineProperty(win.Element.prototype, "scrollHeight", { get: () => 600, configurable: true });
Object.defineProperty(win.Element.prototype, "scrollTop", { get: () => 0, set: () => {}, configurable: true });
// Das grosse Fenster rendert eine echte `TabBar`; deren Effekt scrollt den
// aktiven Tab sichtbar, und `linkedom` kennt `scrollIntoView` nicht.
win.HTMLElement.prototype.scrollIntoView = function () {};

const CWD = "/home/steimerbyte/workspace";

/** Drei Zeilen: ZIP, Text, Ordner. Ein Text und ein Ordner als Gegenprobe. */
const LIST_RESPONSE = {
  entries: [
    { name: "bitkom-itk-beschaffung-leitfaeden.zip", isDir: false, size: 58_000_000, modified: "" },
    { name: "notes.md", isDir: false, size: 120, modified: "" },
    { name: "pages", isDir: true, size: 0, modified: "" },
  ],
  path: CWD,
};

globalThis.fetch = async (url) => {
  const href = String(url);
  if (href.includes("type=list")) {
    return { ok: true, status: 200, json: async () => LIST_RESPONSE };
  }
  if (href.includes("/api/git/status")) {
    return { ok: true, status: 200, json: async () => ({ isGitRepository: false, files: [] }) };
  }
  if (href.includes("/api/home")) {
    return { ok: true, status: 200, json: async () => ({ home: "/home/steimerbyte" }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { FileExplorer } = await jiti.import("./FileExplorer.tsx");

const ReactDOM = await import("react-dom/client");
const { act } = await import("react");

const mountedRoots = [];

async function mountExplorer() {
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      React.createElement(I18nProvider, null,
        React.createElement(FileExplorer, { cwd: CWD, onOpenFile: () => {}, changesCollapsed: true })),
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  return container;
}

test.after(async () => {
  for (const root of mountedRoots.splice(0)) {
    await act(async () => { root.unmount(); });
  }
});

/** Ein Druck auf den Menueknopf: Radix oeffnet auf `pointerdown`, nicht auf `click`. */
async function openRowMenu(row, { keyboard = false } = {}) {
  const trigger = row.querySelector('[title="File actions"]');
  assert.ok(trigger, `the row has no menu button; rendered: ${JSON.stringify((row.textContent ?? "").slice(0, 200))}`);
  if (keyboard) {
    // Im grossen Fenster liegt ein DismissableLayer der Dialogebene ueber der
    // Seite; der Tastenweg oeffnet dasselbe Menue ohne einen zweiten
    // pointerdown-Zweig im Test.
    await act(async () => {
      trigger.dispatchEvent(Object.assign(new win.Event("keydown", { bubbles: true, cancelable: true }), { key: "Enter" }));
    });
  } else {
    const down = new win.Event("pointerdown", { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries({ button: 0, ctrlKey: false, pointerType: "mouse" })) {
      Object.defineProperty(down, key, { value, configurable: true });
    }
    await act(async () => { trigger.dispatchEvent(down); });
  }
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  // Das Menue haengt als Portal am `body`, nicht im Container.
  const items = [...win.document.querySelectorAll('[role="menu"] [role="menuitem"]')];
  return { trigger, items };
}

const rowByName = (name) => [...win.document.querySelectorAll('[role="treeitem"]')]
  .find((node) => (node.textContent ?? "").includes(name));

async function closeMenu() {
  await act(async () => {
    win.document.dispatchEvent(Object.assign(new win.Event("keydown", { bubbles: true }), { key: "Escape" }));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

test("a zip row carries its download entry before any pointer touches it", async () => {
  await mountExplorer();
  const row = rowByName("bitkom-itk-beschaffung-leitfaeden.zip");
  assert.ok(row, "the zip row was never rendered");

  const { items } = await openRowMenu(row);
  // `DropdownMenuItem asChild` macht den Anker selbst zum Eintrag, nicht zu
  // seinem Kind.
  const zipLink = items.find((item) => item.getAttribute("href")?.includes(".zip"));

  assert.ok(
    zipLink,
    `no download entry in the zip row's menu; entries found: ` +
    `${JSON.stringify(items.map((item) => item.textContent))}`,
  );
  assert.equal(
    zipLink.getAttribute("href"),
    `/api/files/home/steimerbyte/workspace/bitkom-itk-beschaffung-leitfaeden.zip?type=download`,
    "the download entry must address the file route with type=download",
  );
  await closeMenu();
});

test("a viewable text row carries its download entry without hover too", async () => {
  await mountExplorer();
  const row = rowByName("notes.md");
  assert.ok(row, "the text row was never rendered");

  const { items } = await openRowMenu(row);
  const textLink = items.find((item) => item.getAttribute("href")?.includes("notes.md"));

  assert.ok(
    textLink,
    `the text row has no download entry without hover; entries: ` +
    `${JSON.stringify(items.map((item) => item.textContent))}`,
  );
  await closeMenu();
});

test("every row carries a menu button without hover, and the download lives inside", async () => {
  await mountExplorer();
  const rows = [...win.document.querySelectorAll('[role="treeitem"]')];
  assert.ok(rows.length > 0, "no rows rendered at all");

  for (const row of rows) {
    const trigger = row.querySelector('[title="File actions"]');
    assert.ok(trigger, `a row has no menu button; rendered: ${JSON.stringify((row.textContent ?? "").slice(0, 120))}`);
    // Der Knopf ist ohne Hover im DOM und wird nicht per Opazitaet versteckt.
    const style = trigger.getAttribute("style") ?? "";
    assert.equal(/opacity:\s*0/.test(style), false, `the menu button is invisible without hover: ${style}`);
    assert.equal(/display:\s*none/.test(style), false, `the menu button is hidden: ${style}`);
    assert.equal(
      row.querySelectorAll("a[download]").length,
      0,
      "a download anchor outside the menu is unreachable on a phone again",
    );
  }
});

test("a folder row's menu has no download entry", async () => {
  await mountExplorer();
  const row = rowByName("pages");
  assert.ok(row, "the folder row was never rendered");

  const { items } = await openRowMenu(row);
  assert.equal(
    items.some((item) => item.hasAttribute("download")),
    false,
    `a directory is not downloadable; entries: ${JSON.stringify(items.map((item) => item.textContent))}`,
  );
  await closeMenu();
});

test("the popup explorer window offers the same menu, above its own panel", async () => {
  const container = await mountExplorer();

  const openButton = [...container.querySelectorAll("button")]
    .find((b) => (b.getAttribute("aria-label") ?? "").includes("large window"));
  assert.ok(
    openButton,
    `the popup opener is missing; buttons: ${JSON.stringify(
      [...container.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")),
    )}`,
  );

  await act(async () => { openButton.dispatchEvent(new win.Event("click", { bubbles: true })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });

  const dialog = win.document.querySelector('[role="dialog"]');
  assert.ok(dialog, "the explorer window did not open");

  const row = [...dialog.querySelectorAll('[role="treeitem"]')]
    .find((node) => (node.textContent ?? "").includes("notes.md"));
  assert.ok(row, "the popup window has no text row");

  const { items } = await openRowMenu(row, { keyboard: true });
  const link = items.find((item) => item.hasAttribute("download"));
  assert.ok(link, `the popup window's menu has no download entry: ${JSON.stringify(items.map((item) => item.textContent))}`);

  // Das Fenster liegt auf Ebene 1300; ein Menue auf Ebene 50 waere unsichtbar.
  const menu = win.document.querySelector('[role="menu"]');
  assert.equal(menu?.style.zIndex, "1310", "the row menu must sit above the explorer window panel");
  await closeMenu();

  await act(async () => {
    const close = [...dialog.querySelectorAll("button")]
      .find((b) => (b.getAttribute("aria-label") ?? "").toLowerCase().includes("close"));
    if (close) close.dispatchEvent(new win.Event("click", { bubbles: true }));
  });
});


test("das Zeilenmenue der Seitenleiste liegt ueber dem Schubfach", async () => {
  await mountExplorer();
  const row = rowByName("notes.md");
  assert.ok(row, "die Textzeile fehlt");
  await openRowMenu(row);

  // Dasselbe Menue in der Seitenleiste: dort liegt auf dem Telefon das
  // Schubfach (200) und das Datei-Panel (250) ueber der Seite. Auf der
  // Standardebene 50 war es darunter und damit unsichtbar.
  const menu = win.document.querySelector('[role="menu"]');
  assert.ok(menu, "das Menue ist nicht offen");
  assert.ok(
    Number(menu.style.zIndex) > 250,
    `das Menue liegt auf Ebene ${menu.style.zIndex || "auto"} und damit unter dem Schubfach (200) und dem Datei-Panel (250)`,
  );
  await closeMenu();
});
