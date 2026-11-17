import { NextResponse } from "next/server";
import { getRequestIdentity } from "@/lib/request-identity";
import { isApiRequestAllowed } from "@/lib/request-security";
import {
  MAX_SESSION_SEARCH_QUERY_LENGTH,
  MIN_SESSION_SEARCH_QUERY_LENGTH,
  searchSessions,
} from "@/lib/session-search";

export const dynamic = "force-dynamic";

/**
 * GET /api/sessions/search?q=… — Sessions nach dem Inhalt ihrer Transkripte
 * finden.
 *
 * Sichtbarkeit und Reihenfolge kommen aus `lib/session-search.ts`, das dafuer
 * denselben Bestand benutzt wie `GET /api/sessions`. Diese Route prueft nur,
 * wer fragt und ob die Frage lang genug ist.
 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json(
      { error: "Untrusted API request" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const identity = getRequestIdentity(req.headers);
    if (!identity) {
      return NextResponse.json(
        { error: "Unknown user" },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }

    const query = (new URL(req.url).searchParams.get("q") ?? "").trim();
    if (query.length < MIN_SESSION_SEARCH_QUERY_LENGTH || query.length > MAX_SESSION_SEARCH_QUERY_LENGTH) {
      return NextResponse.json(
        {
          error: `q must be ${MIN_SESSION_SEARCH_QUERY_LENGTH}-${MAX_SESSION_SEARCH_QUERY_LENGTH} characters`,
          field: "q",
        },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    const result = await searchSessions(identity, query);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
