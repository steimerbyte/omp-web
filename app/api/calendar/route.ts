import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import {
  getCalendarPath,
  isCalendarPathAllowed,
  normalizeCalendarEvent,
  notifyCalendarChange,
  readCalendarFile,
  writeCalendarFile,
} from "@/lib/calendar-store";
import { MAX_TITLE_LENGTH, MAX_TEXT_LENGTH, isCalendarDate, isCalendarDateTime } from "@/lib/calendar";
import { getRequestIdentity, type WebIdentity } from "@/lib/request-identity";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/**
 * GET/POST /api/calendar — die Termine des angemeldeten Kontos.
 *
 * Bewusst nach dem Muster von `app/api/quick-phrases/route.ts`: genau eine
 * Liste, ein Konto pro Datei, und ein Speicher, in den ein Client beliebig viel
 * und beliebig wohin schreiben kann, waere eine neue Mandantengrenze statt
 * einer geloesten.
 */

/**
 * Die Identitaet, oder `null` — und `null` ist hier 403.
 *
 * Bewusst als eigene Funktion und nicht als Default-Parameter: ein
 * `resolveTenantAgentDir(identity = ...)`-Default waere die Mandantengrenze an
 * einer Stelle, die man beim Aufruf uebersieht. `null` heisst "niemand
 * angemeldet", und das einzige Ergebnis, das daraus folgen darf, ist Ablehnung.
 *
 * Zusätzlich wird der *abgeleitete* Pfad gegen die Konto-Home geprueft, bevor
 * irgendein Verzeichnis entsteht (`app/api/default-cwd/route.ts` macht das
 * genauso). Ein Pfad, der erst erzeugt und dann geprueft wird, hinterlaesst
 * bei jeder verweigerten Anfrage eine Datei in fremder Home.
 */
function requireIdentity(req: Request): WebIdentity | null {
  const identity = getRequestIdentity(req.headers);
  if (identity === null) return null;
  return isCalendarPathAllowed(identity, getCalendarPath(identity)) ? identity : null;
}

/**
 * GET /api/calendar — alle Termine des Kontos.
 *
 * Der Filter `?from=` und `?to=` ist eine Bequemlichkeit fuer die Oberflaeche,
 * die ein Monat laden will, ohne den ganzen Bestand zu uebertragen. Er filtert
 * **nach** dem Laden und **vor** dem Antworten, damit die Datei die einzige
 * Wahrheit bleibt: ein zweiter Speicher mit einer Teilmenge waere eine
 * Kopie, die auseinanderlaufen kann.
 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireIdentity(req);
  if (identity === null) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const { exists, events } = readCalendarFile(identity);

  const url = new URL(req.url);
  const from = url.searchParams.get("from")?.trim() || null;
  const to = url.searchParams.get("to")?.trim() || null;

  const filtered = from || to
    ? events.filter((event) => {
        // Ein Ganztagestermin endet am *letzten* Tag (einschliesslich), ein
        // Termin mit Uhrzeit am Endzeitpunkt. Fuer den Filter reicht der
        // Vergleich der Datumsanteile: ein Filter, der die Uhrzeit ignoriert,
        // liefert einen Tag zu viel statt zu wenig — das ist die harmlosere
        // Richtung, weil ein extra Termin im Kalender sichtbar ist und ein
        // fehlender nicht.
        const eventStart = event.start.slice(0, 10);
        const eventEnd = event.end.slice(0, 10);
        if (from && eventEnd < from) return false;
        if (to && eventStart > to) return false;
        return true;
      })
    : events;

  return NextResponse.json({ events: filtered, exists });
}

/**
 * POST /api/calendar — einen Termin anlegen.
 *
 * Der Client schickt `title`, `start`, `end` und `allDay`; optional `description`
 * und `location`. Die Kennung und die Zeitstempel vergibt der Server — ein
 * Client, der seine eigene Kennung waehlt, koennte einen fremden Termin
 * ueberschreiben, und das ist genau der Grund, warum die Kennung hier nicht
 * aus dem Request kommt.
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireIdentity(req);
  if (identity === null) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }

  const raw = body as Record<string, unknown>;
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, MAX_TITLE_LENGTH) : "";
  if (!title) {
    return NextResponse.json({ error: "A calendar event needs a title" }, { status: 400 });
  }

  const allDay = raw.allDay === true;
  const start = typeof raw.start === "string" ? raw.start.trim() : "";
  const end = typeof raw.end === "string" ? raw.end.trim() : "";
  const startValid = allDay ? isCalendarDate(start) : isCalendarDateTime(start);
  const endValid = allDay ? isCalendarDate(end) : isCalendarDateTime(end);
  if (!startValid || !endValid) {
    return NextResponse.json(
      { error: allDay ? "start and end must be dates (YYYY-MM-DD)" : "start and end must be date-times (YYYY-MM-DDTHH:mm)" },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  const created = normalizeCalendarEvent({
    id: randomUUID(),
    title,
    start,
    end,
    allDay,
    description: typeof raw.description === "string" ? raw.description.slice(0, MAX_TEXT_LENGTH) : undefined,
    location: typeof raw.location === "string" ? raw.location.slice(0, MAX_TEXT_LENGTH) : undefined,
    createdAt: now,
    updatedAt: now,
  });
  if (!created) {
    return NextResponse.json({ error: "The event could not be stored" }, { status: 400 });
  }

  const existing = readCalendarFile(identity);
  const events = writeCalendarFile(identity, [...existing.events, created]);
  notifyCalendarChange(identity);

  // Das Geschriebene wird zurueckgegeben, damit der Client den *validierten*
  // Termin sieht und nicht seinen eigenen, noch ungeprueften.
  return NextResponse.json({ event: events.find((e) => e.id === created.id) ?? created }, { status: 201 });
}
