import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

/**
 * DirectoryPicker (Radix-Dialog): Verzeichnisliste, Laufwerke, Pfadfeld,
 * Fehlerzustand und die Busy-Sperre gegen Escape/Klick daneben. Radix portalt
 * nach `document.body`; gesucht wird deshalb im Dokument, nicht im Container.
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

let activeElement = win.document.body;
Object.defineProperty(win.document, "activeElement", { get: () => activeElement, configurable: true });
/** Eigener Setter statt `activeElement = this`: `no-this-alias` verbietet das. */
function setActive(element) {
  activeElement = element;
}
win.HTMLElement.prototype.focus = function focus() {
  const tag = this.tagName;
  if (tag !== "BUTTON" && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "A" && !this.hasAttribute("tabindex")) return;
  setActive(this);
};

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
  // React (canUseDOM:false beim Import) nutzt den Legacy-Input-Pfad.
  proto.attachEvent = function attachEvent() {};
  proto.detachEvent = function detachEvent() {};
}

const ORIGINALS = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
  localStorage: globalThis.localStorage,
  fetch: globalThis.fetch,
  getComputedStyle: globalThis.getComputedStyle,
  matchMedia: globalThis.matchMedia,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
};

win.innerWidth = 1200;
win.innerHeight = 800;
win.localStorage = localStorage;
win.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {} });
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
  for (const key of ["window", "document", "navigator", "localStorage", "fetch", "getComputedStyle", "matchMedia", "IS_REACT_ACT_ENVIRONMENT"]) {
    if (ORIGINALS[key] === undefined) delete globalThis[key];
    else globalThis[key] = ORIGINALS[key];
  }
});

const jiti = createJiti(`${ROOT}/package.json`, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { I18nProvider } = await jiti.import(`${ROOT}/hooks/useI18n.tsx`);
const { DirectoryPicker } = await jiti.import(`${ROOT}/components/DirectoryPicker.tsx`);

function fire(target, type, props = {}) {
  const event = new win.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(event, key, { value, configurable: true });
  }
  target.dispatchEvent(event);
  return event;
}

async function typePath(input, value) {
  fire(input, "focusin", {});
  const descriptor = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value");
  descriptor.set.call(input, value);
  fire(input, "keydown", { key: "a" });
  fire(input, "input", {});
}

async function mount({ fetchImpl, onCancel = () => {}, onSelect = () => {}, busy = false, error = null } = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return fetchImpl(String(url), calls.length);
  };
  win.document.body.innerHTML = "";
  activeElement = win.document.body;
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    root.render(
      React.createElement(I18nProvider, null,
        React.createElement(DirectoryPicker, { onCancel, onSelect, busy, error })),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  mounted.push({ root });
  return { root, calls };
}

const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });

const BUTTON = (label, root = win.document) => [...root.querySelectorAll("button")].find((node) => node.textContent.trim() === label);

test("zeigt Verzeichnisse, navigiert hinein und wieder herauf und liefert den Pfad", async () => {
  const selected = [];
  const { root, calls } = await mount({
    onSelect: (path) => selected.push(path),
    fetchImpl: async (url) => {
      const pages = {
        "/api/cwd/browse": { path: "/home/user", parentPath: "/home", directories: [{ name: "project", path: "/home/user/project" }], drives: null },
        "/api/cwd/browse?path=%2Fhome%2Fuser%2Fproject": { path: "/home/user/project", parentPath: "/home/user", directories: [], drives: null },
        "/api/cwd/browse?path=%2Fhome%2Fuser": { path: "/home/user", parentPath: "/home", directories: [], drives: null },
        "/api/cwd/browse?path=%2Fhome": { path: "/home", parentPath: "/", directories: [], drives: null },
      };
      return { ok: true, status: 200, json: async () => pages[url] ?? pages["/api/cwd/browse"] };
    },
  });

  assert.equal(calls[0], "/api/cwd/browse");
  const pathInput = win.document.querySelector(".directory-picker-path");
  assert.equal(pathInput.value, "/home/user");
  assert.ok(win.document.querySelector(".directory-picker-entry"), "der Ordner-Eintrag fehlt");
  assert.match(win.document.querySelector(".directory-picker-entry").textContent, /project/);

  const select = BUTTON("Select this folder");
  assert.ok(select);
  assert.equal(select.hasAttribute("disabled"), false);
  select.click();
  assert.deepEqual(selected, ["/home/user"]);

  // In den Ordner hinein.
  win.document.querySelector(".directory-picker-entry").click();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls[1], "/api/cwd/browse?path=%2Fhome%2Fuser%2Fproject");
  assert.equal(pathInput.value, "/home/user/project");

  // Eine Ebene hoch ueber den Pfeil: parentPath des Projektordners ist /home/user.
  const back = win.document.querySelector(".directory-picker-back");
  assert.equal(back.hasAttribute("disabled"), false);
  back.click();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  assert.equal(calls[2], "/api/cwd/browse?path=%2Fhome%2Fuser");
  assert.equal(win.document.querySelector(".directory-picker-path").value, "/home/user");

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";
});

test("Wegfeld: Enter im Formular navigiert, ungueltiger Pfad zeigt den Fehler", async () => {
  const { root, calls } = await mount({
    fetchImpl: async (url) => {
      if (url.includes("path=%2Fdoes-not-exist")) {
        return { ok: false, status: 404, json: async () => ({ error: "Not a directory" }) };
      }
      return { ok: true, status: 200, json: async () => ({ path: "/start", parentPath: "/", directories: [], drives: null }) };
    },
  });

  const input = win.document.querySelector(".directory-picker-path");
  await act(async () => {
    await typePath(input, "/does-not-exist");
  });
  assert.equal(input.value, "/does-not-exist");

  // Solange der getippte Pfad nicht bestaetigt ist, sperrt der Select-Knopf.
  assert.equal(BUTTON("Select this folder").hasAttribute("disabled"), true);

  const form = win.document.querySelector("form");
  await act(async () => {
    fire(form, "submit");
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls[1], "/api/cwd/browse?path=%2Fdoes-not-exist");
  assert.match(win.document.body.textContent, /Not a directory/);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";
});

test("Laufwerke erscheinen als eigene Liste; leere Liste meldet no drives", async () => {
  const { root, calls } = await mount({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ path: "C:\\", parentPath: null, directories: [], drives: [{ name: "C:", path: "C:\\" }] }) }),
  });
  assert.match(win.document.body.textContent, /C:/);
  assert.equal(win.document.querySelectorAll(".directory-picker-entry").length, 1);
  win.document.querySelector(".directory-picker-entry").click();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls[1], "/api/cwd/browse?path=C%3A%5C");
  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";

  const second = await mount({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ path: "C:\\", parentPath: null, directories: [], drives: [] }) }),
  });
  assert.match(win.document.body.textContent, /No drives found/);
  await act(async () => second.root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";
});

test("busy sperrt Escape und Klick daneben, danach schliesst Escape den Dialog", async () => {
  let cancels = 0;
  const { root } = await mount({
    busy: true,
    onCancel: () => { cancels += 1; },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ path: "/p", parentPath: "/", directories: [], drives: null }) }),
  });

  assert.equal(BUTTON("Checking...").hasAttribute("disabled"), true);
  assert.match(win.document.body.textContent, /Checking.../);

  await act(async () => {
    fire(win.document, "keydown", { key: "Escape" });
    fire(win.document.body, "pointerdown");
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(cancels, 0, "busy darf den Dialog nicht schliessen");

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";

  const second = await mount({
    busy: false,
    onCancel: () => { cancels += 1; },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ path: "/p", parentPath: "/", directories: [], drives: null }) }),
  });
  await act(async () => {
    fire(win.document, "keydown", { key: "Escape" });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(cancels, 1, "ohne busy schliesst Escape den Dialog");
  await act(async () => second.root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";
});

test("Fehler vom Aufrufer und der Abbrechen-Knopf rufen onCancel", async () => {
  let cancels = 0;
  const { root } = await mount({
    error: "Ordner vertrauenswuerdig?",
    onCancel: () => { cancels += 1; },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ path: "/p", parentPath: "/", directories: [], drives: null }) }),
  });
  assert.match(win.document.body.textContent, /Ordner vertrauenswuerdig/);

  const cancel = BUTTON("Cancel");
  assert.ok(cancel);
  cancel.click();
  assert.equal(cancels, 1);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  win.document.body.innerHTML = "";
});
