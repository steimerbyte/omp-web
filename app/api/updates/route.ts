import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { requireAdmin } from "@/lib/request-identity";
import { getOmpWebUpdateStatus } from "@/lib/omp-updates";

export const dynamic = "force-dynamic";

/**
 * GET is open, POST is admin-only.
 *
 * POST is the one that would change something that belongs to the whole host,
 * so it stays behind `requireAdmin()` — a tenant must not be able to move the
 * operator onto a version the operator has not reviewed.
 *
 * GET stays open. `getOmpWebUpdateStatus()` reads the latest release of
 * *this* repository, compares it with the running version, writes nothing and
 * exposes no secret; it is the status for the update indicator, which every
 * account may see. The route answers exactly the question that is not
 * host-wide.
 *
 * This distribution is published as a GitHub release in
 * `steimerbyte/omp-web` and ships no artifact a route could install, so
 * there is nothing to install here: the update is taken from the release by
 * the operator. `POST` therefore always answers 409 with the status, whose
 * release link points at this repository.
 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  try {
    const status = await getOmpWebUpdateStatus();
    return NextResponse.json(status, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message || "Unable to check for updates" }, { status: 502 });
  }
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const denied = requireAdmin(req);
  if (denied) return denied;
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const status = await getOmpWebUpdateStatus();
    return NextResponse.json(
      {
        error: "No installable omp-web update is available",
        status,
      },
      { status: 409 },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: message || "Unable to check for updates" },
      { status: 502 },
    );
  }
}
