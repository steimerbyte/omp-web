import assert from "node:assert/strict";
import test from "node:test";
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
 * Gemessen wird nicht der Zustand einer Hover-Variable, sondern was im DOM
 * steht, ohne dass ein Zeiger die Zeile je beruehrt: genau der Zustand, in
 * dem der Nutzer auf dem Telefon arbeitet.
 */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const win = dom.window;
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

test("a zip row carries a download link before any pointer touches it", async () => {
  const container = await mountExplorer();
  const text = container.textContent ?? "";

  assert.ok(
    text.includes("bitkom-itk-beschaffung-leitfaeden.zip"),
    `the zip row was never rendered.\nrendered: ${JSON.stringify(text.slice(0, 300))}`,
  );

  const links = [...container.querySelectorAll("a[download]")];
  const zipLink = links.find((a) => a.getAttribute("href")?.includes(".zip"));

  assert.ok(
    zipLink,
    `no download link in the zip row without hover; links found: ` +
    `${JSON.stringify(links.map((a) => a.getAttribute("href")))}\n` +
    `rendered: ${JSON.stringify(text.slice(0, 300))}`,
  );

  const href = zipLink.getAttribute("href");
  assert.equal(
    href,
    `/api/files/home/steimerbyte/workspace/bitkom-itk-beschaffung-leitfaeden.zip?type=download`,
    "the download link must address the file route with type=download",
  );
});

test("a text row keeps its download link behind hover", async () => {
  const container = await mountExplorer();
  const links = [...container.querySelectorAll("a[download]")];

  assert.equal(
    links.some((a) => a.getAttribute("href")?.includes("notes.md")),
    false,
    "a viewable file must not get a permanent button; the row is still openable by click",
  );
});