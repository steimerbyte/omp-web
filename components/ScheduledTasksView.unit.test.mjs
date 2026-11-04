import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";

/**
 * The scheduled-task list and its dialog, stubbed at
 * `/api/scheduled-tasks`, `/api/scheduled-settings` and `/api/models`.
 *
 * The dialog is the interesting part: the visible cron field and the three
 * simple fields write one value, a preset fills all three, and the form only
 * submits when the expression parses, the name and prompt are non-empty, and a
 * model is chosen.
 */

const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
restoreLinkedomPrototypesOnExit(win);
const nav = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };
win.getComputedStyle = () => new Proxy({}, { get: (_t, p) => (typeof p === "string" && p.startsWith("get") ? () => "" : "0px") });
win.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
win.Element.prototype.scrollIntoView = () => {};
win.HTMLElement.prototype.scrollIntoView = () => {};
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
const { ScheduledTasksView } = await jiti.import("./ScheduledTasksView.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { createRoot } = await import("react-dom/client");

const HOME = "/srv/accounts/alice";
const PROJECT = `${HOME}/demo`;

function task(overrides = {}) {
  return {
    id: "task-1",
    name: "Morning brief",
    cron: "0 8 * * 1-5",
    prompt: "Summarise the open reviews.",
    provider: "openai",
    modelId: "gpt-5",
    thinkingLevel: "medium",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastRunAt: "2026-01-02T08:00:00.000Z",
    lastRunStatus: "ok",
    lastRunSessionId: "session-old",
    nextRun: Date.now() + 60 * 60 * 1000,
    ...overrides,
  };
}

function json(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

async function mount({ tasks = [task()], respond } = {}) {
  win.document.body.innerHTML = "";
  const calls = [];
  let store = tasks.map((entry) => ({ ...entry }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const call = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    if (respond) return respond(call, store);
    if (url === "/api/scheduled-tasks" && call.method === "GET") return json({ tasks: store });
    if (url === "/api/scheduled-tasks" && call.method === "POST") {
      store = [...store, { ...task({ id: "task-new", name: call.body.name, cron: call.body.cron, prompt: call.body.prompt }), ...call.body }];
      return json({ task: store.at(-1) });
    }
    if (url.startsWith("/api/scheduled-tasks/") && call.method === "PATCH") {
      store = store.map((entry) => entry.id === decodeURIComponent(url.split("/")[3]) ? { ...entry, ...call.body } : entry);
      return json({ task: store[0] });
    }
    if (url.startsWith("/api/scheduled-tasks/") && call.method === "DELETE") {
      store = store.filter((entry) => entry.id !== decodeURIComponent(url.split("/")[3]));
      return json({ deleted: true });
    }
    if (url.startsWith("/api/scheduled-tasks/") && url.endsWith("/run")) {
      return json({ sessionId: "session-run" });
    }
    if (url === "/api/scheduled-settings") return json({ defaultCwd: null, home: HOME, folders: [PROJECT] });
    if (url.startsWith("/api/models")) {
      return json({ modelList: [{ provider: "openai", id: "gpt-5", name: "GPT-5", model: "gpt-5" }, { provider: "anthropic", id: "claude", name: "Claude" }] });
    }
    return json({});
  };
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(ScheduledTasksView, {
      onOpenSession: (id) => calls.push({ url: "open-session", id }),
    })));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  return {
    container,
    calls,
    async unmount() { await act(async () => { root.unmount(); }); globalThis.fetch = originalFetch; },
  };
}

// Radix renders the dialog into a portal on document.body, so every lookup
// goes through the document rather than the component container.
function all(selector) {
  return [...win.document.querySelectorAll(selector)];
}

function el(selector) {
  return win.document.querySelector(selector);
}

function button(_container, text) {
  return all("button").find((node) => (node.textContent ?? "").trim() === text);
}

function reactProps(element) {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps"));
  return key ? element[key] : null;
}

async function type(element, value) {
  await act(async () => {
    const prototype = element.tagName === "TEXTAREA"
      ? win.HTMLTextAreaElement.prototype
      : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    reactProps(element)?.onChange?.({ target: element, currentTarget: element, preventDefault() {}, stopPropagation() {} });
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
}

async function choose(select, value) {
  await act(async () => {
    reactProps(select)?.onChange?.({ target: { value }, currentTarget: select, preventDefault() {}, stopPropagation() {} });
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
}

async function submit(form) {
  await act(async () => {
    reactProps(form)?.onSubmit?.({ preventDefault() {}, stopPropagation() {} });
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
}

function dialog() {
  return el('[role="dialog"]');
}

test("lists tasks with schedule, run state, folder, and actions", async () => {
  const { container, calls, unmount } = await mount();
  assert.match(container.textContent, /Scheduled tasks/);
  assert.match(container.textContent, /Morning brief/);
  assert.match(container.textContent, /Weekdays at 08:00/);
  assert.match(container.textContent, /Last run: .*Started/);
  assert.match(container.textContent, /\/srv\/accounts\/alice/);
  assert.equal(el('[role="switch"]').getAttribute("aria-checked"), "true");

  await act(async () => { el('[role="switch"]').click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.deepEqual(calls.find((call) => call.method === "PATCH").body, { enabled: false });

  await act(async () => { button(container, "Run now").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.equal(calls.filter((call) => call.url === "/api/scheduled-tasks/task-1/run").length, 1);
  assert.equal(calls.filter((call) => call.url === "/api/scheduled-tasks").length >= 2, true);

  await act(async () => { button(container, "Open the session of the last run").click(); });
  assert.deepEqual(calls.find((call) => call.url === "open-session"), { url: "open-session", id: "session-old" });
  await unmount();
});

test("a failed hand start stays on its own row", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url.endsWith("/run")) return json({ error: "model is gone" }, false, 400);
      if (call.url === "/api/scheduled-tasks") return json({ tasks: [task()] });
      if (call.url === "/api/scheduled-settings") return json({ defaultCwd: null, home: HOME, folders: [PROJECT] });
      return json({});
    },
  });
  await act(async () => { button(container, "Run now").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  const alert = el("li [role='alert']");
  assert.ok(alert, "die Zeilenmeldung fehlt");
  assert.match(alert.textContent, /model is gone/);
  assert.equal(button(container, "Run now").disabled, false);
  await unmount();
});

test("the dialog's preset fills the simple fields and the cron", async () => {
  const { container, unmount } = await mount();
  await act(async () => { button(container, "New scheduled task").click(); });
  assert.ok(dialog());
  assert.match(dialog().textContent, /New scheduled task/);
  const cron = el("#scheduled-cron");
  assert.equal(reactProps(cron)?.value, "0 8 * * *");

  await act(async () => { button(container, "Weekdays at 08:00").click(); });
  assert.equal(reactProps(el("#scheduled-cron"))?.value, "0 8 * * 1-5");
  assert.equal(reactProps(el("#scheduled-minute"))?.value, "0");
  assert.equal(reactProps(el("#scheduled-hour"))?.value, "8");
  assert.equal(reactProps(el("#scheduled-weekday"))?.value, "1-5");
  assert.equal(button(container, "Weekdays at 08:00").getAttribute("aria-pressed"), "true");

  await act(async () => { button(container, "Hourly").click(); });
  assert.equal(reactProps(el("#scheduled-cron"))?.value, "0 * * * *");
  // Hourly does not fit the three-field editor, so the fields disappear but
  // the raw input is still the source of truth.
  assert.equal(el("#scheduled-minute"), null);
  await unmount();
});

test("the simple fields and the weekday select write the same cron string", async () => {
  const { container, unmount } = await mount();
  await act(async () => { button(container, "New scheduled task").click(); });
  await type(el("#scheduled-minute"), "30");
  assert.equal(reactProps(el("#scheduled-cron"))?.value, "30 8 * * *");
  await type(el("#scheduled-hour"), "9");
  assert.equal(reactProps(el("#scheduled-cron"))?.value, "30 9 * * *");
  await choose(el("#scheduled-weekday"), "1-5");
  assert.equal(reactProps(el("#scheduled-cron"))?.value, "30 9 * * 1-5");
  await unmount();
});

test("an invalid expression blocks saving until it parses again", async () => {
  const { container, unmount } = await mount();
  await act(async () => { button(container, "New scheduled task").click(); });
  const name = el("#scheduled-name");
  await type(name, "Nightly");
  await type(el("#scheduled-prompt"), "Do the thing");
  await choose(el("#scheduled-model"), "openai\u0000gpt-5");
  assert.equal(button(container, "Save task").disabled, false);

  await type(el("#scheduled-cron"), "0 8 L * *");
  assert.match(dialog().querySelector("[role='alert']").textContent, /This cron expression is not valid\. \(dayOfMonth: L\)/);
  assert.equal(button(container, "Save task").disabled, true);

  await type(el("#scheduled-cron"), "0 8 * * *");
  assert.equal(button(container, "Save task").disabled, false);
  await unmount();
});

test("creating a task posts every field, including the explicit null folder", async () => {
  const { container, calls, unmount } = await mount();
  await act(async () => { button(container, "New scheduled task").click(); });
  await type(el("#scheduled-name"), "Nightly");
  await type(el("#scheduled-prompt"), "Do the thing");
  await choose(el("#scheduled-model"), "anthropic\u0000claude");
  await act(async () => { button(container, "Every 15 minutes").click(); });
  const enabled = el('input[type="checkbox"]');
  await act(async () => {
    reactProps(enabled)?.onChange?.({ target: { checked: false }, currentTarget: enabled, preventDefault() {}, stopPropagation() {} });
  });
  await submit(dialog().querySelector("form"));

  const post = calls.find((call) => call.method === "POST" && call.url === "/api/scheduled-tasks");
  assert.deepEqual(post.body, {
    name: "Nightly",
    cron: "*/15 * * * *",
    prompt: "Do the thing",
    provider: "anthropic",
    modelId: "claude",
    cwd: null,
    enabled: false,
  });
  assert.equal(dialog(), null);
  assert.match(container.textContent, /Nightly/);
  await unmount();
});

test("a create conflict shows the version sentence, not the server line", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/scheduled-tasks" && call.method === "POST") {
        return json({ error: "written by another version and this build writes 1" }, false, 409);
      }
      if (call.url === "/api/scheduled-tasks") return json({ tasks: [task()] });
      if (call.url === "/api/scheduled-settings") return json({ defaultCwd: null, home: HOME, folders: [] });
      return json({ modelList: [{ provider: "openai", id: "gpt-5", name: "GPT-5" }] });
    },
  });
  await act(async () => { button(container, "New scheduled task").click(); });
  await type(el("#scheduled-name"), "Nightly");
  await type(el("#scheduled-prompt"), "Do the thing");
  await choose(el("#scheduled-model"), "openai\u0000gpt-5");
  await submit(dialog().querySelector("form"));
  const alert = dialog().querySelector("[role='alert']");
  assert.match(alert.textContent, /written by a newer version of omp-web/);
  await unmount();
});

test("a locked create shows the lock sentence", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/scheduled-tasks" && call.method === "POST") return json({ error: "locked" }, false, 503);
      if (call.url === "/api/scheduled-tasks") return json({ tasks: [task()] });
      if (call.url === "/api/scheduled-settings") return json({ defaultCwd: null, home: HOME, folders: [] });
      return json({ modelList: [{ provider: "openai", id: "gpt-5", name: "GPT-5" }] });
    },
  });
  await act(async () => { button(container, "New scheduled task").click(); });
  await type(el("#scheduled-name"), "Nightly");
  await type(el("#scheduled-prompt"), "Do the thing");
  await choose(el("#scheduled-model"), "openai\u0000gpt-5");
  await submit(dialog().querySelector("form"));
  assert.match(dialog().querySelector("[role='alert']").textContent, /Another process is writing the task file/);
  await unmount();
});

test("editing prepopulates and PATCHes only the submitted shape", async () => {
  const { container, calls, unmount } = await mount();
  await act(async () => { button(container, "Edit").click(); });
  assert.match(dialog().textContent, /Edit scheduled task|Edit task/);
  assert.equal(reactProps(el("#scheduled-name"))?.value, "Morning brief");
  assert.equal(reactProps(el("#scheduled-cron"))?.value, "0 8 * * 1-5");
  assert.equal(reactProps(el("#scheduled-prompt"))?.value, "Summarise the open reviews.");
  assert.equal(reactProps(el("#scheduled-weekday"))?.value, "1-5");

  await type(el("#scheduled-prompt"), "Summarise the open reviews, briefly.");
  await submit(dialog().querySelector("form"));
  const patch = calls.find((call) => call.method === "PATCH");
  assert.deepEqual(patch.url, "/api/scheduled-tasks/task-1");
  assert.equal(patch.body.prompt, "Summarise the open reviews, briefly.");
  assert.equal(patch.body.enabled, true);
  assert.equal(patch.body.cwd, null);
  await unmount();
});

test("delete asks inline first, cancel keeps the task, confirm deletes", async () => {
  const { container, calls, unmount } = await mount();
  await act(async () => { button(container, "Edit").click(); });
  await act(async () => { button(container, "Delete").click(); });
  assert.match(dialog().textContent, /Delete “Morning brief”\?/);
  await act(async () => { button(container, "Cancel").click(); });
  assert.doesNotMatch(dialog().textContent, /Delete “Morning brief”\?/);
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 0);

  await act(async () => { button(container, "Delete").click(); });
  await act(async () => { button(container, "Delete").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.equal(calls.find((call) => call.method === "DELETE").url, "/api/scheduled-tasks/task-1");
  assert.equal(dialog(), null);
  assert.match(container.textContent, /No scheduled tasks/);
  await unmount();
});

test("the model list failure is shown inside the dialog", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/scheduled-tasks") return json({ tasks: [task()] });
      if (call.url === "/api/scheduled-settings") return json({ defaultCwd: null, home: HOME, folders: [] });
      if (call.url.startsWith("/api/models")) return json({ error: "cwd outside the account" }, false, 403);
      return json({});
    },
  });
  await act(async () => { button(container, "New scheduled task").click(); });
  assert.match(dialog().textContent, /The model list could not be loaded\. cwd outside the account/);
  assert.equal(button(container, "Save task").disabled, true);
  await unmount();
});

test("loading, empty, and failed lists each have a state", async () => {
  const empty = await mount({ tasks: [] });
  assert.match(empty.container.textContent, /No scheduled tasks/);
  assert.match(empty.container.textContent, /Create a task with a schedule, a model and a prompt/);
  await empty.unmount();

  const failing = await mount({
    respond: (call) => {
      if (call.url === "/api/scheduled-tasks") return json({ error: "file unreadable" }, false, 500);
      if (call.url === "/api/scheduled-settings") return json({ defaultCwd: null, home: HOME, folders: [] });
      return json({});
    },
  });
  assert.match(failing.container.textContent, /The scheduled tasks could not be loaded\./);
  const before = failing.calls.filter((call) => call.url === "/api/scheduled-tasks").length;
  await act(async () => { button(failing.container, "Retry").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.equal(failing.calls.filter((call) => call.url === "/api/scheduled-tasks").length, before + 1);
  await failing.unmount();
});

test("the folder picker in the dialog offers home and the known folders", async () => {
  const { container, calls, unmount } = await mount();
  await act(async () => { button(container, "New scheduled task").click(); });
  const select = el("#scheduled-cwd");
  const values = [...select.querySelectorAll("option")].map((option) => option.getAttribute("value"));
  assert.deepEqual(values.slice(0, 3), ["", HOME, PROJECT]);
  const option = [...select.querySelectorAll("option")].find((node) => node.getAttribute("value") === PROJECT);
  option.selected = true;
  await act(async () => {
    reactProps(select)?.onChange?.({ target: { value: PROJECT }, currentTarget: select, preventDefault() {}, stopPropagation() {} });
  });
  await type(el("#scheduled-name"), "In project");
  await type(el("#scheduled-prompt"), "Work here");
  await choose(el("#scheduled-model"), "openai\u0000gpt-5");
  await submit(dialog().querySelector("form"));
  assert.equal(calls.find((call) => call.method === "POST").body.cwd, PROJECT);
  await unmount();
});

test("each cron shape gets its own description and dead schedules say so", async () => {
  const { container, unmount } = await mount({
    tasks: [
      task({ id: "a", name: "Ticker", cron: "* * * * *", nextRun: null }),
      task({ id: "b", name: "Quarter", cron: "*/15 * * * *" }),
      task({ id: "c", name: "Hourly15", cron: "15 * * * *", lastRunStatus: "error" }),
      task({ id: "d", name: "Weekly", cron: "0 9 * * 3" }),
      task({ id: "e", name: "Monthly", cron: "0 0 1 * *" }),
      task({ id: "f", name: "Dormant", cron: "0 7 * * *", enabled: false, nextRun: null, lastRunStatus: null, lastRunSessionId: null }),
    ],
  });
  assert.match(container.textContent, /Every minute/);
  assert.match(container.textContent, /Every 15 minutes/);
  assert.match(container.textContent, /Hourly at minute 15/);
  assert.match(container.textContent, /Wednesday at 09:00/);
  assert.match(container.textContent, /This schedule never occurs/);
  assert.match(container.textContent, /Failed to start/);
  assert.match(container.textContent, /0 0 1 \* \*/);
  assert.match(container.textContent, /No upcoming run/);
  await unmount();
});

test("a refused enable toggle is reported without flipping the switch", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.method === "PATCH") return json({ error: "task is locked by another run" }, false, 400);
      if (call.url === "/api/scheduled-tasks") return json({ tasks: [task()] });
      if (call.url === "/api/scheduled-settings") return json({ defaultCwd: null, home: HOME, folders: [PROJECT] });
      return json({});
    },
  });
  await act(async () => { el('[role="switch"]').click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /task is locked by another run/);
  assert.equal(el('[role="switch"]').getAttribute("aria-checked"), "true");
  await unmount();
});

test("a refused delete keeps the confirmation open with the reason", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.method === "DELETE") return json({ error: "store is read-only" }, false, 500);
      if (call.url === "/api/scheduled-tasks") return json({ tasks: [task()] });
      if (call.url === "/api/scheduled-settings") return json({ defaultCwd: null, home: HOME, folders: [PROJECT] });
      return json({});
    },
  });
  await act(async () => { button(container, "Edit").click(); });
  await act(async () => { button(container, "Delete").click(); });
  await act(async () => { button(container, "Delete").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(dialog().textContent, /store is read-only/);
  assert.ok(button(container, "Delete"));
  await unmount();
});

test("a rejected model-list fetch is shown instead of an empty picker", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/scheduled-tasks") return json({ tasks: [task()] });
      if (call.url === "/api/scheduled-settings") return json({ defaultCwd: null, home: HOME, folders: [] });
      if (call.url.startsWith("/api/models")) throw new Error("network down");
      return json({});
    },
  });
  await act(async () => { button(container, "New scheduled task").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(dialog().textContent, /network down/);
  await unmount();
});
