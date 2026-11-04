import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `GET /api/stats` aggregates every account's sessions on the host, so it is
 * admin-only; the range is validated instead of being passed through to the
 * library (which silently falls back to 24h).
 *
 * The cache is seeded, and the seed is fresh, so `refresh()` returns before the
 * loader ever opens `stats.db`: the test never reads the operator's database.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const snapshot = {
  stats: { totalMessages: 3, byDay: [] },
  tools: { tools: [] },
  totalMessages: 3,
};

globalThis.__ompStatsState = {
  cache: new Map(
    ["1h", "24h", "7d", "30d", "90d", "all"].map((range) => [
      range,
      { snapshot, syncedAt: Date.now(), checkedAt: Date.now() },
    ]),
  ),
  runs: new Map(),
};

const route = await jiti.import("./route.ts");

const ORIGIN = "http://localhost:30141";
const ADMIN = { host: "localhost:30141", "x-omp-user": "pi", "x-omp-admin": "1" };
const TENANT = { host: "localhost:30141", "x-omp-user": "alice" };

function get(query = "", headers = ADMIN) {
  return route.GET(new Request(`${ORIGIN}/api/stats${query}`, { headers }));
}

test("ein Mandant bekommt die hostweiten Zahlen nicht", async () => {
  const response = await get("", TENANT);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Administrator access is required.");
});

test("auch ohne Identitaet gibt es keinen Default-Admin", async () => {
  const response = await get("", {});
  assert.equal(response.status, 403);
});

test("der Admin liest den gecachten Payload", async () => {
  const response = await get("?range=7d");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.range, "7d");
  assert.equal(body.data.totalMessages, 3);
  assert.equal(body.data.syncing, false);
});

test("ein unbekannter Bereich ist 400 und nennt die erlaubten", async () => {
  const response = await get("?range=42y");
  assert.equal(response.status, 400);
  const { error } = await response.json();
  assert.match(error, /Unknown range "42y"/);
  assert.match(error, /24h/);
});

test("range wird getrimmt und kleingeschrieben", async () => {
  const response = await get("?range=%2030D%20");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.range, "30d");
});

test("refresh=1 gibt den Payload zurueck, ohne auf den Sync zu warten", async () => {
  const response = await get("?range=24h&refresh=1");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.range, "24h");
  assert.equal(body.success, true);
});
