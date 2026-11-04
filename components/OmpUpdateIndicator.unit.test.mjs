import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

/**
 * OmpUpdateIndicator: 403/404/Erfolg werden unterschieden, und nur ein
 * verfuegbares Update rendert ueberhaupt etwas. Der Panel-Schliessweg laeuft
 * ueber Pointerdown/Escape, nicht ueber einen Schliessen-Knopf.
 */

const ROOT = process.cwd();
const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
restoreLinkedomPrototypesOnExit(win);

const fakeNavigator = { userAgent: "test", languages: ["de-DE"], language: "de-DE" };
const storage = new Map();
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => void storage.set(key, String(value)),
  removeItem: (key) => void storage.delete(key),
};

const ORIGINALS = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
  localStorage: globalThis.localStorage,
  fetch: globalThis.fetch,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
};

win.innerWidth = 1200;
win.innerHeight = 800;
win.localStorage = localStorage;
win.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {} });
globalThis.window = new Proxy(win, {
  get(target, property) {
    if (property === "navigator") return fakeNavigator;
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
  has(target, property) {
    return property === "navigator" || Reflect.has(target, property);
  },
});
globalThis.document = win.document;
globalThis.navigator = fakeNavigator;
globalThis.localStorage = localStorage;
for (const [name, value] of Object.entries(linkedom)) {
  if (name === "parseHTML" || name === "default") continue;
  if (typeof value === "function" && /^[A-Z]/.test(name)) globalThis[name] = value;
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
win.getComputedStyle = () => new Proxy({}, { get: (_target, property) => (typeof property === "string" && property.startsWith("get") ? () => "" : "0px") });
globalThis.getComputedStyle = win.getComputedStyle;

/**
 * Das Panel haengt an `getBoundingClientRect` und `window.innerWidth`; beide
 * liefert linkedom nicht. Der Stub ist Teil des Vertrags, den die Komponente
 * fuer ihre Klemme voraussetzt.
 */
win.Element.prototype.getBoundingClientRect = function rect() {
  return { top: 40, left: 100, right: 260, bottom: 74, width: 160, height: 34, x: 100, y: 40 };
};

const mounted = [];
test.after(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  for (const key of ["window", "document", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"]) {
    const value = ORIGINALS[key];
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});

const jiti = createJiti(`${ROOT}/package.json`, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { I18nProvider } = await jiti.import(`${ROOT}/hooks/useI18n.tsx`);
const { OmpUpdateIndicator, classifyUpdatesResponse } = await jiti.import(`${ROOT}/components/OmpUpdateIndicator.tsx`);

function fire(target, type, props = {}) {
  const event = new win.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(event, key, { value, configurable: true });
  }
  target.dispatchEvent(event);
  return event;
}

async function mountWith(response) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (typeof response === "function") return response();
    return response;
  };
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(OmpUpdateIndicator)));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  mounted.push({ root, container });
  return { root, container, calls };
}

const UPDATE = {
  updateAvailable: true,
  currentAppVersion: "0.22.5",
  latestRelease: {
    version: "0.23.0",
    name: "Release 0.23.0",
    body: "## Fixes\n\n- something",
    htmlUrl: "https://example.test/releases/0.23.0",
    publishedAt: "2026-11-01T10:00:00Z",
  },
};

test("classifyUpdatesResponse trennt 403, 404, 5xx und Erfolg", () => {
  assert.equal(classifyUpdatesResponse(200), "ok");
  assert.equal(classifyUpdatesResponse(204), "ok");
  assert.equal(classifyUpdatesResponse(403), "unauthorized");
  assert.equal(classifyUpdatesResponse(404), "missing");
  assert.equal(classifyUpdatesResponse(500), "unavailable");
  assert.equal(classifyUpdatesResponse(399), "unavailable");
});

test("ein verfuegbares Update rendert Version und Changelog und schliesst per Escape", async () => {
  const { root, container, calls } = await mountWith({
    ok: true,
    status: 200,
    json: async () => UPDATE,
  });

  const button = container.querySelector("button");
  assert.ok(button, "der Update-Hinweis fehlt");
  assert.match(button.textContent, /v0\.23\.0/);
  assert.match(button.getAttribute("title"), /0\.23\.0/);
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(container.querySelector('[role="dialog"]'), null);
  assert.equal(calls[0].url, "/api/updates");
  assert.equal(calls[0].options.cache, "no-store");

  await act(async () => {
    fire(button, "mouseover", { relatedTarget: win.document.body });
    fire(button, "mouseout", { relatedTarget: win.document.body });
  });

  await act(async () => {
    fire(button, "click");
  });

  const dialog = container.querySelector('[role="dialog"]');
  assert.ok(dialog, "das Update-Panel wurde nicht geoeffnet");
  assert.match(dialog.textContent, /0\.23\.0/);
  assert.match(dialog.textContent, /Fixes/);
  assert.match(dialog.textContent, /0\.22\.5/);
  const link = dialog.querySelector('a[href="https://example.test/releases/0.23.0"]');
  assert.ok(link, "der Release-Link fehlt");
  assert.equal(link.getAttribute("target"), "_blank");

  await act(async () => {
    fire(win.document, "pointerdown");
  });
  assert.equal(container.querySelector('[role="dialog"]'), null);

  await act(async () => {
    fire(button, "click");
  });
  assert.ok(container.querySelector('[role="dialog"]'));

  await act(async () => {
    fire(win.document, "keydown", { key: "Escape" });
  });
  assert.equal(container.querySelector('[role="dialog"]'), null);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("ohne Update rendert die Komponente nichts", async () => {
  const { root, container } = await mountWith({
    ok: true,
    status: 200,
    json: async () => ({ ...UPDATE, updateAvailable: false }),
  });
  assert.equal(container.innerHTML, "");
  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("403 und 404 sind terminal und rendern ebenfalls nichts", async () => {
  for (const status of [403, 404, 500]) {
    const { root, container } = await mountWith({ ok: false, status, json: async () => ({}) });
    assert.equal(container.innerHTML, "", `Status ${status} darf nichts rendern`);
    await act(async () => root.unmount());
    mounted.splice(0, mounted.length);
    container.remove();
  }
});

test("Netzfehler und ein Archiv ohne Release-Datum kommen ohne Datum aus", async () => {
  const { root, container } = await mountWith({
    ok: true,
    status: 200,
    json: async () => ({
      ...UPDATE,
      latestRelease: { ...UPDATE.latestRelease, publishedAt: null, body: "   ", name: "Nur der Name" },
    }),
  });
  const button = container.querySelector("button");
  await act(async () => {
    fire(button, "click");
  });
  const dialog = container.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /Nur der Name/);
  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("ein abgebrochener Fetch laesst die Komponente leer", async () => {
  const { root, container } = await mountWith(() => Promise.reject(new Error("aborted")));
  assert.equal(container.innerHTML, "");
  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});
