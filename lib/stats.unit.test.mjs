import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * Der eine Pfad, den `lib/stats.ts` ohne injizierten Loader nimmt: die echte
 * `@oh-my-pi/omp-stats`-Datenbank. Sie liegt unter dem XDG-Datenverzeichnis
 * (`getStatsDbPath`), das hier auf ein Temp-Verzeichnis zeigt, damit der Test
 * niemals die Datenbank des Entwicklers oeffnet.
 *
 * `refreshDirsFromEnv` ist noetig, weil der Resolver seine Pfade beim
 * Modul-Laden festhaelt. Ein explizites Agent-Verzeichnis darf dabei nicht
 * gesetzt werden: `setAgentDir` schaltet den XDG-Zweig ab (gemessen).
 */

const KEYS = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"];
const previousEnv = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const previousStatsState = globalThis.__ompStatsState;
const dataRoot = mkdtempSync(join(tmpdir(), "omp-web-stats-db-"));

const utils = await import("@oh-my-pi/pi-utils");

mkdirSync(join(dataRoot, "omp"), { recursive: true });
process.env.XDG_DATA_HOME = dataRoot;
process.env.XDG_STATE_HOME = dataRoot;
process.env.XDG_CACHE_HOME = dataRoot;
utils.refreshDirsFromEnv();

test.after(() => {
  for (const key of KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  utils.__resetDirsFromEnvForTests();
  globalThis.__ompStatsState = previousStatsState;
  rmSync(dataRoot, { recursive: true, force: true });
});

test("the redirected stats database is the temp one", () => {
  assert.equal(utils.getStatsDbPath(), join(dataRoot, "omp", "stats.db"));
});

test("the default loader syncs and reads a real, empty stats database", async () => {
  const { createStatsService, STATS_RANGES } = await import("./stats.ts");
  globalThis.__ompStatsState = undefined;

  assert.ok(STATS_RANGES.includes("90d"));
  const service = createStatsService();
  await service.refresh("90d");

  const payload = service.get("90d");
  assert.equal(payload.range, "90d");
  assert.equal(payload.error, undefined);
  assert.equal(payload.syncing, false);
  assert.ok(payload.stats, "the dashboard payload is present");
  assert.ok(payload.tools, "the tool breakdown is present");
  assert.equal(payload.totalMessages, 0, "a fresh temp database has no messages");
  assert.equal(payload.generatedAt > 0, true);
});
