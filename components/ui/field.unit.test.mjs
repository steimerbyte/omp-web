import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as linkedom from "linkedom";
import { createJiti } from "jiti";

/**
 * Die Feld-Bausteine sind reine Darstellung. Der Test rendert jeden einmal
 * und prueft das, was der Aufrufer bzw. der Screenreader sieht: Rolle,
 * `data-slot`, die Ausrichtung und die Fehlerliste.
 *
 * `FieldError` hat die einzige Logik der Datei: es dedupliziert Meldungen und
 * entscheidet zwischen einer einzelnen Meldung und einer Liste. Genau diese
 * Zweige werden hier mit konkreten Eingaben durchlaufen.
 */

/* Ein Dokument muss VOR dem jiti-Import existieren: Radix entscheidet beim
 * Laden seiner Module einmal pro Prozess, ob `useLayoutEffect` zur Verfuegung
 * steht (`globalThis?.document`). Fehlt es hier, wird es prozessweit zur
 * No-Op — und jede spaetere DOM-Testdatei im selben Lauf verliert ihre
 * Effekte, obwohl sie selbst ein Fenster installiert. */
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
win.getComputedStyle = () => new Proxy({}, { get: (_t, p) => (typeof p === "string" && p.startsWith("get") ? () => "" : "0px") });
globalThis.window = win;
globalThis.document = win.document;
globalThis.navigator = { userAgent: "test", languages: ["de-DE"], language: "de-DE", platform: "linux" };
globalThis.getComputedStyle = win.getComputedStyle;
win.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent() { return false; } });
globalThis.matchMedia = win.matchMedia;

const ROOT = process.cwd();
const jiti = createJiti(`${ROOT}/package.json`, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { Field, FieldLabel, FieldDescription, FieldError, FieldGroup, FieldLegend, FieldSeparator, FieldSet, FieldContent, FieldTitle } =
  await jiti.import(`${ROOT}/components/ui/field.tsx`);

const html = (element) => renderToStaticMarkup(element);

test("FieldSet rendert ein fieldset mit data-slot", () => {
  const out = html(React.createElement(FieldSet, { className: "gap-2" }, "x"));
  assert.match(out, /^<fieldset /);
  assert.match(out, /data-slot="field-set"/);
  assert.match(out, /gap-2/);
});

test("FieldLegend traegt die Variante als Datenschluessel", () => {
  assert.match(html(React.createElement(FieldLegend, null, "Titel")), /^<legend /);
  const standard = html(React.createElement(FieldLegend, null, "Titel"));
  assert.match(standard, /data-slot="field-legend"/);
  assert.match(standard, /data-variant="legend"/);
  const klein = html(React.createElement(FieldLegend, { variant: "label" }, "Titel"));
  assert.match(klein, /data-variant="label"/);
  // Die Variante entscheidet ueber die Schriftgroesse: sonst waere sie nur ein
  // Datenattribut ohne Wirkung.
  assert.match(klein, /data-\[variant=label\]:text-sm/);
});

test("FieldGroup rendert einen div-Container", () => {
  const out = html(React.createElement(FieldGroup, null, "x"));
  assert.match(out, /^<div /);
  assert.match(out, /data-slot="field-group"/);
  assert.match(out, /field-group/);
});

test("Field ist eine Gruppe und meldet ihre Ausrichtung", () => {
  const standard = html(React.createElement(Field, null, "x"));
  assert.match(standard, /role="group"/);
  assert.match(standard, /data-slot="field"/);
  assert.match(standard, /data-orientation="vertical"/);
  assert.match(standard, /flex-col/);

  const waagerecht = html(React.createElement(Field, { orientation: "horizontal" }, "x"));
  assert.match(waagerecht, /data-orientation="horizontal"/);
  assert.match(waagerecht, /flex-row/);
});

test("FieldContent, FieldTitle und FieldDescription sind eigene Slots", () => {
  assert.match(html(React.createElement(FieldContent, null, "x")), /data-slot="field-content"/);
  assert.match(html(React.createElement(FieldTitle, null, "x")), /data-slot="field-label"/);
  const beschreibung = html(React.createElement(FieldDescription, null, "Hilfe"));
  assert.match(beschreibung, /^<p /);
  assert.match(beschreibung, /data-slot="field-description"/);
  assert.match(beschreibung, /Hilfe/);
});

test("FieldLabel ist ein Label, das auf sein Feld zeigt", () => {
  const out = html(React.createElement(FieldLabel, { htmlFor: "titel" }, "Titel"));
  assert.match(out, /^<label /);
  assert.match(out, /data-slot="field-label"/);
  assert.match(out, /for="titel"/);
});

test("FieldSeparator ohne Text ist nur eine Linie", () => {
  const out = html(React.createElement(FieldSeparator));
  assert.match(out, /data-slot="field-separator"/);
  assert.match(out, /data-content="false"/);
  assert.doesNotMatch(out, /field-separator-content/);
});

test("FieldSeparator mit Text zeigt den Text zwischen den Linien", () => {
  const out = html(React.createElement(FieldSeparator, null, "oder"));
  assert.match(out, /data-content="true"/);
  assert.match(out, /data-slot="field-separator-content"/);
  assert.match(out, />oder</);
});

test("FieldError ohne Inhalt rendert gar nichts", () => {
  assert.equal(html(React.createElement(FieldError)), "");
  assert.equal(html(React.createElement(FieldError, { errors: [] })), "");
  assert.equal(html(React.createElement(FieldError, { errors: [undefined] })), "");
});

test("FieldError zeigt eine einzelne Meldung als Text, nicht als Liste", () => {
  const out = html(React.createElement(FieldError, { errors: [{ message: "Pflichtfeld" }] }));
  assert.match(out, /role="alert"/);
  assert.match(out, /data-slot="field-error"/);
  assert.match(out, /Pflichtfeld/);
  assert.doesNotMatch(out, /<ul/);
});

test("FieldError dedupliziert gleiche Meldungen", () => {
  const out = html(React.createElement(FieldError, { errors: [{ message: "Zu kurz" }, { message: "Zu kurz" }] }));
  // Eine Meldung, kein Listenpunkt: der Nutzer soll den Satz einmal lesen.
  assert.doesNotMatch(out, /<ul/);
  assert.equal(out.match(/Zu kurz/g).length, 1);
});

test("FieldError listet verschiedene Meldungen auf", () => {
  const out = html(React.createElement(FieldError, {
    errors: [{ message: "Zu kurz" }, { message: "Nur Buchstaben" }, { message: "Zu kurz" }],
  }));
  assert.match(out, /<ul/);
  assert.equal(out.match(/<li/g).length, 2);
  assert.match(out, /Nur Buchstaben/);
});

test("FieldError bevorzugt explizite Kinder vor errors", () => {
  const out = html(React.createElement(FieldError, { errors: [{ message: "aus errors" }] }, "aus children"));
  assert.match(out, /aus children/);
  assert.doesNotMatch(out, /aus errors/);
});
