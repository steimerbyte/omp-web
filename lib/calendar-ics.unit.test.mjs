import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./calendar-ics.ts");
}

/**
 * Die beiden Regel-Formen, die die Monats-Expansion braucht.
 *
 * `allWeekdaysOfMonth` ist die Stelle hinter `FREQ=MONTHLY;BYDAY=MO` (jeder
 * Montag) und hinter der Schnittmenge `BYMONTHDAY=…;BYDAY=…`; der geordnete
 * Fall (`2MO`) laeuft ueber `nthWeekdayOfMonth` und ist anderswo geprueft. Hier
 * steht deshalb nur, was diese beiden Zweige von der Funktion verlangen: jeder
 * passende Wochentag des Monats, in aufsteigender Reihenfolge, keiner aus dem
 * Nachbarmonat.
 */
function calendar(...lines) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR"].join("\r\n");
}

function dates(result) {
  return result.events.map((entry) => entry.event.start.slice(0, 10));
}

test("a monthly BYDAY rule brings every matching weekday of the month", async () => {
  const { parseCalendarIcs } = await loadSubject();

  // Oktober 2026 beginnt an einem Donnerstag: Montage sind der 5., 12., 19.
  // und 26. Der fuenfte Treffer liegt schon im November — die Funktion darf
  // keinen Tag aus dem Nachbarmonat liefern.
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:Jeden Montag",
      "DTSTART;VALUE=DATE:20261001",
      "RRULE:FREQ=MONTHLY;BYDAY=MO;COUNT=5",
      "END:VEVENT",
    ),
  );

  assert.deepEqual(dates(result), [
    "2026-10-05",
    "2026-10-12",
    "2026-10-19",
    "2026-10-26",
    "2026-11-02",
  ]);
});

test("BYMONTHDAY and BYDAY intersect on the weekdays of the month", async () => {
  const { parseCalendarIcs } = await loadSubject();

  // Die Schnittmenge laeuft ueber eine eigene Menge (Zeile 739): nur der 5.
  // und der 12. Oktober sind Montage, der 1. und der 8. sind es nicht.
  const result = parseCalendarIcs(
    calendar(
      "BEGIN:VEVENT",
      "UID:2",
      "SUMMARY:Montag im Monat",
      "DTSTART;VALUE=DATE:20261001",
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=1,5,8,12;BYDAY=MO;COUNT=2",
      "END:VEVENT",
    ),
  );

  assert.deepEqual(dates(result), ["2026-10-05", "2026-10-12"]);
});
