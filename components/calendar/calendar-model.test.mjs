import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { root: process.cwd() });
const {
  HOUR_HEIGHT,
  MINUTE_HEIGHT,
  MINUTES_PER_DAY,
  eventColorVariable,
  eventDaySpan,
  eventDurationMinutes,
  eventSegmentForDay,
  eventSpansDay,
  moveEventToDay,
  moveEventToSlot,
  shiftMonth,
  todayDateString,
} = await jiti.import("@/components/calendar/calendar-model.ts");

/** Ein Termin mit Uhrzeit. */
function timed(overrides = {}) {
  return {
    id: "evt-1",
    title: "Teammeeting",
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:00",
    allDay: false,
    createdAt: "2026-03-01T09:00:00.000Z",
    updatedAt: "2026-03-01T09:00:00.000Z",
    ...overrides,
  };
}

/** Ein Ganztagestermin. */
function allDay(overrides = {}) {
  return timed({ allDay: true, start: "2026-03-14", end: "2026-03-14", ...overrides });
}

// --- Das Raster ---------------------------------------------------------------

test("the hour scale has the documented size", () => {
  // Der Wert bestimmt, wie hoch ein Tag in der Wochenansicht ist. Er steht
  // in einer Konstante, weil er an zwei Stellen gebraucht wird — und der
  // Test haelt die Zahl fest, damit sie nicht stillschweigend wandert.
  assert.equal(MINUTE_HEIGHT, 0.8);
  assert.equal(HOUR_HEIGHT, 48);
  assert.equal(MINUTES_PER_DAY, 1440);
});

// --- Die Monatsnavigation -------------------------------------------------------

test("shifting a month moves to the first of the neighbouring month", () => {
  assert.equal(shiftMonth("2026-03-14", 1), "2026-04-01");
  assert.equal(shiftMonth("2026-03-14", -1), "2026-02-01");
  assert.equal(shiftMonth("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftMonth("2026-01-01", -1), "2025-12-01");
});

test("shifting a month works from the first as well", () => {
  assert.equal(shiftMonth("2026-03-01", 1), "2026-04-01");
  assert.equal(shiftMonth("2026-03-01", -1), "2026-02-01");
});

test("today is the local day, not the UTC day", () => {
  const today = todayDateString();
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  // Der heutige Tag muss der lokale sein. `toISOString()` rechnet in UTC und
  // waere in Mitteleuropa nach 22 Uhr der Vortag.
  const now = new Date();
  assert.equal(today.slice(0, 4), String(now.getFullYear()));
  assert.equal(Number(today.slice(5, 7)), now.getMonth() + 1);
  assert.equal(Number(today.slice(8, 10)), now.getDate());
});

// --- Die Tage eines Termins -------------------------------------------------------

test("an all-day event spans its days inclusive", () => {
  const event = allDay({ start: "2026-03-14", end: "2026-03-16" });
  assert.deepEqual(eventDaySpan(event), { start: "2026-03-14", end: "2026-03-16" });
  assert.equal(eventSpansDay(event, "2026-03-15"), true);
  assert.equal(eventSpansDay(event, "2026-03-17"), false);
});

test("an event ending at midnight ends on the previous day", () => {
  // Ein Termin von 22:00 bis 00:00 endet am *Anfang* des zweiten Tages. Der
  // zweite Tag gehoert also nicht mehr zum Termin — sonst stuende er in der
  // Monatsansicht einen Tag zu lang.
  const event = timed({ start: "2026-03-14T22:00", end: "2026-03-15T00:00" });
  assert.deepEqual(eventDaySpan(event), { start: "2026-03-14", end: "2026-03-14" });
  assert.equal(eventSpansDay(event, "2026-03-15"), false);
});

test("an event crossing midnight without ending at zero spans both days", () => {
  const event = timed({ start: "2026-03-14T23:00", end: "2026-03-15T00:30" });
  assert.deepEqual(eventDaySpan(event), { start: "2026-03-14", end: "2026-03-15" });
  assert.equal(eventSpansDay(event, "2026-03-15"), true);
});

// --- Die Position im Stundenraster ----------------------------------------------------

test("a timed event is placed by its minutes from midnight", () => {
  const segment = eventSegmentForDay(timed({ start: "2026-03-14T15:00", end: "2026-03-14T16:30" }), "2026-03-14");
  assert.equal(segment.top, 900);
  assert.equal(segment.height, 90);
});

test("an all-day event has no segment in the hour grid", () => {
  assert.equal(eventSegmentForDay(allDay(), "2026-03-14"), null);
});

test("an event crossing midnight is split at midnight", () => {
  const event = timed({ start: "2026-03-14T23:00", end: "2026-03-15T00:30" });
  const first = eventSegmentForDay(event, "2026-03-14");
  assert.equal(first.top, 1380);
  assert.equal(first.height, 60);
  // Im zweiten Tag beginnt der Termin um 00:00 und endet um 00:30.
  const second = eventSegmentForDay(event, "2026-03-15");
  assert.equal(second.top, 0);
  assert.equal(second.height, 30);
});

test("an event on another day has no segment", () => {
  assert.equal(eventSegmentForDay(timed(), "2026-03-15"), null);
});

// --- Die Dauer -------------------------------------------------------------------------

test("the duration of a timed event is its real span", () => {
  assert.equal(eventDurationMinutes(timed({ start: "2026-03-14T15:00", end: "2026-03-14T16:30" })), 90);
});

test("the duration of an event crossing midnight counts the whole span", () => {
  const event = timed({ start: "2026-03-14T23:00", end: "2026-03-15T00:30" });
  assert.equal(eventDurationMinutes(event), 90);
});

test("the duration of an all-day event counts its days", () => {
  assert.equal(eventDurationMinutes(allDay({ start: "2026-03-14", end: "2026-03-14" })), MINUTES_PER_DAY);
  assert.equal(eventDurationMinutes(allDay({ start: "2026-03-14", end: "2026-03-16" })), MINUTES_PER_DAY * 3);
});

// --- Das Verschieben ---------------------------------------------------------------------

test("moving a timed event to another day keeps its time of day", () => {
  const moved = moveEventToDay(timed(), "2026-03-16");
  assert.equal(moved.start, "2026-03-16T15:00");
  assert.equal(moved.end, "2026-03-16T16:00");
  assert.equal(moved.allDay, false);
});

test("moving an all-day event keeps its number of days", () => {
  const moved = moveEventToDay(allDay({ start: "2026-03-14", end: "2026-03-16" }), "2026-04-01");
  assert.equal(moved.start, "2026-04-01");
  assert.equal(moved.end, "2026-04-03");
  assert.equal(moved.allDay, true);
});

test("moving a timed event to a slot keeps its duration", () => {
  // Ein Termin, der eine Stunde dauert, dauert nach dem Verschieben immer
  // noch eine Stunde. Waere die Laenge nicht erhalten, wuerde der Nutzer
  // seine eigene Aenderung nicht bemerken.
  const moved = moveEventToSlot(timed(), "2026-03-16", 10 * 60);
  assert.equal(moved.start, "2026-03-16T10:00");
  assert.equal(moved.end, "2026-03-16T11:00");
  assert.equal(moved.allDay, false);
});

test("moving an event to a slot near midnight ends on the next day", () => {
  const event = timed({ start: "2026-03-14T15:00", end: "2026-03-14T16:00" });
  const moved = moveEventToSlot(event, "2026-03-16", 23 * 60 + 30);
  assert.equal(moved.start, "2026-03-16T23:30");
  // Die Stunde laeuft ueber die Mitternacht — das Ende liegt am Folgetag.
  assert.equal(moved.end, "2026-03-17T00:30");
});

test("moving an all-day event to a slot turns it into a timed event", () => {
  const moved = moveEventToSlot(allDay(), "2026-03-16", 9 * 60);
  assert.equal(moved.start, "2026-03-16T09:00");
  assert.equal(moved.end, "2026-03-16T10:00");
  assert.equal(moved.allDay, false);
});

// --- Die Farbe ------------------------------------------------------------------------------

test("the color of an event is a theme variable, never a literal", () => {
  const variable = eventColorVariable(timed());
  assert.match(variable, /^var\(--/, `keine Theme-Variable: ${variable}`);
});

test("the color of an event is stable", () => {
  assert.equal(eventColorVariable(timed()), eventColorVariable(timed()));
});
