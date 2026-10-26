import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { ICS_MIT_ALLEN_NEUN, VERWORFENE_FORMATE, dateiMit } from "../test/calendar-formats.mjs";

const jiti = createJiti(import.meta.url);
const {
  MAX_ICS_OCCURRENCES_PER_EVENT,
  MAX_ICS_OCCURRENCES_PER_IMPORT,
  parseCalendarIcs,
  unescapeIcsText,
} = await jiti.import("./calendar-ics.ts");

/**
 * Tests des ICS-Parsers.
 *
 * Der Parser ist der Teil, der mit fremden Dateien zu tun hat — und fremde
 * Dateien sind kaputt. Deshalb wird hier nicht nur der Normalfall geprueft,
 * sondern jede Stelle, an der eine Datei den Parser ueberraschen kann:
 * gefaltete Zeilen, exklusive `DTEND`, Zonen, Dauern, Regeln ohne Ende und
 * eine Datei, die ueberhaupt kein Kalender ist.
 */

/** Baut eine ICS-Datei aus Zeilen — mit `BEGIN`/`END` drumherum. */
function calendar(...lines) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR"].join("\r\n");
}

/** Die Daten (`YYYY-MM-DD`) der Termine, die der Parser liefert. */
function dates(result) {
  return result.events.map((entry) => entry.event.start.slice(0, 10));
}

/**
 * Baut eine ICS-Datei aus `VEVENT`-Bloecken, die je `occurrences` Termine
 * liefern (eine Tagesregel mit `COUNT`) — einer je `startDates`.
 *
 * Die Rechnung fuer den Import-Deckel: `MAX_ICS_OCCURRENCES_PER_IMPORT` (2000)
 * ist das, was **ein Import** liefern darf, `MAX_ICS_OCCURRENCES_PER_EVENT`
 * (1000) das, was **ein `VEVENT`** liefern darf. Der Import-Deckel wird also
 * nie von einem einzigen Block erreicht. Drei Bloecke zu je 1000 Terminen
 * bieten 3000 Termine an, also 1000 mehr als erlaubt: der erste Block bringt
 * 1000 Termine (Deckel je Ereignis), der zweite die naechsten 1000, und beim
 * dritten Block ist der Import bei 2000 Terminen voll — er bricht ab, ohne
 * den dritten Block ueberhaupt zu lesen.
 */
function calendarWithManyOccurrences(startDates, occurrences) {
  const lines = [];
  for (const [index, startDate] of startDates.entries()) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:termin-${index}`,
      `SUMMARY:Termin ${index}`,
      `DTSTART;VALUE=DATE:${startDate}`,
      `RRULE:FREQ=DAILY;COUNT=${occurrences}`,
      "END:VEVENT",
    );
  }
  return calendar(...lines);
}

// ------------------------------------------------------------ das Format --

test("a folded line becomes one line again", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Ein sehr langer Titel",
      "  der ueber eine Zeile gefaltet wurde",
      "DTSTART:20261028T140000",
      "END:VEVENT",
    ),
  );
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].event.title, "Ein sehr langer Titel der ueber eine Zeile gefaltet wurde");
});

test("a folded line in a description keeps its words apart", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Titel",
      "DESCRIPTION:Erster Teil",
      " und zweiter Teil",
      "DTSTART:20261028T140000",
      "END:VEVENT",
    ),
  );
  assert.equal(result.events[0].event.description, "Erster Teil und zweiter Teil");
});

test("the text escapes are undone", () => {
  assert.equal(unescapeIcsText("a\\nb"), "a\nb");
  assert.equal(unescapeIcsText("a\\,b"), "a,b");
  assert.equal(unescapeIcsText("a\\;b"), "a;b");
  assert.equal(unescapeIcsText("a\\\\b"), "a\\b");
});

test("a summary with escaped commas and newlines becomes readable text", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Team\\, Abteilung\\nZeile zwei",
      "DTSTART:20261028T140000",
      "END:VEVENT",
    ),
  );
  assert.equal(result.events[0].event.title, "Team, Abteilung\nZeile zwei");
});

test("a summary, a description and a location land in the event", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Teammeeting",
      "DESCRIPTION:Agenda Punkt eins",
      "LOCATION:Raum 3",
      "DTSTART:20261028T140000",
      "END:VEVENT",
    ),
  );
  const event = result.events[0].event;
  assert.equal(event.title, "Teammeeting");
  assert.equal(event.description, "Agenda Punkt eins");
  assert.equal(event.location, "Raum 3");
});

test("the uid travels next to the event and is not part of it", () => {
  const result = parseCalendarIcs(
    calendar("BEGIN:VEVENT", "UID:abc-123", "SUMMARY:Titel", "DTSTART:20261028T140000", "END:VEVENT"),
  );
  assert.equal(result.events[0].uid, "abc-123");
  assert.equal(result.events[0].event.uid, undefined);
});

test("a file without any event yields no event and no exception", () => {
  const result = parseCalendarIcs("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR");
  assert.equal(result.events.length, 0);
  assert.equal(result.report.imported, 0);
});

test("a completely broken file yields an empty result instead of an exception", () => {
  const result = parseCalendarIcs("\u0000�kein Textÿ mit : und ; und \"");
  assert.deepEqual(result.events, []);
  assert.equal(result.report.imported, 0);
});

test("an empty string yields an empty result", () => {
  assert.deepEqual(parseCalendarIcs("").events, []);
});

// -------------------------------------------------------------- die Zeiten --

test("an all-day event without an end lasts one day", () => {
  const result = parseCalendarIcs(
    calendar("BEGIN:VEVENT", "UID:1", "SUMMARY:Feiertag", "DTSTART;VALUE=DATE:20261028", "END:VEVENT"),
  );
  const event = result.events[0].event;
  assert.equal(event.allDay, true);
  assert.equal(event.start, "2026-10-28");
  assert.equal(event.end, "2026-10-28");
});

test("the exclusive end of an all-day event becomes an inclusive end", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Urlaub",
      "DTSTART;VALUE=DATE:20261028",
      "DTEND;VALUE=DATE:20261030",
      "END:VEVENT",
    ),
  );
  const event = result.events[0].event;
  assert.equal(event.start, "2026-10-28");
  assert.equal(event.end, "2026-10-29");
  assert.equal(event.allDay, true);
});

test("a floating time is taken as it stands", () => {
  const result = parseCalendarIcs(
    calendar("BEGIN:VEVENT", "UID:1", "SUMMARY:Titel", "DTSTART:20261028T140000", "END:VEVENT"),
  );
  assert.equal(result.events[0].event.start, "2026-10-28T14:00");
});

test("a time with a zone is taken as the wall clock and is named in the report", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Orts-termin",
      "DTSTART;TZID=America/New_York:20261028T140000",
      "END:VEVENT",
    ),
  );
  assert.equal(result.events[0].event.start, "2026-10-28T14:00");
  assert.equal(
    result.report.warnings.some((warning) => warning.includes("TZID=America/New_York")),
    true,
  );
});

test("a time in UTC is converted into the local time of the machine", () => {
  const result = parseCalendarIcs(
    calendar("BEGIN:VEVENT", "UID:1", "SUMMARY:Titel", "DTSTART:20261028T140000Z", "END:VEVENT"),
  );
  const expected = new Date(Date.UTC(2026, 9, 28, 14, 0));
  const local = `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, "0")}-${String(
    expected.getDate(),
  ).padStart(2, "0")}T${String(expected.getHours()).padStart(2, "0")}:${String(expected.getMinutes()).padStart(2, "0")}`;
  assert.equal(result.events[0].event.start, local);
});

test("a duration instead of an end computes the end", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Workout",
      "DTSTART:20261028T140000",
      "DURATION:PT1H30M",
      "END:VEVENT",
    ),
  );
  assert.equal(result.events[0].event.start, "2026-10-28T14:00");
  assert.equal(result.events[0].event.end, "2026-10-28T15:30");
});

test("a duration in days computes the inclusive end of an all-day event", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Workshop",
      "DTSTART;VALUE=DATE:20261028",
      "DURATION:P2D",
      "END:VEVENT",
    ),
  );
  assert.equal(result.events[0].event.start, "2026-10-28");
  assert.equal(result.events[0].event.end, "2026-10-29");
});

test("an end wins over a duration", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Titel",
      "DTSTART:20261028T140000",
      "DTEND:20261028T160000",
      "DURATION:PT1H",
      "END:VEVENT",
    ),
  );
  assert.equal(result.events[0].event.end, "2026-10-28T16:00");
});

test("an event without a start is skipped with a reason", () => {
  const result = parseCalendarIcs(
    calendar("BEGIN:VEVENT", "UID:1", "SUMMARY:Ohne Beginn", "END:VEVENT"),
  );
  assert.equal(result.events.length, 0);
  assert.equal(result.report.skipped[0].reason, "no-start-date");
});

// ------------------------------------------------------------ die Regeln --

test("a daily rule with a count brings that many events", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Taeglich",
      "DTSTART;VALUE=DATE:20261028",
      "RRULE:FREQ=DAILY;COUNT=3",
      "END:VEVENT",
    ),
  );
  assert.deepEqual(dates(result), ["2026-10-28", "2026-10-29", "2026-10-30"]);
  assert.equal(result.events.length, 3);
});

test("every occurrence gets its own id", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Taeglich",
      "DTSTART;VALUE=DATE:20261028",
      "RRULE:FREQ=DAILY;COUNT=3",
      "END:VEVENT",
    ),
  );
  const ids = new Set(result.events.map((entry) => entry.event.id));
  assert.equal(ids.size, 3);
});

test("an interval between the days is kept", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Jeden zweiten Tag",
      "DTSTART;VALUE=DATE:20261028",
      "RRULE:FREQ=DAILY;INTERVAL=2;COUNT=3",
      "END:VEVENT",
    ),
  );
  assert.deepEqual(dates(result), ["2026-10-28", "2026-10-30", "2026-11-01"]);
});

test("a weekly rule with two weekdays brings both", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Mo und Mi",
      "DTSTART;VALUE=DATE:20261026",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4",
      "END:VEVENT",
    ),
  );
  assert.deepEqual(dates(result), ["2026-10-26", "2026-10-28", "2026-11-02", "2026-11-04"]);
});

test("a monthly rule with the second monday brings the second monday", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Monatsreview",
      "DTSTART;VALUE=DATE:20261012",
      "RRULE:FREQ=MONTHLY;BYDAY=2MO;COUNT=3",
      "END:VEVENT",
    ),
  );
  assert.deepEqual(dates(result), ["2026-10-12", "2026-11-09", "2026-12-14"]);
});

test("a monthly rule with a day of the month brings that day", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Monatsende",
      "DTSTART;VALUE=DATE:20261015",
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=15;COUNT=3",
      "END:VEVENT",
    ),
  );
  assert.deepEqual(dates(result), ["2026-10-15", "2026-11-15", "2026-12-15"]);
});

test("an until date ends the rule", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Bis zum 30.",
      "DTSTART;VALUE=DATE:20261028",
      "RRULE:FREQ=DAILY;UNTIL=20261030",
      "END:VEVENT",
    ),
  );
  assert.deepEqual(dates(result), ["2026-10-28", "2026-10-29", "2026-10-30"]);
});

test("an excluded day is left out", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Taeglich",
      "DTSTART;VALUE=DATE:20261028",
      "RRULE:FREQ=DAILY;COUNT=3",
      "EXDATE;VALUE=DATE:20261029",
      "END:VEVENT",
    ),
  );
  assert.deepEqual(dates(result), ["2026-10-28", "2026-10-30"]);
});

test("a rule without a count and without an until brings one event and says so", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Immer",
      "DTSTART;VALUE=DATE:20261028",
      "RRULE:FREQ=DAILY",
      "END:VEVENT",
    ),
  );
  assert.equal(result.events.length, 1);
  assert.equal(result.report.unexpandedRecurrences, 1);
  assert.equal(result.report.skipped[0].reason, "unexpanded-recurrence");
  assert.equal(result.report.warnings.length > 0, true);
});

test("a rule the module cannot read brings one event and says so", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Der letzte Freitag",
      "DTSTART;VALUE=DATE:20261030",
      "RRULE:FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1;COUNT=3",
      "END:VEVENT",
    ),
  );
  assert.equal(result.events.length, 1);
  assert.equal(result.report.unexpandedRecurrences, 1);
  assert.equal(result.report.skipped[0].reason, "unexpanded-recurrence");
  assert.equal(result.report.warnings.some((warning) => warning.includes("BYSETPOS")), true);
});

test("a by-part that does not fit the frequency is reported, not guessed", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Titel",
      "DTSTART;VALUE=DATE:20261028",
      "RRULE:FREQ=DAILY;BYMONTHDAY=1;COUNT=3",
      "END:VEVENT",
    ),
  );
  assert.equal(result.events.length, 1);
  assert.equal(result.report.unexpandedRecurrences, 1);
  assert.equal(result.report.skipped[0].reason, "unexpanded-recurrence");
});

test("an ordinal weekday in a weekly rule is reported, not guessed", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Titel",
      "DTSTART;VALUE=DATE:20261028",
      "RRULE:FREQ=WEEKLY;BYDAY=2MO;COUNT=3",
      "END:VEVENT",
    ),
  );
  assert.equal(result.events.length, 1);
  assert.equal(result.report.unexpandedRecurrences, 1);
});

test("a rule that yields no event at all is reported", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Titel",
      "DTSTART;VALUE=DATE:20261028",
      "RRULE:FREQ=DAILY;UNTIL=20261020",
      "END:VEVENT",
    ),
  );
  assert.equal(result.events.length, 0);
  assert.equal(result.report.skipped[0].reason, "unexpanded-recurrence");
});

test("an endless rule never expands without a limit", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Viele",
      "DTSTART;VALUE=DATE:20261028",
      "RRULE:FREQ=DAILY;COUNT=50000",
      "END:VEVENT",
    ),
  );
  assert.equal(result.events.length, MAX_ICS_OCCURRENCES_PER_EVENT);
  // Die Zahl 1000 steht so in `AGENTS.md` — sie wird hier festgehalten, damit
  // eine Aenderung an der Konstante nicht unbemerkt durchgeht.
  assert.equal(result.events.length, 1000);
  assert.equal(result.report.warnings.some((warning) => warning.includes("abgeschnitten")), true);
});

// ---------------------------------------------------------- die Grenzen --

test("an import with too many events stops at the limit of the import", () => {
  const result = parseCalendarIcs(
    calendarWithManyOccurrences(["20260101", "20260201", "20260301"], 1000),
  );
  // Die Zahl 2000 steht so in `AGENTS.md` — sie wird hier festgehalten, damit
  // eine Aenderung an der Konstante nicht unbemerkt durchgeht.
  assert.equal(result.events.length, MAX_ICS_OCCURRENCES_PER_IMPORT);
  assert.equal(result.events.length, 2000);
  assert.equal(result.report.imported, MAX_ICS_OCCURRENCES_PER_IMPORT);
});

test("the report says that the import was cut off at the limit of the import", () => {
  const result = parseCalendarIcs(
    calendarWithManyOccurrences(["20260101", "20260201", "20260301"], 1000),
  );
  assert.equal(
    result.report.warnings.some((warning) =>
      warning.includes(
        "Der Import wurde bei 2000 Terminen abgeschnitten — die uebrigen Termine der Datei wurden nicht gelesen.",
      ),
    ),
    true,
  );
});

// ------------------------------------------------------ was nicht passt --

test("alarms, attendees and categories are counted and not dropped silently", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Titel",
      "DTSTART:20261028T140000",
      "ATTENDEE;CN=Anna:mailto:anna@example.org",
      "ATTENDEE;CN=Ben:mailto:ben@example.org",
      "CATEGORIES:Arbeit",
      "BEGIN:VALARM",
      "TRIGGER:-PT15M",
      "ACTION:DISPLAY",
      "END:VALARM",
      "END:VEVENT",
    ),
  );
  assert.equal(result.report.ignored.attendees, 2);
  assert.equal(result.report.ignored.categories, 1);
  assert.equal(result.report.ignored.alarms, 1);
  assert.equal(result.events.length, 1);
});

test("a time zone block is counted and not read", () => {
  const result = parseCalendarIcs(
    [
      "BEGIN:VCALENDAR",
      "BEGIN:VTIMEZONE",
      "TZID:Europe/Berlin",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Titel",
      "DTSTART;TZID=Europe/Berlin:20261028T140000",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n"),
  );
  assert.equal(result.report.ignored.timezones, 1);
  assert.equal(result.events.length, 1);
});

// ---------------------------------------------- die verworfenen Bestandteile --

test("eine normale Datei mit einem Termin zaehlt keinen sonstigen Kalenderbestandteil", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Titel",
      "DTSTART;VALUE=DATE:20261028",
      "DTEND;VALUE=DATE:20261029",
      "END:VEVENT",
    ),
  );
  assert.equal(result.report.ignored.otherComponents, 0);
  assert.equal(result.events.length, 1);
});

test("eine Datei mit einer Aufgabe zaehlt einen sonstigen Kalenderbestandteil", () => {
  const result = parseCalendarIcs(
    calendar("BEGIN:VTODO", "UID:2", "SUMMARY:Aufgabe", "END:VTODO"),
  );
  assert.equal(result.report.ignored.otherComponents, 1);
});

test("eine Datei mit einem Termin und einer Aufgabe zaehlt genau einen sonstigen Kalenderbestandteil", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Titel",
      "DTSTART;VALUE=DATE:20261028",
      "END:VEVENT",
      "BEGIN:VTODO",
      "UID:2",
      "SUMMARY:Aufgabe",
      "END:VTODO",
    ),
  );
  assert.equal(result.report.ignored.otherComponents, 1);
  assert.equal(result.events.length, 1);
});

test("ein Wecker im Termin zaehlt als Wecker und nicht als sonstiger Kalenderbestandteil", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Titel",
      "DTSTART;VALUE=DATE:20261028",
      "BEGIN:VALARM",
      "TRIGGER:-PT15M",
      "ACTION:DISPLAY",
      "END:VALARM",
      "END:VEVENT",
    ),
  );
  assert.equal(result.report.ignored.alarms, 1);
  assert.equal(result.report.ignored.otherComponents, 0);
});

test("eine Zeitzone zaehlt als Zeitzone und nicht als sonstiger Kalenderbestandteil", () => {
  const result = parseCalendarIcs(
    calendar("BEGIN:VTIMEZONE", "TZID:Europe/Berlin", "END:VTIMEZONE"),
  );
  assert.equal(result.report.ignored.timezones, 1);
  assert.equal(result.report.ignored.otherComponents, 0);
});

test("der Teil einer Zeitzone zaehlt nicht als sonstiger Kalenderbestandteil", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VTIMEZONE",
      "TZID:Europe/Berlin",
      "BEGIN:STANDARD",
      "DTSTART:19701025T030000",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0100",
      "END:STANDARD",
      "END:VTIMEZONE",
    ),
  );
  assert.equal(result.report.ignored.timezones, 1);
  assert.equal(result.report.ignored.otherComponents, 0);
});

test("ein END ohne BEGIN zaehlt keinen Bestandteil und liefert keinen Termin", () => {
  const result = parseCalendarIcs(["END:VTODO", "END:VALARM", "END:VEVENT"].join("\r\n"));
  assert.equal(result.report.ignored.otherComponents, 0);
  assert.equal(result.report.ignored.alarms, 0);
  assert.equal(result.events.length, 0);
  assert.equal(result.report.skipped.length, 0);
});

test("eine fremde Komponente im Termin zaehlt als sonstiger Kalenderbestandteil", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Titel",
      "DTSTART;VALUE=DATE:20261028",
      "BEGIN:X-FOO",
      "BAR:1",
      "END:X-FOO",
      "END:VEVENT",
    ),
  );
  assert.equal(result.report.ignored.otherComponents, 1);
  assert.equal(result.events.length, 1);
});

test("malformed lines are skipped without an exception", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Titel",
      "DTSTART:20261028T140000",
      "DIES IST KEINE EIGENSCHAFT",
      "DTSTART:not-a-date",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:2",
      "SUMMARY:Zweiter Termin",
      "DTSTART:20261104T100000",
      "END:VEVENT",
    ),
  );
  assert.equal(result.events.length, 2);
});

test("an event without a summary is skipped with a reason", () => {
  const result = parseCalendarIcs(
    calendar("BEGIN:VEVENT", "UID:1", "DTSTART:20261028T140000", "END:VEVENT"),
  );
  assert.equal(result.events.length, 0);
  assert.equal(result.report.skipped[0].reason, "invalid-event");
});

test("a too long title is cut and the report says so", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      `SUMMARY:${"a".repeat(400)}`,
      "DTSTART:20261028T140000",
      "END:VEVENT",
    ),
  );
  assert.equal(result.events[0].event.title.length, 300);
  assert.equal(result.report.warnings.some((warning) => warning.includes("gekuerzt")), true);
});

test("an event whose end lies before its beginning is skipped", () => {
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Verkehrt",
      "DTSTART:20261028T160000",
      "DTEND:20261028T140000",
      "END:VEVENT",
    ),
  );
  assert.equal(result.events.length, 0);
  assert.equal(result.report.skipped[0].reason, "invalid-event");
});

test("an event without an end gets an end an hour later and the report says so", () => {
  const result = parseCalendarIcs(
    calendar("BEGIN:VEVENT", "UID:1", "SUMMARY:Titel", "DTSTART:20261028T140000", "END:VEVENT"),
  );
  assert.equal(result.events[0].event.end, "2026-10-28T15:00");
  assert.equal(result.report.warnings.some((warning) => warning.includes("Stunde")), true);
});

// ------------------------------------------- die neun verworfenen Formate --

test("jede der neun Formate wird von ihrer eigenen Datei ausgeloest — und von keiner anderen", () => {
  // Das ist der **Beleg** fuer die Zuordnung: jede Datei traegt genau ein
  // Format, und der Parser zaehlt genau dieses eine. Wer eine Zuordnung
  // vertauscht, sieht es hier zuerst.
  for (const format of VERWORFENE_FORMATE) {
    const result = parseCalendarIcs(dateiMit(format.zeilen));
    const gezaehlt = Object.entries(result.report.ignored).filter(([, anzahl]) => anzahl > 0);
    assert.deepEqual(
      gezaehlt,
      [[format.key, 1]],
      `die Datei fuer "${format.key}" zaehlt ${JSON.stringify(gezaehlt)}`,
    );
  }
});

test("eine Datei mit allen neun Formaten traegt genau die neun Zaehler mit je einer Angabe", () => {
  const result = parseCalendarIcs(ICS_MIT_ALLEN_NEUN);
  // Die Zahl **neun** steht so in `docs/calendar.md` — sie wird hier
  // festgehalten, damit eine Aenderung an der Zahl nicht unbemerkt
  // durchgeht.
  assert.equal(Object.keys(result.report.ignored).length, 9);
  assert.deepEqual(result.report.ignored, {
    alarms: 1,
    attendees: 1,
    categories: 1,
    organizers: 1,
    urls: 1,
    statuses: 1,
    transparencies: 1,
    timezones: 1,
    otherComponents: 1,
  });
});
