import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { mock } from "bun:test";
import { parseHTML } from "linkedom";

/**
 * The projects dashboard has to be *reachable*, and the only honest proof of
 * that is the rendered DOM.
 *
 * ### What this would have caught
 *
 * `showProjects` was `activeView === "projects" && !showChat`. `showChat` is
 * durably true in normal operation — the sidebar adopts a cwd by itself on
 * first load (`getRecentProjects` → `setSelectedCwd` → `onCwdChange`) — so the
 * branch never rendered, while the sidebar button, which reads `activeView`
 * directly, showed the dashboard as pressed. Button lit, area empty.
 *
 * A test asserting the *variable* would have passed throughout: `activeView`
 * really was `"projects"`. What matters is which component React mounted, so
 * every assertion below is on the DOM the shell produced.
 *
 * ### How the shell is mounted
 *
 * `AppShell` pulls in `next/navigation`, the resizable-panel library and the
 * whole chat tree. `mock.module` replaces the router hooks with a stub reading
 * a fixed query string; linkedom plus a handful of geometry stubs supplies the
 * DOM; and `fetch` answers `/api/sessions` with one session in
 * `~/workspace/demo`, so the sidebar has something real to adopt. That last
 * part is what makes these tests bite: with a session present, the automatic
 * cwd adoption *does* run, so the dashboard is rendered with `showChat` filled
 * underneath — the exact state that used to hide it.
 */

const SESSION = {
  id: "s1",
  path: "/tmp/s1.jsonl",
  cwd: "/home/alice/workspace/demo",
  projectRoot: "/home/alice/workspace/demo",
  created: "2026-01-01T00:00:00Z",
  modified: "2026-10-01T00:00:00Z",
  messageCount: 3,
  firstMessage: "hi",
  parentSession: null,
  name: null,
  transient: false,
};

// `next/navigation` is only reachable through the App Router context, which a
// unit test has no way to mount. The search string is per-render state, so the
// stub reads it from a mutable module-level variable instead of a closure.
let currentSearch = "";
mock.module("next/navigation", () => ({
  useRouter: () => ({ replace() {}, push() {}, back() {}, prefetch() {} }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => "/",
  useParams: () => ({}),
}));

/**
 * A DOM small enough to mount, large enough to satisfy the panel library.
 *
 * `DOMRect`, the observers and a non-zero `getBoundingClientRect` are the
 * three things linkedom lacks that `react-resizable-panels` needs; without
 * them the library throws "Could not find Group" before AppShell renders.
 */
function installDom(search) {
  const { window } = parseHTML(
    '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
  );
  const g = globalThis;
  // linkedom builds a fresh `navigator` on every read and ignores writes to
  // the property, so it is only reachable from behind a proxy.
  const navigator = { languages: ["en-US"], language: "en-US", userAgent: "harness" };
  const windowProxy = new Proxy(window, {
    get(target, property) {
      if (property === "navigator") return navigator;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has(target, property) {
      return property === "navigator" || Reflect.has(target, property);
    },
  });

  g.window = windowProxy;
  g.document = window.document;
  g.navigator = navigator;
  g.location = new URL(`http://localhost:30141/${search}`);
  g.history = {
    state: null,
    replaceState(_state, _unused, url) {
      g.location = new URL(String(url), "http://localhost:30141/");
    },
    pushState() {},
  };
  g.HTMLElement = window.HTMLElement;
  g.Element = window.Element;
  g.Node = window.Node;
  g.Event = window.Event;
  g.KeyboardEvent = window.KeyboardEvent;
  g.getComputedStyle = window.getComputedStyle ?? (() => ({}));
  g.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  g.cancelAnimationFrame = (id) => clearTimeout(id);
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  // `useAudio` reads the sound preference in its useState initializer, so
  // storage has to exist before the first render, not after mount.
  const storage = new Map();
  g.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => void storage.set(key, String(value)),
    removeItem: (key) => void storage.delete(key),
  };

  g.DOMRect ??= class DOMRect {
    constructor(x = 0, y = 0, width = 0, height = 0) {
      Object.assign(this, { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height });
    }
    toJSON() {
      return { ...this };
    }
  };
  const noopObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  g.ResizeObserver ??= noopObserver;
  g.IntersectionObserver ??= noopObserver;
  g.MutationObserver ??= noopObserver;
  const originalRect = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function rect() {
    const box = originalRect.call(this);
    return box && box.width > 0 ? box : new g.DOMRect(0, 0, 1200, 800);
  };
  for (const property of ["offsetWidth", "clientWidth"]) {
    if (!Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, property)) {
      Object.defineProperty(window.HTMLElement.prototype, property, { get: () => 1200 });
    }
  }
  for (const property of ["offsetHeight", "clientHeight"]) {
    if (!Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, property)) {
      Object.defineProperty(window.HTMLElement.prototype, property, { get: () => 800 });
    }
  }

  const json = (body) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  g.fetch = async (input) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    // `useAgentSession` reads `context.messages` and `context.model` off this
    // one without a guard, so a mounted chat needs a real shape. It is matched
    // before the list endpoint, whose path it starts with.
    if (/^\/api\/sessions\/[^/?]+/.test(url)) {
      return json({
        leafId: "l1",
        filePath: SESSION.path,
        totalActiveMs: 0,
        contextUsage: null,
        context: {
          messages: [],
          entryIds: [],
          model: "test/model",
          thinkingLevel: "off",
          configuredThinkingLevel: "off",
          tools: [],
        },
      });
    }
    if (url.startsWith("/api/sessions")) return json({ sessions: [SESSION] });
    // The sizes endpoint answers before the projects one: the dashboard
    // polls it for the folder sizes, and the answer has its own shape.
    if (url.startsWith("/api/projects/sizes")) {
      return json({ sizes: [], pending: false });
    }
    if (url.startsWith("/api/projects")) {
      return json({ projects: [], priorities: [], home: "/home/alice" });
    }
    // ChatWindow's own bootstrap. `useAgentSession` reads `state.context.model`
    // unconditionally once a body came back, so a chat that mounts needs a
    // real shape here rather than a 404.
    if (url.startsWith("/api/agent/")) {
      if (url.includes("/events")) {
        // An SSE stream that stays open and never speaks: no reconnect loop.
        return new Response(new ReadableStream({ start() {} }), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return json({
        running: false,
        state: {
          context: { model: "test/model" },
          messages: [],
          isStreaming: false,
          isCompacting: false,
          tools: [],
        },
      });
    }
    // Anything else answers 404 so a component guarding on `res.ok` bails out
    // instead of rendering half a payload — `/api/system-stats` reaches
    // `stats.memory.usedPercent` unconditionally once it has parsed a body.
    return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  };

  return window.document;
}

/** Mount AppShell at `search` and hand back its rendered container. */
async function mountShell(search) {
  currentSearch = search;
  const document = installDom(search);
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
  const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
  const { AppShell } = await jiti.import("./AppShell.tsx");

  const container = document.getElementById("root");
  const root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    root.render(
      React.createElement(I18nProvider, null, React.createElement(AppShell)),
    );
  });
  return { root, container };
}

/**
 * The dashboard's own chrome, present only when the dashboard is mounted.
 *
 * Matched on `aria-label`, not on the visible text: the sidebar's own filter
 * is "Search projects & sessions", so a substring test for "Search projects"
 * is true in both views and would pass for the wrong reason.
 */
function dashboardSignals(container) {
  return {
    search: container.querySelector('[aria-label="Search projects..."]') !== null,
    empty: container.querySelector('[data-projects-dashboard]') !== null,
  };
}

/** ChatWindow's composer, present only when the chat is mounted. */
function chatSignals(container) {
  const html = container.innerHTML;
  return {
    composer: html.includes('data-testid="composer-quick-phrases"'),
    textarea: html.includes("<textarea"),
  };
}

test("?view=projects renders the dashboard while a session is available", async () => {
  const { root, container } = await mountShell("?view=projects");

  assert.equal(
    dashboardSignals(container).search,
    true,
    "the dashboard did not render even though activeView was 'projects'",
  );
  assert.equal(
    chatSignals(container).composer,
    false,
    "the chat was mounted on top of the dashboard",
  );

  await act(async () => root.unmount());
});

test("?view=projects survives the sidebar's automatic cwd adoption", async () => {
  // Same load, but the URL also names a session. The sidebar restores it and
  // adopts its cwd, so `showChat` is true for real — the state that used to
  // gate the dashboard away. A second `act` flushes the fetch-driven adoption.
  const { root, container } = await mountShell("?view=projects&session=s1");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  assert.equal(dashboardSignals(container).search, true, "the dashboard lost to the restored chat");
  assert.equal(chatSignals(container).composer, false, "the chat was mounted on top of the dashboard");

  await act(async () => root.unmount());
});

test("the dashboard button keeps ?view=projects in the URL", async () => {
  const { root } = await mountShell("?view=projects");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  // The URL is the reload contract for `?view=projects`; if it is dropped the
  // next reload silently lands on the chat.
  assert.match(globalThis.location.search, /[?&]view=projects/);

  await act(async () => root.unmount());
});

test("without ?view=projects the chat still wins", async () => {
  // The negative direction: ungating the dashboard must not make it the
  // default. `?session=` restores a real session, so the chat must mount.
  const { root, container } = await mountShell("?session=s1");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  assert.equal(dashboardSignals(container).search, false, "the dashboard rendered without being asked for");
  assert.equal(chatSignals(container).textarea, true, "the chat did not render");

  await act(async () => root.unmount());
});
