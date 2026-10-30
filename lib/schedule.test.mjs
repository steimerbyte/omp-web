import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  describeSchedule,
  isUnsatisfiable,
  nextRunAfter,
  parseSchedule,
  SCHEDULE_PRESETS,
  ScheduleError,
} = await jiti.import("./schedule.ts");

/**
 * Die Zeitzone dieses Tests ist die des Servers — genau das ist die
 * dokumentierte Entscheidung des Moduls. Damit die Erwartungen trotzdem
 * lesbar bleiben, werden sie mit `local()` gebaut und nicht als ISO-String
 * mit `Z` geschrieben: `new Date(2026, 2, 14, 8, 0)` ist "14. Maerz 08:00 in
 * der Zone dieses Rechners", und `nextRunAfter` rechnet in derselben Zone.
 */
function local(year, month, day, hour = 0, minute = 0) {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

/** Ein Datum lesbar machen: `2026-03-14T08:00:00` in lokaler Zeit. */
function shown(ms) {
  const date = new Date(ms);
  return [
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
    `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
  ].join("T");
}

// --- Grammatik -----------------------------------------------------------------

test("*/15 matches the quarter hours", () => {
  const schedule = parseSchedule("*/15 * * * *");
  assert.deepEqual(
    schedule.minutes.flatMap((hit, value) => (hit ? [value] : [])),
    [0, 15, 30, 45],
  );
  assert.equal(schedule.hours.every(Boolean), true);
});

test("0 8 * * * is one minute of the day", () => {
  const schedule = parseSchedule("0 8 * * *");
  assert.deepEqual(schedule.minutes.flatMap((hit, value) => (hit ? [value] : [])), [0]);
  assert.deepEqual(schedule.hours.flatMap((hit, value) => (hit ? [value] : [])), [8]);
  assert.equal(schedule.dayOfMonthRestricted, false);
  assert.equal(schedule.dayOfWeekRestricted, false);
});

test("0 8 * * 1-5 covers Monday to Friday and not the weekend", () => {
  const schedule = parseSchedule("0 8 * * 1-5");
  // Index 0 = Sonntag, wie in `Date#getDay`.
  assert.deepEqual(schedule.daysOfWeek, [false, true, true, true, true, true, false]);
});

test("1-30/2 is the odd days of the month", () => {
  const schedule = parseSchedule("0 0 1-30/2 * *");
  const days = schedule.daysOfMonth.flatMap((hit, value) => (hit ? [value] : []));
  assert.deepEqual(days, [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29]);
});

test("a comma list is the union of its tokens", () => {
  const schedule = parseSchedule("0,30 9,17 * * *");
  assert.deepEqual(schedule.minutes.flatMap((hit, value) => (hit ? [value] : [])), [0, 30]);
  assert.deepEqual(schedule.hours.flatMap((hit, value) => (hit ? [value] : [])), [9, 17]);
});

test("7 is Sunday, like 0", () => {
  assert.deepEqual(parseSchedule("0 8 * * 7").daysOfWeek, parseSchedule("0 8 * * 0").daysOfWeek);
  assert.equal(parseSchedule("0 8 * * 7").daysOfWeek.filter(Boolean).length, 1);
});

test("a schedule parsed from a padded expression keeps the normalized text", () => {
  assert.equal(parseSchedule("  0   8  *  *  * ").expression, "0 8 * * *");
});

// --- Ablehnung -------------------------------------------------------------------

test("a six-field expression is refused with the field count", () => {
  assert.throws(
    () => parseSchedule("0 0 8 * * *"),
    (error) => error instanceof ScheduleError
      && error.field === "expression"
      && /Expected 5 cron fields/.test(error.message),
  );
});

test("@reboot is refused, not interpreted", () => {
  assert.throws(
    () => parseSchedule("@reboot"),
    (error) => error instanceof ScheduleError && error.field === "expression",
  );
});

test("L, W and # are refused and name their field and token", () => {
  for (const [expression, field, token] of [
    ["0 8 L * *", "dayOfMonth", "L"],
    ["0 8 15W * *", "dayOfMonth", "15W"],
    ["0 8 * * 5#2", "dayOfWeek", "5#2"],
  ]) {
    assert.throws(
      () => parseSchedule(expression),
      (error) => error instanceof ScheduleError
        && error.field === field
        && error.token === token
        && error.message.includes(token)
        && error.message.includes(field),
      `expected ${expression} to be refused at ${field} with ${token}`,
    );
  }
});

test("an out-of-range value is refused", () => {
  assert.throws(() => parseSchedule("60 * * * *"), (error) => error.field === "minute" && error.token === "60");
  assert.throws(() => parseSchedule("0 24 * * *"), (error) => error.field === "hour" && error.token === "24");
  assert.throws(() => parseSchedule("0 0 0 * *"), (error) => error.field === "dayOfMonth");
  assert.throws(() => parseSchedule("0 0 * 13 *"), (error) => error.field === "month");
  assert.throws(() => parseSchedule("0 0 * * 8"), (error) => error.field === "dayOfWeek");
});

test("a zero step and a descending range are refused", () => {
  assert.throws(() => parseSchedule("*/0 * * * *"), /must be at least 1/);
  assert.throws(() => parseSchedule("0 0 10-5 * *"), /descending/);
});

test("an empty token is refused", () => {
  assert.throws(() => parseSchedule("1,,2 8 * * *"), (error) => error.field === "minute");
  assert.throws(() => parseSchedule(""), /Expected 5 cron fields/);
});

// --- Faelligkeit -------------------------------------------------------------------

test("a time exactly on a slot returns the next slot, not itself", () => {
  const schedule = parseSchedule("0 8 * * *");
  const onSlot = local(2026, 3, 14, 8, 0);
  // 08:00:00 liegt genau auf dem Slot — "nach" heisst strikt nach.
  assert.equal(shown(nextRunAfter(schedule, onSlot)), "2026-03-15T08:00");
  // Eine Sekunde nach dem Slot ist derselbe Fall.
  assert.equal(shown(nextRunAfter(schedule, onSlot + 1000)), "2026-03-15T08:00");
  // Eine Minute davor liegt der Slot.
  assert.equal(shown(nextRunAfter(schedule, onSlot - 60_000)), "2026-03-14T08:00");
});

test("the next run crosses a month boundary", () => {
  const schedule = parseSchedule("0 8 1 * *");
  assert.equal(shown(nextRunAfter(schedule, local(2026, 3, 14, 9, 0))), "2026-04-01T08:00");
});

test("the next run crosses a year boundary", () => {
  const schedule = parseSchedule("0 8 1 1 *");
  assert.equal(shown(nextRunAfter(schedule, local(2026, 12, 31, 23, 59))), "2027-01-01T08:00");
});

test("a February 29 schedule finds the leap day", () => {
  const schedule = parseSchedule("0 8 29 2 *");
  assert.equal(shown(nextRunAfter(schedule, local(2026, 1, 1))), "2028-02-29T08:00");
  // Und danach der naechste: vier Jahre spaeter, weil 2100 kein Schaltjahr ist
  // spielt hier noch keine Rolle — 2032 ist das naechste.
  assert.equal(shown(nextRunAfter(schedule, local(2028, 2, 29, 9, 0))), "2032-02-29T08:00");
});

test("day-of-month and day-of-week combine with OR when both are restricted", () => {
  // POSIX: "0 0 13 * 5" heisst jeder Freitag *und* jeder 13., nicht beides
  // zugleich. Mit UND waere der erste Treffer nach dem 14.03.2026 der
  // Freitag, der 13. November 2026; der 20.03.2026 ist ein Freitag, aber
  // kein 13. — dass er hier gewinnt, ist der Beweis fuer ODER.
  const schedule = parseSchedule("0 0 13 * 5");
  assert.equal(shown(nextRunAfter(schedule, local(2026, 3, 14, 0, 0))), "2026-03-20T00:00");
  // Und der 13.04.2026 ist ein Montag: der Treffer kommt hier allein aus dem
  // Tagesdatum-Zweig, einen Tag vor dem naechsten Freitag (17.04.).
  assert.equal(shown(nextRunAfter(schedule, local(2026, 4, 12, 0, 0))), "2026-04-13T00:00");
});

test("a star with a step in the day of month still counts as restricted", () => {
  // `*/2` im Tagesdatum ist nicht genau `*`, also gilt die ODER-Regel: jeder
  // ungerade Tag oder jeder Montag. Der Beweis ist der 22.06.2026 — ein
  // Montag mit geradem Datum. Unter Vixies Auslegung (ein fuehrender Stern
  // gilt als uneingeschraenkt) waere der Ausdruck nur noch "jeder ungerade
  // Tag", und dieser Montag fiele weg.
  const schedule = parseSchedule("0 8 */2 * 1");
  assert.equal(schedule.dayOfMonthRestricted, true);
  assert.equal(shown(nextRunAfter(schedule, local(2026, 6, 21, 9, 0))), "2026-06-22T08:00");
  // Danach der 23. (ungerade) — der Wochentag ist es nicht mehr.
  assert.equal(shown(nextRunAfter(schedule, local(2026, 6, 22, 9, 0))), "2026-06-23T08:00");
});

test("a restricted day-of-week alone ignores the day of month", () => {
  const schedule = parseSchedule("0 8 * * 1");
  // 14.03.2026 ist ein Samstag, der naechste Montag der 16.
  assert.equal(shown(nextRunAfter(schedule, local(2026, 3, 14, 9, 0))), "2026-03-16T08:00");
});

test("a restricted day of month alone ignores the weekday", () => {
  const schedule = parseSchedule("0 8 15 * *");
  assert.equal(shown(nextRunAfter(schedule, local(2026, 3, 14, 9, 0))), "2026-03-15T08:00");
});

test("*/15 fires every quarter hour", () => {
  const schedule = parseSchedule("*/15 * * * *");
  assert.equal(shown(nextRunAfter(schedule, local(2026, 3, 14, 9, 1))), "2026-03-14T09:15");
  assert.equal(shown(nextRunAfter(schedule, local(2026, 3, 14, 9, 45) + 60_000)), "2026-03-14T10:00");
});

test("the sequence of runs is strictly increasing over a long stretch", () => {
  const schedule = parseSchedule("23 4 * * 1-5");
  let cursor = local(2026, 1, 1);
  let previous = cursor;
  const seen = [];
  for (let index = 0; index < 200; index += 1) {
    const next = nextRunAfter(schedule, cursor);
    assert.ok(next > cursor, `run ${index} is not after the previous time`);
    assert.equal(next % 60_000, 0, "a run lands on a whole minute");
    assert.ok(next > previous);
    previous = next;
    cursor = next;
    seen.push(next);
  }
  // 200 Werktage in Folge: jeder Treffer ist ein Werktag um 04:23.
  for (const ms of seen) {
    const date = new Date(ms);
    assert.equal(date.getHours(), 4);
    assert.equal(date.getMinutes(), 23);
    assert.ok(date.getDay() >= 1 && date.getDay() <= 5, `${date.toDateString()} is a weekday`);
  }
});

test("a schedule that never matches is refused instead of scanning forever", () => {
  assert.throws(() => nextRunAfter(parseSchedule("0 0 31 4 *"), local(2026, 1, 1)), /No matching time within 2921 days/);
});

test("a February 29 schedule across the 2100 gap is not refused", () => {
  // Der groesste Abstand zwischen zwei Schalttagen ist 2096 → 2104. Mit einer
  // Vier-Jahres-Grenze haette die Suche von 2097 aus nichts gefunden, obwohl
  // 2104 existiert; die Grenze im Modul ist deshalb 2921 Tage.
  const schedule = parseSchedule("0 8 29 2 *");
  assert.equal(shown(nextRunAfter(schedule, local(2097, 1, 1))), "2104-02-29T08:00");
});

// --- Beschreibung und Voreinstellungen -------------------------------------------------

test("describeSchedule describes the shapes a person would name", () => {
  assert.deepEqual(describeSchedule("0 8 * * *"), { kind: "daily", hour: 8, minute: 0 });
  assert.deepEqual(describeSchedule("*/15 * * * *"), { kind: "everyMinutes", step: 15 });
  assert.deepEqual(describeSchedule("0 8 * * 1-5"), { kind: "weekdays", hour: 8, minute: 0 });
  assert.deepEqual(describeSchedule("0 * * * *"), { kind: "hourly", minute: 0 });
  assert.deepEqual(describeSchedule("0 8 * * 1"), { kind: "weekly", weekday: 1, hour: 8, minute: 0 });
  assert.deepEqual(describeSchedule("30 6 * * 0"), { kind: "weekly", weekday: 0, hour: 6, minute: 30 });
  assert.deepEqual(describeSchedule("* * * * *"), { kind: "everyMinute" });
  // Minute ungleich 0 ist eine eigene Form: "stuendlich" nennt sie nicht.
  assert.deepEqual(describeSchedule("7 * * * *"), { kind: "hourly", minute: 7 });
});

test("describeSchedule maps both Sunday spellings to the same weekday", () => {
  // Cron kennt 0 und 7 als Sonntag; der Deskriptor traegt nur Date#getDay, sonst
  // gaebe es zwei Wahrheiten ueber denselben Tag.
  assert.deepEqual(describeSchedule("0 8 * * 7"), describeSchedule("0 8 * * 0"));
  assert.deepEqual(describeSchedule("0 8 * * 7"), { kind: "weekly", weekday: 0, hour: 8, minute: 0 });
});

test("describeSchedule falls back to the expression it cannot phrase", () => {
  assert.deepEqual(describeSchedule("5,7,23 1-5 * * *"), { kind: "custom", expression: "5,7,23 1-5 * * *" });
  // Ein ungueltiger Ausdruck hat keine Bedeutung. Der Deskriptor ist `null` und
  // nicht der rohe Text: die Ansicht zeigt dann ihren eigenen Fehlersatz.
  assert.equal(describeSchedule("nonsense"), null);
  // Ein Wert aus einem Request-Body ist zur Laufzeit nicht zwingend ein String;
  // die Beschreibung darf daran nicht scheitern.
  assert.equal(describeSchedule(42), null);
});

test("every preset parses, and its labelKey names a catalogue entry", () => {
  for (const preset of SCHEDULE_PRESETS) {
    const schedule = parseSchedule(preset.cron);
    assert.equal(schedule.expression, preset.cron);
    // Der Schluessel wird zur Laufzeit zusammengesetzt (`scheduled.<labelKey>`),
    // also kann TypeScript ihn nicht pruefen — dieser Test ist die Pruefung.
    assert.equal(typeof preset.labelKey, "string");
    assert.match(preset.labelKey, /^preset[A-Z]/);
    assert.equal(describeSchedule(preset.cron)?.kind !== "custom", true, `${preset.id} hat keine Beschreibung`);
  }
});

test("the preset to cron mapping is byte-identical", () => {
  // Die Zuordnung ist eine Zusicherung, nicht eine Beschriftung: wer sie
  // aendert, legt eine Aufgabe fuer eine Zeit an, die niemand gewaehlt hat.
  // Deshalb steht der erwartete Ausdruck hier vollstaendig und in der
  // Reihenfolge, in der der Dialog ihn anbietet.
  assert.deepEqual(
    SCHEDULE_PRESETS.map((preset) => [preset.id, preset.cron]),
    [
      ["hourly", "0 * * * *"],
      ["every-15-minutes", "*/15 * * * *"],
      ["daily-0800", "0 8 * * *"],
      ["weekdays-0800", "0 8 * * 1-5"],
      ["weekly-monday-0800", "0 8 * * 1"],
    ],
  );
});

test("the presets cover the five required schedules", () => {
  const crons = SCHEDULE_PRESETS.map((preset) => preset.cron);
  for (const cron of ["0 * * * *", "0 8 * * *", "0 8 * * 1-5", "0 8 * * 1", "*/15 * * * *"]) {
    assert.ok(crons.includes(cron), `${cron} is missing from the presets`);
  }
  assert.equal(new Set(SCHEDULE_PRESETS.map((preset) => preset.id)).size, SCHEDULE_PRESETS.length);
});

// --- Nie treffende Plaene ------------------------------------------------------

/**
 * Ein Plan ohne Kalendertag wird **vor** der Suche erkannt.
 *
 * Die Zusicherung hat zwei Haelften, und beide gehoeren hierher: der Praedikat
 * sagt "nie", und die Suche kommt ohne die 4,2 Mio. Minuten aus. Nur das
 * Praedikat zu pruefen liesse offen, ob `nextRunAfter` es ueberhaupt benutzt;
 * nur die Zeit zu messen waere ein Test, der von der Maschine abhaengt.
 */
test("0 0 31 2 * is unsatisfiable and is refused without scanning", () => {
  const schedule = parseSchedule("0 0 31 2 *");
  assert.equal(isUnsatisfiable(schedule), true, "der 31. Februar existiert nicht");

  const started = performance.now();
  assert.throws(() => nextRunAfter(schedule, local(2026, 3, 14, 9, 0)), ScheduleError);
  const elapsed = performance.now() - started;

  // Die Suche brauchte vorher gemessen 208-261 ms. Eine Grenze von 20 ms ist
  // weit ueber dem, was der Aufruf jetzt kostet (Mikrosekunden), und weit
  // unter dem, was die Schleife kostet — sie unterscheidet die Bauarten und
  // nicht die Geschwindigkeit dieser Maschine.
  assert.ok(elapsed < 20, `der Aufruf hat ${elapsed.toFixed(1)} ms gebraucht, also wurde gesucht`);
});

test("0 0 31 2 1 is satisfiable: POSIX ORs the day fields, so Mondays in February fire", () => {
  // Der Gegentest zum Praedikat. Wer das Tagesdatum allein prueft, haelt
  // diesen Plan fuer tot und die Aufgabe liefe nie wieder — obwohl sie jeden
  // Montag im Februar faellig ist.
  const schedule = parseSchedule("0 0 31 2 1");
  assert.equal(isUnsatisfiable(schedule), false, "ein eingeschraenkter Wochentag rettet den toten Kalendertag");

  const next = nextRunAfter(schedule, local(2026, 3, 14, 9, 0));
  const when = new Date(next);
  assert.equal(when.getMonth(), 1, "der naechste Treffer liegt im Februar");
  assert.equal(when.getDay(), 1, "und es ist ein Montag");
});

test("ordinary schedules are satisfiable", () => {
  for (const cron of ["0 8 * * *", "*/15 * * * *", "0 8 * * 1-5", "0 8 29 2 *", "0 0 13 * 5", "0 0 31 * *"]) {
    assert.equal(isUnsatisfiable(parseSchedule(cron)), false, cron);
  }
});

test("a leap day schedule counts as satisfiable, because leap years exist", () => {
  const schedule = parseSchedule("0 8 29 2 *");
  assert.equal(isUnsatisfiable(schedule), false);
  assert.equal(shown(nextRunAfter(schedule, local(2026, 3, 14, 9, 0))), "2028-02-29T08:00");
});

test("a dead day-of-month in one month is not dead when another month has it", () => {
  // Der 31. gibt es in sieben Monaten; nur im Februar nicht. `0 0 31 * *` ist
  // deshalb erfuellbar, und die Suche findet den naechsten 31.
  const schedule = parseSchedule("0 0 31 * *");
  assert.equal(isUnsatisfiable(schedule), false);
  assert.equal(shown(nextRunAfter(schedule, local(2026, 3, 14, 9, 0))), "2026-03-31T00:00");
});

test("an impossible month/day pair spread over two months is still dead", () => {
  // 30. Februar und 31. Februar: beide Monate sind Februar, beide Tage gibt es
  // dort nicht.
  assert.equal(isUnsatisfiable(parseSchedule("0 0 30,31 2 *")), true);
  assert.throws(() => nextRunAfter(parseSchedule("0 0 30,31 2 *"), local(2026, 3, 14, 9, 0)), ScheduleError);
});
