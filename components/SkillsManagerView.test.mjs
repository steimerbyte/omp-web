import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";

/**
 * Die Liste der Skills-Verwaltung — gemountet, mit dem echten Client-Code.
 *
 * Zwei Behauptungen, die man am Markup nicht ablesen kann, weil sie erst nach
 * dem Fetch entstehen: ein Skill mit Diagnose traegt das Warnzeichen, ein
 * sauberer nicht; und "New skill" reicht den Prompt mit dem absoluten Bestand
 * nach oben (der Chat schreibt ihn dann in den Entwurf). Ohne den Badge-Test
 * wuerde ein spaeterer Umbau der Zeile den stillen Loader-Ausschluss wieder
 * unsichtbar machen.
 */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };
globalThis.window = new Proxy(dom.window, {
  get(target, prop) {
    if (prop === "navigator") return fakeNavigator;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
globalThis.document = dom.document;
globalThis.navigator = fakeNavigator;
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  clear: () => { storage.clear(); },
};
dom.window.localStorage = globalThis.localStorage;

const DIR = "/tmp/omp-web-home/alice/.omp/agent/skills";
const broken = {
  name: "broken",
  description: "",
  filePath: `${DIR}/broken/SKILL.md`,
  mtimeMs: 1,
  hasSkillFile: true,
  source: "custom:user",
  diagnostics: [{
    type: "error",
    message: "Missing frontmatter description; omp skips this skill silently without one.",
    path: `${DIR}/broken/SKILL.md`,
  }],
};
const valid = {
  name: "valid",
  description: "A valid skill.",
  filePath: `${DIR}/valid/SKILL.md`,
  mtimeMs: 2,
  hasSkillFile: true,
  source: "custom:user",
  diagnostics: [],
};

globalThis.fetch = async (url) => {
  const href = String(url);
  if (href === "/api/skills/user") {
    return { ok: true, status: 200, json: async () => ({ directory: DIR, skills: [broken, valid], diagnostics: [] }) };
  }
  if (href.startsWith("/api/skills/user/")) {
    const name = decodeURIComponent(href.split("/").at(-1));
    const skill = name === "valid" ? valid : broken;
    return { ok: true, status: 200, json: async () => ({ skill, content: `---\nname: ${skill.name}\n---\n` }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { SkillsManagerView } = await jiti.import("./SkillsManagerView.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { createRoot } = await import("react-dom/client");

test("die Liste zeigt das Diagnose-Warnzeichen nur am kaputten Skill", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let newSkillPrompt = null;

  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(SkillsManagerView, {
      cwd: "/tmp/project",
      onNewSkill: (prompt) => { newSkillPrompt = prompt; },
      onEditWithAi() {},
    })));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

  const badges = container.querySelectorAll('[aria-label^="Skill problem"]');
  assert.equal(badges.length, 1, "genau ein Skill traegt das Warnzeichen");
  const brokenRow = [...container.querySelectorAll("button")].find((button) => button.textContent.includes("broken"));
  assert.ok(brokenRow);
  assert.match(brokenRow.getAttribute("title"), /Missing frontmatter description/);
  const validRow = [...container.querySelectorAll("button")].find((button) => button.textContent.includes("valid"));
  assert.ok(validRow);
  assert.equal(validRow.querySelector('[aria-label^="Skill problem"]'), null);

  // "New skill" muss den absoluten Bestand in den Prompt schreiben.
  const newButton = [...container.querySelectorAll("button")].find((button) => button.textContent.includes("New skill"));
  assert.ok(newButton);
  const propsKey = Object.keys(newButton).find((key) => key.startsWith("__reactProps"));
  assert.ok(propsKey);
  await act(async () => { newButton[propsKey].onClick(); });
  assert.ok(newSkillPrompt?.includes(DIR), newSkillPrompt ?? "no prompt");

  root.unmount();
});
