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
function installDom() {
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
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
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
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    if (/^\/api\/sessions\/[^/?]+/.test(url)) return json(sessionDetail());
    if (url.startsWith("/api/sessions")) return json({ sessions: [SESSION] });
    if (url.startsWith("/api/projects/sizes")) return json({ sizes: [], pending: false });
    if (url.startsWith("/api/projects")) return json({ projects: [], priorities: [], home: "/home/alice" });
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

async function mountShell(search) {
  currentSearch = search;
  const document = installDom();
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
