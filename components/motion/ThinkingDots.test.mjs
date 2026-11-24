import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import { THINKING_DOT_DURATION } from "./animations.ts";

/**
 * The working indicator's contract:
 *
 *  - the grid has 49 cells and the box is there in every mode;
 *  - the cells animate in `full` and stand still in `off`, without the box
 *    changing size — that difference is the whole reason the mode is read in
 *    the component rather than left to `MotionConfig`;
 *  - the fan is deterministic, because a `Math.random()` field differs between
 *    the server render and the browser's first render;
 *  - the CSS fallback is the same number as the token.
 */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const storage = new Map();
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  clear: () => { storage.clear(); },
};
globalThis.window = dom.window;
globalThis.document = dom.document;
globalThis.localStorage = localStorage;
dom.window.localStorage = localStorage;
dom.window.matchMedia = () => ({
  matches: false,
  media: "",
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
});
globalThis.matchMedia = dom.window.matchMedia;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ThinkingDots, dotTiming } = await jiti.import("./ThinkingDots.tsx");
const { setAnimationMode } = await jiti.import("./AnimationProvider.tsx");
const { createRoot } = await import("react-dom/client");

const mounted = [];

async function mount(element) {
  const container = document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => { root.render(element); });
  return container;
}

test.afterEach(async () => {
  for (const root of mounted.splice(0)) await act(async () => { root.unmount(); });
  storage.clear();
  setAnimationMode("full");
});

/** The body of a rule or at-rule, found by its braces. */
function ruleBody(text, selector) {
  const at = text.indexOf(selector);
  if (at === -1) return null;
  const open = text.indexOf("{", at);
  if (open === -1) return null;
  let depth = 0;
  let close = open;
  for (; close < text.length; close += 1) {
    if (text[close] === "{") depth += 1;
    else if (text[close] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return text.slice(open + 1, close);
}

const dotsOf = (container) => [...container.querySelectorAll(".omp-thinking-dot")];
const boxOf = (container) => container.querySelector(".omp-thinking-dots");

test("full mode: 49 live cells in a 20px box that is in the layout", () => {
  const markup = renderToStaticMarkup(React.createElement(ThinkingDots, { isWorking: true }));

  assert.equal((markup.match(/\bis-live\b/g) ?? []).length, 49, "es sind nicht 49 animierte Zellen");
  assert.match(markup, /^<span[^>]*class="omp-thinking-dots"/, "die Box fehlt");
  assert.match(markup, /width:20px/, "die Box hat keine feste Breite");
  assert.match(markup, /height:20px/, "die Box hat keine feste Hoehe");
  assert.match(markup, /aria-hidden="true"/, "der Indikator gehoert nicht in den Accessibility-Baum");
  assert.doesNotMatch(markup, /role="status"/, "der Indikator ist kein Status-Live-Bereich");
});

test("off mode: the box stays and no cell carries the animation class", async () => {
  storage.set("omp-animations", "off");
  setAnimationMode("off");

  const container = await mount(React.createElement(ThinkingDots, { isWorking: true }));
  const box = boxOf(container);
  assert.ok(box, "die Box ist im Modus off nicht gemountet");
  assert.equal(dotsOf(container).length, 49);
  assert.equal(box.style.width, "20px", "die Box schrumpft im Modus off");
  assert.equal(box.style.height, "20px");
  assert.equal(box.getAttribute("data-working"), "true");
  for (const dot of dotsOf(container)) {
    assert.doesNotMatch(dot.getAttribute("class"), /is-live/, "eine Zelle animiert im Modus off");
  }
});

test("idle: the same box, no live cell, and it stays out of the layout's way", () => {
  const markup = renderToStaticMarkup(React.createElement(ThinkingDots, { isWorking: false }));

  assert.equal((markup.match(/\bis-live\b/g) ?? []).length, 0, "die Zellen atmen im Ruhezustand");
  assert.match(markup, /data-working="false"/);
  assert.match(markup, /width:20px/);
});

test("size, extra props and the ref reach the box", async () => {
  const ref = React.createRef();
  const container = await mount(
    React.createElement(ThinkingDots, { isWorking: true, size: 12, title: "agent running", ref }),
  );
  const box = boxOf(container);
  assert.equal(box.style.width, "12px");
  assert.equal(box.style.height, "12px");
  assert.equal(box.getAttribute("title"), "agent running");
  assert.equal(ref.current, box);
});

test("dotTiming is deterministic and stays inside the declared fan", () => {
  assert.deepEqual(dotTiming(7), dotTiming(7), "die Phase ist nicht reproduzierbar");

  const delays = new Set();
  for (let index = 0; index < 49; index += 1) {
    const { delay, duration } = dotTiming(index);
    assert.match(delay, /^-\d+\.\d{3}s$/, `Zelle ${index}: Delay ${delay}`);
    assert.match(duration, /^\d+\.\d{3}s$/, `Zelle ${index}: Dauer ${duration}`);

    const delaySeconds = Number.parseFloat(delay);
    assert.ok(delaySeconds <= 0 && delaySeconds > -1, `Zelle ${index}: Delay ausserhalb einer Sekunde`);
    const period = Number.parseFloat(duration);
    // Die 0.7x bis 1.3x stehen als Kommentar in animations.ts; hier ist die Zahl.
    assert.ok(
      period >= 0.7 * THINKING_DOT_DURATION - 0.001 && period <= 1.3 * THINKING_DOT_DURATION + 0.001,
      `Zelle ${index}: Dauer ${period}s liegt ausserhalb des Faechers`,
    );
    delays.add(delay);
  }
  assert.ok(delays.size > 40, "die Zellen starten fast gleichzeitig");
});

test("kein Math.random im Modul", () => {
  // Der Kommentar nennt den Grund, warum es verboten ist; die Regel gilt dem Code.
  const source = readFileSync(new URL("./ThinkingDots.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(source, /Math\.random/, "Zufall im Render bricht die Hydration");
});

test("die CSS-Dauer ist dieselbe Zahl wie das Token", () => {
  const globals = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
  const body = ruleBody(globals, ".omp-thinking-dot.is-live");
  assert.ok(body, "die Live-Klasse fehlt in globals.css");
  assert.match(
    body,
    new RegExp(`var\\(--omp-thinking-dot-duration, ${THINKING_DOT_DURATION}s\\)`),
    "der Fallback in globals.css driftet gegen THINKING_DOT_DURATION",
  );
  assert.match(body, /animation-delay:\s*var\(--omp-thinking-dot-delay/);
  // Die Kurve ist ein Keyword; eine eigene cubic-bezier() waere ein zweiter Takt.
  assert.doesNotMatch(body, /cubic-bezier/);
});

test("die Keyframes bewegen ausschliesslich opacity", () => {
  const globals = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
  const body = ruleBody(globals, "@keyframes omp-thinking-dot");
  assert.ok(body, "@keyframes omp-thinking-dot fehlt");
  const properties = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(properties)], ["opacity"], "eine Zelle animiert mehr als ihre Deckkraft");
});

test("off und reduced motion halten die neue Klasse an", () => {
  const globals = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

  const offBody = ruleBody(globals, 'html[data-omp-animations="off"] .omp-thinking-dot.is-live');
  assert.ok(offBody, "der off-Zweig fuer den Indikator fehlt");
  assert.match(offBody, /animation-duration:\s*1ms/, "off stoppt den Indikator nicht");

  const blocks = [];
  let index = globals.indexOf("@media (prefers-reduced-motion: reduce)");
  while (index !== -1) {
    blocks.push(ruleBody(globals.slice(index), "@media"));
    index = globals.indexOf("@media (prefers-reduced-motion: reduce)", index + 1);
  }
  assert.ok(
    blocks.some((block) => block.includes(".omp-thinking-dot.is-live") && /animation-duration:\s*1ms/.test(block)),
    "reduced motion stoppt den Indikator nicht",
  );
});
