import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

/**
 * FileImagePreview: Laden/Fehler/Wiederholen, Zoom per Knopf, Rad und Tastatur,
 * Originalgroesse per Doppelklick, Panning ueber Pointer-Events, Zaehler,
 * Navigation und die drei Schliesswege. Die Buehne wird per ResizeObserver
 * gemessen, weil linkedom kein Layout hat.
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
class SimplePointerEvent extends win.Event {
  constructor(type, init = {}) {
    super(type, init);
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
    this.button = init.button ?? 0;
    this.pointerId = init.pointerId ?? 1;
    this.relatedTarget = init.relatedTarget ?? null;
  }
}

const observers = [];
class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback;
    observers.push(this);
  }
  observe() {}
  disconnect() {}
}
globalThis.ResizeObserver = FakeResizeObserver;
globalThis.PointerEvent = SimplePointerEvent;
globalThis.DOMRect = SimpleDOMRect;
win.DOMRect = SimpleDOMRect;

const ORIGINALS = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
  localStorage: globalThis.localStorage,
  ResizeObserver: globalThis.ResizeObserver,
  PointerEvent: globalThis.PointerEvent,
  DOMRect: globalThis.DOMRect,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  MutationObserver: globalThis.MutationObserver,
  IntersectionObserver: globalThis.IntersectionObserver,
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
win.Element.prototype.getBoundingClientRect = function rect() {
  return { top: 50, left: 50, right: 250, bottom: 150, width: 200, height: 100, x: 50, y: 50 };
};
win.Element.prototype.scrollIntoView = function scrollIntoView() {};
// `react-remove-scroll` (Radix) ruft `window.getSelection` beim Rad-Ereignis.
win.getSelection = () => null;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
globalThis.IntersectionObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };

// `linkedom` hat keinen Fokus; `activeElement` und `focus()` werden wie in
// `DialogFocus.test.mjs` nachgebaut. Das Primitiv braucht beides fuer Fokusfalle
// und Rueckgabe an den Ausloeser.
let activeElement = win.document.body;
const setActive = (element) => { activeElement = element; };
Object.defineProperty(win.document, "activeElement", {
  get: () => (activeElement.isConnected === false ? win.document.body : activeElement),
  configurable: true,
});
win.HTMLElement.prototype.focus = function focus() {
  const tag = this.tagName;
  const nativelyFocusable = tag === "BUTTON" || tag === "INPUT" || tag === "TEXTAREA" || tag === "A" || tag === "SELECT";
  if (!nativelyFocusable && !this.hasAttribute("tabindex")) return;
  setActive(this);
};

const mounted = [];
test.after(async () => {
  for (const { root } of mounted.splice(0)) {
    await act(async () => root.unmount());
  }
  win.document.body.innerHTML = "";
  for (const key of ["window", "document", "navigator", "localStorage", "ResizeObserver", "PointerEvent", "DOMRect", "IS_REACT_ACT_ENVIRONMENT", "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver", "IntersectionObserver"]) {
    if (ORIGINALS[key] === undefined) delete globalThis[key];
    else globalThis[key] = ORIGINALS[key];
  }
});

const jiti = createJiti(`${ROOT}/package.json`, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { I18nProvider } = await jiti.import(`${ROOT}/hooks/useI18n.tsx`);
const { FileImagePreview } = await jiti.import(`${ROOT}/components/FileImagePreview.tsx`);
const { Dialog, DialogContent } = await jiti.import(`${ROOT}/components/ui/dialog.tsx`);

function fire(target, type, props = {}) {
  const event = type === "pointerdown" || type === "pointermove" || type === "pointerup" || type === "pointercancel"
    ? new SimplePointerEvent(type, { bubbles: true, cancelable: true })
    : new win.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(event, key, { value, configurable: true });
  }
  target.dispatchEvent(event);
  return event;
}

async function mount(props = {}, prepare) {
  observers.length = 0;
  win.document.body.innerHTML = "";
  activeElement = win.document.body;
  prepare?.();
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  const calls = { close: 0, next: 0, prev: 0 };
  const render = (next = {}) => act(async () => {
    root.render(React.createElement(I18nProvider, null,
      React.createElement(FileImagePreview, {
        open: true,
        filePath: "/work/pic.png",
        fileName: "pic.png",
        onClose: () => { calls.close += 1; },
        ...props,
        ...next,
      })));
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await render();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  mounted.push({ root });
  return { root, container, calls, render };
}

function image() {
  return win.document.querySelector("img");
}

async function loadImage(width = 4000, height = 3000) {
  const img = image();
  Object.defineProperty(img, "naturalWidth", { value: width, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: height, configurable: true });
  await act(async () => {
    img.dispatchEvent(new win.Event("load"));
  });
  await act(async () => {
    observers.at(-1)?.callback([{ contentRect: { width: 800, height: 600 } }]);
  });
}

const zoomText = () => win.document.querySelector('[aria-live="polite"]').textContent;

test("laedt das Bild, zeigt Zaehler und Temperatur der Zoomstufe", async () => {
  const { root, container, calls } = await mount({ currentIndex: 2, total: 3, onNext: () => { calls.next += 1; }, onPrev: () => { calls.prev += 1; } });

  const img = image();
  assert.ok(img, "das img fehlt");
  assert.equal(img.getAttribute("src"), "/api/files/work/pic.png?type=read");
  assert.equal(img.getAttribute("data-loaded"), "false");
  assert.equal(img.getAttribute("draggable"), "false");
  assert.ok(win.document.querySelector('[role="dialog"]').getAttribute("aria-labelledby").length > 0);
  assert.match(win.document.body.textContent, /2 of 3/);
  assert.match(win.document.body.textContent, /Loading image/);

  await act(async () => {
    img.dispatchEvent(new win.Event("error"));
  });
  assert.match(win.document.body.textContent, /This image could not be opened/);
  assert.ok(win.document.querySelector('[role="alert"]'));

  const retry = [...win.document.querySelectorAll("button")].find((node) => node.textContent.trim() === "Refresh");
  await act(async () => {
    retry.click();
  });
  assert.equal(image().getAttribute("src"), "/api/files/work/pic.png?type=read&v=1");

  await loadImage();
  assert.equal(image().getAttribute("data-loaded"), "true");
  assert.match(zoomText(), /18%/);

  await act(async () => {
    win.document.querySelector('[aria-label="Next image"]').click();
  });
  assert.equal(calls.next, 1);
  await act(async () => {
    win.document.querySelector('[aria-label="Previous image"]').click();
  });
  assert.equal(calls.prev, 1);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Zoom per Knoepfen, Rad, Tastatur und Doppelklick mit Panning", async () => {
  const { root, container } = await mount({ currentIndex: 1, total: 1 });
  await loadImage();
  assert.match(zoomText(), /18%/);

  const zoomIn = win.document.querySelector('[aria-label="Zoom in"]');
  const zoomOut = win.document.querySelector('[aria-label="Zoom out"]');
  const stage = image().parentElement.parentElement;

  await act(async () => {
    zoomIn.click();
  });
  assert.match(zoomText(), /22%/);

  await act(async () => {
    zoomOut.click();
  });
  assert.match(zoomText(), /18%/);

  // Rad: deltaY < 0 vergroessert, > 0 verkleinert, preventDefault gesetzt.
  let wheel;
  await act(async () => {
    wheel = fire(stage, "wheel", { deltaY: -100, clientX: 100, clientY: 100 });
  });
  assert.equal(wheel.defaultPrevented, true);
  assert.match(zoomText(), /22%/);
  await act(async () => {
    fire(stage, "wheel", { deltaY: 100, clientX: 100, clientY: 100 });
  });
  assert.match(zoomText(), /18%/);

  // Tastatur: +, -, 0.
  await act(async () => {
    fire(win.document, "keydown", { key: "+" });
  });
  assert.match(zoomText(), /22%/);
  await act(async () => {
    fire(win.document, "keydown", { key: "-" });
  });
  assert.match(zoomText(), /18%/);
  await act(async () => {
    fire(win.document, "keydown", { key: "0" });
  });
  assert.match(zoomText(), /18%/);

  // Doppelklick auf die Buehne: Originalgroesse = 100 %, nochmal zurueck.
  await act(async () => {
    fire(stage, "dblclick");
  });
  assert.match(zoomText(), /100%/);
  await act(async () => {
    fire(stage, "dblclick");
  });
  assert.match(zoomText(), /18%/);

  // 100 % setzt canPan; Pointerdrag verschiebt den Transform.
  await act(async () => {
    fire(stage, "dblclick");
  });
  const frame = image().parentElement;
  const before = frame.getAttribute("style");
  await act(async () => {
    fire(stage, "pointerdown", { button: 0, clientX: 100, clientY: 100, pointerId: 7 });
    fire(stage, "pointermove", { clientX: 160, clientY: 130, pointerId: 7 });
    fire(stage, "pointerup", { clientX: 160, clientY: 130, pointerId: 7 });
  });
  assert.notEqual(frame.getAttribute("style"), before, "der Pan hat den Transform nicht veraendert");
  assert.match(frame.getAttribute("style"), /translate\(/);

  // Ein zweiter Move ohne Drag ist ein No-op; Pointerdown mit rechter Taste auch.
  await act(async () => {
    fire(stage, "pointermove", { clientX: 300, clientY: 300, pointerId: 7 });
    fire(stage, "pointerdown", { button: 2, clientX: 0, clientY: 0, pointerId: 7 });
  });

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Escape, Klick auf den Backdrop und der X-Knopf schliessen; Eingabefelder werden ignoriert", async () => {
  const { root, container, calls } = await mount();
  const backdrop = win.document.querySelector('[data-slot="dialog-overlay"]');
  assert.ok(backdrop, "der Dialoghintergrund fehlt");

  const input = win.document.createElement("input");
  win.document.body.appendChild(input);
  await act(async () => {
    fire(input, "keydown", { key: "Escape" });
  });
  assert.equal(calls.close, 0, "Escape in einem Eingabefeld darf nicht schliessen");

  await act(async () => {
    fire(win.document, "keydown", { key: "Escape" });
  });
  assert.equal(calls.close, 1);

  await act(async () => {
    // Radix schliesst den modalen Dialog verzoegert: `pointerdown` aussen
    // merkt sich den Druck, erst der folgende `click` schliesst. `linkedom`
    // loescht `event.target` nach dem Dispatch; Radix liest ihn aber erst
    // beim `click`, deshalb wird er hier wieder gesetzt.
    const down = fire(backdrop, "pointerdown", { button: 0 });
    Object.defineProperty(down, "target", { value: backdrop, configurable: true });
    fire(backdrop, "click");
  });
  assert.equal(calls.close, 2, "ein Druck auf den Hintergrund schliesst");

  await act(async () => {
    win.document.querySelector('[aria-label="Close"]').click();
  });
  assert.equal(calls.close, 3);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
  input.remove();
});

test("Tastatur-Pfeile navigieren nur mit Callbacks; open=false rendert nichts", async () => {
  const noNav = await mount();
  await act(async () => {
    fire(win.document, "keydown", { key: "ArrowRight" });
    fire(win.document, "keydown", { key: "ArrowLeft" });
  });
  assert.ok(win.document.querySelector('[role="dialog"]'), "ohne Callbacks bleibt die Vorschau offen");
  assert.equal(win.document.querySelector('[aria-label="Next image"]'), null);
  await act(async () => noNav.root.unmount());
  mounted.splice(0, mounted.length);
  noNav.container.remove();

  const nextCalls = { next: 0, prev: 0 };
  const withNav = await mount({ onNext: () => { nextCalls.next += 1; }, onPrev: () => { nextCalls.prev += 1; } });
  await act(async () => {
    fire(win.document, "keydown", { key: "ArrowRight" });
    fire(win.document, "keydown", { key: "ArrowLeft" });
  });
  assert.equal(nextCalls.next, 1);
  assert.equal(nextCalls.prev, 1);
  await act(async () => withNav.root.unmount());
  mounted.splice(0, mounted.length);
  withNav.container.remove();

  const closed = await mount({ open: false });
  assert.equal(win.document.querySelector('[data-slot="dialog-content"]'), null);
  await act(async () => closed.root.unmount());
  mounted.splice(0, mounted.length);
  closed.container.remove();
});

test("0x0-Bild gilt als geladen ohne Groesse, Zaehler fehlt bei einem Bild", async () => {
  const { root, container } = await mount({ currentIndex: 1, total: 1 });
  await loadImage(0, 0);
  assert.equal(image().getAttribute("data-loaded"), "true");
  assert.doesNotMatch(image().getAttribute("style") ?? "", /width:/);
  assert.doesNotMatch(win.document.body.textContent, /1 \/ 1/);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Der Fokus steht im Dialog und geht beim Schliessen an den Ausloeser zurueck", async () => {
  const trigger = win.document.createElement("button");
  trigger.textContent = "Open image";
  const { calls, render } = await mount({}, () => {
    win.document.body.appendChild(trigger);
    trigger.focus();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  const content = win.document.querySelector('[data-slot="dialog-content"]');
  assert.ok(content, "der Dialog fehlt");
  assert.ok(content.contains(win.document.activeElement), "der Fokus steht nicht im Dialog");
  assert.equal(win.document.querySelector('[role="dialog"]'), content);

  await act(async () => {
    fire(win.document, "keydown", { key: "Escape" });
  });
  assert.equal(calls.close, 1);
  await render({ open: false });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.equal(win.document.querySelector('[data-slot="dialog-content"]'), null);
  assert.equal(win.document.activeElement, trigger, "der Fokus ging nicht an den Ausloeser zurueck");
  trigger.remove();
});

test("Im grossen Fenster schliesst Escape nur die Vorschau, nicht das Fenster", async () => {
  win.document.body.innerHTML = "";
  activeElement = win.document.body;
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  const closes = { preview: 0, window: 0 };
  const render = (previewOpen) => act(async () => {
    root.render(React.createElement(I18nProvider, null,
      React.createElement(Dialog, { open: true, onOpenChange: (next) => { if (!next) closes.window += 1; } },
        React.createElement(DialogContent, { bare: true, showCloseButton: false },
          React.createElement(FileImagePreview, {
            open: previewOpen,
            filePath: "/work/pic.png",
            fileName: "pic.png",
            onClose: () => { closes.preview += 1; },
          })))));
  });
  const contents = () => [...win.document.querySelectorAll('[data-slot="dialog-content"]')];
  await render(true);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  assert.equal(contents().length, 2, "Fenster und Vorschau stehen nicht beide");
  assert.ok(contents()[1].contains(win.document.activeElement), "der Fokus liegt nicht in der Vorschau");

  await act(async () => {
    fire(win.document, "keydown", { key: "Escape" });
  });
  assert.equal(closes.preview, 1, "Escape schliesst die Vorschau nicht");
  assert.equal(closes.window, 0, "Escape hat das Fenster mitgeschlossen");
  assert.equal(contents().length, 2);

  // Die Anwendung nimmt die Vorschau nach dem Schliessen aus dem Baum.
  await render(false);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  assert.equal(contents().length, 1);

  await act(async () => {
    fire(win.document, "keydown", { key: "Escape" });
  });
  assert.equal(closes.window, 1, "der naechste Escape schliesst das Fenster");

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});
