// Verhalten statt Quelltext: der bestehende useTheme-Test prueft nur Strings.
// Hier laeuft der Modul-Store: Zyklus, Persistenz und die System-Umschaltung.
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

const ORIGINALS = {
  window: globalThis.window,
  document: globalThis.document,
  localStorage: globalThis.localStorage,
  matchMedia: globalThis.matchMedia,
  HTMLElement: globalThis.HTMLElement,
};
const store = new Map();
const localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
  removeItem: (key) => { store.delete(key); },
  clear: () => store.clear(),
};
let systemDark = false;
const changeListeners = [];
const matchMedia = (query) => {
  const isSystemQuery = query.includes("prefers-color-scheme");
  return {
    get matches() { return isSystemQuery ? systemDark : false; },
    media: query,
    addEventListener: (type, cb) => { if (type === "change" && isSystemQuery) changeListeners.push(cb); },
    removeEventListener: () => {},
    addListener: (cb) => { if (isSystemQuery) changeListeners.push(cb); },
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  };
};

globalThis.window = win;
globalThis.document = win.document;
globalThis.localStorage = localStorage;
win.localStorage = localStorage;
globalThis.matchMedia = matchMedia;
win.matchMedia = matchMedia;
globalThis.HTMLElement = win.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { useTheme } = await jiti.import(`${ROOT}hooks/useTheme.ts`);

test.after(() => {
  for (const [key, value] of Object.entries(ORIGINALS)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});

test("zyklisiert light -> dark -> auto, persistiert und folgt dem System", async () => {
  store.set("pi-theme", "dark");
  const seen = [];
  function Probe() {
    seen.push(useTheme());
    return React.createElement("span", null, seen.at(-1).theme);
  }
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => { root.render(React.createElement(Probe)); });
  assert.equal(seen.at(-1).preference, "dark");
  assert.equal(seen.at(-1).theme, "dark");
  assert.equal(seen.at(-1).isDark, true);
  assert.equal(container.textContent, "dark");

  // dark -> auto: das System entscheidet, hier hell.
  await act(async () => { seen.at(-1).toggleTheme({ x: 12, y: 34 }); });
  assert.equal(seen.at(-1).preference, "auto");
  assert.equal(seen.at(-1).theme, "light");
  assert.equal(store.get("pi-theme"), "auto");

  // auto -> light -> dark -> auto: der Kreis schliesst sich.
  await act(async () => { seen.at(-1).toggleTheme(); });
  assert.equal(seen.at(-1).preference, "light");
  await act(async () => { seen.at(-1).toggleTheme(); });
  assert.equal(seen.at(-1).preference, "dark");
  assert.equal(store.get("pi-theme"), "dark");
  await act(async () => { seen.at(-1).toggleTheme(); });
  assert.equal(seen.at(-1).preference, "auto");
  assert.equal(store.get("pi-theme"), "auto");

  // Ein Systemwechsel erreicht den Store nur bei preference "auto".
  systemDark = true;
  await act(async () => { for (const cb of changeListeners) cb(); });
  assert.equal(seen.at(-1).preference, "auto");
  assert.equal(seen.at(-1).theme, "dark");
  assert.equal(container.textContent, "dark");

  await act(async () => { root.unmount(); });
  container.remove();
});
