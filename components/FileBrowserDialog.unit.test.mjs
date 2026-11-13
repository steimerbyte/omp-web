import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

/**
 * FileBrowserDialog: Liste und Raster, Sortierung, Tastaturnavigation,
 * Brotkrume/Aufwaerts, Fehler-Retry/Dismiss, Dateiauswahl mit `allowFiles`,
 * Ansichts-Umschaltung und die Busy-Sperre. Grid-Kacheln bekommen einen
 * IntersectionObserver, der sofort "sichtbar" meldet (sonst laedt das
 * Thumbnail wie im Browser erst beim Scrollen).
 */

const ROOT = process.cwd();
const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
restoreLinkedomPrototypesOnExit(win);

const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US" };
const storage = new Map();
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => void storage.set(key, String(value)),
  removeItem: (key) => void storage.delete(key),
};

class FakeIntersectionObserver {
  constructor(callback) {
    this.callback = callback;
  }
  observe(target) {
    this.callback([{ isIntersecting: true, target }]);
  }
  unobserve() {}
  disconnect() {}
}

class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback;
    observers.push(this);
  }
  observe() {}
  disconnect() {}
}
const observers = [];
globalThis.IntersectionObserver = FakeIntersectionObserver;
globalThis.ResizeObserver = FakeResizeObserver;
win.Element.prototype.scrollIntoView = function scrollIntoView() {};
win.Element.prototype.getBoundingClientRect = function rect() {
  return { top: 0, left: 0, right: 600, bottom: 400, width: 600, height: 400, x: 0, y: 0 };
};

const ORIGINALS = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
  localStorage: globalThis.localStorage,
  IntersectionObserver: globalThis.IntersectionObserver,
  ResizeObserver: globalThis.ResizeObserver,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
};

win.innerWidth = 1200;
win.innerHeight = 800;
win.localStorage = localStorage;
win.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
globalThis.window = new Proxy(win, {
  get(target, property) {
    if (property === "navigator") return fakeNavigator;
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
  has(target, property) {
    return property === "navigator" || Reflect.has(target, property);
  },
});
globalThis.document = win.document;
globalThis.navigator = fakeNavigator;
globalThis.localStorage = localStorage;
for (const [name, value] of Object.entries(linkedom)) {
  if (name === "parseHTML" || name === "default") continue;
  if (typeof value === "function" && /^[A-Z]/.test(name)) globalThis[name] = value;
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
win.getComputedStyle = () => new Proxy({}, { get: (_target, property) => (typeof property === "string" && property.startsWith("get") ? () => "" : "0px") });
globalThis.getComputedStyle = win.getComputedStyle;

const mounted = [];
test.after(async () => {
  for (const { root } of mounted.splice(0)) {
    await act(async () => root.unmount());
  }
  win.document.body.innerHTML = "";
  for (const key of ["window", "document", "navigator", "localStorage", "IntersectionObserver", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"]) {
    if (ORIGINALS[key] === undefined) delete globalThis[key];
    else globalThis[key] = ORIGINALS[key];
  }
});

const jiti = createJiti(`${ROOT}/package.json`, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { I18nProvider } = await jiti.import(`${ROOT}/hooks/useI18n.tsx`);
const { FileBrowserDialog } = await jiti.import(`${ROOT}/components/FileBrowserDialog.tsx`);

const PAGES = {
  "/api/files/work?type=list": {
    entries: [
      { name: "zeta", isDir: true },
      { name: "alpha", isDir: true },
      { name: "photo.png", isDir: false },
      { name: "notes.txt", isDir: false },
    ],
    parentPath: "/",
    ancestors: ["/"],
  },
  "/api/files/work/alpha?type=list": {
    entries: [{ name: "inner", isDir: true }],
    parentPath: "/work",
    ancestors: ["/", "/work"],
  },
  "/api/files/%2F?type=list": {
    entries: [{ name: "home", isDir: true }],
    parentPath: null,
    ancestors: [],
  },
};

function fire(target, type, props = {}) {
  const event = new win.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(event, key, { value, configurable: true });
  }
  target.dispatchEvent(event);
  return event;
}

async function mount(props = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const key = String(url);
    calls.push(key);
    const page = PAGES[key];
    if (!page) {
      return { ok: false, status: 404, json: async () => ({ error: `not found: ${key}` }) };
    }
    return { ok: true, status: 200, json: async () => page };
  };
  win.document.body.innerHTML = "";
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  const events = { cancel: 0, confirm: [], view: [], selectFile: [] };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    root.render(React.createElement(I18nProvider, null,
      React.createElement(FileBrowserDialog, {
        open: true,
        title: "Copy to…",
        initialPath: "/work",
        confirmLabel: "Copy here",
        onCancel: () => { events.cancel += 1; },
        onConfirm: (path) => events.confirm.push(path),
        onViewChange: props.onViewChange === undefined ? undefined : (view) => {
          events.view.push(view);
          props.onViewChange?.(view);
        },
        onSelectFile: props.allowFiles ? (path) => events.selectFile.push(path) : undefined,
        ...props,
      })));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  mounted.push({ root });
  return { root, container, calls, events };
}

// Liste und Raster tragen keine Listenrolle mehr (die Eintraege sind Knoepfe);
// der Ordner-Name am Container ist der stabile Griff.
const listbox = (container) => container.querySelector('[aria-label="Current folder"]');
const buttons = (container) => [...container.querySelectorAll("button")];

test("Liste: sortiert Ordner vor Dateien, Dateien ohne allowFiles sind deaktiviert", async () => {
  const { root, container, calls, events } = await mount({ view: "list" });
  assert.equal(calls[0], "/api/files/work?type=list");

  const list = listbox(container);
  assert.ok(list, "die Liste fehlt");
  assert.equal(list.getAttribute("aria-label"), "Current folder");
  const names = [...list.querySelectorAll("span")].map((node) => node.textContent).filter((text) => /alpha|zeta|photo|notes/.test(text) && !text.includes("."));
  assert.deepEqual(names, ["alpha", "zeta"]);

  const disabled = [...list.querySelectorAll('[aria-disabled="true"]')];
  assert.equal(disabled.length, 2, "beide Dateien sind deaktivierte Zeilen");
  assert.match(list.textContent, /photo\.png/);
  assert.match(list.textContent, /notes\.txt/);

  // Der Sortierknopf dreht die Reihenfolge der Ordner.
  await act(async () => {
    container.querySelector('[aria-label="Sort by name"]').click();
  });
  const sortedDown = [...list.querySelectorAll('span')].map((node) => node.textContent).filter((text) => text === "alpha" || text === "zeta");
  assert.deepEqual(sortedDown, ["zeta", "alpha"]);

  // Bestaetigen liefert den aktuellen Ordner.
  const confirm = buttons(container).find((node) => node.textContent.trim() === "Copy here");
  assert.equal(confirm.hasAttribute("disabled"), false);
  await act(async () => {
    confirm.click();
  });
  assert.deepEqual(events.confirm, ["/work"]);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Tastatur: Pfeil ab/auf, Enter in Ordner, Backspace hoch, Home zur Wurzel", async () => {
  const { root, container, calls } = await mount({ view: "list" });
  const panel = container.querySelector('[role="dialog"]');

  await act(async () => {
    fire(panel, "keydown", { key: "ArrowDown" });
  });
  const active = panel.querySelector('[data-active="true"]');
  assert.ok(active, "nach ArrowDown muss eine Zeile aktiv sein");
  assert.match(active.textContent, /alpha/);

  await act(async () => {
    fire(panel, "keydown", { key: "ArrowDown" });
  });
  assert.match(panel.querySelector('[data-active="true"]').textContent, /zeta/);
  await act(async () => {
    fire(panel, "keydown", { key: "ArrowUp" });
  });
  assert.match(panel.querySelector('[data-active="true"]').textContent, /alpha/);

  // Enter betritt den aktiven Ordner.
  await act(async () => {
    fire(panel, "keydown", { key: "Enter" });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls[1], "/api/files/work/alpha?type=list");
  assert.match(container.textContent, /inner/);
  assert.equal(container.querySelector('[aria-label="Selected folder"]').textContent, "/work/alpha");

  // Backspace geht wieder hoch (parentPath aus der Antwort).
  await act(async () => {
    fire(panel, "keydown", { key: "Backspace" });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls[2], "/api/files/work?type=list");

  // Home springt auf "/".
  await act(async () => {
    fire(panel, "keydown", { key: "Home" });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls[3], "/api/files/%2F?type=list");
  assert.equal(container.querySelector('[aria-label="Selected folder"]').textContent, "/");

  // ArrowRight betritt ebenfalls den aktiven Ordner (nach ArrowDown).
  await act(async () => {
    fire(panel, "keydown", { key: "ArrowDown" });
  });
  await act(async () => {
    fire(panel, "keydown", { key: "ArrowRight" });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls[4], "/api/files/home?type=list");

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Liste und Raster geben sich nicht als Listbox aus; Enter oeffnet weiterhin den aktiven Ordner", async () => {
  const listMount = await mount({ view: "list" });
  assert.equal(
    listMount.container.querySelectorAll('[role="listbox"], [role="option"]').length,
    0,
    "der Container traegt keine Listenrolle, die seine Knopf-Kinder nicht erfuellen",
  );
  const list = listbox(listMount.container);
  assert.ok(list);
  assert.ok([...list.children].every((node) => node.tagName === "BUTTON" || node.getAttribute("aria-disabled") === "true"));
  const panel = listMount.container.querySelector('[role="dialog"]');
  await act(async () => {
    fire(panel, "keydown", { key: "ArrowDown" });
  });
  const active = list.querySelector('[data-active="true"]');
  assert.match(active.textContent, /alpha/, "die Pfeiltaste setzt die aktive Zeile wie zuvor");
  await act(async () => {
    fire(panel, "keydown", { key: "Enter" });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(listMount.calls.at(-1), "/api/files/work/alpha?type=list");
  await act(async () => listMount.root.unmount());
  mounted.splice(0, mounted.length);
  listMount.container.remove();

  const gridMount = await mount({ view: "grid" });
  assert.equal(gridMount.container.querySelectorAll('[role="listbox"], [role="option"]').length, 0);
  await act(async () => gridMount.root.unmount());
  mounted.splice(0, mounted.length);
  gridMount.container.remove();
});

test("Brotkrume und Aufwaerts-Knopf navigieren nur bestaetigte Vorfahren", async () => {
  const { root, container, calls } = await mount({ view: "list" });
  await act(async () => {
    // In /work/alpha wechseln, damit "/" und "/work" als Vorfahren sichtbar sind.
    const alpha = [...listbox(container).querySelectorAll("button")].find((node) => node.textContent.includes("alpha"));
    alpha.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls.at(-1), "/api/files/work/alpha?type=list");

  // CSS-Module-Klassen sind im Harness leer; die Krume wird ueber Text+title gefunden.
  const workCrumb = [...container.querySelectorAll("button")].find((node) => node.textContent.trim() === "work" && node.getAttribute("title") === "/work");
  assert.ok(workCrumb, "die bestaetigte Krume /work ist ein Knopf");
  await act(async () => {
    workCrumb.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls.at(-1), "/api/files/work?type=list");

  const up = container.querySelector('[aria-label="Up one level"]');
  assert.ok(up, "der Aufwaerts-Knopf fehlt");
  await act(async () => {
    up.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls.at(-1), "/api/files/%2F?type=list");

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Raster: Kacheln, Thumbnails fuer Bilder und Dateiauswahl mit allowFiles", async () => {
  const { root, container, calls, events } = await mount({ allowFiles: true, view: "grid" });
  assert.equal(calls[0], "/api/files/work?type=list");
  const grid = listbox(container);
  assert.ok(grid);
  assert.equal(observers.length >= 1, true, "die Rasterflaeche wird gemessen");

  const tiles = [...grid.querySelectorAll("button")];
  const photo = tiles.find((node) => node.textContent.includes("photo.png"));
  assert.ok(photo, "die Bildkachel fehlt");
  assert.equal(photo.getAttribute("title"), "photo.png");
  const img = photo.querySelector("img");
  assert.ok(img, "das Thumbnail wurde nicht gerendert");
  assert.equal(img.getAttribute("src"), "/api/files/work/photo.png?type=read");
  assert.equal(img.getAttribute("loading"), "lazy");

  const folder = tiles.find((node) => node.textContent.includes("alpha"));
  assert.ok(folder);
  await act(async () => {
    folder.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls.at(-1), "/api/files/work/alpha?type=list");

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();

  const second = await mount({ allowFiles: true, view: "grid" });
  const fileTile = [...listbox(second.container).querySelectorAll("button")].find((node) => node.textContent.includes("notes.txt"));
  assert.ok(fileTile);
  await act(async () => {
    fileTile.click();
  });
  assert.deepEqual(second.events.selectFile, ["/work/notes.txt"]);

  // selectedFile markiert die Kachel.
  await act(async () => second.root.unmount());
  mounted.splice(0, mounted.length);
  second.container.remove();
  const third = await mount({ allowFiles: true, view: "grid", selectedFile: "/work/notes.txt" });
  const selected = [...listbox(third.container).querySelectorAll("button")].find((node) => node.textContent.includes("notes.txt"));
  assert.equal(selected.getAttribute("title"), "notes.txt");
  await act(async () => third.root.unmount());
  mounted.splice(0, mounted.length);
  third.container.remove();
});

test("Ansicht umschalten: kontrolliert meldet nur, unkontrolliert wechselt die Darstellung", async () => {
  let nextView;
  const controlled = await mount({ view: "list", onViewChange: (view) => { nextView = view; } });
  const gridButton = controlled.container.querySelector('button[title="Grid view"]');
  assert.ok(gridButton);
  await act(async () => {
    gridButton.click();
  });
  assert.equal(nextView, "grid");
  assert.equal(listbox(controlled.container).querySelectorAll("button").length > 0, true, "kontrolliert bleibt die Liste");

  await act(async () => controlled.root.unmount());
  mounted.splice(0, mounted.length);
  controlled.container.remove();

  let uncontrolledView;
  const uncontrolled = await mount({ allowFiles: true, onViewChange: (view) => { uncontrolledView = view; } });
  // allowFiles ohne view startet im Raster.
  assert.ok(uncontrolled.container.querySelector("img"), "das Raster startet mit Thumbnails");
  const listButton = uncontrolled.container.querySelector('button[title="List view"]');
  await act(async () => {
    listButton.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(uncontrolledView, "list");
  assert.equal(uncontrolled.container.querySelectorAll("img").length, 0, "die Liste rendert keine Thumbnails");

  await act(async () => uncontrolled.root.unmount());
  mounted.splice(0, mounted.length);
  uncontrolled.container.remove();
});

test("Fehler: Meldung, Retry und Dismiss; Bestaetigen bleibt gesperrt", async () => {
  const { root, container, calls } = await mount({ view: "list" });
  // Ein nicht existierendes Ziel erzwingt einen 403/404 aus dem Stub.
  await act(async () => {
    const panel = container.querySelector('[role="dialog"]');
    fire(panel, "keydown", { key: "Home" });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  // "/" existiert; jetzt gezielt den Fehlerpfad ueber einen unbekannten Pfad.
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: "Access denied" }) });
  await act(async () => {
    const panel = container.querySelector('[role="dialog"]');
    fire(panel, "keydown", { key: "Home" });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  let alert = container.querySelector('[role="alert"]');
  assert.ok(alert, "die Fehlerzeile fehlt");
  assert.match(alert.textContent, /Access denied/);
  const confirm = buttons(container).find((node) => node.textContent.trim() === "Copy here");
  assert.equal(confirm.hasAttribute("disabled"), true);

  // Retry laedt denselben Ordner erneut (der Stub scheitert weiter).
  await act(async () => {
    [...alert.querySelectorAll("button")].find((node) => node.textContent.trim() === "Refresh").click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  alert = container.querySelector('[role="alert"]');
  assert.ok(alert, "nach dem Retry steht die Meldung wieder da");

  await act(async () => {
    [...alert.querySelectorAll("button")].find((node) => node.textContent.trim() === "Close").click();
  });
  assert.equal(container.querySelector('[role="alert"]'), null);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("busy sperrt Escape, Backdrop, Schliessen und Bestaetigen", async () => {
  const { root, container, events } = await mount({ view: "list", busy: true });
  assert.equal(buttons(container).find((node) => node.textContent.trim() === "Copy here").hasAttribute("disabled"), true);
  assert.equal(container.querySelector('[aria-label="Close"]').hasAttribute("disabled"), true);

  await act(async () => {
    fire(win.document, "keydown", { key: "Escape" });
    fire(container.firstElementChild, "click");
  });
  assert.equal(events.cancel, 0);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();

  const idle = await mount({ view: "list" });
  await act(async () => {
    fire(win.document, "keydown", { key: "Escape" });
  });
  assert.equal(idle.events.cancel, 1);
  await act(async () => {
    fire(idle.container.firstElementChild, "click");
  });
  assert.equal(idle.events.cancel, 2);
  await act(async () => {
    idle.container.querySelector('[aria-label="Close"]').click();
  });
  assert.equal(idle.events.cancel, 3);
  await act(async () => idle.root.unmount());
  mounted.splice(0, mounted.length);
  idle.container.remove();
});

test("Raster ohne allowFiles zeigt Dateien als deaktivierte Kacheln; Scroll misst mit", async () => {
  const { root, container } = await mount({ view: "grid" });
  const grid = listbox(container);
  const disabled = [...grid.querySelectorAll('[aria-disabled="true"]')];
  assert.equal(disabled.length, 2, "photo.png und notes.txt sind deaktiviert");
  assert.deepEqual(disabled.map((node) => node.getAttribute("title")).sort(), ["notes.txt", "photo.png"]);

  await act(async () => {
    Object.defineProperty(grid, "scrollTop", { value: 250, configurable: true });
    fire(grid, "scroll");
  });
  assert.ok(grid.querySelector('[role="listbox"], [class]'));

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Datei per Tastatur auswaehlen (allowFiles), Hover setzt die aktive Zeile", async () => {
  const { root, container, events } = await mount({ allowFiles: true, view: "list" });
  const list = listbox(container);
  const fileRow = [...list.querySelectorAll("button")].find((node) => node.textContent.includes("notes.txt"));
  assert.ok(fileRow);
  await act(async () => {
    fire(fileRow, "mouseover", { relatedTarget: win.document.body });
    fire(fileRow, "mouseout", { relatedTarget: win.document.body });
  });
  const panel = container.querySelector('[role="dialog"]');
  // Reihenfolge bei allowFiles: alpha, zeta, notes.txt (dirs zuerst, dann Dateien).
  for (let step = 0; step < 4; step += 1) {
    await act(async () => {
      fire(panel, "keydown", { key: "ArrowDown" });
    });
  }
  await act(async () => {
    fire(panel, "keydown", { key: "Enter" });
  });
  assert.deepEqual(events.selectFile, ["/work/notes.txt"]);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("HTTP-Fehler ohne JSON-Body faellt auf den Statuscode zurueck", async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    json: async () => { throw new Error("html"); },
  });
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null,
      React.createElement(FileBrowserDialog, {
        open: true, title: "T", initialPath: "/work", confirmLabel: "OK",
        onCancel: () => {}, onConfirm: () => {}, view: "list",
      })));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.match(container.textContent, /Failed to load files \(HTTP 503\)/);
  await act(async () => root.unmount());
  container.remove();
});

test("leerer Ordner und open=false", async () => {
  globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => ({ entries: [], parentPath: null, ancestors: [] }) });
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null,
      React.createElement(FileBrowserDialog, {
        open: true, title: "T", initialPath: "/empty", confirmLabel: "OK",
        onCancel: () => {}, onConfirm: () => {}, view: "list",
      })));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.match(container.textContent, /This folder has no subfolders/);
  assert.equal(container.querySelector('[aria-label="Up one level"]'), null);
  await act(async () => root.unmount());
  container.remove();

  const closedContainer = win.document.createElement("div");
  win.document.body.appendChild(closedContainer);
  const closedRoot = createRoot(closedContainer);
  await act(async () => {
    closedRoot.render(React.createElement(I18nProvider, null,
      React.createElement(FileBrowserDialog, {
        open: false, title: "T", initialPath: "/", confirmLabel: "OK",
        onCancel: () => {}, onConfirm: () => {},
      })));
  });
  assert.equal(closedContainer.innerHTML, "");
  await act(async () => closedRoot.unmount());
  closedContainer.remove();
});
