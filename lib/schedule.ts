import { GERMAN_WEEKDAYS } from "./calendar";

/**
 * Cron-Zeitplaene fuer geplante Agenten-Aufgaben.
 *
 * ### Warum eine eigene Implementierung und keine Bibliothek
 *
 * Das Format ist klein: fuenf Felder, `*`, Zahlen, Bereiche, Schritte und
 * Listen. Eine Abhaengigkeit fuer diese Grammatik waere mehr Code im Baum als
 * der Parser selbst — und `AGENTS.md` verbietet neue Pakete fuer genau solche
 * Faelle. Was hier *nicht* nachgebaut wird, ist die Zeitzone: die kommt aus der
 * lokalen `Date`-API des Servers.
 *
 * ### Streng, nicht nachsichtig
 *
 * Was nicht in der Grammatik steht, wird abgelehnt und nicht interpretiert:
 * `L`, `W`, `#`, `@reboot` und sechs Felder sind Fehler, keine Sonderfaelle.
 * Ein Zeitplan, der still zu etwas anderem wird als dem, was der Nutzer
 * getippt hat, feuert zur falschen Zeit — und das merkt niemand, bis es zu
 * spaet ist. Der Fehler nennt deshalb Feld und Token.
 *
 * ### Zeitzone
 *
 * Alle Zeiten sind lokale Zeit des Servers (ueber `Date`), nicht UTC. Der
 * Agent laeuft auf derselben Maschine wie der Zeitplan; eine eigene
 * Zonenrechnung waere die Stelle, an der Sommerzeit falsch wird.
 */

/** Die fuenf Felder in der Reihenfolge, in der sie im Ausdruck stehen. */
export type ScheduleField = "minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek";

/**
 * Ein abgelehnter Zeitplan.
 *
 * `field` und `token` sind getrennt vom Text, damit eine Route den Fehler
 * zuordnen kann (Feld markieren), ohne die Meldung zu zerlegen.
 */
export class ScheduleError extends Error {
  /** Das abgelehnte Feld, oder `expression` fuer den Ausdruck als Ganzes. */
  readonly field: ScheduleField | "expression";
  /** Der abgelehnte Token, oder der ganze Ausdruck. */
  readonly token: string;

  constructor(field: ScheduleField | "expression", token: string, message: string) {
    super(message);
    this.name = "ScheduleError";
    this.field = field;
    this.token = token;
  }
}

interface FieldSpec {
  name: ScheduleField;
  /** Kleinster erlaubter Wert. */
  min: number;
  /** Groesster erlaubter Wert. */
  max: number;
  /** Laenge der Trefferliste; Index = Wert, bei `dayOfWeek` wird 7 auf 0 gelegt. */
  size: number;
}

const FIELDS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59, size: 60 },
  { name: "hour", min: 0, max: 23, size: 24 },
  { name: "dayOfMonth", min: 1, max: 31, size: 32 },
  { name: "month", min: 1, max: 12, size: 13 },
  // 0 und 7 sind beide Sonntag; die Trefferliste hat sieben Tage.
  { name: "dayOfWeek", min: 0, max: 7, size: 7 },
];

/**
 * Ein gepruefter Zeitplan.
 *
 * Die Trefferlisten sind `ReadonlyArray<boolean>` und eingefroren: ein Aufrufer
 * soll einen einmal geprueften Plan nicht mehr veraendern koennen. `true` am
 * Index heisst "dieser Wert trifft zu".
 */
export interface ParsedSchedule {
  /** Der Ausdruck, aus dem der Plan entstand — fuer Fehlermeldungen. */
  readonly expression: string;
  /** 0-59. */
  readonly minutes: ReadonlyArray<boolean>;
  /** 0-23. */
  readonly hours: ReadonlyArray<boolean>;
  /** 1-31; Index 0 ist unbenutzt. */
  readonly daysOfMonth: ReadonlyArray<boolean>;
  /** 1-12; Index 0 ist unbenutzt. */
  readonly months: ReadonlyArray<boolean>;
  /** 0-6 mit 0 = Sonntag. */
  readonly daysOfWeek: ReadonlyArray<boolean>;
  /** `true`, wenn das Tagesdatum-Feld nicht genau `*` ist. */
  readonly dayOfMonthRestricted: boolean;
  /** `true`, wenn das Wochentag-Feld nicht genau `*` ist. */
  readonly dayOfWeekRestricted: boolean;
}

const STAR_STEP = /^\*\/(\d+)$/;
const RANGE_STEP = /^(\d+)-(\d+)\/(\d+)$/;
const RANGE = /^(\d+)-(\d+)$/;
const VALUE = /^\d+$/;

function toNumber(field: FieldSpec, token: string, text: string, what: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < field.min || value > field.max) {
    throw new ScheduleError(
      field.name,
      token,
      `${what} ${text} in the ${field.name} field is outside ${field.min}-${field.max}`,
    );
  }
  return value;
}

/** Ein Schritt ist eins oder mehr; `0` und negativ sind keine Schrittweite. */
function toStep(field: FieldSpec, token: string, text: string): number {
  const step = Number(text);
  if (!Number.isSafeInteger(step) || step < 1) {
    throw new ScheduleError(field.name, token, `Step ${text} in the ${field.name} field must be at least 1`);
  }
  return step;
}

/** Die Werte eines Tokens, oder ein Fehler, der Feld und Token nennt. */
function valuesForToken(field: FieldSpec, token: string): number[] {
  const values: number[] = [];

  if (token === "*") {
    for (let value = field.min; value <= field.max; value += 1) values.push(value);
    return values;
  }

  const starStep = STAR_STEP.exec(token);
  if (starStep) {
    const step = toStep(field, token, starStep[1]);
    // Vixie beginnt `*/n` beim Feldminimum, nicht bei 0: `*/2` im Tagesdatum
    // heisst 1, 3, 5, ... und nicht 2, 4, 6, ...
    for (let value = field.min; value <= field.max; value += step) values.push(value);
    return values;
  }

  const rangeStep = RANGE_STEP.exec(token);
  if (rangeStep) {
    const from = toNumber(field, token, rangeStep[1], "Range start");
    const to = toNumber(field, token, rangeStep[2], "Range end");
    if (from > to) throw new ScheduleError(field.name, token, `Range ${from}-${to} in the ${field.name} field is descending`);
    const step = toStep(field, token, rangeStep[3]);
    for (let value = from; value <= to; value += step) values.push(value);
    return values;
  }

  const range = RANGE.exec(token);
  if (range) {
    const from = toNumber(field, token, range[1], "Range start");
    const to = toNumber(field, token, range[2], "Range end");
    if (from > to) throw new ScheduleError(field.name, token, `Range ${from}-${to} in the ${field.name} field is descending`);
    for (let value = from; value <= to; value += 1) values.push(value);
    return values;
  }

  if (VALUE.test(token)) {
    values.push(toNumber(field, token, token, "Value"));
    return values;
  }

  throw new ScheduleError(
    field.name,
    token,
    `Invalid ${field.name} token "${token}": expected *, a number, a-b, a-b/n or */n`,
  );
}

function parseField(field: FieldSpec, raw: string): ReadonlyArray<boolean> {
  const mask = new Array<boolean>(field.size).fill(false);
  for (const token of raw.split(",")) {
    // Ein leerer Token entsteht durch `1,,2` oder einen Schlusspunkt; er ist
    // keine leere Liste, sondern ein Schreibfehler.
    if (token === "") {
      throw new ScheduleError(field.name, raw, `Empty token in the ${field.name} field "${raw}"`);
    }
    for (const value of valuesForToken(field, token)) {
      // 7 und 0 sind beide Sonntag.
      mask[field.name === "dayOfWeek" ? value % 7 : value] = true;
    }
  }
  return Object.freeze(mask);
}

/**
 * Zerlegt einen Cron-Ausdruck in seine Trefferlisten.
 *
 * Fuenf Felder, in dieser Reihenfolge: Minute, Stunde, Tag des Monats, Monat,
 * Wochentag. Alles andere ist ein `ScheduleError`.
 */
export function parseSchedule(expression: string): ParsedSchedule {
  if (typeof expression !== "string") {
    throw new ScheduleError("expression", String(expression), "A cron expression must be a string");
  }
  const trimmed = expression.trim();
  const parts = trimmed === "" ? [] : trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw new ScheduleError(
      "expression",
      trimmed,
      `Expected 5 cron fields (minute hour day-of-month month day-of-week), got ${parts.length}`,
    );
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  return Object.freeze({
    expression: parts.join(" "),
    minutes: parseField(FIELDS[0], minute),
    hours: parseField(FIELDS[1], hour),
    daysOfMonth: parseField(FIELDS[2], dayOfMonth),
    months: parseField(FIELDS[3], month),
    daysOfWeek: parseField(FIELDS[4], dayOfWeek),
    dayOfMonthRestricted: dayOfMonth !== "*",
    dayOfWeekRestricted: dayOfWeek !== "*",
  });
}

/**
 * Trifft der Plan diesen Zeitpunkt (auf die Minute genau)?
 *
 * Tagesdatum und Wochentag werden ODER-verknuepft, sobald beide eingeschraenkt
 * sind, sonst UND — die POSIX-Regel. `0 0 13 * 5` heisst also "jeder Freitag
 * und jeder 13.", nicht "jeder Freitag, der auf einen 13. faellt".
 *
 * "Eingeschraenkt" heisst hier: nicht genau `*`. Das ist die lesbare Definition
 * und nicht die von Vixie, die schon einen fuehrenden `*` als "nicht
 * eingeschraenkt" wertet — der Unterschied zeigt sich nur bei einem Stern mit
 * Schritt im Tagesdatum zusammen mit einem Wochentag, und dort ist "jeder
 * zweite Tag oder jeder Montag" die Erwartung, die man beim Lesen hat.
 */
function matchesAt(schedule: ParsedSchedule, at: Date): boolean {
  if (!schedule.minutes[at.getMinutes()]) return false;
  if (!schedule.hours[at.getHours()]) return false;
  if (!schedule.months[at.getMonth() + 1]) return false;

  const dayOfMonth = schedule.daysOfMonth[at.getDate()];
  const dayOfWeek = schedule.daysOfWeek[at.getDay()];
  if (schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted) return dayOfMonth || dayOfWeek;
  return dayOfMonth && dayOfWeek;
}

/**
 * 2921 Tage in Minuten — der groesste Abstand zwischen zwei 29. Februaren im
 * gregorianischen Kalender.
 *
 * Die Zahl ist gemessen und nicht geschaetzt: zwischen 2000 und 2400 liegt der
 * groesste Abstand bei 2096-02-29 → 2104-02-29 (der Sprung ueber das nicht
 * existierende Schaltjahr 2100), also 2921 Tage. Vier Jahre waren zu kurz —
 * `0 8 29 2 *`, von 2097 aus gerechnet, fand damit nichts, obwohl 2104
 * existiert.
 *
 * Die Grenze hat zwei Aufgaben: sie findet den entferntesten echten Treffer,
 * und sie beendet die Suche nach einem Plan, der nie trifft (`0 0 31 2 *` gibt
 * es nicht). Ein Treffer wird in dieser Frist gefunden oder gar nicht.
 *
 * Der Preis ist eine Obergrenze von {@link MAX_SCAN_MINUTES} Schritten statt
 * eines Sprungs. Das passiert nur bei einem Plan, der ueber Jahre nichts
 * findet, und nur einmal pro Tick.
 */
const MAX_SCAN_MINUTES = 2921 * 24 * 60;

/**
 * Der naechste faellige Zeitpunkt **strikt nach** `afterMs`, als Epoch-ms.
 *
 * Minute fuer Minute vorwaerts, mit der lokalen `Date`-API. Das ist absichtlich
 * die einfache Variante: die Schleife ist trivial zu pruefen, und falsch
 * gerechnete Feldarithmetik waere der teurere Fehler. Der Preis ist eine
 * Obergrenze von {@link MAX_SCAN_MINUTES} Schritten statt eines Sprungs.
 *
 * Ein Zeitpunkt genau auf einem Slot liefert den *naechsten* Slot: "nach"
 * heisst nach.
 */
export function nextRunAfter(schedule: ParsedSchedule, afterMs: number): number {
  if (!Number.isFinite(afterMs)) {
    throw new ScheduleError("expression", String(afterMs), "nextRunAfter needs a finite timestamp");
  }

  const cursor = new Date(afterMs);
  cursor.setSeconds(0, 0);
  // +1 Minute, weil die erste gepruefte Minute bereits echt nach `afterMs`
  // liegen muss: 08:00:30 hat den 08:00-Slot verpasst.
  cursor.setMinutes(cursor.getMinutes() + 1);

  for (let step = 0; step < MAX_SCAN_MINUTES; step += 1) {
    if (matchesAt(schedule, cursor)) return cursor.getTime();
    cursor.setMinutes(cursor.getMinutes() + 1);
  }

  throw new ScheduleError(
    "expression",
    schedule.expression,
    `No matching time within ${MAX_SCAN_MINUTES / 1440} days for "${schedule.expression}"`,
  );
}

/** Eine Voreinstellung fuer die Auswahl im Dialog. */
export interface SchedulePreset {
  id: string;
  /** Deutsche Beschriftung, wie die uebrigen Texte der Oberflaeche. */
  label: string;
  cron: string;
  description?: string;
}

/**
 * Die Voreinstellungen des Auswahldialogs.
 *
 * Deutsch wie der Rest der Oberflaeche (`components/CalendarView.tsx`), und die
 * Reihenfolge ist die Haeufigkeit: stuendlich und taeglich zuerst.
 */
export const SCHEDULE_PRESETS: readonly SchedulePreset[] = Object.freeze([
  { id: "hourly", label: "Stündlich", cron: "0 * * * *" },
  { id: "every-15-minutes", label: "Alle 15 Minuten", cron: "*/15 * * * *" },
  { id: "daily-0800", label: "Täglich um 08:00", cron: "0 8 * * *" },
  { id: "weekdays-0800", label: "Werktags um 08:00", cron: "0 8 * * 1-5" },
  { id: "weekly-monday-0800", label: "Montags um 08:00", cron: "0 8 * * 1" },
]);

function two(value: number): string {
  return String(value).padStart(2, "0");
}

function single(field: string): number | null {
  return /^\d+$/.test(field) ? Number(field) : null;
}

/**
 * Ein kurzer deutscher Satz fuer die Listenansicht.
 *
 * Erkannt werden die Formen, die ein Mensch auch so sagen wuerde; alles andere
 * faellt auf den rohen Ausdruck zurueck. Ein erfundener Satz fuer
 * `5,7,23 1-5 * * *` waere laenger und weniger genau als der Ausdruck selbst.
 */
export function describeSchedule(expression: string): string {
  let schedule: ParsedSchedule;
  try {
    schedule = parseSchedule(expression);
  } catch {
    // `String()` und nicht `expression.trim()`: der Wert kommt aus einem
    // Request-Body und ist zur Laufzeit nicht zwingend ein String. Die
    // Beschreibung einer kaputten Eingabe ist die Eingabe, kein Absturz.
    return String(expression).trim();
  }

  const [minuteField, hourField, dayField, monthField, weekField] = schedule.expression.split(/\s+/);
  const everyDay = dayField === "*" && monthField === "*";

  if (dayField === "*" && monthField === "*" && weekField === "*") {
    if (minuteField === "*" && hourField === "*") return "Jede Minute";

    const minuteStep = STAR_STEP.exec(minuteField);
    if (minuteStep && hourField === "*") {
      const step = Number(minuteStep[1]);
      return step === 1 ? "Jede Minute" : `Alle ${step} Minuten`;
    }

    const minute = single(minuteField);
    if (minute !== null && hourField === "*") {
      return minute === 0 ? "Stündlich" : `Stündlich zur Minute ${two(minute)}`;
    }
  }

  const minute = single(minuteField);
  const hour = single(hourField);
  if (minute === null || hour === null || !everyDay) return schedule.expression;

  const time = `${two(hour)}:${two(minute)}`;

  if (weekField === "*") return `Täglich um ${time}`;
  if (weekField === "1-5") return `Werktags um ${time}`;

  const weekdays = weekField.split(",").map((day) => single(day));
  if (weekdays.length === 1 && weekdays[0] !== null) {
    // `GERMAN_WEEKDAYS` beginnt am Montag, Cron bei Sonntag.
    const name = GERMAN_WEEKDAYS[((weekdays[0] % 7) + 6) % 7];
    return `${name}s um ${time}`;
  }

  return schedule.expression;
}
