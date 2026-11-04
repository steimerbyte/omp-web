// Der Quick-Phrases-Store hat bisher keinen Test. Er ist ein Modul-Singleton;
// die Faelle laufen deshalb in einer Reihenfolge: Seed beim ersten Laden,
// Schreiben mit/ohne Persistenz, Flush und der Fehlerpfad.
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
const ORIGINALS = { window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage, fetch: globalThis.fetch };
const store = new Map();
const localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
  removeItem: (key) => { store.delete(key); },
  clear: () => store.clear(),
};
const requests = [];
let handler = async () => ({ ok: true, status: 200, json: async () => ({}) });

globalThis.window = win;
globalThis.document = win.document;
globalThis.localStorage = localStorage;
win.localStorage = localStorage;
globalThis.fetch = async (url, init) => {
  requests.push([String(url), init]);
  return handler(String(url), init);
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const {
  loadQuickPhrases, setQuickPhrases, flushQuickPhrases, useQuickPhrases,
} = await jiti.import(`${ROOT}hooks/useQuickPhrases.ts`);

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

test.after(() => {
  for (const [key, value] of Object.entries(ORIGINALS)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});

test("seeds the defaults when the server has no file yet", async () => {
  requests.length = 0;
  // Keine Datei: der Bestand wandert aus dem Browser oder wird gesaet.
  store.delete("omp-quick-phrases-seeded");
  handler = async (url, init) => {
    if (init?.method === "PUT") {
      return { ok: true, status: 200, json: async () => ({ phrases: JSON.parse(init.body).phrases }) };
    }
    return { ok: true, status: 200, json: async () => ({ exists: false, phrases: [] }) };
  };
  const seen = [];
  function Probe() {
    seen.push(useQuickPhrases());
    return React.createElement("span", null, String(seen.at(-1).phrases.length));
  }
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(Probe)); });
  await act(async () => { await settle(); });

  assert.equal(requests.filter(([, init]) => init?.method === "PUT").length, 1);
  assert.equal(seen.at(-1).loaded, true);
  assert.equal(seen.at(-1).error, null);
  assert.equal(seen.at(-1).phrases.length, 7);
  assert.equal(container.textContent, "7");
  assert.ok(store.get("omp-quick-phrases-mirror"));

  // Schreiben mit Persistenz: der Server ist die Wahrheit, der leere Text
  // faellt raus, der Spiegel folgt der Antwort.
  await act(async () => {
    setQuickPhrases([{ label: "Kurz", text: "Text" }, { label: "leer", text: "" }]);
    await settle();
  });
  assert.equal(seen.at(-1).phrases.length, 1);
  assert.deepEqual(seen.at(-1).phrases[0], { label: "Kurz", text: "Text" });
  assert.deepEqual(JSON.parse(store.get("omp-quick-phrases-mirror")), [{ label: "Kurz", text: "Text" }]);

  // Ohne Persistenz bleibt der Server unberuehrt.
  const putsBefore = requests.filter(([, init]) => init?.method === "PUT").length;
  await act(async () => { setQuickPhrases([{ label: "Nur", text: "lokal" }], false); });
  assert.equal(requests.filter(([, init]) => init?.method === "PUT").length, putsBefore);
  assert.equal(seen.at(-1).phrases[0].label, "Nur");

  // Flush schreibt sofort — auch eine Zeile ohne Text, die der Store ablehnt.
  await act(async () => {
    flushQuickPhrases([{ label: "Flush", text: "sofort" }]);
    await settle();
  });
  assert.equal(requests.filter(([, init]) => init?.method === "PUT").length, putsBefore + 1);
  assert.equal(seen.at(-1).phrases[0].label, "Flush");

  // Ein fehlgeschlagener PUT setzt error, die Liste bleibt stehen.
  handler = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await act(async () => {
    setQuickPhrases([{ label: "bleibt", text: "da" }]);
    await settle();
  });
  assert.equal(seen.at(-1).error, "HTTP 500");
  assert.equal(seen.at(-1).phrases[0].label, "bleibt");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("ein fehlgeschlagener GET behaelt die letzte Liste und meldet den Fehler", async () => {
  handler = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await loadQuickPhrases();
  await settle();
  const seen = [];
  function Probe() {
    seen.push(useQuickPhrases());
    return null;
  }
  const container = win.document.createElement("div");
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(Probe)); });
  await act(async () => { await settle(); });
  assert.equal(seen.at(-1).error, "HTTP 503");
  assert.equal(seen.at(-1).loaded, false);
  assert.equal(seen.at(-1).phrases[0].label, "bleibt");
  await act(async () => { root.unmount(); });
});

test("eine unerwartete Antwortform ist ein Fehler, kein leeres Ergebnis", async () => {
  const seen = [];
  function Probe() {
    seen.push(useQuickPhrases());
    return null;
  }
  const container = win.document.createElement("div");
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(Probe)); });
  handler = async () => ({ ok: true, status: 200, json: async () => ({ phrases: [] }) });
  await act(async () => { await loadQuickPhrases(); await settle(); });
  assert.equal(seen.at(-1).error, "unexpected response shape");
  await act(async () => { root.unmount(); });
});
