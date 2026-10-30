import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React from "react";
import { createJiti } from "jiti";

/**
 * Die Brotkrumen von `FileBrowserDialog` — und zwar im Klick.
 *
 * `pathCrumbs()` zerlegt den angezeigten Pfad lexikalisch in eine Krume je
 * Vorfahr, und 661fb69 hat nur den Aufwaerts-Knopf an die Allowlist des Servers
 * gehaengt: `parentPath` kam als Feld aus `GET /api/files/...?type=list`. Die
 * Krume rendern ihre Nicht-letzten Eintraege weiter als Button mit
 * `onClick={() => navigateTo(crumb.fullPath)}`. Fuer ein Konto mit Home
 * `<tmp>/alice` ist damit die erste Krume `<tmp>` ein Knopf, und der Klick
 * endet in `403 Access denied` — dieselbe Fehlerklasse, derselbe Endpunkt,
 * jeder Mandant.
 *
 * Der Test klickt, er prueft nicht nur Anwesenheit: eine Regression, die
 * `getFileDirectory` nur noch im `onClick` zurueckbringt, wuerde bei einer
 * reiner Anwesenheitspruefung gruen bleiben. Der zweite Teil deckt die
 * Nebenwirkung ab — `navigateTo` setzte `setCurrentPath(target)` vor dem Fetch,
 * ein abgelehnter Sprung zeigte danach den verbotenen Pfad als aktuellen an.
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

/** Die Home des Mandanten; alles darueber liegt in keiner Allowlist. */
const HOME = "/srv/tenants/alice";
const PROJECTS = "/srv/tenants/alice/projects";
const DEMO = "/srv/tenants/alice/projects/demo";

/** Der Verzeichnisbaum, den die Route in diesem Test "sieht". */
const TREE = {
  [HOME]: { entries: [{ name: "projects", isDir: true }], parentPath: null, ancestors: [] },
  [PROJECTS]: {
    entries: [{ name: "demo", isDir: true }],
    parentPath: HOME,
    ancestors: [HOME],
  },
  [DEMO]: {
    entries: [{ name: "app.ts", isDir: false }],
    parentPath: PROJECTS,
    ancestors: [PROJECTS, HOME],
  },
};

const requestedPaths = [];
globalThis.fetch = async (url) => {
  const href = String(url);
  // Wie `filePathFromSegments`: fuehrende Schraegstriche fallen auf einen
  // zusammen. Ohne das wird aus dem kodierten Wurzel-Segment `%2F` ein `//`,
  // und ein Test, der `/` erwartet, scheitert an seiner eigenen Attrappe.
  const path = decodeURIComponent(href.split("?")[0].replace(/^\/api\/files/, "")).replace(/^\/{2,}/, "/");
  requestedPaths.push(path);
  const listing = TREE[path];
  if (!listing) {
    // Genau die Antwort der Route fuer einen Pfad ausserhalb der Allowlist.
    return { ok: false, status: 403, json: async () => ({ error: "Access denied" }) };
  }
  return { ok: true, status: 200, json: async () => ({ path, ...listing }) };
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
  await settle();
  return container;
}

/** Zwei Runden: Mount -> Fetch -> setState -> Render. */
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
}

/** Ein echter Klick auf das Element, nicht nur eine Existenzpruefung. */
async function click(element) {
  await act(async () => { element.dispatchEvent(new win.Event("click", { bubbles: true })); });
  await settle();
}

/** Das Element, das den gerade angezeigten Ordner nennt. */
function shownPath(container) {
  const label = container.querySelector('[aria-label="Selected folder"]');
  return label ? label.getAttribute("title") : null;
}

/** Die Brotkrume in Reihenfolge, mit dem Text, den sie anzeigen. */
function crumbs(container) {
  return [...container.querySelectorAll("[title]")]
    .filter((node) => node.tagName === "BUTTON" || node.getAttribute("aria-disabled") === "true"
      || node.getAttribute("aria-label") === "Selected folder")
    .filter((node) => (node.getAttribute("title") ?? "").startsWith("/"))
    .map((node) => ({ node, path: node.getAttribute("title") }));
}

test.after(async () => {
  for (const root of mountedRoots.splice(0)) {
    await act(async () => { root.unmount(); });
  }
});

test("eine Krume ueber der Home ist sichtbar, aber kein Knopf", async () => {
  const container = await mountDialog(DEMO);

  // Sichtbar bleibt sie: sie zeigt, wo der Ordner haengt.
  const shown = crumbs(container).map((crumb) => crumb.path);
  assert.deepEqual(shown, ["/srv", "/srv/tenants", HOME, PROJECTS, DEMO]);

  const first = crumbs(container)[0];
  assert.notEqual(first.node.tagName, "BUTTON", "/srv ist ein Knopf — ein Klick endet in 403");
});

test("der Klick auf die erste Krume fragt den verbotenen Pfad nicht ab", async () => {
  const container = await mountDialog(DEMO);
  const before = requestedPaths.length;

  await click(crumbs(container)[0].node);

  // Kein Request auf /srv, kein Wechsel des angezeigten Ordners.
  assert.equal(requestedPaths.slice(before).some((path) => path === "/srv"), false,
    `es wurde ${JSON.stringify(requestedPaths.slice(before))} angefragt`);
  assert.equal(shownPath(container), DEMO);
});

test("ein Klick auf eine bestaetigte Krume navigiert dorthin", async () => {
  const container = await mountDialog(DEMO);

  const alice = crumbs(container).find((crumb) => crumb.path === HOME);
  assert.equal(alice.node.tagName, "BUTTON", `${HOME} ist bestaetigt und muss ein Knopf sein`);
  await click(alice.node);

  assert.equal(requestedPaths.includes(HOME), true);
  assert.equal(shownPath(container), HOME);
});

test("ein abgelehnter Sprung zeigt den verbotenen Pfad nicht als aktuellen an", async () => {
  const container = await mountDialog(DEMO);
  const panel = container.querySelector('[role="dialog"]');

  // Die Home-Taste springt auf "/" — fuer einen Mandanten immer verboten. Der
  // Weg darf scheitern, der Dialog darf danach aber nicht das Wurzelverzeichnis
  // als ausgewaehlten Ordner fuehren.
  // linkedom kennt keinen KeyboardEvent-Konstruktor; React liest `key` vom
  // nativen Event, ein zusaetzlich gesetztes Feld genuegt.
  const home = new win.Event("keydown", { bubbles: true, cancelable: true });
  home.key = "Home";
  await act(async () => { panel.dispatchEvent(home); });
  await settle();

  assert.equal(requestedPaths.includes("/"), true, "der Sprung wurde nicht einmal versucht");
  assert.equal(shownPath(container), DEMO);
});