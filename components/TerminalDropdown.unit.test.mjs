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
const { TerminalDropdown, terminalSpawnCols } = await jiti.import(`${ROOT}/components/TerminalDropdown.tsx`);

/** Ein geschlossenes Desktop-Panel: der Container ist 0 px, das Kind traegt die Breite. */
function stubRightPanel(clientWidth) {
  const panel = win.document.createElement("div");
  panel.className = "right-panel-container";
  Object.defineProperty(panel, "clientWidth", { configurable: true, value: clientWidth });
  win.document.body.appendChild(panel);
  return () => panel.remove();
}

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

async function mount({ fetchImpl, cwd = "/work", onOpenTerminal = () => {} } = {}) {
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
      React.createElement(TerminalDropdown, { cwd, onOpenTerminal })));
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
  // Die Kopfleiste schneidet Kinder ab (`overflow-y: hidden`); ein
  // absolut positioniertes Menue waere unsichtbar. Es liegt fest im Viewport,
  // an einer gemessenen Zahl und nicht an `100%` des 36-px-Streifens.
  assert.equal(menu.style.position, "fixed");
  assert.equal(Number.isFinite(Number.parseFloat(menu.style.top)), true, `top fehlt: ${menu.style.top}`);
  assert.equal(Number.isFinite(Number.parseFloat(menu.style.left)), true, `left fehlt: ${menu.style.left}`);
  assert.match(menu.textContent, /New terminal/);
  assert.match(menu.textContent, /\/work\/running/);
  assert.match(menu.textContent, /bash · pid 11/);
  assert.match(menu.textContent, /zsh · pid 12/);
  assert.equal(menu.querySelectorAll('[role="menuitem"]').length, 3, "Neu + zwei Terminals");

  // Eine Zeile pro Eintrag: der Name bleibt ganz, der Pfad daneben kuerzt sich.
  // Mit `flex: 1` am Namen brach "New terminal" bei 280 px um.
  const createRow = [...menu.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.includes("New terminal"));
  const label = [...createRow.querySelectorAll("span")].find((node) => node.textContent.trim() === "New terminal");
  assert.ok(label, "der Name der Neu-Zeile fehlt");
  assert.equal(label.style.whiteSpace, "nowrap");
  assert.equal(label.style.flexShrink, "0");
  const path = [...createRow.querySelectorAll("span")].find((node) => node.textContent.trim() === "/work");
  assert.ok(path, "der Pfad der Neu-Zeile fehlt");
  assert.equal(path.style.whiteSpace, "nowrap");
  assert.equal(path.style.textOverflow, "ellipsis");
  assert.equal(path.getAttribute("title"), "/work", "der gekuerzte Pfad braucht den vollen Wert");

  const running = [...menu.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.includes("/work/running"));
  const runningPath = [...running.querySelectorAll("div")]
    .find((node) => node.textContent.trim() === "/work/running");
  assert.ok(runningPath, "der Pfad der laufenden Zeile fehlt");
  assert.equal(runningPath.getAttribute("title"), "/work/running", "der gekuerzte Pfad braucht den vollen Wert");
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
  // Desktop: das Panel misst 522 px (der gemessene rechte Dateibereich).
  const removePanel = stubRightPanel(522);
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
  assert.deepEqual(JSON.parse(post.options.body), { cwd: "/work", cols: 62, rows: 30 });
  removePanel();
  assert.match(container.textContent, /spawn failed/);
  assert.deepEqual(opened, [], "bei einem Fehler wird kein Terminal geoeffnet");

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("auf dem Telefon spawnt die Shell in die Overlay-Breite", async () => {
  const desktopWidth = win.innerWidth;
  win.innerWidth = 390;
  try {
    const { root, container, calls } = await mount({ fetchImpl: defaultFetch });
    const trigger = container.querySelector('button[aria-haspopup="menu"]');
    await act(async () => {
      trigger.click();
    });
    const newItem = [...container.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.includes("New terminal"));
    await act(async () => {
      newItem.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const post = calls.find((call) => call.options.method === "POST");
    // Kein messbares Panel (geschlossen, display: none) → (390 − 32) / 8,4 =
    // 42 Spalten; 62 waeren auf diesem Bild umgebrochene Zeilen.
    assert.deepEqual(JSON.parse(post.options.body), { cwd: "/work", cols: 42, rows: 30 });

    await act(async () => root.unmount());
    mounted.splice(0, mounted.length);
    container.remove();
  } finally {
    win.innerWidth = desktopWidth;
  }
});

test("die Spalten folgen der gemessenen Breite, sonst dem Viewport", () => {
  // Gemessenes Panel gewinnt: 522 / 8,4 = 62.
  assert.equal(terminalSpawnCols(522, 1280), 62);
  // Ohne Messung: Telefon-Overlay (390 − 32) / 8,4 = 42; Desktop (1200 − 32) / 8,4 = 139.
  assert.equal(terminalSpawnCols(null, 390), 42);
  assert.equal(terminalSpawnCols(null, 1280), 139);
  // Klemmen: nie unter die Messgrenze, nie ueber 200 Spalten.
  assert.equal(terminalSpawnCols(10, 390), 20);
  assert.equal(terminalSpawnCols(2400, 1280), 200);
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

test("Mousedown daneben schliesst das Menue", async () => {
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
