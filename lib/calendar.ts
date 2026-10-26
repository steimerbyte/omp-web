/**
 * Kalender-Domaene: Ereignismodell, Validierung und die deutsche Kalenderlogik.
 *
 * ### Warum dieses Modul ohne `fs` und ohne `fetch` auskommt
 *
 * Dieselbe Trennung wie in `lib/quick-phrases.ts`: die Form (was ein gueltiger
 * Termin ist) gehoert in eine Datei, die der Browser *und* der Server laden
 * koennen, ohne dass der Server-Only-Code in das Browser-Bundle wandert. Das
 * ist hier nicht Kosmetik: die Ganztags-Logik, die ISO-Kalenderwoche und die
 * Feiertagsberechnung muessen in der Oberflaeche und im Agent-Tool *dieselbe*
 * Antwort geben. Eine zweite Kopie dieser Logik im Client waere die uebliche
 * Stelle, an der sich beide unterscheiden.
 *
 * ### Die Zeitform
 *
 * Termine liegen als **lokale** Zeit ohne Zone: `"2026-03-14"` fuer einen
 * Ganztagestermin und `"2026-03-14T15:00"` fuer einen mit Uhrzeit. Kein
 * `Z`, kein Offset.
 *
 * Das ist eine bewusste Entscheidung und keine Nachlaessigkeit. Ein Kalender
 * zeigt Termine in der Zeitzone des Nutzers an, der sie liest — nicht in der
 * des Servers und nicht in der des Browsers, der sie gespeichert hat. Ein
 * gespeicherter Offset muesste beim Lesen in die Zeitzone des Lesers
 * umgerechnet werden, und genau an dieser Stelle faengt ein Kalender an, zur
 * falschen Zeit zu stehen. Ohne Zone gibt es nichts umzurechnen: der String
 * bedeutet in jedem Prozess dasselbe, namely "halb drei an diesem Tag".
 *
 * Der Preis ist ehrlich benannt: ein Termin, den ein Agent ueber eine
 * Schnittstelle in einer anderen Zone anlegt, traegt *diese* Zeit ein, nicht
 * die Zeit des Agenten. Das ist bei einem Kalender, den ein Mensch liest, das
 * richtige Verhalten — die Frage "wann ist es" beantwortet der Kalender, nicht
 * der Prozess, der die Datei schreibt.
 */

/** Ein Termin im Kalender. */
export interface CalendarEvent {
  /** Stabile Kennung; vom Server vergeben, nie vom Client erfunden. */
  id: string;
  /** Der Titel. Leer ist ungueltig — ein Termin ohne Titel ist kein Termin. */
  title: string;
  /** Optionale Notiz. */
  description?: string;
  /** Optionaler Ort. */
  location?: string;
  /**
   * Beginn, lokal und ohne Zone: `"2026-03-14"` (Ganztag) oder
   * `"2026-03-14T15:00"`.
   */
  start: string;
  /**
   * Ende, im selben Format wie `start`. Bei einem Ganztagestermin ist das
   * Ende **der letzte Tag** (einschliesslich), nicht der erste Tag danach.
   * Das entspricht der Erwartung im Kalender ("der Termin ist am 14. und am
   * 15.") und der Darstellung in der Monatsansicht, in der ein Ganztagestermin
   * an beiden Tagen als Block erscheint.
   */
  end: string;
  /** `true` heisst Ganztagestermin: der Termin belegt den ganzen Tag. */
  allDay: boolean;
  /**
   * Die Farbe des Termins: ein Preset-Name (`accent`, `success`, ...) oder
   * ein Hex-Code (`#ff00aa`). Ohne diese Angabe traegt der Termin die
   * Voreinstellung (Akzent).
   *
   * Der Wert ist *Datenhaltung*, nicht Anzeige: ein Termin, den der Nutzer
   * farblich markiert hat, soll seine Farbe auch behalten, wenn das Theme
   * wechselt. Deshalb steht hier der Hex-Code des Termins und nicht der
   * Name einer Theme-Variable.
   */
  color?: string;
  /** Erstellzeitpunkt (ISO mit Zone) — fuer die Sortierung im Protokoll. */
  createdAt: string;
  /** Letzte Aenderung (ISO mit Zone). */
  updatedAt: string;
}

/** Die hoechste Anzahl Termine in einer Kalenderdatei. */
export const MAX_CALENDAR_EVENTS = 5000;

/** Die laengste erlaubte Titellaenge. */
export const MAX_TITLE_LENGTH = 300;

/** Die laengste erlaubte Laenge fuer Notiz und Ort. */
export const MAX_TEXT_LENGTH = 4000;

/**
 * Die Preset-Farben, die ein Termin tragen kann. Die Reihenfolge ist die
 * Anzeigereihenfolge.
 *
 * ### Warum jede Preset-Farbe eine CSS-Variable ist
 *
 * `AGENTS.md` verbietet Farbliterale im Code: `applyOmpPalette` schreibt die
 * Variablen zur Laufzeit um, und ein festes `#1f8b4c` in einer Kachel bleibt
 * in einem importierten Theme das alte Blaugruen. Jede Preset-Farbe hier ist
 * deshalb ein *Name*, und die Oberflaeche uebersetzt den Namen in eine
 * Variable des aktiven Themes. Ein Preset sieht in hell und dunkel also
 * richtig aus und folgt dem Theme wie der Rest der Oberflaeche.
 */
export const CALENDAR_COLOR_PRESETS = [
  "accent",
  "success",
  "warning",
  "danger",
  "violet",
] as const;

/** Eine der Preset-Farben eines Termins. */
export type CalendarColorPreset = (typeof CALENDAR_COLOR_PRESETS)[number];

/**
 * Die Farbe, die ein Termin bekommt, wenn keine genannt wurde.
 *
 * Der Akzent ist die Farbe der Anwendung selbst: ein Termin ohne eigene
 * Farbe faellt im Kalender nicht auf, und genau das will der Nutzer in der
 * Regel.
 */
export const DEFAULT_CALENDAR_COLOR: CalendarColorPreset = "accent";

/**
 * Die CSS-Variable, in der die Preset-Farbe eines Termins steht.
 *
 * Die Zuordnung gehoert hierher und nicht in die Oberflaeche: die Werkzeuge
 * (Agent) und die Oberflaeche brauchen dieselbe Farbe fuer denselben Termin,
 * und eine Farbe, die nur in der Oberflaeche existiert, waere an zwei Stellen
 * definiert.
 */
export const CALENDAR_COLOR_VARIABLES: Record<CalendarColorPreset, string> = {
  accent: "var(--accent)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--danger)",
  violet: "var(--violet)",
};

/** `true`, wenn der Wert eine der Preset-Farben ist. */
export function isCalendarColorPreset(value: unknown): value is CalendarColorPreset {
  return typeof value === "string" && (CALENDAR_COLOR_PRESETS as readonly string[]).includes(value);
}

/**
 * Die deutschen Namen der Preset-Farben.
 *
 * ### Warum sie hier stehen und nicht im i18n-Katalog
 *
 * Wie die Monats- und Wochentagsnamen: es ist ein festes Vokabular des
 * Kalenders, das in jeder Sprache des Programms deutsch ist — der Kalender
 * ist ein deutscher Kalender. Der i18n-Katalog ist der Katalog der
 * *Oberflaeche* und haengt an der eingestellten Sprache.
 *
 * Und sie muessen fuer zwei Seiten reichen: die Dialog-Komponente (Client)
 * und die Werkzeug-Ausgabe (Server) nennen dieselben fuenf Farben. Eine
 * Konstante in `lib/calendar-tool.ts` koennte der Client nicht importieren
 * (die Datei zieht `fs` ueber den Store), und ein i18n-Schluessel koennte
 * das Server-Werkzeug nicht ohne das gesamte Sprachpaket aufloesen.
 */
export const CALENDAR_COLOR_PRESET_LABELS: Record<CalendarColorPreset, string> = {
  accent: "Akzent",
  success: "Erfolg",
  warning: "Warnung",
  danger: "Gefahr",
  violet: "Violett",
};

/**
 * Ein Hex-Farbcode — `#rgb` oder `#rrggbb`.
 *
 * ### Warum die kurze Form zulaessig ist
 *
 * `#f0a` ist eine gaengige Schreibweise, und wer sie im Dialog eintippt,
 * meint dieselbe Farbe wie bei `#ff00aa`. Deshalb wird sie erkannt und auf
 * die lange Form gebracht (siehe `normalizeCalendarColor`).
 */
const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `true`, wenn der Wert ein Hex-Farbcode ist. */
export function isCalendarHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value.trim());
}

/**
 * Bringt eine Farbangabe in die Form, in der sie gespeichert wird.
 *
 * ### Warum genau eine Form gespeichert wird
 *
 * Gespeichert wird ein Preset-Name (`accent`) oder ein Hex-Code in genau
 * einer Schreibweise: klein und sechs Stellen (`#ff00aa`). Zwei Schreibweisen
 * derselben Farbe wuerden in der Datei zwei verschiedene Termine ergeben —
 * `#f0a` und `#ff00aa` waeren fuer den Vergleich zwei Farben, obwohl sie
 * eine sind. Der Vergleich bleibt dadurch eindeutig, und die Form ist
 * zugleich die, die der Farbwähler des Browsers liefert.
 *
 * @returns Der Preset-Name, der Hex-Code in kanonischer Form — oder
 * `undefined`, wenn die Angabe keine Farbe ist.
 */
export function normalizeCalendarColor(value: unknown): string | undefined {
  if (isCalendarColorPreset(value)) return value;
  if (!isCalendarHexColor(value)) return undefined;
  const hex = value.trim().slice(1).toLowerCase();
  const long = hex.length === 3 ? hex.split("").map((digit) => digit + digit).join("") : hex;
  return `#${long}`;
}

/**
 * Die Farbe, mit der ein Termin gezeichnet wird.
 *
 * ### Warum die Aufloesung im Domaenenmodell steht
 *
 * Die Werkzeuge (Agent) und die Oberflaeche zeigen denselben Termin. Wer die
 * Farbe an beiden Stellen getrennt aufloest, zeigt dem Nutzer im Chat eine
 * andere Farbe als im Kalender. Die Aufloesung gehoert deshalb in das
 * Domaenenmodell, das beide Seiten benutzen.
 *
 * @returns Die CSS-Variable eines Presets, der Hex-Code einer eigenen Farbe
 * — oder die Voreinstellung, wenn der Termin keine Farbe traegt.
 */
export function resolveEventColor(event: { color?: unknown }): string {
  const color = normalizeCalendarColor(event?.color);
  if (color === undefined) return CALENDAR_COLOR_VARIABLES[DEFAULT_CALENDAR_COLOR];
  if (isCalendarColorPreset(color)) return CALENDAR_COLOR_VARIABLES[color];
  return color;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** `true`, wenn der String ein gueltiges Kalenderdatum ist. */
export function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  return true;
}

/** `true`, wenn der String ein gueltiger Kalenderzeitpunkt ohne Zone ist. */
export function isCalendarDateTime(value: string): boolean {
  if (!DATE_TIME_PATTERN.test(value)) return false;
  const [datePart, timePart] = value.split("T");
  if (!isCalendarDate(datePart)) return false;
  const [hours, minutes] = timePart.split(":").map(Number);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

/** Die Zahl der Tage im Monat — Schalttage inklusive. */
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Wandelt ein Datum ohne Zone in die Zahl der Sekunden seit Mitternacht.
 *
 * Bewusst `Date.UTC` und nicht `new Date(...)`: die lokale Datumskonstruktion
 * von `Date` wertet die lokale Zeitzone aus, und damit wuerde derselbe String
 * in zwei Prozessen mit不同 Zeitzonen zwei verschiedene Zahlen liefern. Die
 * Kalenderlogik rechnet in *Wandkalender*-Zeit, nicht in UTC.
 */
export function dateToDayNumber(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

/** Das Gegenstueck zu `dateToDayNumber`: die Zahl zurueck in ein Datum. */
export function dayNumberToDate(dayNumber: number): string {
  const date = new Date(dayNumber * 86_400_000);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Die Zahl der Minuten seit Mitternacht eines Kalenderzeitpunkts. */
export function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

/** Das Gegenstueck zu `timeToMinutes`. */
export function minutesToTime(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(normalized / 60))}:${pad2(normalized % 60)}`;
}

/** Zwei Ziffern mit fuehrender Null. */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Der Montag der Woche, in der das Datum liegt.
 *
 * Die deutsche Woche beginnt am Montag — nicht am Sonntag wie in den
 * angelsaechsischen Kalendern und nicht am Samstag wie im Kalender der
 * Buchhaltung. Der Wochentag als Zahl ist daher 0 = Montag bis 6 = Sonntag.
 */
export function startOfWeek(date: string): string {
  const dayNumber = dateToDayNumber(date);
  // `Date.UTC(1970, 0, 1)` war ein Donnerstag, also liegt der Montag der
  // Woche um den 4. Tag davor. Der Rest faengt negative Werte ab.
  const offset = (((dayNumber + 3) % 7) + 7) % 7;
  return dayNumberToDate(dayNumber - offset);
}

/** Der Wochentag als Zahl: 0 = Montag bis 6 = Sonntag. */
export function weekdayIndex(date: string): number {
  const dayNumber = dateToDayNumber(date);
  return (((dayNumber + 3) % 7) + 7) % 7;
}

/** Das Datum `amount` Tage nach `date`. */
export function addDays(date: string, amount: number): string {
  return dayNumberToDate(dateToDayNumber(date) + amount);
}

/** Der erste Tag des Monats, in dem `date` liegt. */
export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/**
 * Die ISO-Kalenderwoche von `date`.
 *
 * ISO 8601, nicht die amerikanische Woche: die Woche beginnt am Montag, und
 * die erste Woche des Jahres ist die, in der der 4. Januar liegt. Der 1. Januar
 * 2021 gehoert damit zu KW 53 des Jahres 2020 — die Woche mit 52 oder 53
 * Tagen, die ein Jahr mit 53 Wochen hat.
 */
export function isoWeek(date: string): { year: number; week: number } {
  // Der Donnerstag der aktuellen Woche bestimmt das Jahr der Woche. Das ist
  // der Grund, warum ISO 8601 ueberhaupt den Donnerstag bemuht: der 1. Januar
  // kann in der letzten Woche des Vorjahres liegen, und der Donnerstag dieser
  // Woche liegt dann noch im Vorjahr — die Woche gehoert also zum Vorjahr,
  // obwohl sie fast vollstaendig im neuen Jahr liegt.
  const thursday = addDays(date, 3 - weekdayIndex(date));
  const thursdayYear = Number(thursday.slice(0, 4));
  const week1Thursday = firstThursdayOfYear(thursdayYear);
  const week = Math.round((dateToDayNumber(thursday) - dateToDayNumber(week1Thursday)) / 7) + 1;
  return { year: thursdayYear, week };
}

/**
 * Der Donnerstag der ersten Woche des Jahres.
 *
 * Die erste Woche ist nach ISO 8601 die Woche, in der der **4. Januar**
 * liegt. Ihr Donnerstag ist deshalb nicht "der erste Donnerstag des Jahres",
 * sondern der Donnerstag der Woche, die den 4. Januar enthaelt — und der kann
 * noch im Vorjahr liegen (2026: der 4. Januar ist ein Sonntag, die Woche
 * beginnt am 29. Dezember 2025, ihr Donnerstag ist der 1. Januar 2026).
 *
 * Deshalb wird hier nicht der 4. Januar verschoben, sondern der *Montag* der
 * Woche, in der der 4. Januar liegt, plus drei Tage.
 */
function firstThursdayOfYear(year: number): string {
  const mondayOfWeek1 = startOfWeek(`${year}-01-04`);
  return addDays(mondayOfWeek1, 3);
}

/** Die Nummer der Kalenderwoche — kurz, wie sie in Deutschland notiert wird. */
export function isoWeekNumber(date: string): number {
  return isoWeek(date).week;
}

/**
 * Die deutschen Feiertage eines Jahres.
 *
 * ### Warum das eine eigene Berechnung ist
 *
 * Die beweglichen Feiertage (Karfreitag, Ostermontag, Christi Himmelfahrt,
 * Pfingstmontag) haengen am Ostersonntag. Der gaengige Trick ist die
 * Gauss-Formel fuer das Osterdatum; sie ist seit 1583 in Gebrauch und gilt
 * fuer die katholische und die protestantische Kirche gleichermassen, weil
 * beide das gregorianische Osterdatum benutzen. Fuer einen deutschen
 * Arbeitskalender ist das genau richtig.
 *
 * ### Bewusst *nicht* enthalten
 *
 * Bundeslaenderspezifische Feiertage (Fronleichnam, Dreikönig,
 * Mariä Himmelfahrt, Buß- und Bettag, ...) fehlen. Sie haengen am
 * Bundesland, und ein Kalender ohne Bundesland-Auswahl kann sie nicht
 * zutreffend anzeigen. Ein falscher Feiertag ist schlimmer als ein fehlender,
 * deshalb bleiben sie weg, bis der Kalender eine Auswahl kennt.
 */
export function germanHolidays(year: number): Map<string, string> {
  const holidays = new Map<string, string>();
  const easter = easterSunday(year);

  holidays.set(`${year}-01-01`, "Neujahr");
  holidays.set(addDays(easter, -2), "Karfreitag");
  holidays.set(addDays(easter, 1), "Ostermontag");
  holidays.set(`${year}-05-01`, "Tag der Arbeit");
  holidays.set(addDays(easter, 39), "Christi Himmelfahrt");
  holidays.set(addDays(easter, 50), "Pfingstmontag");
  holidays.set(`${year}-10-03`, "Tag der Deutschen Einheit");
  holidays.set(`${year}-12-25`, "1. Weihnachtstag");
  holidays.set(`${year}-12-26`, "2. Weihnachtstag");

  return holidays;
}

/**
 * Das Osterdatum nach der Gauss-Formel.
 *
 * `month` und `day` beziehen sich auf den *Maerz*, in dem das Osterfest immer
 * liegt (der frueheste Fall ist der 22. Maerz, der spaeteste der 25. April).
 */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** `true`, wenn der Tag ein Feiertag im Jahr des Datums ist. */
export function isGermanHoliday(date: string): string | null {
  const year = Number(date.slice(0, 4));
  return germanHolidays(year).get(date) ?? null;
}

/**
 * Die deutschen Monatsnamen.
 *
 * Fest im Modul, nicht aus `Intl` geholt: `Intl.DateTimeFormat` liefert die
 * Namen in der Sprache der *Umgebung*, und die Umgebung des Servers ist nicht
 * die des Nutzers. Ein deutscher Kalender, dessen Monatsnamen zwischen Server
 * und Browser springen, ist kein deutscher Kalender.
 */
export const GERMAN_MONTHS = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
] as const;

/** Die deutschen Monatsnamen in der Kurzform, wie sie in der Kopfzeile stehen. */
export const GERMAN_MONTHS_SHORT = [
  "Jan", "Feb", "Mär", "Apr", "Mai", "Jun",
  "Jul", "Aug", "Sep", "Okt", "Nov", "Dez",
] as const;

/** Die deutschen Wochentage, lang. Montag ist der erste Tag. */
export const GERMAN_WEEKDAYS = [
  "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag",
] as const;

/** Die deutschen Wochentage in der Kurzform. */
export const GERMAN_WEEKDAYS_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as const;

/** Die deutschen Wochentage in der Zweibuchstabenform, wie sie in einem Kalenderkopf stehen. */
export const GERMAN_WEEKDAYS_MIN = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as const;

/** Der deutsche Wochentagsname eines Datums. */
export function germanWeekdayName(date: string): string {
  return GERMAN_WEEKDAYS[weekdayIndex(date)];
}

/** Der deutsche Monatsname eines Datums. */
export function germanMonthName(date: string): string {
  return GERMAN_MONTHS[Number(date.slice(5, 7)) - 1];
}

/**
 * Das Datum im deutschen Format: `14.03.2026`.
 *
 * `Intl` mit `de-DE` wuerde dasselbe liefern, aber es haengt an der
 * Verfuegbarkeit der ICU-Daten in der Laufzeitumgebung. Der Server laeuft
 * unter Bun, der Browser unter Chromium — beide haben ICU, aber nicht zwingend
 * dieselbe Version. Eine Ausgabe, die auf einem Rechner mit duenner ICU leer
 * bleibt, ist schlimmer als eine eigene Formatierung.
 */
export function formatGermanDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${day}.${month}.${year}`;
}

/** Der Monat und das Jahr in deutscher Schreibweise: `März 2026`. */
export function formatGermanMonthYear(date: string): string {
  return `${germanMonthName(date)} ${date.slice(0, 4)}`;
}

/** Die Zeit im deutschen Format: `15:00`. */
export function formatGermanTime(time: string): string {
  return time;
}

/** Das Datum mit Zeit in deutscher Schreibweise: `14.03.2026, 15:00`. */
export function formatGermanDateTime(start: string): string {
  if (!start.includes("T")) return formatGermanDate(start);
  const [date, time] = start.split("T");
  return `${formatGermanDate(date)}, ${formatGermanTime(time)}`;
}

/**
 * Die Ziffern eines Textes — ohne Buchstaben und ohne alles andere.
 *
 * Buchstaben fliegen raus, statt den Wert unbrauchbar zu machen: wer
 * versehentlich "1a5" tippt, meint "15" und soll nicht an einem Tastendruck
 * scheitern.
 */
export function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Die Ziffern und der Doppelpunkt einer Uhrzeit-Eingabe.
 *
 * Der Doppelpunkt bleibt, weil er Stunde und Minute trennt; alles andere
 * fliegt raus.
 */
export function sanitizeTimeInput(value: string): string {
  return value.replace(/[^\d:]/g, "");
}

/**
 * Die Ziffern und die Punkte einer Datumseingabe.
 *
 * Der Punkt bleibt, weil er Tag, Monat und Jahr trennt; alles andere fliegt
 * raus.
 */
export function sanitizeDateInput(value: string): string {
  return value.replace(/[^\d.]/g, "");
}

/**
 * Die Ziffern und der Raute einer Hex-Farb-Eingabe.
 *
 * Alles, was kein Hex-Zeichen ist, fliegt raus — sonst koennte ein
 * Farbcode nicht als Farbcode erkannt werden.
 */
export function sanitizeHexInput(value: string): string {
  return value.replace(/[^0-9a-fA-F#]/g, "");
}

/**
 * Die kanonische Form `HH:MM` einer Uhrzeit-Eingabe — oder `null`.
 *
 * ### Was der Nutzer tippen darf
 *
 * `15`, `15:0` und `15:00` sind alle gueltig und ergeben `15:00`. Ein
 * Doppelpunkt trennt Stunde und Minute; ohne ihn fuellen die Ziffern erst
 * die Stunde und dann die Minute, von links nach rechts. So ist `15:3`
 * `15:03` und `1530` ist `15:30`.
 *
 * ### Warum die Form kanonisch ist
 *
 * Der Kalender speichert `HH:MM` — ohne Sekunden, ohne Zone, ohne
 * fuehrende Nullen beim Wert. Jede Eingabe, die zu derselben Zeit fuehrt,
 * ergibt deshalb dieselbe Zeichenkette: `15`, `15:0` und `15:00` sind alle
 * `15:00`. Ohne diese Regel haette dieselbe Uhrzeit je nach Eingabe zwei
 * Formen, und der Vergleich zweier Termine waere unmoeglich.
 *
 * @returns `HH:MM`, oder `null`, wenn die Eingabe keine Uhrzeit ist.
 */
export function normalizeTimeInput(value: string): string | null {
  const parts = value.split(":");
  if (parts.length > 2) return null;
  let hours = digitsOf(parts[0] ?? "");
  let minutes = digitsOf(parts[1] ?? "");
  if (parts.length === 1 && hours.length > 2) {
    // Ohne Doppelpunkt fuellen die Ziffern erst die Stunde, dann die Minute.
    minutes = hours.slice(2);
    hours = hours.slice(0, 2);
  }
  if (hours.length === 0 || hours.length > 2) return null;
  if (minutes.length > 2) return null;
  const hourValue = Number(hours);
  const minuteValue = minutes === "" ? 0 : Number(minutes);
  if (hourValue > 23 || minuteValue > 59) return null;
  return `${pad2(hourValue)}:${pad2(minuteValue)}`;
}

/**
 * Die kanonische Form `YYYY-MM-DD` einer deutschen Datumseingabe — oder
 * `null`.
 *
 * `14.3.2026` und `14.03.2026` ergeben beide `2026-03-14`. Das Datum wird
 * in der Form gespeichert, in der der Kalender es ohnehin rechnet; der
 * Doppelpunkt gehoert zur Eingabe, nicht zum Termin.
 *
 * @returns `YYYY-MM-DD`, oder `null`, wenn die Eingabe kein Datum ist.
 */
export function normalizeDateInput(value: string): string | null {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const day = digitsOf(parts[0] ?? "");
  const month = digitsOf(parts[1] ?? "");
  const year = digitsOf(parts[2] ?? "");
  if (day.length === 0 || day.length > 2) return null;
  if (month.length === 0 || month.length > 2) return null;
  if (year.length !== 4) return null;
  const iso = `${year}-${pad2(Number(month))}-${pad2(Number(day))}`;
  return isCalendarDate(iso) ? iso : null;
}

/**
 * Das Kalenderblatt eines Monats: sechs Wochen x sieben Tage.
 *
 * ### Warum sechs Wochen und nicht vier oder fünf
 *
 * Die Zahl der Wochen, die ein Monat ueberdeckt, haengt davon ab, an welchem
 * Wochentag der Erste faellt. Im Extremfall braucht ein 28-Tage-Februar, der
 * an einem Montag beginnt, genau vier Wochen, und ein 31-Tage-Maerz, der an
 * einem Sonntag beginnt, sechs. Eine Tabelle, die ihre Hoehe mit dem Monat
 * veraendert, springt beim Blättern — und ein Kalender, der springt, ist
 * unbrauchbar, weil man beim Wechseln den falschen Termin anfasst.
 *
 * Deshalb ist die Hoehe konstant sechs Wochen. Der letzte Tag eines Monats
 * rutscht dadurch sometimes in die letzte Woche, und die Tage des
 * Nachbarmonats sind an den Raendern sichtbar. Das ist genau so, wie es ein
 * ausgedruckter deutscher Kalender macht.
 */
export function buildMonthGrid(anchorDate: string): string[] {
  const first = startOfMonth(anchorDate);
  const gridStart = startOfWeek(first);
  const days: string[] = [];
  for (let i = 0; i < 42; i++) {
    days.push(addDays(gridStart, i));
  }
  return days;
}

/** Die sieben Tage der Woche, in der `date` liegt. */
export function buildWeekGrid(anchorDate: string): string[] {
  const start = startOfWeek(anchorDate);
  const days: string[] = [];
  for (let i = 0; i < 7; i++) {
    days.push(addDays(start, i));
  }
  return days;
}

/**
 * Die Wochenstunden einer Tagesansicht: 0 bis 24 Uhr.
 *
 * Die Obergrenze ist 24, damit ein Termin, der bis Mitternacht laeuft, noch
 * eine Zeile hat, in der er sichtbar ist.
 */
export const HOURS_PER_DAY = 24;

/**
 * Die Positionen eines Termins in der Tages- oder Wochenansicht.
 *
 * `startMinute` und `endMinute` sind Minuten seit Mitternacht; `top` und
 * `height` sind in Minuten, damit die Oberflaeche sie durch `px`-Faktoren
 * umrechnen kann.
 */
export interface EventPosition {
  top: number;
  height: number;
  startMinute: number;
  endMinute: number;
}

/**
 * Die Position eines Termins innerhalb eines Tages.
 *
 * Ein Ganztagestermin hat in der Tagesansicht keine Zeitachse — er belegt den
 * ganzen Tag. Fuer die Tagesansicht liefert diese Funktion deshalb
 * `null`, und die Oberflaeche zeigt Ganztagestermine in einer eigenen Leiste
 * ueber dem Raster.
 */
export function eventPosition(start: string, end: string): EventPosition | null {
  if (!start.includes("T") || !end.includes("T")) return null;
  const startMinute = timeToMinutes(start.split("T")[1]);
  const startDay = dateToDayNumber(start.slice(0, 10));
  const endDay = dateToDayNumber(end.slice(0, 10));
  const rawEndMinute = timeToMinutes(end.split("T")[1]);

  // Ein Termin, der ueber Mitternacht laeuft, hat ein Enddatum am Folgetag.
  // Die Endminute allein sagt das nicht — "23:00 bis 23:30" ist ein Termin am
  // selben Abend, "23:00 bis 00:30" laeuft in den nächsten Tag. Deshalb wird
  // der *Tag* mitgerechnet, und erst danach entschieden, ob abgeschnitten
  // werden muss.
  const endMinute = endDay > startDay
    ? 1440 + rawEndMinute
    : rawEndMinute;

  // Fuer die Ansicht wird ein ueber Mitternacht laufender Termin am Ende des
  // Tages abgeschnitten — der Rest gehoert in die naechste Spalte, und das ist
  // die Aufgabe des Aufrufers.
  const visibleEnd = Math.min(endMinute, 1440);
  const height = Math.max(visibleEnd - startMinute, 15);
  return { top: startMinute, height, startMinute, endMinute };
}

/**
 * Prueft, ob ein Termin ein Zeitraum-Problem hat: Ende vor Beginn.
 *
 * Zurueckgegeben wird ein kurzer Grund, der dem Nutzer und dem Agenten
 * sagt, was falsch war — nicht nur, dass etwas falsch war.
 */
export function validateEventRange(start: string, end: string, allDay: boolean): string | null {
  if (allDay) {
    if (dateToDayNumber(end) < dateToDayNumber(start)) {
      return "Das Ende liegt vor dem Beginn.";
    }
    return null;
  }
  if (end <= start) {
    return "Das Ende liegt vor dem Beginn.";
  }
  return null;
}

/**
 * Die Wochenzahl eines Datums in der Kurzform, wie sie im deutschen
 * Kalenderkopf steht: `KW 12`.
 */
export function formatGermanWeek(date: string): string {
  return `KW ${isoWeekNumber(date)}`;
}

/**
 * Der Wochentag und das Datum eines Datums in deutscher Schreibweise:
 * `Freitag, 13.03.2026`.
 */
export function formatGermanLongDate(date: string): string {
  return `${germanWeekdayName(date)}, ${formatGermanDate(date)}`;
}

/**
 * Die Wochenzahl eines Datums in der Langform, wie sie in der Kopfzeile der
 * Wochenansicht steht: `KW 11 · 09.03. – 15.03.2026`.
 */
export function formatGermanWeekRange(anchorDate: string): string {
  const days = buildWeekGrid(anchorDate);
  const first = days[0];
  const last = days[6];
  const lastYear = last.slice(0, 4);
  return `KW ${isoWeekNumber(first)} · ${formatGermanDate(first)} – ${formatGermanDate(last)}${lastYear !== first.slice(0, 4) ? ` ${lastYear}` : ""}`;
}

/**
 * Prueft, ob ein Termin ein Datum in der Wochenansicht des Ankers liegt.
 *
 * Die Pruefung arbeitet mit Tagesnummern statt mit Datumsvergleichen, damit
 * ein Ganztagestermin ueber den Wochenrand hinaus nicht in der falschen
 * Woche landet.
 */
export function eventFallsInWeek(event: CalendarEvent, anchorDate: string): boolean {
  const days = buildWeekGrid(anchorDate);
  const first = dateToDayNumber(days[0]);
  const last = dateToDayNumber(days[6]);
  const eventStart = dateToDayNumber(event.start.slice(0, 10));
  const eventEnd = dateToDayNumber(event.end.slice(0, 10));
  return eventStart <= last && eventEnd >= first;
}

/**
 * Prueft, ob ein Termin in einem bestimmten Monat liegt.
 *
 * Fuer die Monatsansicht zaehlt ein Ganztagestermin, der an einem Monatsende
 * beginnt und in den Folgemonat laeuft, in **beiden** Monaten. Ein Termin, der
 * nur an einem einzigen Tag liegt, wird ueber seinen Anfangsmonat einsortiert.
 */
export function eventFallsInMonth(event: CalendarEvent, anchorDate: string): boolean {
  const month = anchorDate.slice(0, 7);
  const startMonth = event.start.slice(0, 7);
  const endMonth = event.end.slice(0, 7);
  return startMonth === month || endMonth === month;
}
