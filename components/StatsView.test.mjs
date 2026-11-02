import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { mock } from "bun:test";
import { parseHTML } from "linkedom";
import { captureLinkedomPrototypes } from "../lib/test-linkedom.mjs";

/**
 * Die Statistik-Seite, an ihrem gerenderten DOM gemessen.
 *
 * Der Test hält drei Verträge fest, die man an einer Komponente nicht ablesen
 * kann: dass die Zahlen aus `/api/stats` formatiert ankommen, dass 403 und
 * "keine Sitzungen" zwei verschiedene Sätze zeigen, und dass der Knopf in der
 * Seitenleiste wirklich *über* Einstellungen steht und einem Tenant nicht
 * angeboten wird.
 *
 * Der Aufbau ist derselbe wie in `AppShell.projects-view.test.mjs`: linkedom
 * plus die Geometrie-Stubs, die `react-resizable-panels` braucht; `fetch`
 * beantwortet die Routen, die die Seitenleiste beim Mounten fragt.
 */

// `next/navigation` gibt es nur im App Router. Der Suchstring ist Zustand pro
// Mount und steht deshalb in einer Modulvariablen, die `mountShell` setzt.
let currentSearch = "";
mock.module("next/navigation", () => ({
  useRouter: () => ({ replace() {}, push() {}, back() {}, prefetch() {} }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => "/",
  useParams: () => ({}),
}));

const SERIES = [
  { timestamp: Date.UTC(2026, 0, 1, 0), requests: 4, errors: 1, tokens: 1000, cost: 0.02 },
  { timestamp: Date.UTC(2026, 0, 1, 1), requests: 6, errors: 0, tokens: 3000, cost: 0.05 },
];

const AGGREGATE = {
  totalRequests: 42,
  successfulRequests: 40,
  failedRequests: 2,
  errorRate: 0.125,
  totalInputTokens: 1_234_567,
  totalOutputTokens: 345_678,
  totalCacheReadTokens: 100_000,
  totalCacheWriteTokens: 10_000,
  cacheRate: 0.5,
  cacheSavings: 0.1,
  totalCost: 12.3456,
  unpricedRequests: 0,
  totalPremiumRequests: 0,
  avgDuration: 1500,
  avgTtft: 800,
  avgTokensPerSecond: 34.56,
  firstTimestamp: Date.UTC(2026, 0, 1, 0),
  lastTimestamp: Date.UTC(2026, 0, 1, 2),
};

function statsPayload(overrides = {}) {
  return {
    range: "24h",
    generatedAt: Date.UTC(2026, 0, 1, 2),
    syncing: false,
    totalMessages: 123,
    stats: {
      overall: AGGREGATE,
      byModel: [{ ...AGGREGATE, model: "claude-sonnet-4", provider: "anthropic" }],
      byFolder: [{ ...AGGREGATE, folder: "/home/alice/workspace/demo" }],
      byAgentType: [],
      timeSeries: SERIES,
      modelSeries: [],
      modelPerformanceSeries: [],
      costSeries: [],
    },
    tools: {
      byTool: [
        {
          tool: "read",
          calls: 17,
          errors: 1,
          argsChars: 100,
          resultChars: 900,
          totalTokensShare: 2500,
          outputTokensShare: 300,
          costShare: 0.5,
          unpricedRequestsShare: 0,
          lastUsed: Date.UTC(2026, 0, 1, 1),
        },
      ],
      byToolModel: [],
      series: [],
    },
    ...overrides,
  };
}

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

/** One snapshot per file: `installDom` runs per test, and the prototype state
 *  this file must put back is the one from before its first patch. linkedom
 *  shares the prototypes process-wide. */
let restorePrototypes = null;
test.after(() => restorePrototypes?.());

/**
 * Ein DOM, das `react-resizable-panels` mounten kann, und ein `fetch`, das die
 * Punkte beantwortet, die die Seitenleiste beim Start liest. `respond` ist die
 * Antwort auf `/api/stats`; alles andere ist fest.
 */
function installDom({ statsResponse = () => json({ success: true, data: statsPayload() }), isAdmin = true, languages = ["en-US"] } = {}) {
  const { window } = parseHTML(
    '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
  );
  // linkedom teilt die Prototypen prozessweit; nach dieser Datei zurueckgeben.
  restorePrototypes ??= captureLinkedomPrototypes(window);
  const g = globalThis;
  const navigator = { languages, language: languages[0], userAgent: "harness" };
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
  g.location = new URL(`http://localhost:30141/${currentSearch}`);
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
      Object.defineProperty(window.HTMLElement.prototype, property, { configurable: true, get: () => 1200 });
    }
  }
  for (const property of ["offsetHeight", "clientHeight"]) {
    if (!Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, property)) {
      Object.defineProperty(window.HTMLElement.prototype, property, { configurable: true, get: () => 800 });
    }
  }

  g.fetch = async (input) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    if (url.startsWith("/api/stats")) return statsResponse();
    if (url.startsWith("/api/whoami")) {
      return json({ user: { username: "alice", isAdmin, home: "/home/alice" } });
    }
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
    if (url.startsWith("/api/projects/sizes")) return json({ sizes: [], pending: false });
    if (url.startsWith("/api/projects")) {
      return json({ projects: [], priorities: [], home: "/home/alice" });
    }
    // The scheduled view is mounted by its deep-link test; without these two
    // shapes its hooks log a fetch failure that has nothing to do with stats.
    if (url.startsWith("/api/scheduled-tasks")) return json({ tasks: [] });
    if (url.startsWith("/api/scheduled-settings")) {
      return json({ defaultCwd: null, home: "/home/alice", folders: [] });
    }
    if (url.startsWith("/api/agent/")) {
      if (url.includes("/events")) {
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
    return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  };

  return window.document;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function render(componentPath, componentName, options) {
  const document = installDom(options);
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
  const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
  const component = await jiti.import(componentPath);
  const container = document.getElementById("root");
  const root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(component[componentName])));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  return { root, container };
}

async function mountStats(options) {
  return render("./StatsView.tsx", "StatsView", options);
}

async function mountShell(search, options) {
  currentSearch = search;
  return render("./AppShell.tsx", "AppShell", options);
}

test("formats the KPI strip, the chart and a model row from the payload", async () => {
  const { root, container } = await mountStats();
  const text = container.textContent;

  // Cost, percent and compact token counts — the three formatters that feed
  // every other cell in the tables.
  assert.ok(text.includes("$12.35"), `the total cost was not formatted: ${text.slice(0, 400)}`);
  assert.ok(text.includes("12.5%"), "the error rate was not formatted as a percentage");
  assert.ok(text.includes("50.0%"), "the cache rate was not formatted as a percentage");
  assert.ok(text.includes("1.2M"), "the input token count was not compacted");
  assert.ok(text.includes("1.50 s"), "the average latency was not formatted as seconds");
  assert.ok(text.includes("800 ms"), "the TTFT was not formatted as milliseconds");
  assert.ok(text.includes("34.6"), "the throughput was not formatted with one decimal");

  // The model table, with its provider, is really there.
  assert.ok(text.includes("claude-sonnet-4"));
  assert.ok(text.includes("anthropic"));
  assert.ok(text.includes("read"), "the tools table did not render its row");
  assert.ok(text.includes("Models") && text.includes("Projects") && text.includes("Tools"));

  const chart = container.querySelector('svg[role="img"]');
  assert.ok(chart, "the time-series chart is not rendered as an image");
  assert.match(chart.getAttribute("aria-label"), /Token/i);
  assert.ok(chart.querySelector("title"), "the chart has no accessible title");
  assert.equal(container.querySelectorAll("svg[role='img'] rect").length, SERIES.length * 2);

  await act(async () => root.unmount());
});

test("formats the Requests KPI with the page locale, like the table cells", async () => {
  const payload = statsPayload();
  const withRequests = {
    ...payload,
    stats: {
      ...payload.stats,
      overall: { ...payload.stats.overall, totalRequests: 4_200 },
      byModel: payload.stats.byModel.map((row) => ({ ...row, totalRequests: 4_200 })),
      byFolder: payload.stats.byFolder.map((row) => ({ ...row, totalRequests: 4_200 })),
    },
  };
  const { root, container } = await mountStats({
    languages: ["de-DE", "en-US"],
    statsResponse: () => json({ success: true, data: withRequests }),
  });
  const text = container.textContent;

  // German groups thousands with a dot. The KPI used to call `toLocaleString()`
  // with no locale, so on that page the strip said "4,200" beside cells that
  // said "4.200".
  const grouped = text.match(/4\.200/g) ?? [];
  assert.ok(grouped.length >= 2, `the KPI and the cells disagree about the locale: ${text.slice(0, 300)}`);
  assert.ok(!text.includes("4,200"), "the Requests KPI ignored the page locale");

  await act(async () => root.unmount());
});

test("a 403 says admins only, not empty", async () => {
  const { root, container } = await mountStats({
    statsResponse: () => json({ error: "forbidden" }, 403),
  });
  const text = container.textContent;

  assert.ok(container.querySelector('[data-state="forbidden"]'), "no distinct 403 state");
  assert.ok(text.includes("Admins only"));
  assert.ok(!text.includes("No sessions yet"));
  assert.ok(!container.querySelector('svg[role="img"]'), "the chart rendered without data");

  await act(async () => root.unmount());
});

test("a database without sessions says so instead of showing zeroes", async () => {
  const { root, container } = await mountStats({
    statsResponse: () => json({ success: true, data: statsPayload({ stats: null, tools: null, totalMessages: 0 }) }),
  });
  const text = container.textContent;

  assert.ok(container.querySelector('[data-state="empty"]'), "no distinct empty state");
  assert.ok(text.includes("No sessions yet"));
  assert.ok(!text.includes("Admins only"));
  assert.ok(!text.includes("$12.35"), "the empty state showed numbers anyway");

  await act(async () => root.unmount());
});

test("the stats entry stands one row above settings and opens ?view=stats", async () => {
  const { root, container } = await mountShell("?view=stats", { isAdmin: true });

  assert.ok(container.querySelector("[data-stats-view]"), "?view=stats did not render the stats page");
  assert.equal(container.querySelector("textarea"), null, "the chat was mounted over the stats page");

  const buttons = [...container.querySelectorAll("button")];
  const statsButton = container.querySelector('[aria-label="Stats"]');
  const settingsButton = container.querySelector('button[title="Settings"]');
  assert.ok(statsButton, "the sidebar has no stats button for an admin");
  assert.ok(settingsButton, "the settings button is gone");
  assert.ok(
    buttons.indexOf(statsButton) < buttons.indexOf(settingsButton),
    "the stats button is not above settings in the sidebar stack",
  );

  // The URL is the reload contract, as it is for the other views.
  assert.match(globalThis.location.search, /[?&]view=stats/);

  await act(async () => root.unmount());
});

test("?view=scheduled survives the sidebar's automatic cwd adoption", async () => {
  // The regression: `skipInitialProjectSelection` listed projects, calendar,
  // skills and (after this slice) stats, but not scheduled. The sidebar then
  // adopted the first recent project, and that adoption is "go to the work" —
  // it switched the view to chat and the URL dropped `view=scheduled`.
  const { root, container } = await mountShell("?view=scheduled", { isAdmin: true });

  const heading = [...container.querySelectorAll("h1")].some(
    (element) => element.textContent === "Scheduled tasks",
  );
  assert.ok(heading, "the scheduled view lost to the automatic cwd adoption");
  assert.equal(container.querySelector("textarea"), null, "the chat was mounted over the scheduled view");
  assert.match(globalThis.location.search, /[?&]view=scheduled/);

  await act(async () => root.unmount());
});

test("a tenant gets no stats button, and the deep link says admins only", async () => {
  const { root, container } = await mountShell("?view=stats", {
    isAdmin: false,
    statsResponse: () => json({ error: "forbidden" }, 403),
  });

  assert.equal(container.querySelector('[aria-label="Stats"]'), null, "a tenant was offered the stats page");
  assert.ok(container.querySelector('button[title="Settings"]'), "the settings button disappeared too");
  assert.ok(container.querySelector('[data-state="forbidden"]'));

  await act(async () => root.unmount());
});
