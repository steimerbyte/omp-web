import assert from "node:assert/strict";
import test from "node:test";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";
import * as linkedom from "linkedom";
import React from "react";
import { createJiti } from "jiti";

/**
 * FileExplorer: Baum (mit Git-Badges), Hover-Aktionen fuer Mention und
 * Bildvorschau, Auswahl/Properties, Upload ueber den imperativen Handle samt
 * Fehler-Toast und Erfolgs-Zusammenfassung, das grosse Fenster (Portal,
 * Escape) und die Change-Liste. Der Baum ist virtualisiert; der Harness misst
 * 600 px Hoehe, damit react-window Zeilen rendert.
 */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const win = dom.window;
restoreLinkedomPrototypesOnExit(win);
const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };
const computed = () => new Proxy({}, { get: (_target, prop) => (typeof prop === "string" && prop.startsWith("get") ? () => "" : "0px") });
win.getComputedStyle = computed;
win.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent() { return false; } });
globalThis.window = new Proxy(win, {
  get(target, prop) {
    if (prop === "navigator") return fakeNavigator;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
globalThis.document = win.document;
globalThis.navigator = fakeNavigator;
// Arborist animiert den Fokus-Scroll ueber requestAnimationFrame; eine echte
// Frame-Schleife laesst `act` nie zur Ruhe kommen. Der Stub ist fuer den Test
// ausreichend, weil keine Animation geprueft wird.
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
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
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  clear: () => { storage.clear(); },
};
globalThis.localStorage = localStorage;
win.localStorage = localStorage;
win.HTMLElement.prototype.getBoundingClientRect = function rect() {
  return { top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 };
};
Object.defineProperty(win.Element.prototype, "clientHeight", { get: () => 600, configurable: true });
Object.defineProperty(win.Element.prototype, "scrollHeight", { get: () => 600, configurable: true });
Object.defineProperty(win.Element.prototype, "scrollTop", { get: () => 0, set: () => {}, configurable: true });
win.Element.prototype.scrollIntoView = function scrollIntoView() {};

const ORIGINALS = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
  localStorage: globalThis.localStorage,
  fetch: globalThis.fetch,
  XMLHttpRequest: globalThis.XMLHttpRequest,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
};

const CWD = "/work";
const ROOT_PAGE = {
  entries: [
    { name: "src", isDir: true, size: 0, modified: "" },
    { name: "notes.txt", isDir: false, size: 1536, modified: "" },
    { name: "photo.png", isDir: false, size: 2048, modified: "" },
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
const GIT_FILES = [
  { filePath: "/work/notes.txt", status: "modified", code: "M", indexStatus: "M", worktreeStatus: " " },
  { filePath: "/work/photo.png", status: "untracked", code: "A", indexStatus: "?", worktreeStatus: "?" },
];

function installFetch({ uploadCheck = "ok", files = GIT_FILES } = {}) {
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/api/files/work/src?type=list")) return { ok: true, status: 200, json: async () => SRC_PAGE };
    if (href.includes("type=list")) return { ok: true, status: 200, json: async () => ROOT_PAGE };
    if (href.includes("/api/git/status")) {
      return { ok: true, status: 200, json: async () => ({ isGitRepository: files.length > 0, repositoryRoot: "/work", files, additions: 3, deletions: 1 }) };
    }
    if (href.includes("/api/home")) return { ok: true, status: 200, json: async () => ({ home: "/home/user" }) };
    if (href.includes("type=upload-check")) {
      if (uploadCheck === "error") return { ok: false, status: 403, json: async () => ({ error: "No permission" }) };
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (href.includes("type=meta")) return { ok: true, status: 200, json: async () => ({ size: 1536, mime: "text/plain", language: "text" }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

class FakeXHR {
  static instances = [];
  static next = { status: 200, body: { uploaded: ["notes.txt"], skipped: [], errors: [] } };
  constructor() {
    this.upload = {};
    this.status = 0;
    this.responseText = "";
    FakeXHR.instances.push(this);
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  send(body) {
    this.body = body;
    setTimeout(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
      this.upload.onprogress?.({ lengthComputable: false, loaded: 1, total: 0 });
      this.status = FakeXHR.next.status;
      this.responseText = typeof FakeXHR.next.body === "string" ? FakeXHR.next.body : JSON.stringify(FakeXHR.next.body);
      this.onload?.();
    }, 0);
  }
}
globalThis.XMLHttpRequest = FakeXHR;

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
  for (const key of ["window", "document", "navigator", "localStorage", "fetch", "XMLHttpRequest", "IS_REACT_ACT_ENVIRONMENT"]) {
    if (ORIGINALS[key] === undefined) delete globalThis[key];
    else globalThis[key] = ORIGINALS[key];
  }
});

function settle(ms = 40) {
  return act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

async function mount({ changesCollapsed = true, props = {}, ref = null, fetchOptions = {} } = {}) {
  installFetch(fetchOptions);
  win.document.body.innerHTML = "";
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  mountedRoots.push(root);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    root.render(
      React.createElement(I18nProvider, null,
        React.createElement(FileExplorer, {
          cwd: CWD,
          onOpenFile: () => {},
          changesCollapsed,
          ...props,
          ref,
        })),
    );
  });
  await settle(60);
  await settle(40);
  return container;
}

const rows = (scope = win.document) => [...scope.querySelectorAll('[role="treeitem"]')];
const rowByName = (name, scope = win.document) => rows(scope).find((node) => node.textContent.includes(name));

// Arborists eigener Klick-Pfad (Fokus + Scroll) laesst sich in linkedom nicht
// befriedigend simulieren. Der Row-Renderer haengt seinen onClick aber direkt
// an das DOM-Element; der Test ruft genau diesen Handler mit einem
// MouseEvent-foermigen Objekt auf, damit OnNavigate/OnOpenFile/Selection echt
// durch die Komponente laufen.
function invokeRowClick(row, init = {}) {
  const key = Object.keys(row).find((name) => name.startsWith("__reactProps"));
  const handler = key ? row[key]?.onClick : undefined;
  assert.equal(typeof handler, "function", "die Zeile hat keinen onClick-Handler");
  const event = {
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    target: row,
    currentTarget: row,
    preventDefault() {},
    stopPropagation() {},
  };
  handler(event);
}

function fire(target, type, props = {}) {
  const event = new win.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(event, key, { value, configurable: true });
  }
  target.dispatchEvent(event);
  return event;
}

async function hover(node) {
  // Der Hover-Zustand der Zeilenbeschriftung haengt am inneren
  // dragHandle-Element; ein Enter auf dem aeusseren Row-Element erreicht ihn
  // nicht.
  const target = node.querySelector('div[draggable="true"]') ?? node;
  await act(async () => {
    fire(target, "mouseover", { relatedTarget: win.document.body });
  });
}

// Arborists selectMulti() ruft scrollTo() und haengt in linkedom. Der
// onSelect-Callback des Trees ist aber oeffentlich als Prop vorhanden; der
// Test reicht ihm dieselben Knoten, die ein Ctrl-Klick liefern wuerde.
function invokeTreeSelect(ids) {
  let props = null;
  for (const element of win.document.querySelectorAll("*")) {
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
  props.onSelect(ids.map((id) => ({
    id,
    data: { name: id.split("/").pop(), isDir: id === "/work/src" },
  })));
}

test("Baum zeigt Ordner und Dateien, Git-Badge im Baum, Change-Liste separat", async () => {
  const container = await mount({ changesCollapsed: true, props: { onAtMention: () => {} } });
  assert.ok(rowByName("src"), "der Ordner src fehlt");
  assert.ok(rowByName("notes.txt"), "die Datei notes.txt fehlt");
  assert.equal(rowByName("notes.txt").textContent.includes("M"), true, "das Git-Badge fehlt in der Zeile");
  assert.match(rowByName("src").textContent, /src/);

  // Datei-Klick oeffnet die Datei; arborists node.focus() ist in linkedom
  // nicht ausfuehrbar, deshalb wird das Oeffnen hier nicht ueber die Zeile
  // gefahren (die Zeile selbst ist oben belegt).
  // Die Aenderungsliste ist eine eigene Ansicht: changesCollapsed=false.
  const changes = await mount({ changesCollapsed: false });
  assert.ok(changes.textContent.includes("notes.txt"));
  assert.ok(changes.textContent.includes("photo.png"));
  assert.ok(changes.textContent.includes("+3"));
  assert.ok(changes.textContent.includes("-1"));
  assert.equal(rows(changes).length, 0, "die Aenderungsliste zeigt keinen Dateibaum");
});

test("Ordner laedt beim Aufklappen nach; Hover zeigt Mention und Bildvorschau", async () => {
  const mentions = [];
  const container = await mount({
    props: {
      onAtMention: (path, isDir) => mentions.push([path, isDir]),
      initialViewState: { currentPath: "/work", expandedPaths: new Set(["/work/src"]), history: { paths: ["/work"], index: 0 } },
    },
  });
  assert.ok(rowByName("inner.txt"), "der Unterordner wurde nicht geladen");

  const src = rowByName("src");
  await hover(src);
  const mentionDir = src.querySelector('[title="Insert path into chat"]');
  assert.ok(mentionDir, "der Mention-Knopf fehlt am Ordner");
  await act(async () => {
    mentionDir.click();
  });
  assert.deepEqual(mentions, [["src", true]]);

  const photo = rowByName("photo.png");
  await hover(photo);
  const imageButton = photo.querySelector('[title="Open image in large view"]');
  assert.ok(imageButton, "der Bild-Knopf fehlt an der Bilddatei");
  await act(async () => {
    imageButton.click();
  });
  const preview = win.document.querySelector('[role="dialog"] img');
  assert.ok(preview, "die grosse Bildvorschau wurde nicht geoeffnet");
  assert.equal(preview.getAttribute("src"), "/api/files/work/photo.png?type=read");
  await act(async () => {
    fire(win.document, "keydown", { key: "Escape" });
  });
});

test("Auswahl per Ctrl-Klick, Properties fuer Datei und Ordner, Escape schliesst", async () => {
  const container = await mount();
  const notes = rowByName("notes.txt");
  await act(async () => {
    invokeTreeSelect(["/work/notes.txt"]);
  });
  const properties = container.querySelector('[title="Properties"]');
  assert.ok(properties, "der Properties-Knopf fehlt nach der Auswahl");
  await act(async () => {
    properties.click();
  });
  await settle(20);
  let dialog = win.document.querySelector('[role="dialog"]');
  assert.ok(dialog, "der Properties-Dialog fehlt");
  assert.match(dialog.textContent, /notes\.txt/);
  assert.match(dialog.textContent, /1\.5 KB/);
  assert.match(dialog.textContent, /text\/plain/);
  assert.match(dialog.textContent, /text/);

  await act(async () => {
    fire(win.document.body, "keydown", { key: "Escape" });
  });
  assert.equal(win.document.querySelector('[role="dialog"]'), null, "Escape schliesst die Properties");

  // Ordner-Properties zaehlen die Eintraege aus type=list.
  const clear = container.querySelector('[title="Clear selection"]');
  if (clear) {
    await act(async () => {
      clear.click();
    });
  }
  await act(async () => {
    invokeTreeSelect(["/work/src"]);
  });
  await act(async () => {
    container.querySelector('[title="Properties"]').click();
  });
  await settle(20);
  dialog = win.document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.match(dialog.textContent, /1 items/);
  assert.match(dialog.textContent, /Folder/);
  await act(async () => {
    fire(win.document.body, "keydown", { key: "Escape" });
  });
});

test("Upload ueber den Handle: Fehler mit Dismiss, dann Erfolg mit Zusammenfassung", async () => {
  const ref = React.createRef();
  const container = await mount({ ref });
  assert.ok(ref.current, "der imperative Handle fehlt");
  await act(async () => {
    ref.current.openUploadPicker();
  });
  const input = container.querySelector('input[type="file"]');
  assert.ok(input, "das Datei-Eingabefeld fehlt");

  const deliver = async (file, response) => {
    FakeXHR.next = response;
    const before = FakeXHR.instances.length;
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      fire(input, "change");
    });
    await settle(30);
    return FakeXHR.instances.slice(before);
  };

  const failed = await deliver(new File(["x"], "notes.txt", { type: "text/plain" }), { status: 500, body: "boom" });
  assert.equal(failed.length, 1);
  assert.equal(failed[0].method, "POST");
  assert.match(failed[0].url, /type=upload&conflict=error$/);
  assert.ok(failed[0].body instanceof FormData);
  assert.equal(failed[0].body.get("files").name, "notes.txt");
  assert.match(container.textContent, /boom/);
  const dismissError = container.querySelector('[title="Dismiss error"]');
  assert.ok(dismissError);
  await act(async () => {
    dismissError.click();
  });
  assert.doesNotMatch(container.textContent, /boom/);

  await deliver(new File(["y"], "notes.txt", { type: "text/plain" }), { status: 200, body: { uploaded: ["notes.txt"], skipped: [], errors: [] } });
  assert.match(container.textContent, /notes\.txt/);
  const dismissSummary = container.querySelector('[title="Dismiss upload results"]');
  assert.ok(dismissSummary, "die Upload-Zusammenfassung fehlt");
  await act(async () => {
    dismissSummary.click();
  });
  assert.equal(container.querySelector('[title="Dismiss upload results"]'), null);
});

test("Upload-Check-Fehler landet als Fehlertext ohne XHR", async () => {
  const ref = React.createRef();
  const container = await mount({ ref, fetchOptions: { uploadCheck: "error" } });
  const input = container.querySelector('input[type="file"]');
  const before = FakeXHR.instances.length;
  await act(async () => {
    Object.defineProperty(input, "files", { value: [new File(["z"], "blocked.txt")], configurable: true });
    fire(input, "change");
  });
  await settle(30);
  assert.match(container.textContent, /No permission/);
  assert.equal(FakeXHR.instances.length, before, "ohne erfolgreichen Check darf kein Upload starten");
});

test("grosses Fenster: Portal, Blick-Meldung, Navigation und Escape", async () => {
  const popupChanges = [];
  const views = [];
  const container = await mount({
    props: {
      onPopupOpenChange: (open) => popupChanges.push(open),
      onViewStateChange: (view) => views.push(view),
    },
  });
  // Ein Pfadwechsel meldet einen neuen Blick an die Seite.
  const home = [...container.querySelectorAll("button")]
    .find((node) => (node.getAttribute("title") ?? "").startsWith("Home directory") && !node.disabled);
  assert.ok(home, "der Home-Knopf fehlt");
  await act(async () => {
    home.click();
  });
  await settle(40);
  assert.equal(views.length >= 2, true, "der Baum meldet seinen Blick nach aussen");

  const open = container.querySelector('[title="Open explorer in a large window"]');
  assert.ok(open, "der Knopf zum grossen Fenster fehlt");
  await act(async () => {
    open.click();
  });
  await settle(40);
  const popup = win.document.querySelector('[role="dialog"]');
  assert.ok(popup, "das grosse Fenster wurde nicht geoeffnet");
  assert.ok(popup.querySelectorAll('[role="treeitem"]').length > 0, "das Fenster zeigt keinen Baum");
  assert.equal(popupChanges.at(-1), true, "das Oeffnen wurde nicht gemeldet");

  // Ein Pfadwechsel bei unveraendertem Aufklapp-Zustand laeuft durch
  // sameViewState; der Home-Knopf ist im Fenster aktiv.
  const homeInPopup = [...popup.querySelectorAll("button")]
    .find((node) => (node.getAttribute("title") ?? "").startsWith("Home directory") && !node.disabled);
  assert.ok(homeInPopup, "der Home-Knopf im Fenster fehlt");
  await act(async () => {
    homeInPopup.click();
  });
  await settle(40);
  assert.match(popup.textContent, /home\/user/);

  await act(async () => {
    fire(win.document.body, "keydown", { key: "Escape", bubbles: true });
  });
  await settle(20);
  assert.equal(win.document.querySelector('[role="dialog"]')?.textContent.includes("Explorer:") ?? false, false);
  assert.equal(popupChanges.at(-1), false, "das Schliessen wurde nicht gemeldet");
});
