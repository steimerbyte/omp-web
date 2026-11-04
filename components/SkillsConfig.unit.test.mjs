import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";

/**
 * The skills browser, mounted with a stubbed `/api/skills` family.
 *
 * Three source groups and one dormant fold are what makes this screen more
 * than a list: a disabled skill is still in its source group, but only under
 * "Dormant", and the footer's "Check updates" covers every installed package
 * while the detail's "Check" covers one.
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
const { SkillsConfig } = await jiti.import("./SkillsConfig.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { createRoot } = await import("react-dom/client");

const CWD = "/home/alice/workspace/demo";

function skill(overrides = {}) {
  return {
    name: "custom-skill",
    description: "A skill of this account.",
    filePath: "/home/alice/.omp/agent/skills/custom-skill/SKILL.md",
    baseDir: "/home/alice/.omp/agent/skills/custom-skill",
    disableModelInvocation: false,
    sourceInfo: { source: "custom:user" },
    ...overrides,
  };
}

const CUSTOM = skill();
const PROJECT = skill({
  name: "project-skill",
  description: "From skills.sh.",
  filePath: "/home/alice/workspace/demo/.claude/skills/project-skill/SKILL.md",
  disableModelInvocation: true,
  sourceInfo: { source: "project", scope: "project" },
  install: {
    package: "owner/repo@project-skill",
    scope: "project",
    source: "skills.sh",
    skillsShUrl: "https://skills.sh/owner/repo/project-skill",
    versionHash: "aaaaaaaa1111",
    canCheckForUpdates: true,
  },
});
const GLOBAL = skill({
  name: "global-skill",
  description: "Installed globally.",
  filePath: "/home/alice/.claude/skills/global-skill/SKILL.md",
  sourceInfo: { source: "native:user", scope: "user" },
  install: {
    package: "owner/repo@global-skill",
    scope: "global",
    source: "skills.sh",
    skillsShUrl: "https://skills.sh/owner/repo/global-skill",
    versionHash: "bbbbbbbb2222",
    canCheckForUpdates: true,
  },
});
const PATH_SKILL = skill({
  name: "path-skill",
  description: "Registered by path.",
  filePath: "/opt/skills/path-skill/SKILL.md",
  sourceInfo: { source: "custom:path" },
});

function list(overrides = {}) {
  return {
    skills: [CUSTOM, PROJECT, GLOBAL, PATH_SKILL],
    diagnostics: [],
    projectResourcesLoaded: true,
    ...overrides,
  };
}

function json(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

async function mount({ respond, data = list(), embedded = true } = {}) {
  win.document.body.innerHTML = "";
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const call = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    if (respond) return respond(call);
    return json(data);
  };
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(SkillsConfig, {
      cwd: CWD,
      embedded,
      onClose: () => calls.push({ url: "close" }),
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

function clickable(container, text) {
  return [...container.querySelectorAll("div")]
    .filter((node) => (node.getAttribute("style") ?? "").includes("cursor:pointer") && (node.textContent ?? "").trim().startsWith(text))
    .at(-1);
}

function reactProps(element) {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps"));
  return key ? element[key] : null;
}

async function type(input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set.call(input, value);
    const handler = reactProps(input)?.onChange;
    if (handler) {
      handler({ target: input, currentTarget: input, preventDefault() {}, stopPropagation() {} });
      return;
    }
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
}

test("groups skills by source and folds dormant ones", async () => {
  const { container, calls, unmount } = await mount();
  assert.deepEqual(calls.map((call) => call.url), [`/api/skills?cwd=${encodeURIComponent(CWD)}`]);
  assert.match(container.textContent, /Your skills/);
  assert.match(container.textContent, /Project \/ skills\.sh/);
  assert.match(container.textContent, /Global \/ skills\.sh/);
  assert.match(container.textContent, /Path/);
  assert.match(container.textContent, /Dormant \(1\)/);
  assert.doesNotMatch(container.textContent, /project-skill/, "der schlafende Skill steht offen");
  // The first enabled skill is selected and its path is shown for the account.
  assert.match(container.textContent, /~\/\.omp\/agent\/skills\/custom-skill\/SKILL\.md/);
  assert.match(container.textContent, /A skill of this account\./);

  await act(async () => { clickable(container, "▸").click(); });
  assert.match(container.textContent, /project-skill/);
  assert.match(container.textContent, /▾/);
  await unmount();
});

test("toggling the selected skill writes the explicit disable flag", async () => {
  const { container, calls, unmount } = await mount();
  const toggle = container.querySelector('button[title="Visible in model prompt — click to disable"]');
  assert.ok(toggle, "der Sichtbarkeits-Schalter fehlt");
  await act(async () => { toggle.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.deepEqual(calls.find((call) => call.method === "PATCH").body, {
    filePath: CUSTOM.filePath,
    disableModelInvocation: true,
  });
  assert.match(container.textContent, /Hidden from model, still manually invocable/);
  await unmount();
});

test("a failed toggle keeps the state and shows the server reason", async () => {
  const { container, unmount } = await mount({
    respond: (call) => call.method === "PATCH"
      ? json({ error: "SKILL.md is not writable" }, false, 500)
      : json(list()),
  });
  await act(async () => { container.querySelector('button[title="Visible in model prompt — click to disable"]').click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(container.textContent, /SKILL.md is not writable/);
  assert.equal(container.querySelector('button[title="Visible in model prompt — click to disable"]') !== null, true);
  await unmount();
});

test("checking one installed skill shows the available version and updates it", async () => {
  let checked = 0;
  const { container, calls, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/skills/check") {
        checked += 1;
        return json({
          updates: [{
            package: GLOBAL.install.package,
            scope: "global",
            state: "update-available",
            currentVersion: GLOBAL.install.versionHash,
            latestVersion: "cccccccc3333",
          }],
        });
      }
      if (call.url === "/api/skills/update") {
        return json({ success: true, skill: { ...GLOBAL, install: { ...GLOBAL.install, versionHash: "cccccccc3333" } } });
      }
      return json(list());
    },
  });

  await act(async () => { clickable(container, "global-skill").click(); });
  assert.match(container.textContent, /bbbbbbbb/);
  assert.equal(button(container, "Check").disabled, false);
  await act(async () => { button(container, "Check").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const check = calls.find((call) => call.url === "/api/skills/check");
  assert.deepEqual(check.body, {
    cwd: CWD,
    package: GLOBAL.install.package,
    scope: "global",
  });
  assert.equal(container.querySelector('span[title="Update available"]') !== null, true);
  assert.match(container.textContent, /cccccccc/);

  await act(async () => { button(container, "Update").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  const update = calls.find((call) => call.url === "/api/skills/update");
  assert.deepEqual(update.body, {
    cwd: CWD,
    package: GLOBAL.install.package,
    scope: "global",
  });
  assert.equal(calls.filter((call) => call.url.startsWith("/api/skills?")).length, 2);
  assert.match(container.textContent, /Up to date/);
  assert.equal(checked, 1);
  await unmount();
});

test("a failed update check is reported on the detail", async () => {
  const { container, unmount } = await mount({
    respond: (call) => call.url === "/api/skills/check"
      ? json({ error: "registry timeout" }, false, 504)
      : json(list()),
  });
  await act(async () => { clickable(container, "global-skill").click(); });
  await act(async () => { button(container, "Check").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(container.textContent, /registry timeout/);
  await unmount();
});

test("the detail reports every check state and its message", async () => {
  const { container, unmount } = await mount({
    respond: (call) => call.url === "/api/skills/check"
      ? json({
        updates: [
          { package: GLOBAL.install.package, scope: "global", state: "unsupported" },
          { package: PROJECT.install.package, scope: "project", state: "error", message: "not a git checkout" },
        ],
      })
      : json(list()),
  });
  await act(async () => { clickable(container, "global-skill").click(); });
  await act(async () => { button(container, "Check").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(container.textContent, /Automatic checks unavailable/);

  await act(async () => { clickable(container, "▸").click(); });
  await act(async () => { clickable(container, "project-skill").click(); });
  await act(async () => { button(container, "Check").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(container.textContent, /not a git checkout/);
  await unmount();
});

test("checking all installs from the footer covers every package", async () => {
  const { container, calls, unmount } = await mount({
    respond: (call) => call.url === "/api/skills/check"
      ? json({
        updates: [{
          package: GLOBAL.install.package,
          scope: "global",
          state: "update-available",
          currentVersion: "b",
          latestVersion: "c",
        }],
      })
      : json(list()),
  });
  await act(async () => { button(container, "Check updates").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const check = calls.find((call) => call.url === "/api/skills/check");
  assert.deepEqual(check.body, { cwd: CWD });
  assert.match(container.textContent, /1 Update/);
  assert.equal(container.querySelectorAll('span[title="Update available"]').length, 1);
  await unmount();
});

test("add panel searches and installs a skills.sh package", async () => {
  const { container, calls, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/skills/search") {
        return json({
          results: [{
            package: "owner/repo@new-skill",
            installs: "12.3k",
            url: "https://skills.sh/owner/repo/new-skill",
          }],
        });
      }
      if (call.url === "/api/skills/install") return json({ success: true });
      return json(list());
    },
  });

  await act(async () => { clickable(container, "Add skill").click(); });
  const input = container.querySelector('input[placeholder="e.g. react, testing, deploy"]');
  assert.ok(input, "das Suchfeld fehlt");
  assert.equal(button(container, "Search").disabled, true);

  await type(input, "new-skill");
  await act(async () => { button(container, "Search").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.deepEqual(calls.find((call) => call.url === "/api/skills/search").body, { query: "new-skill" });
  assert.match(container.textContent, /new-skill/);
  assert.match(container.textContent, /owner\/repo/);
  assert.match(container.textContent, /12\.3k/);
  assert.match(container.textContent, /skills\.sh ↗/);

  await act(async () => { button(container, "Install").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.deepEqual(calls.find((call) => call.url === "/api/skills/install").body, {
    package: "owner/repo@new-skill",
    scope: "global",
    cwd: CWD,
  });
  assert.match(container.textContent, /✓ Installed/);
  await unmount();
});

test("a search without results and a failing search are different messages", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/skills/search") return json({ results: [] });
      return json(list());
    },
  });
  await act(async () => { clickable(container, "Add skill").click(); });
  const input = container.querySelector('input[placeholder="e.g. react, testing, deploy"]');
  await type(input, "nothing");
  await act(async () => { button(container, "Search").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(container.textContent, /No skills found/);
  await unmount();

  const failing = await mount({
    respond: (call) => {
      if (call.url === "/api/skills/search") return json({ error: "skills.sh is down" });
      return json(list());
    },
  });
  await act(async () => { clickable(failing.container, "Add skill").click(); });
  const second = failing.container.querySelector('input[placeholder="e.g. react, testing, deploy"]');
  await type(second, "anything");
  await act(async () => { button(failing.container, "Search").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(failing.container.textContent, /skills\.sh is down/);
  await failing.unmount();
});

test("an install failure stays in the add panel", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/skills/search") {
        return json({ results: [{ package: "owner/repo@broken", installs: "1", url: "" }] });
      }
      if (call.url === "/api/skills/install") return json({ error: "package not found" }, false, 404);
      return json(list());
    },
  });
  await act(async () => { clickable(container, "Add skill").click(); });
  await type(container.querySelector('input[placeholder="e.g. react, testing, deploy"]'), "broken");
  await act(async () => { button(container, "Search").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  await act(async () => { button(container, "Install").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(container.textContent, /package not found/);
  assert.equal(button(container, "Install").disabled, false);
  await unmount();
});

test("project scope is unavailable until project resources load", async () => {
  const { container, unmount } = await mount({
    data: list({ projectResourcesLoaded: false }),
  });
  assert.match(container.textContent, /Project skills are not loaded because this project is not trusted\./);
  await act(async () => { clickable(container, "Add skill").click(); });
  const project = button(container, "project");
  assert.equal(project.disabled, true);
  assert.match(project.getAttribute("title"), /Project installs are unavailable/);
  await unmount();
});

test("withheld skills are counted in their own bar", async () => {
  const { container, unmount } = await mount({
    data: list({ diagnostics: [{ type: "info", message: "2 skills are withheld by the load policy" }] }),
  });
  assert.equal(container.querySelector('[data-testid="load-policy-diagnostics"]').textContent, "2 skills are withheld by the load policy");
  await unmount();
});

test("a failed list shows the reason and an empty list says so", async () => {
  const failing = await mount({ respond: () => json({ error: "cannot read skills" }, false, 500) });
  assert.match(failing.container.textContent, /cannot read skills/);
  await failing.unmount();

  const empty = await mount({ data: list({ skills: [] }) });
  assert.match(empty.container.textContent, /No skills found/);
  assert.match(empty.container.textContent, /Select a skill/);
  await empty.unmount();
});

test("the close button is the caller's callback", async () => {
  const { container, calls, unmount } = await mount();
  await act(async () => { button(container, "Close").click(); });
  assert.ok(calls.some((call) => call.url === "close"));
  await unmount();
});

test("selecting a path skill names the source and row hover paints only unselected rows", async () => {
  const { container, unmount } = await mount();
  await act(async () => { clickable(container, "path-skill").click(); });
  assert.match(container.textContent, /Registered by path\./);
  assert.match(container.textContent, /Registered by path/);
  const customRow = [...container.querySelectorAll("div")].find((node) =>
    (node.getAttribute("style") ?? "").includes("cursor:pointer") && (node.textContent ?? "").trim().startsWith("custom-skill"));
  assert.ok(customRow, "die Skill-Zeile fehlt");
  await act(async () => { reactProps(customRow).onMouseEnter({ currentTarget: customRow }); });
  assert.equal(customRow.style.background, "var(--bg-hover)");
  await act(async () => { reactProps(customRow).onMouseLeave({ currentTarget: customRow }); });
  assert.equal(customRow.style.background, "none");
  // The "Add skill" entry paints on hover while the panel is closed.
  const addEntry = [...container.querySelectorAll("div")].find((node) =>
    (node.getAttribute("style") ?? "").includes("cursor:pointer") && (node.textContent ?? "").trim() === "Add skill");
  assert.ok(addEntry, "der Add-skill-Eintrag fehlt");
  await act(async () => { reactProps(addEntry).onMouseEnter({ currentTarget: addEntry }); });
  assert.equal(addEntry.style.background, "var(--bg-hover)");
  await act(async () => { reactProps(addEntry).onMouseLeave({ currentTarget: addEntry }); });
  assert.equal(addEntry.style.background, "none");
  await unmount();
});

test("a search request that rejects reports the failure and clears the spinner", async () => {
  const { container, unmount } = await mount({
    respond: (call) => call.url === "/api/skills/search"
      ? Promise.reject(new Error("search offline"))
      : json(list()),
  });
  await act(async () => { clickable(container, "Add skill").click(); });
  const input = container.querySelector('input[placeholder="e.g. react, testing, deploy"]');
  await type(input, "broken");
  await act(async () => { button(container, "Search").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(container.textContent, /search offline/);
  assert.equal(button(container, "Search").disabled, false);
  await unmount();
});

test("Enter in the search field starts the search", async () => {
  const { container, calls, unmount } = await mount({
    respond: (call) => call.url === "/api/skills/search"
      ? json({ results: [] })
      : json(list()),
  });
  await act(async () => { clickable(container, "Add skill").click(); });
  const input = container.querySelector('input[placeholder="e.g. react, testing, deploy"]');
  await type(input, "enter-skill");
  await act(async () => { reactProps(input).onKeyDown({ key: "Enter", preventDefault() {}, stopPropagation() {} }); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.equal(calls.find((call) => call.url === "/api/skills/search").body.query, "enter-skill");
  await unmount();
});

test("an install request that rejects stays in the panel with the reason", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/skills/search") return json({ results: [{ package: "owner/repo@new-skill", installs: "1", url: "https://skills.sh/x" }] });
      if (call.url === "/api/skills/install") return Promise.reject(new Error("installer crashed"));
      return json(list());
    },
  });
  await act(async () => { clickable(container, "Add skill").click(); });
  const input = container.querySelector('input[placeholder="e.g. react, testing, deploy"]');
  await type(input, "new-skill");
  await act(async () => { button(container, "Search").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  await act(async () => { button(container, "Install").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(container.textContent, /installer crashed/);
  await unmount();
});

test("the project scope is selectable and changes the printed install path", async () => {
  const { container, unmount } = await mount();
  await act(async () => { clickable(container, "Add skill").click(); });
  assert.match(container.textContent, /~\/\.claude\/skills\//);
  const project = button(container, "project");
  assert.ok(project, "der project-Knopf fehlt");
  assert.equal(project.disabled, false);
  await act(async () => { project.click(); });
  assert.match(container.textContent, /workspace\/demo\/\.claude\/skills\//);
  await unmount();
});

test("a list of only dormant skills opens the dormant group on load", async () => {
  const { container, unmount } = await mount({ data: list({ skills: [PROJECT] }) });
  assert.match(container.textContent, /Dormant \(1\)/);
  assert.match(container.textContent, /project-skill/);
  assert.match(container.textContent, /From skills\.sh\./);
  await unmount();
});

test("a failed update is reported on the detail", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/skills/check") {
        return json({ updates: [{ package: GLOBAL.install.package, scope: "global", state: "update-available", currentVersion: GLOBAL.install.versionHash, latestVersion: "cccccccc3333" }] });
      }
      if (call.url === "/api/skills/update") return json({ error: "registry broke" }, false, 500);
      return json(list());
    },
  });
  await act(async () => { clickable(container, "global-skill").click(); });
  await act(async () => { button(container, "Check").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  await act(async () => { button(container, "Update").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(container.textContent, /registry broke/);
  await unmount();
});

test("a toggle whose request rejects reports the network error", async () => {
  const { container, unmount } = await mount({
    respond: (call) => call.method === "PATCH" ? Promise.reject(new Error("connection reset")) : json(list()),
  });
  await act(async () => { container.querySelector('button[title="Visible in model prompt — click to disable"]').click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(container.textContent, /connection reset/);
  await unmount();
});
