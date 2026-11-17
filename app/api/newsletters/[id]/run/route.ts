import { NextResponse } from "next/server";
import { runTaskNow } from "@/lib/scheduler";
import { getRequestIdentity, requireIdentity, type WebIdentity } from "@/lib/request-identity";
import { isApiRequestAllowed } from "@/lib/request-security";
import {
  getNewsletterPath,
  isNewsletterPathAllowed,
  readNewsletterFile,
} from "@/lib/newsletter-store";
import { getTask } from "@/lib/scheduled-tasks-store";
import { scheduledTaskErrorResponse } from "@/lib/scheduled-tasks-http";

export const dynamic = "force-dynamic";

/**
 * POST /api/newsletters/[id]/run — eine Ausgabe sofort recherchieren lassen.
 *
 * Dieselbe Route wie `app/api/scheduled-tasks/[id]/run`, nur ueber den
 * Newsletter adressiert: der Nutzer kennt die Kennung seines Newsletters, nicht
 * die der Aufgabe dahinter. Gestartet wird dieselbe Aufgabe, also derselbe
 * Prompt und damit dieselbe Recherche — ein zweiter Startweg waere eine zweite
 * Wahrheit ueber das, was ein Lauf ist.
 *
 * ### Warum 404 und nicht 403 bei einem fremden Newsletter
 *
 * Die Newsletter liegen pro Konto in getrennten Dateien; ein fremder ist hier
 * gar nicht vorhanden. Ein 403 wuerde verraten, dass es ihn anderswo gibt.
 */

function identityFor(req: Request): WebIdentity | null {
  const identity = getRequestIdentity(req.headers);
  if (identity === null) return null;
  return isNewsletterPathAllowed(identity, getNewsletterPath(identity)) ? identity : null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
  /**
   * Der Session-Start, im Betrieb der echte.
   *
   * Next uebergibt ihn nie — der Parameter existiert fuer den Test, der
   * pruefen muss, *dass* der Handstart denselben Weg nimmt, ohne dafuer eine
   * echte Session zu oeffnen. Die Begruendung steht in
   * `app/api/scheduled-tasks/[id]/run/route.ts`.
   */
  starter?: Parameters<typeof runTaskNow>[2],
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const denied = requireIdentity(req);
  if (denied) return denied;
  const identity = identityFor(req);
  if (identity === null) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const { id } = await params;
  const newsletter = readNewsletterFile(identity).newsletters.find((entry) => entry.id === id);
  // Ein Newsletter ohne Aufgabe hat nichts zu starten — beides ist derselbe
  // 404, weil beides "dieser Newsletter kann gerade nicht laufen" heisst.
  const task = newsletter === undefined ? null : getTask(identity, newsletter.taskId);
  if (task === null) {
    return NextResponse.json({ error: "Newsletter not found" }, { status: 404 });
  }

  try {
    const { sessionId } = await runTaskNow(identity, task, starter);
    return NextResponse.json({ sessionId });
  } catch (error) {
    // Der Start ist gescheitert (unbekanntes Modell, kein Arbeitsverzeichnis,
    // SDK-Fehler). Der Fehler ist derselbe wie beim direkten Start der
    // Aufgabe, also dieselbe Antwort.
    return scheduledTaskErrorResponse(error);
  }
}
