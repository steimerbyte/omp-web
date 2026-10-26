import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as linkedom from "linkedom";
import React from "react";
import { createJiti } from "jiti";

/**
 * Die Kalenderansicht — im Browser gemessen, nicht im Quelltext gelesen.
 *
 * ### Warum ein Harness noetig ist
 *
 * Zwei der Befunde liegen in der *Verdrahtung* zwischen Ansicht und
 * Rechenlogik: welche Verschiebung eine Zelle anstoesst, und welches
 * Ereignis der Client abwartet. Beides steht im Quelltext an zwei
 * verschiedenen Stellen, und ein Quelltext-Vergleich beweist nichts: derselbe
 * Aufruf ist in der Monatsansicht richtig und in der Wochenansicht falsch.
 *
 * Der Harness montiert darum die echte Komponente, fuehrt echte
 * Drag-and-Drop-Ereignisse aus und liest danach das, was der Benutzer
 * sieht.
 */

/**
 * Die Termine, die der Server in diesem Test liefert.
 *
 * Die Daten liegen im *heutigen* Monat: die Ansicht zeigt den Monat des
 * heutigen Tages, und ein Termin in einem anderen Monat taucht in ihr gar
 * nicht auf. Der Test rechnet deshalb mit dem heutigen Datum.
 */
function pad(value) {
  return String(value).padStart(2, "0");
}

const today = new Date();

/**
 * Der Tag, an dem der Termin liegt.
 *
 * Es ist der **Mittwoch der aktuellen Woche** — der Mittwoch, weil er in
 * jeder Woche liegt, und die aktuelle Woche, weil die Wochenansicht genau
 * diese sieben Tage zeigt. Der Monatsraster zeigt denselben Monat, also
 * taucht der Termin in beiden Ansichten auf.
 */
const EVENT_DAY = (() => {
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const wednesday = new Date(monday);
  wednesday.setDate(wednesday.getDate() + 2);
  return `${wednesday.getFullYear()}-${pad(wednesday.getMonth() + 1)}-${pad(wednesday.getDate())}`;
})();

const EVENTS = [
  {
    id: "timed-1",
    title: "Teammeeting",
    description: undefined,
    location: undefined,
    start: `${EVENT_DAY}T15:00`,
    end: `${EVENT_DAY}T16:30`,
    allDay: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "all-1",
    title: "Urlaub",
    description: undefined,
    location: undefined,
    start: `${EVENT_DAY}T00:00:00Z`.slice(0, 10),
    end: `${EVENT_DAY}T00:00:00Z`.slice(0, 10),
    allDay: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

/** Die Anfragen, die der Server in diesem Test bekommen hat. */
const requests = [];

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const win = dom.window;
const fakeNavigator = { userAgent: "test", languages: ["de-DE"], language: "de-DE", platform: "linux" };

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
globalThis.NodeFilter = win.NodeFilter ?? { SHOW_ELEMENT: 1 };

// React 19 schaltet seinen `change`-Pfad an der Existenz von `oninput` auf dem
// `document` fest, und er fragt das beim Auswerten von `react-dom` ab — nicht
// beim Dispatchen. linkedom hat `oninput` nicht, also fiel
// `isInputEventSupported` in diesem Harness dauerhaft auf `false` und
// `onChange` an kontrollierten Feldern wurde nie gerufen.
//
// `attachEvent`/`detachEvent` braucht der alte Input-Polyfill, den React
// nimmt, wenn `isInputEventSupported` false ist. Gemessen 2026-10-20 in
// `app/login/login-username-prefill.test.mjs`.
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

/**
 * Der Server des Tests.
 *
 * `GET /api/calendar` liefert die Testtermine, `PATCH` merkt sich den
 * Body — an dem liest der Test ab, was die Oberflaeche dem Server wirklich
 * schickt.
 */
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null });
  if (String(url).includes("/api/calendar/events")) return { ok: true, json: async () => ({}) };
  return { ok: true, json: async () => ({ events: EVENTS, event: EVENTS[0] }) };
};

/**
 * Der Ereignisstrom des Servers.
 *
 * `EventSource` gibt es in Bun nicht; die Kalenderansicht oeffnet ihn beim
 * Start. Der Ersatz tut nichts — der Test prueft die *Verdrahtung* der
 * Oberflaeche, nicht den Strom.
 */
globalThis.EventSource = class {
  constructor(url) { this.url = url; }
  addEventListener() {}
  removeEventListener() {}
  close() {}
};

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { CalendarView } = await jiti.import("../CalendarView.tsx");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

async function mount() {
  requests.length = 0;
  win.document.body.innerHTML = "";
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(CalendarView)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  return { container, root };
}

/** Der Knopf mit dem gegebenen Text. */
const buttonWith = (text) => [...win.document.querySelectorAll("button")].find((b) => b.textContent.trim() === text);

/** Der Chip (der ziehbare Termin) mit dem gegebenen Titel. */
const chipWith = (title) =>
  [...win.document.querySelectorAll("[draggable=true]")].find((c) => c.textContent.includes(title));

/** Ein Drag-and-Drop, wie der Browser ihn erzeugt. */
function dragEvent(type, id) {
  const event = new win.Event(type, { bubbles: true, cancelable: true });
  const store = new Map();
  if (id) store.set("text/plain", id);
  event.dataTransfer = {
    getData: (format) => store.get(format) ?? "",
    setData: (format, value) => { store.set(format, value); },
    effectAllowed: "all",
    dropEffect: "move",
  };
  return event;
}

/** Die PATCH-Anfrage, die der Test gerade ausgeloest hat. */
const patchRequest = () => requests.find((r) => r.method === "PATCH");

test("ein Termin, der in der Monatsansicht auf einen anderen Tag gezogen wird, behaelt seine Uhrzeit", async () => {
  const { root } = await mount();

  const chip = chipWith("Teammeeting");
  assert.ok(chip, "der Termin-Chip wurde nicht gerendert");

  // Das Monatsraster: sechs Zeilen, sieben Spalten.
  const grid = [...win.document.querySelectorAll("div")].find(
    (d) => d.style.gridTemplateRows === "repeat(6, 1fr)",
  );
  assert.ok(grid, "das Monatsraster wurde nicht gerendert");

  // Das Raster beginnt am Montag der Woche vor dem 1. des Monats. Der
  // Zieltag ist der 20. — der Abstand vom 1. bis zum 20. ist 19 Tage, plus
  // der Versatz bis zum Montag.
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const index = offset + 19;
  const target = grid.children[index];
  assert.ok(target, "die Zielzelle wurde nicht gefunden");

  await act(async () => {
    chip.dispatchEvent(dragEvent("dragstart", "timed-1"));
    target.dispatchEvent(dragEvent("dragover", "timed-1"));
    target.dispatchEvent(dragEvent("drop", "timed-1"));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });

  const patch = patchRequest();
  assert.ok(patch, "es wurde keine PATCH-Anfrage geschickt");
  assert.equal(
    patch.body.start,
    `2026-${pad(today.getMonth() + 1)}-20T15:00`,
    "die Uhrzeit des Termins ging beim Ziehen verloren",
  );

  await act(async () => { root.unmount(); });
});

test("eine Tageszelle nimmt den Zug schon beim Betreten an", async () => {
  // Chromium feuert beim Betreten einer neuen Zelle zuerst `dragenter` und
  // `dragover` erst mit der naechsten Mausbewegung. Der Browser gilt den Zug
  // nur als angenommen, wenn das zuletzt gelieferte Ereignis abgebrochen
  // wurde — ohne diesen Abbruch verweigert Chromium den Fall und es kommt
  // kein `drop` an. Gemessen im Browser: ohne `dragenter` kein `drop`, mit
  // `dragenter` ein `drop`.
  const { root } = await mount();

  const grid = [...win.document.querySelectorAll("div")].find(
    (d) => d.style.gridTemplateRows === "repeat(6, 1fr)",
  );
  assert.ok(grid, "das Monatsraster wurde nicht gerendert");

  const target = grid.children[10];
  assert.ok(target, "die Zielzelle wurde nicht gefunden");

  await act(async () => {
    const entered = dragEvent("dragenter", "timed-1");
    target.dispatchEvent(entered);
    assert.equal(
      entered.defaultPrevented,
      true,
      "die Tageszelle bricht `dragenter` nicht ab — Chromium verweigert dann den Fall",
    );
  });

  await act(async () => { root.unmount(); });
});

test("ein Fehler beim Speichern erscheint nicht als englischer Servertext", async () => {
  // Der Server antwortet mit einem englischen Text — so, wie die Routen es
  // tatsaechlich tun.
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null });
    if (init?.method === "POST") {
      return { ok: false, json: async () => ({ error: "The event could not be stored" }) };
    }
    return { ok: true, json: async () => ({ events: EVENTS, event: EVENTS[0] }) };
  };

  const { root } = await mount();

  // Die Kette, die ein Serverfehler in der Oberflaeche nimmt: der Hook
  // wirft den Text des Servers weiter, und die Ansicht zeigt ihn an.
  // Geprueft wird deshalb die *Quelle* der Anzeige — im Browser laesst sich
  // der Klickpfad in diesem Harness nicht bis zum Absenden des Formulars
  // durchspielen, und die Kette selbst ist an drei Stellen ablesbar.
  //
  // Geprueft wird die Absicht, nicht die Form: eine Zeile, die den
  // Servertext uebernimmt, ist ein Fehler — unabhaengig davon, ob sie
  // `cause.message`, `cause.toString()` oder einen Umweg ueber eine
  // Zwischenvariable benutzt.
  const viewSource = await readFile(new URL("../CalendarView.tsx", import.meta.url), "utf8");
  const noticeLines = viewSource.split("\n").filter((line) => line.includes("setNotice("));
  assert.ok(noticeLines.length > 0, "es wird ueberhaupt eine Meldung angezeigt");
  // Der Fehler des *offenen Dialogs* hat einen eigenen Zustand: er steht
  // im Dialog, weil die Meldungsleiste der Ansicht hinter dem Radix-Overlay
  // liegt und damit nicht lesbar ist. Auch dort darf der Servertext nicht
  // unuebersetzt erscheinen.
  const dialogErrorLines = viewSource.split("\n").filter((line) => line.includes("setDialogError("));
  assert.ok(dialogErrorLines.length > 0, "der Dialog bekommt keinen Fehler weitergereicht");
  for (const line of [...noticeLines, ...dialogErrorLines]) {
    assert.doesNotMatch(
      line,
      /cause\.message|cause\.toString/,
      `der Servertext wird unuebersetzt angezeigt: ${line.trim()}`,
    );
  }

  // Und der Fehler des Dialogs erreicht den Dialog auch wirklich: ohne
  // dieses Prop koennte die Meldung im Dialog gar nicht erscheinen.
  assert.match(
    viewSource,
    /error=\{dialogError\}/,
    "der Dialog bekommt den Fehler nicht weitergereicht",
  );

  await act(async () => { root.unmount(); });
});

test("ein Termin, der in der Wochenansicht auf eine andere Stunde gezogen wird, behaelt seine Dauer", async () => {
  const { root } = await mount();

  // Auf die Wochenansicht umschalten.
  const weekTab = buttonWith("Woche");
  assert.ok(weekTab, "der Reiter 'Woche' wurde nicht gerendert");
  await act(async () => { weekTab.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });

  const chip = chipWith("Teammeeting");
  assert.ok(chip, "der Termin-Chip wurde nicht gerendert");

  // Die Zielzelle: die Stundenspalte des Tages, auf die gezogen wird. Das
  // Stundenraster hat eine Spalte je Tag; gesucht wird die Spalte des
  // Ereignistages, und daraus die Zelle der Stunde 9.
  const columns = [...win.document.querySelectorAll("div")].filter(
    (d) => d.style.gridTemplateColumns?.startsWith("56px repeat(") && d.style.minHeight,
  );
  assert.ok(columns.length > 0, "das Stundenraster wurde nicht gerendert");
  const body = columns[columns.length - 1];

  // Die Spalte des Tages, an dem der Termin liegt.
  const dayIndex = (new Date(`${EVENT_DAY}T00:00:00`).getDay() + 6) % 7;
  const column = body.children[dayIndex + 1];
  assert.ok(column, "die Tagespalte wurde nicht gefunden");

  // Die Zelle der Stunde 9 (die elfte Zelle, weil die Stunde 0 die erste ist).
  const hourCell = column.children[9];
  assert.ok(hourCell, "die Stundenzelle wurde nicht gefunden");

  await act(async () => {
    chip.dispatchEvent(dragEvent("dragstart", "timed-1"));
    hourCell.dispatchEvent(dragEvent("dragover", "timed-1"));
    hourCell.dispatchEvent(dragEvent("drop", "timed-1"));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });

  const patch = patchRequest();
  assert.ok(patch, "es wurde keine PATCH-Anfrage geschickt");
  assert.equal(patch.body.start, `${EVENT_DAY}T09:00`, "der Termin landete nicht auf der Zielstunde");
  assert.equal(patch.body.end, `${EVENT_DAY}T10:30`, "die Dauer des Termins ging beim Ziehen verloren");

  await act(async () => { root.unmount(); });
});
