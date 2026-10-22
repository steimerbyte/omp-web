import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { requireProjectsIdentity } from "@/lib/projects-guards";
import { readProjectSizes, startProjectSizeMeasurement } from "@/lib/projects-sizes";

export const dynamic = "force-dynamic";

/**
 * GET /api/projects/sizes — the cheap polling endpoint for the folder sizes.
 *
 * ### Why a second endpoint and not a query on `GET /api/projects`
 *
 * The poll has to be cheap, because it runs every two seconds while a
 * measurement is outstanding. `GET /api/projects` is not cheap: it calls
 * `resolveProject` per project, and that starts a **git process**. Thirty
 * polls over eighteen projects would be 540 git invocations, and the git
 * calls have nothing to do with the sizes.
 *
 * This endpoint reads one small JSON file — the registry — and answers. The
 * `sizes` it returns are the last known values; the `pending` flag says
 * whether a project still owes a measurement, and the client polls while
 * that flag is `true`.
 *
 * ### It also starts the measurement
 *
 * The endpoint triggers the background run itself (and joins a run that is
 * already in flight — `lib/projects-sizes.ts` holds one lock per registry).
 * So the measurement also starts when *only* this endpoint is called, and
 * the answer to "who triggers the poll" is not left to the caller.
 *
 * ### The guard chain is the same one the main route runs
 *
 * `isApiRequestAllowed` (host allow-list and cross-site) → `requireProjectsIdentity`
 * (the account, and the derived registry path inside that account's own
 * home). Both come from the shared modules, not from a copy: `AGENTS.md` is
 * explicit that a guard copied into a route is a guard that will be out of
 * date in one of the two copies. This endpoint **writes** — the background
 * run stores the measurements in the registry — so it is a write path and
 * gets the write path's guards.
 *
 * ### The one shadowed URL
 *
 * This is a static segment, and the catch-all `app/api/projects/[...root]`
 * is a dynamic one, so the static segment wins for the URL
 * `/api/projects/sizes`. A project whose root is exactly `/sizes` would
 * therefore be unreachable through the catch-all. That is a single-segment
 * absolute path; the dashboard creates its projects under
 * `<home>/workspace`, and the registry's roots are absolute paths, so the
 * shadowed URL is the one the folder `/sizes` would use.
 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireProjectsIdentity(req);
  if (identity === null) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  try {
    // The run is started **synchronously** and the route does not wait for
    // it: the request may not block on the measurement — that was the whole
    // point of moving it into the background. The `await` below is for the
    // visibility filter, which reads a cached allow-list and compares
    // strings; it costs milliseconds, not seconds.
    startProjectSizeMeasurement(identity);
    return NextResponse.json(await readProjectSizes(identity));
  } catch {
    return NextResponse.json({ error: "Unable to read project sizes" }, { status: 500 });
  }
}
