import { NextResponse } from "next/server";
import { generateSessionTitle } from "@/lib/session-title";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";
import { requireSessionAccess } from "../../session-guard";
import { getRequestIdentity } from "@/lib/request-identity";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // Diese Route ist ein Schreibpfad *und* teuer: sie startet notfalls eine
  // RPC-Session und ruft das Modell. Beides gehoert der fremden Session, also
  // gehoert die Sperre vor `startRpcSession`, nicht in den `catch`.
  const denied = await requireSessionAccess(req, id);
  if (denied) return denied;

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const existing = getRpcSession(id);
    const identity = getRequestIdentity(req.headers);
    const { session } = existing?.isAlive()
      ? { session: existing }
      : await startRpcSession(id, filePath, undefined, {
        // Die Identitaet wandert in die Sitzung, damit die Kalender-Werkzeuge
        // das Konto benutzen, das die Sitzung oeffnet — siehe die gleiche
        // Begruendung in `app/api/agent/[id]/route.ts`.
        identity: identity ?? undefined,
        owner: identity?.username,
      });

    // globalThis keeps wrappers alive across dev hot reloads; older instances
    // may predate waitUntilReady(), but those have already completed startup.
    await session.waitUntilReady?.();
    const result = await generateSessionTitle(session.inner);

    if (!session.isAlive()) {
      return NextResponse.json(
        { error: "The session was closed while its title was being generated. Please try again." },
        { status: 409 },
      );
    }

    // omp declines to title greetings and other low-signal openers; report that
    // as a no-op instead of writing a meaningless name.
    if (!result) {
      return NextResponse.json({ title: null, skipped: true });
    }

    // The button is an explicit action like `/rename`, so it writes with source
    // "user": omp refuses an "auto" write after a manual rename, and that
    // refusal used to be ignored (HTTP 200 with the title untouched).
    const named = await session.inner.sessionManager.setSessionName(result.title, "user");
    if (!named) {
      return NextResponse.json(
        { error: "The session's title could not be written. It was renamed by hand or the session was closed." },
        { status: 409 },
      );
    }
    invalidateSessionListCache();
    return NextResponse.json({ title: result.title });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
