import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

/**
 * FileContextMenu: Radix-Kontextmenue plus eigene Formularschritte. Geprueft
 * werden die Menueeintraege je Zielart, Rename/Mkdir/Delete gegen die echte
 * /api/file-actions-Antwort, Fehlertexte aus `error`+`reason`, Copy/Move ueber
 * den Dialog, der Toast und die Schliesswege (Viewport, Escape, Pointerdown).
 */

const ROOT = process.cwd();
const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
restoreLinkedomPrototypesOnExit(win);

const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };
const storage = new Map();
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => void storage.set(key, String(value)),
  removeItem: (key) => void storage.delete(key),
};
const computed = () => new Proxy({}, {
  get: (_target, prop) => (typeof prop === "string" && prop.startsWith("get") ? () => "" : "0px"),
});
win.getComputedStyle = computed;
win.matchMedia = () => ({
  matches: false,
  media: "",
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
});
win.document.hasFocus = () => true;

class SimpleDOMRect {
  constructor(x = 0, y = 0, width = 0, height = 0) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }
  get left() { return this.x; }
  get top() { return this.y; }
  get right() { return this.x + this.width; }
  get bottom() { return this.y + this.height; }
  static fromRect(rect = {}) {
    return new SimpleDOMRect(rect.x ?? 0, rect.y ?? 0, rect.width ?? 0, rect.height ?? 0);
  }
}
class SimpleMouseEvent extends win.Event {
  constructor(type, init = {}) {
    super(type, init);
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
    this.button = init.button ?? 0;
    this.buttons = init.buttons ?? 0;
    this.relatedTarget = init.relatedTarget ?? null;
  }
}
class SimpleKeyboardEvent extends win.Event {
  constructor(type, init = {}) {
    super(type, init);
    this.key = init.key ?? "";
  }
}
class SimplePointerEvent extends SimpleMouseEvent {}
globalThis.DOMRect = SimpleDOMRect;
win.DOMRect = SimpleDOMRect;
globalThis.MouseEvent = SimpleMouseEvent;
globalThis.KeyboardEvent = SimpleKeyboardEvent;
globalThis.PointerEvent = SimplePointerEvent;

win.Element.prototype.getBoundingClientRect = function rect() {
  return { top: 40, left: 40, right: 240, bottom: 74, width: 200, height: 34, x: 40, y: 40 };
};
win.Element.prototype.scrollIntoView = function scrollIntoView() {};
for (const proto of [win.HTMLInputElement?.prototype, win.HTMLTextAreaElement?.prototype]) {
  if (!proto) continue;
  let start = 0;
  let end = 0;
  Object.defineProperty(proto, "selectionStart", { get: () => start, configurable: true });
  Object.defineProperty(proto, "selectionEnd", { get: () => end, configurable: true });
  proto.setSelectionRange = function setSelectionRange(nextStart, nextEnd) {
    const max = String(this.value ?? "").length;
    start = Math.min(Math.max(0, nextStart), max);
    end = Math.min(Math.max(start, nextEnd), max);
  };
  proto.select = function select() {
    this.setSelectionRange(0, String(this.value ?? "").length);
  };
  proto.attachEvent = function attachEvent() {};
  proto.detachEvent = function detachEvent() {};
}

let activeElement = win.document.body;
Object.defineProperty(win.document, "activeElement", { get: () => activeElement, configurable: true });
win.HTMLElement.prototype.focus = function focus() {
  const tag = this.tagName;
  if (tag !== "BUTTON" && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "A" && !this.hasAttribute("tabindex")) return;
  activeElement = this;
};

const ORIGINALS = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
  localStorage: globalThis.localStorage,
  fetch: globalThis.fetch,
  getComputedStyle: globalThis.getComputedStyle,
  matchMedia: globalThis.matchMedia,
  DOMRect: globalThis.DOMRect,
  MouseEvent: globalThis.MouseEvent,
  KeyboardEvent: globalThis.KeyboardEvent,
  PointerEvent: globalThis.PointerEvent,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
};

win.innerWidth = 1200;
win.innerHeight = 800;
win.localStorage = localStorage;
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
globalThis.getComputedStyle = computed;
globalThis.matchMedia = win.matchMedia;
for (const [name, value] of Object.entries(linkedom)) {
  if (name === "parseHTML" || name === "default") continue;
  if (typeof value === "function" && /^[A-Z]/.test(name)) globalThis[name] = value;
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;

const mounted = [];
test.after(async () => {
  for (const { root } of mounted.splice(0)) {
    await act(async () => root.unmount());
  }
  win.document.body.innerHTML = "";
  for (const key of ["window", "document", "navigator", "localStorage", "fetch", "getComputedStyle", "matchMedia", "DOMRect", "MouseEvent", "KeyboardEvent", "PointerEvent", "IS_REACT_ACT_ENVIRONMENT"]) {
    if (ORIGINALS[key] === undefined) delete globalThis[key];
    else globalThis[key] = ORIGINALS[key];
  }
});

const jiti = createJiti(`${ROOT}/package.json`, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { I18nProvider } = await jiti.import(`${ROOT}/hooks/useI18n.tsx`);
const { FileContextMenu, FileActionToast } = await jiti.import(`${ROOT}/components/FileContextMenu.tsx`);

const FILE_TARGET = { x: 120, y: 90, path: "/work/notes.txt", name: "notes.txt", isDir: false };
const IMAGE_TARGET = { x: 120, y: 90, path: "/work/pic.png", name: "pic.png", isDir: false };
const DIR_TARGET = { x: 120, y: 90, path: "/work/folder", name: "folder", isDir: true };

function fire(target, type, props = {}) {
  const event = new SimpleMouseEvent(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(event, key, { value, configurable: true });
  }
  target.dispatchEvent(event);
  return event;
}

function itemByText(text) {
  return [...win.document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.includes(text));
}

async function typeInto(input, value) {
  input.setAttribute("type", "text");
  fire(input, "focusin");
  const descriptor = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value");
  descriptor.set.call(input, value);
  fire(input, "keydown", { key: "a" });
  fire(input, "input");
}

async function mount({ target, onOpenImage, fetchImpl, clipboard } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return fetchImpl(String(url), options);
  };
  if (clipboard !== undefined) {
    fakeNavigator.clipboard = clipboard;
  } else {
    delete fakeNavigator.clipboard;
  }
  win.document.body.innerHTML = "";
  activeElement = win.document.body;
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  const notices = [];
  const events = { closed: 0, mutated: 0 };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    root.render(React.createElement(I18nProvider, null,
      React.createElement(FileContextMenu, {
        target,
        onClose: () => { events.closed += 1; },
        onMutated: () => { events.mutated += 1; },
        onNotify: (notice) => notices.push(notice),
        onOpenImage,
      })));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  mounted.push({ root });
  return { root, container, calls, notices, events };
}

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test("Datei-Menue: Rename laedt den Namen vor und POSTet genau ein Segment", async () => {
  const { root, calls, notices, events } = await mount({
    target: FILE_TARGET,
    fetchImpl: async () => jsonResponse(200, { ok: true }),
  });

  assert.equal(win.document.querySelectorAll('[role="menuitem"]').length, 3, "Copy path, Rename, Delete");
  const rename = itemByText("Rename…");
  assert.ok(rename);
  await act(async () => {
    rename.click();
  });

  const input = win.document.querySelector('[role="dialog"] input');
  assert.ok(input, "das Namensfeld fehlt");
  assert.equal(input.value, "notes.txt");
  await act(async () => {
    await typeInto(input, "notes-neu.txt");
  });

  await act(async () => {
    fire(win.document.querySelector('[role="dialog"] form'), "submit");
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  const post = calls.find((call) => call.options.method === "POST");
  assert.equal(post.url, "/api/file-actions/work/notes.txt?type=rename");
  assert.deepEqual(JSON.parse(post.options.body), { name: "notes-neu.txt" });
  assert.equal(events.closed >= 1, true);
  assert.equal(events.mutated, 1);
  assert.deepEqual(notices, [{ kind: "success", text: "Renamed to notes-neu.txt" }]);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";
});

test("ungueltiger Name kommt ohne Anfrage als Fehlerhinweis", async () => {
  const { root, calls, notices } = await mount({
    target: FILE_TARGET,
    fetchImpl: async () => jsonResponse(200, { ok: true }),
  });
  await act(async () => {
    itemByText("Rename…").click();
  });
  const input = win.document.querySelector('[role="dialog"] input');
  await act(async () => {
    await typeInto(input, "../boese");
  });
  await act(async () => {
    fire(win.document.querySelector('[role="dialog"] form'), "submit");
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  assert.deepEqual(notices, [{ kind: "error", text: "Enter a single name without slashes" }]);
  assert.equal(calls.filter((call) => call.options.method === "POST").length, 0);
  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";
});

test("Ordner-Menue hat New folder und Copy/Move, mkdir POSTet den Namen", async () => {
  const { root, calls, notices } = await mount({
    target: DIR_TARGET,
    fetchImpl: async () => jsonResponse(200, { ok: true }),
  });
  assert.equal(win.document.querySelectorAll('[role="menuitem"]').length, 5);
  const labels = [...win.document.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent.trim());
  assert.deepEqual(labels, ["New folder…", "Rename…", "Copy to…", "Move to…", "Delete"]);

  await act(async () => {
    itemByText("New folder…").click();
  });
  const input = win.document.querySelector('[role="dialog"] input');
  assert.equal(input.value, "");

  await act(async () => {
    await typeInto(input, "neu");
  });
  await act(async () => {
    fire(win.document.querySelector('[role="dialog"] form'), "submit");
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const post = calls.find((call) => call.options.method === "POST");
  assert.equal(post.url, "/api/file-actions/work/folder?type=mkdir");
  assert.deepEqual(JSON.parse(post.options.body), { name: "neu" });
  assert.deepEqual(notices, [{ kind: "success", text: "Folder neu created" }]);
  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";
});

test("Delete bestaetigt und meldet error+reason vollstaendig", async () => {
  const { root, calls, notices } = await mount({
    target: FILE_TARGET,
    fetchImpl: async () => jsonResponse(403, { error: "Permission denied", reason: "read-only" }),
  });
  await act(async () => {
    itemByText("Delete").click();
  });
  const dialog = win.document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.match(dialog.textContent, /Delete notes.txt\\?/);

  const confirm = [...dialog.querySelectorAll("button")].find((node) => node.textContent.trim() === "Delete");
  await act(async () => {
    confirm.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const del = calls.find((call) => call.options.method === "DELETE");
  assert.equal(del.url, "/api/file-actions/work/notes.txt");
  assert.deepEqual(notices, [{ kind: "error", text: "Permission denied (read-only)" }]);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";
});

test("Delete eines Ordners nennt die rekursive Warnung; JSON-Fehler faellt auf HTTP zurueck", async () => {
  const { root, notices } = await mount({
    target: DIR_TARGET,
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      json: async () => { throw new Error("html"); },
    }),
  });
  await act(async () => {
    itemByText("Delete").click();
  });
  assert.match(win.document.querySelector('[role="dialog"]').textContent, /deletes everything inside/i);
  const confirm = [...win.document.querySelectorAll('[role="dialog"] button')].find((node) => node.textContent.trim() === "Delete");
  await act(async () => {
    confirm.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.deepEqual(notices, [{ kind: "error", text: "HTTP 500" }]);
  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";
});

test("Copy path schreibt in die Clipboard-API, Vorschau oeffnet das Bild ohne Schliessen", async () => {
  const written = [];
  const opened = [];
  const { root, notices, events } = await mount({
    target: IMAGE_TARGET,
    fetchImpl: async () => jsonResponse(200, { ok: true }),
    clipboard: { writeText: async (text) => { written.push(text); } },
    onOpenImage: (path, name) => opened.push([path, name]),
  });
  assert.equal(win.document.querySelectorAll('[role="menuitem"]').length, 4, "Preview, Copy path, Rename, Delete");

  await act(async () => {
    itemByText("Preview").click();
  });
  assert.deepEqual(opened, [["/work/pic.png", "pic.png"]]);
  assert.equal(events.closed, 0, "die Vorschau laesst das Menue offen");

  await act(async () => {
    itemByText("Copy path").click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  assert.deepEqual(written, ["/work/pic.png"]);
  assert.deepEqual(notices, [{ kind: "success", text: "Path copied to the clipboard" }]);
  assert.equal(events.closed, 1);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";
});

test("Clipboard-Fehler wird als Fehlerhinweis gemeldet", async () => {
  const { root, notices } = await mount({
    target: FILE_TARGET,
    fetchImpl: async () => jsonResponse(200, { ok: true }),
    clipboard: { writeText: async () => { throw new Error("denied"); } },
  });
  await act(async () => {
    itemByText("Copy path").click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  assert.deepEqual(notices, [{ kind: "error", text: "Could not write to the clipboard" }]);
  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";
});

test("Copy to oeffnet den Ziel-Dialog und bestaetigt mit destination", async () => {
  const { root, calls, notices } = await mount({
    target: DIR_TARGET,
    fetchImpl: async (url, options = {}) => {
      if (options.method === "POST") return jsonResponse(200, { ok: true });
      return jsonResponse(200, { path: "/work", parentPath: "/", directories: [], files: [] });
    },
  });
  await act(async () => {
    itemByText("Copy to…").click();
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

  const dialog = win.document.querySelector('[data-slot="dialog-content"]') ?? win.document.querySelector('[role="dialog"]');
  assert.ok(dialog, "der Ziel-Dialog fehlt");
  assert.match(dialog.textContent, /Copy folder/);

  const confirm = [...dialog.querySelectorAll("button")].find((node) => /Copy here/.test(node.textContent));
  assert.ok(confirm);
  await act(async () => {
    confirm.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  const post = calls.find((call) => call.options.method === "POST");
  assert.equal(post.url, "/api/file-actions/work/folder?type=copy");
  assert.deepEqual(JSON.parse(post.options.body), { destination: "/work" });
  assert.deepEqual(notices, [{ kind: "success", text: "Copied to /work" }]);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";
});

test("Formularschritt: Escape zurueck zur Liste, Pointerdown und Escape aussen schliessen", async () => {
  const { root, events } = await mount({
    target: FILE_TARGET,
    fetchImpl: async () => jsonResponse(200, { ok: true }),
  });
  await act(async () => {
    itemByText("Rename…").click();
  });
  assert.ok(win.document.querySelector('[role="dialog"]'));

  // Escape im Panel: zurueck zur Liste.
  await act(async () => {
    fire(win.document.querySelector('[role="dialog"]'), "keydown", { key: "Escape" });
  });
  assert.equal(win.document.querySelector('[role="dialog"]'), null);
  assert.ok(win.document.querySelector('[role="menuitem"]'), "die Liste ist wieder da");
  assert.equal(events.closed, 0);

  await act(async () => {
    itemByText("Rename…").click();
  });
  await act(async () => {
    fire(win.document.body, "pointerdown");
  });
  assert.equal(events.closed, 1);

  await act(async () => {
    fire(win.window, "resize");
    fire(win.window, "scroll");
  });
  assert.equal(events.closed >= 2, true);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";
});

test("Move to: Titel, Erfolgstext, und ein Netzfehler meldet die Exception", async () => {
  const { root, calls, notices } = await mount({
    target: DIR_TARGET,
    fetchImpl: async (url, options = {}) => {
      if (options.method === "POST") throw new Error("network down");
      return jsonResponse(200, { path: "/work", parentPath: "/", directories: [], files: [] });
    },
  });
  await act(async () => {
    itemByText("Move to…").click();
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  const dialog = win.document.querySelector('[data-slot="dialog-content"]') ?? win.document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.match(dialog.textContent, /Move folder/);
  assert.match(dialog.textContent, /Move here/);

  const confirm = [...dialog.querySelectorAll("button")].find((node) => /Move here/.test(node.textContent));
  await act(async () => {
    confirm.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const post = calls.find((call) => call.options.method === "POST");
  assert.equal(post.url, "/api/file-actions/work/folder?type=move");
  assert.deepEqual(notices, [{ kind: "error", text: "network down" }]);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";
});

test("Move to ohne Netzfehler meldet den Zielpfad", async () => {
  const { root, notices } = await mount({
    target: DIR_TARGET,
    fetchImpl: async (url, options = {}) => {
      if (options.method === "POST") return jsonResponse(200, { ok: true });
      return jsonResponse(200, { path: "/work", parentPath: "/", directories: [], files: [] });
    },
  });
  await act(async () => {
    itemByText("Move to…").click();
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  const dialog = win.document.querySelector('[data-slot="dialog-content"]') ?? win.document.querySelector('[role="dialog"]');
  const confirm = [...dialog.querySelectorAll("button")].find((node) => /Move here/.test(node.textContent));
  await act(async () => {
    confirm.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.deepEqual(notices, [{ kind: "success", text: "Moved to /work" }]);
  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";
});

test("DELETE mit 200 meldet den Dateinamen als geloescht", async () => {
  const { root, notices, events } = await mount({
    target: FILE_TARGET,
    fetchImpl: async () => jsonResponse(200, {}),
  });
  await act(async () => {
    itemByText("Delete").click();
  });
  const confirm = [...win.document.querySelectorAll('[role="dialog"] button')].find((node) => node.textContent.trim() === "Delete");
  await act(async () => {
    confirm.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.deepEqual(notices, [{ kind: "success", text: "notes.txt deleted" }]);
  assert.equal(events.mutated, 1);
  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";
});

test("DELETE mit HTML-Antwort faellt auf HTTP-Status zurueck", async () => {
  const { root, notices } = await mount({
    target: FILE_TARGET,
    fetchImpl: async () => ({
      ok: false,
      status: 409,
      json: async () => { throw new Error("html"); },
    }),
  });
  await act(async () => {
    itemByText("Delete").click();
  });
  const confirm = [...win.document.querySelectorAll('[role="dialog"] button')].find((node) => node.textContent.trim() === "Delete");
  await act(async () => {
    confirm.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.deepEqual(notices, [{ kind: "error", text: "HTTP 409" }]);
  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";
});

test("Netzfehler bei Rename und Delete werden als Fehlerhinweis gemeldet", async () => {
  const { root, notices } = await mount({
    target: FILE_TARGET,
    fetchImpl: async () => { throw new Error("offline"); },
  });
  await act(async () => {
    itemByText("Rename…").click();
  });
  await act(async () => {
    fire(win.document.querySelector('[role="dialog"] form'), "submit");
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.deepEqual(notices, [{ kind: "error", text: "offline" }]);
  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";

  const second = await mount({
    target: FILE_TARGET,
    fetchImpl: async () => { throw new Error("offline"); },
  });
  await act(async () => {
    itemByText("Delete").click();
  });
  const confirm = [...win.document.querySelectorAll('[role="dialog"] button')].find((node) => node.textContent.trim() === "Delete");
  await act(async () => {
    confirm.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.deepEqual(second.notices, [{ kind: "error", text: "offline" }]);
  await act(async () => second.root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";
});

test("waehrend des Transfers schluckt das Menue Escape und Pointerdown daneben", async () => {
  let cancels = 0;
  const { root, events } = await mount({
    target: DIR_TARGET,
    fetchImpl: async () => jsonResponse(200, { path: "/work", parentPath: "/", directories: [], files: [] }),
  });
  await act(async () => {
    itemByText("Copy to…").click();
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  const dialog = win.document.querySelector('[data-slot="dialog-content"]') ?? win.document.querySelector('[role="dialog"]');
  assert.ok(dialog);

  await act(async () => {
    fire(win.document, "keydown", { key: "Escape" });
    fire(win.document.body, "pointerdown");
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  // Das Menue bleibt offen, der Dialog entscheidet selbst.
  assert.equal(events.closed, 0);

  const cancel = [...dialog.querySelectorAll("button")].find((node) => node.textContent.trim() === "Cancel");
  assert.ok(cancel);
  await act(async () => {
    cancel.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(win.document.querySelector('[data-slot="dialog-content"]'), null);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";
});

test("Escape in der Liste und ein Kontextmenue auf dem Panel schliessen/verhindern", async () => {
  const { root, events } = await mount({
    target: FILE_TARGET,
    fetchImpl: async () => jsonResponse(200, { ok: true }),
  });
  const menu = win.document.querySelector('[role="menu"]');
  assert.ok(menu);
  await act(async () => {
    fire(menu, "contextmenu");
  });

  await act(async () => {
    fire(win.document, "keydown", { key: "Escape" });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(events.closed, 1);

  // Rename oeffnen und mit dem Abbrechen-Knopf zurueck zur Liste.
  await act(async () => {
    itemByText("Rename…").click();
  });
  const cancel = [...win.document.querySelectorAll('[role="dialog"] button')].find((node) => node.textContent.trim() === "Cancel");
  await act(async () => {
    cancel.click();
  });
  assert.equal(win.document.querySelector('[role="dialog"]'), null);
  assert.ok(win.document.querySelector('[role="menuitem"]'));

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";
});

test("Abbrechen in New folder und Delete, Kontextmenue auf dem Formularpanel", async () => {
  const { root } = await mount({
    target: DIR_TARGET,
    fetchImpl: async () => jsonResponse(200, { ok: true }),
  });
  await act(async () => {
    itemByText("New folder…").click();
  });
  let dialog = win.document.querySelector('[role="dialog"]');
  await act(async () => {
    fire(dialog, "contextmenu");
  });
  let cancel = [...dialog.querySelectorAll("button")].find((node) => node.textContent.trim() === "Cancel");
  await act(async () => {
    cancel.click();
  });

  await act(async () => {
    itemByText("Delete").click();
  });
  dialog = win.document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  cancel = [...dialog.querySelectorAll("button")].find((node) => node.textContent.trim() === "Cancel");
  await act(async () => {
    cancel.click();
  });
  assert.equal(win.document.querySelector('[role="dialog"]'), null);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";
});

test("FileActionToast meldet Erfolg als status und Fehler als alert und laesst sich schliessen", async () => {
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  let dismissed = 0;
  await act(async () => {
    root.render(React.createElement(I18nProvider, null,
      React.createElement(FileActionToast, { notice: { kind: "success", text: "fertig" }, onDismiss: () => { dismissed += 1; } })));
  });
  let toast = win.document.querySelector('[role="status"]');
  assert.ok(toast);
  assert.match(toast.textContent, /fertig/);
  await act(async () => {
    toast.querySelector("button").click();
  });
  assert.equal(dismissed, 1);

  await act(async () => {
    root.render(React.createElement(I18nProvider, null,
      React.createElement(FileActionToast, { notice: { kind: "error", text: "kaputt" }, onDismiss: () => {} })));
  });
  toast = win.document.querySelector('[role="alert"]');
  assert.ok(toast);
  assert.match(toast.textContent, /kaputt/);
  assert.equal(toast.getAttribute("aria-live"), "assertive");

  await act(async () => root.unmount());
  container.remove();
});
