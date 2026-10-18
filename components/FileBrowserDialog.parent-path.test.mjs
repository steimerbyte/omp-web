import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React from "react";
import { createJiti } from "jiti";

/**
 * `FileBrowserDialog` und der Aufwaerts-Knopf.
 *
 * Der Knopf wurde allein daraus eingeblendet, dass `getFileDirectory()` den
 * angezeigten Pfad verlassen hat — eine lexikalische Rechnung ohne jede
 * Allowlist. Fuer ein Konto mit Home `<home-root>/alice` ist der Elternpfad von
 * `<home-root>/alice` aber `<home-root>`, das kein Mandant betreten darf: der
 * erste Klick endete in `403 Access denied`. Die Route `/api/files?type=list`
 * liefert jetzt `parentPath`, dort gegen die Allowlist geprueft, und die
 * Komponente folgt ihr.
 *
 * Geprueft wird beides: ohne `parentPath` in der Antwort gibt es keinen Knopf,
 * und mit einem `parentPath` gibt es ihn. Der zweite Fall ist die Gegenprobe
 * gegen das Ueberdrehen in die andere Richtung — ein Knopf, der nie erscheint,
 * waere genauso kaputt wie einer, der in den 403 fuehrt.
 */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const win = dom.window;
const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };

win.getComputedStyle = () => new Proxy({}, {
  get: (_target, prop) => (typeof prop === "string" && prop.startsWith("get") ? () => "" : "0px"),
});
win.matchMedia = () => ({
  matches: false,
  media: "",
  addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {},
  onchange: null,
  dispatchEvent() { return false; },
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

/** Die Home eines Mandanten unter `<home-root>`; der Elternpfad ist `<home-root>`. */
const HOME = "/srv/tenants/alice";
/** Eine Stufe tiefer: der Elternpfad liegt noch in der Home des Kontos. */
const DEEP = "/srv/tenants/alice/projects/demo";
const PARENT = "/srv/tenants/alice/projects";

/** Was die Route fuer den angezeigten Ordner antwortet. */
let listResponse = { entries: [{ name: "demo", isDir: true }], path: HOME, parentPath: null };
const requestedUrls = [];
globalThis.fetch = async (url) => {
  requestedUrls.push(String(url));
  return { ok: true, status: 200, json: async () => listResponse };
};

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { FileBrowserDialog } = await jiti.import("./FileBrowserDialog.tsx");

const ReactDOM = await import("react-dom/client");
const { act } = await import("react");

const mountedRoots = [];

async function mountDialog(initialPath) {
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
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  return container;
}

/** Der Aufwaerts-Knopf ist der einzige mit dieser Beschriftung. */
function upButton(container) {
  return container.querySelector('button[aria-label="Up one level"]');
}

test.after(async () => {
  for (const root of mountedRoots.splice(0)) {
    await act(async () => { root.unmount(); });
  }
});

test("ohne betretbaren Elternpfad gibt es keinen Aufwaerts-Knopf", async () => {
  listResponse = { entries: [{ name: "demo", isDir: true }], path: HOME, parentPath: null };

  const container = await mountDialog(HOME);

  // Der Ordner selbst ist sichtbar — der Dialog funktioniert, nur der Weg nach
  // oben fehlt, weil die Route ihn verweigert hat.
  assert.ok((container.textContent ?? "").includes("demo"));
  assert.equal(upButton(container), null);
});

test("mit betretbarem Elternpfad erscheint der Knopf", async () => {
  listResponse = { entries: [{ name: "app.ts", isDir: false }], path: DEEP, parentPath: PARENT };

  const container = await mountDialog(DEEP);

  const button = upButton(container);
  assert.ok(button, `kein Aufwaerts-Knopf, obwohl die Route ${PARENT} nennt`);
});