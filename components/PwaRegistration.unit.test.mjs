import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

/**
 * PwaRegistration haengt einen Effekt an `document`/`navigator`. Getestet wird
 * der Registrierungsaufruf, nicht das Offline-Verhalten: der Service Worker
 * selbst existiert in linkedom nicht, die Aufrufstelle schon.
 */

const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
restoreLinkedomPrototypesOnExit(win);
const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US" };

const ORIGINALS = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  NODE_ENV: process.env.NODE_ENV,
  APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION,
};

win.innerWidth = 1200;
win.innerHeight = 800;
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

const jiti = createJiti(`${process.cwd()}/package.json`, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { PwaRegistration } = await jiti.import(`${process.cwd()}/components/PwaRegistration.tsx`);

test.after(() => {
  for (const key of ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"]) {
    const value = ORIGINALS[key];
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
  if (ORIGINALS.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINALS.NODE_ENV;
  if (ORIGINALS.APP_VERSION === undefined) delete process.env.NEXT_PUBLIC_APP_VERSION;
  else process.env.NEXT_PUBLIC_APP_VERSION = ORIGINALS.APP_VERSION;
});

async function mount() {
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    root.render(React.createElement(PwaRegistration));
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { root, container };
}

test("registriert /sw.js mit der Build-Version und dem Wurzel-Scope", async () => {
  process.env.NODE_ENV = "production";
  process.env.NEXT_PUBLIC_APP_VERSION = "1.2.3";
  Object.defineProperty(win.document, "readyState", { value: "complete", configurable: true });

  const registrations = [];
  fakeNavigator.serviceWorker = {
    register: async (url, options) => {
      registrations.push({ url, options });
    },
  };

  const { root, container } = await mount();

  assert.equal(container.textContent, "");
  assert.deepEqual(registrations, [{
    url: "/sw.js?v=1.2.3",
    options: { scope: "/", updateViaCache: "none" },
  }]);

  await act(async () => root.unmount());
  container.remove();
});

test("wartet auf load und meldet einen fehlgeschlagenen Register-Versuch", async () => {
  process.env.NODE_ENV = "production";
  process.env.NEXT_PUBLIC_APP_VERSION = "9.9.9";
  Object.defineProperty(win.document, "readyState", { value: "loading", configurable: true });

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  const registrationCalls = [];
  fakeNavigator.serviceWorker = {
    register: async (url) => {
      registrationCalls.push(url);
      throw new Error("no worker");
    },
  };

  const { root, container } = await mount();
  assert.deepEqual(registrationCalls, [], "vor load darf nicht registriert werden");

  await act(async () => {
    win.dispatchEvent(new win.Event("load"));
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.deepEqual(registrationCalls, ["/sw.js?v=9.9.9"]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /Failed to register/);

  console.error = originalError;
  await act(async () => root.unmount());
  container.remove();
});

test("registriert in der Test-/Entwicklungsumgebung nichts", async () => {
  process.env.NODE_ENV = "test";
  delete process.env.NEXT_PUBLIC_APP_VERSION;
  const registrations = [];
  fakeNavigator.serviceWorker = {
    register: async (url) => {
      registrations.push(url);
    },
  };

  const { root, container } = await mount();

  assert.deepEqual(registrations, []);
  await act(async () => root.unmount());
  container.remove();
});
