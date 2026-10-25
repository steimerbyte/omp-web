import { NextResponse } from "next/server";
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
 * PATCH/DELETE /api/calendar/[id] — einen Termin aendern oder loeschen.
 *
 * ### Warum `PATCH` und nicht `PUT`
 *
 * `PUT` bedeutet "ersetze diese Ressource mit diesem Inhalt". Der Client
 * schickt aber bei einer Verschiebung nur das, was sich aendert — Anfang und
 * Ende. Ein `PUT` wuerde damit die Beschreibung und den Ort loeschen, wenn
 * der Client sie nicht mitschickt. `PATCH` sagt: "aendere dies, lass den Rest
 * stehen", und das ist genau die Semantik, die ein Kalender braucht.
 *
 * ### Warum 404 und nicht 403 bei einem fremden Termin
 *
 * Die Termine liegen pro Konto in getrennten Dateien. Ein fremder Termin ist
 * in dieser Datei gar nicht vorhanden — es gibt nichts, was 403 verbergen
 * koennte. Die Route liest nur die eigene Datei, und deshalb ist 404 die
 * einzige moegliche Antwort.
 */

/**
 * Die Identitaet, oder `null` — und `null` ist hier 403.
 *
 * Dieselbe Form und dieselbe Begruendung wie in `app/api/calendar/route.ts`:
 * die Mandantengrenze gehoert an eine Stelle, und der Default waere eine
 * zweite.
 */
function requireIdentity(req: Request): WebIdentity | null {
  const identity = getRequestIdentity(req.headers);
  if (identity === null) return null;
  return isCalendarPathAllowed(identity, getCalendarPath(identity)) ? identity : null;
}

/** Der Termin mit dieser Kennung in diesem Konto, oder `null`. */
function findEvent(identity: WebIdentity, id: string) {
  const { events } = readCalendarFile(identity);
  return events.find((event) => event.id === id) ?? null;
}

/**
 * PATCH /api/calendar/[id] — einen Termin aendern.
 *
 * Das Verschieben eines Termins ist derselbe Aufruf: der Client schickt den
 * neuen `start` und `end`, und der Termin wandert. Es gibt dafuer keinen
 * zweiten Endpunkt — ein "move"-Endpunkt waere dieselbe Logik unter einem
 * zweiten Namen.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
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

  const { id } = await params;
  const existing = findEvent(identity, id);
  if (!existing) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
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

  // Der Ganztag-Flag entscheidet, wie `start` und `end` gelesen werden
  // muessen. Er kann mitgeschickt werden (dann zaehlt er), sonst gilt der
  // des bestehenden Termins.
  const allDay = raw.allDay === undefined ? existing.allDay : raw.allDay === true;

  const title = raw.title === undefined
    ? existing.title
    : typeof raw.title === "string" ? raw.title.trim().slice(0, MAX_TITLE_LENGTH) : "";
  if (!title) {
    return NextResponse.json({ error: "A calendar event needs a title" }, { status: 400 });
  }

  const start = raw.start === undefined ? existing.start : typeof raw.start === "string" ? raw.start.trim() : "";
  const end = raw.end === undefined ? existing.end : typeof raw.end === "string" ? raw.end.trim() : "";
  const startValid = allDay ? isCalendarDate(start) : isCalendarDateTime(start);
  const endValid = allDay ? isCalendarDate(end) : isCalendarDateTime(end);
  if (!startValid || !endValid) {
    return NextResponse.json(
      { error: allDay ? "start and end must be dates (YYYY-MM-DD)" : "start and end must be date-times (YYYY-MM-DDTHH:mm)" },
      { status: 400 },
    );
  }

  const description = raw.description === undefined
    ? existing.description
    : typeof raw.description === "string" ? raw.description.slice(0, MAX_TEXT_LENGTH) : undefined;
  const location = raw.location === undefined
    ? existing.location
    : typeof raw.location === "string" ? raw.location.slice(0, MAX_TEXT_LENGTH) : undefined;

  const updated = normalizeCalendarEvent({
    id: existing.id,
    title,
    start,
    end,
    allDay,
    description,
    location,
    // `createdAt` bleibt: der Zeitpunkt, an dem der Termin das erste Mal
    // existierte, aendert sich nicht, weil er bearbeitet wurde.
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  });
  if (!updated) {
    return NextResponse.json({ error: "The event could not be stored" }, { status: 400 });
  }

  const { events } = readCalendarFile(identity);
  const next = events.map((event) => (event.id === existing.id ? updated : event));
  const written = writeCalendarFile(identity, next);
  notifyCalendarChange(identity);

  return NextResponse.json({ event: written.find((event) => event.id === existing.id) ?? updated });
}

/**
 * DELETE /api/calendar/[id] — einen Termin loeschen.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireIdentity(req);
  if (identity === null) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const { id } = await params;
  const { events } = readCalendarFile(identity);
  if (!events.some((event) => event.id === id)) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }

  writeCalendarFile(identity, events.filter((event) => event.id !== id));
  notifyCalendarChange(identity);

  return NextResponse.json({ ok: true });
}
