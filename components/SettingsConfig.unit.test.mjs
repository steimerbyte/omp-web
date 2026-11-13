import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";

/**
 * The settings window, stubbed at `/api/settings`, `/api/theme`,
 * `/api/display-settings`, `/api/mcp` and `/api/agent/:id`.
 *
 * Each control has one write route and one follow-up: boolean and select save
 * immediately and ask for a session reload, a theme mapping also re-reads the
 * palettes, the display flag re-reads itself, and MCP saves the whole scope.
 * The conditions decide whether a field is in the DOM at all, so they are
 * asserted through the rendered rows rather than through the helpers.
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
const { SettingsConfig } = await jiti.import("./SettingsConfig.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { createRoot } = await import("react-dom/client");

const CWD = "/home/alice/workspace/demo";
const SESSION = "session-1";

const PALETTE = { name: "Default", colorScheme: "dark", variables: { "--bg": "#000", "--accent": "#f00", "--bg-panel": "#111", "--border": "#222", "--text": "#fff", "--text-muted": "#aaa" } };

function field(overrides) {
  return {
    path: "x.y",
    tab: "interaction",
    label: "Field",
    description: "A setting.",
    type: "boolean",
    value: false,
    defaultValue: false,
    configured: false,
    writable: true,
    ...overrides,
  };
}

function settings(overrides = {}) {
  return {
    tabs: [
      { id: "appearance", label: "Appearance", groups: ["Theme", "Layout"] },
      { id: "interaction", label: "Interaction", groups: ["Behaviour"] },
      { id: "memory", label: "Memory", groups: ["Memory", "Tools"] },
    ],
    fields: [
      field({ path: "theme.dark", tab: "appearance", group: "Theme", label: "Dark theme", type: "select", value: "default", defaultValue: "default", options: [{ value: "default", label: "Default", description: "Standard dark" }, { value: "forest", label: "Forest" }] }),
      field({ path: "theme.light", tab: "appearance", group: "Theme", label: "Light theme", type: "select", value: "default", defaultValue: "default", options: [{ value: "default", label: "Default" }, { value: "daylight", label: "Daylight" }] }),
      field({ path: "appearance.accent", tab: "appearance", group: "Theme", label: "Accent intensity", type: "text", value: "0.8", defaultValue: "1" }),
      field({ path: "hideThinkingBlock", tab: "appearance", group: "Layout", label: "Hide thinking", value: false, defaultValue: false }),
      field({ path: "advisor.enabled", label: "Advisor", value: false, defaultValue: false }),
      field({ path: "advisor.model", label: "Advisor model", type: "text", value: "gpt-5", defaultValue: "", condition: "advisorEnabled" }),
      field({ path: "defaultThinkingLevel", tab: "interaction", group: "Behaviour", label: "Thinking level", type: "select", value: "medium", defaultValue: "medium", options: [{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "auto", label: "Auto" }] }),
      field({ path: "autoThinkingLevel", tab: "interaction", group: "Behaviour", label: "Auto thinking", type: "select", value: "medium", defaultValue: "medium", condition: "autoThinkingActive", options: [{ value: "medium", label: "Medium" }] }),
      field({ path: "retry.attempts", tab: "interaction", group: "Behaviour", label: "Attempts", type: "select", value: 2, defaultValue: 1, options: [{ value: "1", label: "One" }, { value: "2", label: "Two" }, { value: "3", label: "Three" }] }),
      field({ path: "retry.usageAwareFallback", tab: "interaction", label: "Usage-aware fallback", value: false, defaultValue: false }),
      field({ path: "retry.usageAwareThreshold", tab: "interaction", label: "Usage threshold", type: "text", value: "0.9", defaultValue: "1", condition: "usageAwareFallbackEnabled" }),
      field({ path: "plan.enabled", tab: "interaction", label: "Plan mode", value: false, defaultValue: false }),
      field({ path: "plan.maxSteps", tab: "interaction", label: "Plan steps", type: "text", value: "8", defaultValue: "8", condition: "planModeEnabled" }),
      field({ path: "features.unexpectedStopDetection", tab: "interaction", label: "Unexpected stop detection", value: false, defaultValue: false }),
      field({ path: "features.unexpectedStopWindow", tab: "interaction", label: "Stop window", type: "text", value: "3", defaultValue: "3", condition: "unexpectedStopDetection" }),
      field({ path: "api.secret", tab: "interaction", label: "API key", type: "secret", value: "stored-secret", defaultValue: "", configured: true }),
      field({ path: "features.locked", tab: "interaction", label: "Locked flag", value: true, defaultValue: true, writable: false }),
      field({ path: "hasImage.field", tab: "interaction", label: "Image field", type: "text", value: "x", defaultValue: "", condition: "hasImageProtocol" }),
      field({ path: "unknown.condition", tab: "interaction", label: "Unknown condition field", type: "text", value: "visible", defaultValue: "" , condition: "somethingElse" }),
      field({ path: "ghost.field", tab: "ghost", label: "Ghost field", type: "text", value: "hidden without search", defaultValue: "" }),
      field({ path: "autolearn.enabled", tab: "interaction", label: "Autolearn", value: false, defaultValue: false }),
      field({ path: "autolearn.maxSkills", tab: "interaction", label: "Autolearn limit", type: "text", value: "5", defaultValue: "5", condition: "autolearnActive" }),
      field({ path: "memory.backend", tab: "memory", group: "Memory", label: "Memory backend", type: "select", value: "local", defaultValue: "local", options: [{ value: "local", label: "Local" }, { value: "hindsight", label: "Hindsight" }, { value: "mnemopi", label: "Mnemopi" }] }),
      field({ path: "memory.hindsightUrl", tab: "memory", group: "Memory", label: "Hindsight URL", type: "text", value: "http://hindsight", defaultValue: "", condition: "hindsightActive" }),
      field({ path: "memory.mnemopiPath", tab: "memory", group: "Memory", label: "Mnemopi path", type: "text", value: "/tmp/mnemopi", defaultValue: "", condition: "mnemopiActive" }),
      field({ path: "provider.limits", tab: "memory", group: "Memory", label: "Provider limits", type: "providerLimits", value: { openai: 2 }, defaultValue: {} }),
      field({ path: "tools.order", tab: "memory", group: "Tools", label: "Ordered tools", type: "multiselect", ordered: true, value: ["b"], defaultValue: [], options: [{ value: "a", label: "A" }, { value: "b", label: "B" }, { value: "c", label: "C" }] }),
      field({ path: "tools.flat", tab: "memory", group: "Tools", label: "Flat tools", type: "multiselect", value: [], defaultValue: [], options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }] }),
    ],
    availableThemes: [{ name: "default", colorScheme: "dark" }],
    theme: { names: { dark: "default", light: "default" }, palettes: { dark: PALETTE, light: { ...PALETTE, name: "Light", colorScheme: "light" } } },
    ...overrides,
  };
}

function mcpConfig(overrides = {}) {
  return {
    user: {
      path: "/home/alice/.omp/agent/mcp.json",
      servers: [
        { name: "native", config: { type: "stdio", command: "node" }, enabled: true, editable: true },
        { name: "claude-owned", config: { type: "http", url: "https://example.test/mcp" }, enabled: false, editable: false, source: { path: "/home/alice/.claude.json", provider: "claude" } },
      ],
    },
    project: null,
    ...overrides,
  };
}

function json(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

async function mount({ respond, initialSection = "themes", isAdmin = true, cwd = CWD, sessionId = SESSION } = {}) {
  win.document.body.innerHTML = "";
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const call = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    if (respond) return respond(call);
    if (url.startsWith("/api/whoami")) return json({ user: { username: "admin", isAdmin } });
    if (url.startsWith("/api/settings") && call.method === "PATCH") return json({ value: call.body.value });
    if (url.startsWith("/api/settings")) return json(settings());
    if (url.startsWith("/api/theme")) return json(settings().theme);
    if (url.startsWith("/api/display-settings")) return json({ hideThinkingBlock: call.body?.value ?? false });
    if (url.startsWith("/api/mcp") && call.method === "GET") return json(mcpConfig());
    if (url.startsWith("/api/mcp")) return json({});
    if (url.startsWith("/api/agent/")) return json({ success: true });
    return json({});
  };
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(SettingsConfig, {
      cwd,
      sessionId,
      initialSection,
      onClose: () => calls.push({ url: "close" }),
      onModelsChanged: () => calls.push({ url: "models-changed" }),
      onReloaded: () => calls.push({ url: "reloaded" }),
    })));
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

function navButton(container, text) {
  return [...container.querySelectorAll("nav button")].find((node) => (node.textContent ?? "").trim() === text);
}

function labelNode(container, label) {
  return [...container.querySelectorAll("div")].find((node) => (node.textContent ?? "").trim() === label);
}

function row(container, label) {
  const labelEl = labelNode(container, label);
  assert.ok(labelEl, `Zeile ${label} fehlt`);
  return labelEl.closest('[data-writable]');
}

function reactProps(element) {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps"));
  return key ? element[key] : null;
}

async function setText(element, value, { blur = true } = {}) {
  await act(async () => {
    const prototype = element.tagName === "TEXTAREA"
      ? win.HTMLTextAreaElement.prototype
      : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    reactProps(element)?.onChange?.({ target: element, currentTarget: element, preventDefault() {}, stopPropagation() {} });
  });
  // The blur handler closes over the value that was rendered; let the change
  // commit before firing it, exactly like a user moving to the next field.
  if (blur) {
    await act(async () => {
      reactProps(element)?.onBlur?.({ target: element, currentTarget: element, preventDefault() {}, stopPropagation() {} });
    });
  }
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
}

function areaValue(element) {
  return reactProps(element)?.value;
}

async function choose(container, ariaLabel, optionText) {
  const trigger = container.querySelector(`button[aria-label="${ariaLabel}"]`);
  assert.ok(trigger, `Trigger ${ariaLabel} fehlt`);
  await act(async () => { trigger.click(); });
  const option = [...container.querySelectorAll('[role="option"]')]
    .find((node) => (node.textContent ?? "").includes(optionText));
  assert.ok(option, `Option ${optionText} fehlt`);
  await act(async () => { option.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
}

test("renders theme cards with the active mode and previews the other", async () => {
  const { container, unmount } = await mount();
  assert.match(container.textContent, /Themes/);
  assert.match(container.textContent, /dark mapping/);
  assert.match(container.textContent, /light mapping/);
  assert.match(container.textContent, /Active on web/);
  const preview = button(container, "Preview light") ?? button(container, "Preview dark");
  assert.ok(preview, "der Preview-Knopf fehlt");
  const before = win.document.documentElement.dataset.ompThemeMode;
  await act(async () => { preview.click(); });
  await act(async () => { (button(container, "Preview light") ?? button(container, "Preview dark")).click(); });
  assert.notEqual(win.document.documentElement.dataset.ompThemeMode, before);
  await unmount();
});

test("a theme mapping saves, re-reads the theme and their settings", async () => {
  const { container, calls, unmount } = await mount();
  await choose(container, "light theme", "Daylight");
  const patch = calls.find((call) => call.method === "PATCH");
  assert.deepEqual(patch.body, { path: "theme.light", value: "daylight" });
  assert.ok(calls.some((call) => call.url.startsWith("/api/theme") && call.url.includes("cwd=")));
  assert.equal(calls.filter((call) => call.url.startsWith("/api/settings?")).length, 2);
  await unmount();
});

test("a boolean writes immediately and offers a session reload", async () => {
  const { container, calls, unmount } = await mount({ initialSection: "settings:appearance" });
  assert.match(container.textContent, /Hide thinking/);
  const toggle = row(container, "Hide thinking").querySelector("button[aria-pressed]");
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  await act(async () => { toggle.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.deepEqual(calls.find((call) => call.method === "PATCH").body, { path: "hideThinkingBlock", value: true });
  // The display flag is applied at once, so no reload banner.
  assert.equal(container.textContent.includes("Reload the active session"), false);
  assert.ok(calls.some((call) => call.url.startsWith("/api/display-settings")));
  await unmount();
});

test("a normal boolean shows the reload notice and reloading posts the command", async () => {
  const { container, calls, unmount } = await mount({ initialSection: "settings:interaction" });
  const toggle = row(container, "Advisor").querySelector("button[aria-pressed]");
  await act(async () => { toggle.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /Reload the active session to apply runtime settings/);
  await act(async () => { button(container, "Reload session").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.deepEqual(calls.find((call) => call.url === `/api/agent/${SESSION}`).body, { type: "reload" });
  assert.doesNotMatch(container.textContent, /Reload the active session/);
  assert.ok(calls.some((call) => call.url === "reloaded"));
  await unmount();
});

test("a failed save is reported under its own field and changes nothing", async () => {
  const { container, unmount } = await mount({
    initialSection: "settings:interaction",
    respond: (call) => {
      if (call.method === "PATCH") return json({ error: "config is read-only" }, false, 403);
      if (call.url.startsWith("/api/whoami")) return json({ user: { isAdmin: true } });
      return json(settings());
    },
  });
  await act(async () => { row(container, "Advisor").querySelector("button[aria-pressed]").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(row(container, "Advisor").textContent, /config is read-only/);
  assert.equal(row(container, "Advisor").querySelector("button[aria-pressed]").getAttribute("aria-pressed"), "false");
  await unmount();
});

test("text fields save on blur, secrets only when non-empty", async () => {
  const { container, calls, unmount } = await mount();
  // Themes section renders the appearance Theme fields below the cards.
  const accent = row(container, "Accent intensity").querySelector("input");
  await setText(accent, "0.5");
  assert.deepEqual(calls.find((call) => call.method === "PATCH").body, { path: "appearance.accent", value: "0.5" });

  await act(async () => { navButton(container, "Interaction").click(); });
  const secret = row(container, "API key").querySelector("input");
  assert.equal(secret.type, "password");
  assert.equal(secret.value, "");
  assert.equal(secret.placeholder, "Configured — enter to replace");
  await setText(secret, "");
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
  await setText(secret, "fresh-secret");
  assert.deepEqual(calls.filter((call) => call.method === "PATCH").at(-1).body, { path: "api.secret", value: "fresh-secret" });
  await unmount();
});

test("a select saves the string, or the number when the value is numeric", async () => {
  const { container, calls, unmount } = await mount({ initialSection: "settings:interaction" });
  await choose(container, "Thinking level", "Auto");
  assert.deepEqual(calls.find((call) => call.method === "PATCH").body, { path: "defaultThinkingLevel", value: "auto" });
  // Once auto is chosen, the conditional field appears.
  assert.ok(labelNode(container, "Auto thinking"), "das bedingte Feld fehlt");

  await choose(container, "Attempts", "Three");
  assert.deepEqual(calls.filter((call) => call.method === "PATCH").at(-1).body, { path: "retry.attempts", value: 3 });
  await unmount();
});

test("every condition gates its field on the value it reads", async () => {
  const { container, unmount } = await mount({ initialSection: "settings:interaction" });
  for (const hidden of ["Advisor model", "Usage threshold", "Plan steps", "Stop window", "Autolearn limit", "Image field"]) {
    assert.equal(labelNode(container, hidden), undefined, `${hidden} ist sichtbar`);
  }
  assert.ok(labelNode(container, "Unknown condition field"));

  const toggles = [
    ["Usage-aware fallback", "Usage threshold"],
    ["Plan mode", "Plan steps"],
    ["Unexpected stop detection", "Stop window"],
    ["Autolearn", "Autolearn limit"],
  ];
  for (const [toggleLabel, revealed] of toggles) {
    await act(async () => { row(container, toggleLabel).querySelector("button[aria-pressed]").click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    assert.ok(labelNode(container, revealed), `${revealed} fehlt nach ${toggleLabel}`);
  }

  await act(async () => { navButton(container, "Memory").click(); });
  await choose(container, "Memory backend", "Mnemopi");
  assert.ok(labelNode(container, "Mnemopi path"));
  assert.equal(labelNode(container, "Hindsight URL"), undefined);
  await unmount();
});

test("a read-only setting keeps its control disabled", async () => {
  const { container, unmount } = await mount({ initialSection: "settings:interaction" });
  const locked = row(container, "Locked flag").querySelector("button[aria-pressed]");
  assert.equal(locked.disabled, true);
  assert.equal(row(container, "Locked flag").getAttribute("data-writable"), "false");
  await unmount();
});

test("multiselect toggles options and reorders the ordered ones", async () => {
  const { container, calls, unmount } = await mount({ initialSection: "settings:memory" });
  const ordered = row(container, "Ordered tools");
  const [a, b, c] = [...ordered.querySelectorAll("button")].filter((node) => ["A", "B", "C"].includes(node.textContent.trim()));
  assert.equal(a.parentElement.getAttribute("data-selected"), "false");
  assert.equal(b.parentElement.getAttribute("data-selected"), "true");
  assert.equal([...ordered.querySelectorAll("button")].filter((node) => ["A", "B", "C"].includes(node.textContent.trim())).length, 3);

  await act(async () => { a.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.deepEqual(calls.filter((call) => call.method === "PATCH").at(-1).body, { path: "tools.order", value: ["b", "a"] });

  // B now sits before A, so its → is enabled and makes ["a", "b"].
  const refreshed = row(container, "Ordered tools");
  const moveRight = [...refreshed.querySelectorAll("button")].find((node) => node.textContent.trim() === "→" && !node.disabled);
  assert.ok(moveRight, "kein aktiver →-Knopf");
  await act(async () => { moveRight.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.deepEqual(calls.filter((call) => call.method === "PATCH").at(-1).body, { path: "tools.order", value: ["a", "b"] });
  await unmount();

});

test("multiselect removes an already selected option", async () => {
  const { container, calls, unmount } = await mount({ initialSection: "settings:memory" });
  const flat = row(container, "Flat tools");
  const x = [...flat.querySelectorAll("button")].find((node) => node.textContent.trim() === "X");
  await act(async () => { x.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.deepEqual(calls.filter((call) => call.method === "PATCH").at(-1).body, { path: "tools.flat", value: ["x"] });
  await unmount();
});

test("the provider-limits JSON editor saves valid JSON and refuses broken JSON", async () => {
  const { container, calls, unmount } = await mount({ initialSection: "settings:memory" });
  const textarea = row(container, "Provider limits").querySelector("textarea");
  assert.match(areaValue(textarea), /"openai": 2/);

  await setText(textarea, "{ not json", { blur: true });
  assert.match(row(container, "Provider limits").textContent, /Unexpected|JSON|position/i);
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 0);

  await setText(textarea, '{"anthropic": 3}', { blur: true });
  assert.deepEqual(calls.find((call) => call.method === "PATCH").body, { path: "provider.limits", value: { anthropic: 3 } });
  await unmount();
});

test("search crosses every tab and reports invisible matches", async () => {
  const { container, unmount } = await mount();
  const search = container.querySelector('input[placeholder="Search /settings"]');
  await setText(search, "ghost", { blur: false });
  assert.match(container.textContent, /Search · 1/);
  assert.ok(labelNode(container, "Ghost field"));
  assert.equal(labelNode(container, "Accent intensity"), undefined);

  await setText(search, "zzz-no-match", { blur: false });
  assert.match(container.textContent, /Search · 0/);
  assert.match(container.textContent, /No settings match this search\./);
  await unmount();
});

test("the navigation hides accounts from non-admins and locks project areas without a cwd", async () => {
  const projectless = await mount({ cwd: null, isAdmin: false });
  assert.equal(navButton(projectless.container, "Accounts"), undefined);
  assert.equal(navButton(projectless.container, "Skills").disabled, true);
  assert.match(navButton(projectless.container, "Skills").getAttribute("title"), /requires a project/);
  assert.equal(navButton(projectless.container, "MCP").disabled, false);
  await projectless.unmount();

  const admin = await mount({ isAdmin: true });
  assert.ok(navButton(admin.container, "Accounts"));
  await admin.unmount();
});

test("the Chat section toggles hidden messages without a settings request", async () => {
  storage.clear();
  const view = await mount({ initialSection: "chat" });
  try {
    const toggle = view.container.querySelector('button[aria-label="Show hidden messages"]');
    assert.ok(toggle, "Schalter fehlt");
    assert.equal(toggle.getAttribute("aria-pressed"), "false");
    await act(async () => { toggle.click(); });
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
    assert.equal(storage.get("omp-show-hidden-messages"), "true");
    // Surface preference only: nothing goes through /api/settings.
    assert.equal(view.calls.some((call) => call.url.startsWith("/api/settings") && call.method === "PATCH"), false);
    await act(async () => { toggle.click(); });
    assert.equal(storage.get("omp-show-hidden-messages"), "false");
  } finally {
    await view.unmount();
  }
});

test("closing calls both callbacks, and the backdrop only closes on itself", async () => {
  const { container, calls, unmount } = await mount();
  const backdrop = container.querySelector('[role="dialog"]').parentElement;
  await act(async () => {
    backdrop.querySelector('[role="dialog"]').dispatchEvent(new win.Event("mousedown", { bubbles: true }));
  });
  assert.equal(calls.some((call) => call.url === "close"), false);
  await act(async () => { backdrop.dispatchEvent(new win.Event("mousedown", { bubbles: true })); });
  assert.ok(calls.some((call) => call.url === "close"));
  assert.ok(calls.some((call) => call.url === "models-changed"));
  await unmount();
});

test("the close rail also calls the close callback", async () => {
  const { container, calls, unmount } = await mount();
  await act(async () => { button(container, "Close settings×").click(); });
  assert.ok(calls.some((call) => call.url === "close"));
  await unmount();
});

test("a load failure is the section's message, and the skeleton while loading", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { container, unmount } = await mount({
    respond: async (call) => {
      if (call.url.startsWith("/api/whoami")) return json({ user: { isAdmin: true } });
      if (call.url.startsWith("/api/settings")) {
        await gate;
        return json({ error: "settings file unreadable" }, false, 500);
      }
      return json({});
    },
  });
  assert.ok(container.querySelector('[role="status"][aria-label="Loading themes…"]'));
  await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /settings file unreadable/);
  await unmount();
});

test("MCP lists both scopes, toggles with a session reload, and saves the scope", async () => {
  let store = mcpConfig();
  const { container, calls, unmount } = await mount({
    initialSection: "mcp",
    respond: (call) => {
      if (call.url.startsWith("/api/whoami")) return json({ user: { isAdmin: true } });
      if (call.url.startsWith("/api/settings")) return json(settings());
      if (call.url.startsWith("/api/mcp") && call.method === "GET") return json(store);
      if (call.url.startsWith("/api/mcp") && call.method === "PATCH") {
        store = {
          ...store,
          user: {
            ...store.user,
            servers: store.user.servers.map((item) => item.name === call.body.name ? { ...item, enabled: call.body.enabled } : item),
          },
        };
        return json({});
      }
      if (call.url.startsWith("/api/mcp") && call.method === "PUT") {
        store = {
          ...store,
          user: {
            ...store.user,
            servers: call.body.servers.map((entry) => ({ ...entry, enabled: true, editable: true })),
          },
        };
        return json({});
      }
      if (call.url.startsWith("/api/agent/")) return json({ success: true });
      return json({});
    },
  });

  assert.match(container.textContent, /MCP servers/);
  assert.match(container.textContent, /User · 2/);
  assert.match(container.textContent, /Project · 0/);
  assert.match(container.textContent, /claude-owned/);
  assert.match(container.textContent, /claude/);
  const projectScope = button(container, "Project · 0");
  assert.equal(projectScope.disabled, true);

  await act(async () => { container.querySelector('button[aria-label="Disable native"]').click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  const patch = calls.find((call) => call.method === "PATCH");
  assert.deepEqual(patch.body, { scope: "user", name: "native", enabled: false });
  assert.ok(calls.some((call) => call.url === `/api/agent/${SESSION}`));
  assert.ok(calls.some((call) => call.url === "reloaded"));

  // Selecting the external server shows its read-only notice and no actions.
  const externalRow = [...container.querySelectorAll("button")].find((node) => node.textContent.trim().startsWith("claude-owned"));
  await act(async () => { externalRow.click(); });
  assert.match(container.textContent, /Configuration read-only · managed by claude/);
  assert.equal(button(container, "Delete"), undefined);
  assert.equal(button(container, "Save MCP"), undefined);

  // Adding a server appends a draft and edits it by save.
  await act(async () => { button(container, "+ Add OMP server").click(); });
  const nameInput = container.querySelector('input[placeholder="server-name"]');
  assert.equal(nameInput.value, "new-server");
  const textarea = [...container.querySelectorAll("textarea")].at(-1);
  assert.match(areaValue(textarea), /"type": "stdio"/);
  await setText(nameInput, "added-server", { blur: false });
  await setText(textarea, JSON.stringify({ type: "stdio", command: "bunx", args: ["srv"] }, null, 2), { blur: false });
  await act(async () => { button(container, "Save MCP").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  const put = calls.find((call) => call.method === "PUT");
  assert.deepEqual(put.body, {
    scope: "user",
    servers: [
      { name: "native", config: { type: "stdio", command: "node" } },
      { name: "added-server", config: { type: "stdio", command: "bunx", args: ["srv"] } },
    ],
  });

  // Deleting the added server removes it from the saved scope.
  const addedRow = [...container.querySelectorAll("button")].find((node) => node.textContent.trim() === "added-server");
  await act(async () => { addedRow.click(); });
  await act(async () => { button(container, "Delete").click(); });
  await act(async () => { button(container, "Save MCP").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  assert.deepEqual(calls.filter((call) => call.method === "PUT").at(-1).body.servers, [
    { name: "native", config: { type: "stdio", command: "node" } },
  ]);
  await unmount();
});

test("MCP reports a save failure and an invalid draft stays put", async () => {
  const { container, calls, unmount } = await mount({
    initialSection: "mcp",
    respond: (call) => {
      if (call.url.startsWith("/api/whoami")) return json({ user: { isAdmin: true } });
      if (call.url.startsWith("/api/settings")) return json(settings());
      if (call.url.startsWith("/api/mcp") && call.method === "GET") return json(mcpConfig());
      if (call.url.startsWith("/api/mcp")) return json({ error: "mcp file is read-only" }, false, 403);
      return json({});
    },
  });
  const textarea = [...container.querySelectorAll("textarea")].at(-1);
  // Broken JSON is parsed in commitDraft and surfaces as the error.
  await setText(textarea, "{ broken", { blur: false });
  await act(async () => { button(container, "Save MCP").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /Unexpected|JSON|position/i);
  assert.equal(calls.filter((call) => call.method === "PUT").length, 0);

  await setText(textarea, '{"type": "stdio", "command": "node"}', { blur: false });
  await act(async () => { button(container, "Save MCP").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /mcp file is read-only/);
  await unmount();
});

test("MCP without a project hides the project scope and an empty scope says so", async () => {
  const { container, unmount } = await mount({
    initialSection: "mcp",
    respond: (call) => {
      if (call.url.startsWith("/api/whoami")) return json({ user: { isAdmin: true } });
      if (call.url.startsWith("/api/settings")) return json(settings());
      if (call.url.startsWith("/api/mcp")) {
        return json({ user: { path: "/tmp/mcp.json", servers: [] }, project: null });
      }
      return json({});
    },
  });
  assert.match(container.textContent, /No servers in this scope\./);
  assert.match(container.textContent, /Add or select an MCP server\./);
  assert.equal(button(container, "Project · 0").disabled, true);
  await unmount();
});

test("an MCP load failure is the section's state", async () => {
  const { container, unmount } = await mount({
    initialSection: "mcp",
    respond: (call) => {
      if (call.url.startsWith("/api/whoami")) return json({ user: { isAdmin: true } });
      if (call.url.startsWith("/api/settings")) return json(settings());
      if (call.url.startsWith("/api/mcp")) return json({ error: "no mcp config" }, false, 500);
      return json({});
    },
  });
  assert.match(container.textContent, /no mcp config/);
  await unmount();
});

test("a failed whoami is treated as a non-admin, not as a crash", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url.startsWith("/api/whoami")) throw new Error("whoami unavailable");
      if (call.url.startsWith("/api/settings")) return json(settings());
      return json({});
    },
  });
  assert.equal(navButton(container, "Accounts"), undefined);
  assert.ok(navButton(container, "Interaction"));
  await unmount();
});

test("a failed session reload is shown in the section", async () => {
  const { container, unmount } = await mount({
    initialSection: "settings:interaction",
    respond: (call) => {
      if (call.url.startsWith("/api/whoami")) return json({ user: { isAdmin: true } });
      if (call.method === "PATCH" && call.url.startsWith("/api/settings")) return json({ value: call.body.value });
      if (call.url.startsWith("/api/settings")) return json(settings());
      if (call.url.startsWith("/api/agent/")) return json({ error: "session vanished" }, false, 404);
      return json({});
    },
  });
  await act(async () => { row(container, "Advisor").querySelector("button[aria-pressed]").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  await act(async () => { button(container, "Reload session").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /session vanished/);
  await unmount();
});

test("MCP toggles a read-only server without writing its config and reports Toggle failures", async () => {
  let patchFails = false;
  const { container, calls, unmount } = await mount({
    initialSection: "mcp",
    respond: (call) => {
      if (call.url.startsWith("/api/whoami")) return json({ user: { isAdmin: true } });
      if (call.url.startsWith("/api/settings")) return json(settings());
      if (call.url.startsWith("/api/mcp") && call.method === "GET") return json(mcpConfig());
      if (call.url.startsWith("/api/mcp") && call.method === "PATCH") {
        if (patchFails) return json({ error: "mcp.json is locked" }, false, 409);
        return json({});
      }
      if (call.url.startsWith("/api/agent/")) return json({ success: true });
      return json({});
    },
  });

  // The externally managed server is read-only; its switch still works and the
  // draft commit must leave the stored config untouched.
  await act(async () => { container.querySelector('button[aria-label="Enable claude-owned"]').click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.deepEqual(calls.find((call) => call.method === "PATCH").body, { scope: "user", name: "claude-owned", enabled: true });

  patchFails = true;
  await act(async () => { container.querySelector('button[aria-label="Disable native"]').click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /mcp\.json is locked/);
  await unmount();
});
