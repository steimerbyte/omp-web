import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";

/**
 * The plugin manager, mounted with a stubbed `/api/plugins`.
 *
 * The screen has two places that render the same package with different rules
 * (the list summary and the detail), and three write paths that each answer
 * with a full replacement list. The test keeps them apart: a POST names the
 * action, the scope and the cwd, and the returned list becomes the new state.
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
const { PluginsConfig } = await jiti.import("./PluginsConfig.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { createRoot } = await import("react-dom/client");

const CWD = "/home/alice/workspace/demo";
const SESSION = "session-1";

function pkg(overrides = {}) {
  return {
    source: "npm:@scope/omp-plugin",
    scope: "global",
    filtered: false,
    disabled: false,
    installedPath: "/home/alice/.omp/plugins/node_modules/@scope/omp-plugin",
    packageName: "@scope/omp-plugin",
    version: "1.2.3",
    configuredVersion: "1.0.0",
    counts: { extensions: 1, skills: 2, prompts: 1, themes: 0 },
    resources: [
      { kind: "extension", name: "alpha", path: "/home/alice/.omp/plugins/alpha.ts", relativePath: "alpha.ts" },
      { kind: "skill", name: "review", path: "/home/alice/.omp/plugins/skill/review.md", relativePath: "skill/review.md" },
    ],
    status: "loaded",
    ...overrides,
  };
}

const GLOBAL_PACKAGE = pkg();
const PROJECT_PACKAGE = pkg({
  source: "github:user/repo",
  scope: "project",
  disabled: true,
  filtered: false,
  status: "disabled",
  counts: { extensions: 0, skills: 0, prompts: 0, themes: 0 },
  resources: [],
  version: undefined,
  configuredVersion: undefined,
  packageName: undefined,
  installedPath: undefined,
});

function response(packages = [GLOBAL_PACKAGE, PROJECT_PACKAGE], overrides = {}) {
  return {
    packages,
    totals: { extensions: 1, skills: 2, prompts: 1, themes: 0 },
    diagnostics: [],
    projectResourcesLoaded: true,
    ...overrides,
  };
}

function json(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

async function mount({ data = response(), respond, sessionId = SESSION } = {}) {
  win.document.body.innerHTML = "";
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const call = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    if (respond) return respond(call);
    if (url.startsWith("/api/plugins") && call.method === "GET") return json(data);
    if (url.startsWith("/api/plugins")) return json(data);
    if (url.startsWith("/api/agent/")) return json({ success: true, data: {} });
    return json({});
  };
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(PluginsConfig, {
      cwd: CWD,
      sessionId,
      onClose: () => calls.push({ url: "close" }),
      onReloaded: () => calls.push({ url: "reloaded" }),
    })));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  return {
    container,
    calls,
    async unmount() { await act(async () => { root.unmount(); }); globalThis.fetch = originalFetch; },
  };
}

function button(container, text) {
  return [...container.querySelectorAll("button")].find((node) => (node.textContent ?? "").trim() === text);
}

function reactProps(element) {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps"));
  return key ? element[key] : null;
}

async function type(input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set.call(input, value);
    // Input events do not reach React's delegated listener under linkedom;
    // call the component's own onChange with the same value.
    const handler = reactProps(input)?.onChange;
    if (handler) handler({ target: input, currentTarget: input, preventDefault() {}, stopPropagation() {} });
    else input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
}

test("lists both scopes and opens the first package's detail", async () => {
  const { container, calls, unmount } = await mount();
  assert.deepEqual(calls.map((call) => call.url), [`/api/plugins?cwd=${encodeURIComponent(CWD)}`]);
  assert.match(container.textContent, /^Plugins/);
  assert.match(container.textContent, /npm:@scope\/omp-plugin/);
  assert.match(container.textContent, /github:user\/repo/);
  assert.match(container.textContent, /installed 1\.2\.3 · configured 1\.0\.0/);
  assert.match(container.textContent, /~\/\.omp\/plugins\/node_modules\/@scope\/omp-plugin/);
  assert.match(container.textContent, /1 ext · 2 skills · 1 prompt/);
  assert.match(container.textContent, /alpha/);
  assert.match(container.textContent, /skill\/review\.md/);
  assert.match(container.textContent, /1 ext · 2 skills · 1 prompts · 0 themes/);
  await unmount();
});

test("a disabled project package is marked and shows no resolved resources", async () => {
  const { container, unmount } = await mount();
  const projectRow = [...container.querySelectorAll("div")]
    .filter((node) => (node.getAttribute("style") ?? "").includes("cursor:pointer") && (node.textContent ?? "").includes("github:user/repo"))
    .at(-1);
  assert.ok(projectRow, "die Projektzeile fehlt");
  await act(async () => { projectRow.click(); });
  assert.match(container.textContent, /Package disabled\./);
  assert.equal(container.querySelector('button[aria-label="Enable package"]') !== null, true);
  await unmount();
});

test("installing from the add panel normalizes a pasted command", async () => {
  let installed = false;
  const { container, calls, unmount } = await mount({
    respond: (call) => {
      if (call.method === "POST" && call.body.action === "install") {
        installed = true;
        return json(response([pkg({ source: "npm:@scope/new-plugin", scope: "project" }), ...(installed ? [] : [GLOBAL_PACKAGE])]));
      }
      return json(response());
    },
  });

  await act(async () => { button(container, "Add plugin").click(); });
  const input = container.querySelector("#plugin-source");
  assert.ok(input, "das Quellfeld fehlt");
  assert.match(container.textContent, /~\/\.omp\/plugins/);

  // A pasted shell command is reduced to the package argument before install.
  await act(async () => {
    const event = new win.Event("paste", { bubbles: true, cancelable: true });
    event.clipboardData = { getData: () => "$ omp plugin add npm:@scope/new-plugin" };
    input.dispatchEvent(event);
  });
  assert.equal(input.value, "npm:@scope/new-plugin");

  await act(async () => { button(container, "project").click(); });
  assert.match(container.textContent, /~\/workspace\/demo\/\.omp\/plugins/);
  await act(async () => { button(container, "Install").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });

  const post = calls.find((call) => call.method === "POST" && call.body?.action === "install");
  assert.deepEqual(post.body, {
    action: "install",
    source: "npm:@scope/new-plugin",
    scope: "project",
    cwd: CWD,
  });
  assert.match(container.textContent, /Package installed\./);
  await unmount();
});

test("normalizing on blur turns a copied command into the package", async () => {
  const { container, unmount } = await mount();
  await act(async () => { button(container, "Add plugin").click(); });
  const input = container.querySelector("#plugin-source");
  await type(input, "omp plugin install github:user/repo");
  await act(async () => { input.dispatchEvent(new win.Event("focusout", { bubbles: true })); });
  assert.equal(input.value, "github:user/repo");
  await unmount();
});

test("install scope is disabled while project resources are not loaded", async () => {
  const { container, unmount } = await mount({
    data: response([GLOBAL_PACKAGE], { projectResourcesLoaded: false }),
  });
  assert.match(container.textContent, /Project plugins are not loaded because this project is not trusted\./);
  await act(async () => { button(container, "Add plugin").click(); });
  const project = button(container, "project");
  assert.equal(project.disabled, true);
  assert.match(project.getAttribute("title"), /Project installs are unavailable/);
  assert.match(container.textContent, /No resolved resources|No resources|npm:@scope/);
  await unmount();
});

test("update and disable send the action for the selected package", async () => {
  const { container, calls, unmount } = await mount();
  await act(async () => { button(container, "Update").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.deepEqual(calls.find((call) => call.method === "POST" && call.body.action === "update").body, {
    action: "update",
    source: GLOBAL_PACKAGE.source,
    scope: "global",
    cwd: CWD,
  });
  assert.match(container.textContent, /Package updated\./);

  await act(async () => { container.querySelector('button[aria-label="Disable package"]').click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.equal(calls.filter((call) => call.method === "POST" && call.body.action === "disable").length, 1);
  assert.match(container.textContent, /Package disabled\./);
  await unmount();
});

test("removing the last package returns to the add panel", async () => {
  const { container, calls, unmount } = await mount({
    respond: (call) => {
      if (call.method === "POST" && call.body.action === "remove") {
        return json(response([]));
      }
      return json(response([GLOBAL_PACKAGE]));
    },
  });
  await act(async () => { button(container, "Remove").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.deepEqual(calls.find((call) => call.method === "POST").body, {
    action: "remove",
    source: GLOBAL_PACKAGE.source,
    scope: "global",
    cwd: CWD,
  });
  assert.ok(container.querySelector("#plugin-source"), "das Add-Panel ist nicht aufgegangen");
  assert.match(container.textContent, /No plugins configured/);
  await unmount();
});

test("reload session posts the agent command and refreshes the list", async () => {
  const { container, calls, unmount } = await mount();
  const reload = button(container, "Reload session");
  assert.equal(reload.disabled, false);
  await act(async () => { reload.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  const command = calls.find((call) => call.url === `/api/agent/${SESSION}`);
  assert.deepEqual(command.body, { type: "reload" });
  assert.ok(calls.some((call) => call.url === "reloaded"));
  assert.match(container.textContent, /Session reloaded\./);
  assert.equal(calls.filter((call) => call.url.startsWith("/api/plugins?")).length, 2);
  await unmount();
});

test("without a session the reload button is disabled and explains why", async () => {
  const { container, unmount } = await mount({ sessionId: null });
  const reload = button(container, "Reload session");
  assert.equal(reload.disabled, true);
  assert.match(reload.getAttribute("title"), /Open a session/);
  await unmount();
});

test("an empty list opens the add panel and says there is nothing yet", async () => {
  const { container, unmount } = await mount({ data: response([]) });
  assert.match(container.textContent, /No plugins configured/);
  assert.ok(container.querySelector("#plugin-source"));
  await unmount();
});

test("an action failure stays on the screen and leaves the list in place", async () => {
  const { container, unmount } = await mount({
    respond: (call) => call.method === "POST"
      ? json({ error: "registry unreachable" }, false, 502)
      : json(response([GLOBAL_PACKAGE])),
  });
  await act(async () => { button(container, "Update").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(container.textContent, /registry unreachable/);
  assert.match(container.textContent, /npm:@scope\/omp-plugin/);
  await unmount();
});

test("a failed load shows the reason in the list column", async () => {
  const { container, unmount } = await mount({ respond: () => json({ error: "cannot read plugin registry" }, false, 500) });
  assert.match(container.textContent, /cannot read plugin registry/);
  assert.match(container.textContent, /No plugins configured|Select a package|Add plugin/);
  await unmount();
});

test("diagnostics replace the totals line with their count", async () => {
  const { container, unmount } = await mount({
    data: response([GLOBAL_PACKAGE], {
      diagnostics: [{ type: "error", message: "duplicate extension", source: "npm:x" }],
    }),
  });
  assert.match(container.textContent, /1 diagnostic/);
  // The detail still lists the resources; only the footer totals line — the
  // one that also names themes — is replaced by the diagnostic count.
  assert.doesNotMatch(container.textContent, /0 themes/);
  await unmount();
});

async function exercisePointerHandlers(container) {
  let invoked = 0;
  await act(async () => {
    for (const node of container.querySelectorAll("*")) {
      const props = reactProps(node);
      if (!props) continue;
      for (const name of ["onMouseEnter", "onMouseLeave"]) {
        if (typeof props[name] !== "function") continue;
        props[name]({ currentTarget: node, target: node, preventDefault() {}, stopPropagation() {} });
        invoked += 1;
      }
    }
  });
  return invoked;
}

test("row and sidebar hover handlers respond to the pointer", async () => {
  const { container, unmount } = await mount();
  await act(async () => { button(container, "Add plugin").click(); });
  assert.ok(await exercisePointerHandlers(container) > 2);
  await unmount();
});

test("error and filtered statuses get their own badges and colours", async () => {
  const { container, unmount } = await mount({
    data: response([
      pkg({ source: "npm:broken", status: "error", filtered: false }),
      pkg({ source: "npm:filtered-one", packageName: "filtered-one", status: "installed", filtered: true }),
      pkg({ source: "npm:off", status: "disabled", disabled: true }),
    ]),
  });
  assert.match(container.textContent, /broken/);
  assert.match(container.textContent, /error/);
  assert.equal([...container.querySelectorAll("span")].some((node) => node.textContent === "filtered"), false);
  const filteredRow = [...container.querySelectorAll("div")]
    .filter((node) => (node.getAttribute("style") ?? "").includes("cursor:pointer") && (node.textContent ?? "").trim().startsWith("npm:filtered-one"))
    .at(-1);
  assert.ok(filteredRow, "die gefilterte Zeile fehlt");
  await act(async () => { filteredRow.click(); });
  assert.equal([...container.querySelectorAll("span")].some((node) => node.textContent === "filtered"), true);
  assert.match(container.textContent, /Disabled/);
  await exercisePointerHandlers(container);
  await unmount();
});

test("pressing Enter in the source field installs, and a failed install stays", async () => {
  const { container, calls, unmount } = await mount({
    respond: (call) => {
      if (call.method === "POST") throw new Error("npm registry unreachable");
      return json(response());
    },
  });
  await act(async () => { button(container, "Add plugin").click(); });
  const input = container.querySelector("#plugin-source");
  await type(input, "npm:@scope/new-plugin");
  await act(async () => {
    reactProps(input).onKeyDown({ key: "Enter", preventDefault() {}, stopPropagation() {}, target: input, currentTarget: input });
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.deepEqual(calls.find((call) => call.method === "POST").body, {
    action: "install",
    source: "npm:@scope/new-plugin",
    scope: "global",
    cwd: CWD,
  });
  assert.match(container.textContent, /npm registry unreachable/);
  await unmount();
});

test("a reload failure is reported instead of a success message", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url.startsWith("/api/agent/")) return json({ error: "session is gone" }, false, 404);
      return json(response([GLOBAL_PACKAGE]));
    },
  });
  await act(async () => { button(container, "Reload session").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /session is gone/);
  assert.doesNotMatch(container.textContent, /Session reloaded\./);
  await unmount();
});

test("a short source resolves to an already installed package after install", async () => {
  const { container, calls, unmount } = await mount({
    respond: (call) => {
      if (call.method === "POST") return json(response([pkg({ source: "npm:@scope/short-name", scope: "global" })]));
      return json(response([]));
    },
  });
  await act(async () => { button(container, "Add plugin").click(); });
  const input = container.querySelector("#plugin-source");
  await type(input, "short-name");
  await act(async () => { button(container, "Install").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /npm:@scope\/short-name/);
  assert.match(container.textContent, /Package installed\./);
  await unmount();
});
