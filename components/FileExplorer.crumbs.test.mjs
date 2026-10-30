import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React from "react";
import { createJiti } from "jiti";

/**
 * Die Brotkrumen und der Aufwaerts-Knopf von `FileExplorer` — und zwar im Klick.
 *
 * Der Befund: beide rechneten den Zielpfad rein lexikalisch (`getFileDirectory`,
 * `currentPath.split("/")`), ohne die Allowlist des Kontos zu fragen. Fuer einen
 * Mandanten endete jeder Klick auf eine Krume oberhalb seiner Home in
 * `403 Access denied` — und weil `handleNavigate` `currentPath` VOR dem Fetch
 * setzte, stand der verbotene Pfad danach als aktueller Ordner da, mit eigener
 * Krume-Leiste.
 *
 * Dieselbe Route wie im Dialog (`GET /api/files/<pfad>?type=list`) liefert mit
 * `ancestors` und `parentPath` die Kette der betretbaren Vorfahren. Der Test
 * antwortet mit genau diesen Feldern.
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

/** Die Home des Mandanten; alles darueber liegt in keiner Allowlist. */
const TENANTS = "/srv/tenants";
const HOME = "/srv/tenants/alice";
const PROJECTS = "/srv/tenants/alice/projects";
const DEMO = "/srv/tenants/alice/projects/demo";

/**
 * Der Verzeichnisbaum, den die Route in diesem Test "sieht". `parentPath` und
 * `ancestors` sind genau die Felder, die `route.ts` zurueckgibt.
 */
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
  if (href.includes("/api/git/status")) {
    return { ok: true, status: 200, json: async () => ({ isGitRepository: false, files: [] }) };
  }
  if (href.includes("/api/home")) {
    return { ok: true, status: 200, json: async () => ({ home: HOME }) };
  }
  if (!href.includes("/type=list") && !href.includes("?type=list")) {
    return { ok: true, status: 200, json: async () => ({}) };
  }
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
const { FileExplorer } = await jiti.import("./FileExplorer.tsx");

const ReactDOM = await import("react-dom/client");
const { act } = await import("react");

const mountedRoots = [];

/**
 * Der Projektwurzel-`cwd` ist bewusst nicht die Home des Kontos — und nicht der
 * gezeigte Ordner, damit der Aufwaerts-Knopf ueberhaupt einen Weg anbietet.
 * (`canGoUp` gilt am Projektwurzel-`cwd` weiterhin als Grenze; das ist die
 * bestehende Bedeutung dieses Guards und keine Erfindung dieses Tests.)
 */
async function mountExplorer(currentPath) {
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      React.createElement(I18nProvider, null,
        React.createElement(FileExplorer, {
          cwd: PROJECTS,
          onOpenFile: () => {},
          changesCollapsed: true,
          initialViewState: {
            currentPath,
            expandedPaths: new Set(),
            history: { paths: [currentPath], index: 0 },
          },
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

/**
 * Die Brotkrume in Reihenfolge, mit dem Text, den sie anzeigen. Ein Knoten
 * ohne `BUTTON` ist Kontext, kein Ziel.
 *
 * Gelesen wird nur die Krumenleiste, nicht der ganze Explorer: eine Dateizeile
 * im Baum traegt auch einen `title` mit ihrem vollen Pfad und saehe hier wie
 * eine letzte Krume aus.
 */
function crumbs(container) {
  const bar = [...container.querySelectorAll("span")].find((node) => {
    const overflow = node.style?.overflowX ?? "";
    return overflow === "auto" && node.style?.whiteSpace === "nowrap";
  });
  assert.notEqual(bar, undefined, "die Krumenleiste wurde nicht gefunden");
  return [...bar.querySelectorAll("[title]")]
    .filter((node) => node.getAttribute("title")?.startsWith("/"))
    .map((node) => ({ node, path: node.getAttribute("title"), isButton: node.tagName === "BUTTON" }));
}

/** Der Pfad, den die Krume als aktuellen Ordner ausweist. */
function shownPath(container) {
  const crumbsInOrder = crumbs(container);
  const last = crumbsInOrder[crumbsInOrder.length - 1];
  return last ? last.path : null;
}

/**
 * Der Aufwaerts-Knopf anhand seiner Beschriftung. „Upload files…" enthaelt
 * ebenfalls „up" — deshalb wird die volle deutsche Beschriftung verlangt und
 * nicht nur ein Teilstring.
 */
function upButton(container) {
  const buttons = [...container.querySelectorAll("button[aria-label]")];
  const found = buttons.find((button) => {
    const label = (button.getAttribute("aria-label") ?? "").toLowerCase();
    return label === "up one directory" || label.includes("eine ebene hoeher")
      || label.includes("eine ebene höher");
  });
  assert.notEqual(found, undefined,
    `der Aufwaerts-Knopf wurde nicht gefunden, Labels: ${JSON.stringify(buttons.map((b) => b.getAttribute("aria-label")))}`);
  return found;
}

test.after(async () => {
  for (const root of mountedRoots.splice(0)) {
    await act(async () => { root.unmount(); });
  }
});

test("eine Krume ueber der Home ist sichtbar, aber kein Knopf", async () => {
  const container = await mountExplorer(DEMO);

  const shown = crumbs(container);
  assert.deepEqual(shown.map((crumb) => crumb.path),
    ["/srv", TENANTS, HOME, PROJECTS, DEMO],
    "die Krumen zeigen weiterhin den ganzen Weg nach oben");

  // Sichtbar, aber kein Ziel: alles oberhalb der bestaetigten Vorfahren. Die
  // letzte Krume ist der aktuelle Ordner und damit nie ein Knopf.
  const overHome = shown.filter((crumb) => !crumb.isButton);
  assert.deepEqual(overHome.map((crumb) => crumb.path), ["/srv", TENANTS, DEMO]);
  assert.equal(overHome[0].path, "/srv", "/srv ist ein Knopf — ein Klick endet in 403");
  assert.equal(shown.find((crumb) => crumb.path === HOME).isButton, true,
    `${HOME} ist bestaetigt und muss ein Knopf sein`);
});

test("der Klick auf die erste Krume fragt den verbotenen Pfad nicht ab", async () => {
  const container = await mountExplorer(DEMO);
  const before = requestedPaths.length;

  // Die Krume ist kein Knopf. Sie zu "klicken" geht nur, wenn sie einer waere —
  // der Test darf also nicht an einem cast scheitern, sondern muss beweisen,
  // dass gar kein Ziel existiert.
  const first = crumbs(container)[0];
  assert.equal(first.isButton, false, "/srv ist klickbar, obwohl es nicht betretbar ist");

  assert.equal(requestedPaths.length, before, "eine unbestaetigte Krume loest eine Anfrage aus");
  assert.equal(shownPath(container), DEMO);
});

test("eine bestaetigte Krume navigiert dorthin", async () => {
  const container = await mountExplorer(DEMO);

  const home = crumbs(container).find((crumb) => crumb.path === HOME);
  assert.equal(home.isButton, true, `${HOME} ist bestaetigt und muss ein Knopf sein`);
  await click(home.node);

  assert.equal(requestedPaths.includes(HOME), true);
  assert.equal(shownPath(container), HOME);
});

test("der Aufwaerts-Knopf geht in einen bestaetigten Vorfahren", async () => {
  const container = await mountExplorer(DEMO);
  const up = upButton(container);
  assert.equal(up.hasAttribute("disabled"), false, "der Aufwaerts-Knopf ist deaktiviert, obwohl ein Vorfahre bestaetigt ist");

  await click(up);

  assert.equal(requestedPaths.includes(PROJECTS), true, `angefragt wurde ${JSON.stringify(requestedPaths.slice(-3))}`);
  assert.equal(shownPath(container), PROJECTS);
});

test("ueber der Home gibt es keinen Aufwaerts-Knopf", async () => {
  // An der Home ist der lexikalische Elternpfad `/srv/tenants` — fuer den
  // Mandanten nicht betretbar. Der Server liefert `parentPath: null`, also darf
  // der Knopf gar nicht erst angeboten werden.
  const container = await mountExplorer(HOME);
  const up = upButton(container);
  assert.equal(up.hasAttribute("disabled"), true,
    "der Aufwaerts-Knopf ist aktiv, obwohl der Server keinen Elternpfad bestaetigt hat");

  // Selbst wenn er aktiv waere: der Weg darf nicht am verbotenen Elternpfad
  // enden, und der verbotene Pfad darf nicht zum angezeigten Ordner werden.
  if (!up.hasAttribute("disabled")) await click(up);
  assert.equal(shownPath(container), HOME);
});

test("ein abgelehnter Sprung zeigt den verbotenen Pfad nicht als aktuellen an", async () => {
  // Der Up-Knopf an der Home zeigt hier keinen Weg. Also ueber die
  // Historie/Pfadleiste: die Kralle `/srv` gibt es nicht als Knopf. Der
  // entscheidende Nachweis ist deshalb der direkteste Weg, den ein Klick
  // nehmen koennte — ein Klick auf das Element, falls es doch ein Knopf ist.
  const container = await mountExplorer(DEMO);
  const first = crumbs(container)[0];
  const before = requestedPaths.length;

  if (first.isButton) {
    await click(first.node);
    assert.equal(requestedPaths.slice(before).some((path) => path === "/srv"), false,
      "der verbotene Pfad wurde angefragt");
  }
  assert.equal(shownPath(container), DEMO, "der verbotene Pfad steht als aktueller Ordner in der Leiste");
});