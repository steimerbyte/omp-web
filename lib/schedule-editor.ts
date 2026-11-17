/**
 * Die Bausteine des einfachen Zeitplan-Editors.
 *
 * Zwei Ansichten zeigen denselben Editor — die geplanten Aufgaben und die
 * Newsletter —, deshalb steht die Umrechnung hier und nicht zweimal dort. Der
 * Editor kennt nur, was die Presets erzeugen: eine feste Minute, eine feste
 * Stunde und ein Wochentagsfeld. Alles andere (`*` in der Minute, Schritte,
 * Listen im Monat) bleibt im Rohfeld.
 *
 * Die Woerter stehen nicht hier: `weekdayLabelKey` liefert einen
 * Katalogschluessel, uebersetzt wird in der Ansicht.
 */

/** Die Vorbelegung fuer eine Minute/Stunde/Regel — was ein Preset in Felder schreibt. */
export interface EditorValue {
  minute: string;
  hour: string;
  /** `*` (taeglich), `1-5` (werktags) oder ein einzelner Wochentag. */
  weekday: string;
}

/**
 * Zerlegt einen Cron in die drei Felder des Editors — oder `null`.
 *
 * Das Wochentagsfeld wird **unveraendert** uebernommen, auch `7`: beide
 * Schreibweisen fuer Sonntag stehen in {@link WEEKDAY_VALUES}, damit ein
 * gelesener Ausdruck beim Speichern derselbe bleibt. Ein Editor, der `7` auf
 * `0` normalisiert, aendert einen Zeitplan, den niemand angefasst hat.
 */
export function toEditorValue(cron: string): EditorValue | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, weekday] = parts;
  if (dayOfMonth !== "*" || month !== "*") return null;
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
  return { minute, hour, weekday };
}

/** Aus den drei Feldern wieder einen Cron. */
export function toCron(value: EditorValue): string {
  return `${value.minute} ${value.hour} * * ${value.weekday}`;
}

/**
 * Die Katalogschluessel der Wochentage, Index = `Date#getDay` (`0` = Sonntag).
 *
 * Dieselbe Tabelle benennt das Auswahlfeld und die Beschreibung eines
 * Zeitplans, damit "Montags um 08:00" und `value="1"` nie zwei verschiedene
 * Tage meinen.
 */
const WEEKDAY_LABEL_KEYS: readonly string[] = [
  "scheduled.weekdaySun",
  "scheduled.weekdayMon",
  "scheduled.weekdayTue",
  "scheduled.weekdayWed",
  "scheduled.weekdayThu",
  "scheduled.weekdayFri",
  "scheduled.weekdaySat",
];

/**
 * Die Werte des Wochentagsfeldes.
 *
 * `0` und `7` sind beide Sonntag, und beide stehen deshalb zur Wahl: ein
 * gespeicherter Ausdruck `0 8 * * 7` landet beim Bearbeiten als `7` im Feld,
 * und ein `<select>` ohne passende `<option>` zeigt sonst stillschweigend den
 * ersten Eintrag — ein Sonntag wuerde beim naechsten Speichern zu "taeglich".
 */
export const WEEKDAY_VALUES: readonly string[] = ["*", "1-5", "1", "2", "3", "4", "5", "6", "0", "7"];

/** Der Katalogschluessel zu einem Feldwert; `7` ist Sonntag wie `0`. */
export function weekdayLabelKey(value: string): string {
  if (value === "*") return "scheduled.weekdayEveryDay";
  if (value === "1-5") return "scheduled.weekdayWeekdays";
  return WEEKDAY_LABEL_KEYS[Number(value) % 7];
}
