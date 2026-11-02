import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const { STATS_MIN_REFRESH_MS, STATS_RANGES, STATS_TTL_MS, createStatsService } = await jiti.import("./stats.ts");

/**
 * The stats service: cache, single-flight and range isolation.
 *
 * Every service here gets a fake loader, so no test opens `~/.omp/stats.db`.
 * The cache and the in-flight runs live on `globalThis` on purpose (the dev
 * server reloads modules), so each test deletes that state first.
 */

function resetState() {
  delete globalThis.__ompStatsState;
}

/** `refresh` registers its run, then starts the loader on the next microtask. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function fakeClock(start = 1_000_000) {
  let at = start;
  return {
    now: () => at,
    advance(ms) {
      at += ms;
    },
  };
}

/** The two numbers a test can follow through every layer. */
function snapshot(totalCost, totalMessages) {
  return {
    stats: { overall: { totalCost } },
    tools: { totalCalls: totalMessages },
    totalMessages,
  };
}

test("the cache TTL is one minute, the forced-refresh floor five seconds, and the ranges mirror the library", () => {
  // `getTimeRangeConfig` accepts exactly these and silently falls back to 24h
  // for anything else; the route rejects instead, so the list is asserted here.
  assert.equal(STATS_TTL_MS, 60_000);
  assert.equal(STATS_MIN_REFRESH_MS, 5_000);
  assert.deepEqual(STATS_RANGES, ["1h", "24h", "7d", "30d", "90d", "all"]);
});

test("the first get answers empty and starts exactly one sync", async () => {
  resetState();
  const clock = fakeClock();
  let loads = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const service = createStatsService({
    ttlMs: 60_000,
    now: clock.now,
    load: async () => {
      loads += 1;
      return gate;
    },
  });

  const first = service.get("24h");
  assert.equal(first.range, "24h");
  assert.equal(first.stats, null);
  assert.equal(first.tools, null);
  assert.equal(first.totalMessages, null);
  assert.equal(first.syncing, true);
  assert.equal(first.error, undefined);
  assert.equal(first.generatedAt, 1_000_000);

  // A second call while the first is in flight joins it instead of starting one.
  const second = service.get("24h");
  assert.equal(second.syncing, true);

  await flush();
  assert.equal(loads, 1);

  clock.advance(250);
  release(snapshot(1.5, 42));
  await service.refresh("24h"); // the in-flight promise, not a second load
  assert.equal(loads, 1);

  const served = service.get("24h");
  assert.equal(served.syncing, false);
  assert.equal(served.totalMessages, 42);
  assert.equal(served.tools.totalCalls, 42);
  assert.equal(served.stats.overall.totalCost, 1.5);
  // The clock at completion, not the time of the request that triggered it.
  assert.equal(served.generatedAt, 1_000_250);
  assert.equal(served.error, undefined);
});

test("an expired TTL starts a new sync, one that has not expired does not", async () => {
  resetState();
  const clock = fakeClock();
  let loads = 0;
  const service = createStatsService({
    ttlMs: 1_000,
    now: clock.now,
    load: async () => {
      loads += 1;
      return snapshot(1.5, 42 + loads);
    },
  });

  service.get("24h");
  await service.refresh("24h");
  assert.equal(loads, 1);
  assert.equal(service.get("24h").totalMessages, 43);

  clock.advance(999);
  const fresh = service.get("24h");
  assert.equal(fresh.syncing, false);
  assert.equal(fresh.totalMessages, 43);
  assert.equal(loads, 1);

  clock.advance(1); // exactly the TTL is expired
  const stale = service.get("24h");
  assert.equal(stale.syncing, true);
  assert.equal(stale.totalMessages, 43); // the old numbers until the read lands

  await flush();
  assert.equal(loads, 2);

  await service.refresh("24h");
  assert.equal(service.get("24h").totalMessages, 44);
  assert.equal(service.get("24h").generatedAt, 1_001_000);
});

test("a failed sync keeps the last good payload and records the error", async () => {
  resetState();
  const clock = fakeClock();
  let attempts = 0;
  const service = createStatsService({
    ttlMs: 1_000,
    now: clock.now,
    load: async () => {
      attempts += 1;
      if (attempts === 1) return snapshot(1.5, 42);
      throw new Error("stats.db is locked");
    },
  });

  service.get("24h");
  await service.refresh("24h");
  assert.equal(service.get("24h").totalMessages, 42);

  clock.advance(1_000);
  const stale = service.get("24h");
  assert.equal(stale.syncing, true);
  assert.equal(stale.totalMessages, 42);
  await service.refresh("24h");

  const failed = service.get("24h");
  assert.equal(failed.totalMessages, 42); // the last good numbers, not an empty dashboard
  assert.equal(failed.stats.overall.totalCost, 1.5);
  assert.equal(failed.error, "stats.db is locked");
  assert.equal(failed.syncing, false);
  assert.equal(attempts, 2);

  // The failure is cached for the TTL too, so a poll cannot retry in a tight loop.
  clock.advance(999);
  assert.equal(service.get("24h").error, "stats.db is locked");
  assert.equal(attempts, 2);
});

test("a range change never serves another range's numbers", async () => {
  resetState();
  const clock = fakeClock();
  const loads = [];
  const service = createStatsService({
    ttlMs: 60_000,
    now: clock.now,
    load: async (range) => {
      loads.push(range);
      if (range === "7d") return snapshot(7.5, 420);
      if (range === "24h") return snapshot(1.5, 42);
      return snapshot(0.5, 7);
    },
  });

  const seven = service.get("7d");
  assert.equal(seven.range, "7d");
  assert.equal(seven.totalMessages, null);
  assert.equal(seven.syncing, true);
  await service.refresh("7d");
  assert.equal(service.get("7d").totalMessages, 420);

  const day = service.get("24h");
  assert.equal(day.range, "24h");
  assert.equal(day.totalMessages, null); // 420 belongs to 7d, not here
  assert.equal(day.syncing, true);
  await service.refresh("24h");
  assert.equal(service.get("24h").totalMessages, 42);

  // The range string is normalized, so this is the cached 7d entry, not a new load.
  const again = service.get(" 7D ");
  assert.equal(again.range, "7d");
  assert.equal(again.totalMessages, 420);
  assert.deepEqual(loads, ["7d", "24h"]);

  assert.equal(service.get("all").syncing, true);
  await service.refresh("all");
  assert.equal(service.get("all").totalMessages, 7);
  assert.equal(service.get("24h").totalMessages, 42);
  assert.equal(service.get("7d").totalMessages, 420);
  assert.deepEqual(loads, ["7d", "24h", "all"]);
});

test("a forced refresh starts at most once per STATS_MIN_REFRESH_MS", async () => {
  resetState();
  const clock = fakeClock();
  let loads = 0;
  const service = createStatsService({
    ttlMs: 60_000,
    now: clock.now,
    load: async () => {
      loads += 1;
      return snapshot(1.5, 42);
    },
  });

  service.get("24h");
  await service.refresh("24h");
  assert.equal(loads, 1);

  clock.advance(4_999);
  await service.refresh("24h");
  await service.refresh("24h");
  assert.equal(loads, 1); // inside the floor: no second walk
  assert.equal(service.get("24h").totalMessages, 42);
  assert.equal(service.get("24h").syncing, false);

  clock.advance(1); // exactly the floor
  await service.refresh("24h");
  assert.equal(loads, 2);
});

test("a synchronously throwing loader leaves no settled run behind, so refresh retries", async () => {
  resetState();
  const clock = fakeClock();
  let attempts = 0;
  const service = createStatsService({
    ttlMs: 60_000,
    now: clock.now,
    load: () => {
      attempts += 1;
      throw new Error("stats.db is unreadable");
    },
  });

  const started = service.get("24h");
  assert.equal(started.syncing, true);
  await service.refresh("24h"); // the throw must not escape the flight

  const failed = service.get("24h");
  assert.equal(attempts, 1);
  assert.equal(globalThis.__ompStatsState.runs.size, 0);
  assert.equal(failed.syncing, false);
  assert.equal(failed.stats, null);
  assert.equal(failed.error, "stats.db is unreadable");

  // The settled promise is not still in `runs`: a later refresh really retries.
  clock.advance(STATS_MIN_REFRESH_MS);
  await service.refresh("24h");
  assert.equal(attempts, 2);
  assert.equal(service.get("24h").error, "stats.db is unreadable");
});

test("the route asks for the admin role before it reads the stats database", () => {
  const source = readFileSync(new URL("../app/api/stats/route.ts", import.meta.url), "utf8");
  // The prose explains the admin rule and would match a naive scan; only code counts.
  const code = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .join("\n");

  const guard = code.indexOf("requireAdmin(");
  assert.ok(guard >= 0, "the payload spans every account's sessions, so the route is admin-only");
  const read = code.indexOf("statsService.");
  assert.ok(read > guard, "the guard runs before the read, not after it");
  assert.match(code, /export const dynamic = "force-dynamic"/);
  assert.match(code, /status: 400/);
});
