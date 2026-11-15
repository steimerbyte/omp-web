import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// Die Zeitzone gehoert zum Test, nicht zum Rechner. Die Sommerzeit-Luecke am
// 29.03.2026 gibt es nur in einer Zone mit Umstellung; eine CI in UTC wuerde
// die Tests darunter gruen rechnen, ohne etwas zu pruefen. `process.env.TZ`
// wirkt in Bun sofort (gemessen), und jede Testdatei laeuft im eigenen Worker.
process.env.TZ = "Europe/Berlin";

const jiti = createJiti(import.meta.url);
const {
  MAX_REMINDERS_PER_EVENT,
  REMINDER_GRACE_MS,
  dueReminders,
  leadText,
  nextReminderAt,
  reminderText,
} = await jiti.import("./calendar-reminders.ts");

// --- Der Bestand -----------------------------------------------------------
// Die Erwartungen sind mit derselben lokalen Konstruktion gebaut wie der
// Produktivcode (`new Date(jahr, monat - 1, tag, stunde, minute)`). Ein Test,
// der stattdessen `Date.UTC` schriebe, waere auf einem Rechner in UTC gruen
// und in Berlin rot — und die Kalenderzeit ist Wanduhr, nicht UTC.

/** Ein Termin mit Uhrzeit; `overrides` ersetzt einzelne Felder. */
function timed(overrides = {}) {
  return {
    id: "ev-timed",
    title: "Zahnarzt",
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:00",
    allDay: false,
    createdAt: "2026-03-01T09:00:00.000Z",
    updatedAt: "2026-03-01T09:00:00.000Z",
    ...overrides,
  };
}

/** Ein Ganztagstermin; `overrides` ersetzt einzelne Felder. */
function allDay(overrides = {}) {
  return {
    id: "ev-day",
    title: "Urlaub",
    start: "2026-11-17",
    end: "2026-11-19",
    allDay: true,
    createdAt: "2026-03-01T09:00:00.000Z",
    updatedAt: "2026-03-01T09:00:00.000Z",
    ...overrides,
  };
}

/** Die lokale Wanduhr eines Datums und einer Uhrzeit als Zeitstempel. */
function at(year, month, day, hours = 0, minutes = 0) {
  return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime();
}

// --- Der Altbestand --------------------------------------------------------

test("a missing field means the previous lead: five minutes before", () => {
  const event = timed();
  // 14:55 ist der Zeitpunkt; 14:50 liegt davor, 14:55 genau darauf.
  assert.deepEqual(dueReminders([event], at(2026, 3, 14, 14, 54)), []);
  const due = dueReminders([event], at(2026, 3, 14, 14, 55));
  assert.equal(due.length, 1);
  assert.equal(due[0].atMs, at(2026, 3, 14, 14, 55));
  assert.equal(due[0].title, "Zahnarzt");
  assert.equal(due[0].body, "in 5 Minuten · 15:00");
});

test("a missing field means eight in the morning for an all-day event", () => {
  const event = allDay();
  assert.deepEqual(dueReminders([event], at(2026, 11, 17, 7, 59)), []);
  const due = dueReminders([event], at(2026, 11, 17, 8, 0));
  assert.equal(due.length, 1);
  assert.equal(due[0].atMs, at(2026, 11, 17, 8, 0));
  assert.equal(due[0].body, "Ganztägig · Di 17.11.");
});

test("a field that is not an array falls back to the previous lead", () => {
  for (const reminders of [15, "15", null, {}, [[]]]) {
    const due = dueReminders([timed({ reminders })], at(2026, 3, 14, 14, 55));
    assert.equal(due.length, 1, `reminders=${JSON.stringify(reminders)}`);
  }
});

test("an array of nothing but junk falls back to the previous lead", () => {
  const due = dueReminders([timed({ reminders: [{}, 42, { minutesBefore: "15" }] })], at(2026, 3, 14, 14, 55));
  assert.equal(due.length, 1);
  assert.equal(due[0].body, "in 5 Minuten · 15:00");
});

// --- Leer heisst keine -----------------------------------------------------

test("an empty array means no reminder at all", () => {
  assert.deepEqual(dueReminders([timed({ reminders: [] })], at(2026, 3, 14, 14, 55)), []);
  assert.equal(nextReminderAt([timed({ reminders: [] })], at(2026, 3, 14, 12, 0)), null);
  assert.deepEqual(dueReminders([allDay({ reminders: [] })], at(2026, 11, 17, 8, 0)), []);
});

// --- Die beiden Formen -----------------------------------------------------

test("a timed event fires minutes before the start", () => {
  const event = timed({ reminders: [{ minutesBefore: 15 }, { minutesBefore: 60 }] });
  // Die Zeitpunkte sind 14:00 und 14:45. Um 13:59 ist keiner faellig, um 14:00
  // der erste, um 14:45 der zweite — der erste ist dann 45 Minuten vorbei und
  // faellt unter die Zehn-Minuten-Regel.
  assert.deepEqual(dueReminders([event], at(2026, 3, 14, 13, 59)), []);
  assert.deepEqual(
    dueReminders([event], at(2026, 3, 14, 14, 0)).map((reminder) => reminder.atMs),
    [at(2026, 3, 14, 14, 0)],
  );
  assert.deepEqual(
    dueReminders([event], at(2026, 3, 14, 14, 45)).map((reminder) => reminder.body),
    ["in 15 Minuten · 15:00"],
  );
  // Zwei Zeitpunkte innerhalb des Fensters erscheinen beide, aufsteigend.
  const close = timed({ reminders: [{ minutesBefore: 15 }, { minutesBefore: 20 }] });
  const both = dueReminders([close], at(2026, 3, 14, 14, 46));
  assert.deepEqual(both.map((reminder) => reminder.body), [
    "in 20 Minuten · 15:00",
    "in 15 Minuten · 15:00",
  ]);
});

test("minutesBefore zero fires at the start", () => {
  const due = dueReminders([timed({ reminders: [{ minutesBefore: 0 }] })], at(2026, 3, 14, 15, 0));
  assert.equal(due.length, 1);
  assert.equal(due[0].atMs, at(2026, 3, 14, 15, 0));
  assert.equal(due[0].body, "jetzt · 15:00");
});

test("an all-day event fires at the wall-clock time of the chosen day", () => {
  const event = allDay({ reminders: [{ daysBefore: 0, atTime: "08:00" }, { daysBefore: 1, atTime: "18:00" }] });
  assert.deepEqual(dueReminders([event], at(2026, 11, 16, 17, 59)), []);
  const dayBefore = dueReminders([event], at(2026, 11, 16, 18, 0));
  assert.deepEqual(dayBefore.map((reminder) => reminder.body), ["Ganztägig · in 1 Tag · Di 17.11."]);
  const sameDay = dueReminders([event], at(2026, 11, 17, 8, 0));
  assert.deepEqual(sameDay.map((reminder) => reminder.body), ["Ganztägig · Di 17.11."]);
  assert.deepEqual(sameDay.map((reminder) => reminder.atMs), [at(2026, 11, 17, 8, 0)]);
});

test("the wrong key set for the event falls away", () => {
  // minutesBefore an einem Ganztagstermin: es gibt keinen Beginn mit Uhrzeit.
  // daysBefore an einem Termin mit Uhrzeit: dieselbe Aussage, ungenauer.
  // Beide Schluesselsaetze in einem Eintrag: derselbe Fall. Der gueltige
  // Nachbar bleibt, damit nicht das ganze Feld auf den Altbestand faellt.
  const day = allDay({
    reminders: [
      { minutesBefore: 15 },
      { daysBefore: 1, atTime: "18:00" },
      { minutesBefore: 30, daysBefore: 2, atTime: "09:00" },
    ],
  });
  assert.deepEqual(
    dueReminders([day], at(2026, 11, 16, 18, 0)).map((reminder) => reminder.body),
    ["Ganztägig · in 1 Tag · Di 17.11."],
  );
  const appointment = timed({
    reminders: [
      { daysBefore: 1, atTime: "18:00" },
      { minutesBefore: 15 },
      { minutesBefore: 30, daysBefore: 0, atTime: "08:00" },
    ],
  });
  assert.deepEqual(
    dueReminders([appointment], at(2026, 3, 14, 14, 45)).map((reminder) => reminder.body),
    ["in 15 Minuten · 15:00"],
  );
});

test("a field with no valid entry falls back to the previous lead", () => {
  // Ein Array aus einem einzigen falschen Eintrag ist keine Entscheidung
  // gegen Erinnerungen — es zaehlt wie ein fehlendes Feld.
  assert.deepEqual(
    dueReminders([allDay({ reminders: [{ minutesBefore: 15 }] })], at(2026, 11, 17, 8, 0))
      .map((reminder) => reminder.body),
    ["Ganztägig · Di 17.11."],
  );
  assert.deepEqual(
    dueReminders([timed({ reminders: [{ daysBefore: 1, atTime: "18:00" }] })], at(2026, 3, 14, 14, 55))
      .map((reminder) => reminder.body),
    ["in 5 Minuten · 15:00"],
  );
});

test("invalid entries fall away one by one", () => {
  const event = timed({
    reminders: [
      { minutesBefore: -5 },
      { minutesBefore: 15 },
      { minutesBefore: 20161 },
      { minutesBefore: 15.5 },
      { minutesBefore: "15" },
      { minutesBefore: Number.NaN },
      { minutesBefore: Number.POSITIVE_INFINITY },
      42,
      null,
      {},
      [15],
    ],
  });
  const due = dueReminders([event], at(2026, 3, 14, 14, 45));
  assert.deepEqual(due.map((reminder) => reminder.body), ["in 15 Minuten · 15:00"]);
});

test("the bounds are inclusive", () => {
  // 20160 Minuten sind 14 Tage, 20161 nicht. Der gueltige Nachbar macht den
  // Unterschied sichtbar: ohne ihn fiele das Feld auf den Altbestand.
  const latest = timed({ reminders: [{ minutesBefore: 20160 }, { minutesBefore: 20161 }] });
  assert.equal(
    nextReminderAt([latest], at(2026, 3, 14, 15, 0) - 20161 * 60_000),
    at(2026, 3, 14, 15, 0) - 20160 * 60_000,
  );
  // 14 Tage vorher, 23:59 ist erlaubt — 15 Tage nicht.
  const day = allDay({ reminders: [{ daysBefore: 14, atTime: "23:59" }, { daysBefore: 15, atTime: "23:59" }] });
  assert.equal(nextReminderAt([day], at(2026, 11, 1, 0, 0)), at(2026, 11, 3, 23, 59));
  // Uhrzeiten ausserhalb 00:00–23:59 und mit einer Ziffer fallen weg; der
  // gueltige Eintrag bleibt.
  const times = allDay({
    reminders: [{ daysBefore: 0, atTime: "24:00" }, { daysBefore: 0, atTime: "8:00" }, { daysBefore: 0, atTime: "08:00" }],
  });
  assert.equal(nextReminderAt([times], at(2026, 11, 17, 0, 0)), at(2026, 11, 17, 8, 0));
  // Nicht ganzzahlige Tage fallen weg.
  const fractional = allDay({ reminders: [{ daysBefore: 1.5, atTime: "08:00" }, { daysBefore: 2, atTime: "08:00" }] });
  assert.equal(nextReminderAt([fractional], at(2026, 11, 10, 0, 0)), at(2026, 11, 15, 8, 0));
});

// --- Grenzen der Anzahl ----------------------------------------------------

test("duplicates count once", () => {
  const event = timed({ reminders: [{ minutesBefore: 15 }, { minutesBefore: 15 }, { minutesBefore: 60 }] });
  assert.equal(nextReminderAt([event], at(2026, 3, 14, 12, 0)), at(2026, 3, 14, 14, 0));
  // Nach dem ersten Zeitpunkt kommt nur der zweite — die Doppel fallen weg.
  assert.equal(nextReminderAt([event], at(2026, 3, 14, 14, 0)), at(2026, 3, 14, 14, 45));
  assert.equal(nextReminderAt([event], at(2026, 3, 14, 14, 45)), null);
});

test("at most five reminders per event, the five earliest ones", () => {
  const event = timed({
    reminders: [600, 300, 120, 60, 30, 10, 5].map((minutes) => ({ minutesBefore: minutes })),
  });
  const target = at(2026, 3, 14, 15, 0);
  // Die Zeitpunkte der Reihe nach abfragen: `nextReminderAt` ist strikt
  // kuenftig, also liefert jede Runde den naechsten.
  const times = [];
  let now = at(2026, 3, 14, 0, 0);
  for (;;) {
    const next = nextReminderAt([event], now);
    if (next === null) break;
    times.push(next);
    now = next;
  }
  assert.equal(times.length, MAX_REMINDERS_PER_EVENT);
  assert.deepEqual(times, [120, 60, 30, 10, 5].map((minutes) => target - minutes * 60_000));
});

// --- Die Zehn-Minuten-Regel ------------------------------------------------

test("a reminder that is more than ten minutes past is not repeated", () => {
  const event = timed({ reminders: [{ minutesBefore: 15 }] }); // 14:45
  assert.equal(dueReminders([event], at(2026, 3, 14, 14, 45)).length, 1, "genau darauf");
  assert.equal(dueReminders([event], at(2026, 3, 14, 14, 55)).length, 1, "genau zehn Minuten spaeter");
  assert.equal(dueReminders([event], at(2026, 3, 14, 14, 55) + 1).length, 0, "eine Millisekunde zu spaet");
  assert.equal(dueReminders([event], at(2026, 3, 15, 9, 0)).length, 0, "am naechsten Morgen");
});

// --- Der naechste Termin ---------------------------------------------------

test("the next reminder is the earliest future instant", () => {
  const events = [
    timed({ id: "a", reminders: [{ minutesBefore: 15 }] }), // 14.03. 14:45
    allDay({ id: "b", reminders: [{ daysBefore: 1, atTime: "18:00" }] }), // 16.11. 18:00
  ];
  assert.equal(nextReminderAt(events, at(2026, 3, 14, 12, 0)), at(2026, 3, 14, 14, 45));
  assert.equal(nextReminderAt(events, at(2026, 3, 14, 14, 45)), at(2026, 11, 16, 18, 0));
  assert.equal(nextReminderAt(events, at(2026, 11, 16, 18, 0)), null, "der Zeitpunkt selbst ist nicht mehr kuenftig");
  assert.equal(nextReminderAt([], at(2026, 3, 14, 12, 0)), null);
});

test("an event without a valid start has no reminders", () => {
  for (const start of ["", "morgen", "2026-02-30T15:00", "2026-03-14T25:00", "2026-03-14T15:00"]) {
    const event = timed({ start });
    const expected = start === "2026-03-14T15:00" ? 1 : 0;
    assert.equal(
      nextReminderAt([event], at(2026, 3, 14, 12, 0)) === null ? 0 : 1,
      expected,
      `start=${start}`,
    );
  }
});

// --- Der Schluessel --------------------------------------------------------

test("the key is the event id and the instant, and it does not move", () => {
  const event = timed({ reminders: [{ minutesBefore: 15 }] });
  const first = dueReminders([event], at(2026, 3, 14, 14, 45))[0];
  const later = dueReminders([event], at(2026, 3, 14, 14, 47))[0];
  assert.equal(first.key, `ev-timed@${at(2026, 3, 14, 14, 45)}`);
  assert.equal(later.key, first.key, "derselbe Zeitpunkt, derselbe Schluessel");
});

// --- Die Texte -------------------------------------------------------------

test("the lead text names minutes, hours and days", () => {
  assert.equal(leadText(0), "jetzt");
  assert.equal(leadText(-5), "jetzt");
  assert.equal(leadText(1), "in 1 Minute");
  assert.equal(leadText(2), "in 2 Minuten");
  assert.equal(leadText(15), "in 15 Minuten");
  assert.equal(leadText(59), "in 59 Minuten");
  assert.equal(leadText(60), "in 1 Stunde");
  assert.equal(leadText(90), "in 90 Minuten");
  assert.equal(leadText(120), "in 2 Stunden");
  assert.equal(leadText(1440), "in 1 Tag");
  assert.equal(leadText(2880), "in 2 Tagen");
  assert.equal(leadText(10080), "in 7 Tagen");
  assert.equal(leadText(1260), "in 21 Stunden");
  assert.equal(leadText(4320), "in 3 Tagen");
  assert.equal(leadText(20160), "in 14 Tagen");
});

test("the text of a timed reminder names the lead and the start", () => {
  const event = timed();
  assert.equal(reminderText(event, at(2026, 3, 14, 14, 45)), "in 15 Minuten · 15:00");
  assert.equal(reminderText(event, at(2026, 3, 14, 14, 0)), "in 1 Stunde · 15:00");
  assert.equal(reminderText(event, at(2026, 3, 14, 15, 0)), "jetzt · 15:00");
});

test("the text of an all-day reminder names the day and the distance", () => {
  const event = allDay();
  assert.equal(reminderText(event, at(2026, 11, 17, 8, 0)), "Ganztägig · Di 17.11.");
  assert.equal(reminderText(event, at(2026, 11, 16, 18, 0)), "Ganztägig · in 1 Tag · Di 17.11.");
  assert.equal(reminderText(event, at(2026, 11, 14, 8, 0)), "Ganztägig · in 3 Tagen · Di 17.11.");
});

test("the body carries the event title and no duplicate keys", () => {
  const events = [
    timed({ id: "one", reminders: [{ minutesBefore: 15 }] }),
    timed({ id: "two", reminders: [{ minutesBefore: 15 }] }),
  ];
  const due = dueReminders(events, at(2026, 3, 14, 14, 45));
  assert.deepEqual(due.map((reminder) => reminder.key), [
    `one@${at(2026, 3, 14, 14, 45)}`,
    `two@${at(2026, 3, 14, 14, 45)}`,
  ]);
  assert.deepEqual(due.map((reminder) => reminder.title), ["Zahnarzt", "Zahnarzt"]);
});

// --- Die Zeitumstellung ----------------------------------------------------
// `wallClockMs` baut die lokale Wanduhr mit `new Date(jahr, monat - 1, tag, …)`.
// Genau das ist gewollt — und es hat zwei Faelle, die man nicht raten darf:
// der eine rechnet ueber die Umstellung, der andere liegt in der Luecke.

test("a reminder that crosses the clock change keeps its real lead", () => {
  // Der Termin beginnt 03:00 am Tag der Umstellung. 120 Minuten vorher ist
  // 00:00 derselben Nacht: auf der Wanduhr drei Stunden, real zwei. Gezaehlt
  // wird die echte Zeit (Beginn minus Vorlauf), die Zeile nennt sie auch so.
  const event = timed({
    start: "2026-03-29T03:00",
    end: "2026-03-29T04:00",
    reminders: [{ minutesBefore: 120 }],
  });
  const start = at(2026, 3, 29, 3, 0);
  const instant = start - 120 * 60_000;
  assert.equal(nextReminderAt([event], start - 86_400_000), instant);
  assert.equal(new Date(instant).getHours(), 0, "die Erinnerung liegt um Mitternacht");
  assert.equal(new Date(instant).getMinutes(), 0);
  const due = dueReminders([event], instant);
  assert.equal(due.length, 1);
  assert.equal(due[0].atMs, instant);
  assert.equal(due[0].body, "in 2 Stunden · 03:00");
});

test("a start inside the clock jump is moved forward, as JavaScript defines", () => {
  // 02:30 gibt es am 29.03.2026 in Berlin nicht. `new Date(2026, 2, 29, 2, 30)`
  // schiebt auf 03:30 — die Erinnerung feuert zur naechsten existierenden
  // Uhrzeit. Der Termin selbst behaelt seine eingetragene Wanduhr im Text.
  const event = timed({
    start: "2026-03-29T02:30",
    end: "2026-03-29T03:30",
    reminders: [{ minutesBefore: 0 }],
  });
  const instant = at(2026, 3, 29, 3, 30);
  assert.equal(nextReminderAt([event], at(2026, 3, 29, 0, 0)), instant);
  const due = dueReminders([event], instant);
  assert.equal(due.length, 1);
  assert.equal(due[0].atMs, instant);
  assert.equal(due[0].body, "jetzt · 02:30");
});

test("the day distance survives the turn of the year", () => {
  // Der 2. Januar ist ein Samstag, und der Abstand zum 1. Januar ist eine
  // Tageszahl — kein Datumsvergleich, bei dem ein Jahreswechsel dazwischen
  // liegt.
  const event = allDay({
    start: "2027-01-02",
    end: "2027-01-03",
    reminders: [{ daysBefore: 1, atTime: "18:00" }, { daysBefore: 0, atTime: "08:00" }],
  });
  assert.equal(reminderText(event, at(2027, 1, 1, 18, 0)), "Ganztägig · in 1 Tag · Sa 02.01.");
  assert.equal(reminderText(event, at(2027, 1, 2, 8, 0)), "Ganztägig · Sa 02.01.");
  const due = dueReminders([event], at(2027, 1, 1, 18, 0));
  assert.equal(due.length, 1);
  assert.equal(due[0].atMs, at(2027, 1, 1, 18, 0));
  assert.equal(due[0].body, "Ganztägig · in 1 Tag · Sa 02.01.");
});
