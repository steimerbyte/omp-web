import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";

/**
 * Die Newsletter-Ansicht — gerendert, nicht im Quelltext gelesen.
 *
 * Geprueft wird, was der Nutzer sieht: die neueste Ausgabe mit ihren
 * Abschnitten, die aelteren Ausgaben als waehlbare Chips und der leere
 * Zustand. Die Herkunft der Texte ist dabei Teil der Zusage: Quellen werden
 * nur als `http(s)` verlinkt und in einem neuen Tab geoeffnet.
 */

const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
restoreLinkedomPrototypesOnExit(win);
const nav = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };
win.getComputedStyle = () => new Proxy({}, { get: (_target, prop) => {
  // Radix' Presence wartet auf `animationend`, wenn es eine Animation sieht.
  // linkedom fuehrt keine aus; ohne dieses "keine Animation" bleibt jeder
  // geschlossene Dialog im Portal stehen.
  if (prop === "animationName") return "none";
  return typeof prop === "string" && prop.startsWith("get") ? () => "" : "0px";
} });
win.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
Object.defineProperty(win.document, "visibilityState", { configurable: true, get: () => "visible" });
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

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  clear: () => storage.clear(),
};
win.localStorage = globalThis.localStorage;

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { NewsletterView } = await jiti.import("./NewsletterView.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { createRoot } = await import("react-dom/client");

const ISSUES = [
  {
    id: "i2",
    generatedAt: "2026-11-17T06:00:00Z",
    title: "Today's issue",
    intro: "Two stories worth your morning.",
    sections: [
      {
        topic: "agents",
        headline: "Agents ship",
        summary: "A big week for tool use.",
        items: [
          { title: "Story A", summary: "Why it matters", url: "https://example.com/a" },
          { title: "Story B", url: "javascript:alert(1)" },
        ],
      },
    ],
  },
  {
    id: "i0",
    generatedAt: "2026-11-16T06:00:00Z",
    title: "Yesterday's issue",
    intro: "Older intro.",
    sections: [{ topic: "models", items: [{ title: "Old story" }] }],
  },
];

function newsletter(overrides = {}) {
  return {
    id: "n1",
    name: "AI digest",
    topics: ["agents", "models"],
    provider: "test",
    modelId: "m1",
    taskId: "t1",
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-17T05:00:00Z",
    issues: ISSUES,
    schedule: {
      enabled: true,
      nextRun: Date.now() + 3_600_000,
      lastRunAt: "2026-11-17T05:00:00Z",
      lastRunStatus: "ok",
      cron: "0 8 * * *",
      cwd: null,
    },
    ...overrides,
  };
}

function json(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

/**
 * Der Takt fuer die relativen Zeiten.
 *
 * Er laeuft alle 30 s; ein Test, der darauf wartet, waere eine halbe Minute
 * lang. Stattdessen wird der Callback gemerkt und von Hand getickt.
 */
const timers = [];
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
globalThis.setInterval = (callback, ms) => {
  timers.push({ callback, ms });
  return timers.length;
};
globalThis.clearInterval = () => {};
test.after(() => {
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
});

async function mount({ newsletters = [newsletter()], handler = null } = {}) {
  win.document.body.innerHTML = "";
  timers.length = 0;
  const originalFetch = globalThis.fetch;
  calls.length = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const call = { url, method, body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    if (handler) {
      const answer = await handler(call);
      if (answer) return answer;
    }
    if (url === "/api/newsletters" && method === "GET") return json({ newsletters });
    if (url === "/api/newsletters" && method === "POST") return json({ newsletter: newsletter({ id: "n2", name: "n2" }) }, 201);
    if (url === "/api/newsletters/n1/run" && method === "POST") return json({ sessionId: "s9" });
    if (url === "/api/newsletters/n1" && method === "PATCH") return json({ newsletter: newsletter() });
    if (url === "/api/newsletters/n1" && method === "DELETE") return json({ ok: true });
    // Der Dialog und der Kopf lesen dieselben Ordner wie die geplanten Aufgaben.
    if (url === "/api/scheduled-settings" && method === "GET") {
      return json({ defaultCwd: null, home: "/home/alice", folders: ["/home/alice", "/home/alice/work"] });
    }
    if (url.startsWith("/api/models")) {
      return json({
        modelList: [
          { id: "m1", name: "Model One", provider: "test" },
          { id: "m2", name: "Model Two", provider: "test" },
        ],
        models: {},
      });
    }
    return json({}, 404);
  };
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(NewsletterView)));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  return {
    container,
    async unmount() { await act(async () => { root.unmount(); }); globalThis.fetch = originalFetch; },
  };
}

/** Die Anfragen des montierten Baums, in Reihenfolge. */
const calls = [];

function button(container, text) {
  return [...container.querySelectorAll("button")].find((node) => (node.textContent ?? "").trim() === text);
}

const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); }); };

async function click(node) {
  await act(async () => { node.click(); });
  await settle();
}

/** Den React-Handler direkt aufrufen: linkedom fuehrt kein `value`-Setter fuer jedes Feld. */
function reactProps(element) {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps"));
  return key ? element[key] : null;
}

async function change(element, value) {
  await act(async () => {
    reactProps(element)?.onChange?.({ target: { value }, currentTarget: element, preventDefault() {}, stopPropagation() {} });
  });
}

/** Radix haengt den Dialog als Portal an den `body`. */
const dialog = () => win.document.querySelector("[role=dialog]");

test("renders the latest issue with its sections and an http source link", async () => {
  const harness = await mount();

  assert.match(harness.container.textContent, /AI digest/);
  assert.match(harness.container.textContent, /Today's issue/);
  assert.match(harness.container.textContent, /Two stories worth your morning\./, "die Einleitung fehlt");
  assert.match(harness.container.textContent, /Agents ship/, "der Abschnittskopf fehlt");
  assert.match(harness.container.textContent, /Story A/, "der Eintrag fehlt");

  const link = harness.container.querySelector('a[href="https://example.com/a"]');
  assert.ok(link, "der Quellenlink fehlt");
  assert.equal(link.getAttribute("target"), "_blank");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");

  // Fremder Text bleibt Text: eine `javascript:`-Adresse wird nicht verlinkt.
  const hrefs = [...harness.container.querySelectorAll("a")].map((node) => node.getAttribute("href"));
  assert.deepEqual(hrefs.filter((href) => !href.startsWith("https://")), []);

  // Der Zeitplan steht unter dem Namen: naechster Lauf und letzter Status.
  assert.match(harness.container.textContent, /Next run/);
  assert.match(harness.container.textContent, /Last run/);

  await harness.unmount();
});

test("older issues are chips and switch the shown issue; Newest goes back", async () => {
  const harness = await mount();

  assert.match(harness.container.textContent, /Earlier issues/);
  const chips = [...harness.container.querySelectorAll("button")]
    .filter((node) => (node.textContent ?? "").trim() !== "Newest" && /\d{2}\.\d{2}\.\d{4}/.test(node.textContent ?? ""));
  assert.equal(chips.length, 1, "die aeltere Ausgabe fehlt als Chip");

  await act(async () => { chips[0].click(); });
  assert.match(harness.container.textContent, /Yesterday's issue/);
  assert.equal(harness.container.textContent.includes("Old story"), true);
  assert.equal(harness.container.textContent.includes("Today's issue"), false);

  const newest = button(harness.container, "Newest");
  assert.ok(newest, "der Neueste-Knopf fehlt");
  await act(async () => { newest.click(); });
  assert.match(harness.container.textContent, /Today's issue/);

  await harness.unmount();
});

test("an empty store is its own state with a create CTA", async () => {
  const harness = await mount({ newsletters: [] });

  assert.match(harness.container.textContent, /No newsletter yet/);
  // Der Kopf traegt denselben Knopf; gemeint ist die Aufforderung im leeren
  // Zustand, also der Knopf innerhalb des leeren Bereichs.
  const empty = harness.container.querySelector('[data-newsletter-state="empty"]');
  const cta = button(empty, "New newsletter");
  assert.ok(cta, "der Anlegen-Knopf fehlt im leeren Zustand");

  await act(async () => { cta.click(); });
  // Radix haengt den Dialog als Portal an den `body`.
  assert.ok(win.document.body.textContent.includes("Topics"), "der Dialog ist nicht aufgegangen");

  await harness.unmount();
});

test("the dialog creates a newsletter with topics, schedule and model", async () => {
  const harness = await mount();
  await click(button(harness.container, "New newsletter"));
  assert.ok(dialog(), "der Dialog ist nicht aufgegangen");

  await change(win.document.querySelector("#newsletter-name"), "Fresh digest");
  await change(win.document.querySelector("#newsletter-topics"), "beta, gamma");
  // Erst der Rohausdruck, dann die drei Felder: die Felder gewinnen wieder.
  await change(win.document.querySelector("#newsletter-cron"), "0 9 * * 5");
  await change(win.document.querySelector("#newsletter-cron"), "*/15 * * * *");
  await change(win.document.querySelector("#newsletter-minute"), "15");
  await change(win.document.querySelector("#newsletter-hour"), "7");
  await change(win.document.querySelector("#newsletter-weekday"), "1-5");
  await change(win.document.querySelector("#newsletter-model"), "test\u0000m2");

  const form = win.document.querySelector("form");
  await act(async () => { reactProps(form).onSubmit({ preventDefault() {} }); });
  await settle();

  const post = calls.find((call) => call.method === "POST" && call.url === "/api/newsletters");
  assert.ok(post, "der POST fehlt");
  assert.deepEqual(post.body, {
    name: "Fresh digest",
    topics: ["beta", "gamma"],
    provider: "test",
    modelId: "m2",
    cron: "15 7 * * 1-5",
    cwd: null,
  });
  assert.equal(dialog(), null, "der Dialog blieb offen");
  await harness.unmount();
});

test("editing prefills the schedule from schedule.cron and sends it back", async () => {
  const harness = await mount();
  await click(button(harness.container, "Edit"));
  await change(win.document.querySelector("#newsletter-name"), "Renamed");

  await act(async () => {
    reactProps(win.document.querySelector("form")).onSubmit({ preventDefault() {} });
  });
  await settle();

  const patch = calls.find((call) => call.method === "PATCH");
  assert.ok(patch, "der PATCH fehlt");
  assert.deepEqual(patch.body, {
    name: "Renamed",
    topics: ["agents", "models"],
    provider: "test",
    modelId: "m1",
    cron: "0 8 * * *",
    cwd: null,
  });

  await click(button(harness.container, "Edit"));
  await click(button(dialog(), "Cancel"));
  assert.equal(dialog(), null, "Cancel hat den Dialog nicht geschlossen");
  await harness.unmount();
});

test("the header shows the workspace of the run, shortened to the home prefix", async () => {
  const harness = await mount({
    newsletters: [newsletter({ schedule: { ...newsletter().schedule, cwd: "/home/alice/work" } })],
  });
  assert.match(harness.container.textContent, /Working folder: ~\/work/);
  await harness.unmount();
});

test("the dialog prefills the stored workspace and sends it back", async () => {
  const harness = await mount({
    newsletters: [newsletter({ schedule: { ...newsletter().schedule, cwd: "/home/alice/work" } })],
  });
  await click(button(harness.container, "Edit"));

  const select = win.document.querySelector("#newsletter-cwd");
  assert.ok(select, "die Arbeitsordner-Wahl fehlt");
  assert.equal(select.value, "/home/alice/work", "der gespeicherte Ordner ist nicht vorbelegt");
  // Die Ordner des Kontos sind absolut und der Leerwert ist der Standard.
  assert.deepEqual([...select.querySelectorAll("option")].map((option) => option.value).slice(0, 3), ["", "/home/alice", "/home/alice/work"]);

  await act(async () => {
    reactProps(win.document.querySelector("form")).onSubmit({ preventDefault() {} });
  });
  await settle();
  const patch = calls.find((call) => call.method === "PATCH");
  assert.equal(patch.body.cwd, "/home/alice/work");
  await harness.unmount();
});

test("choosing the default workspace sends null", async () => {
  const harness = await mount({
    newsletters: [newsletter({ schedule: { ...newsletter().schedule, cwd: "/home/alice/work" } })],
  });
  await click(button(harness.container, "Edit"));
  await change(win.document.querySelector("#newsletter-cwd"), "");

  await act(async () => {
    reactProps(win.document.querySelector("form")).onSubmit({ preventDefault() {} });
  });
  await settle();
  const patch = calls.find((call) => call.method === "PATCH");
  assert.equal(patch.body.cwd, null, "der Leerwert muss als Loeschung ankommen");
  await harness.unmount();
});

test("a newsletter without a schedule is saved with a cron that recreates the task", async () => {
  const harness = await mount({ newsletters: [newsletter({ schedule: null })] });
  assert.match(harness.container.textContent, /The schedule is missing/);

  await click(button(harness.container, "Edit"));
  await act(async () => {
    reactProps(win.document.querySelector("form")).onSubmit({ preventDefault() {} });
  });
  await settle();

  const patch = calls.find((call) => call.method === "PATCH");
  assert.ok(patch, "der PATCH fehlt");
  assert.equal(patch.body.cron, "0 8 * * 1", "ohne Zeitplan geht kein Cron mit — die Aufgabe entstuende nie");
  await harness.unmount();
});

test("deleting asks inside the dialog and removes the newsletter", async () => {
  const harness = await mount();
  await click(button(harness.container, "Delete"));
  assert.match(dialog().textContent, /Delete .AI digest.\? Its schedule stops with it\./);

  await click(button(dialog(), "Delete newsletter"));
  assert.ok(calls.some((call) => call.method === "DELETE" && call.url === "/api/newsletters/n1"));
  assert.equal(dialog(), null);

  // Der Weg in die Rueckfrage steht auch im Dialog selbst; Abbrechen laesst
  // den Dialog stehen und nimmt nur die Rueckfrage zurueck.
  await click(button(harness.container, "Edit"));
  await click(button(dialog(), "Delete"));
  assert.match(dialog().textContent, /Its schedule stops with it\./);
  await click(button(dialog(), "Cancel"));
  assert.equal(dialog().textContent.includes("Its schedule stops with it."), false);
  await click(button(dialog(), "Cancel"));
  assert.equal(dialog(), null);
  await harness.unmount();
});

test("run now posts the run and reports a refused start", async () => {
  let failRun = false;
  const harness = await mount({
    handler: async (call) => (failRun && call.url === "/api/newsletters/n1/run" ? json({ error: "no model" }, 503) : null),
  });
  await click(button(harness.container, "Refresh now"));
  assert.ok(calls.some((call) => call.method === "POST" && call.url === "/api/newsletters/n1/run"));

  failRun = true;
  await click(button(harness.container, "Refresh now"));
  assert.match(harness.container.textContent, /The run could not be started\./);
  await harness.unmount();
});

test("a failed load is a banner whose Retry loads again", async () => {
  let fail = true;
  const harness = await mount({
    handler: async (call) => (fail && call.url === "/api/newsletters" ? json({ error: "boom" }, 503) : null),
  });
  assert.match(harness.container.textContent, /The newsletters could not be loaded\./);

  fail = false;
  await click(button(harness.container, "Retry"));
  assert.match(harness.container.textContent, /AI digest/);
  await harness.unmount();
});

test("a second newsletter switches, and one without issues says so", async () => {
  const harness = await mount({
    newsletters: [newsletter(), newsletter({ id: "n3", name: "Second digest", issues: [] })],
  });
  await click(button(harness.container, "Second digest"));
  assert.match(harness.container.textContent, /Second digest/);
  assert.match(harness.container.textContent, /No issue yet/);
  await harness.unmount();
});

test("Escape closes the dialog through onOpenChange", async () => {
  const harness = await mount();
  await click(button(harness.container, "Edit"));
  assert.ok(dialog(), "der Dialog ist nicht aufgegangen");

  const event = new win.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "key", { value: "Escape", configurable: true });
  Object.defineProperty(event, "code", { value: "Escape", configurable: true });
  await act(async () => { win.document.dispatchEvent(event); });
  await settle();
  assert.equal(dialog(), null, "Escape hat den Dialog nicht geschlossen");
  await harness.unmount();
});

test("a failed model list is shown but does not break the dialog", async () => {
  const harness = await mount({
    handler: async (call) => {
      if (call.url.startsWith("/api/models")) throw new Error("offline");
      return null;
    },
  });
  await click(button(harness.container, "Edit"));
  assert.match(dialog().textContent, /The model list could not be loaded\. offline/);
  await harness.unmount();
});

test("the relative time keeps ticking while the view stays open", async () => {
  const harness = await mount();
  const tick = timers.find((entry) => entry.ms === 30_000)?.callback;
  assert.ok(tick, "der Takt fuer die relativen Zeiten fehlt");
  await act(async () => { tick(); });
  assert.match(harness.container.textContent, /Next run/);
  await harness.unmount();
});

test("a model answer that is not JSON leaves an empty, working list", async () => {
  const harness = await mount({
    handler: async (call) => {
      if (call.url.startsWith("/api/models")) {
        return { ok: true, status: 200, json: async () => { throw new Error("not json"); } };
      }
      return null;
    },
  });
  await click(button(harness.container, "Edit"));
  assert.ok(dialog(), "der Dialog ist nicht aufgegangen");
  assert.equal(dialog().textContent.includes("could not be loaded"), false, "ein leerer Koerper ist kein Fehler");
  await harness.unmount();
});

test("a refused save stays open and names the field", async () => {
  const harness = await mount({
    handler: async (call) => (call.method === "PATCH" ? json({ error: "bad name", field: "name" }, 500) : null),
  });
  await click(button(harness.container, "Edit"));
  await act(async () => {
    reactProps(win.document.querySelector("form")).onSubmit({ preventDefault() {} });
  });
  await settle();

  assert.ok(dialog(), "der Dialog ist trotz Fehler zugegangen");
  assert.match(dialog().textContent, /The newsletter could not be saved\. bad name \(name\)/);
  await harness.unmount();
});

test("a refused delete stays open and shows the reason", async () => {
  const harness = await mount({
    handler: async (call) => (call.method === "DELETE" ? json({ error: "locked" }, 503) : null),
  });
  await click(button(harness.container, "Delete"));
  await click(button(dialog(), "Delete newsletter"));

  assert.ok(dialog(), "der Dialog ist trotz Fehler zugegangen");
  assert.match(dialog().textContent, /The newsletter could not be deleted\. locked/);
  await harness.unmount();
});

test("an issue without intro or summaries still renders its items", async () => {
  const harness = await mount({
    newsletters: [newsletter({
      schedule: { enabled: false, nextRun: null, lastRunAt: null, lastRunStatus: "error", cron: "0 8 * * 1" },
      issues: [{
        id: "i9",
        generatedAt: "2026-11-17T06:00:00Z",
        sections: [
          { topic: "agents", items: [{ title: "Only a title" }] },
          { topic: "models", items: [] },
        ],
      }],
    })],
  });
  assert.match(harness.container.textContent, /Only a title/);
  assert.match(harness.container.textContent, /Paused/);
  assert.match(harness.container.textContent, /Failed to start/);
  await harness.unmount();
});

test("a model endpoint that refuses is reported", async () => {
  const harness = await mount({
    handler: async (call) => (call.url.startsWith("/api/models") ? json({ error: "no registry" }, 503) : null),
  });
  await click(button(harness.container, "Edit"));
  assert.match(dialog().textContent, /The model list could not be loaded\. no registry/);
  await harness.unmount();
});

test("a poll failure over loaded data keeps the list and offers a retry", async () => {
  let fail = false;
  const harness = await mount({
    handler: async (call) => (fail && call.url === "/api/newsletters" ? json({ error: "boom" }, 503) : null),
  });
  fail = true;
  // Der 10-s-Takt des Hooks: kein zweiter Timer, den die Ansicht selbst haette.
  const poll = timers.find((entry) => entry.ms === 10_000)?.callback;
  assert.ok(poll, "das Poll-Intervall des Hooks fehlt");
  await act(async () => {
    poll();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.match(harness.container.textContent, /could not be loaded/);
  assert.match(harness.container.textContent, /AI digest/, "die geladene Liste ist verschwunden");

  fail = false;
  await click(button(harness.container, "Retry"));
  assert.equal(harness.container.textContent.includes("could not be loaded"), false);
  await harness.unmount();
});
