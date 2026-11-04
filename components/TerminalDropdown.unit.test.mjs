import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

/**
 * TerminalDropdown: Liste der Terminals, Oeffnen eines laufenden Terminals,
 * Kill per DELETE, Spawn per POST (inkl. Fehlertext) und Schliessen per
 * Mousedown daneben. Der 4-Sekunden-Poll wird nicht abgewartet.
 */

const ROOT = process.cwd();
const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
restoreLinkedomPrototypesOnExit(win);

const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US" };
const storage = new Map();
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => void storage.set(key, String(value)),
  removeItem: (key) => void storage.delete(key),
};

const ORIGINALS = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
  localStorage: globalThis.localStorage,
  fetch: globalThis.fetch,
  matchMedia: globalThis.matchMedia,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
};

win.innerWidth = 1200;
win.innerHeight = 800;
win.localStorage = localStorage;
win.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {} });
globalThis.window = new Proxy(win, {
  get(target, property) {
    if (property === "navigator") return fakeNavigator;
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
  has(target, property) {
    return property === "navigator" || Reflect.has(target, property);
  },
});
globalThis.document = win.document;
globalThis.navigator = fakeNavigator;
globalThis.localStorage = localStorage;
globalThis.matchMedia = win.matchMedia;
for (const [name, value] of Object.entries(linkedom)) {
  if (name === "parseHTML" || name === "default") continue;
  if (typeof value === "function" && /^[A-Z]/.test(name)) globalThis[name] = value;
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
win.getComputedStyle = () => new Proxy({}, { get: (_target, property) => (typeof property === "string" && property.startsWith("get") ? () => "" : "0px") });
globalThis.getComputedStyle = win.getComputedStyle;

const mounted = [];
test.after(async () => {
  for (const { root } of mounted.splice(0)) {
    await act(async () => root.unmount());
  }
  for (const key of ["window", "document", "navigator", "localStorage", "fetch", "matchMedia", "IS_REACT_ACT_ENVIRONMENT"]) {
    if (ORIGINALS[key] === undefined) delete globalThis[key];
    else globalThis[key] = ORIGINALS[key];
  }
});

const jiti = createJiti(`${ROOT}/package.json`, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { I18nProvider } = await jiti.import(`${ROOT}/hooks/useI18n.tsx`);
const { TerminalDropdown } = await jiti.import(`${ROOT}/components/TerminalDropdown.tsx`);

const TERMINALS = [
  { id: "t1", cwd: "/work/running", shell: "bash", status: "running", pid: 11, createdAt: 1 },
  { id: "t2", cwd: "/work/dead", shell: "zsh", status: "exited", pid: 12, createdAt: 2 },
];

function fire(target, type, props = {}) {
  const event = new win.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(event, key, { value, configurable: true });
  }
  target.dispatchEvent(event);
  return event;
}

async function mount({ fetchImpl, disabled = false, cwd = "/work", onOpenTerminal = () => {} } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return fetchImpl(String(url), options);
  };
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    root.render(React.createElement(I18nProvider, null,
      React.createElement(TerminalDropdown, { cwd, disabled, onOpenTerminal })));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  mounted.push({ root });
  return { root, container, calls };
}

const defaultFetch = async (url, options = {}) => {
  if (options.method === "POST") {
    return { ok: true, status: 200, json: async () => ({ terminal: { ...TERMINALS[0], id: "new-1" } }) };
  }
  if (options.method === "DELETE") {
    return { ok: true, status: 200, json: async () => ({}) };
  }
  return { ok: true, status: 200, json: async () => ({ terminals: TERMINALS }) };
};

test("zeigt laufende und beendete Terminals und oeffnet ein laufendes", async () => {
  const opened = [];
  const { root, container, calls } = await mount({
    fetchImpl: defaultFetch,
    onOpenTerminal: (id) => opened.push(id),
  });

  const trigger = container.querySelector('button[aria-haspopup="menu"]');
  assert.ok(trigger);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(calls[0].url, "/api/terminal");
  assert.match(trigger.textContent, /Terminal/);
  assert.ok(trigger.querySelector('[aria-label="1 running"]'), "der Running-Zaehler fehlt");

  await act(async () => {
    fire(trigger, "mouseover", { relatedTarget: win.document.body });
    fire(trigger, "mouseout", { relatedTarget: win.document.body });
    trigger.click();
  });
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  const menu = container.querySelector('[role="menu"]');
  assert.ok(menu);
  assert.match(menu.textContent, /New terminal/);
  assert.match(menu.textContent, /\/work\/running/);
  assert.match(menu.textContent, /bash · pid 11/);
  assert.match(menu.textContent, /zsh · pid 12/);
  assert.equal(menu.querySelectorAll('[role="menuitem"]').length, 3, "Neu + zwei Terminals");

  const running = [...menu.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.includes("/work/running"));
  await act(async () => {
    fire(running, "mouseover", { relatedTarget: win.document.body });
    running.click();
  });
  assert.deepEqual(opened, ["t1"]);
  assert.equal(container.querySelector('[role="menu"]'), null, "die Auswahl schliesst das Menue");

  // Beendete Terminals reagieren nicht auf Klick.
  await act(async () => {
    trigger.click();
  });
  const dead = [...container.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.includes("/work/dead"));
  await act(async () => {
    fire(dead, "mouseover", { relatedTarget: win.document.body });
    fire(dead, "mouseout", { relatedTarget: win.document.body });
    dead.click();
  });
  assert.deepEqual(opened, ["t1"]);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("spawnt ein Terminal und nennt den Fehler, wenn der Server ablehnt", async () => {
  const opened = [];
  const { root, container, calls } = await mount({
    fetchImpl: async (url, options = {}) => {
      if (options.method === "POST") {
        return { ok: false, status: 500, json: async () => ({ error: "spawn failed" }) };
      }
      return defaultFetch(url, options);
    },
    onOpenTerminal: (id) => opened.push(id),
  });
  const trigger = container.querySelector('button[aria-haspopup="menu"]');
  await act(async () => {
    trigger.click();
  });
  const newItem = [...container.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.includes("New terminal"));
  assert.ok(newItem);

  await act(async () => {
    newItem.click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const post = calls.find((call) => call.options.method === "POST");
  assert.equal(post.url, "/api/terminal");
  assert.equal(post.options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(post.options.body), { cwd: "/work", cols: 100, rows: 30 });
  assert.match(container.textContent, /spawn failed/);
  assert.deepEqual(opened, [], "bei einem Fehler wird kein Terminal geoeffnet");

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("erfolgreicher Spawn oeffnet das neue Terminal und schliesst das Menue", async () => {
  const opened = [];
  const { root, container, calls } = await mount({
    fetchImpl: defaultFetch,
    onOpenTerminal: (id) => opened.push(id),
  });
  const trigger = container.querySelector('button[aria-haspopup="menu"]');
  await act(async () => {
    trigger.click();
  });
  const newItem = [...container.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.includes("New terminal"));
  await act(async () => {
    newItem.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  assert.deepEqual(opened, ["new-1"]);
  assert.equal(container.querySelector('[role="menu"]'), null);
  // Nach dem Spawn wird die Liste neu geladen.
  assert.equal(calls.filter((call) => call.options.method !== "POST" && call.url === "/api/terminal").length >= 2, true);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Kill schickt DELETE und laedt die Liste neu", async () => {
  const { root, container, calls } = await mount({
    fetchImpl: async (url, options = {}) => {
      if (options.method === "DELETE") throw new Error("delete failed");
      return defaultFetch(url, options);
    },
  });
  const trigger = container.querySelector('button[aria-haspopup="menu"]');
  await act(async () => {
    trigger.click();
  });

  const kill = container.querySelector('[aria-label="Kill terminal in /work/running"]');
  assert.ok(kill);
  await act(async () => {
    fire(kill, "mouseover", { relatedTarget: win.document.body });
    fire(kill, "mouseout", { relatedTarget: win.document.body });
    kill.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  const del = calls.find((call) => call.options.method === "DELETE");
  assert.equal(del.url, "/api/terminal/t1");
  const refreshes = calls.filter((call) => call.url === "/api/terminal" && !call.options.method);
  assert.equal(refreshes.length >= 2, true, "Mount und Kill laden die Liste");

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Mousedown daneben schliesst das Menue, disabled oeffnet es nicht", async () => {
  const { root, container } = await mount({ fetchImpl: defaultFetch });
  const trigger = container.querySelector('button[aria-haspopup="menu"]');
  await act(async () => {
    trigger.click();
  });
  assert.ok(container.querySelector('[role="menu"]'));

  await act(async () => {
    fire(win.document.body, "mousedown");
  });
  assert.equal(container.querySelector('[role="menu"]'), null);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();

  const second = await mount({ fetchImpl: defaultFetch, disabled: true });
  const disabledTrigger = second.container.querySelector('button[aria-haspopup="menu"]');
  assert.equal(disabledTrigger.getAttribute("title"), "Select a project to open a terminal");
  await act(async () => {
    disabledTrigger.click();
  });
  assert.equal(second.container.querySelector('[role="menu"]'), null);
  await act(async () => second.root.unmount());
  mounted.splice(0, mounted.length);
  second.container.remove();
});

test("ein POST ohne JSON-Antwort nennt den Statuscode", async () => {
  const { root, container } = await mount({
    fetchImpl: async (url, options = {}) => {
      if (options.method === "POST") {
        return { ok: false, status: 500, json: async () => { throw new Error("html answer"); } };
      }
      return defaultFetch(url, options);
    },
  });
  const trigger = container.querySelector('button[aria-haspopup="menu"]');
  await act(async () => {
    trigger.click();
  });
  const newItem = [...container.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.includes("New terminal"));
  await act(async () => {
    newItem.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  assert.match(container.textContent, /Failed to spawn \(500\)/);
  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("leere Liste und ein Netzfehler beim Refresh bleiben ohne Ausnahme", async () => {
  const { root, container } = await mount({
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  const trigger = container.querySelector('button[aria-haspopup="menu"]');
  await act(async () => {
    trigger.click();
  });
  assert.match(container.textContent, /No terminals yet/);
  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});
