import type { DashboardStats, ToolDashboardStats } from "@oh-my-pi/omp-stats";

/**
 * The stats dashboard's payload and the sync behind it.
 *
 * The numbers come from `~/.omp/stats.db`: the operator's database, shared by
 * every `omp` process on the host — process-global, and therefore admin-only.
 * The read is cached because a sync walks every session file, so a request
 * answers with the last payload and the walk happens in the background.
 */

export interface StatsPayload {
  range: string;
  generatedAt: number;
  stats: DashboardStats | null;
  tools: ToolDashboardStats | null;
  /** The whole database's message count, not this range's — the client uses it as an empty check. */
  totalMessages: number | null;
  syncing: boolean;
  error?: string;
}

/** One full read for one range: dashboard, tool breakdown and message count. */
export interface StatsSnapshot {
  stats: DashboardStats;
  tools: ToolDashboardStats;
  totalMessages: number;
}

/** How a snapshot is read. Injectable so a test never opens the database. */
export type StatsLoader = (range: string) => Promise<StatsSnapshot>;

/** The ranges `getTimeRangeConfig` accepts; the library falls back to 24h silently, the route rejects instead. */
export const STATS_RANGES: readonly string[] = ["1h", "24h", "7d", "30d", "90d", "all"];

/** Same default as `getTimeRangeConfig`; anything else resolves here too. */
const DEFAULT_RANGE = "24h";

/** One refresh per minute: a sync walks every session file, and the numbers do not move faster. */
export const STATS_TTL_MS = 60_000;

/** A forced refresh may start at most this often; each walk reads every session file. */
export const STATS_MIN_REFRESH_MS = 5_000;

interface StatsEntry {
  snapshot: StatsSnapshot | null;
  /** When the served numbers were read; `null` before the first read. */
  syncedAt: number | null;
  /** When the last attempt finished, failed or not — this paces retries, not `syncedAt`. */
  checkedAt: number;
  error?: string;
}

interface StatsState {
  cache: Map<string, StatsEntry>;
  runs: Map<string, Promise<void>>;
}

declare global {
  // `globalThis`, not module scope: the dev server reloads this module on every
  // change, and both the cache and the in-flight syncs must survive that.
  var __ompStatsState: StatsState | undefined;
}

function getState(): StatsState {
  if (!globalThis.__ompStatsState) globalThis.__ompStatsState = { cache: new Map(), runs: new Map() };
  return globalThis.__ompStatsState;
}

function normalizeRange(range: string | null | undefined): string {
  const normalized = range?.trim().toLowerCase() ?? "";
  return STATS_RANGES.includes(normalized) ? normalized : DEFAULT_RANGE;
}

export interface StatsServiceOptions {
  load?: StatsLoader;
  ttlMs?: number;
  now?: () => number;
}

export interface StatsService {
  /** The cached payload for this range, or the empty one; never awaits IO. */
  get(range: string | null | undefined): StatsPayload;
  /** Start the single-flight read for this range; resolves once it settled. */
  refresh(range: string | null | undefined): Promise<void>;
}

export function createStatsService(options: StatsServiceOptions = {}): StatsService {
  const load = options.load ?? loadStatsFromDb;
  const ttlMs = options.ttlMs ?? STATS_TTL_MS;
  const now = options.now ?? Date.now;

  function refresh(range: string | null | undefined): Promise<void> {
    const key = normalizeRange(range);
    const state = getState();
    const running = state.runs.get(key);
    if (running) return running;

    // A forced refresh starts a sync unless the cache is younger than
    // `STATS_MIN_REFRESH_MS`; the TTL only decides whether an unforced read needs one.
    const entry = state.cache.get(key);
    const since = entry === undefined ? Number.POSITIVE_INFINITY : now() - entry.checkedAt;
    const fresh = since < ttlMs;
    if (fresh && since < STATS_MIN_REFRESH_MS) return Promise.resolve();

    // Registered before the loader can settle: a synchronously throwing loader
    // would otherwise clear `runs` before this line stores its settled promise.
    const run = Promise.resolve()
      .then(() => load(key))
      .then((snapshot) => {
        const at = now();
        state.cache.set(key, { snapshot, syncedAt: at, checkedAt: at });
      })
      .catch((error: unknown) => {
        // A failed sync is an answer: keep the last good numbers and say so.
        const previous = state.cache.get(key);
        state.cache.set(key, {
          snapshot: previous?.snapshot ?? null,
          syncedAt: previous?.syncedAt ?? null,
          checkedAt: now(),
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        state.runs.delete(key);
      });
    state.runs.set(key, run);
    return run;
  }

  function get(range: string | null | undefined): StatsPayload {
    const key = normalizeRange(range);
    const state = getState();
    const at = now();
    const entry = state.cache.get(key);
    const stale = entry === undefined || at - entry.checkedAt >= ttlMs;
    if (stale) void refresh(key);

    return {
      range: key,
      generatedAt: entry?.syncedAt ?? at,
      stats: entry?.snapshot?.stats ?? null,
      tools: entry?.snapshot?.tools ?? null,
      totalMessages: entry?.snapshot?.totalMessages ?? null,
      syncing: stale || state.runs.has(key),
      ...(entry?.error === undefined ? {} : { error: entry.error }),
    };
  }

  return { get, refresh };
}

/**
 * Read the real database. Only `refresh` calls this, and only on a missing or
 * expired cache (or an explicit `?refresh=1`), so the walk stays off the request.
 */
async function loadStatsFromDb(range: string): Promise<StatsSnapshot> {
  // A static import would open the SQLite handle — and its sync workers — for
  // every module importing this file, tests included, so the import stays lazy.
  // `closeDb` is never called: the handle is shared and long-lived.
  const stats = await import("@oh-my-pi/omp-stats");
  await stats.syncAllSessions();
  await stats.refreshRollups();
  const [dashboard, tools, totalMessages] = await Promise.all([
    stats.getDashboardStats(range),
    stats.getToolDashboardStats(range),
    stats.getTotalMessageCount(),
  ]);
  return { stats: dashboard, tools, totalMessages };
}

export const statsService = createStatsService();
