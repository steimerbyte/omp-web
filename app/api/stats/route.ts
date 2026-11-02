import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/request-identity";
import { STATS_RANGES, statsService } from "@/lib/stats";

export const dynamic = "force-dynamic";

/**
 * GET /api/stats?range=24h&refresh=1 — the data behind the CLI's `/stats`
 * dashboard.
 *
 * Admin-only: the payload aggregates every account's sessions on this host.
 * The answer is the cached payload; the sync starts in the background, so the
 * request never waits for the database.
 */
export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const requested = url.searchParams.get("range")?.trim().toLowerCase() ?? null;
  if (requested !== null && !STATS_RANGES.includes(requested)) {
    return NextResponse.json(
      { error: `Unknown range "${requested}". Allowed: ${STATS_RANGES.join(", ")}.` },
      { status: 400 },
    );
  }

  // Before the read, so the payload already reports `syncing` for this refresh.
  // The service rate-limits a forced start to one per `STATS_MIN_REFRESH_MS`,
  // so a poll cannot start a walk over every session file on every request.
  if (url.searchParams.get("refresh") === "1") void statsService.refresh(requested);
  return NextResponse.json({ success: true, data: statsService.get(requested) });
}
