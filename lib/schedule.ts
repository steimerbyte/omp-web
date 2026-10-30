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
 * Kann dieser Plan ueberhaupt jemals treffen?
 *
 * Die Suche in {@link nextRunAfter} findet einen Treffer oder laeuft
 * {@link MAX_SCAN_MINUTES} Minuten lang vergeblich. Fuer einen Ausdruck wie
 * `0 0 31 2 *` ist das reine Rechenzeit: der 31. Februar existiert in keinem
 * Jahr. Gemessen kostete ein solcher Aufruf 208-261 ms — synchron, also
 * blockierend, und zwar einmal pro `GET` und zweimal pro Takt.
 *
 * Diese Funktion beantwortet die Frage vorher, aus den Feldmasken statt aus
 * dem Kalender: ein Plan ist unerfuellbar, wenn **kein** Monat im Monatsfeld
 * einen Tag im Tagesdatum-Feld hat, den es in diesem Monat gibt.
 *
 * ### Warum nur bei freiem Wochentag
 *
 * POSIX verknuepft Tagesdatum und Wochentag mit ODER, sobald beide
 * eingeschraenkt sind (siehe {@link matchesAt}). `0 0 31 2 1` heisst danach
 * "jeder Montag im Februar **oder** jeder 31. Februar" — und der Montagsteil
 * trifft. Ein Test, der das Tagesdatum allein ansieht, wuerde diesen Plan
 * faelschlich fuer tot erklaeren und die Aufgabe nie wieder laufen lassen.
 * Deshalb gilt die Aussage nur, wenn der Wochentag genau `*` ist: dann ist die
 * Verknuepfung UND, und ein Tagesdatum ohne echten Kalendertag ist wirklich
 * das Ende.
 *
 * Der Februar ist der einzige Monat, in dem die Antwort von der Jahreszahl
 * abhaengt (29). Er zaehlt hier als "hat den 29.", weil es Jahre mit dem 29.
 * Februar gibt; `0 8 29 2 *` ist damit erfuellbar, und zwar im naechsten
 * Schaltjahr — genau das findet die Suche auch.
 *
 * Die uebrigen Felder koennen die Frage nicht toeten: Minuten und Stunden
 * haben immer mindestens einen Eintrag, weil `parseField` einen leeren Ausdruck
 * gar nicht erst zulaesst.
 */
export function isUnsatisfiable(schedule: ParsedSchedule): boolean {
  // Ein eingeschraenkter Wochentag rettet jeden toten Kalendertag (ODER-Regel);
  // dann ist die Frage nicht "nie", sondern "irgendwann ein Montag".
  if (schedule.dayOfWeekRestricted) return false;

  return !monthHasAnyListedDay(schedule);
}

/**
 * Gibt es einen Monat, in dem mindestens ein aufgefuehrtes Tagesdatum existiert?
 *
 * Die Laengen sind die groessten, die der Monat je hat: der Februar bekommt 29,
 * weil ein Schaltjahr zaehlt. Ein Tagesdatum, das nur im Februar fehlt (30.,
 * 31.), macht den Plan nicht tot, solange ein anderer Monat es hat.
 */
function monthHasAnyListedDay(schedule: ParsedSchedule): boolean {
  const longestDay = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (let month = 1; month <= 12; month += 1) {
    if (!schedule.months[month]) continue;
    for (let day = 1; day <= longestDay[month]; day += 1) {
      if (schedule.daysOfMonth[day]) return true;
    }
  }
  return false;
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
 *
 * Ein nie treffender Ausdruck wird **vorher** erkannt: {@link isUnsatisfiable}
 * beantwortet die Frage aus den Feldmasken, und {@link nextRunAfter} wirft
 * dann sofort, statt 4,2 Mio. Minuten abzulaufen. Gemessen kostete `0 0 31 2 *`
 * vorher 208-261 ms pro Aufruf, synchron in der Route; nachher liegt der
 * Aufruf im Mikrosekundenbereich.
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
  // Vor der Suche, nicht nach ihr: ein Plan, der nie trifft, soll nicht
  // 4,2 Mio. Minuten lang geprueft werden, um dasselbe Ergebnis zu finden.
  if (isUnsatisfiable(schedule)) {
    // Dieselbe Meldung wie am Ende der Suche, und sie stimmt auch hier: gibt es
    // nie einen Treffer, gibt es ihn erst recht nicht innerhalb der Frist. Der
    // Aufrufer (und der bestehende Test) sieht keinen Unterschied ausser der
    // Antwortzeit.
    throw new ScheduleError(
      "expression",
      schedule.expression,
      `No matching time within ${MAX_SCAN_MINUTES / 1440} days for "${schedule.expression}"`,
    );
  }
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
  /**
   * Der Schluessel der Beschriftung im Sprachpaket, ohne Namensraum.
   *
   * Der Katalog-Schluessel ist `scheduled.<labelKey>`. Ein fertiger Satz
   * waere hier falsch: dieses Modul ist rein, kennt keine Sprache der
   * Oberflaeche und darf keine deutsche Zeile in ein englisches Interface
   * tragen.
   */
  labelKey: string;
  cron: string;
}

/**
 * Die Voreinstellungen des Auswahldialogs.
 *
 * Die Reihenfolge ist die Haeufigkeit: stuendlich und taeglich zuerst. Die
 * Zuordnung `id → cron` ist eine Zusicherung und wird von `schedule.test.mjs`
 * festgehalten — ein Preset, das etwas anderes erzeugt als sein Name sagt,
 * legt eine Aufgabe fuer eine Zeit an, die niemand gewaehlt hat.
 */
export const SCHEDULE_PRESETS: readonly SchedulePreset[] = Object.freeze([
  { id: "hourly", labelKey: "presetHourly", cron: "0 * * * *" },
  { id: "every-15-minutes", labelKey: "presetEvery15Minutes", cron: "*/15 * * * *" },
  { id: "daily-0800", labelKey: "presetDaily", cron: "0 8 * * *" },
  { id: "weekdays-0800", labelKey: "presetWeekdays", cron: "0 8 * * 1-5" },
  { id: "weekly-monday-0800", labelKey: "presetWeeklyMonday", cron: "0 8 * * 1" },
]);

function single(field: string): number | null {
  return /^\d+$/.test(field) ? Number(field) : null;
}

/**
 * Ein erkanntes Muster eines Zeitplans — **ohne Text**.
 *
 * Die Beschreibung eines Cron-Ausdrucks gehoert nicht hierher: dieses Modul
 * ist rein und sprachlos, die Oberflaeche hat drei Kataloge. Ein fertiger
 * deutscher Satz waere in einer englischen oder chinesischen Oberflaeche
 * schlicht falsch. Die Form ist deshalb ein Deskriptor, den die Ansicht
 * ueber `t(...)` in ihre Sprache bringt.
 *
 * `custom` heisst: der Ausdruck ist gueltig, aber keiner der Formen, die ein
 * Mensch so sagen wuerde. Dann ist der Ausdruck selbst die beste Beschreibung.
 */
export type ScheduleDescription =
  /** Jede Minute (`* * * * *`). */
  | { kind: "everyMinute" }
  /** Alle `step` Minuten (Stern mit Schritt im Minutenfeld). */
  | { kind: "everyMinutes"; step: number }
  /** Jede Stunde, zu einer festen Minute (`m * * * *`). */
  | { kind: "hourly"; minute: number }
  /** Taeglich zu einer festen Zeit (`m h * * *`). */
  | { kind: "daily"; hour: number; minute: number }
  /** Montag bis Freitag zu einer festen Zeit (`m h * * 1-5`). */
  | { kind: "weekdays"; hour: number; minute: number }
  /** Ein einzelner Wochentag zu einer festen Zeit (`m h * * d`). */
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  /** Gueltig, aber nicht in Worten beschreibbar — der Ausdruck selbst. */
  | { kind: "custom"; expression: string };

/**
 * Was der Ausdruck bedeutet, als Deskriptor — oder `null`, wenn er ungueltig ist.
 *
 * `weekday` ist `0` bis `6` mit `0` = Sonntag, wie `Date#getDay`: die
 * Ansicht waehlt daraus den Namen aus ihrem Katalog.
 */
export function describeSchedule(expression: string): ScheduleDescription | null {
  let schedule: ParsedSchedule;
  try {
    schedule = parseSchedule(expression);
  } catch {
    // Ein kaputter Ausdruck hat keine Bedeutung; die Ansicht zeigt das Feld
    // rot und gar keine Beschreibung. `String()` waere hier eine erfundene
    // Antwort auf eine ungueltige Frage.
    return null;
  }

  const [minuteField, hourField, dayField, monthField, weekField] = schedule.expression.split(/\s+/);
  const everyDay = dayField === "*" && monthField === "*";

  if (dayField === "*" && monthField === "*" && weekField === "*") {
    if (minuteField === "*" && hourField === "*") return { kind: "everyMinute" };

    const minuteStep = STAR_STEP.exec(minuteField);
    if (minuteStep && hourField === "*") {
      const step = Number(minuteStep[1]);
      return step === 1 ? { kind: "everyMinute" } : { kind: "everyMinutes", step };
    }

    const minute = single(minuteField);
    if (minute !== null && hourField === "*") return { kind: "hourly", minute };
  }

  const minute = single(minuteField);
  const hour = single(hourField);
  if (minute === null || hour === null || !everyDay) return { kind: "custom", expression: schedule.expression };

  if (weekField === "*") return { kind: "daily", hour, minute };
  if (weekField === "1-5") return { kind: "weekdays", hour, minute };

  const weekdays = weekField.split(",").map((day) => single(day));
  if (weekdays.length === 1 && weekdays[0] !== null) {
    // Cron kennt 0 und 7 als Sonntag; der Deskriptor traegt nur `Date#getDay`.
    return { kind: "weekly", weekday: weekdays[0] % 7, hour, minute };
  }

  return { kind: "custom", expression: schedule.expression };
}
