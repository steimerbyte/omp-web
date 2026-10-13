import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import { createJiti } from "jiti";

/**
 * DER BEFUND: der Explorer-Tab eines Fensters ist nicht mehr der erste Tab.
 *
 * Der Test laeuft ueber den ganzen Weg, auf dem der Fehler passiert:
 * `FileExplorer` (Sidebar-Instanz) -> Knopf "Open explorer in a large window"
 * -> `FileExplorerWindow` -> echte `TabBar` -> Zeigerzug -> `onReorder` ->
 * Tab-Liste des Fensters. `TabBar.selection.test.mjs` haengt an der Leiste und
 * gibt ihr eine Attrappe; dort kann dieser Fehler gar nicht auftauchen, weil die
 * Liste des Fensters gar nicht beteiligt ist.
 *
 * Gemessen wird nicht die Meldung von `TabBar`, sondern die Reihenfolge, die
 * danach im DOM steht.
 */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const win = dom.window;
const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };

const computed = () => new Proxy({}, {
  get: (_target, prop) => (typeof prop === "string" && prop.startsWith("get") ? () => "" : "0px"),
});
win.getComputedStyle = computed;
win.matchMedia = () => ({ addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent() { return false; } });
win.scrollTo = () => {};

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
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
globalThis.IntersectionObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
for (const [name, value] of Object.entries(linkedom)) {
  if (name === "default") continue;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor && !descriptor.writable) continue;
  globalThis[name] = value;
}
for (const name of Object.keys(win)) {
  if (name === "window" || name === "navigator") continue;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor && !descriptor.writable) continue;
  globalThis[name] = win[name];
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
globalThis.matchMedia = win.matchMedia;

globalThis.Image = class {
  set src(_value) {}
  removeAttribute() {}
  addEventListener() {}
  removeEventListener() {}
};

if (!globalThis.customElements) {
  globalThis.customElements = { get: () => undefined, define: () => {} };
  win.customElements = globalThis.customElements;
}

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  clear: () => { storage.clear(); },
};
win.localStorage = globalThis.localStorage;

// Der Zug in der Leiste loescht eine Textmarkierung; linkedom kennt keine
// Selection-API.
const selection = { text: "", removeAllRanges() { this.text = ""; }, empty() { return this.text === ""; }, toString() { return this.text; } };
win.document.getSelection = () => selection;
win.getSelection = () => selection;
globalThis.document.getSelection = () => selection;

win.HTMLElement.prototype.scrollIntoView = function () {};

/**
 * linkedom fuehrt kein Layout aus. Die Tab-Kacheln werden 100px breit
 * vermessen — ohne diese Masse entscheidet `TabBar.handlePointerMove` nichts,
 * und der Test pruefte den Zustand statt des Fehlers.
 */
const tileRects = new WeakMap();
win.HTMLElement.prototype.getBoundingClientRect = function rect() {
  const tile = tileRects.get(this);
  if (tile) return tile;
  return { top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 };
};
Object.defineProperty(win.Element.prototype, "clientHeight", { get: () => 600, configurable: true });
Object.defineProperty(win.Element.prototype, "scrollHeight", { get: () => 600, configurable: true });
Object.defineProperty(win.Element.prototype, "scrollTop", { get: () => 0, set: () => {}, configurable: true });

const LIST_RESPONSE = {
  entries: [
    { name: "alpha.ts", isDir: false, size: 10, modified: "" },
    { name: "beta.ts", isDir: false, size: 10, modified: "" },
    { name: "src", isDir: true, size: 0, modified: "" },
  ],
  path: "/home/steimerbyte/workspace",
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
const React = (await import("react")).default;
const ReactDOM = await import("react-dom/client");
const { act } = await import("react");

const CWD = "/home/steimerbyte/workspace";
const POPUP_TITLE = "Open explorer in a large window";
const NEW_TAB_TITLE = "New tab";

const mountedRoots = [];

test.after(async () => {
  for (const root of mountedRoots.splice(0)) {
    await act(async () => { root.unmount(); });
  }
});

/** Die Kacheln der Leiste des Fensters, in DOM-Reihenfolge. */
function tabTiles() {
  return [...document.querySelectorAll("[data-tab-close]")].map((button) => button.parentElement);
}

function label(tile) {
  return tile.querySelector("span[title]")?.textContent ?? "";
}

function click(button) {
  const event = new win.Event("click", { bubbles: true, cancelable: true });
  button.dispatchEvent(event);
}

/** Ein Zeigerzug der Kachel nach ganz links, ueber die Leistenkante hinaus. */
async function dragToTheLeft(tile) {
  const pointer = (type, x) => {
    const event = new win.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { button: 0, pointerId: 1, clientX: x, clientY: 15 });
    return event;
  };
  await act(async () => { tile.dispatchEvent(pointer("pointerdown", 250)); });
  await act(async () => { tile.dispatchEvent(pointer("pointermove", -400)); });
  await act(async () => { tile.dispatchEvent(pointer("pointerup", -400)); });
  await act(async () => {});
}

test("Ein Drop ganz links laesst den Explorer-Tab an erster Stelle", async () => {
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

  // Das grosse Fenster oeffnen — der Ort des Fehlers.
  const popupButton = container.querySelector(`[title="${POPUP_TITLE}"]`);
  assert.ok(popupButton, "der Knopf fuer das grosse Fenster wurde nicht gefunden");
  await act(async () => { click(popupButton); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });

  const newTabButton = () => [...document.querySelectorAll(`[title="${NEW_TAB_TITLE}"]`)].pop();
  assert.ok(newTabButton(), "der Knopf fuer einen neuen Tab wurde nicht gefunden");
  await act(async () => { click(newTabButton()); });
  await act(async () => { click(newTabButton()); });

  let tiles = tabTiles();
  assert.equal(tiles.length, 3, `erwartet Explorer + 2 Tabs, gesehen: ${tiles.map(label).join(" | ")}`);

  // Der Zug muss auch wirklich stattfinden: die Kacheln werden nach ihrer
  // Position im DOM vermessen.
  tiles.forEach((tile, index) => {
    const left = index * 100;
    tileRects.set(tile, { top: 0, left, right: left + 100, bottom: 30, width: 100, height: 30, x: left, y: 0 });
  });

  const dragged = tiles[2];
  const untouched = tiles[1];
  await dragToTheLeft(dragged);

  tiles = tabTiles();
  assert.equal(tiles.length, 3, "nach dem Zug sind nicht mehr drei Tabs da");
  assert.equal(label(tiles[0]), "Explorer", "der Explorer-Tab steht nicht mehr an erster Stelle");
  assert.equal(tiles[1], dragged, "der gezogene Tab steht nicht direkt hinter dem Explorer");
  assert.equal(tiles[2], untouched, "der unberuehrte Tab steht nicht mehr ganz rechts");
});