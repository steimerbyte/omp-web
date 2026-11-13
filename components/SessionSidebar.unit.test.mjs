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
// Letzter Props-Satz der Liste, damit `defaultItemHeight` pruefbar ist.
const virtuosoProps = [];
mock.module("react-virtuoso", () => {
  const Virtuoso = forwardRef(function VirtuosoMock(props, ref) {
    virtuosoProps.push(props);
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
// Radix misst Trigger und Panel; ohne Rechtecke steht das Menue auf NaN.
window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return { top: 0, left: 0, right: 120, bottom: 20, width: 120, height: 20, x: 0, y: 0 };
};
// Der Fokus: Escape muss ihn an den Menueknopf zurueckgeben (Radix' Zusage,
// hier gemessen statt angenommen). linkedom setzt `activeElement` nicht.
let activeElement = window.document.body;
function rememberFocus(element) { activeElement = element; }
Object.defineProperty(window.document, "activeElement", { configurable: true, get: () => activeElement });
window.HTMLElement.prototype.focus = function focus() { rememberFocus(this); };
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

/** Radix oeffnet auf `pointerdown`, nicht auf `click`. */
function pointerDown(node) {
  const event = new window.Event("pointerdown", { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({ button: 0, ctrlKey: false, pointerType: "mouse" })) {
    Object.defineProperty(event, key, { value, configurable: true });
  }
  node.dispatchEvent(event);
}

function keydown(target, key) {
  const event = new window.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "key", { value: key, configurable: true });
  target.dispatchEvent(event);
}

/** Oeffnet das Zeilenmenue einer Sitzung und liefert seine Eintraege (Portal am body). */
async function openRowMenu(scope) {
  const trigger = scope.querySelector('[title="Session actions"]');
  assert.ok(trigger, "der Menueknopf der Sessionzeile fehlt");
  await act(async () => { pointerDown(trigger); });
  await settle(30);
  return [...window.document.querySelectorAll('[role="menu"] [role="menuitem"]')];
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

test("ohne Animationen steht der Unread-Puls still", async () => {
  storage.clear();
  storage.set("omp-web:unread-session-ids", JSON.stringify(["s1"]));
  storage.set("omp-animations", "off");
  runningIds = [];
  const { container } = await mount();
  assert.ok(container.querySelector('[title="New activity"]'), "der Unread-Indikator fehlt");
  // SMIL kennt weder `data-omp-animations` noch reduced motion — mit
  // abgeschalteten Animationen darf kein <animate> im DOM stehen.
  const smil = [...container.querySelectorAll("*")].filter((node) => /^animate/i.test(node.tagName));
  assert.equal(smil.length, 0);
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

test("mobil steht ein Menueknopf ohne Hover in der Zeile, nicht drei Einzelknoepfe", async () => {
  storage.clear();
  runningIds = [];
  mobileViewport = true;
  try {
    const { container } = await mount();
    // Kein mouseover: der Knopf entsteht allein aus dem Markup.
    const menu = container.querySelector('[title="Session actions"]');
    assert.ok(menu, "der Menueknopf fehlt mobil");
    // Die Klasse traegt die 44-px-Regel aus globals.css.
    assert.ok(menu.classList.contains("sidebar-row-action"), "die 44-px-Regel haengt an der Klasse");
    for (const gone of ["Rename", "Archive", "Delete"]) {
      assert.equal(
        container.querySelector(`[title^="${gone}"]`),
        null,
        `der Einzelknopf ${gone} ist noch da`,
      );
    }
  } finally {
    mobileViewport = false;
  }
});

test("der Menueknopf ist auch auf dem Desktop ohne Hover da", async () => {
  storage.clear();
  runningIds = [];
  const { container } = await mount();
  assert.ok(container.querySelector('[title="Session actions"]'), "der Menueknopf fehlt ohne Hover");
});

test("Sessionzeile ist mobil 44px hoch und auf dem Desktop 40", async () => {
  storage.clear();
  runningIds = [];
  const desktop = await mount();
  const desktopRow = [...desktop.container.querySelectorAll("div")]
    .find((node) => node.getAttribute("title") === "hello there").parentElement;
  assert.equal(desktopRow.style.height, "40px");
  assert.equal(virtuosoProps.at(-1).defaultItemHeight, 40);

  mobileViewport = true;
  try {
    const mobile = await mount();
    const mobileRow = [...mobile.container.querySelectorAll("div")]
      .find((node) => node.getAttribute("title") === "hello there").parentElement;
    assert.equal(mobileRow.style.height, "44px");
    assert.equal(virtuosoProps.at(-1).defaultItemHeight, 44);
  } finally {
    mobileViewport = false;
  }
});

test("das Zeilenmenue bietet genau Rename, Archive und Delete; die Aktionen laufen ueber die API", async () => {
  storage.clear();
  runningIds = [];
  const { container } = await mount();

  const items = await openRowMenu(container);
  assert.deepEqual(
    items.map((item) => item.textContent),
    ["Rename", "Archive (hide from list, restorable)", "Delete"],
    "die Zeile hat genau diese drei Aktionen",
  );

  await act(async () => { items[1].click(); });
  await settle();
  const archiveCall = requests.find((entry) => entry.url === "/api/sessions/s1" && entry.method === "PATCH");
  assert.ok(archiveCall, "der Archiv-Aufruf fehlt");
  assert.match(archiveCall.body, /"archived":true/);

  // Delete oeffnet dieselbe Rueckfrage in der Zeile.
  const second = await openRowMenu(container);
  await act(async () => { second[2].click(); });
  await settle();
  assert.match(container.textContent, /Delete hello there\?/, "die Rueckfrage fehlt");
  const confirm = [...container.querySelectorAll("button")].find((node) => node.textContent === "Delete");
  assert.ok(confirm, "der Bestaetigungsknopf fehlt");
  await act(async () => { confirm.click(); });
  await settle();
  assert.ok(
    requests.some((entry) => entry.url === "/api/sessions/s1" && entry.method === "DELETE"),
    "die Bestaetigung hat nicht geloescht",
  );
});

test("Enter oeffnet das Menue, Pfeiltasten navigieren, Escape gibt den Fokus zurueck", async () => {
  storage.clear();
  runningIds = [];
  const { container } = await mount();
  const trigger = container.querySelector('[title="Session actions"]');
  assert.ok(trigger, "der Menueknopf fehlt");

  await act(async () => { keydown(trigger, "Enter"); });
  await settle(20);
  assert.ok(window.document.querySelector('[role="menu"]'), "Enter hat das Menue nicht geoeffnet");

  await act(async () => { keydown(window.document.activeElement, "ArrowDown"); });
  await settle(10);
  assert.equal(
    window.document.activeElement?.getAttribute("role"),
    "menuitem",
    "die Pfeiltaste hat den Fokus nicht in die Eintraege bewegt",
  );

  await act(async () => { keydown(window.document, "Escape"); });
  await settle(20);
  assert.equal(window.document.querySelector('[role="menu"]'), null, "Escape schliesst das Menue nicht");
  assert.equal(window.document.activeElement, trigger, "der Fokus kehrt nicht zum Menueknopf zurueck");
});

test("Klick auf den Menueknopf und auf einen Eintrag waehlt die Sitzung nicht aus", async () => {
  storage.clear();
  runningIds = [];
  const selected = [];
  const { container } = await mount({ onSelectSession: (session) => selected.push(session.id) });
  const trigger = container.querySelector('[title="Session actions"]');
  assert.ok(trigger, "der Menueknopf fehlt");

  await act(async () => { trigger.click(); });
  await act(async () => { pointerDown(trigger); });
  await settle(20);
  assert.deepEqual(selected, [], "der Klick auf den Menueknopf hat die Sitzung ausgewaehlt");

  const items = [...window.document.querySelectorAll('[role="menu"] [role="menuitem"]')];
  await act(async () => { items[0].click(); });
  await settle();
  assert.deepEqual(selected, [], "der Menueeintrag hat die Sitzung mit ausgewaehlt");
  assert.ok(container.querySelector("input"), "der Eintrag Rename hat das Eingabefeld nicht geoeffnet");
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
