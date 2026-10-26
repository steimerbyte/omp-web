/**
 * Der ICS-Parser: aus einer `.ics`-Datei die Termine des Kalenders machen.
 *
 * ### Warum das ein eigenes Modul ist
 *
 * Das ICS-Format ist ein Fremdformat, und die Abbildung auf das
 * Ereignismodell braucht Regeln, die an genau einer Stelle stehen muessen.
 * Ein zweiter Parser — im Client fuer die Vorschau und im Server fuer den
 * Import — waere die klassische Stelle, an der sich beide unterscheiden: der
 * Client zeigte eine Vorschau, die der Server nicht so speichert.
 *
 * ### Das Modul ist rein
 *
 * Kein `fs`, kein `fetch`, keine Server-Only-Abhaengigkeit: der Parser liest
 * einen String und gibt Termine und einen Bericht zurueck. Damit laesst er
 * sich ohne Dateisystem pruefen, und die Route bleibt die einzige Stelle, die
 * schreibt.
 *
 * ### Die Zeitregel: Wandzeit, ausser bei `Z`
 *
 * Der Kalender speichert lokale Wandzeit ohne Zone (`"2026-03-14T15:00"`,
 * siehe `lib/calendar.ts`). Deshalb gilt:
 *
 * - `DTSTART:20261028T140000` (ohne Zone) — **Wandzeit**, unveraendert:
 *   `"2026-10-28T14:00"`.
 * - `DTSTART;TZID=Europe/Berlin:20261028T140000` — **ebenfalls Wandzeit**,
 *   unveraendert: `"2026-10-28T14:00"`. Der Kalender kennt keine Zonen, und
 *   die Wandzeit ist genau das, was der Leser sieht. Eine Zone aus einer
 *   fremden Datei wird deshalb *nicht* umgerechnet; der Bericht nennt die
 *   betroffenen Termine, damit der Nutzer nachsehen kann.
 * - `DTSTART:20261028T140000Z` — **wird umgerechnet**, und zwar in die
 *   lokale Zeit der Maschine, auf der der Import laeuft. Das `Z` sagt
 *   "das ist ein Zeitpunkt", und ein Zeitpunkt ohne Zone waere eine
 *   Verschiebung um den UTC-Offset.
 *
 * ### Ganztag: `DTEND` ist exklusiv, das Feld `end` ist inklusiv
 *
 * In ICS endet ein Ganztagestermin am *Tag nach* dem letzten Tag
 * (`DTEND:20261029` heisst "der 28. ist der letzte Tag"). Das Feld `end` des
 * Kalenders nennt den *letzten* Tag. Deshalb wird ein Tag abgezogen:
 * `DTEND:20261029` wird zu `"2026-10-28"`.
 *
 * ### Was der Parser nicht kann
 *
 * Das Ereignismodell kennt keine Teilnehmer, keine Erinnerungen, keine
 * Kategorien und keine Status. Was die Datei an solchen Angaben enthaelt,
 * wird gezaehlt und im Bericht genannt — nicht stillschweigend weggeworfen.
 *
 * Wiederholungen werden nur so weit ausgewertet, wie das hier steht; eine
 * Regel, die das Modul nicht kennt, bringt den ersten Termin und eine
 * Meldung. Eine Regel ohne `COUNT` und ohne `UNTIL` ist unbegrenzt und
 * wird **nicht** ausgewertet: sie bringt den ersten Termin und eine
 * Meldung.
 */

import {
  addDays,
  dateToDayNumber,
  daysInMonth,
  isCalendarDate,
  isCalendarDateTime,
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
  minutesToTime,
  startOfWeek,
  timeToMinutes,
  validateEventRange,
  weekdayIndex,
  type CalendarEvent,
} from "./calendar";

/**
 * Die groesste Zahl Termine, die **ein** `VEVENT` liefern darf.
 *
 * Eine Regel ohne Ende (siehe `MAX_ICS_OCCURRENCES_PER_IMPORT`) darf nie
 * endlos laufen. Der Deckel ist hart: lieber ein Import mit 1000 Terminen,
 * der im Bericht nach sich sagt, als ein Import, der die Datei von Hand
 * abbrechen muss.
 */
export const MAX_ICS_OCCURRENCES_PER_EVENT = 1000;

/**
 * Die groesste Zahl Termine, die **ein Import** liefern darf.
 */
export const MAX_ICS_OCCURRENCES_PER_IMPORT = 2000;

/**
 * Die groesste Groesse einer `.ics`-Datei in Bytes (2 MB).
 *
 * Der Import nimmt die Datei als JSON im Body entgegen; eine Grenze ist
 * Pflicht, weil ein Body ohne Grenze ein Speicherproblem ist.
 */
export const MAX_ICS_BYTES = 2 * 1024 * 1024;

/**
 * Der Grund, warum ein Termin nicht importiert wurde.
 *
 * Die Werte sind maschinenlesbar und stabil: die Oberflaeche uebersetzt sie,
 * und ein Test prueft auf sie. Ein neuer Grund ist eine neue Konstante hier
 * — kein freier Text im Code.
 */
export type CalendarIcsSkipReason =
  | "no-start-date"
  | "duplicate"
  | "unexpanded-recurrence"
  | "invalid-event";

/** Ein Termin, der nicht importiert wurde. */
export interface CalendarIcsSkippedEntry {
  /** Der maschinenlesbare Grund. */
  reason: CalendarIcsSkipReason;
  /** Die Erlaeuterung in Worten. */
  detail: string;
}

/**
 * Was das Format hergibt, das das Ereignismodell nicht kennt — nach Art
 * gezaehlt.
 *
 * Die Zaehler stehen immer da, auch wenn sie null sind: eine Antwort, deren
 * Form von der Datei abhaengt, ist eine Form, die der Client nicht kennen
 * kann.
 */
export interface CalendarIcsIgnoredCounts {
  /** `VALARM`-Bloecke und `ALARM`-Eigenschaften. */
  alarms: number;
  /** `ATTENDEE`. */
  attendees: number;
  /** `CATEGORIES`. */
  categories: number;
  /** `ORGANIZER`. */
  organizers: number;
  /** `URL`. */
  urls: number;
  /** `STATUS`. */
  statuses: number;
  /** `TRANSP`. */
  transparencies: number;
  /** `VTIMEZONE`-Bloecke. */
  timezones: number;
  /**
   * Alle uebrigen Komponenten (`VJOURNAL`, `VTODO`, …).
   *
   * Der Umschlag `VCALENDAR` zaehlt nicht mit: er ist die Huelle der Datei,
   * kein Bestandteil.
   */
  otherComponents: number;
}

/** Der Bericht eines Imports. */
export interface CalendarIcsReport {
  /** Die Zahl der Termine, die der Parser erzeugt hat. */
  imported: number;
  /** Was nicht importiert wurde. */
  skipped: CalendarIcsSkippedEntry[];
  /** Was das Format hergibt, das der Kalender nicht speichern kann. */
  ignored: CalendarIcsIgnoredCounts;
  /** Die Zahl der Regeln, die nicht ausgewertet wurden. */
  unexpandedRecurrences: number;
  /** Hinweise, die der Import dem Nutzer mitgeben muss. */
  warnings: string[];
}

/**
 * Ein aus einer Datei gelesener Termin.
 *
 * `uid` und `source` stehen **ausserhalb** des Termins: das Ereignismodell
 * kennt keine UID, und der Kalender soll sie auch nicht kennen. Die Route
 * braucht sie aber, um Duplikate zu erkennen — und zwar dort, wo der
 * vorhandene Kalender bekannt ist.
 */
export interface CalendarIcsParsedEvent {
  /** Der Termin, so wie er in den Kalender passt. */
  event: CalendarEvent;
  /** Die `UID` des `VEVENT` — oder `null`, wenn die Datei keine nennt. */
  uid: string | null;
  /** Der Index des `VEVENT` in der Datei (0-basiert). */
  source: number;
}

/** Das Ergebnis eines Imports. */
export interface CalendarIcsParseResult {
  /** Die Termine in der Reihenfolge, in der sie in der Datei standen. */
  events: CalendarIcsParsedEvent[];
  /** Der Bericht. */
  report: CalendarIcsReport;
}

/** Eine zerlegte Inhaltszeile. */
interface IcsProperty {
  /** Der Name der Eigenschaft, grossgeschrieben. */
  name: string;
  /** Die Parameter der Eigenschaft (`TZID`, `VALUE`, …). */
  params: Record<string, string>;
  /** Der Wert der Eigenschaft. */
  value: string;
}

/** Ein Datum aus einer ICS-Datei, in die Form des Kalenders gebracht. */
interface IcsDateValue {
  /** `"2026-10-28"`. */
  date: string;
  /** `"14:00"` — oder `null` fuer einen Ganztagestermin. */
  time: string | null;
  /** `true`, wenn der Wert eine Uhrzeit traegt. */
  timed: boolean;
  /** Die Zone, die die Datei genannt hat. */
  zone: "utc" | "tzid" | "floating";
  /** Der Name der Zone bei `TZID`. */
  tzid?: string;
}

/** Eine Dauer aus einer ICS-Datei. */
interface IcsDuration {
  /** Ganze Tage. */
  days: number;
  /** Ganze Minuten. */
  minutes: number;
}

/** Die Wochentage in der Reihenfolge des RFC (MO zuerst). */
const WEEKDAY_BY_NAME: Record<string, number> = {
  MO: 0,
  TU: 1,
  WE: 2,
  TH: 3,
  FR: 4,
  SA: 5,
  SU: 6,
};

/** Eine Regel zur Wiederholung, in der Form, die das Modul versteht. */
interface RecurrenceRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count: number | null;
  /** Das `UNTIL` als Wandzeit. */
  until: { date: string; time: string | null } | null;
  /** `BYDAY` mit optionaler Ordnungszahl (`2MO`). */
  byDay: { weekday: number; ordinal: number | null }[] | null;
  /** `BYMONTHDAY` — negative Zahlen zaehlen vom Monatsende. */
  byMonthDay: number[] | null;
  /** `BYMONTH`. */
  byMonth: number[] | null;
  /** Die Regelteile, die dieses Modul nicht auswerten kann. */
  unsupported: string[];
}

/** Die Eigenschaften, die das Ereignismodell nicht kennt. */
const IGNORED_PROPERTY_KINDS: Record<string, keyof CalendarIcsIgnoredCounts> = {
  ALARM: "alarms",
  ATTENDEE: "attendees",
  CATEGORIES: "categories",
  ORGANIZER: "organizers",
  URL: "urls",
  STATUS: "statuses",
  TRANSP: "transparencies",
};

/** Die Teile einer `RRULE`, die dieses Modul auswerten kann. */
const SUPPORTED_RRULE_PARTS: Record<string, true> = {
  FREQ: true,
  INTERVAL: true,
  COUNT: true,
  UNTIL: true,
  BYDAY: true,
  BYMONTHDAY: true,
  BYMONTH: true,
};

/** Zwei Ziffern mit fuehrender Null. */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Macht aus den Zeilen einer Datei wieder ganze Zeilen.
 *
 * RFC 5545 faltet eine lange Zeile an 75 Oktetten: nach dem Zeilenumbruch
 * kommt ein Leerzeichen oder ein Tabulator, und die Zeile geht dort weiter.
 * Beim Auspacken gehoert der Umbruch weg — das Leerzeichen, das er
 * eingefuegt hat, ist aber Inhalt und bleibt erhalten. Sonst stuende am Ende
 * einer gefalteten Beschreibung kein Wort mehr.
 */
function unfoldIcsLines(text: string): string[] {
  const raw = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lines: string[] = [];
  for (const line of raw) {
    const isContinuation = line.startsWith(" ") || line.startsWith("\t");
    if (isContinuation && lines.length > 0) {
      const previous = lines[lines.length - 1];
      const continuation = line.trimStart();
      // Ein Zeilenumbruch, an dem die Datei gefaltet hat, war ein Worttrenner.
      // War die vorherige Zeile schon mit einem Leerzeichen beendet, entsteht
      // kein zweites.
      lines[lines.length - 1] =
        previous.length > 0 && !/\s$/.test(previous) ? `${previous} ${continuation}` : `${previous}${continuation}`;
      continue;
    }
    if (line.trim().length === 0) continue;
    lines.push(line);
  }
  return lines;
}

/** Teilt eine Kopfzeile an den Semikolons — auch in Anfuehrungszeichen. */
function splitParameters(head: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of head) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (char === ";" && !inQuotes) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/**
 * Zerlegt eine Inhaltszeile in Name, Parameter und Wert.
 *
 * @returns `null`, wenn die Zeile kein `NAME:wert` ist — eine kaputte Zeile
 * ist kein Grund, den ganzen Import zu verweigern.
 */
function parseContentLine(line: string): IcsProperty | null {
  let inQuotes = false;
  let colon = -1;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ":" && !inQuotes) {
      colon = index;
      break;
    }
  }
  if (colon < 0) return null;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = splitParameters(head);
  const name = (parts.shift() ?? "").trim().toUpperCase();
  if (!name) return null;

  const params: Record<string, string> = {};
  for (const part of parts) {
    const equals = part.indexOf("=");
    if (equals < 0) continue;
    const key = part.slice(0, equals).trim().toUpperCase();
    let raw = part.slice(equals + 1).trim();
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    params[key] = raw;
  }

  return { name, params, value };
}

/**
 * Wandelt einen ICS-Text in die escaped Form, die der Kalender speichert.
 *
 * `\\n` wird ein echter Zeilenumbruch, `\\,` `\\;` und `\\\\` werden das
 * Zeichen selbst. Ein unbekannter Flucht-Backslash verliert nur das
 * Backslash — so verliert eine fremde Datei nicht ihren ganzen Inhalt.
 */
export function unescapeIcsText(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      result += char;
      continue;
    }
    const next = value[index + 1];
    if (next === undefined) {
      result += "\\";
      break;
    }
    index += 1;
    if (next === "n" || next === "N") result += "\n";
    else if (next === "\\" || next === ";" || next === ",") result += next;
    else result += next;
  }
  return result;
}

/**
 * Bringt einen Zeitpunkt aus einer Datei in die lokale Wandzeit.
 *
 * `Z` heisst "das ist ein Zeitpunkt" — der wird in die lokale Zeit der
 * Maschine umgerechnet. Ohne `Z` bleibt die Uhrzeit stehen: sie *ist*
 * bereits die Wandzeit, die der Kalender zeigt.
 */
function utcToLocalWallClock(year: number, month: number, day: number, hour: number, minute: number): { date: string; time: string } {
  const instant = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return {
    date: `${instant.getFullYear()}-${pad2(instant.getMonth() + 1)}-${pad2(instant.getDate())}`,
    time: `${pad2(instant.getHours())}:${pad2(instant.getMinutes())}`,
  };
}

/**
 * Liest einen Datumswert aus einer Datei.
 *
 * @returns `null`, wenn der Wert kein Datum ist.
 */
function parseIcsDateValue(raw: string, params: Record<string, string>): IcsDateValue | null {
  const value = raw.trim();
  let match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (match) {
    const date = `${match[1]}-${match[2]}-${match[3]}`;
    if (!isCalendarDate(date)) return null;
    return { date, time: null, timed: false, zone: "floating" };
  }

  match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/i.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (hour > 23 || minute > 59) return null;

  if (match[7]) {
    // `Z` heisst Zeitpunkt: in die lokale Zeit der Maschine umrechnen.
    const local = utcToLocalWallClock(year, month, day, hour, minute);
    return { date: local.date, time: local.time, timed: true, zone: "utc" };
  }

  const tzid = params.TZID;
  if (tzid) {
    // Eine Zone aus der Datei wird *nicht* umgerechnet: der Kalender kennt
    // keine Zonen, und die Wandzeit ist, was der Leser sieht.
    return { date: `${match[1]}-${match[2]}-${match[3]}`, time: `${match[4]}:${match[5]}`, timed: true, zone: "tzid", tzid };
  }

  return { date: `${match[1]}-${match[2]}-${match[3]}`, time: `${match[4]}:${match[5]}`, timed: true, zone: "floating" };
}

/**
 * Liest eine Dauer (`PT1H30M`, `P1DT2H`) aus einer Datei.
 *
 * @returns `null`, wenn der Wert keine Dauer ist.
 */
function parseIcsDuration(raw: string): IcsDuration | null {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(raw.trim());
  if (!match) return null;
  if (match[1] === "-") return null;
  const weeks = match[2] ? Number(match[2]) : 0;
  const days = match[3] ? Number(match[3]) : 0;
  const hours = match[4] ? Number(match[4]) : 0;
  const minutes = match[5] ? Number(match[5]) : 0;
  const seconds = match[6] ? Number(match[6]) : 0;
  if (!match[2] && !match[3] && !match[4] && !match[5] && !match[6]) return null;
  return { days: weeks * 7 + days, minutes: hours * 60 + minutes + Math.floor(seconds / 60) };
}

/**
 * Liest eine `RRULE` aus einer Datei.
 *
 * @returns `null`, wenn die Regel kein lesbares `FREQ` hat.
 */
function parseRecurrenceRule(raw: string): RecurrenceRule | null {
  const rule: RecurrenceRule = {
    freq: "DAILY",
    interval: 1,
    count: null,
    until: null,
    byDay: null,
    byMonthDay: null,
    byMonth: null,
    unsupported: [],
  };

  let freqSeen = false;
  for (const part of raw.split(";")) {
    const equals = part.indexOf("=");
    if (equals < 0) continue;
    const key = part.slice(0, equals).trim().toUpperCase();
    const value = part.slice(equals + 1).trim();

    if (!SUPPORTED_RRULE_PARTS[key]) {
      rule.unsupported.push(key);
      continue;
    }

    if (key === "FREQ") {
      const freq = value.toUpperCase();
      if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") {
        rule.unsupported.push(`FREQ=${value}`);
        continue;
      }
      rule.freq = freq;
      freqSeen = true;
      continue;
    }

    if (key === "INTERVAL") {
      const interval = Number(value);
      if (!Number.isInteger(interval) || interval < 1) rule.unsupported.push("INTERVAL");
      else rule.interval = interval;
      continue;
    }

    if (key === "COUNT") {
      const count = Number(value);
      if (!Number.isInteger(count) || count < 1) rule.unsupported.push("COUNT");
      else rule.count = count;
      continue;
    }

    if (key === "UNTIL") {
      const until = parseIcsDateValue(value, {});
      if (!until) rule.unsupported.push("UNTIL");
      else rule.until = { date: until.date, time: until.time };
      continue;
    }

    if (key === "BYDAY") {
      const days: { weekday: number; ordinal: number | null }[] = [];
      for (const entry of value.split(",")) {
        const match = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/i.exec(entry.trim());
        if (!match) {
          rule.unsupported.push(`BYDAY=${entry.trim()}`);
          continue;
        }
        const ordinal = match[1] ? Number(match[1]) : null;
        // Die nullte Woche gibt es nicht — `0MO` ist keine gueltige Angabe.
        if (ordinal === 0) {
          rule.unsupported.push(`BYDAY=${entry.trim()}`);
          continue;
        }
        days.push({ weekday: WEEKDAY_BY_NAME[match[2].toUpperCase()], ordinal });
      }
      if (days.length > 0) rule.byDay = days;
      continue;
    }

    if (key === "BYMONTHDAY") {
      const days: number[] = [];
      for (const entry of value.split(",")) {
        const day = Number(entry.trim());
        if (!Number.isInteger(day) || day === 0 || day < -31 || day > 31) {
          rule.unsupported.push(`BYMONTHDAY=${entry.trim()}`);
          continue;
        }
        days.push(day);
      }
      if (days.length > 0) rule.byMonthDay = days;
      continue;
    }

    if (key === "BYMONTH") {
      const months: number[] = [];
      for (const entry of value.split(",")) {
        const month = Number(entry.trim());
        if (!Number.isInteger(month) || month < 1 || month > 12) {
          rule.unsupported.push(`BYMONTH=${entry.trim()}`);
          continue;
        }
        months.push(month);
      }
      if (months.length > 0) rule.byMonth = months;
    }
  }

  if (!freqSeen) return null;
  // Die `BY`-Teile gelten nicht fuer jede Frequenz. Was hier nicht
  // ausgewertet wird, wird nicht geraten, sondern gemeldet: eine Regel, die
  // stillschweigend etwas anderes bedeutet, waerder schlimmste Fall.
  if (rule.freq === "DAILY" && (rule.byDay || rule.byMonthDay || rule.byMonth)) {
    rule.unsupported.push("BYDAY/BYMONTHDAY/BYMONTH bei FREQ=DAILY");
  }
  if (rule.freq === "WEEKLY" && (rule.byMonthDay || rule.byMonth)) {
    rule.unsupported.push("BYMONTHDAY/BYMONTH bei FREQ=WEEKLY");
  }
  // `BYDAY` mit Ordnungszahl gibt es nur bei `MONTHLY`. Bei `WEEKLY` waere
  // die Ordnungszahl bedeutungslos, bei `YEARLY` wird sie nicht ausgewertet.
  if (rule.freq === "WEEKLY" && rule.byDay?.some((entry) => entry.ordinal !== null)) {
    rule.unsupported.push("BYDAY mit Ordnungszahl bei FREQ=WEEKLY");
  }
  if (rule.freq === "YEARLY" && rule.byDay) {
    rule.unsupported.push("BYDAY bei FREQ=YEARLY");
  }
  return rule;
}

/** Der `n`-te Wochentag in einem Monat — oder `null`, wenn es ihn nicht gibt. */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, ordinal: number): string | null {
  const total = daysInMonth(year, month);
  if (ordinal > 0) {
    const first = `${year}-${pad2(month)}-01`;
    const offset = (weekday - weekdayIndex(first) + 7) % 7;
    const day = 1 + offset + (ordinal - 1) * 7;
    if (day > total) return null;
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }
  const last = `${year}-${pad2(month)}-${pad2(total)}`;
  const offset = (weekdayIndex(last) - weekday + 7) % 7;
  const day = total - offset + (ordinal + 1) * 7;
  if (day < 1) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Alle Wochentage eines Monats, die auf `weekday` fallen. */
function allWeekdaysOfMonth(year: number, month: number, weekday: number): string[] {
  const total = daysInMonth(year, month);
  const dates: string[] = [];
  for (let day = 1; day <= total; day += 1) {
    const date = `${year}-${pad2(month)}-${pad2(day)}`;
    if (weekdayIndex(date) === weekday) dates.push(date);
  }
  return dates;
}

/** Vergleicht einen Termin mit einem `UNTIL`. */
function isBeyondUntil(date: string, time: string | null, until: { date: string; time: string | null }): boolean {
  if (until.time === null) return date > until.date;
  return `${date}T${time ?? "00:00"}` > `${until.date}T${until.time}`;
}

/**
 * Rechnet eine Regel in die Liste ihrer Termine um.
 *
 * @returns Die Daten der Vorkommen und die Angabe, ob der Deckel gegriffen
 * hat.
 */
function expandRecurrence(
  rule: RecurrenceRule,
  startDate: string,
  timed: boolean,
  time: string | null,
  limit: number,
): { dates: string[]; truncated: boolean } {
  const dates: string[] = [];
  let truncated = false;
  const until = rule.until;

  const push = (date: string): boolean => {
    if (until && isBeyondUntil(date, time, until)) return false;
    dates.push(date);
    if (rule.count !== null && dates.length >= rule.count) return false;
    if (dates.length >= limit) {
      truncated = true;
      return false;
    }
    return true;
  };

  const startYear = Number(startDate.slice(0, 4));
  const startMonth = Number(startDate.slice(5, 7));
  const startDay = Number(startDate.slice(8, 10));

  if (rule.freq === "DAILY") {
    for (let period = 0; period < 100_000; period += 1) {
      const date = addDays(startDate, period * rule.interval);
      if (!push(date)) break;
    }
    return { dates, truncated };
  }

  if (rule.freq === "WEEKLY") {
    const weekdays = rule.byDay
      ? rule.byDay.map((entry) => entry.weekday)
      : [weekdayIndex(startDate)];
    const weekStart = startOfWeek(startDate);
    for (let period = 0; period < 100_000; period += 1) {
      const base = addDays(weekStart, period * rule.interval * 7);
      const periodDates: string[] = [];
      for (const weekday of weekdays) {
        const date = addDays(base, weekday);
        if (date < startDate) continue;
        periodDates.push(date);
      }
      periodDates.sort();
      let stop = false;
      for (const date of periodDates) {
        if (!push(date)) {
          stop = true;
          break;
        }
      }
      if (stop) break;
    }
    return { dates, truncated };
  }

  if (rule.freq === "MONTHLY") {
    const monthIndexOf = (year: number, month: number): number => year * 12 + (month - 1);
    for (let period = 0; period < 10_000; period += 1) {
      const index = monthIndexOf(startYear, startMonth) + period * rule.interval;
      const year = Math.floor(index / 12);
      const month = (index % 12) + 1;
      const candidates: string[] = [];

      if (rule.byMonthDay) {
        const total = daysInMonth(year, month);
        for (const day of rule.byMonthDay) {
          const resolved = day > 0 ? day : total + day + 1;
          if (resolved < 1 || resolved > total) continue;
          candidates.push(`${year}-${pad2(month)}-${pad2(resolved)}`);
        }
      } else if (rule.byDay) {
        for (const entry of rule.byDay) {
          if (entry.ordinal !== null) {
            const date = nthWeekdayOfMonth(year, month, entry.weekday, entry.ordinal);
            if (date) candidates.push(date);
            continue;
          }
          candidates.push(...allWeekdaysOfMonth(year, month, entry.weekday));
        }
      } else {
        const total = daysInMonth(year, month);
        if (startDay <= total) candidates.push(`${year}-${pad2(month)}-${pad2(startDay)}`);
      }

      // `BYMONTHDAY` und `BYDAY` zusammen schneiden sich.
      if (rule.byMonthDay && rule.byDay) {
        const monthDays = new Set(candidates);
        const weekdayDates = new Set<string>();
        for (const entry of rule.byDay) {
          if (entry.ordinal !== null) {
            const date = nthWeekdayOfMonth(year, month, entry.weekday, entry.ordinal);
            if (date) weekdayDates.add(date);
            continue;
          }
          for (const date of allWeekdaysOfMonth(year, month, entry.weekday)) weekdayDates.add(date);
        }
        candidates.length = 0;
        for (const date of weekdayDates) if (monthDays.has(date)) candidates.push(date);
      }

      candidates.sort();
      let stop = false;
      for (const date of candidates) {
        if (date < startDate) continue;
        if (!push(date)) {
          stop = true;
          break;
        }
      }
      if (stop) break;
    }
    return { dates, truncated };
  }

  // YEARLY
  const months = rule.byMonth ?? [startMonth];
  const days = rule.byMonthDay ?? [startDay];
  for (let period = 0; period < 10_000; period += 1) {
    const year = startYear + period * rule.interval;
    const candidates: string[] = [];
    for (const month of months) {
      const total = daysInMonth(year, month);
      for (const day of days) {
        const resolved = day > 0 ? day : total + day + 1;
        if (resolved < 1 || resolved > total) continue;
        candidates.push(`${year}-${pad2(month)}-${pad2(resolved)}`);
      }
    }
    candidates.sort();
    let stop = false;
    for (const date of candidates) {
      if (date < startDate) continue;
      if (!push(date)) {
        stop = true;
        break;
      }
    }
    if (stop) break;
  }
  return { dates, truncated };
}

/**
 * Sammelt die `VEVENT`-Bloecke einer Datei.
 *
 * Alles andere wird gezaehlt und nicht beachtet: `VTIMEZONE`, `VALARM`,
 * `VJOURNAL` — der Kalender hat fuer sie keine Form.
 *
 * Der Umschlag `VCALENDAR` und die Teile eines fremden Bestandteils
 * (`STANDARD` in einer `VTIMEZONE`) zaehlen nicht mit: sie sind die Huelle
 * der Datei, kein Inhalt.
 */
function collectEventBlocks(lines: string[], report: CalendarIcsReport): IcsProperty[][] {
  const blocks: IcsProperty[][] = [];
  const buffers = new Map<string, IcsProperty[]>();
  const stack: string[] = [];

  for (const line of lines) {
    const property = parseContentLine(line);
    if (!property) continue;

    if (property.name === "BEGIN") {
      const component = property.value.trim().toUpperCase();
      stack.push(component);
      if (!buffers.has(component)) buffers.set(component, []);
      continue;
    }

    if (property.name === "END") {
      const component = property.value.trim().toUpperCase();
      const index = stack.lastIndexOf(component);
      // Der Elternbestandteil: die Teile eines fremden Blocks (`STANDARD` in
      // einer `VTIMEZONE`) sind kein eigener Bestandteil der Datei.
      const parent = index > 0 ? stack[index - 1] : undefined;
      // Nur was wirklich geoeffnet wurde, zaehlt: ein `END:` ohne `BEGIN:`
      // schliesst nichts.
      const opened = index >= 0;
      if (opened) stack.length = index;
      if (component === "VEVENT") {
        // Nur ein geoeffneter Block ist ein Termin.
        const buffer = buffers.get("VEVENT");
        if (buffer) blocks.push(buffer);
      } else if (component === "VALARM") {
        if (opened) report.ignored.alarms += 1;
      } else if (component === "VTIMEZONE") {
        if (opened) report.ignored.timezones += 1;
      } else if (component === "VCALENDAR") {
        // Der Umschlag der Datei ist kein Bestandteil, sondern die Huelle.
      } else if (opened && (parent === undefined || parent === "VCALENDAR" || parent === "VEVENT")) {
        // Nur was die Anwendung nicht kennt und was nicht in einem fremden
        // Block steckt, zaehlt als sonstiger Bestandteil.
        report.ignored.otherComponents += 1;
      }
      buffers.delete(component);
      continue;
    }

    const current = stack[stack.length - 1];
    if (!current) continue;
    const buffer = buffers.get(current);
    if (!buffer) continue;

    if (current === "VEVENT") {
      const kind = IGNORED_PROPERTY_KINDS[property.name];
      if (kind) report.ignored[kind] += 1;
    }
    buffer.push(property);
  }

  return blocks;
}

/** Die Eigenschaften eines `VEVENT`, nach Namen gruppiert. */
function groupProperties(block: IcsProperty[]): Map<string, IcsProperty[]> {
  const grouped = new Map<string, IcsProperty[]>();
  for (const property of block) {
    const list = grouped.get(property.name);
    if (list) list.push(property);
    else grouped.set(property.name, [property]);
  }
  return grouped;
}

/** Kuerzt einen Text und meldet, wenn es passiert ist. */
function truncateText(
  value: string | undefined,
  limit: number,
  label: string,
  title: string,
  warnings: string[],
): string | undefined {
  if (!value) return undefined;
  if (value.length <= limit) return value;
  warnings.push(`Der ${label} von „${title}" war laenger als ${limit} Zeichen und wurde gekuerzt.`);
  return value.slice(0, limit);
}

/**
 * Baut aus einem `VEVENT` die Termine, die daraus werden.
 *
 * @returns Die Termine des Blocks — leer, wenn der Block nichts hergibt.
 */
function buildEventFromBlock(
  block: IcsProperty[],
  source: number,
  report: CalendarIcsReport,
  remaining: number,
): CalendarIcsParsedEvent[] {
  const properties = groupProperties(block);
  const first = (name: string): IcsProperty | null => properties.get(name)?.[0] ?? null;
  const all = (name: string): IcsProperty[] => properties.get(name) ?? [];

  const summary = first("SUMMARY");
  const title = summary ? unescapeIcsText(summary.value).trim() : "";
  if (!title) {
    report.skipped.push({ reason: "invalid-event", detail: "VEVENT ohne SUMMARY" });
    return [];
  }

  const dtstartProperty = first("DTSTART");
  if (!dtstartProperty) {
    report.skipped.push({ reason: "no-start-date", detail: `VEVENT „${title}" ohne DTSTART` });
    return [];
  }
  const dtstart = parseIcsDateValue(dtstartProperty.value, dtstartProperty.params);
  if (!dtstart) {
    report.skipped.push({
      reason: "no-start-date",
      detail: `VEVENT „${title}" mit unbrauchbarem DTSTART „${dtstartProperty.value.trim()}"`,
    });
    return [];
  }

  const allDay = !dtstart.timed;
  const warnings = report.warnings;

  const dtendProperty = first("DTEND");
  const durationProperty = first("DURATION");

  let endDate = dtstart.date;
  let endTime: string | null = dtstart.time;
  let endKnown = false;

  if (dtendProperty) {
    const dtend = parseIcsDateValue(dtendProperty.value, dtendProperty.params);
    if (!dtend) {
      report.skipped.push({
        reason: "invalid-event",
        detail: `VEVENT „${title}" mit unbrauchbarem DTEND „${dtendProperty.value.trim()}"`,
      });
      return [];
    }
    if (allDay) {
      // Das `DTEND` eines Ganztagestermins ist exklusiv, das Feld `end` des
      // Kalenders nennt den letzten Tag. Also ein Tag abziehen.
      if (dtend.timed) {
        warnings.push(
          `VEVENT „${title}": DTEND hat eine Uhrzeit, obwohl der Beginn ein Ganztag ist — der Datumsanteil wurde als exklusives Ende gelesen.`,
        );
      }
      endDate = addDays(dtend.date, -1);
      if (endDate < dtstart.date) endDate = dtstart.date;
      endTime = null;
    } else {
      if (!dtend.timed) {
        report.skipped.push({
          reason: "invalid-event",
          detail: `VEVENT „${title}" mit einem DTEND ohne Uhrzeit`,
        });
        return [];
      }
      endDate = dtend.date;
      endTime = dtend.time;
    }
    endKnown = true;
  } else if (durationProperty) {
    const duration = parseIcsDuration(durationProperty.value);
    if (!duration) {
      report.skipped.push({
        reason: "invalid-event",
        detail: `VEVENT „${title}" mit unbrauchbarer DURATION „${durationProperty.value.trim()}"`,
      });
      return [];
    }
    if (allDay) {
      endDate = addDays(dtstart.date, Math.max(duration.days - 1, 0));
      endTime = null;
    } else {
      const startMinutes = timeToMinutes(dtstart.time ?? "00:00");
      const total = startMinutes + duration.minutes + duration.days * 24 * 60;
      endDate = addDays(dtstart.date, Math.floor(total / 1440));
      endTime = minutesToTime(total % 1440);
    }
    endKnown = true;
  } else if (!allDay) {
    // Der Kalender kennt keinen Termin ohne Ende: `validateEventRange`
    // weist ein Ende auf dem Beginn zurueck. Eine Stunde ist der kleinste
    // Wert, der darstellbar ist — und der Bericht sagt es.
    const startMinutes = timeToMinutes(dtstart.time ?? "00:00");
    const total = startMinutes + 60;
    endDate = addDays(dtstart.date, Math.floor(total / 1440));
    endTime = minutesToTime(total % 1440);
    endKnown = true;
    warnings.push(
      `VEVENT „${title}" ohne DTEND und ohne DURATION — das Ende wurde auf eine Stunde nach dem Beginn gesetzt.`,
    );
  } else {
    endKnown = true;
  }

  if (!endKnown) {
    report.skipped.push({ reason: "invalid-event", detail: `VEVENT „${title}" ohne DTEND, DURATION und Ende` });
    return [];
  }

  // Die Dauer des Termins — sie wandert mit jedem Vorkommen mit.
  const spanDays = dateToDayNumber(endDate) - dateToDayNumber(dtstart.date) + 1;
  const spanMinutes = allDay
    ? 0
    : (dateToDayNumber(endDate) - dateToDayNumber(dtstart.date)) * 1440 +
      (timeToMinutes(endTime ?? "00:00") - timeToMinutes(dtstart.time ?? "00:00"));

  // Die Zonen, die die Datei genannt hat, dem Nutzer mitgeben.
  if (dtstart.zone === "tzid") {
    warnings.push(
      `VEVENT „${title}" (${dtstart.date}${dtstart.time ? ` ${dtstart.time}` : ""}) hat TZID=${dtstart.tzid ?? "?"}: die Uhrzeit wurde als Wandzeit uebernommen, nicht umgerechnet.`,
    );
  }
  if (dtstart.zone === "utc") {
    warnings.push(
      `VEVENT „${title}" mit Z wurde in die lokale Zeit umgerechnet (${dtstart.date}${dtstart.time ? ` ${dtstart.time}` : ""}).`,
    );
  }

  // Die Termine, die aus der Regel entstehen.
  const rruleProperty = first("RRULE");
  let occurrenceDates: string[] = [dtstart.date];

  if (rruleProperty) {
    const rule = parseRecurrenceRule(rruleProperty.value);
    if (!rule) {
      report.unexpandedRecurrences += 1;
      report.skipped.push({
        reason: "unexpanded-recurrence",
        detail: `VEVENT „${title}" mit unlesbarer RRULE „${rruleProperty.value.trim()}" — nur der erste Termin wurde importiert.`,
      });
      warnings.push(`VEVENT „${title}": die Wiederholungsregel wurde nicht ausgewertet — nur der erste Termin wurde importiert.`);
    } else if (rule.unsupported.length > 0) {
      report.unexpandedRecurrences += 1;
      report.skipped.push({
        reason: "unexpanded-recurrence",
        detail: `VEVENT „${title}" mit nicht unterstuetzter RRULE (${rule.unsupported.join(", ")}) — nur der erste Termin wurde importiert.`,
      });
      warnings.push(
        `VEVENT „${title}": die Wiederholungsregel nutzt ${rule.unsupported.join(", ")}, was der Kalender nicht kennt — nur der erste Termin wurde importiert.`,
      );
    } else if (rule.count === null && rule.until === null) {
      report.unexpandedRecurrences += 1;
      report.skipped.push({
        reason: "unexpanded-recurrence",
        detail: `VEVENT „${title}" mit einer RRULE ohne COUNT und ohne UNTIL — nur der erste Termin wurde importiert.`,
      });
      warnings.push(
        `VEVENT „${title}": die Wiederholungsregel hat weder COUNT noch UNTIL und ist damit unbegrenzt — nur der erste Termin wurde importiert.`,
      );
    } else {
      const limit = Math.min(MAX_ICS_OCCURRENCES_PER_EVENT, Math.max(remaining, 0));
      const expanded = expandRecurrence(rule, dtstart.date, dtstart.timed, dtstart.time, limit);
      occurrenceDates = expanded.dates;
      if (expanded.dates.length === 0) {
        // Die Regel ergibt keinen einzigen Termin — zum Beispiel, weil der
        // Beginn hinter dem `UNTIL` liegt. Das wird gemeldet, nicht
        // verschwiegen: ein VEVENT, der nichts ergibt, ist kein Termin.
        report.skipped.push({
          reason: "unexpanded-recurrence",
          detail: `VEVENT „${title}" mit einer RRULE, die keinen Termin ergibt.`,
        });
      }
      if (expanded.truncated) {
        warnings.push(
          `VEVENT „${title}": die Wiederholungsregel wurde bei ${expanded.dates.length} Terminen abgeschnitten.`,
        );
      }
    }
  }

  // Die Tage, die die Regel ausschliesst.
  const excluded = new Set<string>();
  for (const exdate of all("EXDATE")) {
    for (const entry of exdate.value.split(",")) {
      const parsed = parseIcsDateValue(entry, exdate.params);
      if (!parsed) continue;
      excluded.add(parsed.timed ? `${parsed.date}T${parsed.time}` : parsed.date);
    }
  }

  const uidProperty = first("UID");
  const uid = uidProperty ? uidProperty.value.trim() || null : null;

  const truncatedTitle = truncateText(title, MAX_TITLE_LENGTH, "Titel", title, warnings) ?? title;
  const description = truncateText(
    first("DESCRIPTION") ? unescapeIcsText(first("DESCRIPTION")!.value).trim() : undefined,
    MAX_TEXT_LENGTH,
    "Text",
    title,
    warnings,
  );
  const location = truncateText(
    first("LOCATION") ? unescapeIcsText(first("LOCATION")!.value).trim() : undefined,
    MAX_TEXT_LENGTH,
    "Ort",
    title,
    warnings,
  );

  const now = new Date().toISOString();
  const events: CalendarIcsParsedEvent[] = [];

  for (const date of occurrenceDates) {
    const key = allDay ? date : `${date}T${dtstart.time ?? "00:00"}`;
    if (excluded.has(key)) continue;

    const start = allDay ? date : `${date}T${dtstart.time ?? "00:00"}`;
    let end: string;
    if (allDay) {
      end = addDays(date, Math.max(spanDays - 1, 0));
    } else {
      const startMinutes = timeToMinutes(dtstart.time ?? "00:00");
      const total = startMinutes + spanMinutes;
      const endDay = addDays(date, Math.floor(total / 1440));
      end = `${endDay}T${minutesToTime(((total % 1440) + 1440) % 1440)}`;
    }

    const startValid = allDay ? isCalendarDate(start) : isCalendarDateTime(start);
    const endValid = allDay ? isCalendarDate(end) : isCalendarDateTime(end);
    if (!startValid || !endValid || validateEventRange(start, end, allDay)) {
      report.skipped.push({
        reason: "invalid-event",
        detail: `VEVENT „${title}" ergibt den unbrauchbaren Zeitraum ${start} bis ${end}`,
      });
      continue;
    }

    events.push({
      event: {
        id: globalThis.crypto.randomUUID(),
        title: truncatedTitle,
        ...(description ? { description } : {}),
        ...(location ? { location } : {}),
        start,
        end,
        allDay,
        createdAt: now,
        updatedAt: now,
      },
      uid,
      source,
    });
  }

  return events;
}

/**
 * Liest eine `.ics`-Datei und liefert die Termine und den Bericht.
 *
 * Die Funktion wirft **nicht**. Eine kaputte Datei ist kein Fehler des
 * Imports, sondern ein Import mit einer Menge uebersprungener Termine —
 * ein einzelner kaputter `VEVENT` darf die anderen funfzig nicht
 * mitnehmen.
 *
 * @param ics Der Inhalt der Datei.
 * @returns Die gelesenen Termine und der Bericht.
 */
export function parseCalendarIcs(ics: string): CalendarIcsParseResult {
  const report: CalendarIcsReport = {
    imported: 0,
    skipped: [],
    ignored: {
      alarms: 0,
      attendees: 0,
      categories: 0,
      organizers: 0,
      urls: 0,
      statuses: 0,
      transparencies: 0,
      timezones: 0,
      otherComponents: 0,
    },
    unexpandedRecurrences: 0,
    warnings: [],
  };

  const events: CalendarIcsParsedEvent[] = [];
  if (typeof ics !== "string" || ics.trim().length === 0) {
    return { events, report };
  }

  const lines = unfoldIcsLines(ics);
  const blocks = collectEventBlocks(lines, report);

  let source = 0;
  for (const block of blocks) {
    const sourceIndex = source;
    source += 1;
    const remaining = MAX_ICS_OCCURRENCES_PER_IMPORT - events.length;
    if (remaining <= 0) {
      report.warnings.push(
        `Der Import wurde bei ${MAX_ICS_OCCURRENCES_PER_IMPORT} Terminen abgeschnitten — die uebrigen Termine der Datei wurden nicht gelesen.`,
      );
      break;
    }
    const built = buildEventFromBlock(block, sourceIndex, report, remaining);
    for (const event of built) {
      if (events.length >= MAX_ICS_OCCURRENCES_PER_IMPORT) {
        report.warnings.push(
          `Der Import wurde bei ${MAX_ICS_OCCURRENCES_PER_IMPORT} Terminen abgeschnitten — die uebrigen Termine der Datei wurden nicht gelesen.`,
        );
        break;
      }
      events.push(event);
    }
  }

  report.imported = events.length;
  return { events, report };
}
