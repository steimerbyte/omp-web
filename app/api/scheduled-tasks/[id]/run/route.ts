import { NextResponse } from "next/server";
import { runTaskNow } from "@/lib/scheduler";
import { getRequestIdentity, requireIdentity, type WebIdentity } from "@/lib/request-identity";
import { isApiRequestAllowed } from "@/lib/request-security";
import { scheduledTaskErrorResponse } from "@/lib/scheduled-tasks-http";
import {
  getScheduledTasksPath,
  getTask,
  isScheduledTasksPathAllowed,
} from "@/lib/scheduled-tasks-store";

export const dynamic = "force-dynamic";

/**
 * POST /api/scheduled-tasks/[id]/run — eine Aufgabe sofort starten.
 *
 * ### Warum auch eine deaktivierte Aufgabe laufen darf
 *
 * `enabled` ist die Aussage "der Zeitplan soll sie starten", nicht "sie darf
 * ueberhaupt nicht laufen". Wer deaktiviert und dann "Jetzt ausfuehren"
 * drueckt, hat den Lauf ausdruecklich bestellt; ihn mit 409 abzuweisen hiesse,
 * den ausdruecklichen Befehl des Nutzers gegen seine eigene fruehere
 * Einstellung auszuspielen. Der Takt des Zeitplans bleibt davon unberuehrt —
 * `runTaskNow` fasst `claimRun` nicht an.
 *
 * ### Warum 404 und nicht 403 bei einer fremden Aufgabe
 *
 * Wie in `[id]/route.ts`: die Aufgaben liegen pro Konto in getrennten Dateien,
 * eine fremde Aufgabe existiert in dieser Datei nicht. Ein 403 wuerde
 * verraten, dass es sie anderswo gibt.
 *
 * ### Guard-Reihenfolge
 *
 * Erst der Ursprung, dann die Identitaet, dann die Existenz — dieselbe
 * Reihenfolge wie beim Nachbarn, damit ein Aufruf ohne Konto nicht erfaehrt,
 * ob eine Kennung existiert.
 */

function identityFor(req: Request): WebIdentity | null {
  const identity = getRequestIdentity(req.headers);
  if (identity === null) return null;
  return isScheduledTasksPathAllowed(identity, getScheduledTasksPath(identity)) ? identity : null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
  /**
   * Der Session-Start, im Betrieb der echte.
   *
   * Next uebergibt ihn nie — der Parameter existiert fuer den Test, der
   * pruefen muss, *dass* der Handstart denselben Weg nimmt, ohne dafuer eine
   * echte Session zu oeffnen. Ein `mock.module` waere hier falsch: es ist
   * prozessweit und laesst sich nicht zuruecknehmen, also vergiftet es
   * Testdateien, die den Start spaeter selbst brauchen.
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
  const task = getTask(identity, id);
  if (task === null) {
    return NextResponse.json({ error: "Scheduled task not found" }, { status: 404 });
  }

  try {
    const { sessionId } = await runTaskNow(identity, task, starter);
    return NextResponse.json({ sessionId });
  } catch (error) {
    // Der Start ist gescheitert (unbekanntes Modell, kein Arbeitsverzeichnis,
    // SDK-Fehler). `scheduledTaskErrorResponse` bildet die bekannten Faelle ab;
    // ein unbekannter wird 500, und `runTaskNow` hat ihn bereits als
    // `lastRunStatus: "error"` vermerkt.
    return scheduledTaskErrorResponse(error);
  }
}
