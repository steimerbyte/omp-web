import { NextResponse } from "next/server";
import {
  getCalendarPath,
  isCalendarPathAllowed,
  notifyCalendarChange,
  readCalendarFile,
  writeCalendarFile,
} from "@/lib/calendar-store";
import { MAX_ICS_BYTES, parseCalendarIcs } from "@/lib/calendar-ics";
import { MAX_CALENDAR_EVENTS, type CalendarEvent } from "@/lib/calendar";
import { getRequestIdentity, type WebIdentity } from "@/lib/request-identity";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/**
 * POST /api/calendar/import — eine `.ics`-Datei in den Kalender holen.
 *
 * ### Zwei Schritte in einem Request
 *
 * Der Body kennt `apply`. Ohne `apply` (oder mit `apply: false`) wird nur
 * **gelesen**: die Route parst die Datei, sagt, was importiert wuerde, und
 * schreibt nichts. Mit `apply: true` wird geschrieben.
 *
 * Der Grund ist derselbe wie beim Anlegen eines Termins: ein Import ist
 * nicht rueckgaengig zu machen. Wer 200 Termine importiert und sich dann
 * ueber den Inhalt wundert, hat eine Datei, die er loeschen kann — aber
 * keine, in der er Termine einzeln zurueckbauen muss. Die Vorschau macht
 * den Fehler *vor* dem Schreiben sichtbar.
 *
 * ### Warum die Route und nicht der Browser die Datei liest
 *
 * Die Datei geht als Text im JSON-Body ueber die Leitung, nicht als
 * Datei-Upload. Das haelt den Body klein und pruefbar: die Grenze ist eine
 * Zahl (2 MB), keine zweite Uebertragungsform. Der Browser liest die Datei
 * mit `File.text()` und schickt den Inhalt — der Server muss die Datei
 * nirgends ablegen, bevor er sie gelesen hat.
 *
 * ### Die Duplikate
 *
 * Die UID wird im Kalender **nicht** gespeichert — das Ereignismodell hat
 * kein Feld dafuer, und ein zusaetzliches Feld waere eine zweite Wahrheit
 * ueber denselben Termin. Die UID wird deshalb nur zum Import benutzt:
 * zwei `VEVENT` mit derselben UID sind derselbe Termin, und der zweite
 * faellt weg. Gegen den *vorhandenen* Kalender hilft nur der Inhalt:
 * Titel, Beginn und Ende. Das ist eine Faelle, in der ein importierter
 * Termin wiedererkannt wird, ein selbst angelegter aber nicht — ehrlicher
 * ist, das zu sagen, als eine UID zu erfinden, die es beim Anlegen nicht
 * gibt.
 */

/**
 * Die Identitaet, oder `null` — und `null` ist hier 403.
 *
 * Bewusst als eigene Funktion und nicht als Default-Parameter: ein
 * `resolveTenantAgentDir(identity = ...)`-Default waere die Mandantengrenze
 * an einer Stelle, die man beim Aufruf uebersieht. `null` heisst "niemand
 * angemeldet", und das einzige Ergebnis, das daraus folgen darf, ist
 * Ablehnung.
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

/** Der Schluessel, unter dem ein Termin im Kalender wiedererkannt wird. */
function contentKey(event: { title: string; start: string; end: string }): string {
  return JSON.stringify([event.title, event.start, event.end]);
}

/**
 * POST /api/calendar/import — eine `.ics`-Datei lesen (und schreiben).
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
  if (typeof raw.ics !== "string") {
    return NextResponse.json({ error: "The body needs an `ics` string" }, { status: 400 });
  }
  const ics = raw.ics;

  // Die Grenze gilt fuer die Datei, nicht fuer die Anfrage: ein Body, der
  // grosser ist als 2 MB, wird abgelehnt, bevor irgendetwas gelesen wird.
  if (Buffer.byteLength(ics, "utf8") > MAX_ICS_BYTES) {
    return NextResponse.json(
      { error: `The ICS file is too large (max ${MAX_ICS_BYTES} bytes)` },
      { status: 413 },
    );
  }

  if (ics.trim().length === 0) {
    return NextResponse.json({ error: "The ICS file is empty" }, { status: 400 });
  }
  if (!/BEGIN:VCALENDAR/i.test(ics)) {
    return NextResponse.json(
      { error: "The text is not an ICS calendar (no BEGIN:VCALENDAR)" },
      { status: 400 },
    );
  }

  const apply = raw.apply === true;
  const parsed = parseCalendarIcs(ics);
  const report = parsed.report;

  // Die Duplikate. Zwei `VEVENT` mit derselben UID sind derselbe Termin —
  // der zweite faellt weg, mit allen seinen Vorkommen. Gegenueber dem
  // vorhandenen Kalender hilft nur der Inhalt: Titel, Beginn und Ende.
  const uidOwner = new Map<string, number>();
  const seenUidStart = new Set<string>();
  const existing = readCalendarFile(identity);
  const existingKeys = new Set(existing.events.map(contentKey));

  const accepted: CalendarEvent[] = [];
  for (const entry of parsed.events) {
    if (entry.uid) {
      // Derselbe Termin zweimal: gleiche UID, gleicher Beginn.
      const key = JSON.stringify([entry.uid, entry.event.start]);
      if (seenUidStart.has(key)) {
        report.skipped.push({
          reason: "duplicate",
          detail: `VEVENT mit der UID ${entry.uid} am ${entry.event.start} — derselbe Termin kam zweimal.`,
        });
        continue;
      }
      seenUidStart.add(key);
      // Derselbe Termin in einer anderen Datei: gleiche UID, anderer
      // Beginn. Von den beiden gewinnt das erste.
      const owner = uidOwner.get(entry.uid);
      if (owner !== undefined && owner !== entry.source) {
        report.skipped.push({
          reason: "duplicate",
          detail: `VEVENT mit der UID ${entry.uid} — der erste dieser UID wurde importiert.`,
        });
        continue;
      }
      if (owner === undefined) uidOwner.set(entry.uid, entry.source);
    }
    if (existingKeys.has(contentKey(entry.event))) {
      report.skipped.push({
        reason: "duplicate",
        detail: `„${entry.event.title}" am ${entry.event.start} steht schon im Kalender.`,
      });
      continue;
    }
    accepted.push(entry.event);
  }

  if (!apply) {
    // Die Vorschau: nichts schreiben, aber sagen, was geschrieben wuerde.
    report.imported = accepted.length;
    return NextResponse.json({ applied: false, events: accepted, report });
  }

  const written = writeCalendarFile(identity, [...existing.events, ...accepted]);
  notifyCalendarChange(identity);

  // Das Geschriebene wird zurueckgegeben, damit der Client den *validierten*
  // Termin sieht und nicht seinen eigenen, noch ungeprueften.
  const acceptedIds = new Set(accepted.map((event) => event.id));
  const stored = written.filter((event) => acceptedIds.has(event.id));
  report.imported = stored.length;
  if (stored.length < accepted.length) {
    report.warnings.push(
      `${accepted.length - stored.length} Termine passen nicht mehr in die Kalenderdatei — der Kalender traegt hoechstens ${MAX_CALENDAR_EVENTS} Termine.`,
    );
  }

  return NextResponse.json({ applied: true, events: stored, report });
}
