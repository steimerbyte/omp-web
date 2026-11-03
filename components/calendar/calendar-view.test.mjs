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
 * Die Termine, die der Testserver ausliefert.
 *
 * Veraenderlich, damit ein Test eine andere Datenlage stellen kann (etwa
 * zwoelf Termine an einem Tag); `mount()` liest sie beim Start.
 */
let serverEvents = EVENTS;

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
  return { ok: true, json: async () => ({ events: serverEvents, event: serverEvents[0] }) };
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
const { CalendarView, visibleEventCount } = await jiti.import("../CalendarView.tsx");
// Die deutschen Texte des Kalenders — die Quelle der Beschriftungen. Der Test
// schreibt sie nicht noch einmal hin.
const { deLocale } = await jiti.import("@/lib/i18n/messages/de.ts");
const deMessages = deLocale.messages;
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

/** Ein Element ueber seine Kennung. */
const byId = (id) => win.document.getElementById(id);

/** Ein Eingabefeld ueber seine Beschriftung. */
const inputWith = (label) => win.document.querySelector(`input[aria-label="${label}"]`);

/** Das Datum eines Termintags in der Schreibweise des Dialogs: `TT.MM.JJJJ`. */
const formatDay = (date) => `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;

/** Die offene Terminliste. */
const sheet = () => win.document.querySelector('[role="dialog"]');

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
  // Kein eigener Server fuer diesen Test: er schickt keine Anfrage ab, sondern
  // liest den Quelltext der Ansicht. Ein ausgetauschter `fetch` waere hier
  // nicht nur unnoetig, sondern schaedlich — ein nicht zurueckgesetzter Ersatz
  // laesst alle spaeteren Tests auf einem fremden Datenstand sitzen.
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

// ------------------------- der Tag mit vielen Terminen als Zwischenschritt --

/**
 * Misst den Test als schmalen Bildschirm.
 *
 * `useIsMobile` liest die Breite ueber `matchMedia`; das ist der einzige Weg,
 * der Ansicht einen 390-Pixel-Bildschirm zu sagen. Der Austausch gilt nur
 * fuer die Dauer des Aufrufs.
 */
async function withMobile(run) {
  const original = win.matchMedia;
  win.matchMedia = (query) => ({
    matches: query.includes("max-width: 640px"),
    media: query,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
    onchange: null,
    dispatchEvent() { return false; },
  });
  try {
    return await run();
  } finally {
    win.matchMedia = original;
  }
}

test("schmal: ein Klick auf einen Tag oeffnet erst die Terminliste", async () => {
  await withMobile(async () => {
    const { root } = await mount();

    const chip = chipWith("Teammeeting");
    assert.ok(chip, "der Termin-Chip wurde nicht gerendert");
    const cell = chip.closest("[data-cal-cell]");
    assert.ok(cell, "die Tageszelle wurde nicht gefunden");

    await act(async () => {
      cell.dispatchEvent(new win.Event("click", { bubbles: true }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

    // Der Termin-Dialog ist **nicht** aufgegangen: erst kommt die Liste.
    assert.equal(byId("calendar-title"), null, "der Termin-Dialog ging ohne Zwischenschritt auf");
    assert.ok(
      win.document.body.textContent.includes(deMessages["calendar.selectEvent"]),
      "die Terminliste wurde nicht geoeffnet",
    );

    // Die Liste nennt beide Termine des Tages und ihre Uhrzeit.
    const rows = [...win.document.querySelectorAll("button")].filter(
      (button) => button.textContent.includes("Teammeeting") || button.textContent.includes("Urlaub"),
    );
    assert.equal(rows.length, 2, "die Liste zeigt nicht alle Termine des Tages");
    const meeting = rows.find((row) => row.textContent.includes("Teammeeting"));
    assert.match(meeting.textContent, /15:00–16:30/, "die Uhrzeit des Termins fehlt in der Liste");

    // Und *daraus* kommt der Dialog, mit dem gewaehlten Termin.
    await act(async () => { meeting.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

    const title = byId("calendar-title");
    assert.ok(title, "der Termin-Dialog ging aus der Liste nicht auf");
    assert.equal(title.value, "Teammeeting", "der Dialog hat nicht den gewaehlten Termin gefuellt");

    await act(async () => { root.unmount(); });
  });
});

test("breit: passen alle Termine in die Zelle, legt der Klick direkt an", async () => {
  const { root } = await mount();

  const chip = chipWith("Teammeeting");
  assert.ok(chip, "der Termin-Chip wurde nicht gerendert");
  const cell = chip.closest("[data-cal-cell]");
  assert.ok(cell, "die Tageszelle wurde nicht gefunden");

  await act(async () => {
    cell.dispatchEvent(new win.Event("click", { bubbles: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

  // Keine Liste, kein Zwischenschritt: auf dem Desktop ist der Klick auf die
  // Tagesflaeche das Anlegen, solange die Zelle nichts verschluckt.
  assert.equal(
    win.document.body.textContent.includes(deMessages["calendar.selectEvent"]),
    false,
    "auf dem Desktop wurde die Terminliste geoeffnet, obwohl alle Termine sichtbar sind",
  );
  const title = byId("calendar-title");
  assert.ok(title, "der Termin-Dialog ging nicht auf");
  assert.equal(title.value, "", "der Dialog ist nicht leer");

  await act(async () => { root.unmount(); });
});

test("breit mit verdeckten Terminen: der Klick auf den Tag oeffnet die Liste", async () => {
  // Ohne Layout misst das Raster keine Hoehen, und `hiddenCount` bliebe 0.
  // Fuer diesen Fall bekommt der Test ein Layout: jede Zelle 50 Pixel hoch,
  // die Tageszeile 20, ein Termin-Chip 16 — damit passt genau ein Chip
  // hinein, und eine Zelle mit zwei Terminen verschluckt einen.
  const proto = win.HTMLElement.prototype;
  const originalRect = win.Element.prototype.getBoundingClientRect;
  Object.defineProperty(proto, "clientHeight", { configurable: true, get() { return 50; } });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get() { return 20; } });
  win.Element.prototype.getBoundingClientRect = () => ({
    height: 16, width: 100, top: 0, left: 0, right: 100, bottom: 16, x: 0, y: 0,
    toJSON() { return {}; },
  });

  try {
    const { root } = await mount();

    const more = [...win.document.querySelectorAll("button")]
      .find((button) => /^\d+ weitere$/.test(button.textContent.trim()));
    assert.ok(more, "der Hinweis „N weitere\" wurde nicht gerendert");
    // Zwei Termine, Platz fuer einen: die Zelle verschluckt einen davon.
    assert.equal(more.textContent.trim(), "2 weitere", "der Hinweis nennt nicht beide verdeckten Termine");
    const cell = more.closest("[data-cal-cell]");
    assert.ok(cell, "die Tageszelle wurde nicht gefunden");

    await act(async () => {
      cell.dispatchEvent(new win.Event("click", { bubbles: true }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

    assert.equal(byId("calendar-title"), null, "der Termin-Dialog ging ohne Zwischenschritt auf");
    assert.ok(
      win.document.body.textContent.includes(deMessages["calendar.selectEvent"]),
      "die Terminliste wurde nicht geoeffnet",
    );
    // Der verdeckte Termin steht in der Liste — vorher war er nur ueber den
    // Wechsel in die Tagesansicht erreichbar.
    const rows = [...win.document.querySelectorAll("button")].filter(
      (button) => button.textContent.includes("Teammeeting") || button.textContent.includes("Urlaub"),
    );
    assert.equal(rows.length, 2, "die Liste zeigt nicht alle Termine des Tages");

    await act(async () => { root.unmount(); });
  } finally {
    delete proto.clientHeight;
    delete proto.offsetHeight;
    win.Element.prototype.getBoundingClientRect = originalRect;
  }
});

test("schmal: ein leerer Tag legt direkt an, statt die Liste zu oeffnen", async () => {
  await withMobile(async () => {
    const { root } = await mount();

    const empty = [...win.document.querySelectorAll("[data-cal-cell]")]
      .find((cell) => !cell.querySelector("[data-cal-chip]"));
    assert.ok(empty, "es gibt keine leere Tageszelle im Raster");

    await act(async () => {
      empty.dispatchEvent(new win.Event("click", { bubbles: true }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

    // Eine Liste ohne Eintraege waere ein Zwischenschritt ohne Auswahl: dort
    // gibt es nichts zu waehlen, also legt der Klick direkt an.
    assert.equal(
      win.document.body.textContent.includes(deMessages["calendar.selectEvent"]),
      false,
      "auf dem schmalen Bildschirm wurde fuer einen leeren Tag die Liste geoeffnet",
    );
    const title = byId("calendar-title");
    assert.ok(title, "der Termin-Dialog ging nicht auf");
    assert.equal(title.value, "", "der Dialog ist nicht leer");

    await act(async () => { root.unmount(); });
  });
});

test("ein Klick auf einen leeren Tag legt weiterhin direkt einen Termin an", async () => {
  const { root } = await mount();

  // Die Zelle ohne Chip — dort gibt es nichts auszuwaehlen.
  const empty = [...win.document.querySelectorAll("[data-cal-cell]")]
    .find((cell) => !cell.querySelector("[data-cal-chip]"));
  assert.ok(empty, "es gibt keine leere Tageszelle im Raster");

  await act(async () => {
    empty.dispatchEvent(new win.Event("click", { bubbles: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

  const title = byId("calendar-title");
  assert.ok(title, "der Termin-Dialog ging nicht auf");
  assert.equal(title.value, "", "der Dialog ist nicht leer");
  // Ein neuer Termin bringt seine Uhrzeit selbst mit: 09:00 bis 10:00.
  assert.equal(
    win.document.querySelector(`input[aria-label="Beginn (Uhrzeit)"]`)?.value,
    "09:00",
    "der neue Termin hat keine Beginnzeit",
  );

  await act(async () => { root.unmount(); });
});

test("auf 390 Pixeln passen alle sieben Tage in die Breite — Monat und Woche", async () => {
  await withMobile(async () => {
    const { root } = await mount();

    // Das Monatsraster: sieben Spalten, keine harte Mindestbreite. Beides
    // ist der Unterschied zwischen „alle sieben Tage sichtbar" und 672
    // Pixeln Raster auf 390 Pixeln Bildschirm.
    const month = [...win.document.querySelectorAll("div")].find(
      (d) => d.style.gridTemplateRows === "repeat(6, 1fr)",
    );
    assert.ok(month, "das Monatsraster wurde nicht gerendert");
    assert.equal(
      month.style.gridTemplateColumns,
      "repeat(7, minmax(0, 1fr))",
      "die Monatsspalten duerfen unter ihre Inhaltsbreite schrumpfen — sonst scrollt die Ansicht",
    );
    const monthBox = month.parentElement;
    assert.ok(
      ["0", "0px", ""].includes(monthBox.style.minWidth),
      `die Mindestbreite ${monthBox.style.minWidth} erzwingt seitliches Scrollen`,
    );

    // Die Wochenansicht: Stundenskala 28 statt 56, Tagesspalten ohne die
    // 120-Pixel-Untergrenze — 28 + 7 × 51 waeren sonst 896 Pixel.
    await act(async () => { buttonWith("Woche").click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

    const week = [...win.document.querySelectorAll("div")].find(
      (d) => d.style.gridTemplateColumns?.startsWith("28px repeat(7,"),
    );
    assert.ok(week, "das Wochenraster nutzt nicht die schmale Stundenskala");
    assert.equal(
      week.style.gridTemplateColumns,
      "28px repeat(7, minmax(0, 1fr))",
      "die Wochentage duerfen unter 120 Pixel schrumpfen — sonst scrollt die Ansicht",
    );

    await act(async () => { root.unmount(); });
  });
});

// ------------------------- Wochenende und senkrechtes Scrollen --

test("schmal: Wochen- und Tagesansicht scrollen senkrecht bis 24:00", async () => {
  // Der gemeldete Mangel: auf dem Handy war der Scrollbereich `hidden` —
  // das Raster endete bei etwa 18 Uhr, und was darunter lag, war nicht
  // erreichbar. Der Bereich muss in *beiden* Ansichten senkrecht scrollen,
  // und das Raster muss weiter 24 Stunden hoch sein.
  await withMobile(async () => {
    const { root } = await mount();

    for (const tab of ["Woche", "Tag"]) {
      await act(async () => { buttonWith(tab).click(); });
      await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

      const scroller = [...win.document.querySelectorAll("div")]
        .find((d) => d.style.overflowY === "auto");
      assert.ok(scroller, `${tab}: der Zeitraster-Bereich scrollt nicht senkrecht`);
      assert.equal(scroller.style.overflowX, "hidden", `${tab}: der schmale Bildschirm scrollt seitlich`);

      // 48 Pixel je Stunde, 24 Stunden: 1152 Pixel. Die Zahl steht auch im
      // Kommentar am Scrollbereich — der Test haelt sie fest.
      const hourGrid = [...win.document.querySelectorAll("div")]
        .find((d) => d.style.gridTemplateColumns?.startsWith("28px repeat(") && d.style.minHeight);
      assert.ok(hourGrid, `${tab}: das Stundenraster fehlt`);
      assert.equal(hourGrid.style.minHeight, "1152px", `${tab}: das Raster ist nicht 24 Stunden hoch`);
      assert.equal(hourGrid.children[0].children.length, 24, `${tab}: die Stundenskala endet vor 24 Uhr`);
    }

    await act(async () => { root.unmount(); });
  });
});

test("das Wochenende ist markiert — Monatskopf, Monatszellen und Wochenansicht", async () => {
  const { root } = await mount();

  // Der Monatskopf: sieben Wochentage, die letzten beiden sind Sa und So.
  const monthHeader = [...win.document.querySelectorAll("div")].find(
    (d) => d.style.gridTemplateColumns === "repeat(7, minmax(0, 1fr))" && !d.style.gridTemplateRows,
  );
  assert.ok(monthHeader, "die Wochentagskopfzeile des Monats fehlt");
  const markedHeaders = [...monthHeader.children]
    .filter((element) => element.getAttribute("data-cal-weekend") === "true");
  assert.equal(markedHeaders.length, 2, "der Monatskopf markiert nicht genau zwei Tage");
  assert.deepEqual(markedHeaders.map((element) => element.textContent), ["Sa", "So"]);

  // Die 42 Monatszellen: markiert ist die sechste und siebte Spalte jeder
  // Woche, keine Zelle eines Wochentags.
  const cells = [...win.document.querySelectorAll("[data-cal-cell]")];
  assert.equal(cells.length, 42, "das Monatsraster hat nicht 42 Zellen");
  cells.forEach((cell, index) => {
    assert.equal(
      cell.getAttribute("data-cal-weekend") === "true",
      index % 7 >= 5,
      `die Monatszelle ${index} traegt die falsche Wochenendmarkierung`,
    );
  });

  // Die Wochenansicht: zwei markierte Tagesspalten und zwei markierte
  // Kopfzellen.
  await act(async () => { buttonWith("Woche").click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

  const weekHeader = [...win.document.querySelectorAll("div")].find(
    (d) => d.style.gridTemplateColumns?.startsWith("56px repeat(") && !d.style.minHeight,
  );
  assert.ok(weekHeader, "die Datumszeile der Wochenansicht fehlt");
  // Das erste Kind ist die leere Ecke ueber der Stundenskala.
  const weekHeaderDays = [...weekHeader.children].slice(1);
  assert.equal(weekHeaderDays.length, 7);
  assert.equal(
    weekHeaderDays.filter((element) => element.getAttribute("data-cal-weekend") === "true").length,
    2,
    "die Datumszeile markiert nicht genau Sa und So",
  );

  const weekGrid = [...win.document.querySelectorAll("div")].find(
    (d) => d.style.gridTemplateColumns?.startsWith("56px repeat(") && d.style.minHeight,
  );
  assert.ok(weekGrid, "das Stundenraster der Wochenansicht fehlt");
  const weekColumns = [...weekGrid.children];
  assert.equal(weekColumns.length, 8, "die Wochenansicht hat nicht sieben Tagesspalten");
  assert.deepEqual(
    weekColumns.map((element) => element.getAttribute("data-cal-weekend") === "true"),
    [false, false, false, false, false, false, true, true],
    "markiert sind nicht die beiden Wochenendspalten",
  );

  await act(async () => { root.unmount(); });
});

// ------------------------- Uhrzeit im Dialog, aus jeder Ansicht heraus --

test("Monatsansicht: der Klick auf einen Termin-Chip fuellt die Uhrzeit des Termins", async () => {
  // Der urspruenglich gemeldete Mangel: ein Termin, der aus der Monatsansicht
  // geoeffnet wird, hatte keine Zeitfelder — weil der Monatskontext keine
  // Uhrzeit mitbringt (`preset.time === null`) und der Dialog daraus
  // "Ganztagestermin" ableitete. Hier steht der Nachweis, dass der Klick auf
  // den *Chip* die Zeiten des Termins zeigt, nicht die einer Slot-Vorbelegung.
  const { root } = await mount();

  const chip = chipWith("Teammeeting");
  assert.ok(chip, "der Termin-Chip wurde nicht gerendert");

  await act(async () => { chip.dispatchEvent(new win.Event("click", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

  const title = byId("calendar-title");
  assert.ok(title, "der Termin-Dialog ging nicht auf");
  assert.equal(title.value, "Teammeeting", "der Dialog hat einen anderen Termin geladen");
  assert.equal(byId("calendar-start-date").value, formatDay(EVENT_DAY), "das Startdatum fehlt");
  assert.equal(inputWith("Beginn (Uhrzeit)").value, "15:00", "die Beginnzeit des Termins fehlt");
  assert.equal(inputWith("Ende (Uhrzeit)").value, "16:30", "die Endzeit des Termins fehlt");
  assert.equal(inputWith("Beginn (Uhrzeit)").disabled, false, "die Beginnzeit ist nicht editierbar");
  assert.equal(inputWith("Ende (Uhrzeit)").disabled, false, "die Endzeit ist nicht editierbar");

  await act(async () => { root.unmount(); });
});

test("Wochenansicht: der Klick auf einen Termin im Zeitraster fuellt die Uhrzeit", async () => {
  // Dieselbe Zusage fuer das Zeitraster: dort kommt der Termin aus einem
  // absolut positionierten Block, nicht aus einem Chip. Der Block traegt
  // seine Uhrzeit im `title` — darueber wird er gefunden.
  const { root } = await mount();

  await act(async () => { buttonWith("Woche").click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

  const block = [...win.document.querySelectorAll("[title]")]
    .find((element) => element.getAttribute("title") === "Teammeeting · 15:00–16:30");
  assert.ok(block, "der Termin wurde im Zeitraster nicht gefunden");

  await act(async () => { block.dispatchEvent(new win.Event("click", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

  const title = byId("calendar-title");
  assert.ok(title, "der Termin-Dialog ging nicht auf");
  assert.equal(title.value, "Teammeeting", "der Dialog hat einen anderen Termin geladen");
  assert.equal(inputWith("Beginn (Uhrzeit)").value, "15:00", "die Beginnzeit des Termins fehlt");
  assert.equal(inputWith("Ende (Uhrzeit)").value, "16:30", "die Endzeit des Termins fehlt");
  assert.equal(inputWith("Beginn (Uhrzeit)").disabled, false, "die Beginnzeit ist nicht editierbar");

  await act(async () => { root.unmount(); });
});

// ------------------------- die Terminliste als Zwischenschritt --

test("Terminliste: die gewaehlte Zeile oeffnet ihren Termin, nicht den ersten", async () => {
  await withMobile(async () => {
    const { root } = await mount();

    const chip = chipWith("Teammeeting");
    const cell = chip.closest("[data-cal-cell]");
    await act(async () => { cell.dispatchEvent(new win.Event("click", { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

    const rows = [...win.document.querySelectorAll("button")]
      .filter((button) => /Urlaub|Teammeeting/.test(button.textContent));
    assert.equal(rows.length, 2, "die Liste zeigt nicht beide Termine");
    // Der Ganztagestermin beginnt um 00:00 und steht deshalb vorn — die
    // gewaehlte Zeile ist also nicht die erste. Genau das ist der Punkt.
    assert.match(rows[0].textContent, /Urlaub/, "die Liste sortiert nicht nach Beginn");

    await act(async () => { rows[1].click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

    const title = byId("calendar-title");
    assert.ok(title, "der Termin-Dialog ging nicht auf");
    assert.equal(title.value, "Teammeeting", "der Dialog zeigt nicht den gewaehlten Termin");
    assert.equal(inputWith("Beginn (Uhrzeit)").value, "15:00", "die Uhrzeit gehoert nicht zu diesem Termin");

    await act(async () => { root.unmount(); });
  });
});

test("Terminliste: „Neuer Termin\" oeffnet einen leeren Dialog am Tag der Liste", async () => {
  await withMobile(async () => {
    const { root } = await mount();

    const chip = chipWith("Teammeeting");
    const cell = chip.closest("[data-cal-cell]");
    await act(async () => { cell.dispatchEvent(new win.Event("click", { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

    // Der Knopf im Fuss der Liste — nicht der in der Kalender-Kopfzeile, der
    // den Termin am gewaehlten Tag des Kalenders anlegt.
    const create = [...sheet().querySelectorAll("button")]
      .find((button) => button.textContent.trim() === deMessages["calendar.newEvent"]);
    assert.ok(create, "der Knopf „Neuer Termin\" fehlt in der Liste");

    await act(async () => { create.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

    const title = byId("calendar-title");
    assert.ok(title, "der Termin-Dialog ging nicht auf");
    assert.equal(title.value, "", "der Dialog ist nicht leer");
    assert.equal(
      byId("calendar-start-date").value,
      formatDay(EVENT_DAY),
      "der neue Termin steht nicht am Tag der Liste",
    );

    await act(async () => { root.unmount(); });
  });
});

test("Terminliste: zwoelf Termine stehen vollstaendig im DOM und die Liste scrollt", async () => {
  // Ein Tag mit mehr Terminen, als auf einen Bildschirm passen: die Liste darf
  // keinen davon verschlucken und muss selbst scrollen, statt den Dialog auf
  // die volle Hoehe wachsen zu lassen.
  const many = Array.from({ length: 12 }, (_, index) => ({
    id: `many-${index}`,
    title: `Termin ${index + 1}`,
    description: undefined,
    location: undefined,
    start: `${EVENT_DAY}T${pad(7 + index)}:00`,
    end: `${EVENT_DAY}T${pad(7 + index)}:30`,
    allDay: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }));
  serverEvents = many;
  try {
    await withMobile(async () => {
      const { root } = await mount();

      const chip = chipWith("Termin 1");
      assert.ok(chip, "der erste Termin wurde nicht gerendert");
      const cell = chip.closest("[data-cal-cell]");
      await act(async () => { cell.dispatchEvent(new win.Event("click", { bubbles: true })); });
      await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

      const rows = [...sheet().querySelectorAll("button")]
        .filter((button) => /^Termin \d+/.test(button.textContent.trim()));
      assert.equal(rows.length, 12, "die Liste verschluckt Termine");

      const list = [...sheet().querySelectorAll("div")]
        .find((element) => element.style.overflowY === "auto" || element.style.overflowY === "scroll");
      assert.ok(list, "die Liste hat keinen eigenen Scrollbereich");
      assert.equal(list.style.overflowY, "auto", "die Liste scrollt nicht selbst");

      await act(async () => { root.unmount(); });
    });
  } finally {
    serverEvents = EVENTS;
  }
});

// ------------------------- die Kapazitaetsrechnung der Monatszelle --

test("die Kapazitaetsrechnung zeigt, was passt, und meldet den Rest als verdeckt", async () => {
  // 50 px Zelle, 18 px Tageszeile, 16 px Chip: 32 px stehen den Chips zur
  // Verfuegung, also genau zwei. Der Grenzfall ist der Unterschied zwischen
  // "passt" und "einer zu viel".
  assert.deepEqual(
    visibleEventCount(2, 50, 18, 16),
    { shown: 2, hidden: 0 },
    "zwei passende Termine muessen beide gezeigt werden",
  );
  assert.deepEqual(
    visibleEventCount(3, 50, 18, 16),
    { shown: 1, hidden: 2 },
    "bei einem Termin zu viel bleibt eine Zeile fuer den Hinweis frei",
  );

  // Ohne Messung (Zelle noch nicht im Layout) wird nichts abgeschnitten —
  // sonst verschwaende beim ersten Rendern jeder Termin.
  assert.deepEqual(visibleEventCount(3, 0, 18, 16), { shown: 3, hidden: 0 });
});
