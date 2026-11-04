import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as linkedom from "linkedom";
import { createJiti } from "jiti";

/**
 * `Badge` ist reine Darstellung: Props rein, HTML raus. Der Test rendert
 * deshalb ohne DOM (Rezept A der Messung in /tmp/omp-tests/scan-ui.md) und
 * haelt fest, was der Aufrufer sieht: das Element, die Variante als
 * Datenschluessel und die Klassen, die die Variante unterscheidbar machen.
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
const { Badge } = await jiti.import(`${ROOT}/components/ui/badge.tsx`);

test("Standard-Badge ist ein span mit Variante default", () => {
  const html = renderToStaticMarkup(React.createElement(Badge, null, "Neu"));
  assert.match(html, /^<span /);
  assert.match(html, /data-slot="badge"/);
  assert.match(html, /data-variant="default"/);
  assert.match(html, />Neu</);
  // Die Variante traegt die Primaerfarbe; ohne sie waere das Badge unsichtbar.
  assert.match(html, /bg-primary/);
});

test("variant waehlt die Farbklasse und setzt data-variant", () => {
  const html = renderToStaticMarkup(React.createElement(Badge, { variant: "destructive" }, "Fehler"));
  assert.match(html, /data-variant="destructive"/);
  assert.match(html, /text-destructive/);
});

test("asChild gibt das Attribut an das Kind weiter statt einen span zu bauen", () => {
  const html = renderToStaticMarkup(
    React.createElement(Badge, { asChild: true }, React.createElement("a", { href: "/x" }, "Link")),
  );
  assert.match(html, /^<a /);
  assert.match(html, /href="\/x"/);
  assert.match(html, /data-slot="badge"/);
  assert.match(html, />Link</);
});

test("eine eigene Klasse wird an die Variantenklassen angehaengt", () => {
  const html = renderToStaticMarkup(React.createElement(Badge, { className: "meine-klasse" }, "x"));
  assert.match(html, /meine-klasse/);
  assert.match(html, /data-slot="badge"/);
});
