import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React from "react";
import { createJiti } from "jiti";

/**
 * Der Dialog des Kalenders — gemessen, nicht im Quelltext nachgeschlagen.
 *
 * ### Warum der Dialog gemessen wird und nicht gelesen
 *
 * Zwei der Fehler, um die es hier geht, sind im Quelltext *kaum* zu sehen:
 * eine Vorbelegung, die Start und Ende auf dieselbe Minute setzt, sieht
 * plausibel aus; und ein Loeschknopf ohne Rueckfrage sieht in einer
 * Oberflaeche aus wie jeder andere. Beide fallen erst auf, wenn man das
 * Formular wirklich ausfuellt und abschickt — also wird hier genau das
 * getan.
 *
 * Der Harness ist der aus `components/DialogFocus.test.mjs` uebernommene:
 * `linkedom` fuehrt kein Layout aus, und Radix fragt beim Einrasten die
 * Breite der Bildlaufleiste ab. Ohne die Ersetzungen dort montiert der
 * Dialog ueberhaupt nicht.
 */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const win = dom.window;
const fakeNavigator = { userAgent: "test", languages: ["de-DE"], language: "de-DE", platform: "linux" };

// Ohne `getComputedStyle` wirft `react-remove-scroll-bar` beim Einrasten.
win.getComputedStyle = () => new Proxy({}, {
  get: (_target, prop) => (typeof prop === "string" && prop.startsWith("get") ? () => "" : "0px"),
});

globalThis.window = new Proxy(win, {
  get(target, prop) {
    if (prop === "navigator") return fakeNavigator;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
globalThis.document = win.document;
globalThis.navigator = fakeNavigator;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
for (const name of Object.entries(linkedom)) {
  if (name === "parseHTML" || name === "default") continue;
  if (typeof name === "function" && /^[A-Z]/.test(name)) globalThis[name] = name;
}
for (const name of Object.keys(win)) {
  if (name === "window") continue;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor && !descriptor.writable) continue;
  globalThis[name] = win[name];
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;

// Radix' `FocusScope` laeuft ueber einen `TreeWalker` und braucht dafuer
// `NodeFilter`. Ohne die Konstante bricht das Einrasten des Dialogs ab.
globalThis.NodeFilter = win.NodeFilter ?? { SHOW_ELEMENT: 1 };

/**
 * React 19 schaltet seinen `change`-Pfad an der Existenz von `oninput` auf dem
 * `document` fest, und er fragt das beim Auswerten von `react-dom` ab — nicht
 * beim Dispatchen. linkedom hat `oninput` nicht, also fiel
 * `isInputEventSupported` in diesem Harness dauerhaft auf `false` und
 * `onChange` an kontrollierten Feldern wurde nie gerufen: der Knopf blieb
 * `disabled`, es ging nichts raus.
 *
 * `attachEvent`/`detachEvent` braucht der alte Input-Polyfill, den React
 * nimmt, wenn `isInputEventSupported` false ist. Gemessen 2026-10-20 in
 * `app/login/login-username-prefill.test.mjs`.
 */
win.document.oninput = null;
win.document.onchange = null;
win.HTMLElement.prototype.attachEvent = function attachEvent(type, handler) {
  this.addEventListener(type.replace(/^on/, ""), handler);
};
win.HTMLElement.prototype.detachEvent = function detachEvent(type, handler) {
  this.removeEventListener(type.replace(/^on/, ""), handler);
};

win.matchMedia = () => ({
  matches: false,
  media: "",
  addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {},
  onchange: null,
  dispatchEvent() { return false; },
});
globalThis.matchMedia = win.matchMedia;

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  clear: () => { storage.clear(); },
};
win.localStorage = globalThis.localStorage;

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { CalendarEventDialog } = await jiti.import("./CalendarEventDialog.tsx");
// Die deutschen Farbnamen stehen in der Domaene — der Dialog und die
// Werkzeug-Ausgabe nennen dieselben fuenf Woerter, also kommt die Erwartung
// hier auch aus der Domaene und nicht aus einer Abschrift.
const { CALENDAR_COLOR_PRESET_LABELS } = await jiti.import("@/lib/calendar.ts");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

async function mount(element) {
  win.document.body.innerHTML = "";
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
  return { container, root };
}

/**
 * Tippt in ein React-Eingabefeld, wie ein Browser es tut.
 *
 * Der Wert wird ueber den nativen Setter geschrieben und danach ein
 * `input`-Event gesendet — React loest `onChange` an kontrollierten Feldern
 * nur fuer diese Sequenz aus; ein bloss gesetztes `.value` loest nichts aus.
 *
 * Zusaetzlich laufen `focusin` und `keyup` mit. Laedt eine fruehere Testdatei
 * `react-dom` zuerst, ist `isInputEventSupported` dort schon auf `false`
 * gefallen (`oninput` fehlt im linkedom-`document`), und React nimmt fuer
 * Textfelder dann den alten Polyfill-Pfad, der `onChange` ueber `keyup` auf dem
 * gerade aktiven Element ausloest — mit `attachEvent`, das linkedom ebenfalls
 * nicht kennt. Gemessen 2026-10-20: mit `input` allein blieb der Zustand
 * leer; mit `focusin` + `keyup` daneben wird der Zustand in beiden Laeufen
 * gesetzt. Quelle der Messung: `app/login/login-username-prefill.test.mjs`.
 */
async function setInputValue(input, value) {
  await act(async () => {
    input.dispatchEvent(new win.Event("focusin", { bubbles: true }));
  });
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    input.dispatchEvent(new win.Event("keyup", { bubbles: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

const byId = (id) => win.document.getElementById(id);
const buttons = () => [...win.document.querySelectorAll("button")];
const buttonWith = (text) => buttons().find((b) => b.textContent.trim() === text);

/** Fuellt den Dialog mit einem Titel und schickt das Formular ab. */
async function submitWithTitle(title) {
  const field = byId("calendar-title");
  assert.ok(field, "das Titelfeld wurde nicht gerendert");
  await setInputValue(field, title);
  const form = win.document.querySelector("form");
  assert.ok(form, "das Formular wurde nicht gerendert");
  await act(async () => {
    form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

test("ein neuer Termin aus der Wochenansicht hat ein Ende nach dem Beginn", async () => {
  const saved = [];
  await mount(React.createElement(CalendarEventDialog, {
    event: null,
    // Der Klick auf eine freie Stunde liefert genau diese Vorbelegung.
    preset: { date: "2026-03-14", time: "14:00" },
    busy: false,
    onCancel: () => {},
    onSave: (input) => { saved.push(input); },
    onDelete: () => {},
  }));

  await submitWithTitle("Teammeeting");

  assert.equal(saved.length, 1, "das Formular wurde nicht abgeschickt");
  const input = saved[0];
  assert.equal(input.start, "2026-03-14T14:00");
  assert.ok(
    input.end > input.start,
    `das Ende (${input.end}) liegt nicht nach dem Beginn (${input.start})`,
  );
});

test("ein bestehender Termin behaelt beim Speichern Beginn und Ende", async () => {
  const saved = [];
  await mount(React.createElement(CalendarEventDialog, {
    event: {
      id: "e1", title: "Teammeeting", allDay: false,
      start: "2026-03-14T15:00", end: "2026-03-14T16:30",
    },
    preset: { date: "2026-03-14", time: null },
    busy: false,
    onCancel: () => {},
    onSave: (input) => { saved.push(input); },
    onDelete: () => {},
  }));

  await submitWithTitle("Teammeeting");

  assert.equal(saved.length, 1);
  assert.equal(saved[0].start, "2026-03-14T15:00");
  assert.equal(saved[0].end, "2026-03-14T16:30");
});

test("das Loeschen fragt nach, bevor der Termin verschwindet", async () => {
  const deleted = [];
  const asked = [];
  win.confirm = (message) => {
    asked.push(message);
    // Der Nutzer sagt "nein" — dann darf nichts geloescht werden.
    return false;
  };

  await mount(React.createElement(CalendarEventDialog, {
    event: {
      id: "e1", title: "Teammeeting", allDay: false,
      start: "2026-03-14T15:00", end: "2026-03-14T16:30",
    },
    preset: { date: "2026-03-14", time: null },
    busy: false,
    onCancel: () => {},
    onSave: () => {},
    onDelete: (id) => { deleted.push(id); },
  }));

  const remove = buttonWith("Löschen");
  assert.ok(remove, "der Loesch-Knopf wurde nicht gerendert");
  await act(async () => { remove.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });

  assert.equal(deleted.length, 0, "der Termin wurde ohne Rueckfrage geloescht");
  assert.ok(asked.length > 0, "es wurde nicht nachgefragt");
  assert.match(
    asked[0],
    /Diesen Termin löschen\?/,
    "die Rueckfrage traegt keinen deutschen Text",
  );
});

test("die Farbe zeigt fuenf Presets und einen eigenen Knopf", async () => {
  await mount(React.createElement(CalendarEventDialog, {
    event: null,
    preset: { date: "2026-03-14", time: null },
    busy: false,
    onCancel: () => {},
    onSave: () => {},
    onDelete: () => {},
  }));

  // Fuenf Presets, jedes mit seinem deutschen Namen als Beschriftung — die
  // Namen kommen aus der Domaene.
  const presets = Object.values(CALENDAR_COLOR_PRESET_LABELS);
  assert.equal(presets.length, 5);
  for (const name of presets) {
    const swatch = buttons().find((button) => button.getAttribute("aria-label") === name);
    assert.ok(swatch, `das Preset "${name}" fehlt`);
  }

  // Der Termin traegt noch keine eigene Farbe — er wird in der
  // Voreinstellung gezeichnet, also ist *der* Knopf gedrueckt.
  const accentName = CALENDAR_COLOR_PRESET_LABELS.accent;
  const accent = buttons().find((button) => button.getAttribute("aria-label") === accentName);
  assert.equal(accent.getAttribute("aria-pressed"), "true");
  for (const name of presets.filter((entry) => entry !== accentName)) {
    const swatch = buttons().find((button) => button.getAttribute("aria-label") === name);
    assert.equal(swatch.getAttribute("aria-pressed"), "false", `"${name}" ist gedrueckt`);
  }

  // Und der Knopf fuer eine eigene Farbe.
  const custom = buttonWith("Benutzerdefiniert");
  assert.ok(custom, "der Knopf fuer eine eigene Farbe fehlt");
});

test("ein gewaehltes Preset wird als gedrueckt angezeigt und gespeichert", async () => {
  const saved = [];
  await mount(React.createElement(CalendarEventDialog, {
    event: null,
    preset: { date: "2026-03-14", time: null },
    busy: false,
    onCancel: () => {},
    onSave: (input) => { saved.push(input); },
    onDelete: () => {},
  }));

  const successName = CALENDAR_COLOR_PRESET_LABELS.success;
  const success = buttons().find((button) => button.getAttribute("aria-label") === successName);
  assert.ok(success, `das Preset "${successName}" fehlt`);
  await act(async () => { success.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });

  // Das gewaehlte Preset ist gedrueckt, die anderen nicht.
  assert.equal(success.getAttribute("aria-pressed"), "true");
  const accent = buttons().find(
    (button) => button.getAttribute("aria-label") === CALENDAR_COLOR_PRESET_LABELS.accent,
  );
  assert.equal(accent.getAttribute("aria-pressed"), "false");

  await submitWithTitle("Teammeeting");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].color, "success", "die gewaehlte Farbe wurde nicht gespeichert");
});

test("ein bestehender Termin zeigt sein Preset als gedrueckt", async () => {
  await mount(React.createElement(CalendarEventDialog, {
    event: {
      id: "e1", title: "Teammeeting", allDay: false,
      start: "2026-03-14T15:00", end: "2026-03-14T16:30",
      color: "warning",
    },
    preset: { date: "2026-03-14", time: null },
    busy: false,
    onCancel: () => {},
    onSave: () => {},
    onDelete: () => {},
  }));

  const warningName = CALENDAR_COLOR_PRESET_LABELS.warning;
  const warning = buttons().find((button) => button.getAttribute("aria-label") === warningName);
  assert.ok(warning, `das Preset "${warningName}" fehlt`);
  assert.equal(warning.getAttribute("aria-pressed"), "true");
});

test("ein eigener Hex-Code wird gespeichert und der eigene Knopf ist gedrueckt", async () => {
  const saved = [];
  await mount(React.createElement(CalendarEventDialog, {
    event: null,
    preset: { date: "2026-03-14", time: null },
    busy: false,
    onCancel: () => {},
    onSave: (input) => { saved.push(input); },
    onDelete: () => {},
  }));

  const custom = buttonWith("Benutzerdefiniert");
  assert.ok(custom, "der Knopf fuer eine eigene Farbe fehlt");
  await act(async () => { custom.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });

  // Der eigene Farbwaehler ist jetzt offen: der Farbcode wird getippt.
  const field = byId("calendar-color-hex");
  assert.ok(field, "das Feld fuer den Hex-Code fehlt");
  await setInputValue(field, "#ff00aa");

  await submitWithTitle("Teammeeting");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].color, "#ff00aa");
});
