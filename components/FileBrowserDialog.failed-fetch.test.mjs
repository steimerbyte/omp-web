import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React from "react";
import { createJiti } from "jiti";

/**
 * `FileBrowserDialog` und eine fehlgeschlagene Anfrage.
 *
 * Der Befund: im `catch` von `navigateTo` standen `setEntries([])`,
 * `setParentPath(null)` und `setAncestors([])`. `currentPath` blieb korrekt —
 * aber der Dialog zeigte danach einen LEEREN Ordner fuer genau diesen Pfad,
 * als waere er leer. Der Nutzer sah „keine Dateien" statt der Liste, die
 * einen Takt zuvor noch da war, und der Aufwaerts-Knopf verschwand mit
 * `canGoUp` (das an `parentPath !== null` hing).
 *
 * Ein Ladeindikator existiert (`fileBrowser.loading`, `styles.state`), er
 * ersetzt die leere Liste aber nicht: er steht nur solange `loading` gilt, und
 * `loading` ist im `catch` schon per `finally` auf `false` gesetzt. Die leere
 * Liste im Fehlerfall behauptet also etwas Falsches ueber den Ordner.
 */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const win = dom.window;
const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };

win.getComputedStyle = () => new Proxy({}, {
  get: (_target, prop) => (typeof prop === "string" && prop.startsWith("get") ? () => "" : "0px"),
});
win.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {} });

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
globalThis.cancelAnimationFrame = (id) => clearTimeout(() => clearTimeout(id), 0);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
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
win.HTMLElement.prototype.getBoundingClientRect = function rect() {
  return { top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 };
};

const HOME = "/srv/tenants/alice";
const DEEP = "/srv/tenants/alice/projects/demo";
const PARENT = "/srv/tenants/alice/projects";

/** Der Ordner, dessen Liste nach dem Fehler noch dasteht. */
const ENTRIES = [{ name: "app.ts", isDir: false }, { name: "index.ts", isDir: false }];

/**
 * Antwortet fuer jeden Pfad, bis `failNext` gesetzt wird. Der Fehler kommt
 * danach fuer JEDEN Pfad — so auch fuer den Klick auf "eine Ebene hoeher",
 * den die leere Liste im `catch` sonst unsichtbar gemacht haette.
 *
 * `mountDialog` setzt die Schalter zurueck: `test.after` laeuft erst nach
 * allen Tests der Datei, ein nicht zurueckgesetztes `failNext` wuerde dem
 * naechsten Test den Mount verderben.
 */
let failNext = false;
const requestedPaths = [];
globalThis.fetch = async (url) => {
  const href = String(url);
  const path = decodeURIComponent(href.split("?")[0].replace(/^\/api\/files/, ""));
  requestedPaths.push(path);
  if (failNext) {
    return { ok: false, status: 500, json: async () => ({ error: "Backend unreachable" }) };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      path,
      entries: path === DEEP ? ENTRIES : [{ name: "demo", isDir: true }],
      parentPath: path === DEEP ? PARENT : HOME,
      ancestors: path === DEEP ? [PARENT, HOME] : [HOME],
    }),
  };
};

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { FileBrowserDialog } = await jiti.import("./FileBrowserDialog.tsx");

const ReactDOM = await import("react-dom/client");
const { act } = await import("react");

const mountedRoots = [];

async function mountDialog(initialPath) {
  failNext = false;
  requestedPaths.length = 0;
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      React.createElement(I18nProvider, null,
        React.createElement(FileBrowserDialog, {
          open: true,
          title: "Copy to…",
          initialPath,
          confirmLabel: "Copy here",
          onCancel: () => {},
          onConfirm: () => {},
        }),
      ),
    );
  });
  await settle();
  return container;
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
}

async function click(element) {
  await act(async () => { element.dispatchEvent(new win.Event("click", { bubbles: true })); });
  await settle();
}

/** Der Aufwaerts-Knopf ist der einzige mit dieser Beschriftung. */
function upButton(container) {
  return container.querySelector('button[aria-label="Up one level"]');
}

/** Die Dateinamen, die der Dialog gerade anzeigt. */
function shownEntries(container) {
  const text = container.textContent ?? "";
  return ENTRIES.filter((entry) => text.includes(entry.name)).map((entry) => entry.name);
}

test.after(async () => {
  for (const root of mountedRoots.splice(0)) {
    await act(async () => { root.unmount(); });
  }
  failNext = false;
});

test("eine fehlgeschlagene Anfrage leert den Ordner nicht", async () => {
  const container = await mountDialog(DEEP);
  assert.deepEqual(shownEntries(container), ["app.ts", "index.ts"], "Ausgangslage stimmt nicht");

  failNext = true;
  // Der Aufwaerts-Knopf loest die zweite Anfrage aus.
  const up = upButton(container);
  assert.ok(up, "kein Aufwaerts-Knopf auf der ersten Stufe");
  await click(up);

  const text = container.textContent ?? "";
  assert.ok(text.includes("Backend unreachable"),
    "die Fehlermeldung wird nicht angezeigt");
  assert.deepEqual(shownEntries(container), ["app.ts", "index.ts"],
    "die Liste des unveraenderten Ordners wurde geleert");
});

test("die Fehlermeldung sagt, dass der Ordner nicht leer ist", async () => {
  const container = await mountDialog(DEEP);
  failNext = true;
  await click(upButton(container));

  const text = container.textContent ?? "";
  // "This folder has no subfolders" waere eine falsche Aussage: er ist nicht
  // leer, die Anfrage ist schiefgegangen.
  assert.equal(/no subfolders|empty folder|no files/i.test(text), false,
    `der Dialog behauptet einen leeren Ordner: ${JSON.stringify(text.slice(0, 300))}`);
  assert.ok(text.includes("Backend unreachable"), "die Fehlermeldung fehlt");
});

test("nach dem Fehler bleibt der Aufwaerts-Knopf da", async () => {
  const container = await mountDialog(DEEP);
  failNext = true;
  await click(upButton(container));

  // `canGoUp` haengt an `parentPath`. Ein `setParentPath(null)` im `catch`
  // nahm dem Nutzer damit auch den Weg zurueck, den er gerade gegangen war.
  assert.ok(upButton(container),
    "der Aufwaerts-Knopf verschwand nach dem Fehler, obwohl der Ordner unveraendert blieb");
});