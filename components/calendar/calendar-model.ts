/**
 * Die Rechenlogik der Kalenderoberflaeche.
 *
 * ### Warum diese Datei neben `lib/calendar.ts` steht
 *
 * `lib/calendar.ts` beantwortet die Frage "was ist ein gueltiger Termin" —
 * und das muss der Server, das Agenten-Tool und die Oberflaeche *identisch*
 * beantworten. Diese Datei beantwortet eine andere Frage: "wo liegt dieser
 * Termin auf dem Bildschirm". Das ist eine reine Darstellung, und sie
 * gehoert deshalb nicht in die Domaene: ein Server, der Bildschirmpixel
 * kennt, ist ein Server mit zwei Aufgaben.
 *
 * Die Zeitform ist dieselbe wie in der Domaene: lokale Zeit ohne Zone. Der
 * Kalender zeigt Termine in der Zeitzone des Lesers an, und genau deshalb
 * enthaelt kein String hier eine Zone.
 */

import {
  addDays,
  dateToDayNumber,
  dayNumberToDate,
  minutesToTime,
  resolveEventColor,
  timeToMinutes,
  type CalendarEvent,
} from "@/lib/calendar";
import { CALENDAR_COLOR_VARIABLES } from "@/lib/calendar";

/** Pixel, die eine Minute im Stundenraster belegt. */
export const MINUTE_HEIGHT = 0.8;

/** Pixel, die eine Stunde im Stundenraster belegt. */
export const HOUR_HEIGHT = MINUTE_HEIGHT * 60;

/** Die Minuten eines Tages. */
export const MINUTES_PER_DAY = 24 * 60;

/**
 * Der heutige Tag als Datum ohne Zone.
 *
 * Bewusst `getFullYear()`/`getMonth()`/`getDate()` und nicht `toISOString()`:
 * `toISOString()` rechnet in UTC, und damit wuerde ein Termin am 1. Januar
 * kurz nach Mitternacht in Mitteleuropa zwei Tage in der Vergangenheit
 * liegen. Der Kalender zeigt den Tag, an dem der Leser gerade sitzt.
 */
export function todayDateString(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Der erste Tag des Monats, der `delta` Monate von `anchor` entfernt liegt.
 *
 * `addMonths` gibt es in der Domaene nicht — bewusst, weil die Rechnung ueber
 * `Date` dort die Zeitzone hineinziehen wuerde. Stattdessen wandert der
 * Monatsanfang ueber `addDays`: 32 Tage nach dem Monatsanfang liegen immer
 * im Folgemonat, ein Tag davor immer im Vormonat.
 */
export function shiftMonth(anchor: string, delta: number): string {
  const first = startOfFirst(anchor);
  return startOfFirst(addDays(first, delta > 0 ? 32 : -1));
}

/** Der erste Tag des Monats, in dem `date` liegt. */
function startOfFirst(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/**
 * Die CSS-Variable der Farbe eines Termins.
 *
 * `CALENDAR_COLOR_VARIABLES` haelt die Zuordnung zur Laufzeit aktualisierbar:
 * `applyOmpPalette` schreibt die Variablen um, und eine Kachel mit festem
 * Hex-Wert bliebe im importierten Theme die alte Farbe.
 */
export function eventColorVariable(event: CalendarEvent): string {
  return CALENDAR_COLOR_VARIABLES[resolveEventColor(event)];
}

/**
 * Die Tage, an denen ein Termin liegt — beide Enden einschliesslich.
 *
 * Bei einem Ganztagestermin ist das Ende der *letzte* Tag, bei einem Termin
 * mit Uhrzeit der Tag, an dem die Uhrzeit endet. Ein Termin, der um
 * `00:00` endet, endet aber am *Anfang* des zweiten Tages: der zweite Tag
 * gehoert also nicht mehr zum Termin. Diese eine Ausnahme ist der Grund,
 * warum es diese Funktion gibt und nicht einfach `event.start`/`event.end`.
 */
export function eventDaySpan(event: CalendarEvent): { start: string; end: string } {
  const start = event.start.slice(0, 10);
  let end = event.end.slice(0, 10);
  if (!event.allDay && event.end.slice(11) === "00:00") {
    end = addDays(end, -1);
  }
  return { start, end };
}

/** `true`, wenn der Termin den Tag beruehrt. */
export function eventSpansDay(event: CalendarEvent, day: string): boolean {
  const span = eventDaySpan(event);
  return day >= span.start && day <= span.end;
}

/**
 * Der Teil eines Termins mit Uhrzeit, der auf einem Tag liegt.
 *
 * Ein Termin ueber Mitternacht gehoert zu zwei Tagen: der erste Teil endet um
 * 24:00, der zweite beginnt um 00:00. `eventPosition` liefert nur die
 * Position *innerhalb* eines Tages — der Rest gehoert in die naechste
 * Spalte, und das ist die Aufgabe des Aufrufers.
 */
export function eventSegmentForDay(
  event: CalendarEvent,
  day: string,
): { top: number; height: number } | null {
  if (event.allDay) return null;
  const startDay = event.start.slice(0, 10);
  const endDay = event.end.slice(0, 10);
  const dayNumber = dateToDayNumber(day);
  if (dayNumber < dateToDayNumber(startDay)) return null;
  if (dayNumber > dateToDayNumber(endDay)) return null;

  const startMinute = timeToMinutes(event.start.slice(11));
  const endMinute = timeToMinutes(event.end.slice(11));
  const top = dayNumber === dateToDayNumber(startDay) ? startMinute : 0;
  const bottom = dayNumber === dateToDayNumber(endDay) ? endMinute : MINUTES_PER_DAY;
  if (bottom <= top) return null;
  return { top, height: bottom - top };
}

/**
 * Die Dauer eines Termins in Minuten.
 *
 * Ein Ganztagestermin belegt volle Tage, ein Termin mit Uhrzeit die
 * tatsaechliche Spanne — auch dann, wenn er ueber Mitternacht laeuft.
 */
export function eventDurationMinutes(event: CalendarEvent): number {
  if (event.allDay) {
    const days = dateToDayNumber(event.end.slice(0, 10)) - dateToDayNumber(event.start.slice(0, 10)) + 1;
    return days * MINUTES_PER_DAY;
  }
  const start = dateToDayNumber(event.start.slice(0, 10)) * MINUTES_PER_DAY + timeToMinutes(event.start.slice(11));
  const end = dateToDayNumber(event.end.slice(0, 10)) * MINUTES_PER_DAY + timeToMinutes(event.end.slice(11));
  return end - start;
}

/**
 * Der Termin, verschoben auf einen anderen Tag.
 *
 * Ein Ganztagestermin behaelt seine Laenge in Tagen, ein Termin mit Uhrzeit
 * seine Uhrzeit — er wandert auf den neuen Tag, nicht auf eine neue Tageszeit.
 */
export function moveEventToDay(
  event: CalendarEvent,
  targetDay: string,
): { start: string; end: string; allDay: boolean } {
  if (event.allDay) {
    const span = dateToDayNumber(event.end.slice(0, 10)) - dateToDayNumber(event.start.slice(0, 10));
    return { start: targetDay, end: addDays(targetDay, span), allDay: true };
  }
  const startTime = event.start.slice(11);
  const duration = eventDurationMinutes(event);
  const startMinute = timeToMinutes(startTime);
  return {
    start: `${targetDay}T${startTime}`,
    end: formatAbsolute(targetDay, startMinute + duration),
    allDay: false,
  };
}

/**
 * Der Termin, verschoben auf eine Stelle im Stundenraster.
 *
 * Die Dauer bleibt: ein Termin, der eine Stunde dauert, dauert nach dem
 * Verschieben immer noch eine Stunde. Ein Ganztagestermin, der auf eine
 * Uhrzeit gezogen wird, wird zu einem Termin mit Uhrzeit — eine halbe Stunde
 * ist die kuerzeste sinnvolle Dauer dafuer.
 */
export function moveEventToSlot(
  event: CalendarEvent,
  targetDay: string,
  targetMinute: number,
): { start: string; end: string; allDay: boolean } {
  if (event.allDay) {
    const start = `${targetDay}T${minutesToTime(targetMinute)}`;
    return { start, end: formatAbsolute(targetDay, targetMinute + 60), allDay: false };
  }
  const duration = eventDurationMinutes(event);
  return {
    start: `${targetDay}T${minutesToTime(targetMinute)}`,
    end: formatAbsolute(targetDay, targetMinute + duration),
    allDay: false,
  };
}

/**
 * Ein Zeitpunkt als Datum mit Uhrzeit, ohne Zone.
 *
 * Der Zeitpunkt darf ueber den Tag hinaus laufen — dann wandert das Ende in
 * den Folgetag, und genau das macht `dayNumberToDate` aus der Tageszahl.
 */
function formatAbsolute(day: string, minuteOfDay: number): string {
  const dayNumber = dateToDayNumber(day);
  const absolute = dayNumber * MINUTES_PER_DAY + minuteOfDay;
  const endDay = dayNumberToDate(Math.floor(absolute / MINUTES_PER_DAY));
  const rest = ((absolute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${endDay}T${minutesToTime(rest)}`;
}
