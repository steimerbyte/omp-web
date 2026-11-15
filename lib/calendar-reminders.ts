/**
 * Die Erinnerungen des Kalenders — als reine Logik, ohne DOM.
 *
 * ### Warum das nicht im Hook steht
 *
 * Die Frage "welche Erinnerung ist jetzt faellig" ist eine Rechnung ueber
 * Zeitpunkte, keine Frage an den Browser. Sie steht deshalb hier, nach
 * demselben Muster wie `lib/calendar.ts`: eine Datei, die ein Test ohne
 * Fenster ausfuehren kann. Im Hook bleibt nur die Verdrahtung — Timer,
 * Erlaubnis, `localStorage`.
 *
 * ### Die Zeitform ist die des Kalenders
 *
 * `start` ist lokale Wanduhr ohne Zone (`2026-03-14` bzw.
 * `2026-03-14T15:00`), genau wie in `lib/calendar.ts`. Deshalb wird hier
 * **nicht** `new Date("2026-03-14")` benutzt: das liest den String als UTC
 * und erinnert in Europa zwei Stunden zu spaet. Die Wanduhr wird Feld fuer
 * Feld gebaut, und die Wanduhr, die zaehlt, ist die des Browsers — der
 * Nutzer liest den Termin in seiner Zeitzone, also soll die Erinnerung auch
 * dort klingeln. Ein Zonen-Parameter waere hier eine zweite Wahrheit.
 *
 * ### Das Feld `reminders`
 *
 * Der Vertrag kommt von der Erinnerungs-Oberflaeche (siehe
 * `docs/calendar.md`, „Erinnerungen im Browser"):
 *
 * ```json
 * { "reminders": [{ "minutesBefore": 15 }, { "minutesBefore": 60 }] }
 * { "reminders": [{ "daysBefore": 1, "atTime": "18:00" }] }
 * ```
 *
 * `minutesBefore` gilt fuer Termine **mit** Uhrzeit, `daysBefore`/`atTime`
 * fuer **Ganztagstermine**. Fehlt das Feld (Altbestand), gilt der bisherige
 * Vorlauf: fuenf Minuten vorher, ganztags 08:00 am Tag selbst. Ein leeres
 * Array heisst bewusst „keine Erinnerung". Defekte Eintraege fallen einzeln
 * weg; ein Feld, das gar kein Array ist oder nur aus ungueltigen Eintraegen
 * besteht, ist keine Entscheidung gegen Erinnerungen und faellt auf den
 * Altbestand zurueck.
 */

import {
  GERMAN_WEEKDAYS_SHORT,
  addDays,
  dateToDayNumber,
  isCalendarDate,
  isCalendarDateTime,
  weekdayIndex,
  type CalendarEvent,
} from "./calendar";

/** Ein Termin, wie ihn die Route liefert: mit dem optionalen Erinnerungsfeld. */
export type ReminderEvent = CalendarEvent & { reminders?: unknown };

/**
 * Wie weit eine Erinnerung nach ihrem Zeitpunkt noch feuert.
 *
 * Ohne diese Grenze holte ein Tab, der ueber Nacht im Hintergrund lag, beim
 * Aufwachen jede verpasste Erinnerung nach — ein Schwall Benachrichtigungen
 * fuer Termine von gestern. Zehn Minuten sind lang genug fuer den ueblichen
 * Fall (der Timer feuert spaetestens eine Sekunde nach dem Zeitpunkt) und
 * kurz genug, dass eine Woche Schlaf nichts nachholt.
 */
export const REMINDER_GRACE_MS = 10 * 60_000;

/** Hoechstens so viele Erinnerungen zaehlt ein Termin. */
export const MAX_REMINDERS_PER_EVENT = 5;

/** Der laengste Vorlauf in Minuten: 14 Tage — die Reichweite des Kalenders. */
const MAX_MINUTES_BEFORE = 14 * 24 * 60;

/** Der laengste Vorlauf in Tagen eines Ganztagstermins. */
const MAX_DAYS_BEFORE = 14;

/** Der Vorlauf eines Termins ohne Erinnerungsfeld (Altbestand). */
const DEFAULT_LEAD_MINUTES = 5;

/** Die Uhrzeit des Altbestands bei einem Ganztagstermin. */
const DEFAULT_ALL_DAY_TIME = "08:00";

/** Eine faellige Erinnerung, fertig fuer die Benachrichtigung. */
export interface DueReminder {
  /**
   * Der Schluessel der Erinnerung: Termin-Kennung und Zeitpunkt.
   *
   * Stabil ueber Neuladen hinweg, weil beide Teile aus denselben Daten
   * stammen — er ist der Anker gegen doppelte Benachrichtigungen
   * (`localStorage` und `tag` der Notification-API benutzen ihn).
   */
  key: string;
  /** Der Titel des Termins — die Ueberschrift der Benachrichtigung. */
  title: string;
  /** Der Text darunter: „in 15 Minuten · 15:00" oder „Ganztägig · Di 17.11.". */
  body: string;
  /** Der Zeitpunkt, zu dem die Erinnerung faellig war (ms seit 1970). */
  atMs: number;
}

/** Eine Erinnerung nach dem Vertrag: Vorlauf in Minuten oder in Tagen. */
type ParsedReminder =
  | { kind: "minutes"; minutes: number }
  | { kind: "days"; days: number; time: string };

/** Zwei Ziffern mit fuehrender Null. */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Die lokale Wanduhr eines Kalenderstrings als Zeitstempel.
 *
 * Der String ist entweder `YYYY-MM-DD` (Mitternacht) oder `YYYY-MM-DDTHH:MM`.
 * `new Date(...)` mit Einzelargumenten baut die Wanduhr des Prozesses — genau
 * das ist hier gewollt, siehe Kopfkommentar.
 */
function wallClockMs(value: string): number {
  const datePart = value.slice(0, 10);
  const [year, month, day] = datePart.split("-").map(Number);
  const time = value.length > 10 ? value.slice(11, 16) : "00:00";
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime();
}

/** Das lokale Datum eines Zeitstempels als `YYYY-MM-DD`. */
function localDateOf(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** `true`, wenn der Wert ein Objekt ist — kein Array, kein `null`. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Ein einzelner Eintrag aus `reminders` — oder `null`, wenn er wegfaellt.
 *
 * Der zum `allDay` des Termins falsche Schluesselsatz faellt weg: eine
 * `minutesBefore`-Erinnerung an einem Ganztagstermin haette keinen Beginn,
 * von dem sie rechnen koennte, und eine `daysBefore`-Erinnerung an einem
 * Termin mit Uhrzeit waere eine zweite, ungenauere Form derselben Aussage.
 */
function parseReminder(raw: unknown, allDay: boolean): ParsedReminder | null {
  if (!isPlainObject(raw)) return null;
  const minutesBefore = raw.minutesBefore;
  const daysBefore = raw.daysBefore;
  const atTime = raw.atTime;
  if (allDay) {
    if (minutesBefore !== undefined) return null;
    if (typeof daysBefore !== "number" || !Number.isInteger(daysBefore)) return null;
    if (daysBefore < 0 || daysBefore > MAX_DAYS_BEFORE) return null;
    if (typeof atTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(atTime)) return null;
    return { kind: "days", days: daysBefore, time: atTime };
  }
  if (daysBefore !== undefined || atTime !== undefined) return null;
  if (typeof minutesBefore !== "number" || !Number.isInteger(minutesBefore)) return null;
  if (minutesBefore < 0 || minutesBefore > MAX_MINUTES_BEFORE) return null;
  return { kind: "minutes", minutes: minutesBefore };
}

/** Die Erinnerungen eines Termins, inklusive Altbestand und Grenzen. */
function remindersOf(raw: unknown, allDay: boolean): ParsedReminder[] {
  const fallback: ParsedReminder[] = allDay
    ? [{ kind: "days", days: 0, time: DEFAULT_ALL_DAY_TIME }]
    : [{ kind: "minutes", minutes: DEFAULT_LEAD_MINUTES }];
  // Ein Feld, das kein Array ist, ist keine Aussage ueber Erinnerungen.
  if (!Array.isArray(raw)) return fallback;
  // `[]` heisst bewusst „keine".
  if (raw.length === 0) return [];
  const parsed = raw
    .map((entry) => parseReminder(entry, allDay))
    .filter((entry): entry is ParsedReminder => entry !== null);
  // Ein Array aus lauter Muell war keine Entscheidung gegen Erinnerungen.
  return parsed.length === 0 ? fallback : parsed;
}

/** Der Zeitpunkt einer Erinnerung, als ms seit 1970. */
function reminderMs(reminder: ParsedReminder, event: ReminderEvent): number {
  if (reminder.kind === "minutes") {
    return wallClockMs(event.start) - reminder.minutes * 60_000;
  }
  const day = addDays(event.start.slice(0, 10), -reminder.days);
  return wallClockMs(`${day}T${reminder.time}`);
}

/**
 * Die Zeitpunkte aller Erinnerungen eines Termins, aufsteigend und ohne
 * Doppel — hoechstens `MAX_REMINDERS_PER_EVENT`.
 *
 * Bei mehr als fuenf Eintraegen zaehlen die **fuenf kleinsten Vorlaeufe**: die
 * Erinnerungen dicht am Termin sind die nuetzlichen, eine zwei Wochen alte
 * Vorwarnung am selben Tag ist keine. Sortiert wird nach Vorlaufzeit, damit
 * die Auswahl deterministisch ist — „die ersten im Array" haengt an der
 * Reihenfolge der Oberflaeche. Doppelte Eintraege zaehlen vorher einmal.
 *
 * Ein Termin, dessen Beginn kein gueltiger Kalenderstring ist, hat keine
 * Erinnerungen — lieber keine Benachrichtigung als eine zum falschen Tag.
 */
function instantsOf(event: ReminderEvent): number[] {
  if (typeof event.start !== "string") return [];
  const valid = event.allDay
    ? isCalendarDate(event.start.slice(0, 10))
    : isCalendarDateTime(event.start);
  if (!valid) return [];
  const unique = new Map<string, ParsedReminder>();
  for (const reminder of remindersOf(event.reminders, event.allDay)) {
    const id = reminder.kind === "minutes"
      ? `m${reminder.minutes}`
      : `d${reminder.days}@${reminder.time}`;
    if (!unique.has(id)) unique.set(id, reminder);
  }
  return [...unique.values()]
    // Sortiert nach Vorlauf (Minuten; ein Tag sind 1440), damit die Auswahl
    // deterministisch ist und die nahen Erinnerungen gewinnen.
    .map((reminder) => ({
      reminder,
      lead: reminder.kind === "minutes" ? reminder.minutes : reminder.days * 1440,
    }))
    .sort((a, b) => a.lead - b.lead)
    .slice(0, MAX_REMINDERS_PER_EVENT)
    .map((entry) => reminderMs(entry.reminder, event))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);
}

/**
 * Die Vorlaufzeit in deutscher Schreibweise: „in 15 Minuten", „in 1 Stunde",
 * „in 1 Tag", „jetzt".
 *
 * Ein Tag wird vor der Stunde geprueft, sonst schriebe 1440 „in 24 Stunden".
 * Volle Stunden und Tage werden benannt, alles andere bleibt Minuten — eine
 * Erinnerung 90 Minuten vorher heisst „in 90 Minuten" und nicht „in 1,5
 * Stunden".
 */
export function leadText(minutes: number): string {
  if (minutes <= 0) return "jetzt";
  if (minutes < 60) return minutes === 1 ? "in 1 Minute" : `in ${minutes} Minuten`;
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? "in 1 Tag" : `in ${days} Tagen`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "in 1 Stunde" : `in ${hours} Stunden`;
  }
  return `in ${minutes} Minuten`;
}

/**
 * Der Text einer Erinnerung.
 *
 * Termin mit Uhrzeit: der Vorlauf und die Uhrzeit des Termins —
 * „in 15 Minuten · 15:00". Ein Ganztagstermin hat keine Uhrzeit; seine Zeile
 * nennt den Tag, an dem er stattfindet — „Ganztägig · Di 17.11.", und bei
 * einem Alarm am Vortag zusaetzlich den Abstand: „Ganztägig · in 1 Tag · Di
 * 17.11.". Eine Uhrzeit waere hier die des Alarms und saehe aus wie ein
 * Terminbeginn.
 */
export function reminderText(event: CalendarEvent, atMs: number): string {
  const date = event.start.slice(0, 10);
  if (event.allDay) {
    const days = dateToDayNumber(date) - dateToDayNumber(localDateOf(atMs));
    const head = days > 0 ? `Ganztägig · ${leadText(days * 1440)}` : "Ganztägig";
    const weekday = GERMAN_WEEKDAYS_SHORT[weekdayIndex(date)];
    return `${head} · ${weekday} ${date.slice(8, 10)}.${date.slice(5, 7)}.`;
  }
  const minutes = Math.round((wallClockMs(event.start) - atMs) / 60_000);
  const time = event.start.length > 10 ? event.start.slice(11, 16) : "00:00";
  return `${leadText(minutes)} · ${time}`;
}

/**
 * Die Erinnerungen, die **jetzt** faellig sind.
 *
 * Faellig ist eine Erinnerung ab ihrem Zeitpunkt und dann noch
 * `REMINDER_GRACE_MS` lang. Was laenger vorbei ist, wird nicht nachgeholt:
 * der Tab war zu oder der Rechner hat geschlafen, und eine Benachrichtigung
 * ueber einen Termin von vorgestern hilft niemandem.
 *
 * Die Liste ist nach Zeitpunkt sortiert; der Schluessel ist je Erinnerung
 * eindeutig — zwei Eintraege desselben Termins zum selben Zeitpunkt sind
 * schon in `instantsOf` zu einem geworden.
 */
export function dueReminders(events: readonly ReminderEvent[], nowMs: number): DueReminder[] {
  const due: DueReminder[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    for (const atMs of instantsOf(event)) {
      if (atMs > nowMs) continue;
      if (nowMs - atMs > REMINDER_GRACE_MS) continue;
      const key = `${event.id}@${atMs}`;
      if (seen.has(key)) continue;
      seen.add(key);
      due.push({ key, title: event.title, body: reminderText(event, atMs), atMs });
    }
  }
  return due.sort((a, b) => a.atMs - b.atMs || a.key.localeCompare(b.key));
}

/**
 * Der naechste Zeitpunkt einer Erinnerung — oder `null`, wenn keiner mehr
 * kommt.
 *
 * Der Hook stellt seinen Timer auf diesen Zeitpunkt, statt zu pollen: ein
 * Kalender mit 40 Terminen im Monat hat 40 Zeitpunkte, und eine Schleife,
 * die jede Sekunde nachsieht, waere 40-mal Arbeit pro Minute fuer eine
 * Antwort, die schon feststeht. Kennt der Terminbestand keinen kuenftigen
 * Zeitpunkt mehr, gibt es nichts zu warten.
 */
export function nextReminderAt(events: readonly ReminderEvent[], nowMs: number): number | null {
  let next: number | null = null;
  for (const event of events) {
    for (const atMs of instantsOf(event)) {
      if (atMs <= nowMs) continue;
      if (next === null || atMs < next) next = atMs;
    }
  }
  return next;
}
