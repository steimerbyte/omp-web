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
const { TerminalViewer, isMeasuredTerminal } = await jiti.import(`${ROOT}/components/TerminalViewer.tsx`);

// linkedom misst keine Zelle (`cell.width` bleibt 0, gemessen), FitAddon
// liefert dort nie ein Proposal. Damit die Tests ein gemessenes Panel
// nachstellen, liefert das echte Addon 60x30; der Gate-Test patcht es selbst.
const { FitAddon } = await jiti.import("@xterm/addon-fit");
FitAddon.prototype.proposeDimensions = () => ({ cols: 60, rows: 30 });

async function mount({ terminalId = "term-1", onExit, strict = false } = {}) {
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
    const viewer = React.createElement(TerminalViewer, { terminalId, onExit });
    root.render(strict ? React.createElement(React.StrictMode, null, viewer) : viewer);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  mounted.push({ root });
  return { root, container, calls };
}

/** Ein Zeichen ueber xterms Hilfs-Textarea tippen (loest `onData` aus). */
async function pressKey(container, char) {
  const textarea = container.querySelector(".xterm-helper-textarea");
  textarea.focus();
  await act(async () => {
    const event = new win.Event("keydown", { bubbles: true, cancelable: true });
    const upper = char.toUpperCase().charCodeAt(0);
    for (const [name, value] of Object.entries({ key: char, code: `Key${char.toUpperCase()}`, keyCode: upper, which: upper, charCode: char.charCodeAt(0) })) {
      Object.defineProperty(event, name, { value, configurable: true });
    }
    textarea.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

test("zeigt Connecting, verarbeitet connected/output und sendet Resize", async () => {
  const { root, container, calls } = await mount();

  assert.match(container.textContent, /Connecting…/);
  assert.match(container.textContent, /connecting…/);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].url, "/api/terminal/term-1/stream");
  assert.ok(container.querySelector(".xterm"), "xterm wurde nicht geoeffnet");
  assert.equal(observers.length, 1);

  // Die Groesse folgt dem ResizeObserver — entprellt, nicht pro Tick.
  await act(async () => {
    observers[0].callback();
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  const resizes = () => calls.filter((call) => call.url === "/api/terminal/term-1/resize");
  const resize = resizes()[0];
  assert.ok(resize, "resize-POST fehlt");
  assert.equal(resize.options.method, "POST");
  const body = JSON.parse(resize.options.body);
  assert.equal(typeof body.cols, "number");
  assert.equal(typeof body.rows, "number");

  // Ein weiterer Tick mit derselben Groesse schickt nichts nach.
  await act(async () => {
    observers[0].callback();
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  assert.equal(resizes().length, 1, "unveraenderte Groesse -> kein zweiter POST");

  await act(async () => {
    instances[0].emit("connected", { cols: 100, rows: 30 });
  });
  // `connected` uebernimmt die Spawn-Groesse nicht: xterm behaelt die
  // gefittete Groesse, und der Attach meldet nur eine Abweichung.
  assert.ok(resizes().length <= 2, "hoechstens ein POST fuer die erste Abweichung");
  const attachedSize = JSON.parse(resizes().at(-1).options.body);
  const beforeSecondAttach = resizes().length;
  await act(async () => {
    instances[0].emit("connected", attachedSize);
  });
  assert.equal(resizes().length, beforeSecondAttach, "unveraenderte Groesse -> kein POST");
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

test("Exit setzt exited und ruft onExit, ohne die Meldung doppelt zu schreiben", async () => {
  let exits = 0;
  const { root, container } = await mount({ onExit: () => { exits += 1; } });

  await act(async () => {
    instances[0].emit("connected", { cols: 80, rows: 24 });
    instances[0].emit("exit", { exitCode: 7 });
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  // Die Exit-Zeile kommt als `output` aus dem Manager; der Viewer schreibt sie nicht.
  assert.doesNotMatch(container.querySelector(".xterm-rows").textContent, /Process exited/);
  assert.equal(container.querySelector('[aria-label="exited"]') !== null, true);
  assert.equal(exits, 1);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Exit ohne JSON setzt exited", async () => {
  const { root, container } = await mount();
  await act(async () => {
    instances[0].emit("connected", { cols: 80, rows: 24 });
    instances[0].listeners.get("exit")[0]({ data: "{broken" });
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  assert.doesNotMatch(container.querySelector(".xterm-rows").textContent, /Process exited/);
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
    // Der Resize-POST ist entprellt; erst nach dem Timer wird er gesendet und
    // kann hier scheitern.
    await new Promise((resolve) => setTimeout(resolve, 200));
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

test("Tastatureingaben gehen nacheinander raus, keine geht verloren", async (t) => {
  const { root, container } = await mount();
  const sent = [];
  const gates = [];
  // Jeder input-POST wartet auf seine Freigabe; die Antworten kommen damit
  // garantiert in einer anderen Reihenfolge als die Anfragen — genau der Fall,
  // in dem die ungeordnete Fassung "echo verify" als "yehco veirfy" zustellte.
  globalThis.fetch = (url, options = {}) => {
    if (String(url) !== "/api/terminal/term-1/input") {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    }
    const gate = { body: JSON.parse(options.body).data, resolve: null };
    gates.push(gate);
    sent.push(gate.body);
    return new Promise((resolve) => {
      gate.resolve = (ok = true) => resolve({ ok, status: ok ? 200 : 500 });
    });
  };

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => void warnings.push(String(args[0]));
  t.after(() => {
    console.warn = originalWarn;
  });

  const press = async (char) => pressKey(container, char);

  await press("a");
  await press("b");
  assert.deepEqual(sent, ["a"], "b darf erst nach der Antwort auf a rausgehen");

  await act(async () => {
    gates[0].resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.deepEqual(sent, ["a", "b"], "nach der Antwort geht b in Reihenfolge raus");

  // Ein fehlgeschlagener POST bricht die Kette nicht: c kommt trotzdem an, und
  // die Meldung erscheint genau einmal.
  await act(async () => {
    gates[1].resolve(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await press("c");
  assert.deepEqual(sent, ["a", "b", "c"]);
  assert.equal(
    warnings.filter((line) => line.includes("[terminal] input POST failed")).length,
    1,
    "der Fehler wird einmal gemeldet, nicht pro Zeichen",
  );

  await act(async () => {
    gates[2].resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("unter der Messgrenze wird weder gefittet noch verbunden", async (t) => {
  // Der Fit-Vorschlag wird gesteuert: linkedom kann keine Zelle messen, also
  // ist das der einzige Weg, die 2-Spalten-Situation nachzustellen, die ein
  // 1-px-Panel aus StrictModes doppeltem Mount liefert (gemessen).
  const prototype = FitAddon.prototype;
  const realPropose = prototype.proposeDimensions;
  const realFit = prototype.fit;
  let proposal;
  const fits = [];
  prototype.proposeDimensions = () => proposal;
  prototype.fit = function patchedFit(...args) {
    fits.push(proposal);
    return realFit.apply(this, args);
  };
  t.after(() => {
    prototype.proposeDimensions = realPropose;
    prototype.fit = realFit;
  });

  const { root, container } = await mount();
  const rowCount = () => container.querySelectorAll(".xterm-rows > div").length;

  // Erst gar kein Proposal (Zelle noch nicht gemessen): kein fit, kein Strom,
  // und xterm bleibt bei seinen Startzeilen — kein Resize auf 2 Spalten.
  assert.equal(fits.length, 0, "ohne Proposal kein fit()");
  assert.equal(instances.length, 0, "ohne Proposal kein Strom");
  assert.equal(rowCount(), 24, "kein Resize: xterm bleibt bei 24 Zeilen");

  // 1-px-Panel: FitAddon schlaegt Math.max(2, …) vor, also 2 Spalten.
  proposal = { cols: 2, rows: 50 };
  await act(async () => {
    observers[0].callback();
  });
  assert.equal(fits.length, 0, "unter der Messgrenze kein fit()");
  assert.equal(instances.length, 0, "und kein Strom");
  assert.equal(rowCount(), 24, "die Zeile bleibt unversehrt");

  // Ein spaeterer Refit auf 2 Spalten darf die gezeichnete Zeile nicht
  // zerlegen (gemessen: 62 -> 61 togglen korrumpiert sie).
  proposal = { cols: 61, rows: 30 };
  await act(async () => {
    observers[0].callback();
  });
  assert.equal(fits.length, 1, "bei 61 Spalten wird gefittet");
  assert.equal(rowCount(), 30, "der Resize ist am Terminal angekommen");
  assert.equal(instances.length, 1, "der Strom startet mit der echten Geometrie");

  proposal = { cols: 2, rows: 50 };
  await act(async () => {
    observers[0].callback();
  });
  assert.equal(fits.length, 1, "kein Rueck-Resize unter die Messgrenze");
  assert.equal(rowCount(), 30);

  const prompt = "[steimer@host ~]$ ";
  await act(async () => {
    instances[0].emit("connected", { cols: 62, rows: 30 });
    instances[0].emit("output", Array.from(new TextEncoder().encode(prompt)));
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  const rows = [...container.querySelectorAll(".xterm-rows > div")];
  const promptRow = rows.find((row) => row.textContent.includes("["));
  assert.ok(promptRow, "der Prompt wurde nicht gezeichnet");
  assert.match(promptRow.textContent, /\[steimer@host ~\]\$ /, "der Prompt steht in einer Zeile");

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("die Messgrenze liegt bei 20 Spalten und 5 Zeilen", () => {
  assert.equal(isMeasuredTerminal(2, 24), false, "FitAddons Kleinstwert ist kein Panel");
  assert.equal(isMeasuredTerminal(19, 30), false);
  assert.equal(isMeasuredTerminal(20, 4), false, "zu wenige Zeilen");
  assert.equal(isMeasuredTerminal(20, 5), true, "genau die Grenze");
  assert.equal(isMeasuredTerminal(40, 30), true);
});

test("StrictMode-Doppelmount schliesst den ersten Strom vor dem zweiten", async () => {
  const { root, container } = await mount({ strict: true });
  // StrictMode runnt den Effect zweimal; der erste Strom muss seinen Cleanup
  // gesehen haben, bevor der zweite entsteht — sonst bekaeme der Client den
  // Verlauf zweimal. (Ein einzelner Lauf ist auch in Ordnung: dann gibt es
  // genau einen offenen Strom.)
  assert.equal(instances.filter((source) => !source.closed).length, 1, "genau ein offener Strom");
  if (instances.length > 1) {
    assert.equal(instances[0].closed, true, "der erste Strom wurde geschlossen");
    assert.equal(instances[0].url, instances[1].url);
  }

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("ein haengender input-POST wird nach 15 s abgebrochen, die naechste Taste geht raus", async (t) => {
  const { root, container } = await mount();
  const sent = [];
  // Kein POST antwortet je; der Abort des Viewers muss die Kette loesen.
  globalThis.fetch = (url, options = {}) => {
    if (!String(url).endsWith("/input")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    }
    sent.push(JSON.parse(options.body).data);
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  };

  // Der 15-s-Timer wird nicht abgewartet: alles ab 1 s wird eingesammelt und
  // von Hand ausgeloest, alles darunter (act, Debounce) laeuft echt.
  const captured = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => {
    if (ms >= 1000) {
      captured.push(callback);
      return 0;
    }
    return realSetTimeout(callback, ms, ...args);
  };
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
  });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => void warnings.push(String(args[0]));
  t.after(() => {
    console.warn = originalWarn;
  });

  await pressKey(container, "a");
  assert.deepEqual(sent, ["a"]);
  assert.equal(captured.length, 1, "der input-POST traegt einen 15-s-Timer");

  await act(async () => {
    captured[0]();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.deepEqual(sent, ["a"], "der abgebrochene POST wurde nicht wiederholt");

  await pressKey(container, "b");
  assert.deepEqual(sent, ["a", "b"], "die naechste Taste geht nach dem Abbruch raus");
  assert.equal(
    warnings.filter((line) => line.includes("[terminal] input POST failed")).length,
    1,
    "der Abbruch wird einmal gemeldet",
  );

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});
