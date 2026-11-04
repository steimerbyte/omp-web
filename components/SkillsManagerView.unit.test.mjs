import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";

/**
 * The user-skill manager, mounted with a stubbed `/api/skills/user` family.
 *
 * The interesting paths are the ones that guard data: switching away from a
 * dirty editor asks first, saving sends the mtime the draft was based on, and
 * deleting is the only action that can remove the folder.
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
const { SkillsManagerView } = await jiti.import("./SkillsManagerView.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { createRoot } = await import("react-dom/client");

const CWD = "/home/alice/workspace/demo";
const DIRECTORY = "/home/alice/.omp/agent/skills";

function skill(name, overrides = {}) {
  return {
    name,
    description: name === "alpha" ? "" : "Second skill",
    filePath: `${DIRECTORY}/${name}/SKILL.md`,
    mtimeMs: name === "alpha" ? 1_700_000_000_000 : null,
    hasSkillFile: true,
    source: name === "alpha" ? "custom:user" : "native:user",
    diagnostics: [],
    ...overrides,
  };
}

const ALPHA = skill("alpha");
const BETA = skill("beta", { diagnostics: [{ severity: "warning", message: "missing description" }] });

function list(overrides = {}) {
  return { directory: DIRECTORY, skills: [ALPHA, BETA], diagnostics: [], ...overrides };
}

function json(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

async function mount({ respond, cwd = CWD } = {}) {
  win.document.body.innerHTML = "";
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const call = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    if (respond) return respond(call);
    if (url === "/api/skills/user") return json(list());
    if (url === "/api/skills/user/alpha") return json({ skill: ALPHA, content: "alpha body" });
    if (url === "/api/skills/user/beta") return json({ skill: BETA, content: "beta body" });
    return json({});
  };
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(SkillsManagerView, {
      cwd,
      locale: "en",
      onClose: () => calls.push({ url: "close" }),
      onNewSkill: (prompt) => calls.push({ url: "new-skill", prompt }),
      onEditWithAi: (prompt) => calls.push({ url: "edit-with-ai", prompt }),
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

function row(container, name) {
  return [...container.querySelectorAll("button")].find((node) => {
    const text = (node.textContent ?? "").trim();
    return text.startsWith(name);
  });
}

function editorValue(container) {
  const textarea = container.querySelector("textarea");
  // linkedom does not implement the textarea `value` property, so read what
  // React was told to render.
  return reactProps(textarea)?.value;
}

function reactProps(element) {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps"));
  return key ? element[key] : null;
}

async function typeTextarea(textarea, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value").set.call(textarea, value);
    const handler = reactProps(textarea)?.onChange;
    handler({ target: textarea, currentTarget: textarea, preventDefault() {}, stopPropagation() {} });
  });
}

test("loads the store, selects the first skill and renders its editor", async () => {
  const { container, calls, unmount } = await mount();
  assert.deepEqual(calls.slice(0, 2).map((call) => call.url), ["/api/skills/user", "/api/skills/user/alpha"]);
  assert.match(container.textContent, /\.omp\/agent\/skills/);
  assert.match(container.textContent, /alpha/);
  assert.equal(editorValue(container), "alpha body");
  assert.match(container.textContent, /⚠/);
  assert.match(container.textContent, /user|·/);
  await unmount();
});

test("switching away from a dirty editor asks, cancel keeps the draft", async () => {
  const { container, calls, unmount } = await mount();
  await typeTextarea(container.querySelector("textarea"), "edited body");
  assert.match(container.textContent, /Unsaved changes/);

  await act(async () => { row(container, "beta").click(); });
  assert.match(container.querySelector('[role="alert"]').textContent, /Discard unsaved changes and switch\?/);
  assert.equal(editorValue(container), "edited body");

  await act(async () => { button(container, "Cancel").click(); });
  assert.equal(container.querySelector('[role="alert"]'), null, "die Warnung bleibt stehen");
  assert.equal(calls.filter((call) => call.url === "/api/skills/user/beta").length, 0);

  await act(async () => { row(container, "beta").click(); });
  await act(async () => { button(container, "Discard and switch").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.equal(calls.filter((call) => call.url === "/api/skills/user/beta").length, 1);
  assert.equal(editorValue(container), "beta body");
  await unmount();
});

test("saving sends the draft and the mtime it was based on", async () => {
  let saved = null;
  const { container, calls, unmount } = await mount({
    respond: (call) => {
      if (call.method === "PUT") {
        saved = { ...ALPHA, mtimeMs: 1_700_000_100_000 };
        return json({ skill: saved });
      }
      if (call.url === "/api/skills/user") return json(list());
      if (call.url === "/api/skills/user/alpha") return json({ skill: ALPHA, content: "alpha body" });
      return json({ skill: BETA, content: "beta body" });
    },
  });
  assert.equal(button(container, "Save").disabled, true);
  await typeTextarea(container.querySelector("textarea"), "alpha body v2");
  assert.equal(button(container, "Save").disabled, false);
  await act(async () => { button(container, "Save").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });

  const put = calls.find((call) => call.method === "PUT");
  assert.deepEqual(put.url, "/api/skills/user/alpha");
  assert.deepEqual(put.body, { content: "alpha body v2", expectedMtimeMs: ALPHA.mtimeMs });
  assert.match(container.textContent, /Saved\. New chats use this skill/);
  assert.equal(button(container, "Save").disabled, true);
  await unmount();
});

test("a refused save keeps the draft and offers a reload", async () => {
  const { container, calls, unmount } = await mount({
    respond: (call) => {
      if (call.method === "PUT") return json({ error: "file changed on disk" }, false, 409);
      if (call.url === "/api/skills/user") return json(list());
      if (call.url === "/api/skills/user/alpha") return json({ skill: ALPHA, content: "alpha body" });
      return json({ skill: BETA, content: "beta body" });
    },
  });
  await typeTextarea(container.querySelector("textarea"), "draft");
  await act(async () => { button(container, "Save").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /Could not save the skill\. file changed on disk/);
  assert.equal(editorValue(container), "draft");

  const before = calls.filter((call) => call.url === "/api/skills/user/alpha").length;
  await act(async () => { button(container, "Reload").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.equal(calls.filter((call) => call.url === "/api/skills/user/alpha").length, before + 1);
  assert.equal(editorValue(container), "alpha body");
  await unmount();
});

test("dirty state installs the beforeunload guard", async () => {
  const { container, unmount } = await mount();
  const clean = new win.Event("beforeunload", { cancelable: true });
  win.dispatchEvent(clean);
  assert.equal(clean.defaultPrevented, false);

  await typeTextarea(container.querySelector("textarea"), "dirty");
  const guarded = new win.Event("beforeunload", { cancelable: true });
  win.dispatchEvent(guarded);
  assert.equal(guarded.defaultPrevented, true);
  await unmount();
});

test("deleting confirms, removes the skill, and reloads the store", async () => {
  let deleted = false;
  const { container, calls, unmount } = await mount({
    respond: (call) => {
      if (call.method === "DELETE") {
        deleted = true;
        return json({ success: true });
      }
      if (call.url === "/api/skills/user") {
        return json(list({ skills: deleted ? [BETA] : [ALPHA, BETA] }));
      }
      if (call.url === "/api/skills/user/alpha") return json({ skill: ALPHA, content: "alpha body" });
      return json({ skill: BETA, content: "beta body" });
    },
  });
  await act(async () => { button(container, "Delete").click(); });
  const dialog = container.querySelector('[aria-label="Delete skill alpha?"]');
  assert.ok(dialog, "der Löschdialog fehlt");
  assert.match(dialog.textContent, /This removes the folder and everything in it/);

  await act(async () => {
    [...dialog.querySelectorAll("button")].find((node) => node.textContent.trim() === "Delete").click();
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.equal(calls.find((call) => call.method === "DELETE").url, "/api/skills/user/alpha");
  assert.equal(calls.filter((call) => call.url === "/api/skills/user").length, 2);
  assert.equal(container.querySelector('[aria-label="Delete skill alpha?"]'), null);
  await unmount();
});

test("a failed delete keeps the dialog open with the reason", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.method === "DELETE") return json({ error: "permission denied" }, false, 500);
      if (call.url === "/api/skills/user") return json(list());
      if (call.url === "/api/skills/user/alpha") return json({ skill: ALPHA, content: "alpha body" });
      return json({ skill: BETA, content: "beta body" });
    },
  });
  await act(async () => { button(container, "Delete").click(); });
  const dialog = container.querySelector('[aria-label="Delete skill alpha?"]');
  await act(async () => {
    [...dialog.querySelectorAll("button")].find((node) => node.textContent.trim() === "Delete").click();
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /permission denied/);
  assert.ok(container.querySelector('[aria-label="Delete skill alpha?"]'));
  await unmount();
});

test("deleting the last skill falls back to the empty state", async () => {
  let deleted = false;
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.method === "DELETE") { deleted = true; return json({ success: true }); }
      if (call.url === "/api/skills/user") return json(list({ skills: deleted ? [] : [ALPHA] }));
      return json({ skill: ALPHA, content: "alpha body" });
    },
  });
  await act(async () => { button(container, "Delete").click(); });
  const dialog = container.querySelector('[aria-label="Delete skill alpha?"]');
  await act(async () => {
    [...dialog.querySelectorAll("button")].find((node) => node.textContent.trim() === "Delete").click();
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /No skills yet/);
  assert.match(container.textContent, /\+ New skill/);
  await unmount();
});

test("new-skill and edit-with-AI hand a prompt to the caller", async () => {
  const { container, calls, unmount } = await mount();
  await act(async () => { button(container, "+ New skill").click(); });
  const created = calls.find((call) => call.url === "new-skill");
  assert.match(created.prompt, /\.omp\/agent\/skills/);

  await act(async () => { button(container, "Edit with AI").click(); });
  const edited = calls.find((call) => call.url === "edit-with-ai");
  assert.match(edited.prompt, /alpha\/SKILL\.md/);
  await unmount();
});

test("without a project the actions explain why they are disabled", async () => {
  const { container, unmount } = await mount({ cwd: null });
  const create = button(container, "+ New skill");
  const edit = button(container, "Edit with AI");
  assert.equal(create.disabled, true);
  assert.equal(edit.disabled, true);
  assert.match(create.getAttribute("title"), /Open a project first/);
  await unmount();
});

test("a failed list is an alert and an empty list is its own state", async () => {
  const failing = await mount({ respond: () => json({ error: "cannot read the store" }, false, 500) });
  assert.match(failing.container.textContent, /Could not load your skills\. cannot read the store/);
  await failing.unmount();

  const empty = await mount({ respond: () => json({ directory: DIRECTORY, skills: [], diagnostics: [] }) });
  assert.match(empty.container.textContent, /No skills yet/);
  assert.match(empty.container.textContent, /A skill is a folder with a SKILL\.md/);
  await empty.unmount();
});

test("skill diagnostics and store diagnostics are shown separately", async () => {
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/skills/user") {
        return json(list({ diagnostics: [{ severity: "warning", message: "one folder skipped" }] }));
      }
      if (call.url === "/api/skills/user/alpha") return json({ skill: ALPHA, content: "alpha body" });
      return json({ skill: BETA, content: "beta body" });
    },
  });
  assert.match(container.textContent, /one folder skipped/);
  await act(async () => { row(container, "beta").click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.match(container.textContent, /missing description/);
  await unmount();
});

test("a failed detail load is an alert and reload retries", async () => {
  let fail = true;
  const { container, calls, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/skills/user") return json(list());
      if (call.url === "/api/skills/user/alpha") {
        if (fail) { fail = false; return json({ error: "SKILL.md unreadable" }, false, 500); }
        return json({ skill: ALPHA, content: "alpha body" });
      }
      return json({ skill: BETA, content: "beta body" });
    },
  });
  assert.match(container.textContent, /SKILL.md unreadable/);
  const before = calls.filter((call) => call.url === "/api/skills/user/alpha").length;
  await act(async () => { container.querySelector('button[aria-label="Reload"]').click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.equal(calls.filter((call) => call.url === "/api/skills/user/alpha").length, before + 1);
  assert.equal(editorValue(container), "alpha body");
  await unmount();
});

test("discarding resets the editor to the saved content", async () => {
  const { container, unmount } = await mount();
  await typeTextarea(container.querySelector("textarea"), "throwaway");
  await act(async () => { button(container, "Discard").click(); });
  assert.equal(editorValue(container), "alpha body");
  assert.equal(button(container, "Save").disabled, true);
  await unmount();
});

test("hovering an inactive skill row paints and clears its background", async () => {
  const { container, unmount } = await mount();
  const betaRow = row(container, "beta");
  await act(async () => {
    reactProps(betaRow).onMouseEnter({ currentTarget: betaRow });
  });
  assert.equal(betaRow.style.background, "var(--bg-hover)");
  await act(async () => {
    reactProps(betaRow).onMouseLeave({ currentTarget: betaRow });
  });
  assert.equal(betaRow.style.background, "none");
  // The selected row ignores the hover painters.
  const alphaRow = row(container, "alpha");
  await act(async () => { reactProps(alphaRow).onMouseEnter({ currentTarget: alphaRow }); });
  assert.equal(alphaRow.style.background, "var(--bg-selected)");
  await unmount();
});

test("a skill folder without SKILL.md says that saving creates it", async () => {
  const naked = skill("gamma", { hasSkillFile: false, filePath: `${DIRECTORY}/gamma/SKILL.md` });
  const { container, unmount } = await mount({
    respond: (call) => {
      if (call.url === "/api/skills/user") return json({ directory: DIRECTORY, skills: [naked], diagnostics: [] });
      if (call.url === "/api/skills/user/gamma") return json({ skill: naked, content: "" });
      return json({});
    },
  });
  assert.match(container.textContent, /This folder has no SKILL\.md yet\. Saving creates it\./);
  await unmount();
});
