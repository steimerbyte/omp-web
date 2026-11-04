// Der bestehende useDisplaySettings-Test liest nur den Quelltext. Hier laeuft
// der geteilte Store: fetch, emit, Re-Render und die drei Fehlerpfade.
import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

const ROOT = new globalThis.URL("..", import.meta.url).pathname;
const jiti = createJiti(`${ROOT}package.json`, { jsx: { runtime: "automatic" }, tsconfigPaths: true });

const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
const ORIGINALS = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
const calls = [];
let respond = async () => ({ ok: true, status: 200, json: async () => ({ hideThinkingBlock: false }) });

globalThis.window = win;
globalThis.document = win.document;
globalThis.fetch = async (url, init) => {
  calls.push([String(url), init]);
  return respond(String(url));
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { useDisplaySettings, useSyncedDisplaySettings, refreshDisplaySettings } =
  await jiti.import(`${ROOT}hooks/useDisplaySettings.ts`);

test.after(() => {
  for (const [key, value] of Object.entries(ORIGINALS)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});

test("laedt die Einstellung, meldet Aenderungen an alle Abonnenten und ignoriert Altes", async () => {
  const seen = [];
  function Probe() {
    seen.push(useSyncedDisplaySettings("/projekt"));
    return React.createElement("span", null, String(seen.at(-1).hideThinkingBlock));
  }
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);

  // Der Mount-Effekt holt die Werte einmal fuer den cwd.
  await act(async () => { root.render(React.createElement(Probe)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.deepEqual(calls.map(([url]) => url), ["/api/display-settings?cwd=%2Fprojekt"]);
  assert.equal(container.textContent, "false");

  // Eine Aenderung im Store wird sichtbar.
  respond = async () => ({ ok: true, status: 200, json: async () => ({ hideThinkingBlock: true }) });
  await act(async () => { await refreshDisplaySettings(); });
  assert.equal(container.textContent, "true");
  assert.equal(seen.at(-1).hideThinkingBlock, true);

  // Derselbe Wert loest kein emit aus (kein Re-Render noetig).
  const renders = seen.length;
  await act(async () => { await refreshDisplaySettings(null); });
  assert.equal(seen.length, renders);

  // Eine spaetere, aeltere Antwort darf eine neuere nicht ueberschreiben.
  let releaseOld;
  const oldAnswer = new Promise((resolve) => { releaseOld = resolve; });
  respond = () => oldAnswer;
  const oldRequest = refreshDisplaySettings();
  respond = async () => ({ ok: true, status: 200, json: async () => ({ hideThinkingBlock: false }) });
  await act(async () => { await refreshDisplaySettings(); });
  assert.equal(seen.at(-1).hideThinkingBlock, false);
  respond = async () => ({ ok: true, status: 200, json: async () => ({ hideThinkingBlock: true }) });
  releaseOld({ ok: true, status: 200, json: async () => ({ hideThinkingBlock: true }) });
  await act(async () => { await oldRequest; });
  assert.equal(seen.at(-1).hideThinkingBlock, false);

  // HTTP-Fehler werden geworfen, nicht verschluckt.
  respond = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(() => refreshDisplaySettings(), /503/);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("der reine Hook liest den Store ohne eigenen Request", async () => {
  const before = calls.length;
  const seen = [];
  function Probe() {
    seen.push(useDisplaySettings());
    return null;
  }
  const container = win.document.createElement("div");
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(Probe)); });
  assert.equal(calls.length, before);
  assert.equal(typeof seen.at(-1).hideThinkingBlock, "boolean");
  await act(async () => { root.unmount(); });
});
