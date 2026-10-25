import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  CALENDAR_COLORS,
  CALENDAR_COLOR_VARIABLES,
  buildMonthGrid,
  buildWeekGrid,
  colorForEventId,
  dateToDayNumber,
  daysInMonth,
  easterSunday,
  eventFallsInMonth,
  eventFallsInWeek,
  eventPosition,
  formatGermanDate,
  formatGermanDateTime,
  formatGermanLongDate,
  formatGermanMonthYear,
  formatGermanWeek,
  formatGermanWeekRange,
  germanHolidays,
  germanMonthName,
  germanWeekdayName,
  isCalendarDate,
  isCalendarDateTime,
  isGermanHoliday,
  isoWeek,
  isoWeekNumber,
  minutesToTime,
  resolveEventColor,
  startOfMonth,
  startOfWeek,
  timeToMinutes,
  validateEventRange,
  weekdayIndex,
} = await jiti.import("./calendar.ts");

// --- Datum und Uhrzeit ----------------------------------------------------
// Die Kalenderlogik rechnet in Wandkalender-Zeit, nicht in UTC. Ein Test, der
// das nicht prueft, laeuft in einer Umgebung mit UTC-Zeitzone gruen und
// scheitert in einer mit CET — und genau dort entstehen die Kalenderfehler.

test("a date is valid only with a real month and day", () => {
  assert.equal(isCalendarDate("2026-03-14"), true);
  assert.equal(isCalendarDate("2026-13-01"), false);
  assert.equal(isCalendarDate("2026-02-30"), false);
  assert.equal(isCalendarDate("2026-2-3"), false);
  assert.equal(isCalendarDate("2026-03-14T10:00"), false);
});

test("February 29 exists only in a leap year", () => {
  assert.equal(isCalendarDate("2024-02-29"), true);
  assert.equal(isCalendarDate("2026-02-29"), false);
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2026, 2), 28);
});

test("a date-time needs a valid date and a valid time", () => {
  assert.equal(isCalendarDateTime("2026-03-14T15:00"), true);
  assert.equal(isCalendarDateTime("2026-03-14T24:00"), false);
  assert.equal(isCalendarDateTime("2026-03-14T15:60"), false);
  assert.equal(isCalendarDateTime("2026-03-14"), false);
});

test("the day number does not depend on the machine's timezone", () => {
  // Zwei Daten, die in UTC auf verschiedene Tage fallen, muessen in der
  // Wandkalender-Rechnung genau einen Tag Abstand haben — unabhaengig davon,
  // in welcher Zeitzone der Test laeuft.
  assert.equal(dateToDayNumber("2026-03-15") - dateToDayNumber("2026-03-14"), 1);
  assert.equal(dateToDayNumber("2026-03-01") - dateToDayNumber("2026-02-28"), 1);
});

test("minutes and times convert both ways", () => {
  assert.equal(timeToMinutes("15:00"), 900);
  assert.equal(timeToMinutes("00:00"), 0);
  assert.equal(minutesToTime(900), "15:00");
  assert.equal(minutesToTime(0), "00:00");
  assert.equal(minutesToTime(1440), "00:00");
});

// --- Die deutsche Woche ----------------------------------------------------
// Der Kern der deutschen Woche: sie beginnt am Montag, und die erste Woche
// des Jahres ist die mit dem 4. Januar.

test("the week begins on Monday", () => {
  // 2026-03-14 ist ein Samstag, 2026-03-16 ein Montag.
  assert.equal(weekdayIndex("2026-03-16"), 0);
  assert.equal(weekdayIndex("2026-03-22"), 6);
  assert.equal(startOfWeek("2026-03-14"), "2026-03-09");
  assert.equal(startOfWeek("2026-03-16"), "2026-03-16");
  assert.equal(startOfWeek("2026-03-22"), "2026-03-16");
});

test("the ISO week number follows ISO 8601, not the American week", () => {
  // Der 1. Januar 2021 gehoert zu KW 53 des Jahres 2020: die Woche mit dem
  // 4. Januar ist die erste, und der 1. Januar faellt in die letzte Woche
  // des Vorjahres.
  assert.equal(isoWeekNumber("2021-01-01"), 53);
  assert.equal(isoWeek("2021-01-01").year, 2020);
  assert.equal(isoWeekNumber("2026-01-01"), 1);
  assert.equal(isoWeekNumber("2026-12-31"), 53);
  // Ein Donnerstag der KW 1 gehoert immer zu dieser KW, auch wenn der
  // 1. Januar in die Vorwoche fiel.
  assert.equal(isoWeekNumber("2026-01-08"), 2);
});

test("the first Thursday of the year is in the first ISO week", () => {
  // 2026: der 4. Januar ist ein Sonntag, der erste Donnerstag ist der 8. Januar.
  assert.equal(startOfWeek("2026-01-08"), "2026-01-05");
  assert.equal(isoWeekNumber("2026-01-08"), 2);
});

// --- Deutsche Namen und Formate --------------------------------------------

test("the German names are used, not the browser's locale", () => {
  assert.equal(germanMonthName("2026-03-14"), "März");
  assert.equal(germanMonthName("2026-05-01"), "Mai");
  assert.equal(germanWeekdayName("2026-03-16"), "Montag");
  assert.equal(germanWeekdayName("2026-03-22"), "Sonntag");
  assert.equal(formatGermanDate("2026-03-14"), "14.03.2026");
  assert.equal(formatGermanMonthYear("2026-03-14"), "März 2026");
  assert.equal(formatGermanLongDate("2026-03-14"), "Samstag, 14.03.2026");
  assert.equal(formatGermanDateTime("2026-03-14T15:00"), "14.03.2026, 15:00");
  assert.equal(formatGermanDateTime("2026-03-14"), "14.03.2026");
  assert.equal(formatGermanWeek("2026-03-14"), "KW 11");
});

test("the week range shows both ends and the week number", () => {
  const range = formatGermanWeekRange("2026-03-14");
  assert.match(range, /^KW 11 · 09\.03\.2026 – 15\.03\.2026$/);
});

test("a week range across the turn of the year names the second year", () => {
  // Die Woche vom 28.12.2025 reicht in das Jahr 2026.
  const range = formatGermanWeekRange("2025-12-31");
  assert.match(range, /2026$/);
});

// --- Feiertage --------------------------------------------------------------

test("Easter is computed by the Gauss formula", () => {
  // Bekannte Osterdaten: 2024 am 31. Maerz, 2025 am 20. April, 2026 am 5. April.
  assert.equal(easterSunday(2024), "2024-03-31");
  assert.equal(easterSunday(2025), "2025-04-20");
  assert.equal(easterSunday(2026), "2026-04-05");
  assert.equal(easterSunday(2027), "2027-03-28");
});

test("the movable German holidays hang on Easter", () => {
  const holidays = germanHolidays(2026);
  assert.equal(holidays.get("2026-04-03"), "Karfreitag");
  assert.equal(holidays.get("2026-04-06"), "Ostermontag");
  assert.equal(holidays.get("2026-05-14"), "Christi Himmelfahrt");
  assert.equal(holidays.get("2026-05-25"), "Pfingstmontag");
});

test("the fixed German holidays are on their day", () => {
  const holidays = germanHolidays(2026);
  assert.equal(holidays.get("2026-01-01"), "Neujahr");
  assert.equal(holidays.get("2026-05-01"), "Tag der Arbeit");
  assert.equal(holidays.get("2026-10-03"), "Tag der Deutschen Einheit");
  assert.equal(holidays.get("2026-12-25"), "1. Weihnachtstag");
  assert.equal(holidays.get("2026-12-26"), "2. Weihnachtstag");
});

test("a day that is not a holiday says so", () => {
  assert.equal(isGermanHoliday("2026-03-14"), null);
  assert.equal(isGermanHoliday("2026-12-25"), "1. Weihnachtstag");
});

// --- Raster -----------------------------------------------------------------

test("the month grid has six weeks of seven days, beginning on Monday", () => {
  const grid = buildMonthGrid("2026-03-14");
  assert.equal(grid.length, 42);
  assert.equal(grid[0], "2026-02-23");
  assert.equal(grid[41], "2026-04-05");
  // Jede Zeile beginnt am Montag und laeuft bis zum Sonntag.
  for (let i = 0; i < grid.length; i++) {
    assert.equal(weekdayIndex(grid[i]), i % 7, `${grid[i]} steht an der falschen Stelle`);
  }
});

test("the week grid has seven days beginning on Monday", () => {
  const grid = buildWeekGrid("2026-03-14");
  assert.equal(grid.length, 7);
  assert.equal(grid[0], "2026-03-09");
  assert.equal(grid[6], "2026-03-15");
});

test("the first of the month is found regardless of the anchor day", () => {
  assert.equal(startOfMonth("2026-03-14"), "2026-03-01");
  assert.equal(startOfMonth("2026-03-01"), "2026-03-01");
});

// --- Termine ----------------------------------------------------------------

test("an event that ends before it starts is refused", () => {
  // Ein Termin, der vor seinem Beginn endet, ist kein Termin. Das ist kein
  // Formfehler, sondern ein unmoeglicher Zeitraum — deshalb wird er
  // abgelehnt und nicht stillschweigend vertauscht.
  assert.ok(validateEventRange("2026-03-14T15:00", "2026-03-14T14:00", false));
  assert.ok(validateEventRange("2026-03-15", "2026-03-14", true));
  // Ein gueltiger Zeitraum wird nicht beanstandet.
  assert.equal(validateEventRange("2026-03-14T15:00", "2026-03-14T16:00", false), null);
  // Ein Ganztagestermin darf einen Tag lang sein — Ende ist der letzte Tag.
  assert.equal(validateEventRange("2026-03-14", "2026-03-14", true), null);
  assert.equal(validateEventRange("2026-03-14", "2026-03-15", true), null);
});

test("a timed event is placed by its minutes from midnight", () => {
  const position = eventPosition("2026-03-14T15:00", "2026-03-14T16:30");
  assert.equal(position.top, 900);
  assert.equal(position.height, 90);
  assert.equal(position.startMinute, 900);
  assert.equal(position.endMinute, 990);
});

test("an all-day event has no position in the hour grid", () => {
  assert.equal(eventPosition("2026-03-14", "2026-03-14"), null);
});

test("an event crossing midnight is cut off at the end of the day", () => {
  // 23:00 bis 00:30 am Folgetag laeuft ueber die Mitternacht. In der
  // Tagesansicht ist nur der Teil bis 24:00 sichtbar.
  const crossing = eventPosition("2026-03-14T23:00", "2026-03-15T00:30");
  assert.equal(crossing.endMinute, 1470);
  assert.equal(crossing.height, 60);
  assert.equal(crossing.top, 1380);
});

test("an event in the evening is not mistaken for one crossing midnight", () => {
  // 23:00 bis 23:30 liegt am selben Abend. Wer nur die Uhrzeit vergleicht,
  // haelt es fuer einen Mitternachtswechsel und schneidet es falsch ab.
  const evening = eventPosition("2026-03-14T23:00", "2026-03-14T23:30");
  assert.equal(evening.endMinute, 1410);
  assert.equal(evening.height, 30);
});

test("an event is in the week it starts in", () => {
  const event = { start: "2026-03-10T10:00", end: "2026-03-10T11:00" };
  assert.equal(eventFallsInWeek(event, "2026-03-14"), true);
  assert.equal(eventFallsInWeek(event, "2026-03-16"), false);
});

test("an event spanning a month border appears in both months", () => {
  const event = { start: "2026-03-30T10:00", end: "2026-04-02T10:00" };
  assert.equal(eventFallsInMonth(event, "2026-03-01"), true);
  assert.equal(eventFallsInMonth(event, "2026-04-01"), true);
  assert.equal(eventFallsInMonth(event, "2026-02-01"), false);
});

// --- Farben -----------------------------------------------------------------

test("every color has a theme variable, and no color is a literal", () => {
  for (const color of CALENDAR_COLORS) {
    const variable = CALENDAR_COLOR_VARIABLES[color];
    assert.ok(variable, `${color} hat keine Variable`);
    assert.match(variable, /^var\(--/, `${color} ist keine Theme-Variable: ${variable}`);
  }
});

test("an unknown color falls back to one derived from the id", () => {
  const event = { id: "abc-123", color: "nonsense" };
  assert.ok(CALENDAR_COLORS.includes(resolveEventColor(event)));
  assert.equal(resolveEventColor(event), colorForEventId("abc-123"));
});

test("the color of an id is stable across calls", () => {
  assert.equal(colorForEventId("abc-123"), colorForEventId("abc-123"));
});
