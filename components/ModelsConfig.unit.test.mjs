import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";

/**
 * The models panel, stubbed at `/api/models-config`, its discovery/test/catalog
 * endpoints, both auth provider lists, and the login stream.
 *
 * Every detail view is reached the way a user reaches it — a click in the tree
 * or in the picker — because the selection state is internal. The OAuth stream
 * is a fake `EventSource`: the panel's whole behaviour is "what does this
 * message do to the dialog", so the messages are sent directly.
 */

const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
restoreLinkedomPrototypesOnExit(win);
const nav = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };
win.getComputedStyle = () => new Proxy({}, { get: (_t, p) => (typeof p === "string" && p.startsWith("get") ? () => "" : "0px") });
win.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
win.open = () => null;
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

class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.closed = false;
    FakeEventSource.instances.push(this);
  }
  close() { this.closed = true; }
  emit(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  fail() {
    this.onerror?.({});
  }
}
globalThis.EventSource = FakeEventSource;
win.EventSource = FakeEventSource;

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ModelsConfig } = await jiti.import("./ModelsConfig.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { TooltipProvider } = await jiti.import("./ui/tooltip.tsx");
const { createRoot } = await import("react-dom/client");

const CWD = "/home/alice/workspace/demo";

const OAUTH_PROVIDERS = [
  { id: "github-copilot", name: "GitHub Copilot", usesCallbackServer: true, loggedIn: false, supportsApiKey: false },
  { id: "google", name: "Google", usesCallbackServer: false, loggedIn: false, supportsApiKey: true },
  { id: "logged-oauth", name: "Connected Provider", usesCallbackServer: false, loggedIn: true },
];

const API_KEY_PROVIDERS = [
  { id: "deepseek", displayName: "DeepSeek", configured: false, modelCount: 2 },
  { id: "openai", displayName: "OpenAI", configured: true, source: "file", modelCount: 3 },
  { id: "mystery-gateway", displayName: "Mystery", configured: false, modelCount: 1 },
];

function modelsJson() {
  return {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        api: "openai-completions",
        apiKey: "OPENAI_KEY",
        headers: { "X-Provider": "p" },
        models: [{
          id: "gpt-5",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 128000,
          headers: { "X-Model": "m" },
        }],
      },
      bare: {},
    },
  };
}

function catalog() {
  return {
    recommendation: {
      preset: {
        name: "GPT-5",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 400000,
        maxTokens: 128000,
        cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
      },
      price: { status: "ok", method: "consensus", support: 4, total: 5 },
    },
  };
}

function json(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

async function mount({ respond } = {}) {
  win.document.body.innerHTML = "";
  FakeEventSource.instances = [];
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const call = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    if (respond) return respond(call);
    if (url.startsWith("/api/models-config/catalog")) return json(catalog());
    if (url === "/api/models-config/discover") {
      return json({ models: [{ id: "gpt-5" }, { id: "o4-mini", name: "o4 mini" }], endpoint: "https://api.openai.com/v1/models" });
    }
    if (url === "/api/models-config/test") return json({ ok: true, latencyMs: 42, status: 200, responseText: "pong" });
    if (url === "/api/models-config" && call.method === "PUT") return json({ success: true });
    if (url === "/api/models-config") return json(modelsJson());
    if (url === "/api/auth/providers") return json({ providers: OAUTH_PROVIDERS });
    if (url === "/api/auth/all-providers") return json({ providers: API_KEY_PROVIDERS });
    if (url === "/api/model-roles") return json({ roles: [] });
    if (url.startsWith("/api/models")) return json({ modelList: [], thinkingLevels: {} });
    return json({ providers: OAUTH_PROVIDERS });
  };
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null,
      React.createElement(TooltipProvider, null,
        React.createElement(ModelsConfig, {
          cwd: CWD,
          onClose: () => calls.push({ url: "close" }),
          onModelsChanged: () => calls.push({ url: "models-changed" }),
        }),
      ),
    ));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  return {
    container,
    calls,
    async unmount() { await act(async () => { root.unmount(); }); globalThis.fetch = originalFetch; },
  };
}

function button(container, text) {
  return [...container.querySelectorAll("button")].find((node) => (node.textContent ?? "").trim() === text);
}

function clickable(container, text) {
  return [...container.querySelectorAll("div")]
    .filter((node) => (node.getAttribute("style") ?? "").includes("cursor:pointer") && (node.textContent ?? "").includes(text))
    .at(-1);
}

function card(container, text) {
  return [...container.querySelectorAll("button")]
    .filter((node) => (node.textContent ?? "").includes(text))
    .sort((a, b) => (a.textContent ?? "").length - (b.textContent ?? "").length)[0];
}

function reactProps(element) {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps"));
  return key ? element[key] : null;
}

function valueOf(element) {
  return reactProps(element)?.value;
}

async function type(element, value, { blur = false } = {}) {
  await act(async () => {
    const prototype = element.tagName === "TEXTAREA"
      ? win.HTMLTextAreaElement.prototype
      : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    reactProps(element)?.onChange?.({ target: element, currentTarget: element, preventDefault() {}, stopPropagation() {} });
  });
  if (blur) await act(async () => { reactProps(element)?.onBlur?.({ target: element, currentTarget: element, preventDefault() {}, stopPropagation() {} }); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

async function check(input, checked) {
  // linkedom exposes `checked` read-only, and the handlers only read
  // `event.target.checked`, so the value travels on the event.
  await act(async () => {
    reactProps(input)?.onChange?.({ target: { checked }, currentTarget: input, preventDefault() {}, stopPropagation() {} });
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

async function emit(payload) {
  const es = FakeEventSource.instances.at(-1);
  await act(async () => { es.emit(payload); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

test("loads the tree, the role panel, both provider lists, and saves the file", async () => {
  const { container, calls, unmount } = await mount();
  assert.match(container.textContent, /^Models/);
  assert.match(container.textContent, /Model roles/);
  assert.match(container.textContent, /openai/);
  assert.match(container.textContent, /gpt-5/);
  assert.match(container.textContent, /bare/);
  assert.match(container.textContent, /Connected Provider/);
  assert.match(container.textContent, /OpenAI/);
  assert.ok(calls.some((call) => call.url === "/api/auth/providers"));
  assert.ok(calls.some((call) => call.url === "/api/auth/all-providers"));
  assert.ok(calls.some((call) => call.url.startsWith("/api/model-roles")));

  await act(async () => { button(container, "Save").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  const put = calls.find((call) => call.method === "PUT");
  assert.equal(put.url, "/api/models-config");
  assert.equal(put.body.providers.openai.baseUrl, "https://api.openai.com/v1");
  assert.ok(calls.some((call) => call.url === "models-changed"));
  assert.equal(button(container, "Saved").disabled, true);

  await exercisePointerHandlers(container);
  await act(async () => { container.querySelector("button").click(); });
  assert.ok(calls.some((call) => call.url === "close"));
  await unmount();
});

test("a failed save keeps the panel open with the server reason", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.method === "PUT") return json({ error: "models.yml is read-only" }, false, 403);
      if (call.url === "/api/models-config") return json(modelsJson());
      if (call.url === "/api/auth/providers") return json({ providers: OAUTH_PROVIDERS });
      if (call.url === "/api/auth/all-providers") return json({ providers: API_KEY_PROVIDERS });
      if (call.url === "/api/model-roles") return json({ roles: [] });
      return json({ modelList: [], thinkingLevels: {} });
    },
  });
  await act(async () => { button(container, "Save").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /models\.yml is read-only/);
  assert.ok(button(container, "Save"));
  await unmount();
});

test("provider detail edits the name (with rename), base URL and headers", async () => {
  const { container, calls, unmount } = await mount();
  await act(async () => { clickable(container, "openai").click(); });
  assert.match(container.textContent, /Base URL/);
  const baseUrl = [...container.querySelectorAll("input")].find((input) => input.placeholder === "https://api.example.com/v1");
  assert.equal(valueOf(baseUrl), "https://api.openai.com/v1");

  const nameInput = container.querySelector('input[placeholder="provider-name"]');
  await type(nameInput, "acme");
  await act(async () => { button(container, "Rename").click(); });
  assert.ok(clickable(container, "acme"), "der Baum zeigt den neuen Namen nicht");

  // Renaming remounts the detail (it is keyed by the provider name).
  const renamedBaseUrl = [...container.querySelectorAll("input")].find((input) => input.placeholder === "https://api.example.com/v1");
  await type(renamedBaseUrl, "https://gw.example.test/v1");
  // Header editor starts with the provider's one row.
  const headerInputs = [...container.querySelectorAll('input[placeholder="Header-Name"]')];
  assert.equal(headerInputs.length, 1);
  await act(async () => { button(container, "+ Add header").click(); });
  const names = [...container.querySelectorAll('input[placeholder="Header-Name"]')];
  assert.equal(names.length, 2);
  await type(names[1], "X-New");
  const values = [...container.querySelectorAll('input[placeholder="value"]')];
  await type(values[1], "v");
  // Removing the first row leaves the new one.
  const removeButtons = [...container.querySelectorAll("button")].filter((node) => node.textContent.trim() === "✕");
  await act(async () => { removeButtons[0].click(); });
  assert.equal(container.querySelectorAll('input[placeholder="Header-Name"]').length, 1);

  await act(async () => { button(container, "Save").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  const put = calls.find((call) => call.method === "PUT");
  const provider = put.body.providers.acme;
  assert.equal(provider.baseUrl, "https://gw.example.test/v1");
  assert.deepEqual(provider.headers, { "X-New": "v" });
  await unmount();
});

test("deleting a provider selects the remaining one", async () => {
  const { container, unmount } = await mount();
  await act(async () => { clickable(container, "openai").click(); });
  await act(async () => { button(container, "Delete").click(); });
  assert.equal(clickable(container, "openai"), undefined);
  assert.ok(clickable(container, "bare"));
  assert.match(container.textContent, /Base URL/, "der Detailbereich ist leer");
  await unmount();
});

test("discovery lists, filters and adds selected models without duplicates", async () => {
  const { container, calls, unmount } = await mount();
  await act(async () => { clickable(container, "openai").click(); });
  const fetchButton = button(container, "Import models…");
  assert.equal(fetchButton.disabled, false);
  await act(async () => { fetchButton.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });

  const post = calls.find((call) => call.url === "/api/models-config/discover");
  assert.equal(post.body.providerName, "openai");
  assert.equal(post.body.provider.models, undefined);
  assert.match(container.textContent, /o4 mini/);
  assert.match(container.textContent, /added/);
  await exercisePointerHandlers(container);

  const filter = container.querySelector('[aria-label="Filter upstream models"]');
  const discoveredList = filter.nextElementSibling;
  await type(filter, "o4");
  assert.match(discoveredList.textContent, /o4 mini/);
  assert.doesNotMatch(discoveredList.textContent, /gpt-5/);

  const checkboxes = [...container.querySelectorAll('input[type="checkbox"]')];
  await act(async () => { checkboxes.at(-1).click(); });
  const addSelected = button(container, "Add selected (1)");
  assert.ok(addSelected, "der Zähler fehlt");
  await act(async () => { addSelected.click(); });
  assert.ok(clickable(container, "o4-mini"), "das importierte Modell fehlt im Baum");
  await unmount();
});

test("discovery failure and a provider without a base URL", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/models-config/discover") return json({ error: "provider unreachable" }, false, 502);
      if (call.url === "/api/models-config") return json(modelsJson());
      if (call.url === "/api/auth/providers") return json({ providers: [] });
      if (call.url === "/api/auth/all-providers") return json({ providers: [] });
      if (call.url === "/api/model-roles") return json({ roles: [] });
      return json({ modelList: [], thinkingLevels: {} });
    },
  });
  await act(async () => { clickable(container, "openai").click(); });
  await act(async () => { button(container, "Import models…").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /provider unreachable/);

  const baseUrl = [...container.querySelectorAll("input")].find((input) => input.placeholder === "https://api.example.com/v1");
  await type(baseUrl, "");
  assert.equal(button(container, "Import models…").disabled, true);
  await unmount();
});

test("model detail tests the connection and fills empty fields from the catalog", async () => {
  const { container, calls, unmount } = await mount();
  await act(async () => { clickable(container, "gpt-5").click(); });

  await act(async () => { button(container, "Test").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  const testCall = calls.find((call) => call.url === "/api/models-config/test");
  assert.equal(testCall.body.providerName, "openai");
  assert.equal(testCall.body.model.id, "gpt-5");
  assert.match(container.textContent, /Connected · 42ms · HTTP 200 · pong/);
  assert.ok(button(container, "OK"));

  await act(async () => { button(container, "Fill model details").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  const catalogCall = calls.find((call) => call.url.startsWith("/api/models-config/catalog"));
  assert.match(catalogCall.url, /q=gpt-5/);
  assert.match(catalogCall.url, /provider=openai/);
  assert.match(catalogCall.url, /baseUrl=https%3A%2F%2Fapi\.openai\.com%2Fv1/);
  assert.match(container.textContent, /6 fields filled · Price agreed by 4\/5 records/);
  assert.ok(button(container, "Undo"));
  const maxTokens = [...container.querySelectorAll('input[type="number"]')][1];
  assert.equal(valueOf(maxTokens), "128000");

  await act(async () => { button(container, "Undo").click(); });
  assert.equal(valueOf([...container.querySelectorAll('input[type="number"]')][1]), "");
  assert.equal(button(container, "Undo"), undefined);
  await unmount();
});

test("a failed connection test and a failed catalog lookup are separate messages", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/models-config/test") return json({ ok: false, error: "401 from upstream", latencyMs: 12, status: 401 }, false, 200);
      if (call.url.startsWith("/api/models-config/catalog")) return json({ error: "catalog offline" }, false, 503);
      if (call.url === "/api/models-config") return json(modelsJson());
      if (call.url === "/api/auth/providers") return json({ providers: [] });
      if (call.url === "/api/auth/all-providers") return json({ providers: [] });
      if (call.url === "/api/model-roles") return json({ roles: [] });
      return json({ modelList: [], thinkingLevels: {} });
    },
  });
  await act(async () => { clickable(container, "gpt-5").click(); });
  await act(async () => { button(container, "Test").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /Failed · 12ms · HTTP 401 · 401 from upstream/);

  await act(async () => { button(container, "Fill model details").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /catalog offline/);
  await unmount();
});

test("checkboxes and the thinking map write the model entry", async () => {
  const { container, calls, unmount } = await mount();
  await act(async () => { clickable(container, "gpt-5").click(); });

  // Reasoning is on, so the compatibility controls and the map are visible.
  assert.ok(button(container, "clear all") === undefined, "die Karte ist anfangs leer");
  const levels = [...container.querySelectorAll("div")].filter((node) => node.textContent?.trim().startsWith("off"));
  assert.ok(levels.length > 0);

  const checks = [...container.querySelectorAll('input[type="checkbox"]')];
  // [reasoning, image, deepseek compat, developer role]
  await check(checks[2], true);
  const offRow = [...container.querySelectorAll("div")].find((node) => node.textContent?.trim().startsWith("off"));
  const disabled = [...offRow.querySelectorAll("button")].find((node) => node.textContent.trim() === "Disabled");
  await act(async () => { disabled.click(); });
  assert.ok(button(container, "clear all"), "die Karte hat keinen Eintrag");

  const custom = [...container.querySelectorAll("div")].find((node) => node.textContent?.trim().startsWith("high"));
  const customButton = [...custom.querySelectorAll("button")].find((node) => node.textContent.trim() === "Custom");
  await act(async () => { customButton.click(); });
  const customInput = custom.querySelector("input");
  await type(customInput, "hi");
  await act(async () => { button(container, "clear all").click(); });

  await check(checks[1], false);
  await act(async () => { button(container, "Save").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  const saved = calls.find((call) => call.method === "PUT").body.providers.openai.models[0];
  assert.equal(saved.compat.thinkingFormat, "deepseek");
  assert.equal(saved.thinkingLevelMap, undefined);
  assert.equal(saved.input, undefined);
  await unmount();
});

test("the developer-role checkbox writes an explicit false override", async () => {
  const { container, calls, unmount } = await mount();
  await act(async () => { clickable(container, "gpt-5").click(); });
  const checks = [...container.querySelectorAll('input[type="checkbox"]')];
  await check(checks[3], false);
  await act(async () => { button(container, "Save").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  const saved = calls.find((call) => call.method === "PUT").body.providers.openai.models[0];
  assert.equal(saved.compat.supportsDeveloperRole, false);
  await unmount();
});

test("model headers and numeric fields are edited independently", async () => {
  const { container, calls, unmount } = await mount();
  await act(async () => { clickable(container, "gpt-5").click(); });
  const names = [...container.querySelectorAll('input[placeholder="Header-Name"]')];
  assert.equal(names.length, 1);
  await act(async () => { button(container, "+ Add header").click(); });
  const added = [...container.querySelectorAll('input[placeholder="Header-Name"]')].at(-1);
  await type(added, "X-Extra");
  const values = [...container.querySelectorAll('input[placeholder="value"]')];
  await type(values.at(-1), "yes");

  const context = [...container.querySelectorAll('input[type="number"]')][0];
  await type(context, "64000");
  const costs = [...container.querySelectorAll('input[placeholder="0"]')].filter((input) => input.type === "number");
  await type(costs[0], "3.5");

  await act(async () => { button(container, "Save").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  const saved = calls.find((call) => call.method === "PUT").body.providers.openai.models[0];
  assert.deepEqual(saved.headers, { "X-Model": "m", "X-Extra": "yes" });
  assert.equal(saved.contextWindow, 64000);
  assert.equal(saved.cost.input, 3.5);
  await unmount();
});

test("adding and removing a model moves the selection correctly", async () => {
  const { container, calls, unmount } = await mount();
  await act(async () => { clickable(container, "openai").click(); });
  await act(async () => { clickable(container, "+ Model").click(); });
  assert.match(container.textContent, /ID \*/);
  const idInput = container.querySelector('input[placeholder="model-id"]');
  assert.equal(valueOf(idInput), "");
  await type(idInput, "gpt-6");
  await act(async () => { button(container, "Remove").click(); });
  assert.equal(clickable(container, "gpt-6"), undefined);
  assert.ok(clickable(container, "gpt-5"));

  // Adding to a provider without models works too.
  await act(async () => { clickable(container, "bare").click(); });
  await act(async () => { clickable(container, "+ Model").click(); });
  await type(container.querySelector('input[placeholder="model-id"]'), "first");
  await act(async () => { button(container, "Save").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  const saved = calls.find((call) => call.method === "PUT").body.providers.bare;
  assert.deepEqual(saved.models, [{ id: "first" }]);
  await unmount();
});

test("the picker searches, adds a custom provider, and Escape closes it", async () => {
  const { container, unmount } = await mount();
  await act(async () => { button(container, "+ Add provider").click(); });
  assert.match(container.textContent, /OpenAI \/ Anthropic compatible/);
  assert.match(container.textContent, /GitHub Copilot/);
  assert.match(container.textContent, /DeepSeek/);
  // Unknown provider id falls back to initials.
  assert.match(container.textContent, /MG|MY/);

  const search = container.querySelector('input[placeholder="Search providers…"]');
  await type(search, "copilot");
  assert.match(container.textContent, /GitHub Copilot/);
  assert.doesNotMatch(container.textContent, /DeepSeek/);
  await type(search, "zzz");
  assert.match(container.textContent, /No providers match/);

  await act(async () => {
    const escape = new win.Event("keydown", { bubbles: true });
    escape.key = "Escape";
    search.dispatchEvent(escape);
  });
  assert.equal(container.querySelector('input[placeholder="Search providers…"]'), null);

  await act(async () => { button(container, "+ Add provider").click(); });
  await act(async () => { card(container, "OpenAI / Anthropic compatible").click(); });
  assert.ok(clickable(container, "new-provider"));
  assert.match(container.textContent, /Base URL/);
  await exercisePointerHandlers(container);
  await unmount();
});

test("the OAuth flow follows the stream: auth, code, success", async () => {
  const { container, calls, unmount } = await mount();
  await act(async () => { button(container, "+ Add provider").click(); });
  await act(async () => { card(container, "GitHub Copilot").click(); });

  await act(async () => { button(container, "Login").click(); });
  const es = FakeEventSource.instances.at(-1);
  assert.equal(es.url, "/api/auth/login/github-copilot");
  assert.match(container.textContent, /Opening browser…/);

  await emit({ type: "auth", url: "https://github.com/login/device", instructions: "paste the URL", token: "tok-1" });
  assert.match(container.textContent, /Complete sign-in in the browser/);
  assert.match(container.textContent, /click here to open the login page/);
  const codeInput = [...container.querySelectorAll("input")].find((input) => input.placeholder.startsWith("http://localhost:1455"));
  assert.ok(codeInput, "das Codefeld fehlt");
  await type(codeInput, "  http://localhost:1455/auth/callback?code=abc  ");
  await act(async () => { button(container, "Submit").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  const post = calls.find((call) => call.url === "/api/auth/login/github-copilot" && call.method === "POST");
  assert.deepEqual(post.body, { token: "tok-1", code: "http://localhost:1455/auth/callback?code=abc" });

  const refreshesBefore = calls.filter((call) => call.url === "/api/auth/providers").length;
  await emit({ type: "success" });
  assert.match(container.textContent, /Connected successfully\./);
  await exercisePointerHandlers(container);
  assert.ok(es.closed);
  assert.equal(calls.filter((call) => call.url === "/api/auth/providers").length, refreshesBefore + 1);
  await unmount();
});

test("device codes, prompts and selections each render their control", async () => {
  const { container, calls, unmount } = await mount();
  await act(async () => { button(container, "+ Add provider").click(); });
  await act(async () => { card(container, "Google").click(); });
  await act(async () => { button(container, "Login").click(); });

  await emit({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://google.test/device", intervalSeconds: 5, expiresInSeconds: 600 });
  assert.match(container.textContent, /ABCD-1234/);
  assert.match(container.textContent, /Expires in 10 minutes/);
  assert.match(container.textContent, /https:\/\/google\.test\/device/);

  await emit({ type: "prompt_request", message: "Paste the token", placeholder: "token here", token: "tok-2" });
  assert.match(container.textContent, /Paste the token/);
  assert.equal([...container.querySelectorAll("input")].some((input) => input.placeholder === "token here"), true);

  await emit({ type: "select_request", message: "Pick an organization", token: "tok-3", options: [{ id: "org-a", label: "Org A" }, { id: "org-b", label: "Org B" }] });
  assert.match(container.textContent, /Pick an organization/);
  await act(async () => { button(container, "Org B").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.deepEqual(calls.find((call) => call.url === "/api/auth/login/google" && call.method === "POST").body, { token: "tok-3", code: "org-b" });

  await emit({ type: "progress", message: "Waiting for approval…" });
  assert.match(container.textContent, /Waiting for approval…/);

  await emit({ type: "cancelled" });
  assert.ok(button(container, "Login"));
  await unmount();
});

test("stream errors and a lost connection end in the error state", async () => {
  const { container, unmount } = await mount();
  await act(async () => { button(container, "+ Add provider").click(); });
  await act(async () => { card(container, "GitHub Copilot").click(); });
  await act(async () => { button(container, "Login").click(); });
  await emit({ type: "error", message: "access_denied" });
  assert.match(container.textContent, /access_denied/);
  assert.ok(FakeEventSource.instances.at(-1).closed);

  await act(async () => { button(container, "Login").click(); });
  await act(async () => { FakeEventSource.instances.at(-1).fail(); });
  assert.match(container.textContent, /Connection lost/);
  await unmount();
});

test("a rejected code is shown and the field can be retried", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/auth/login/github-copilot" && call.method === "POST") return json({ error: "invalid_grant" }, false, 400);
      if (call.url === "/api/models-config") return json(modelsJson());
      if (call.url === "/api/auth/providers") return json({ providers: OAUTH_PROVIDERS });
      if (call.url === "/api/auth/all-providers") return json({ providers: API_KEY_PROVIDERS });
      if (call.url === "/api/model-roles") return json({ roles: [] });
      return json({ modelList: [], thinkingLevels: {} });
    },
  });
  await act(async () => { button(container, "+ Add provider").click(); });
  await act(async () => { card(container, "GitHub Copilot").click(); });
  await act(async () => { button(container, "Login").click(); });
  await emit({ type: "auth", url: "https://github.test", instructions: null, token: "tok" });
  const codeInput = [...container.querySelectorAll("input")].find((input) => input.placeholder.startsWith("http://localhost"));
  await type(codeInput, "code");
  await act(async () => { button(container, "Submit").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /invalid_grant/);
  await unmount();
});

test("a logged-in provider can disconnect", async () => {
  const { container, calls, unmount } = await mount();
  await act(async () => { clickable(container, "Connected Provider").click(); });
  assert.match(container.textContent, /Already connected/);
  await act(async () => { button(container, "Disconnect").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  const logout = calls.find((call) => call.url === "/api/auth/logout/logged-oauth");
  assert.equal(logout.method, "POST");
  await unmount();
});

test("API key save posts the trimmed key, and remove deletes it", async () => {
  const { container, calls, unmount } = await mount();
  await act(async () => { clickable(container, "OpenAI").click(); });
  assert.match(container.textContent, /API key is stored/);
  const input = [...container.querySelectorAll("input")].find((element) => element.type === "password");
  await type(input, "  sk-new-key  ");
  await act(async () => { button(container, "Save").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  const post = calls.find((call) => call.url === "/api/auth/api-key/openai");
  assert.deepEqual(post.body, { apiKey: "sk-new-key" });
  assert.ok(button(container, "Saved"));

  await act(async () => { button(container, "Disconnect").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.equal(calls.filter((call) => call.url === "/api/auth/api-key/openai" && call.method === "DELETE").length, 1);
  await unmount();
});

test("API key save and remove failures are reported", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/auth/api-key/openai" && call.method === "POST") return json({ error: "key rejected" }, false, 400);
      if (call.url === "/api/auth/api-key/openai" && call.method === "DELETE") return json({ error: "file locked" }, false, 500);
      if (call.url === "/api/models-config") return json(modelsJson());
      if (call.url === "/api/auth/providers") return json({ providers: [] });
      if (call.url === "/api/auth/all-providers") return json({ providers: API_KEY_PROVIDERS });
      if (call.url === "/api/model-roles") return json({ roles: [] });
      return json({ modelList: [], thinkingLevels: {} });
    },
  });
  await act(async () => { clickable(container, "OpenAI").click(); });
  const input = [...container.querySelectorAll("input")].find((element) => element.type === "password");
  await type(input, "sk-bad");
  await act(async () => { button(container, "Save").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /key rejected/);

  await act(async () => { button(container, "Disconnect").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /file locked/);
  await unmount();
});

test("an unknown provider draws its initials instead of an icon", async () => {
  const { container, unmount } = await mount();
  await act(async () => { button(container, "+ Add provider").click(); });
  const mystery = card(container, "Mystery");
  assert.ok(mystery);
  assert.match(mystery.textContent, /MY|MG/);
  await unmount();
});

test("an empty provider list leaves the roles view and the picker usable", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/models-config") return json({ providers: {} });
      if (call.url === "/api/auth/providers") return json({ providers: [] });
      if (call.url === "/api/auth/all-providers") return json({ providers: [] });
      if (call.url === "/api/model-roles") return json({ roles: [] });
      return json({ modelList: [], thinkingLevels: {} });
    },
  });
  assert.doesNotMatch(container.textContent, /openai/);
  assert.match(container.textContent, /Model roles/);
  assert.ok(button(container, "+ Add provider"));
  await act(async () => { button(container, "+ Add provider").click(); });
  assert.match(container.textContent, /No providers match|OpenAI \/ Anthropic compatible/);
  await unmount();
});

/** Runs every hover/focus handler on the mounted tree once. */
async function exercisePointerHandlers(container) {
  let invoked = 0;
  await act(async () => {
    for (const node of container.querySelectorAll("*")) {
      const props = reactProps(node);
      if (!props) continue;
      for (const name of ["onMouseEnter", "onMouseLeave", "onFocus", "onBlur"]) {
        if (typeof props[name] !== "function") continue;
        props[name]({ currentTarget: node, target: node, preventDefault() {}, stopPropagation() {} });
        invoked += 1;
      }
    }
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return invoked;
}

test("every closed state piece subscribes to pointer handlers", async () => {
  const { container, unmount } = await mount();
  await act(async () => { clickable(container, "openai").click(); });
  await act(async () => { clickable(container, "gpt-5").click(); });
  assert.ok(await exercisePointerHandlers(container) > 20);
  await unmount();
});

test("a network failure while saving reports it instead of closing", async () => {
  const { container, calls, unmount } = await mount({
    respond: (call) => {
      if (call.method === "PUT") throw new Error("connection reset");
      if (call.url === "/api/models-config") return json(modelsJson());
      if (call.url === "/api/auth/providers") return json({ providers: [] });
      if (call.url === "/api/auth/all-providers") return json({ providers: [] });
      if (call.url === "/api/model-roles") return json({ roles: [] });
      return json({ modelList: [], thinkingLevels: {} });
    },
  });
  await act(async () => { button(container, "Save").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /connection reset/);
  assert.ok(button(container, "Save"));
  assert.equal(calls.filter((call) => call.url === "close").length, 0);
  await unmount();
});

test("discovery and test-connection network failures are reported", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/models-config/discover") throw new Error("dns lookup failed");
      if (call.url === "/api/models-config/test") throw new Error("socket hang up");
      if (call.url === "/api/models-config") return json(modelsJson());
      if (call.url === "/api/auth/providers") return json({ providers: [] });
      if (call.url === "/api/auth/all-providers") return json({ providers: [] });
      if (call.url === "/api/model-roles") return json({ roles: [] });
      return json({ modelList: [], thinkingLevels: {} });
    },
  });
  await act(async () => { clickable(container, "openai").click(); });
  await act(async () => { button(container, "Import models…").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /dns lookup failed/);

  await act(async () => { clickable(container, "gpt-5").click(); });
  await act(async () => { button(container, "Test").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /socket hang up/);
  await unmount();
});

test("select-all and a filter without matches drive the discovery list", async () => {
  const many = Array.from({ length: 320 }, (_, index) => ({ id: `model-${index}` }));
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/models-config/discover") return json({ models: many, endpoint: "https://api.openai.com/v1/models" });
      if (call.url === "/api/models-config") return json(modelsJson());
      if (call.url === "/api/auth/providers") return json({ providers: [] });
      if (call.url === "/api/auth/all-providers") return json({ providers: [] });
      if (call.url === "/api/model-roles") return json({ roles: [] });
      return json({ modelList: [], thinkingLevels: {} });
    },
  });
  await act(async () => { clickable(container, "openai").click(); });
  await act(async () => { button(container, "Import models…").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /Showing first 300 of 320/);

  const selectAll = container.querySelector('input[type="checkbox"]');
  await check(selectAll, true);
  assert.match(container.textContent, /Add selected \(300\)/);
  await check(selectAll, false);
  assert.equal(button(container, "Add selected").disabled, true);

  const filter = container.querySelector('[aria-label="Filter upstream models"]');
  await type(filter, "zzz");
  assert.match(container.textContent, /No matching models\./);
  await unmount();
});

test("the thinking map clears one level and the deepseek override can be removed", async () => {
  const { container, calls, unmount } = await mount();
  await act(async () => { clickable(container, "gpt-5").click(); });
  const checks = [...container.querySelectorAll('input[type="checkbox"]')];
  await check(checks[2], true);
  const offRow = [...container.querySelectorAll("div")].find((node) => node.textContent?.trim().startsWith("off"));
  await act(async () => { [...offRow.querySelectorAll("button")].find((node) => node.textContent.trim() === "Disabled").click(); });
  assert.ok(button(container, "clear all"));
  // The same button removes that level again.
  await act(async () => { [...offRow.querySelectorAll("button")].find((node) => node.textContent.trim() === "Default").click(); });
  // Turning the deepseek override off drops the whole compatibility object.
  await check(checks[2], false);
  await act(async () => { button(container, "Save").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  const saved = calls.find((call) => call.method === "PUT").body.providers.openai.models[0];
  assert.equal(saved.compat, undefined);
  await unmount();
});

test("catalog fills the remaining empty fields of a bare model", async () => {
  const { container, calls, unmount } = await mount({
    respond: (call) => {
      if (call.url.startsWith("/api/models-config/catalog")) {
        return json({
          recommendation: {
            preset: { name: "Bare", reasoning: true, input: ["text"], contextWindow: 64000, maxTokens: 8000, cost: { input: 2, output: 3, cacheRead: 1, cacheWrite: 4 } },
            price: { status: "unreliable", reason: "no-exact-match" },
          },
        });
      }
      if (call.url === "/api/models-config") {
        return json({ providers: { bare: { baseUrl: "https://bare.test/v1", models: [{ id: "tiny" }] } } });
      }
      if (call.url === "/api/auth/providers") return json({ providers: [] });
      if (call.url === "/api/auth/all-providers") return json({ providers: [] });
      if (call.url === "/api/model-roles") return json({ roles: [] });
      return json({ modelList: [], thinkingLevels: {} });
    },
  });
  await act(async () => { clickable(container, "tiny").click(); });
  await act(async () => { button(container, "Fill model details").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /9 fields filled · No exact models.dev match/);
  const numbers = [...container.querySelectorAll('input[type="number"]')];
  assert.equal(valueOf(numbers[0]), "64000");
  assert.equal(valueOf(numbers[1]), "8000");
  const checks = [...container.querySelectorAll('input[type="checkbox"]')];
  assert.equal(reactProps(checks[0])?.checked, true);
  assert.equal(reactProps(checks[1])?.checked, false);

  await act(async () => { button(container, "Fill model details").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /No empty fields to fill/);
  await unmount();
});

test("catalog price variants each pick their sentence", async () => {
  const variants = [
    { price: { status: "unreliable", reason: "provider-disagrees" }, text: /No reliable price found/ },
    { price: { status: "unreliable", reason: "single-provider" }, text: /No reliable price found/ },
    { price: { status: "ok", method: "provider", providerName: "Acme" }, text: /Price matched Provider Acme/ },
    { price: { status: "ok", method: "base-url", providerId: "acme" }, text: /Price matched Base URL to acme/ },
  ];
  for (const variant of variants) {
    const { container, unmount } = await mount({
      respond: (call) => {
        if (call.url.startsWith("/api/models-config/catalog")) {
          return json({ recommendation: { preset: { maxTokens: 100 }, price: variant.price } });
        }
        if (call.url === "/api/models-config") {
          return json({ providers: { bare: { baseUrl: "https://bare.test/v1", models: [{ id: "tiny" }] } } });
        }
        if (call.url === "/api/auth/providers") return json({ providers: [] });
        if (call.url === "/api/auth/all-providers") return json({ providers: [] });
        if (call.url === "/api/model-roles") return json({ roles: [] });
        return json({ modelList: [], thinkingLevels: {} });
      },
    });
    await act(async () => { clickable(container, "tiny").click(); });
    await act(async () => { button(container, "Fill model details").click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    assert.match(container.textContent, variant.text);
    await unmount();
  }
});

test("a failed catalog fetch is reported", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url.startsWith("/api/models-config/catalog")) throw new Error("catalog service down");
      if (call.url === "/api/models-config") {
        return json({ providers: { bare: { baseUrl: "https://bare.test/v1", models: [{ id: "tiny" }] } } });
      }
      if (call.url === "/api/auth/providers") return json({ providers: [] });
      if (call.url === "/api/auth/all-providers") return json({ providers: [] });
      if (call.url === "/api/model-roles") return json({ roles: [] });
      return json({ modelList: [], thinkingLevels: {} });
    },
  });
  await act(async () => { clickable(container, "tiny").click(); });
  await act(async () => { button(container, "Fill model details").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /catalog service down/);
  await unmount();
});

test("an API-key provider can be configured from the picker", async () => {
  const { container, calls, unmount } = await mount();
  await act(async () => { button(container, "+ Add provider").click(); });
  await act(async () => { card(container, "DeepSeek").click(); });
  assert.match(container.textContent, /API Key/);
  assert.match(container.textContent, /2 models/);
  const input = [...container.querySelectorAll("input")].find((element) => element.type === "password");
  await type(input, "sk-deepseek");
  await act(async () => { button(container, "Save").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.equal(calls.find((call) => call.url === "/api/auth/api-key/deepseek").body.apiKey, "sk-deepseek");
  await unmount();
});

test("logging out to an empty provider list shows the placeholder again", async () => {
  let loggedOut = false;
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/auth/logout/logged-oauth") { loggedOut = true; return json({ success: true }); }
      if (call.url === "/api/auth/providers") return json({ providers: loggedOut ? [] : OAUTH_PROVIDERS });
      if (call.url === "/api/models-config") return json(modelsJson());
      if (call.url === "/api/auth/all-providers") return json({ providers: [] });
      if (call.url === "/api/model-roles") return json({ roles: [] });
      return json({ modelList: [], thinkingLevels: {} });
    },
  });
  await act(async () => { clickable(container, "Connected Provider").click(); });
  await act(async () => { button(container, "Disconnect").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /Select a provider or model/);
  await unmount();
});

test("the OAuth selection submit handles a network failure", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/auth/login/google" && call.method === "POST") throw new Error("network down");
      if (call.url === "/api/models-config") return json(modelsJson());
      if (call.url === "/api/auth/providers") return json({ providers: OAUTH_PROVIDERS });
      if (call.url === "/api/auth/all-providers") return json({ providers: [] });
      if (call.url === "/api/model-roles") return json({ roles: [] });
      return json({ modelList: [], thinkingLevels: {} });
    },
  });
  await act(async () => { button(container, "+ Add provider").click(); });
  await act(async () => { card(container, "Google").click(); });
  await act(async () => { button(container, "Login").click(); });
  await emit({ type: "select_request", message: "Pick", token: "tok", options: [{ id: "a", label: "A" }] });
  await act(async () => { button(container, "A").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /network down/);
  await unmount();
});

test("a single discovered model toggles out of the selection again", async () => {
  const { container, unmount } = await mount();
  await act(async () => { clickable(container, "openai").click(); });
  await act(async () => { button(container, "Import models…").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  const modelCheckbox = [...container.querySelectorAll("label")]
    .find((label) => (label.textContent ?? "").includes("o4 mini"))
    .querySelector('input[type="checkbox"]');
  await act(async () => {
    reactProps(modelCheckbox)?.onChange?.({ target: modelCheckbox, currentTarget: modelCheckbox, preventDefault() {}, stopPropagation() {} });
  });
  assert.match(container.textContent, /Add selected \(1\)/);
  await act(async () => {
    reactProps(modelCheckbox)?.onChange?.({ target: modelCheckbox, currentTarget: modelCheckbox, preventDefault() {}, stopPropagation() {} });
  });
  assert.equal(button(container, "Add selected").disabled, true);
  await unmount();
});

test("submitting the OAuth code reports a network failure", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/auth/login/github-copilot" && call.method === "POST") throw new Error("link lost");
      if (call.url === "/api/models-config") return json(modelsJson());
      if (call.url === "/api/auth/providers") return json({ providers: OAUTH_PROVIDERS });
      if (call.url === "/api/auth/all-providers") return json({ providers: [] });
      if (call.url === "/api/model-roles") return json({ roles: [] });
      return json({ modelList: [], thinkingLevels: {} });
    },
  });
  await act(async () => { button(container, "+ Add provider").click(); });
  await act(async () => { card(container, "GitHub Copilot").click(); });
  await act(async () => { button(container, "Login").click(); });
  await emit({ type: "auth", url: "https://github.test", token: "tok" });
  const codeInput = [...container.querySelectorAll("input")].find((input) => input.placeholder.startsWith("http://localhost"));
  await type(codeInput, "code");
  await act(async () => { button(container, "Submit").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /link lost/);
  await unmount();
});

test("a refused selection submit shows the server reason", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/auth/login/google" && call.method === "POST") return json({ error: "selection expired" }, false, 400);
      if (call.url === "/api/models-config") return json(modelsJson());
      if (call.url === "/api/auth/providers") return json({ providers: OAUTH_PROVIDERS });
      if (call.url === "/api/auth/all-providers") return json({ providers: [] });
      if (call.url === "/api/model-roles") return json({ roles: [] });
      return json({ modelList: [], thinkingLevels: {} });
    },
  });
  await act(async () => { button(container, "+ Add provider").click(); });
  await act(async () => { card(container, "Google").click(); });
  await act(async () => { button(container, "Login").click(); });
  await emit({ type: "select_request", message: "Pick", token: "tok", options: [{ id: "a", label: "A" }] });
  await act(async () => { button(container, "A").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /selection expired/);
  await unmount();
});

test("API-key save and remove network failures are separate alerts", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/auth/api-key/openai" && call.method === "POST") throw new Error("write failed");
      if (call.url === "/api/auth/api-key/openai" && call.method === "DELETE") throw new Error("delete failed");
      if (call.url === "/api/models-config") return json(modelsJson());
      if (call.url === "/api/auth/providers") return json({ providers: [] });
      if (call.url === "/api/auth/all-providers") return json({ providers: API_KEY_PROVIDERS });
      if (call.url === "/api/model-roles") return json({ roles: [] });
      return json({ modelList: [], thinkingLevels: {} });
    },
  });
  await act(async () => { clickable(container, "OpenAI").click(); });
  const input = [...container.querySelectorAll("input")].find((element) => element.type === "password");
  await type(input, "sk-value");
  await act(async () => { button(container, "Save").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /write failed/);

  await act(async () => { button(container, "Disconnect").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /delete failed/);
  await unmount();
});

test("the API-key field reveals and hides its value", async () => {
  const { container, unmount } = await mount();
  await act(async () => { clickable(container, "OpenAI").click(); });
  const field = [...container.querySelectorAll("input")].find((element) => element.type === "password");
  assert.ok(field, "das Passwortfeld fehlt");
  const show = container.querySelector('button[aria-label="Show details"]');
  assert.ok(show, "der Augenschalter fehlt");
  await act(async () => { show.click(); });
  assert.ok(container.querySelector('button[aria-label="Hide details"]'));
  assert.equal([...container.querySelectorAll("input")].find((element) => element.type === "text") !== undefined, true);
  await act(async () => { container.querySelector('button[aria-label="Hide details"]').click(); });
  assert.ok(container.querySelector('button[aria-label="Show details"]'));
  await unmount();
});
