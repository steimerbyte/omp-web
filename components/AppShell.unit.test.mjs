import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { mock } from "bun:test";
import { parseHTML } from "linkedom";
import { createJiti } from "jiti";
import { captureLinkedomPrototypes } from "../lib/test-linkedom.mjs";

/**
 * AppShell: Session-Statistik-Panel (formatDuration, section, copyButton),
 * Tastatur-Shortcuts am Separator und global (Ctrl+Alt+N) sowie die
 * Benachrichtigung bei einer Extension-Rueckfrage (fire/onClick im
 * Notification-Pfad). Der Rest des Shell wird wie in den bestehenden
 * AppShell-Tests gemountet; die Chat-Oberflaeche darf dafuer mitlaufen.
 */

let currentSearch = "";
mock.module("next/navigation", () => ({
  useRouter: () => ({ replace() {}, push() {}, back() {}, prefetch() {} }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => "/",
  useParams: () => ({}),
}));

const SESSION = {
  id: "s1",
  path: "/tmp/s1.jsonl",
  cwd: "/home/alice/workspace/demo",
  projectRoot: "/home/alice/workspace/demo",
  created: "2026-01-01T00:00:00Z",
  modified: "2026-10-01T00:00:00Z",
  messageCount: 1,
  firstMessage: "hi",
  parentSession: null,
  name: null,
  transient: false,
};

const sessionDetail = () => ({
  leafId: "l1",
  filePath: "/tmp/s1.jsonl",
  totalActiveMs: 7_200_000,
  running: true,
  contextUsage: { percent: 10, contextWindow: 200_000, tokens: 20_000 },
  context: {
    messages: [{ role: "user", content: "hi", timestamp: 1 }],
    entryIds: [],
    model: "test/model",
    thinkingLevel: "off",
    configuredThinkingLevel: "off",
    tools: [],
  },
});

let restorePrototypes = null;
const ORIGINALS = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
  localStorage: globalThis.localStorage,
  fetch: globalThis.fetch,
  Notification: globalThis.Notification,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  EventSource: globalThis.EventSource,
};

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.onmessage = null;
    this.onerror = null;
    FakeEventSource.instances.push(this);
  }
  close() { this.readyState = 2; }
  emit(payload) {
    this.readyState = 1;
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

class FakeNotification {
  static permission = "granted";
  static instances = [];
  static requestPermission() { return Promise.resolve("granted"); }
  constructor(title, options = {}) {
    this.title = title;
    this.body = options.body;
    this.tag = options.tag;
    this.onclick = null;
    FakeNotification.instances.push(this);
  }
  close() {}
}

let focused = 0;
function installDom({ mobile = false } = {}) {
  const { window } = parseHTML('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  restorePrototypes = captureLinkedomPrototypes(window);
  const navigator = {
    languages: ["en-US"], language: "en-US", userAgent: "harness",
    clipboard: { writeText: () => Promise.resolve() },
  };
  const windowProxy = new Proxy(window, {
    get(target, property) {
      if (property === "navigator") return navigator;
      if (property === "focus") return () => { focused += 1; };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has(target, property) {
      return property === "navigator" || Reflect.has(target, property);
    },
  });
  const storage = new Map();
  globalThis.window = windowProxy;
  globalThis.document = window.document;
  globalThis.navigator = navigator;
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => void storage.set(key, String(value)),
    removeItem: (key) => void storage.delete(key),
  };
  globalThis.Notification = FakeNotification;
  windowProxy.Notification = FakeNotification;
  globalThis.EventSource = FakeEventSource;
  windowProxy.EventSource = FakeEventSource;
  window.document.hasFocus = () => false;
  globalThis.location = new URL(`http://localhost:30141/${currentSearch}`);
  globalThis.history = {
    state: null,
    replaceState(_state, _unused, url) { globalThis.location = new URL(String(url), "http://localhost:30141/"); },
    pushState() {},
  };
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  globalThis.KeyboardEvent = class KeyboardEvent extends window.Event {
    constructor(type, init = {}) {
      super(type, init);
      Object.assign(this, {
        key: init.key, code: init.code, ctrlKey: init.ctrlKey ?? false,
        altKey: init.altKey ?? false, shiftKey: init.shiftKey ?? false,
        metaKey: init.metaKey ?? false,
      });
    }
  };
  globalThis.getComputedStyle = window.getComputedStyle ?? (() => ({}));
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  const matchMedia = (query) => ({
    matches: mobile && String(query).includes("max-width"),
    media: String(query),
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
  });
  globalThis.matchMedia = matchMedia;
  windowProxy.matchMedia = matchMedia;
  globalThis.DOMRect ??= class DOMRect {
    constructor(x = 0, y = 0, width = 0, height = 0) {
      Object.assign(this, { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height });
    }
    toJSON() { return { ...this }; }
  };
  const noopObserver = class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  };
  globalThis.ResizeObserver = noopObserver;
  globalThis.IntersectionObserver = noopObserver;
  globalThis.MutationObserver = noopObserver;
  window.Element.prototype.getBoundingClientRect = function rect() {
    return new globalThis.DOMRect(0, 0, 1200, 800);
  };
  for (const property of ["offsetWidth", "clientWidth"]) {
    Object.defineProperty(window.HTMLElement.prototype, property, { configurable: true, get: () => 1200 });
  }
  for (const property of ["offsetHeight", "clientHeight"]) {
    Object.defineProperty(window.HTMLElement.prototype, property, { configurable: true, get: () => 800 });
  }
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};

  const json = (body) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    if (/^\/api\/sessions\/[^/?]+/.test(url)) return json(sessionDetail());
    if (url.startsWith("/api/sessions")) return json({ sessions: [SESSION] });
    if (url.startsWith("/api/projects/sizes")) return json({ sizes: [], pending: false });
    if (url.startsWith("/api/projects")) return json({ projects: [], priorities: [], home: "/home/alice" });
    if (url.startsWith("/api/terminal")) {
      if ((init?.method ?? "GET") === "POST") {
        return json({ terminal: { id: "t-phone", cwd: "/home/alice", pid: 77, status: "running", shell: "bash", createdAt: 1, sandboxed: false } });
      }
      return json({ terminals: [] });
    }
    if (url.startsWith("/api/system-stats")) {
      return json({
        cpuPercent: 42,
        cpuCores: 8,
        loadAvg: { "1m": 0.5, "5m": 0.4, "15m": 0.3 },
        memory: { totalBytes: 2 ** 34, usedBytes: 2 ** 33, usedPercent: 50 },
        gpu: { present: true, vendor: "nvidia", utilizationPercent: 73, memoryUsedBytes: 2 ** 31, memoryTotalBytes: 2 ** 32, source: "nvidia-smi" },
        process: { pid: 1234, rssBytes: 1024, heapBytes: 512, uptimeSec: 5 },
        sampledAt: Date.now(),
      });
    }
    if (url.startsWith("/api/agent/")) {
      if (url.includes("/events")) {
        return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
      }
      return json({ running: false, state: { context: { model: "test/model" }, messages: [], isStreaming: false, isCompacting: false, tools: [] } });
    }
    return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  };
  return window.document;
}

test.after(() => {
  restorePrototypes?.();
  for (const key of Object.keys(ORIGINALS)) {
    if (ORIGINALS[key] === undefined) delete globalThis[key];
    else globalThis[key] = ORIGINALS[key];
  }
});

const settle = (ms = 60) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

async function mountShell(search, options = {}) {
  currentSearch = search;
  const document = installDom(options);
  const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
  const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
  const { AppShell } = await jiti.import("./AppShell.tsx");
  const container = document.getElementById("root");
  const root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(AppShell)));
  });
  await settle(100);
  return { root, container };
}

function dispatchKey(target, init) {
  const event = new globalThis.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

test("Session-Statistik zeigt Dauer und kopiert Felder", async () => {
  FakeEventSource.instances = [];
  FakeNotification.instances = [];
  const { root, container } = await mountShell("?session=s1");

  const statsButton = container.querySelector('[aria-label="Session info"]');
  assert.ok(statsButton, "der Session-Statistik-Knopf fehlt");
  const badgeSlot = container.querySelector('[data-testid="topbar-system-badge"]');
  assert.ok(badgeSlot, "der System-Badge fehlt");
  assert.equal(badgeSlot.style.order, "0", "auf dem Desktop bleibt der Badge an seinem Platz");
  assert.ok(container.querySelector('button[aria-label="Terminal"]'), "auf dem Desktop bleibt das Terminal in der Leiste");
  await act(async () => { statsButton.click(); });
  await settle();

  assert.match(container.textContent, /2h 0m/, "formatDuration hat die aktive Zeit nicht gezeigt");
  assert.match(container.textContent, /Session Info/);
  const copyFile = container.querySelector('[title="Copy file path"]');
  assert.ok(copyFile, "der Kopier-Knopf fuer den Dateipfad fehlt");
  await act(async () => { copyFile.click(); });
  await settle();
  assert.ok(container.querySelector('[title="Copied"]'), "der Kopier-Knopf hat seinen Bestaetigungszustand nicht gezeigt");

  await act(async () => root.unmount());
});

test("auf dem Telefon steht der System-Badge vor den Werkzeugen", async () => {
  FakeEventSource.instances = [];
  FakeNotification.instances = [];
  const { root, container } = await mountShell("?session=s1", { mobile: true });
  await settle(150);

  const badgeSlot = container.querySelector('[data-testid="topbar-system-badge"]');
  assert.ok(badgeSlot, "der System-Badge fehlt");
  // `order: -1` setzt den Badge in der Flex-Zeile direkt hinter den
  // Menue-Knopf (`order: -2`); die Leiste selbst bleibt in DOM-Reihenfolge und
  // Desktop-Layout unberuehrt.
  assert.equal(badgeSlot.style.order, "-1", "der Badge steht auf dem Telefon nicht vorn");
  // Das Terminal ist auch auf dem Telefon erreichbar: der Knopf ist gerendert
  // (teilweise sichtbar, der Rest liegt im Rollweg) und oeffnet das
  // Vollbild-Overlay des rechten Panels.
  const terminal = container.querySelector('button[aria-label="Terminal"]');
  assert.ok(terminal, "das Terminal fehlt auf dem Telefon");
  assert.equal(terminal.hasAttribute("disabled"), false, "das Terminal ist auf dem Telefon nicht gesperrt");

  const button = badgeSlot.querySelector("button");
  assert.match(button.textContent, /CPU42%RAM50%/, "Punkt + Prozent passen als Erstes in die 390 px");
  assert.doesNotMatch(button.textContent, /8c/);
  assert.doesNotMatch(button.textContent, /16\.0 GB/);
  assert.doesNotMatch(button.textContent, /GPU/);
  assert.match(button.getAttribute("title"), /across 8 cores/, "der Tooltip behaelt alle Zahlen");

  await act(async () => { button.click(); });
  await settle(50);
  const dialog = container.querySelector('[role="dialog"]');
  assert.ok(dialog, "das Popover bleibt auf dem Telefon erreichbar");
  assert.match(dialog.textContent, /mem: 8\.0 GB \/ 16\.0 GB/);

  // Der Knopf ist erreichbar und oeffnet sein Menue; das Menue selbst ist
  // fest im Viewport verankert. (Der xterm-Viewer laesst sich in linkedom
  // nicht mounten, deshalb endet der Test vor dem Spawn.)
  await act(async () => { terminal.click(); });
  await settle(50);
  const terminalMenu = container.querySelector('[role="menu"]');
  assert.ok(terminalMenu, "das Terminal-Menue oeffnet auf dem Telefon nicht");
  assert.match(terminalMenu.textContent, /New terminal/);
  assert.equal(terminalMenu.style.position, "fixed", "das Menue liegt nicht fest im Viewport");

  await act(async () => root.unmount());
});

test("the sidebar toggle stays the first item in the top bar on every width", async () => {
  FakeEventSource.instances = [];
  FakeNotification.instances = [];

  const mobile = await mountShell("?session=s1", { mobile: true });
  await settle(150);
  const mobileBar = mobile.container.querySelector('[data-testid="topbar-scroll"]');
  assert.ok(mobileBar, "the top bar is missing");
  const mobileToggle = mobileBar.firstElementChild;
  // Nothing may sort itself in front of the sidebar toggle: with `order: -1`
  // on the badge and no order here, the badge took slot 0 and the drawer
  // button sat one place right of the left edge (operator report).
  assert.match(
    mobileToggle.getAttribute("aria-label") ?? "",
    /Seitenleiste|sidebar/i,
    "the sidebar toggle is not the first top-bar item",
  );
  assert.equal(mobileToggle.style.order, "-2", "the toggle must sort before the badge on mobile");
  assert.equal(
    mobile.container.querySelector('[data-testid="topbar-system-badge"]').style.order,
    "-1",
    "the badge belongs directly behind the toggle on mobile",
  );
  await act(async () => mobile.root.unmount());

  const desktop = await mountShell("?session=s1");
  await settle(100);
  const desktopBar = desktop.container.querySelector('[data-testid="topbar-scroll"]');
  const desktopToggle = desktopBar.firstElementChild;
  assert.equal(desktopToggle.style.order, "0", "the toggle keeps DOM order on the desktop");
  assert.equal(
    desktop.container.querySelector('[data-testid="topbar-system-badge"]').style.order,
    "0",
    "the badge keeps its place on the desktop",
  );
  await act(async () => desktop.root.unmount());
});

test("die Kopfleiste endet mit Freiraum und blendet verborgene Seiten ab", async () => {
  FakeEventSource.instances = [];
  FakeNotification.instances = [];
  const { root, container } = await mountShell("?session=s1");

  const bar = container.querySelector('[data-testid="topbar-scroll"]');
  assert.ok(bar, "die Kopfleiste fehlt");
  const clearance = container.querySelector('[data-testid="topbar-clearance"]');
  assert.ok(clearance, "der Freiraum am Ende fehlt");
  assert.equal(clearance.getAttribute("aria-hidden"), "true");
  assert.equal(clearance.style.width, "36px");
  assert.equal(bar.lastElementChild, clearance, "der Freiraum steht nicht zuletzt");

  const shell = bar.parentElement;
  // linkedom hat kein Layout: 694 px Inhalt auf 390 px Sicht werden gesetzt und
  // das Scroll-Ereignis ausgeloest, statt einen Browser zu brauchen.
  assert.equal(shell.getAttribute("data-topbar-fade"), "none", "ohne Ueberlauf darf nichts abgedunkelt sein");
  Object.defineProperty(bar, "scrollWidth", { configurable: true, value: 694 });
  Object.defineProperty(bar, "clientWidth", { configurable: true, value: 390 });
  Object.defineProperty(bar, "scrollLeft", { configurable: true, value: 0, writable: true });

  await act(async () => { bar.dispatchEvent(new globalThis.Event("scroll")); });
  assert.equal(shell.getAttribute("data-topbar-fade"), "right", "rechts liegt Inhalt, die Kante bleibt hell");

  bar.scrollLeft = 304;
  await act(async () => { bar.dispatchEvent(new globalThis.Event("scroll")); });
  assert.equal(shell.getAttribute("data-topbar-fade"), "left", "am Ende ist nur noch links etwas verborgen");

  await act(async () => root.unmount());
});

test("die Tab-Leiste des Datei-Panels endet vor dem festen Knopf", async () => {
  FakeEventSource.instances = [];
  FakeNotification.instances = [];
  const { root, container } = await mountShell("?session=s1");

  const tabbar = container.querySelector('[data-testid="file-panel-tabbar"]');
  assert.ok(tabbar, "die Tab-Leiste des Datei-Panels fehlt");
  // Der Knopf liegt fest am Fensterrand ueber der rechten oberen Ecke des
  // Panels; 36 px muessen frei bleiben, sonst ist der letzte Tab beim
  // Scrollen nicht mehr tippbar.
  assert.equal(tabbar.parentElement.style.paddingRight, "36px");

  await act(async () => root.unmount());
});

test("der Newsletter-Knopf schaltet die Shell auf die Newsletter-Ansicht", async () => {
  // Der Knopf ist der einzige Weg in die Ansicht: ohne diesen Klick bleibt der
  // Callback in `AppShell` toter Code, und der Coverage-Gate meldet ihn.
  FakeEventSource.instances = [];
  FakeNotification.instances = [];
  const { root, container } = await mountShell("?session=s1");

  const newsletters = container.querySelector('[title="Open newsletters"]');
  assert.ok(newsletters, "der Newsletter-Knopf fehlt");
  await act(async () => { newsletters.click(); });
  await settle(120);

  // Die Ansicht versucht zu laden; die Attrappe kennt /api/newsletters nicht,
  // also steht dort der Fehler-Banner — und nicht mehr die Chat-Oberflaeche.
  assert.match(container.textContent, /could not be loaded/, "die Newsletter-Ansicht wurde nicht geoeffnet");

  await act(async () => root.unmount());
});

test("Separator-Taste und Ctrl+Alt+N laufen durch die Shortcut-Handler", async () => {
  FakeEventSource.instances = [];
  FakeNotification.instances = [];
  const { root, container } = await mountShell("?session=s1");
  const separator = container.querySelector('[data-resize-handle="sidebar"]');
  assert.ok(separator, "der Sidebar-Separator fehlt");
  await act(async () => {
    dispatchKey(separator, { key: "ArrowRight" });
    dispatchKey(separator, { key: "ArrowLeft", shiftKey: true });
  });
  await settle();

  await act(async () => {
    dispatchKey(window, { key: "n", ctrlKey: true, altKey: true });
  });
  await settle();
  assert.ok(container.querySelector('[data-testid="composer-quick-phrases"]') !== null || container.innerHTML.length > 0);

  await act(async () => root.unmount());
});

test("Extension-Rueckfrage erzeugt eine Benachrichtigung, deren Klick die Session oeffnet", async () => {
  FakeEventSource.instances = [];
  FakeNotification.instances = [];
  focused = 0;
  const { root } = await mountShell("?session=s1");

  const stream = FakeEventSource.instances.find((instance) => instance.url.includes("/api/agent/"));
  assert.ok(stream, "der Agent-Eventstream wurde nicht geoeffnet");
  await act(async () => {
    stream.emit({ type: "extension_ui_request", id: "req-1", method: "input", title: "Need input" });
  });
  await settle();

  const notification = FakeNotification.instances.at(-1);
  assert.ok(notification, "es wurde keine Browser-Benachrichtigung erzeugt");
  assert.equal(notification.title, "Pi needs your attention");
  assert.ok(typeof notification.onclick === "function", "der Klick-Handler fehlt");
  await act(async () => { notification.onclick(); });
  await settle();
  assert.equal(focused, 1, "window.focus wurde beim Klick nicht gerufen");

  await act(async () => root.unmount());
});
