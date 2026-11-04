import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";

/**
 * The role panel, mounted against a stubbed `/api/model-roles` and
 * `/api/models`.
 *
 * Two behaviours are invisible in the markup: a hidden role is not rendered
 * at all, and assigning a model keeps the role's thinking level only when the
 * new model supports it — otherwise the assignment would carry a level the
 * model does not know.
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
win.Element.prototype.scrollIntoView = () => {};
win.HTMLElement.prototype.scrollIntoView = () => {};
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
const { ModelRolesPanel } = await jiti.import("./ModelRolesPanel.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { createRoot } = await import("react-dom/client");

const CWD = "/home/alice/workspace/demo";

const ROLES = [
  {
    role: "default",
    tag: "DEF",
    name: "Default",
    builtin: true,
    hidden: false,
    source: "global",
    selector: "openai/gpt-5:high",
    resolved: { provider: "openai", modelId: "gpt-5" },
  },
  {
    role: "smol",
    name: "Fast",
    builtin: true,
    hidden: false,
    source: "default",
    warning: "No model assigned",
  },
  {
    role: "internal",
    name: "Internal",
    builtin: false,
    hidden: true,
    source: "project",
  },
];

const MODELS = {
  modelList: [
    { id: "gpt-5", name: "GPT-5", provider: "openai" },
    { id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" },
  ],
  thinkingLevels: {
    "openai:gpt-5": ["low", "medium", "high"],
    "anthropic:claude-sonnet-4": ["low", "high"],
  },
};

function json(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

async function mount({ cwd = CWD, respond } = {}) {
  win.document.body.innerHTML = "";
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const call = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return respond ? respond(call) : defaultRespond(call);
  };
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(ModelRolesPanel, {
      cwd,
      onRolesChanged: () => { calls.push({ url: "roles-changed" }); },
    })));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  return {
    container,
    calls,
    async unmount() { await act(async () => { root.unmount(); }); globalThis.fetch = originalFetch; },
  };
}

function defaultRespond(call) {
  if (call.url.startsWith("/api/model-roles")) {
    if (call.method === "PUT") return json({ roles: ROLES });
    return json({ roles: ROLES });
  }
  if (call.url.startsWith("/api/models")) return json(MODELS);
  return json({});
}

function button(container, text) {
  return [...container.querySelectorAll("button")].find((node) => (node.textContent ?? "").trim() === text);
}

async function chooseModel(container, roleLabel, optionText) {
  const trigger = container.querySelector(`button[aria-label="${roleLabel}"]`);
  assert.ok(trigger, `Trigger für ${roleLabel} fehlt`);
  await act(async () => { trigger.click(); });
  const option = [...container.querySelectorAll('[role="option"]')]
    .find((node) => (node.textContent ?? "").includes(optionText));
  assert.ok(option, `Option ${optionText} fehlt`);
  await act(async () => { option.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

test("without a project it explains why there is nothing to assign", async () => {
  const { container, calls, unmount } = await mount({ cwd: null });
  assert.match(container.textContent, /project/i);
  assert.equal(container.querySelector("button"), null);
  assert.deepEqual(calls, []);
  await unmount();
});

test("renders roles, hides hidden ones, and shows the warning marker", async () => {
  const { container, calls, unmount } = await mount();
  assert.deepEqual(calls.map((call) => call.url), [
    `/api/model-roles?cwd=${encodeURIComponent(CWD)}`,
    `/api/models?cwd=${encodeURIComponent(CWD)}`,
  ]);
  assert.match(container.textContent, /Default/);
  assert.match(container.textContent, /Fast/);
  assert.doesNotMatch(container.textContent, /Internal/);
  assert.equal(container.querySelectorAll('[role="group"]').length, 1);
  assert.equal(container.querySelector('[title="No model assigned"]').textContent.trim(), "!");
  assert.equal(container.querySelector('button[aria-label="Default"]').textContent.includes("GPT-5 — openai"), true);
  await unmount();
});

test("assigning a model sends the selector and notifies the shell", async () => {
  const { container, calls, unmount } = await mount();
  await chooseModel(container, "Default", "Claude Sonnet 4");
  const put = calls.find((call) => call.method === "PUT");
  assert.equal(put.url, "/api/model-roles");
  assert.deepEqual(put.body, {
    cwd: CWD,
    role: "default",
    selector: "anthropic/claude-sonnet-4:high",
    scope: "global",
  });
  assert.ok(calls.some((call) => call.url === "roles-changed"));
  await unmount();
});

test("clearing the role sends null", async () => {
  const { container, calls, unmount } = await mount();
  const trigger = container.querySelector('button[aria-label="Default"]');
  await act(async () => { trigger.click(); });
  const unset = [...container.querySelectorAll('[role="option"]')]
    .find((node) => (node.textContent ?? "").includes("not set"));
  assert.ok(unset, "der Unset-Eintrag fehlt");
  await act(async () => { unset.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.deepEqual(calls.find((call) => call.method === "PUT").body, {
    cwd: CWD,
    role: "default",
    selector: null,
    scope: "global",
  });
  await unmount();
});

test("switching the scope changes what the write declares", async () => {
  const { container, calls, unmount } = await mount();
  await act(async () => { button(container, "This project").click(); });
  assert.match(container.textContent, /\.omp\/config\.yml/);
  await chooseModel(container, "Default", "Claude Sonnet 4");
  assert.equal(calls.find((call) => call.method === "PUT").body.scope, "project");
  await unmount();
});

test("choosing a thinking level rewrites only the suffix", async () => {
  const { container, calls, unmount } = await mount();
  const group = container.querySelector('[role="group"][aria-label^="Default"]');
  const levels = [...group.querySelectorAll("button")].map((node) => (node.textContent ?? "").trim());
  assert.deepEqual(levels, ["inherit", "off", "auto", "low", "medium", "high"]);

  await act(async () => { button(container, "low").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.equal(calls.find((call) => call.method === "PUT").body.selector, "openai/gpt-5:low");

  // Clicking the level that is already active is not a write.
  const writesBefore = calls.filter((call) => call.method === "PUT").length;
  await act(async () => { button(container, "high").click(); });
  assert.equal(calls.filter((call) => call.method === "PUT").length, writesBefore);
  await unmount();
});

test("a failed load is shown and leaves the panel without rows", async () => {
  const { container, unmount } = await mount({
    respond: (call) => call.url.startsWith("/api/model-roles")
      ? json({ error: "roles unavailable" }, false, 500)
      : json(MODELS),
  });
  assert.match(container.textContent, /HTTP 500/);
  assert.equal(container.querySelector('[role="group"]'), null);
  await unmount();
});

test("a failed write keeps the previous assignment and shows the reason", async () => {
  const { container, calls, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/model-roles" && call.method === "PUT") return json({ error: "read-only config" }, false, 403);
      return defaultRespond(call);
    },
  });
  await chooseModel(container, "Default", "Claude Sonnet 4");
  assert.match(container.textContent, /read-only config/);
  assert.equal(container.querySelector('button[aria-label="Default"]').textContent.includes("GPT-5 — openai"), true);
  assert.ok(calls.some((call) => call.method === "PUT"));
  await unmount();
});
