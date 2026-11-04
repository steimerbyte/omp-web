import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";
import { restoreLinkedomPrototypesOnExit } from "../../lib/test-linkedom.mjs";

/**
 * Die vier Eingabe-Handler des Termin-Dialogs, die kein bestehender Test
 * beruehrt: die beiden Blur-Normalisierungen (Uhrzeit und Datum) und die
 * beiden Wege zur eigenen Farbe (nativer Waehler und Hex-Feld).
 *
 * Alle vier sind an *uncontrolled* Felder gebunden: der getippte Text steht im
 * DOM, der kanonische Wert im Zustand. Der Test tippt deshalb wie ein Browser
 * (native Setter + Ereignisse) und liest danach das Feld — nicht den Zustand.
 */

const ROOT = process.cwd();
const jiti = createJiti(`${ROOT}/package.json`, { jsx: { runtime: "automatic" }, tsconfigPaths: true });

/* Die Globals, die diese Datei ersetzt, gehoeren ihr nicht: `bun test` faehrt
 * alle Dateien in einem Prozess, und was hier stehen bleibt, sieht die
 * naechste Datei. Der Schnappschuss entsteht vor dem ersten Eingriff. */
const ORIGINALS = {
  window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator,
  getComputedStyle: globalThis.getComputedStyle, matchMedia: globalThis.matchMedia,
  localStorage: globalThis.localStorage, Event: globalThis.Event, EventTarget: globalThis.EventTarget,
  DOMRect: globalThis.DOMRect, NodeFilter: globalThis.NodeFilter,
};
test.after(() => {
  for (const [name, value] of Object.entries(ORIGINALS)) {
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  }
});

const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
// Prototyp-Stubs dieser Datei werden am Ende zurueckgegeben; linkedom teilt
// sie prozessweit.
restoreLinkedomPrototypesOnExit(win);
const fakeNavigator = { userAgent: "test", languages: ["de-DE"], language: "de-DE", platform: "linux" };
win.getComputedStyle = () => new Proxy({}, { get: (_t, p) => (typeof p === "string" && p.startsWith("get") ? () => "" : "0px") });
globalThis.window = new Proxy(win, {
  get(target, prop) {
    if (prop === "navigator") return fakeNavigator;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
  has(target, prop) { return prop === "navigator" || Reflect.has(target, prop); },
});
globalThis.document = win.document;
globalThis.navigator = fakeNavigator;
globalThis.getComputedStyle = win.getComputedStyle;
globalThis.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent() { return false; } });
win.matchMedia = globalThis.matchMedia;
for (const [name, value] of Object.entries(linkedom)) {
  if (name === "parseHTML" || name === "default") continue;
  if (typeof value === "function" && /^[A-Z]/.test(name)) globalThis[name] = value;
}
/* Reacts alter Input-Polyfill (aktiv, wenn eine fruehere Datei `react-dom`
 * ohne `document.oninput` geladen hat) haengt sich per `attachEvent` an das
 * aktive Feld. linkedom kennt die Methode nicht; ohne sie wirft schon der
 * Fokus. Die Abbildung auf `addEventListener` genuegt, weil der Polyfill den
 * Wert ohnehin ueber `keyup` liest. */
for (const name of ["attachEvent", "detachEvent"]) {
  if (win.HTMLElement.prototype[name]) continue;
  win.HTMLElement.prototype[name] = function (type, handler) {
    const event = String(type).replace(/^on/, "");
    if (name === "attachEvent") this.addEventListener(event, handler);
    else this.removeEventListener(event, handler);
  };
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
globalThis.NodeFilter = win.NodeFilter ?? { SHOW_ELEMENT: 1 };
globalThis.DOMRect = class DOMRect {
  constructor(x = 0, y = 0, width = 0, height = 0) { Object.assign(this, { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height }); }
  static fromRect(rect = {}) { return new DOMRect(rect.x, rect.y, rect.width, rect.height); }
};
win.document.oninput = null;
win.document.onchange = null;

const { createRoot } = await import("react-dom/client");
const { CalendarEventDialog } = await jiti.import(`${ROOT}/components/calendar/CalendarEventDialog.tsx`);
const { deLocale } = await jiti.import(`${ROOT}/lib/i18n/messages/de.ts`);
const deText = deLocale.messages;

const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 35)); }); };
const byId = (id) => win.document.getElementById(id);
const byLabel = (label) => win.document.querySelector(`input[aria-label="${label}"]`);
const buttonWith = (text) => [...win.document.querySelectorAll("button")].find((button) => button.textContent.trim() === text);

/** Setzt den Wert eines Feldes ueber den nativen Setter und meldet React die Aenderung. */
async function type(input, value) {
  await act(async () => { input.dispatchEvent(new win.Event("focusin", { bubbles: true })); });
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    // Der zweite Weg, den React fuer Textfelder kennt, falls `oninput` beim
    // Laden von `react-dom` nicht als unterstuetzt galt.
    input.dispatchEvent(new win.Event("keyup", { bubbles: true }));
  });
  await flush();
}

/** Das Feld verliert den Fokus — React liest `onBlur` aus `focusout`. */
async function blur(input) {
  await act(async () => { input.dispatchEvent(new win.Event("focusout", { bubbles: true })); });
  await flush();
}

async function mount() {
  win.document.body.innerHTML = "";
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  const saved = [];
  await act(async () => {
    root.render(React.createElement(CalendarEventDialog, {
      event: null,
      preset: { date: "2026-03-14", time: "14:00" },
      busy: false,
      onCancel: () => {},
      onSave: (input) => { saved.push(input); },
      onDelete: () => {},
    }));
  });
  await flush();
  return { container, root, saved };
}

async function submit(title) {
  const titleField = byId("calendar-title");
  await type(titleField, title);
  const form = win.document.querySelector("form");
  await act(async () => { form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })); });
  await flush();
}

test("ein getippter Zeitwert bekommt beim Verlassen die kanonische Form", async () => {
  const { root, saved } = await mount();
  const startTime = byLabel(deText["calendar.eventStartTime"]);
  assert.ok(startTime, "das Feld fuer die Beginn-Uhrzeit fehlt");

  await type(startTime, "9:5");
  await blur(startTime);

  assert.equal(startTime.value, "09:05");
  await submit("Teammeeting");
  assert.equal(saved.length, 1);
  // Der kanonische Wert ist auch der gespeicherte, nicht nur der angezeigte.
  assert.equal(saved[0].start, "2026-03-14T09:05");
  // Das Ende wandert mit, solange der Nutzer es nicht selbst gesetzt hat.
  assert.equal(saved[0].end, "2026-03-14T10:05");
  await act(async () => { root.unmount(); });
});

test("ein getipptes Datum bekommt beim Verlassen die deutsche Form", async () => {
  const { root, saved } = await mount();
  const startDate = byLabel(deText["calendar.eventStartDate"]);
  assert.ok(startDate, "das Feld fuer das Beginn-Datum fehlt");

  await type(startDate, "1.3.2026");
  await blur(startDate);

  assert.equal(startDate.value, "01.03.2026");
  await submit("Teammeeting");
  assert.equal(saved[0].start, "2026-03-01T14:00");
  await act(async () => { root.unmount(); });
});

test("der native Farbwaehler setzt Hex-Feld und gespeicherte Farbe", async () => {
  const { root, saved } = await mount();
  const customButton = buttonWith(deText["calendar.customColor"]);
  assert.ok(customButton, "der Knopf fuer die eigene Farbe fehlt");
  await act(async () => { customButton.click(); });
  await flush();

  const native = win.document.querySelector('input[type="color"]');
  assert.ok(native, "der native Farbwaehler wurde nicht geoeffnet");
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set.call(native, "#ff00aa");
    // Ein Farbfeld meldet sich ueber `change`, nicht ueber `input`.
    native.dispatchEvent(new win.Event("change", { bubbles: true }));
  });
  await flush();

  const hex = byId("calendar-color-hex");
  assert.equal(hex.value, "#ff00aa");
  await submit("Teammeeting");
  assert.equal(saved[0].color, "#ff00aa");
  await act(async () => { root.unmount(); });
});

test("ein getippter Kurz-Hex-Code wird beim Verlassen ausgeschrieben", async () => {
  const { root, saved } = await mount();
  await act(async () => { buttonWith(deText["calendar.customColor"]).click(); });
  await flush();

  const hex = byId("calendar-color-hex");
  await type(hex, "#f0a");
  // Waehrend des Tippens bleibt der getippte Text stehen.
  assert.equal(hex.value, "#f0a");
  await blur(hex);

  assert.equal(hex.value, "#ff00aa");
  await submit("Teammeeting");
  assert.equal(saved[0].color, "#ff00aa");
  await act(async () => { root.unmount(); });
});
