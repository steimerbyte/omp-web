import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as linkedom from "linkedom";
import { createJiti } from "jiti";

/**
 * `Button` ist ein reiner Wrapper um `<button>` (oder das Kind bei `asChild`).
 * Geprueft wird, was der Aufrufer unterscheiden kann: Element, Datenschluessel,
 * und dass `variant`, `size` und `className` tatsaechlich im Markup landen.
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
const { Button } = await jiti.import(`${ROOT}/components/ui/button.tsx`);

test("Standard-Button ist ein button mit Variante und Groesse default", () => {
  const html = renderToStaticMarkup(React.createElement(Button, null, "Speichern"));
  assert.match(html, /^<button /);
  assert.match(html, /data-slot="button"/);
  assert.match(html, /data-variant="default"/);
  assert.match(html, /data-size="default"/);
  assert.match(html, />Speichern</);
  assert.match(html, /bg-primary/);
});

test("size icon setzt die quadratische Groesse", () => {
  const html = renderToStaticMarkup(React.createElement(Button, { size: "icon" }, "×"));
  assert.match(html, /data-size="icon"/);
  assert.match(html, /size-8/);
});

test("variant destructive traegt die Fehlerfarbe", () => {
  const html = renderToStaticMarkup(React.createElement(Button, { variant: "destructive" }, "Löschen"));
  assert.match(html, /data-variant="destructive"/);
  assert.match(html, /text-destructive/);
});

test("asChild rendert das Kind (a) und haengt die Button-Klassen daran", () => {
  const html = renderToStaticMarkup(
    React.createElement(Button, { asChild: true }, React.createElement("a", { href: "/weiter" }, "Weiter")),
  );
  assert.match(html, /^<a /);
  assert.match(html, /href="\/weiter"/);
  assert.match(html, /data-slot="button"/);
  // Die Klassen des Buttons landen auf dem Anker — sonst saehe der Link aus
  // wie ein Link und nicht wie der Knopf, den er ersetzt.
  assert.match(html, /inline-flex/);
});

test("eine eigene Klasse wird zusammengefuehrt", () => {
  const html = renderToStaticMarkup(React.createElement(Button, { className: "w-full" }, "x"));
  assert.match(html, /w-full/);
});

test("type wird durchgereicht", () => {
  const html = renderToStaticMarkup(React.createElement(Button, { type: "submit" }, "x"));
  assert.match(html, /type="submit"/);
});
