import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

/**
 * Der gemeinsame Schalter. Seine Geometrie steckt in Inline-Styles; geprueft
 * wird, was Aufrufer und Screenreader sehen: Zustand, Beschriftung und die
 * beiden Attribute, ueber die die Panels den Knopf in Tests finden.
 */

const ROOT = process.cwd();
const jiti = createJiti(`${ROOT}/package.json`, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { Toggle } = await jiti.import(`${ROOT}/components/ui/toggle.tsx`);

test("ist ein type=button und traegt Zustand plus Beschriftung", () => {
  const html = renderToStaticMarkup(
    React.createElement(Toggle, { checked: true, onChange() {}, label: "Disable package" })
  );
  assert.match(html, /^<button /);
  assert.match(html, /type="button"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /aria-label="Disable package"/);
  assert.match(html, /title="Disable package"/);
  assert.match(html, /width:40px/);
});

test("disabled sperrt den Knopf und meldet den aus-Zustand", () => {
  const html = renderToStaticMarkup(
    React.createElement(Toggle, { checked: false, onChange() {}, disabled: true, label: "x" })
  );
  assert.match(html, /disabled=""/);
  assert.match(html, /aria-pressed="false"/);
});

test("eine eigene Klasse bleibt erhalten", () => {
  const html = renderToStaticMarkup(
    React.createElement(Toggle, { checked: true, onChange() {}, label: "x", className: "ml-2" })
  );
  assert.match(html, /class="ml-2"/);
});
