import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";

/**
 * The stats page with a payload that has no rows.
 *
 * `EmptyRow` only renders when a section has data but no entries in that
 * dimension; an empty overall payload takes the "no sessions" path instead.
 * The fixture therefore carries tokens and one session, and every breakdown
 * list is empty.
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
const { StatsView } = await jiti.import("./StatsView.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { createRoot } = await import("react-dom/client");

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

function payload(overrides = {}) {
  return {
    range: "24h",
    generatedAt: Date.UTC(2026, 0, 1, 2),
    syncing: false,
    totalMessages: 123,
    stats: {
      overall: AGGREGATE,
      byModel: [],
      byFolder: [],
      byAgentType: [],
      timeSeries: [],
      modelSeries: [],
      modelPerformanceSeries: [],
      costSeries: [],
    },
    tools: { byTool: [], byToolModel: [], series: [] },
    ...overrides,
  };
}

function json(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

async function mount(respond) {
  win.document.body.innerHTML = "";
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    calls.push(url);
    return respond(url);
  };
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(StatsView)));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  return {
    container,
    calls,
    async unmount() { await act(async () => { root.unmount(); }); globalThis.fetch = originalFetch; },
  };
}

test("renders an empty row in each breakdown and the empty chart", async () => {
  const { container, calls, unmount } = await mount(() => json({ success: true, data: payload() }));
  assert.deepEqual(calls, ["/api/stats?range=24h"]);
  assert.equal(container.textContent.match(/Nothing in this range\./g)?.length, 3);
  assert.match(container.textContent, /No activity in this range\./);
  // The KPI band still carries the overall numbers.
  assert.match(container.textContent, /42/);
  await unmount();
});

test("switching the range refetches with the new window", async () => {
  const { container, calls, unmount } = await mount((url) => json({
    success: true,
    data: payload({ range: url.includes("7d") ? "7d" : "24h" }),
  }));
  const sevenDays = [...container.querySelectorAll("button")].find((node) => (node.textContent ?? "").trim() === "7 days");
  assert.ok(sevenDays, "der 7-Tage-Knopf fehlt");
  await act(async () => { sevenDays.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  assert.deepEqual(calls, ["/api/stats?range=24h", "/api/stats?range=7d"]);
  assert.equal(sevenDays.getAttribute("aria-pressed"), "true");
  await unmount();
});

test("a 403 is its own state, not an empty table", async () => {
  const { container, unmount } = await mount(() => json({ error: "admin only" }, false, 403));
  assert.match(container.textContent, /administrator/i);
  assert.doesNotMatch(container.textContent, /Nothing in this range/);
  await unmount();
  assert.doesNotMatch(container.textContent, /Nothing in this range/);
});

test("a syncing first response says so and retries on demand", async () => {
  let answer = 0;
  const { container, calls, unmount } = await mount(() => {
    answer += 1;
    return json({ success: true, data: payload({ syncing: answer === 1, stats: answer === 1 ? null : payload().stats }) });
  });
  assert.match(container.textContent, /indexing|syncing|sync/i);
  const retry = [...container.querySelectorAll("button")].find((node) => /retry/i.test(node.textContent ?? ""));
  assert.ok(retry, "der Retry-Knopf fehlt");
  await act(async () => { retry.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  assert.equal(calls.length, 2);
  assert.match(container.textContent, /Nothing in this range/);
  await unmount();
});

test("a populated range renders chart bars and each breakdown row", async () => {
  const rich = payload({
    stats: {
      ...payload().stats,
      byModel: [{
        provider: "openai",
        model: "gpt-5",
        totalRequests: 10,
        failedRequests: 1,
        totalInputTokens: 1500,
        totalOutputTokens: 2500,
        totalCost: 0.4321,
        avgTokensPerSecond: 12.5,
      }],
      byFolder: [{
        folder: "/home/steimer/workspace/omp-web",
        totalRequests: 4,
        totalInputTokens: 400,
        totalOutputTokens: 800,
        totalCost: 0.1,
      }],
      timeSeries: [
        { timestamp: Date.UTC(2026, 0, 1, 0), requests: 3, errors: 0, tokens: 1200, cost: 0.12 },
        { timestamp: Date.UTC(2026, 0, 1, 1), requests: 5, errors: 1, tokens: 2400, cost: 0.24 },
      ],
    },
    tools: {
      byTool: [{
        tool: "bash",
        calls: 7,
        errors: 1,
        argsChars: 100,
        resultChars: 200,
        totalTokensShare: 900,
        outputTokensShare: 300,
        costShare: 0.07,
        unpricedRequestsShare: 0,
        lastUsed: Date.UTC(2026, 0, 1, 1, 30),
      }],
      byToolModel: [],
      series: [],
    },
  });
  const { container, unmount } = await mount(() => json({ success: true, data: rich }));
  assert.equal(container.textContent.match(/Nothing in this range\./g), null);
  assert.match(container.textContent, /gpt-5/);
  assert.match(container.textContent, /omp-web/);
  assert.match(container.textContent, /bash/);
  const chart = container.querySelector('svg[role="img"]');
  assert.ok(chart, "der Chart fehlt");
  assert.equal(chart.querySelectorAll("rect").length, 4);
  assert.match(chart.textContent, /tokens/i);
  await unmount();
});

