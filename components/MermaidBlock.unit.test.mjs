import assert from "node:assert/strict";
import test from "node:test";
import { mock } from "bun:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";

/**
 * Warum `mermaid` gemockt wird.
 *
 * Der echte Renderer braucht ein Layout: `mermaid.render` scheitert in
 * linkedom an `CSSStyleSheet is not defined` (gemessen), also bleibt
 * `MermaidBlock` fuer immer im Ladezustand und `MermaidZoomDialog` waere
 * unerreichbar. Der Mock liefert genau das, was der Renderer liefern wuerde —
 * ein SVG — und macht damit die Zustaende `ready`, `error` und den
 * Zoom-Dialog pruefbar. `parse`/`render` sind steuerbar, damit auch der
 * Fehlerzweig laeuft.
 *
 * Der Mock gilt prozessweit. Das ist hier vertretbar, weil keine andere
 * Testdatei den Mermaid-Renderer zur Laufzeit importiert: die uebrigen Tests
 * rendern `MermaidBlock` serverseitig, wo der Effekt nie laeuft.
 */
const mermaidState = { mode: "ready" };
mock.module("mermaid", () => ({
  default: {
    initialize() {},
    async parse() {
      if (mermaidState.mode === "invalid") return false;
      return { diagramType: "flowchart-v2" };
    },
    async render(id, code) {
      if (mermaidState.mode === "throw") throw new Error("render failed");
      return { svg: `<svg data-mermaid-mock="1"><title>${code}</title></svg>` };
    },
  },
}));

const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
restoreLinkedomPrototypesOnExit(win);
const fakeNavigator = {
  userAgent: "test",
  languages: ["en-US"],
  language: "en-US",
  platform: "linux",
  clipboard: { writeText: async () => {} },
};
globalThis.window = new Proxy(win, {
  get(target, prop) {
    if (prop === "navigator") return fakeNavigator;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
globalThis.document = win.document;
globalThis.navigator = fakeNavigator;
win.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null });
globalThis.matchMedia = win.matchMedia;
win.getComputedStyle = () => new Proxy({}, { get: (_t, p) => (typeof p === "string" && p.startsWith("get") ? () => "" : "0px") });
for (const [key, value] of Object.entries(linkedom)) {
  if (key !== "parseHTML" && key !== "default" && typeof value === "function" && /^[A-Z]/.test(key)) {
    globalThis[key] = value;
  }
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
};
win.localStorage = globalThis.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/* linkedom kennt weder `showModal` noch `close`; beide sind Teil des
 * Dialog-Vertrags, den MermaidZoomDialog beim Oeffnen und Raeumen aufruft. */
const modalCalls = [];
win.HTMLElement.prototype.showModal = function showModal() {
  modalCalls.push("showModal");
  this.open = true;
};
win.HTMLElement.prototype.close = function close() {
  modalCalls.push("close");
  this.open = false;
};

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MermaidBlock, CodeBlock } = await jiti.import("./MermaidBlock.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

const DOM_HARNESS_TIMEOUT = 30_000;

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
  }
}

function reactProps(element) {
  const key = Object.keys(element).find((k) => k.startsWith("__reactProps"));
  assert.ok(key, "kein React-Props-Objekt am Knoten");
  return element[key];
}

async function click(element) {
  const props = reactProps(element);
  const handler = props.onClick;
  assert.equal(typeof handler, "function", "der Knoten hat einen onClick-Handler");
  await act(async () => {
    handler({
      target: element,
      currentTarget: element,
      defaultPrevented: false,
      preventDefault() {},
    });
  });
}

async function mountMermaid(props) {
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(MermaidBlock, props)));
  });
  await settle();
  return { container, root };
}

test("source view toggles to the rendered diagram and back", { timeout: DOM_HARNESS_TIMEOUT }, async () => {
  mermaidState.mode = "ready";
  const { container, root } = await mountMermaid({ code: "graph TD; A-->B" });

  assert.match(container.textContent, /Preview/);
  const previewButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Preview");
  assert.ok(previewButton);
  await click(previewButton);
  await settle(14);

  const svgButton = container.querySelector(".mermaid-preview-button");
  assert.ok(svgButton, "das gerenderte Diagramm ist ein Knopf zum Oeffnen");
  assert.match(svgButton.innerHTML, /data-mermaid-mock="1"/);
  assert.match(svgButton.innerHTML, /graph TD; A--&gt;B/);

  const sourceButton = [...container.querySelectorAll(".markdown-code-action")].find((button) => button.textContent === "Source");
  assert.ok(sourceButton, "der Header bietet die Rueckkehr zum Quelltext");
  await click(sourceButton);
  assert.doesNotMatch(container.innerHTML, /data-mermaid-mock/);
  assert.match(container.textContent, /graph TD/);
  await act(async () => { root.unmount(); });
});

test("an unparsable diagram shows the error state, a throwing renderer as well", { timeout: DOM_HARNESS_TIMEOUT }, async () => {
  mermaidState.mode = "invalid";
  const invalid = await mountMermaid({ code: "not a diagram", defaultPreview: true });
  assert.match(invalid.container.textContent, /Invalid Mermaid diagram/);
  await act(async () => { invalid.root.unmount(); });

  mermaidState.mode = "throw";
  const throwing = await mountMermaid({ code: "graph TD; C-->D", defaultPreview: true });
  assert.match(throwing.container.textContent, /Invalid Mermaid diagram/);
  await act(async () => { throwing.root.unmount(); });
  mermaidState.mode = "ready";
});

test("the zoom dialog opens, zooms, fits, and closes on Escape", { timeout: DOM_HARNESS_TIMEOUT }, async () => {
  mermaidState.mode = "ready";
  modalCalls.length = 0;
  const { container, root } = await mountMermaid({ code: "graph TD; E-->F", defaultPreview: true });
  const preview = container.querySelector(".mermaid-preview-button");
  assert.ok(preview);
  await click(preview);

  const dialog = container.querySelector("dialog.mermaid-zoom-dialog");
  assert.ok(dialog, "der Zoom-Dialog steht im Dokument");
  assert.equal(modalCalls.includes("showModal"), true);
  assert.equal(win.document.body.style.overflow, "hidden");
  assert.match(dialog.textContent, /100%/);

  const zoomIn = dialog.querySelector('[aria-label="Zoom in"]');
  const zoomOut = dialog.querySelector('[aria-label="Zoom out"]');
  const fit = dialog.querySelector('[aria-label="Fit to width"]');
  await click(zoomIn);
  assert.match(dialog.textContent, /125%/);
  // Bis zur Obergrenze klicken: 3 is the cap, further clicks leave it there.
  for (let i = 0; i < 12 && !zoomIn.disabled; i++) await click(zoomIn);
  assert.match(dialog.textContent, /300%/);
  assert.equal(zoomIn.disabled, true);
  await click(zoomOut);
  assert.match(dialog.textContent, /275%/);
  await click(fit);
  assert.match(dialog.textContent, /100%/);

  const cancelProps = reactProps(dialog);
  await act(async () => {
    cancelProps.onCancel({ preventDefault() {} });
  });
  assert.equal(container.querySelector("dialog.mermaid-zoom-dialog"), null);
  assert.equal(win.document.body.style.overflow, "");
  await act(async () => { root.unmount(); });
});

test("Escape and the close button in the dialog both call onClose", { timeout: DOM_HARNESS_TIMEOUT }, async () => {
  mermaidState.mode = "ready";
  const { container, root } = await mountMermaid({ code: "graph TD; G-->H", defaultPreview: true });
  await click(container.querySelector(".mermaid-preview-button"));

  let dialog = container.querySelector("dialog.mermaid-zoom-dialog");
  const { onKeyDown } = reactProps(dialog);
  await act(async () => {
    onKeyDown({ key: "a", preventDefault() {} });
  });
  assert.ok(container.querySelector("dialog.mermaid-zoom-dialog"), "andere Tasten schliessen nicht");

  await act(async () => {
    onKeyDown({ key: "Escape", preventDefault() {} });
  });
  assert.equal(container.querySelector("dialog.mermaid-zoom-dialog"), null);

  await click(container.querySelector(".mermaid-preview-button"));
  dialog = container.querySelector("dialog.mermaid-zoom-dialog");
  await click(dialog.querySelector('[aria-label="Close"]'));
  assert.equal(container.querySelector("dialog.mermaid-zoom-dialog"), null);
  await act(async () => { root.unmount(); });
});

test("a click on the empty dialog backdrop closes it, a click on the canvas does not", { timeout: DOM_HARNESS_TIMEOUT }, async () => {
  mermaidState.mode = "ready";
  const { container, root } = await mountMermaid({ code: "graph TD; I-->J", defaultPreview: true });
  await click(container.querySelector(".mermaid-preview-button"));

  const dialog = container.querySelector("dialog.mermaid-zoom-dialog");
  const viewport = dialog.querySelector(".mermaid-zoom-viewport");
  const canvas = dialog.querySelector(".mermaid-zoom-canvas");
  const { onClick } = reactProps(viewport);
  await act(async () => {
    onClick({ target: canvas, currentTarget: viewport });
  });
  assert.ok(container.querySelector("dialog.mermaid-zoom-dialog"), "Klick auf das Diagramm bleibt offen");
  await act(async () => {
    onClick({ target: viewport, currentTarget: viewport });
  });
  assert.equal(container.querySelector("dialog.mermaid-zoom-dialog"), null);
  await act(async () => { root.unmount(); });
});

test("the CodeBlock copy button writes the code and reports the copy", { timeout: DOM_HARNESS_TIMEOUT }, async () => {
  const writes = [];
  fakeNavigator.clipboard.writeText = async (text) => { writes.push(text); };
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(CodeBlock, { code: "const x = 1;", lang: "javascript" })));
  });

  const copyButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Copy");
  assert.ok(copyButton);
  await click(copyButton);
  assert.deepEqual(writes, ["const x = 1;"]);
  assert.match(container.textContent, /Copied/);
  await act(async () => { root.unmount(); });
});
