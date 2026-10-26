import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React from "react";
import { createJiti } from "jiti";

/**
 * Der Kalender-Hook — gemessen, nicht im Quelltext nachgeschlagen.
 *
 * ### Was hier gemessen wird
 *
 * Der Befund, den der Nutzer gemeldet hat, ist im Quelltext unsichtbar: bei
 * jedem Anlegen und Loeschen eines Termins bricht der Hook eine eigene
 * HTTP-Anfrage ab (`net::ERR_ABORTED` im Netzwerk-Tab, rote Zeile in der
 * Konsole). Ein Test, der nur im Quelltext nach `abort` sucht, wuerde genau
 * das pruefen, was man nicht sehen kann — der Fehler zeigt sich erst im
 * Zusammenspiel von Anfrage, Antwortreihenfolge und Abbau.
 *
 * Deshalb wird hier der Hook gemountet und die Anfragen von Hand gesteuert:
 * `fetch` wird ersetzt, die Antworten werden in einer selbst gewaehlten
 * Reihenfolge aufgeloest, und am `signal` jeder Anfrage ist sichtbar, ob sie
 * abgebrochen wurde. Erwartet wird das Verhalten, nicht die Form des Codes.
 *
 * ### Warum `linkedom` und nicht `jsdom`
 *
 * Derselbe Harness wie in `components/calendar/calendar-event-dialog.test.mjs`:
 * `linkedom` fuehrt kein Layout aus, braucht aber auch kein Fenstersystem —
 * der Hook zeichnet nichts. `jsdom` wuerde hier nur Gewicht und
 * Nachinstallationen kosten.
 */

/* ------------------------------------------------------------------ *
 * Das Fenster
 * ------------------------------------------------------------------ */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const win = dom.window;
const fakeNavigator = { userAgent: "test", languages: ["de-DE"], language: "de-DE", platform: "linux" };

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
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

win.matchMedia = () => ({
  matches: false,
  media: "",
  addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {},
  onchange: null,
  dispatchEvent() { return false; },
});
globalThis.matchMedia = win.matchMedia;

/* ------------------------------------------------------------------ *
 * Die Anfragen
 * ------------------------------------------------------------------ */

/**
 * Alle Anfragen, die der Hook gestellt hat.
 *
 * Jede Anfrage merkt sich ihr `signal` — daran ist zu sehen, ob der Hook
 * sie abgebrochen hat — und laesst sich von Hand beantworten.
 */
let requests = [];

/**
 * Ein `EventSource`-Stub.
 *
 * `linkedom` kennt keinen `EventSource`, und der Hook oeffnet im Effekt
 * einen SSE-Strom. Der Stub merkt sich die Instanzen, damit der Test den
 * Strom eine Aenderung melden kann.
 */
class FakeEventSource {
  constructor(url) {
    this.url = String(url);
    this.listeners = new Map();
    this.onerror = null;
    this.closed = false;
    sources.push(this);
  }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  removeEventListener(type, handler) {
    const list = (this.listeners.get(type) ?? []).filter((h) => h !== handler);
    this.listeners.set(type, list);
  }
  close() { this.closed = true; }
  /** Meldet dem Hook eine Kalenderaenderung, wie der Server es tut. */
  emit(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
}

let sources = [];

globalThis.EventSource = FakeEventSource;

/**
 * Das `fetch` des Hooks.
 *
 * Die Anfrage wird gezählt und bleibt offen, bis der Test sie beantwortet.
 * Bricht der Hook das `signal` ab, lehnt die Anfrage so ab, wie es ein
 * Browser tut — mit einem `AbortError`.
 */
globalThis.fetch = (url, init = {}) => {
  const request = {
    url: String(url),
    method: init.method ?? "GET",
    signal: init.signal ?? null,
    resolve: null,
    reject: null,
  };
  const promise = new Promise((resolve, reject) => {
    request.resolve = (response) => resolve(response);
    request.reject = (cause) => reject(cause);
    request.signal?.addEventListener("abort", () => {
      reject(new DOMException("The user aborted a request.", "AbortError"));
    });
  });
  requests.push(request);
  return promise;
};

/** Eine Antwort, wie der Hook sie liest. */
function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

/** Ein Kalendertermin, an dem der Test den Stand erkennt. */
function event(id) {
  return { id, title: id, start: "2026-10-26T10:00:00.000Z", end: "2026-10-26T11:00:00.000Z" };
}

/* ------------------------------------------------------------------ *
 * Der Hook
 * ------------------------------------------------------------------ */

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { useCalendar } = await jiti.import("./useCalendar.ts");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

/**
 * Der Hook in einer winzigen Komponente.
 *
 * `sink` haelt den zuletzt gerenderten Zustand — so sieht der Test, was die
 * Oberflaeche zeigen wuerde.
 */
function Probe({ sink }) {
  const result = useCalendar();
  sink.current = result;
  return null;
}

/** Setzt Anfragen und Stroeme fuer einen Test zurueck. */
function reset() {
  requests = [];
  sources = [];
}

/** Montiert den Hook und wartet, bis der erste Ladevorgang gestellt ist. */
async function mount(sink) {
  win.document.body.innerHTML = "";
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(Probe, { sink })); });
  return root;
}

/** Ein Tick, damit die Antworten des Hooks verarbeitet werden. */
async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Beantwortet eine Anfrage und wartet auf die Verarbeitung. */
async function answer(request, response) {
  await act(async () => {
    request.resolve(response);
    await tick();
  });
}

/** Verwirft eine Anfrage mit einem Fehler und wartet auf die Verarbeitung. */
async function fail(request, cause) {
  await act(async () => {
    request.reject(cause);
    await tick();
  });
}

/** Startet einen weiteren Ladevorgang. */
async function reload(sink) {
  await act(async () => {
    void sink.current.reload();
    await tick();
  });
}

/** Haelt die Konsolenausgaben fest, damit der Testlauf lesbar bleibt. */
async function withCapturedErrors(fn) {
  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    return await fn(logged);
  } finally {
    console.error = original;
  }
}

/* ------------------------------------------------------------------ *
 * Die Messungen
 * ------------------------------------------------------------------ */

test("die juengere Antwort gewinnt, auch wenn die aeltere spaeter eintrifft", async () => {
  reset();
  const sink = { current: null };
  const root = await mount(sink);

  // Der erste Ladevorgang beim Mounten, der zweite von `reload()`.
  await reload(sink);
  assert.equal(requests.length, 2);
  const [older, newer] = requests;

  // Die juengere Antwort trifft zuerst ein.
  await answer(newer, jsonResponse({ events: [event("neu")] }));
  assert.deepEqual(sink.current.events, [event("neu")]);

  // Die aeltere Antwort trifft danach ein und darf den Stand nicht ueberschreiben.
  await answer(older, jsonResponse({ events: [event("alt")] }));
  assert.deepEqual(sink.current.events, [event("neu")]);

  await act(async () => { root.unmount(); await tick(); });
});

test("eine aeltere Antwort, die zuerst eintrifft, wird verworfen", async () => {
  reset();
  const sink = { current: null };
  const root = await mount(sink);

  await reload(sink);
  const [older, newer] = requests;

  // Die aeltere Antwort trifft zuerst ein: sie ist ueberholt und wird
  // verworfen, der alte Stand bleibt stehen.
  await answer(older, jsonResponse({ events: [event("alt")] }));
  assert.equal(sink.current.events, null);

  // Erst die juengere Antwort darf den Stand zeigen.
  await answer(newer, jsonResponse({ events: [event("neu")] }));
  assert.deepEqual(sink.current.events, [event("neu")]);

  await act(async () => { root.unmount(); await tick(); });
});

test("keine der beiden Anfragen wird abgebrochen", async () => {
  reset();
  const sink = { current: null };
  const root = await mount(sink);

  await reload(sink);
  assert.equal(requests.length, 2);

  // Der eigentliche Regressionstest: kein Request wird abgebrochen, weder
  // beim zweiten Ladevorgang noch beim Beantworten.
  assert.equal(requests[0].signal.aborted, false);
  assert.equal(requests[1].signal.aborted, false);

  await answer(requests[1], jsonResponse({ events: [event("neu")] }));
  await answer(requests[0], jsonResponse({ events: [event("alt")] }));
  assert.equal(requests[0].signal.aborted, false);
  assert.equal(requests[1].signal.aborted, false);

  // Auch beim Abbau bleibt die erste Anfrage unangetastet: abgebrochen wird
  // nur die zuletzt gestellte.
  await act(async () => { root.unmount(); await tick(); });
  assert.equal(requests[0].signal.aborted, false);
});

test("ein echter Fehler setzt den Fehlerzustand", async () => {
  reset();
  const sink = { current: null };
  const root = await mount(sink);

  await reload(sink);
  await withCapturedErrors(async (logged) => {
    await answer(requests[1], jsonResponse({ error: "kaputt" }, { ok: false, status: 500 }));
    assert.equal(sink.current.error, true);
    assert.equal(logged.length, 1);
  });

  await act(async () => { root.unmount(); await tick(); });
});

test("ein AbortError setzt keinen Fehlerzustand", async () => {
  reset();
  const sink = { current: null };
  const root = await mount(sink);

  await reload(sink);
  await withCapturedErrors(async (logged) => {
    await fail(requests[1], new DOMException("The user aborted a request.", "AbortError"));
    assert.equal(sink.current.error, false);
    assert.equal(logged.length, 0);
  });

  await act(async () => { root.unmount(); await tick(); });
});

test("ein echter Fehler einer veralteten Anfrage setzt keinen Fehlerzustand", async () => {
  reset();
  const sink = { current: null };
  const root = await mount(sink);

  await reload(sink);
  const [older, newer] = requests;

  // Die juengere Anfrage hat Erfolg.
  await answer(newer, jsonResponse({ events: [event("neu")] }));
  assert.equal(sink.current.error, false);

  // Die veraltete Anfrage meldet danach einen echten Fehler: sie hat
  // nichts zu melden, ihr Fehler betrifft einen ueberholten Stand.
  await withCapturedErrors(async (logged) => {
    await answer(older, jsonResponse({ error: "kaputt" }, { ok: false, status: 500 }));
    assert.equal(sink.current.error, false);
    assert.deepEqual(sink.current.events, [event("neu")]);
    assert.equal(logged.length, 0);
  });

  await act(async () => { root.unmount(); await tick(); });
});

test("beim Abbau wird die laufende Anfrage abgebrochen", async () => {
  reset();
  const sink = { current: null };
  const root = await mount(sink);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].signal.aborted, false);

  await act(async () => { root.unmount(); await tick(); });

  // Das ist der eine Abbruch, der bleiben soll: die Komponente ist weg,
  // die Anfrage laeuft ins Leere.
  assert.equal(requests[0].signal.aborted, true);
});

test("ein Anlegen laedt zweimal, ohne dass eine Anfrage abgebrochen wird", async () => {
  reset();
  const sink = { current: null };
  const root = await mount(sink);

  // Der Schreibvorgang.
  await act(async () => {
    void sink.current.create({ title: "Test", start: "2026-10-26T10:00:00.000Z", end: "2026-10-26T11:00:00.000Z" });
    await tick();
  });
  const write = requests[1];
  assert.equal(write.method, "POST");

  // Die Antwort auf den Schreibvorgang loest den ersten Ladevorgang aus.
  await answer(write, jsonResponse({ event: event("e1") }));
  const loadFromWrite = requests[2];
  assert.equal(loadFromWrite.method, "GET");

  // Der Server meldet die Aenderung ueber den SSE-Strom: das loest den
  // zweiten Ladevorgang aus.
  const source = sources[0];
  assert.ok(source, "der Hook oeffnet einen SSE-Strom");
  await act(async () => {
    source.emit("calendar_changed");
    await tick();
  });
  const loadFromStream = requests[3];
  assert.equal(loadFromStream.method, "GET");

  // Die juengere Anfrage gewinnt, die aeltere wird verworfen.
  await answer(loadFromStream, jsonResponse({ events: [event("e1")] }));
  await answer(loadFromWrite, jsonResponse({ events: [] }));
  assert.deepEqual(sink.current.events, [event("e1")]);

  // Und nichts davon wurde abgebrochen — genau hier stand vorher die rote
  // Zeile im Netzwerk-Tab.
  for (const request of requests.filter((r) => r.method === "GET")) {
    assert.equal(request.signal.aborted, false);
  }

  await act(async () => { root.unmount(); await tick(); });
});
