import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

/**
 * TerminalViewer: xterm wird echt gemountet (linkedom ohne Layout, Canvas als
 * Stub), EventSource/ResizeObserver sind Aufzeichnungs-Stubs. Geprueft werden
 * Statuszeile, Schreiben von output, PTY-Resize, Input-POST, Exit-Ereignis und
 * der Stream-Fehler nach CLOSED.
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

const ORIGINALS = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
  localStorage: globalThis.localStorage,
  fetch: globalThis.fetch,
  EventSource: globalThis.EventSource,
  ResizeObserver: globalThis.ResizeObserver,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
};

win.innerWidth = 1200;
win.innerHeight = 800;
win.devicePixelRatio = 1;
win.document.hasFocus = () => true;
win.localStorage = localStorage;
win.matchMedia = () => ({
  matches: false,
  media: "",
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
});
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

// xterm legt fuer seinen Atlas echte Canvas-2D-Operationen an; linkedom hat
// keinen Kontext. Der Stub liefert leere Pixeldaten und feste Textbreiten.
function fakeContext(canvas) {
  const state = {};
  return new Proxy(state, {
    get(target, property) {
      if (property === "canvas") return canvas;
      if (property === "measureText") {
        return (text) => ({ width: String(text).length * 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
      }
      if (property === "createImageData" || property === "getImageData") {
        return (width, height) => ({
          data: new Uint8ClampedArray(Math.max(1, width | 0) * Math.max(1, height | 0) * 4),
          width: width | 0,
          height: height | 0,
        });
      }
      if (property in target) return target[property];
      return () => undefined;
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    },
  });
}
win.HTMLCanvasElement.prototype.getContext = function getContext() {
  if (!this.__ctx) this.__ctx = fakeContext(this);
  return this.__ctx;
};
win.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,";

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  constructor(url) {
    this.url = url;
    this.readyState = FakeEventSource.OPEN;
    this.listeners = new Map();
    this.onerror = null;
    this.closed = false;
    instances.push(this);
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  emit(type, data) {
    const event = { data: JSON.stringify(data) };
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}
const instances = [];

class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.disconnected = false;
    observers.push(this);
  }
  observe() {}
  disconnect() {
    this.disconnected = true;
  }
}
const observers = [];

globalThis.EventSource = FakeEventSource;
globalThis.ResizeObserver = FakeResizeObserver;

const mounted = [];
test.after(async () => {
  for (const { root } of mounted.splice(0)) {
    await act(async () => root.unmount());
  }
  for (const key of ["window", "document", "navigator", "localStorage", "fetch", "EventSource", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"]) {
    if (ORIGINALS[key] === undefined) delete globalThis[key];
    else globalThis[key] = ORIGINALS[key];
  }
});

const jiti = createJiti(`${ROOT}/package.json`, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { TerminalViewer } = await jiti.import(`${ROOT}/components/TerminalViewer.tsx`);

async function mount({ terminalId = "term-1", onExit } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  instances.length = 0;
  observers.length = 0;
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    root.render(React.createElement(TerminalViewer, { terminalId, onExit }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  mounted.push({ root });
  return { root, container, calls };
}

test("zeigt Connecting, verarbeitet connected/output und sendet Resize", async () => {
  const { root, container, calls } = await mount();

  assert.match(container.textContent, /Connecting…/);
  assert.match(container.textContent, /connecting…/);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].url, "/api/terminal/term-1/stream");
  assert.ok(container.querySelector(".xterm"), "xterm wurde nicht geoeffnet");
  assert.equal(observers.length, 1);

  // PTY-Groesse folgt dem ResizeObserver.
  await act(async () => {
    observers[0].callback();
  });
  const resize = calls.find((call) => call.url === "/api/terminal/term-1/resize");
  assert.ok(resize, "resize-POST fehlt");
  assert.equal(resize.options.method, "POST");
  const body = JSON.parse(resize.options.body);
  assert.equal(typeof body.cols, "number");
  assert.equal(typeof body.rows, "number");

  await act(async () => {
    instances[0].emit("connected", { cols: 100, rows: 30 });
  });
  assert.equal(container.querySelector('[aria-label="running"]') !== null, true, "Status running fehlt");
  assert.match(container.textContent, /term-1/);
  assert.doesNotMatch(container.textContent, /connecting…/);

  // UTF-8-Bytes werden dekodiert und in den Terminalpuffer geschrieben.
  await act(async () => {
    instances[0].emit("output", [104, 101, 108, 108, 111, 32, 119, 195, 182, 114, 116]);
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  assert.match(container.querySelector(".xterm-rows").textContent, /hello wört/);

  // Malformed JSON wird geschluckt.
  await act(async () => {
    instances[0].listeners.get("output")[0]({ data: "{not json" });
    instances[0].listeners.get("connected")[0]({ data: "{not json" });
  });

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Exit schreibt den Code, setzt exited und ruft onExit", async () => {
  let exits = 0;
  const { root, container } = await mount({ onExit: () => { exits += 1; } });

  await act(async () => {
    instances[0].emit("connected", { cols: 80, rows: 24 });
    instances[0].emit("exit", { exitCode: 7 });
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  assert.match(container.textContent, /Process exited/);
  assert.match(container.querySelector(".xterm-rows").textContent, /\[Process exited with code 7\]/);
  assert.equal(container.querySelector('[aria-label="exited"]') !== null, true);
  assert.equal(exits, 1);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Exit ohne JSON setzt exited mit generischer Meldung", async () => {
  const { root, container } = await mount();
  await act(async () => {
    instances[0].emit("connected", { cols: 80, rows: 24 });
    instances[0].listeners.get("exit")[0]({ data: "{broken" });
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  assert.match(container.querySelector(".xterm-rows").textContent, /\[Process exited\]/);
  assert.equal(container.querySelector('[aria-label="exited"]') !== null, true);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Stream-Fehler nach CLOSED zeigt error, solange running war", async () => {
  const { root, container } = await mount();
  await act(async () => {
    instances[0].emit("connected", { cols: 80, rows: 24 });
  });

  await act(async () => {
    instances[0].readyState = FakeEventSource.CLOSED;
    instances[0].onerror?.();
  });
  assert.equal(container.querySelector('[aria-label="error"]') !== null, true);
  assert.match(container.textContent, /Stream closed by server/);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("CLOSED beim Verbinden zeigt keinen Fehler (Status ist noch connecting)", async () => {
  const { root, container } = await mount();
  await act(async () => {
    instances[0].readyState = FakeEventSource.CLOSED;
    instances[0].onerror?.();
  });
  assert.equal(container.querySelector('[aria-label="error"]'), null);
  assert.match(container.textContent, /Connecting…/);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Tastatureingabe im xterm-Hilfsfeld wird als input-POST gesendet", async () => {
  const { root, container, calls } = await mount();
  const textarea = container.querySelector(".xterm-helper-textarea");
  assert.ok(textarea, "xterm-Textarea fehlt");
  textarea.focus();

  await act(async () => {
    const event = new win.Event("keydown", { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries({ key: "a", code: "KeyA", keyCode: 65, which: 65, charCode: 97 })) {
      Object.defineProperty(event, key, { value, configurable: true });
    }
    textarea.dispatchEvent(event);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  const input = calls.find((call) => call.url === "/api/terminal/term-1/input");
  assert.ok(input, "input-POST fehlt");
  assert.equal(input.options.method, "POST");
  assert.deepEqual(JSON.parse(input.options.body), { data: "a" });

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Resize- und Input-POST duerfen fehlschlagen, ohne den Viewer zu brechen", async () => {
  const { root, container } = await mount();
  // Der Stub wirft ab hier fuer jede Anfrage.
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  await act(async () => {
    observers[0].callback();
  });
  const textarea = container.querySelector(".xterm-helper-textarea");
  textarea.focus();
  await act(async () => {
    const event = new win.Event("keydown", { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries({ key: "b", code: "KeyB", keyCode: 66, which: 66, charCode: 98 })) {
      Object.defineProperty(event, key, { value, configurable: true });
    }
    textarea.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.match(container.textContent, /Connecting…/, "der Status bleibt unberuehrt");

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});
