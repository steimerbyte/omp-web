import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";

/**
 * The password lock, mounted with a stubbed `/api/web-access`.
 *
 * The panel exists to make three states distinguishable that all look like
 * "some password" from the outside: no password, a stored password with the
 * lock switched off, and a password managed by the deployment (where every
 * button must refuse). Each is a sentence plus a button state.
 */

const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
restoreLinkedomPrototypesOnExit(win);
const nav = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };
win.getComputedStyle = () => new Proxy({}, { get: (_t, p) => (typeof p === "string" && p.startsWith("get") ? () => "" : "0px") });
win.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
globalThis.window = new Proxy(win, {
  get(target, prop) {
    if (prop === "navigator") return nav;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
globalThis.document = win.document;
globalThis.navigator = nav;
globalThis.matchMedia = win.matchMedia;
for (const [name, value] of Object.entries(linkedom)) {
  if (name === "parseHTML" || name === "default") continue;
  if (typeof value === "function" && /^[A-Z]/.test(name)) globalThis[name] = value;
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
win.document.oninput = null;

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  clear: () => storage.clear(),
};
win.localStorage = globalThis.localStorage;

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { AccessConfig } = await jiti.import("./AccessConfig.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { createRoot } = await import("react-dom/client");

const BASE = { source: "stored", file: "/home/pi/.omp/agent/omp-web-auth.json", username: "omp", updatedAt: null };

function status(overrides = {}) {
  return {
    enabled: false,
    configured: false,
    stored: false,
    managedByEnvironment: false,
    unreadable: false,
    ...BASE,
    ...overrides,
  };
}

/** Mounts the panel with `respond` deciding every `/api/web-access` answer. */
async function mount(respond) {
  win.document.body.innerHTML = "";
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method: init.method ?? "GET", body });
    return respond({ url, method: init.method ?? "GET", body });
  };
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(AccessConfig)));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return {
    container,
    calls,
    async unmount() { await act(async () => { root.unmount(); }); globalThis.fetch = originalFetch; },
  };
}

function json(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function button(container, label) {
  return [...container.querySelectorAll("button")].find((node) => (node.textContent ?? "").trim() === label);
}

async function type(input, value) {
  await act(async () => {
    input.dispatchEvent(new win.Event("focusin", { bubbles: true }));
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    input.dispatchEvent(new win.Event("keyup", { bubbles: true }));
  });
}

test("shows the load failure instead of a form", async () => {
  const { container, unmount } = await mount(() => json({ error: "credential file unreadable" }, false, 500));
  assert.match(container.textContent, /credential file unreadable/);
  assert.equal(container.querySelector("h2"), null);
  await unmount();
});

test("describes an unconfigured lock and keeps the switch disabled", async () => {
  const { container, unmount } = await mount(() => json(status()));
  assert.match(container.textContent, /No password is set/);
  assert.match(container.textContent, /Set a password below before turning this on/);
  const toggle = container.querySelector('button[aria-label="Require a password"]');
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  assert.equal(toggle.disabled, true);
  await unmount();
});

test("distinguishes a stored password with the lock switched off", async () => {
  const { container, unmount } = await mount(() => json(status({ stored: true, configured: true })));
  assert.match(container.textContent, /A password is stored but the lock is off/);
  assert.match(container.textContent, /Replace the password/);
  const toggle = container.querySelector('button[aria-label="Require a password"]');
  assert.equal(toggle.disabled, false);
  await unmount();
});

test("turning the lock on sends the enable action and shows the notice", async () => {
  const { container, calls, unmount } = await mount(({ method }) => {
    if (method === "GET") return json(status({ stored: true, configured: true, enabled: false, username: "sulamith1" }));
    return json(status({ stored: true, configured: true, enabled: true, username: "sulamith1" }));
  });
  await act(async () => { container.querySelector('button[aria-label="Require a password"]').click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const put = calls.find((call) => call.method === "PUT");
  assert.deepEqual(put.body, { action: "enable" });
  assert.match(container.textContent, /Password access is on/);
  await unmount();
});

test("a mismatched password never reaches the network", async () => {
  const { container, calls, unmount } = await mount(() => json(status({ stored: true, configured: true })));
  const [password, confirmation] = container.querySelectorAll('input[type="password"]');
  await type(password, "long-enough-1");
  await type(confirmation, "long-enough-2");
  const save = button(container, "Save password");
  assert.equal(save.disabled, true);
  await act(async () => { save.click(); });
  assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
  await unmount();
});

test("saving a password sends the username draft and clears both fields", async () => {
  const { container, calls, unmount } = await mount(({ method }) => {
    if (method === "GET") return json(status({ stored: true, configured: true, username: "omp" }));
    return json(status({ stored: true, configured: true, enabled: true, username: "sulamith1" }));
  });
  const username = container.querySelector('input[type="text"]');
  await type(username, "sulamith1");
  assert.equal(button(container, "Save username").disabled, false);
  const [password, confirmation] = container.querySelectorAll('input[type="password"]');
  await type(password, "correct horse battery");
  await type(confirmation, "correct horse battery");
  const save = button(container, "Save password");
  assert.equal(save.disabled, false);
  await act(async () => { save.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const put = calls.find((call) => call.method === "PUT");
  assert.deepEqual(put.body, { action: "set-password", password: "correct horse battery", username: "sulamith1" });
  assert.equal(password.value, "");
  assert.equal(confirmation.value, "");
  assert.match(container.textContent, /Password saved and password access turned on/);
  await unmount();
});

test("rejects an invalid username without a request and reports the unchanged case", async () => {
  const { container, calls, unmount } = await mount(() => json(status({ stored: true, configured: true, username: "omp" })));
  const username = container.querySelector('input[type="text"]');
  await type(username, "two words");
  assert.equal(button(container, "Save username").disabled, true);

  await type(username, "omp");
  assert.equal(button(container, "Save username").disabled, true);
  assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
  await unmount();
});

test("saving a different username sends set-username", async () => {
  const { container, calls, unmount } = await mount(({ method }) => {
    if (method === "GET") return json(status({ stored: true, configured: true, username: "omp" }));
    return json(status({ stored: true, configured: true, enabled: true, username: "sulamith1" }));
  });
  await type(container.querySelector('input[type="text"]'), "sulamith1");
  await act(async () => { button(container, "Save username").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.deepEqual(calls.find((call) => call.method === "PUT").body, { action: "set-username", username: "sulamith1" });
  assert.match(container.textContent, /Username saved/);
  await unmount();
});

test("removing the password sends clear and switches the switch off", async () => {
  const { container, calls, unmount } = await mount(({ method }) => {
    if (method === "GET") return json(status({ stored: true, configured: true, enabled: true }));
    return json(status({ stored: false, configured: false, enabled: false }));
  });
  await act(async () => { button(container, "Remove password").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.deepEqual(calls.find((call) => call.method === "PUT").body, { action: "clear" });
  assert.match(container.textContent, /The stored password was removed/);
  await unmount();
});

test("a deployment-managed password is read-only", async () => {
  const { container, unmount } = await mount(() => json(status({ stored: true, configured: true, enabled: true, managedByEnvironment: true })));
  assert.match(container.textContent, /Read-only · OMP_WEB_PASSWORD is configured/);
  assert.match(container.textContent, /Every request needs the password configured by the deployment/);
  const password = container.querySelector('input[type="password"]');
  assert.equal(password.disabled, true);
  assert.equal(container.querySelector('button[aria-label="Require a password"]').disabled, true);
  assert.equal(button(container, "Save password").disabled, true);
  assert.equal(button(container, "Remove password"), undefined);
  await unmount();
});

test("an unreadable credential file says requests are refused", async () => {
  const { container, unmount } = await mount(() => json(status({ unreadable: true, configured: true })));
  assert.match(container.textContent, /The credential file exists but could not be read/);
  await unmount();
});

test("a network failure while saving is shown and the passwords stay", async () => {
  const { container, unmount } = await mount(({ method }) => {
    if (method === "GET") return json(status({ stored: true, configured: true }));
    throw new Error("socket hang up");
  });
  const [password, confirmation] = container.querySelectorAll('input[type="password"]');
  await type(password, "long-enough-1");
  await type(confirmation, "long-enough-1");
  await act(async () => { button(container, "Save password").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(container.textContent, /socket hang up/);
  assert.equal(password.value, "long-enough-1");
  await unmount();
});

test("a stored password with a timestamp shows when it last changed", async () => {
  const { container, unmount } = await mount(() => json(status({
    stored: true,
    configured: true,
    updatedAt: "2026-02-03T04:05:06.000Z",
  })));
  assert.match(container.textContent, /Last changed/);
  assert.doesNotMatch(container.textContent, /No password stored yet/);
  await unmount();
});
