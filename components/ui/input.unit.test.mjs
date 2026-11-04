import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as linkedom from "linkedom";
import { createJiti } from "jiti";

/**
 * `Input` ist ein duennes `<input>`: der Test haelt fest, dass `type`
 * durchgereicht wird (React erkennt eine Texteingabe daran) und dass die
 * Feldklassen und eine eigene Klasse beide im Markup stehen.
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
const { Input } = await jiti.import(`${ROOT}/components/ui/input.tsx`);

test("rendert ein input mit data-slot und type", () => {
  const html = renderToStaticMarkup(React.createElement(Input, { type: "email", placeholder: "mail" }));
  assert.match(html, /^<input /);
  assert.match(html, /data-slot="input"/);
  assert.match(html, /type="email"/);
  assert.match(html, /placeholder="mail"/);
});

test("ohne type bleibt das Aussehen des Textfeldes", () => {
  const html = renderToStaticMarkup(React.createElement(Input, null));
  assert.match(html, /data-slot="input"/);
  assert.match(html, /h-8/);
  assert.doesNotMatch(html, /type="hidden"/);
});

test("eine eigene Klasse wird zusammengefuehrt", () => {
  const html = renderToStaticMarkup(React.createElement(Input, { className: "font-mono" }));
  assert.match(html, /font-mono/);
});
