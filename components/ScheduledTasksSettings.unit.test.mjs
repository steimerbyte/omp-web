import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";

/**
 * Settings → scheduled tasks: one field, one button.
 *
 * The value is loaded from `/api/scheduled-settings`, the empty choice is an
 * explicit "the account home", and the stored answer replaces the draft — the
 * server may resolve a path differently from what was typed.
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
const { ScheduledTasksSettings } = await jiti.import("./ScheduledTasksSettings.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { createRoot } = await import("react-dom/client");

const HOME = "/srv/ome/home";
const PROJECT = "/srv/ome/home/demo";

function json(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

async function mount(respond) {
  win.document.body.innerHTML = "";
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const call = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return respond(call);
  };
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(ScheduledTasksSettings)));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return {
    container,
    calls,
    async unmount() { await act(async () => { root.unmount(); }); globalThis.fetch = originalFetch; },
  };
}

function setSelect(select, value) {
  const option = [...select.querySelectorAll("option")].find((node) => node.getAttribute("value") === value);
  assert.ok(option, `option ${JSON.stringify(value)} fehlt`);
  // linkedom exposes `select.value` as a get-only accessor; selecting the
  // option is what a browser does anyway, and the getter follows it.
  option.selected = true;
  select.dispatchEvent(new win.Event("change", { bubbles: true }));
}

function saveButton(container) {
  return [...container.querySelectorAll("button")].find((node) => /^(Save folder|Saving…)$/.test((node.textContent ?? "").trim()));
}

test("loads the stored default folder and offers home plus the project register", async () => {
  const { container, calls, unmount } = await mount(() => json({ defaultCwd: PROJECT, home: HOME, folders: [PROJECT, "/srv/ome/home/other"] }));
  assert.deepEqual(calls.map((call) => call.url), ["/api/scheduled-settings"]);
  const select = container.querySelector("#settings-scheduled-cwd");
  assert.equal(select.value, PROJECT);
  const values = [...select.querySelectorAll("option")].map((option) => option.getAttribute("value"));
  assert.deepEqual(values, ["", HOME, PROJECT, "/srv/ome/home/other", "\u0000custom"]);
  assert.equal(saveButton(container).disabled, false);
  await unmount();
});

test("choosing another known folder then saving sends it", async () => {
  const { container, calls, unmount } = await mount((call) => json({
    defaultCwd: call.method === "PUT" ? HOME : PROJECT,
    home: HOME,
    folders: [PROJECT],
  }));
  const select = container.querySelector("#settings-scheduled-cwd");
  await act(async () => {
    setSelect(select, HOME);
  });
  await act(async () => { saveButton(container).click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const put = calls.find((call) => call.method === "PUT");
  assert.deepEqual(put.body, { defaultCwd: HOME });
  assert.match(container.textContent, /Saved/);
  await unmount();
});

test("the inherit entry stores null, not the empty string", async () => {
  const { container, calls, unmount } = await mount(() => json({ defaultCwd: null, home: HOME, folders: [PROJECT] }));
  await act(async () => { saveButton(container).click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.deepEqual(calls.find((call) => call.method === "PUT").body, { defaultCwd: null });
  await unmount();
});

test("a custom path is typed into the revealed text field", async () => {
  const { container, calls, unmount } = await mount(() => json({ defaultCwd: null, home: HOME, folders: [] }));
  const select = container.querySelector("#settings-scheduled-cwd");
  await act(async () => {
    setSelect(select, "\u0000custom");
  });
  const path = container.querySelector("#settings-scheduled-cwd-path");
  assert.ok(path, "das Pfadfeld wurde nicht eingeblendet");
  await act(async () => {
    path.dispatchEvent(new win.Event("focusin", { bubbles: true }));
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set.call(path, "/srv/elsewhere");
    path.dispatchEvent(new win.Event("input", { bubbles: true }));
    path.dispatchEvent(new win.Event("keyup", { bubbles: true }));
  });
  await act(async () => { saveButton(container).click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.deepEqual(calls.find((call) => call.method === "PUT").body, { defaultCwd: "/srv/elsewhere" });
  await unmount();
});

test("a rejected save shows the server reason and keeps the button usable", async () => {
  let attempt = 0;
  const { container, calls, unmount } = await mount(() => {
    attempt += 1;
    return attempt === 1
      ? json({ defaultCwd: HOME, home: HOME, folders: [] })
      : json({ error: "cwd is outside the account" }, false, 400);
  });
  await act(async () => { saveButton(container).click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(container.textContent, /could not be saved\. cwd is outside the account/);
  assert.equal(saveButton(container).disabled, false);
  assert.equal(calls.filter((call) => call.method === "PUT").length, 1);
  await unmount();
});

test("a failed load is an alert, and the field still renders", async () => {
  const { container, unmount } = await mount(() => json({ error: "settings unavailable" }, false, 500));
  assert.equal(container.querySelector('[role="alert"]').textContent, "The folder could not be loaded.");
  assert.ok(container.querySelector("#settings-scheduled-cwd"));
  assert.equal(saveButton(container).disabled, true);
  await unmount();
});

test("the button reports that it is saving while the request is open", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { container, unmount } = await mount(async (call) => {
    if (call.method === "PUT") await gate;
    return json({ defaultCwd: null, home: HOME, folders: [] });
  });
  await act(async () => { saveButton(container).click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  assert.equal(saveButton(container).textContent.trim(), "Saving…");
  assert.equal(saveButton(container).disabled, true);
  await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.equal(saveButton(container).textContent.trim(), "Save folder");
  await unmount();
});
