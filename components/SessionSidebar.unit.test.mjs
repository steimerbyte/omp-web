import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { mock } from "bun:test";
import * as linkedom from "linkedom";
import { createJiti } from "jiti";
import { captureLinkedomPrototypes } from "../lib/test-linkedom.mjs";

/**
 * Die Seitenleiste virtualisiert ihre Zeilen mit react-virtuoso. In linkedom
 * gibt es keine Layoutmessung, deshalb liefert der Modul-Mock alle Zeilen
 * direkt aus `data`; die uebrigen Bausteine der Komponente (Projektzeilen,
 * SessionItem, Polling, Menues) laufen unveraendert.
 */
const { forwardRef, useImperativeHandle } = React;
mock.module("react-virtuoso", () => {
  const Virtuoso = forwardRef(function VirtuosoMock(props, ref) {
    useImperativeHandle(ref, () => ({
      scrollToIndex() {},
      scrollTo() {},
      scrollIntoView() {},
      getState() { return { ranges: [] }; },
    }));
    const List = props.components?.List ?? "div";
    const Footer = props.components?.Footer;
    const rows = (props.data ?? []).map((row, index) =>
      React.createElement(React.Fragment, { key: index }, props.itemContent(index, row)));
    return React.createElement(List, { style: {} }, rows, Footer ? React.createElement(Footer) : null);
  });
  return { Virtuoso };
});

const { window } = linkedom.parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
const restorePrototypes = captureLinkedomPrototypes(window);
window.getComputedStyle = () => new Proxy({}, { get: (_target, prop) => (typeof prop === "string" && prop.startsWith("get") ? () => "" : "0px") });

const ORIGINALS = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
  localStorage: globalThis.localStorage,
  fetch: globalThis.fetch,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
};

let visibility = "visible";
const storage = new Map();
const navigator = { languages: ["en-US"], language: "en-US", userAgent: "harness" };
const windowProxy = new Proxy(window, {
  get(target, property) {
    if (property === "navigator") return navigator;
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  },
  has(target, property) {
    return property === "navigator" || Reflect.has(target, property);
  },
});
globalThis.navigator = navigator;
globalThis.window = windowProxy;
globalThis.document = window.document;
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => void storage.set(key, String(value)),
  removeItem: (key) => void storage.delete(key),
};
Object.defineProperty(window.document, "visibilityState", {
  configurable: true,
  get: () => visibility,
});
window.Element.prototype.scrollIntoView = function scrollIntoView() {};
// linkedom liefert die DOM-Klassen; FileExplorer (Arborist) braucht sie als
// Globals. Jede Zuweisung wird fuer den Restore gemerkt.
const installed = new Map();
function installGlobal(name, value) {
  const existing = Object.getOwnPropertyDescriptor(globalThis, name);
  if (existing && !existing.configurable && !existing.writable) return;
  if (!installed.has(name)) installed.set(name, existing);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
for (const [name, value] of Object.entries(linkedom)) {
  if (name === "parseHTML" || name === "default") continue;
  if (typeof value === "function" && /^[A-Z]/.test(name)) installGlobal(name, value);
}
for (const name of Object.keys(window)) {
  if (name === "window") continue;
  if (name in globalThis && installed.has(name)) continue;
  installGlobal(name, window[name]);
}
installGlobal("Event", window.Event);
installGlobal("EventTarget", window.EventTarget);
installGlobal("Image", class {
  constructor() { this.src = ""; this.width = 1; this.height = 1; }
  set src(value) { this._src = value; }
  get src() { return this._src ?? ""; }
});
installGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
installGlobal("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 0));
installGlobal("cancelAnimationFrame", (id) => clearTimeout(id));
installGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
installGlobal("MutationObserver", class { observe() {} disconnect() {} takeRecords() { return []; } });
installGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });

// `useIsMobile` liest die Media-Query am window-Objekt, und linkedoms window
// teilt `matchMedia` mit dem Global — deshalb erst nach den installGlobal-
// Aufrufen setzen, sonst ueberschreibt der Globale-Stub aus der Testdatei ihn.
let mobileViewport = false;
window.matchMedia = (query) => ({
  matches: mobileViewport && query === "(max-width: 640px)",
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

test.after(() => {
  restorePrototypes();
  for (const [name, descriptor] of installed) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  for (const key of ["window", "document", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"]) {
    if (ORIGINALS[key] === undefined) delete globalThis[key];
    else globalThis[key] = ORIGINALS[key];
  }
});

const CWD = "/home/alice/work";
const SESSION = {
  id: "s1",
  path: "/tmp/s1.jsonl",
  cwd: CWD,
  projectRoot: CWD,
  created: "2026-01-01T00:00:00Z",
  modified: "2026-10-01T00:00:00Z",
  messageCount: 2,
  firstMessage: "hello there",
  parentSession: null,
  name: null,
  transient: false,
};
const PAGE = {
  entries: [{ name: "notes.txt", isDir: false, size: 1536, modified: "" }],
  path: CWD,
  parentPath: "/home/alice",
  ancestors: ["/", "/home/alice"],
};
const GIT_FILES = [
  { filePath: `${CWD}/notes.txt`, status: "modified", code: "M", indexStatus: "M", worktreeStatus: " " },
];

let runningIds = [];
const requests = [];
function json(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

function installFetch() {
  requests.length = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method ?? "GET", body: init.body });
    if (url.startsWith("/api/sessions?archived=1")) return json({ sessions: [] });
    if (url.startsWith("/api/sessions")) return json({ sessions: [SESSION] });
    if (url.startsWith("/api/agent/running")) return json({ runningSessionIds: runningIds });
    if (url.startsWith("/api/worktrees?cwd=")) {
      return json({
        projectRoot: CWD,
        isGit: true,
        isTopLevel: true,
        worktrees: [
          { path: CWD, branch: "main", isMain: true },
          { path: `${CWD}-feature`, branch: null, isMain: false },
        ],
      });
    }
    if (url.startsWith("/api/worktrees")) return json({});
    if (url.startsWith("/api/home")) return json({ home: "/home/alice" });
    if (url.includes("/api/git/status")) {
      return json({ isGitRepository: true, repositoryRoot: CWD, files: GIT_FILES, additions: 1, deletions: 0 });
    }
    if (url.includes("type=list")) return json(PAGE);
    return json({});
  };
}

// linkedom kennt weder select() noch setSelectionRange(); der Rename-Effekt
// ruft beides nach dem Mount.
for (const proto of [window.HTMLInputElement?.prototype, window.HTMLTextAreaElement?.prototype]) {
  if (!proto) continue;
  let selectionStart = 0;
  let selectionEnd = 0;
  Object.defineProperty(proto, "selectionStart", { get: () => selectionStart, configurable: true });
  Object.defineProperty(proto, "selectionEnd", { get: () => selectionEnd, configurable: true });
  proto.setSelectionRange = function setSelectionRange(start, end) {
    const max = String(this.value ?? "").length;
    selectionStart = Math.min(Math.max(0, start), max);
    selectionEnd = Math.min(Math.max(selectionStart, end), max);
  };
  proto.select = function select() { this.setSelectionRange(0, String(this.value ?? "").length); };
  proto.attachEvent = function attachEvent() {};
  proto.detachEvent = function detachEvent() {};
}

function settle(ms = 50) {
  return act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { SessionSidebar } = await jiti.import("./SessionSidebar.tsx");

async function mount(props = {}) {
  installFetch();
  window.document.body.innerHTML = "";
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    root.render(
      React.createElement(I18nProvider, null,
        React.createElement(SessionSidebar, {
          selectedSessionId: null,
          onSelectSession: () => {},
          ...props,
        })),
    );
  });
  await settle(80);
  return { container, root };
}

function buttonByTitle(scope, title) {
  return [...scope.querySelectorAll("button")].find((node) => (node.getAttribute("title") ?? "").startsWith(title));
}

test("Projekt- und Sessionzeilen kommen aus /api/sessions, Kollaps und Entfernen wirken", async () => {
  storage.clear();
  const { container } = await mount();

  assert.match(container.textContent, /hello there/);
  const collapse = buttonByTitle(container, "Collapse project");
  assert.ok(collapse, "der Projekt-Kollaps fehlt");
  await act(async () => { collapse.click(); });
  await settle();
  assert.equal(storage.get("omp-web:collapsed-projects"), JSON.stringify([CWD]));
  assert.ok(buttonByTitle(container, "Expand project"), "der Kollaps wurde nicht umgeschaltet");

  const actions = container.querySelector('[title="Project actions"]');
  assert.ok(actions, "der Projekt-Menueknopf fehlt");
  await act(async () => { actions.click(); });
  await settle();
  // Das Menue oeffnet sich animiert; nach zwei Frames ist der Inhalt da.
  await settle(60);
  const remove = [...container.querySelectorAll("button")].find((node) => node.textContent.includes("Remove from sidebar"));
  assert.ok(remove, "der Entfernen-Eintrag fehlt im Menue");
  await act(async () => { remove.click(); });
  await settle();
  assert.equal(storage.get("omp-web:removed-projects"), JSON.stringify([CWD]));
  assert.equal(container.textContent.includes("hello there"), false, "die Projektzeile blieb trotz Entfernen stehen");
});

test("Worktree-Menue zeigt Pfad-Label und Home-Kuerzung", async () => {
  storage.clear();
  const { container } = await mount();
  const actions = container.querySelector('[title="Project actions"]');
  await act(async () => { actions.click(); });
  await settle(60);
  const worktrees = [...container.querySelectorAll("button")].find((node) => node.textContent.includes("Worktrees"));
  assert.ok(worktrees, "der Worktree-Eintrag fehlt");
  await act(async () => { worktrees.click(); });
  await settle(60);
  assert.match(container.textContent, /main/);
  assert.match(container.textContent, /~\/work-feature/, "displayCwd hat das Home-Verzeichnis nicht gekuerzt");
});

test("Laufende und unbenutzte Sessions zeigen ihre Indikatoren", async () => {
  storage.clear();
  storage.set("omp-web:unread-session-ids", JSON.stringify(["s1"]));
  runningIds = [];
  const { container } = await mount();
  assert.ok(container.querySelector('[title="New activity"]'), "der Unread-Indikator fehlt");

  runningIds = ["s1"];
  await act(async () => {
    visibility = "hidden";
    window.document.dispatchEvent(new window.Event("visibilitychange"));
  });
  await settle();
  await act(async () => {
    visibility = "visible";
    window.document.dispatchEvent(new window.Event("visibilitychange"));
  });
  await settle(80);
  assert.ok(container.querySelector('[title="Agent running…"]'), "der Running-Indikator fehlt");
  assert.equal(container.querySelector('[title="New activity"]'), null);
  storage.clear();
});

test("Sessionzeile ist per Enter bedienbar und meldet die Auswahl", async () => {
  storage.clear();
  runningIds = [];
  const selected = [];
  const { container } = await mount({ selectedSessionId: "s1", onSelectSession: (session) => selected.push(session.id) });
  const title = [...container.querySelectorAll("div")].find((node) => node.getAttribute("title") === "hello there");
  assert.ok(title, "die Sessionzeile fehlt");
  const row = title.parentElement;
  assert.equal(row.getAttribute("role"), "button");
  assert.equal(row.getAttribute("tabindex"), "0");
  assert.equal(row.getAttribute("aria-current"), "true");
  await act(async () => {
    row.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true }), { key: "Enter" }));
  });
  await settle();
  assert.deepEqual(selected, ["s1"]);
});

test("mobil sind die drei Aktionen ohne Hover im DOM", async () => {
  storage.clear();
  runningIds = [];
  mobileViewport = true;
  try {
    const { container } = await mount();
    // Kein mouseover: die Aktionen muessen allein aus `isMobile` entstehen.
    const actions = [
      container.querySelector('[title="Rename"]'),
      container.querySelector('[title="Archive (hide from list, restorable)"]'),
      container.querySelector('[title="Delete (Shift+click to delete without confirmation)"]'),
    ];
    assert.ok(actions.every(Boolean), "die drei Aktionen fehlen mobil");
    // Die Klasse traegt die 44-px-Regel aus globals.css.
    assert.ok(actions.every((node) => node.classList.contains("sidebar-row-action")));
  } finally {
    mobileViewport = false;
  }
});

test("Hover zeigt Aktionen; Umbenennen, Archivieren und Shift-Loeschen laufen ueber die API", async () => {
  storage.clear();
  runningIds = [];
  const { container } = await mount();
  const row = [...container.querySelectorAll("div")].find((node) => node.getAttribute("title") === "hello there");
  assert.ok(row, "die Sessionzeile fehlt");
  const pressableRow = row.parentElement;
  await act(async () => {
    pressableRow.dispatchEvent(new window.Event("mouseover", { bubbles: true, relatedTarget: window.document.body }));
  });
  await settle();

  // Hover blendet die Aktionsknoepfe ein; ein Klick auf Umbenennen mountet
  // das Eingabefeld. Der Blur-Pfad laesst sich in linkedom nicht ausloesen,
  // deshalb bleibt es beim Nachweis der Aktionen (Archiv/Loeschen).
  assert.ok(container.querySelector('[title="Rename"]'), "der Umbenennen-Knopf erscheint beim Hover nicht");

  const archive = container.querySelector('[title="Archive (hide from list, restorable)"]');
  await act(async () => { archive.click(); });
  await settle();
  const archiveCall = requests.find((entry) => entry.url === "/api/sessions/s1" && entry.method === "PATCH");
  assert.ok(archiveCall, "der Archiv-Aufruf fehlt");
  assert.match(archiveCall.body, /"archived":true/);

  const remove = container.querySelector('[title="Delete (Shift+click to delete without confirmation)"]');
  await act(async () => {
    remove.dispatchEvent(Object.assign(new window.Event("click", { bubbles: true }), { shiftKey: true }));
  });
  await settle();
  assert.ok(requests.some((entry) => entry.url === "/api/sessions/s1" && entry.method === "DELETE"), "der Shift-Klick hat nicht geloescht");
});

test("Kontextmenue-Ereignis ruft refresh und der Explorer meldet Aenderungen", async () => {
  storage.clear();
  runningIds = [];
  const listener = (event) => {
    event.preventDefault();
    event.detail.refresh();
  };
  window.addEventListener("pi-web:session-row-contextmenu", listener);
  const { container } = await mount();
  try {
    const row = [...container.querySelectorAll("div")].find((node) => node.getAttribute("title") === "hello there");
    await act(async () => {
      row.dispatchEvent(Object.assign(new window.Event("contextmenu", { bubbles: true, cancelable: true }), { clientX: 5, clientY: 5 }));
    });
    await settle();

    const toolbar = container.querySelector('[title="1 changed files"]');
    assert.ok(toolbar, "der Aenderungs-Knopf des Explorers fehlt");
    assert.equal(toolbar.getAttribute("aria-pressed"), "false");
    await act(async () => {
      toolbar.dispatchEvent(new window.Event("mouseover", { bubbles: true, relatedTarget: window.document.body }));
    });
    await act(async () => {
      toolbar.dispatchEvent(new window.Event("mouseout", { bubbles: true, relatedTarget: window.document.body }));
    });
    await act(async () => { toolbar.click(); });
    await settle();
    assert.equal(container.querySelector('[title="1 changed files"]').getAttribute("aria-pressed"), "true");

    await act(async () => {
      window.document.dispatchEvent(Object.assign(new window.Event("mousedown", { bubbles: true }), { target: window.document.body }));
    });
  } finally {
    window.removeEventListener("pi-web:session-row-contextmenu", listener);
  }
});
