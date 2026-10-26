import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React from "react";
import { createJiti } from "jiti";
import { ICS_MIT_ALLEN_NEUN, VERWORFENE_FORMATE, dateiMit } from "../../test/calendar-formats.mjs";

/**
 * Der ICS-Import — gemessen, nicht im Quelltext nachgeschlagen.
 *
 * ### Was hier geprueft wird
 *
 * Der Import hat eine Eigenschaft, die kein anderer Kalenderknopf hat: er
 * **schreibt**. Ein Fehler in der Reihenfolge von "Vorschau" und "Schreiben"
 * waere ein Datenverlust, und ein Fehler im Ort der Fehlermeldung waere eine
 * Oberflaeche, die dem Nutzer die Schuld an ihrem Problem gibt.
 *
 * Deshalb wird hier nicht geprueft, dass eine Funktion aufgerufen wurde,
 * sondern was der Nutzer sieht und was der Server bekommt:
 *
 * - Der erste Request geht **ohne** `apply` raus, und das, was er zurueckgibt,
 *   steht als Vorschau im Dialog.
 * - Der Request, der schreibt, traegt `apply: true`.
 * - Eine zu grosse Datei erzeugt **gar keinen** Request.
 * - Ein Serverfehler steht **im Dialog** — nicht in einer Leiste dahinter.
 * - Eine Datei ohne Termine wird als solche gemeldet, nicht als Erfolg.
 *
 * ### Der Datei-Eingang
 *
 * `linkedom` kennt `input.files` nicht. Der Test legt die Datei deshalb
 * selbst auf den Eingang — genau so, wie der Browser es nach der Auswahl
 * tut — und schickt danach das `change`-Ereignis, das React abwartet.
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

/**
 * `motion` (die Animationen der Dialogbausteine) prueft mit
 * `subject instanceof HTMLElement`, ob es eine Web-Animation benutzen kann.
 * `HTMLElement` steht in `linkedom` nicht unter den *eigenen* Eigenschaften
 * des Fensters, der Loop weiter unten kopiert es deshalb nicht — ohne den
 * globalen Namen bricht die Messung mitten in der Animation ab.
 */
globalThis.HTMLElement = win.HTMLElement;
globalThis.Element = win.Element;
globalThis.Node = win.Node;

/**
 * React 19 schaltet seinen `change`-Pfad an der Existenz von `oninput` auf dem
 * `document` fest. `linkedom` hat `oninput` nicht, also fiel
 * `isInputEventSupported` in diesem Harness dauerhaft auf `false`.
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

/**
 * Der Server des Tests.
 *
 * Die Route antwortet mit `{ applied, events, report }`. Der Test stellt
 * hier die Antwort ein, die die Oberflaeche sehen soll, und liest danach ab,
 * was sie dem Server *geschickt* hat — der Body ist das einzige, was
 * entscheidet, ob geschrieben wird.
 */
const requests = [];

/** Die Antwort, die der Server als naechstes gibt. */
let nextResponse = null;

globalThis.fetch = async (url, init) => {
  requests.push({
    url: String(url),
    method: init?.method ?? "GET",
    body: init?.body ? JSON.parse(init.body) : null,
  });
  const answer = nextResponse ?? {
    ok: true,
    status: 200,
    json: async () => ({
      applied: false,
      events: [],
      report: {
        imported: 2,
        skipped: [],
        ignored: {
          alarms: 0, attendees: 0, categories: 0, organizers: 0, urls: 0,
          statuses: 0, transparencies: 0, timezones: 0, otherComponents: 0,
        },
        unexpandedRecurrences: 0,
        warnings: [],
      },
    }),
  };
  nextResponse = null;
  return answer;
};

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { CalendarImportButton } = await jiti.import("./CalendarImport.tsx");
// Die Grenze kommt aus dem Modul, nicht aus dem Test — sonst prueft der
// Test seine eigene Zahl statt der Zahl der Route.
// `parseCalendarIcs` kommt dazu, weil die Zaehler der verworfenen Formate
// im Bericht des Parsers stehen — die Vorschau zeigt sie weiter, und ein
// Test, der sich seine Zaehler selbst ausdenkt, prueft seine Ausgedanken.
const { MAX_ICS_BYTES, parseCalendarIcs } = await jiti.import("@/lib/calendar-ics.ts");
// Das deutsche Sprachpaket — die **Quelle** der deutschen Bezeichner. Der
// Test schreibt sie nicht noch einmal hin, sondern liest sie hier: so
// zaehlt der Test die Bezeichner, die der Dialog wirklich zeigt.
const { deLocale } = await jiti.import("@/lib/i18n/messages/de.ts");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

/**
 * Der deutsche Name, den die Vorschau fuer ein verworfenes Format nennen
 * muss — aus dem deutschen Sprachpaket gelesen.
 */
function deutscherName(format) {
  const name = deLocale.messages[format.labelKey];
  assert.equal(
    typeof name,
    "string",
    `das deutsche Sprachpaket kennt keinen Bezeichner fuer „${format.key}“ (${format.labelKey})`,
  );
  return name;
}

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:one@example.com",
  "DTSTART:20261028T140000",
  "DTEND:20261028T150000",
  "SUMMARY:Teammeeting",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

/**
 * Eine Datei, die **etwas Verworfenes** enthaelt: eine Erinnerung
 * (`VALARM`) und eine Aufgabe (`VTODO`). Beide zaehlt der Parser — die
 * Vorschau darf nur die nennen, deren Zaehler groesser als null ist.
 */
const ICS_MIT_VERWORFENEM = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:one@example.com",
  "DTSTART:20261028T140000",
  "DTEND:20261028T150000",
  "SUMMARY:Teammeeting",
  "BEGIN:VALARM",
  "TRIGGER:-PT15M",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VTODO",
  "UID:aufgabe@example.com",
  "SUMMARY:Aufgabe",
  "END:VTODO",
  "END:VCALENDAR",
].join("\r\n");

/**
 * Die Antwort der Import-Route fuer eine Datei — mit dem Bericht des
 * **echten** Parsers.
 *
 * Die Zaehler der verworfenen Formate stehen im Bericht des Parsers, und
 * die Vorschau zeigt sie weiter. Ein Test, der sich seine Zaehler selbst
 * ausdenkt, prueft seine Ausgedanken — deshalb laeuft die Datei hier durch
 * `parseCalendarIcs`, und die Antwort ist das, was die Route auch liefert.
 */
function routeAnswer(ics) {
  const parsed = parseCalendarIcs(ics);
  return {
    applied: false,
    events: parsed.events.map((entry) => entry.event),
    report: parsed.report,
  };
}

/**
 * Der Bericht, den der Server fuer einen erfolgreichen Lauf zurueckgibt.
 */
function report(overrides = {}) {
  return {
    imported: 2,
    skipped: [],
    ignored: {
      alarms: 0, attendees: 0, categories: 0, organizers: 0, urls: 0,
      statuses: 0, transparencies: 0, timezones: 0, otherComponents: 0,
    },
    unexpandedRecurrences: 0,
    warnings: [],
    ...overrides,
  };
}

async function mount(props = {}) {
  requests.length = 0;
  win.document.body.innerHTML = "";
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(CalendarImportButton, props)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
  return { container, root };
}

/** Die Datei, die der Nutzer auswaehlt. */
function fakeFile(name, content, size) {
  return {
    name,
    size: size ?? content.length,
    async text() { return content; },
  };
}

/**
 * Waehlt eine Datei aus, wie der Browser es tut.
 *
 * `linkedom` kennt `input.files` nicht — der Test legt die Datei deshalb auf
 * den Eingang und schickt danach das `change`-Ereignis.
 */
async function chooseFile(file) {
  const input = win.document.querySelector('input[type="file"]');
  assert.ok(input, "der Datei-Eingang wurde nicht gerendert");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new win.Event("change", { bubbles: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
}

const buttons = () => [...win.document.querySelectorAll("button")];
const buttonWith = (text) => buttons().find((b) => b.textContent.trim() === text);
const dialog = () => win.document.querySelector('[role="dialog"]');
const alertBox = () => win.document.querySelector('[role="alert"]');
/** Der sichtbare Text des Dialogs — als eine Zeile, ohne Leerraum-Rauschen. */
const dialogText = () => (dialog()?.textContent ?? "").replace(/\s+/g, " ").trim();

/**
 * Die Eintraege des Blocks „Diese Angaben wurden nicht uebernommen" — oder
 * `null`, wenn es den Block gar nicht gibt.
 *
 * Der Block wird an seiner Ueberschrift erkannt, nicht an einer Reihenfolge
 * von Listeneintraegen: es geht darum, **welche** Zeilen der Dialog zeigt,
 * nicht darum, dass er ueberhaupt eine Liste hat.
 */
function ignoredItems() {
  const title = [...(dialog()?.querySelectorAll("div") ?? [])]
    .find((node) => node.textContent.trim() === "Diese Angaben wurden nicht übernommen");
  if (!title) return null;
  const list = title.parentElement?.querySelector("ul");
  if (!list) return [];
  return [...list.querySelectorAll("li")].map((li) => li.textContent.trim());
}

test("der erste Request liest nur — die Vorschau erscheint, und es wird nichts geschrieben", async () => {
  await mount();

  await chooseFile(fakeFile("kalender.ics", ICS));

  assert.equal(requests.length, 1, "es wurde nicht genau eine Anfrage geschickt");
  const [request] = requests;
  assert.equal(request.url, "/api/calendar/import");
  assert.equal(request.method, "POST");
  assert.equal(request.body.apply, false, "der erste Request muss ohne `apply` gehen");
  assert.equal(request.body.ics, ICS, "der Inhalt der Datei kam nicht an");

  // Die Vorschau steht im Dialog.
  assert.ok(dialog(), "der Dialog wurde nicht geoeffnet");
  assert.match(dialogText(), /2 Termine in der Vorschau/);
  assert.ok(buttonWith("Importieren"), "der Import-Knopf fehlt in der Vorschau");
  assert.ok(buttonWith("Abbrechen"), "der Abbrechen-Knopf fehlt in der Vorschau");
});

test("der Knopf „Importieren“ schickt `apply: true`", async () => {
  await mount();

  await chooseFile(fakeFile("kalender.ics", ICS));

  const apply = buttonWith("Importieren");
  assert.ok(apply, "der Import-Knopf fehlt in der Vorschau");
  await act(async () => { apply.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

  assert.equal(requests.length, 2, "der Import hat keinen zweiten Request erzeugt");
  assert.equal(requests[1].body.apply, true, "der schreibende Request muss `apply: true` tragen");
  assert.match(dialogText(), /2 Termine importiert/);
});

test("eine zu grosse Datei erzeugt keinen Request, sondern eine Meldung", async () => {
  await mount();

  await chooseFile(fakeFile("riesig.ics", ICS, MAX_ICS_BYTES + 1));

  assert.equal(requests.length, 0, "eine zu grosse Datei wurde dem Server trotzdem geschickt");
  const alert = alertBox();
  assert.ok(alert, "die Meldung ueber die zu grosse Datei fehlt");
  assert.match(alert.textContent, /zu groß/);
});

test("ein Serverfehler erscheint im Dialog — nicht in einer Leiste dahinter", async () => {
  await mount();

  // Genau die Antwort der Route bei einer Datei, die kein Kalender ist.
  nextResponse = {
    ok: false,
    status: 400,
    json: async () => ({ error: "The text is not an ICS calendar (no BEGIN:VCALENDAR)" }),
  };

  await chooseFile(fakeFile("notiz.txt", "Hallo Welt"));

  assert.equal(requests.length, 1);
  const alert = alertBox();
  assert.ok(alert, "die Fehlermeldung fehlt ganz");
  // Der Kern des gemeldeten Fehlers: die Meldung muss **im** Dialog stehen.
  // Eine Meldung hinter dem Dialog waere fuer den Nutzer unsichtbar.
  assert.ok(dialog(), "der Dialog wurde nicht geoeffnet");
  assert.ok(
    dialog().contains(alert),
    "die Fehlermeldung steht nicht im Dialog, sondern irgendwo dahinter",
  );
  // Die deutsche Ueberschrift kommt aus dem Statuscode, der englische
  // Originaltext steht als Nachweis darunter.
  assert.match(alert.textContent, /kein gültiger ICS-Kalender/);
  assert.match(alert.textContent, /not an ICS calendar/);
});

test("der Statuscode nennt die deutsche Ueberschrift — der englische Text wird nicht uebersetzt", async () => {
  await mount();

  // Genau die Antwort der Route bei fehlender Berechtigung.
  nextResponse = {
    ok: false,
    status: 403,
    json: async () => ({ error: "Access denied" }),
  };

  await chooseFile(fakeFile("kalender.ics", ICS));

  const alert = alertBox();
  assert.ok(alert, "die Fehlermeldung fehlt ganz");
  assert.ok(dialog()?.contains(alert), "die Fehlermeldung steht nicht im Dialog");
  assert.match(alert.textContent, /Zugriff auf den Kalender verweigert/);
  // Der Originaltext steht da, wird aber nicht uebersetzt: er ist der
  // Nachweis, nicht die Erklaerung.
  assert.match(alert.textContent, /Access denied/);
});

test("eine Datei ohne Termine wird als solche gemeldet, nicht als Erfolg verbucht", async () => {
  await mount();

  nextResponse = {
    ok: true,
    status: 200,
    json: async () => ({ applied: false, events: [], report: report({ imported: 0 }) }),
  };

  await chooseFile(fakeFile("leer.ics", "BEGIN:VCALENDAR\r\nEND:VCALENDAR"));

  assert.match(dialogText(), /enthält keine Termine/);
  assert.doesNotMatch(dialogText(), /importiert/);

  // Ohne Termine gibt es nichts zu schreiben — der Knopf ist deaktiviert,
  // und ein Klick schickt trotzdem keinen Request.
  const apply = buttonWith("Importieren");
  assert.ok(apply, "der Import-Knopf fehlt");
  assert.equal(apply.disabled, true, "der Import-Knopf ist aktiv, obwohl nichts zu importieren ist");
  await act(async () => { apply.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
  assert.equal(requests.length, 1, "es wurde trotzdem geschrieben");
});

test("die Zahl steht im richtigen Numerus — ein Termin, drei Termine", async () => {
  await mount();

  nextResponse = {
    ok: true,
    status: 200,
    json: async () => ({ applied: false, events: [], report: report({ imported: 1 }) }),
  };

  await chooseFile(fakeFile("eins.ics", ICS));

  // Ein Termin: "1 Termin in der Vorschau" — nicht "1 Termine".
  assert.match(dialogText(), /1 Termin in der Vorschau/);
  assert.doesNotMatch(dialogText(), /1 Termine/);
});

test("eine Datei ohne verworfene Formate zeigt den Block nicht — keine Überschrift, kein Zähler", async () => {
  await mount();

  // Die Antwort der Route fuer die einfache Datei — der Bericht kommt aus
  // dem echten Parser, und der zaehlt bei dieser Datei nichts.
  nextResponse = {
    ok: true,
    status: 200,
    json: async () => routeAnswer(ICS),
  };

  await chooseFile(fakeFile("kalender.ics", ICS));

  // Der Bericht des Parsers traegt hier ueberall eine Null.
  const parsed = parseCalendarIcs(ICS);
  for (const [name, count] of Object.entries(parsed.report.ignored)) {
    assert.equal(count, 0, `der Zaehler ${name} ist nicht null — die Datei traegt doch etwas Verworfenes`);
  }

  // Eine Liste voller Nullen ist Rauschen: der Block darf gar nicht da sein.
  assert.equal(ignoredItems(), null, "der Block „Diese Angaben wurden nicht übernommen“ steht im Dialog");
  assert.doesNotMatch(dialogText(), /nicht übernommen/);
  // Und kein Zaehler irgendwo im Dialog.
  assert.doesNotMatch(dialogText(), /:\s*0\b/);
});

test("eine Datei mit verworfenen Formaten nennt nur die Zähler über null", async () => {
  await mount();

  // Der Bericht kommt aus dem echten Parser: die Datei traegt eine
  // Erinnerung (`VALARM`) und eine Aufgabe (`VTODO`).
  nextResponse = {
    ok: true,
    status: 200,
    json: async () => routeAnswer(ICS_MIT_VERWORFENEM),
  };

  await chooseFile(fakeFile("kalender.ics", ICS_MIT_VERWORFENEM));

  const items = ignoredItems();
  assert.ok(items, "der Block „Diese Angaben wurden nicht übernommen“ fehlt im Dialog");
  // Nur die zwei Bestandteile, die wirklich vorkommen — mit ihrer Zahl.
  assert.deepEqual(
    [...items].sort(),
    ["Erinnerungen: 1", "Sonstige Kalenderbestandteile: 1"],
  );
  // Und keine Zeile mit einer Null: die uebrigen sieben Zaehler sind null
  // und stehen nicht da.
  for (const item of items) {
    assert.doesNotMatch(item, /:\s*0\b/, `die Zeile „${item}" nennt einen Zaehler von null`);
  }
});

test("eine Notiz über 4000 Zeichen wird beim Import gekürzt — und die Warnung steht in der Vorschau", async () => {
  await mount();

  // Die Datei traegt eine Notiz mit 4001 Zeichen.
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:one@example.com",
    "DTSTART:20261028T140000",
    "DTEND:20261028T150000",
    "SUMMARY:Teammeeting",
    `DESCRIPTION:${"a".repeat(4001)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  // Die Grenze sitzt bei 4000 Zeichen: das 4001. faellt weg, der Rest
  // bleibt stehen. Die Zahl steht so in `docs/calendar.md` — sie wird hier
  // festgehalten, damit eine Aenderung an der Konstante nicht unbemerkt
  // durchgeht.
  const parsed = parseCalendarIcs(ics);
  assert.equal(parsed.events[0].event.description.length, 4000);
  assert.equal(parsed.events[0].event.description, "a".repeat(4000));

  nextResponse = {
    ok: true,
    status: 200,
    json: async () => routeAnswer(ics),
  };

  await chooseFile(fakeFile("kalender.ics", ics));

  // Und der Nutzer erfaehrt es: die Warnung des Parsers steht in der
  // Vorschau, mit der Zahl, die gegriffen hat.
  assert.match(dialogText(), /4000 Zeichen und wurde gekuerzt/);
});

test("ein Ort über 4000 Zeichen wird beim Import gekürzt — und die Warnung steht in der Vorschau", async () => {
  await mount();

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:one@example.com",
    "DTSTART:20261028T140000",
    "DTEND:20261028T150000",
    "SUMMARY:Teammeeting",
    `LOCATION:${"a".repeat(4001)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const parsed = parseCalendarIcs(ics);
  assert.equal(parsed.events[0].event.location.length, 4000);
  assert.equal(parsed.events[0].event.location, "a".repeat(4000));

  nextResponse = {
    ok: true,
    status: 200,
    json: async () => routeAnswer(ics),
  };

  await chooseFile(fakeFile("kalender.ics", ics));

  assert.match(dialogText(), /4000 Zeichen und wurde gekuerzt/);
});

// ------------------------------------------- die neun verworfenen Formate --

test("die Vorschau nennt alle neun verworfenen Formate mit ihrem deutschen Namen — kein Rohschluessel", async () => {
  await mount();

  // Die Datei traegt alle neun Formate — der Bericht des echten Parsers
  // zaehlt jede genau einmal.
  nextResponse = {
    ok: true,
    status: 200,
    json: async () => routeAnswer(ICS_MIT_ALLEN_NEUN),
  };

  await chooseFile(fakeFile("kalender.ics", ICS_MIT_ALLEN_NEUN));

  const items = ignoredItems();
  assert.ok(items, "der Block „Diese Angaben wurden nicht übernommen“ fehlt im Dialog");

  // Der Dialog nennt **jedes** Format mit seinem deutschen Namen — nicht den
  // Schluessel des Berichts. Der Schluessel waere der Fallback der
  // Oberflaeche, wenn ein Bezeichner fehlte: er faellt still darauf
  // zurueck, und der Nutzer saehe einen englischen Bezeichner.
  const erwartet = VERWORFENE_FORMATE.map((format) => `${deutscherName(format)}: 1`);
  assert.deepEqual([...items].sort(), [...erwartet].sort());

  // Und kein Schluessel des Berichts taucht auf.
  for (const format of VERWORFENE_FORMATE) {
    assert.ok(
      !items.some((item) => item.startsWith(`${format.key}:`)),
      `die Vorschau zeigt den Rohschluessel „${format.key}“ statt eines deutschen Bezeichners`,
    );
  }
});

test("jede der neun Formate erscheint in der Vorschau mit ihrem eigenen deutschen Namen", async () => {
  // Jede Datei traegt genau ein Format — so belegt die Vorschau, welcher
  // Bezeichner zu welchem Zaehler gehoert, statt nur, dass es neun
  // Bezeichner gibt.
  for (const format of VERWORFENE_FORMATE) {
    const ics = dateiMit(format.zeilen);

    await mount();
    nextResponse = {
      ok: true,
      status: 200,
      json: async () => routeAnswer(ics),
    };
    await chooseFile(fakeFile("kalender.ics", ics));

    const items = ignoredItems();
    assert.ok(items, `der Block fehlt fuer „${format.key}“`);
    assert.deepEqual(
      items,
      [`${deutscherName(format)}: 1`],
      `das Format „${format.key}“ erscheint nicht als „${deutscherName(format)}“`,
    );
  }
});
