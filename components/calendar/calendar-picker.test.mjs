import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  DIAL_RING_RATIO,
  DIAL_RING_SPLIT,
  PICKER_WEEKDAY_INITIALS,
  PICKER_WIDTH,
  PICKER_RATIO,
  dialAngle,
  dialNumberPositions,
  dialValueAt,
  nextPickerDate,
  pickerDateHeader,
  pickerMonthGrid,
  pickerMonthLabel,
  shiftPickerMonth,
} = await jiti.import("./calendar-picker.ts");

// --- Das Raster ------------------------------------------------------------
// Die Sechs-Zeilen-Regel ist dieselbe wie in der Monatsansicht: ein Monat mit
// fuenf Wochen bekommt trotzdem sechs Zeilen, damit der Dialog beim Blaettern
// nicht springt. Ein Test, der nur „42 Zellen" prueft, wuerde das nicht
// festhalten — deshalb wird die *Form* jeder Woche geprueft.

test("the month grid is six rows of seven, Monday first", () => {
  const grid = pickerMonthGrid(2026, 11); // November 2026, der 1. ist ein Sonntag
  assert.equal(grid.length, 6);
  for (const row of grid) assert.equal(row.length, 7);
  assert.deepEqual(grid[0], [null, null, null, null, null, null, "2026-11-01"]);
  assert.equal(grid[1][0], "2026-11-02");
  assert.equal(grid[1][6], "2026-11-08");
  assert.equal(grid[5][0], "2026-11-30");
  assert.equal(grid[5][1], null);
});

test("the grid carries only days of the month", () => {
  const february = pickerMonthGrid(2026, 2); // 28 Tage, der 1. ist ein Sonntag
  const days = february.flat().filter((day) => day !== null);
  assert.equal(days.length, 28);
  assert.equal(days[0], "2026-02-01");
  assert.equal(days[27], "2026-02-28");
  assert.equal(february[0].filter((day) => day === null).length, 6);
  assert.equal(february[4].filter((day) => day !== null).length, 6, "die vorletzte Zeile traegt noch Tage");
  assert.equal(february[5].every((day) => day === null), true, "die letzte Zeile ist leer");
});

test("a month that needs six rows keeps six", () => {
  // Der 1. August 2026 ist ein Samstag: 31 Tage plus sechs Zellen davor
  // brauchen sechs Zeilen.
  const august = pickerMonthGrid(2026, 8);
  assert.equal(august.length, 6);
  assert.equal(august[0][5], "2026-08-01");
  assert.equal(august[5][0], "2026-08-31");
  assert.equal(august[5][1], null);
});

test("the grid of a month with five weeks still has six rows", () => {
  const june = pickerMonthGrid(2026, 6); // 30 Tage, der 1. ist ein Montag
  assert.equal(june.length, 6);
  assert.equal(june[0][0], "2026-06-01");
  assert.deepEqual(june[5], [null, null, null, null, null, null, null]);
});

// --- Die Kopfzeilen --------------------------------------------------------

test("the date header names the weekday and the day in German", () => {
  assert.deepEqual(pickerDateHeader("2026-11-18"), { weekday: "Mi.", dayMonth: "18. Nov." });
  assert.deepEqual(pickerDateHeader("2026-03-01"), { weekday: "So.", dayMonth: "1. Mär." });
  // Der erste Tag des Monats steht ohne fuehrende Null da — „18." nicht „018.".
  assert.deepEqual(pickerDateHeader("2026-01-09"), { weekday: "Fr.", dayMonth: "9. Jan." });
});

test("the month label is the German month and the year", () => {
  assert.equal(pickerMonthLabel(2026, 11), "November 2026");
  assert.equal(pickerMonthLabel(2027, 3), "März 2027");
});

test("the weekday initials are one letter per day, Monday first", () => {
  assert.deepEqual(PICKER_WEEKDAY_INITIALS, ["M", "D", "M", "D", "F", "S", "S"]);
});

test("browsing months keeps the day when it exists and clamps it otherwise", () => {
  assert.equal(shiftPickerMonth("2026-11-18", 1), "2026-12-18");
  assert.equal(shiftPickerMonth("2026-11-18", -1), "2026-10-18");
  // Der 31. Januar minus ein Monat ist der 28. Februar, nicht der 3. Maerz.
  assert.equal(shiftPickerMonth("2026-01-31", 1), "2026-02-28");
  assert.equal(shiftPickerMonth("2026-03-31", -1), "2026-02-28");
  // Ueber das Jahresende.
  assert.equal(shiftPickerMonth("2026-12-15", 1), "2027-01-15");
  assert.equal(shiftPickerMonth("2026-01-15", -1), "2025-12-15");
  // Ein Schaltjahr gibt es nur alle vier Jahre.
  assert.equal(shiftPickerMonth("2026-01-31", 1), "2026-02-28");
  assert.equal(shiftPickerMonth("2027-01-31", 1), "2027-02-28");
});

// --- Die Tastatur ----------------------------------------------------------

test("the arrow keys follow the grid, not the calendar", () => {
  // 18.11.2026 ist ein Mittwoch.
  assert.equal(nextPickerDate("2026-11-18", "ArrowLeft"), "2026-11-17");
  assert.equal(nextPickerDate("2026-11-18", "ArrowRight"), "2026-11-19");
  // Eine Zeile im Raster sind sieben Tage, nicht einer.
  assert.equal(nextPickerDate("2026-11-18", "ArrowUp"), "2026-11-11");
  assert.equal(nextPickerDate("2026-11-18", "ArrowDown"), "2026-11-25");
  // Ueber den Monatsrand.
  assert.equal(nextPickerDate("2026-11-01", "ArrowLeft"), "2026-10-31");
  assert.equal(nextPickerDate("2026-11-30", "ArrowRight"), "2026-12-01");
});

test("Home and End go to Monday and Sunday of the week", () => {
  assert.equal(nextPickerDate("2026-11-18", "Home"), "2026-11-16");
  assert.equal(nextPickerDate("2026-11-18", "End"), "2026-11-22");
  // Ein Montag bleibt am Montag, ein Sonntag am Sonntag.
  assert.equal(nextPickerDate("2026-11-16", "Home"), "2026-11-16");
  assert.equal(nextPickerDate("2026-11-22", "End"), "2026-11-22");
});

test("PageUp and PageDown change the month and keep the day", () => {
  assert.equal(nextPickerDate("2026-11-18", "PageUp"), "2026-10-18");
  assert.equal(nextPickerDate("2026-11-18", "PageDown"), "2026-12-18");
  assert.equal(nextPickerDate("2026-03-31", "PageUp"), "2026-02-28");
});

test("an unknown key leaves the day alone", () => {
  assert.equal(nextPickerDate("2026-11-18", "Enter"), "2026-11-18");
  assert.equal(nextPickerDate("2026-11-18", "a"), "2026-11-18");
});

// --- Das Zifferblatt -------------------------------------------------------
// Alle Winkel sind in Grad, 0 ist oben, gezaehlt wird im Uhrzeigersinn. Die
// Geometrie wird an den vier Achsen geprueft — dort ist ein Vorzeichenfehler
// sichtbar, in der Mitte nicht.

test("the dial angle starts at the top and runs clockwise", () => {
  assert.equal(dialAngle(0), 0);
  assert.equal(dialAngle(3), 90);
  assert.equal(dialAngle(6), 180);
  assert.equal(dialAngle(9), 270);
  // Die zweite Stundenscheibe liegt auf derselben 12er-Teilung.
  assert.equal(dialAngle(12), 0);
  assert.equal(dialAngle(20), 240);
  assert.equal(dialAngle(23), 330);
});

test("the minute dial has twelve five-minute slots", () => {
  assert.equal(dialAngle(0, "minute"), 0);
  assert.equal(dialAngle(15, "minute"), 90);
  assert.equal(dialAngle(30, "minute"), 180);
  assert.equal(dialAngle(45, "minute"), 270);
  assert.equal(dialAngle(55, "minute"), 330);
});

test("the hour positions are two rings of twelve", () => {
  const positions = dialNumberPositions("hour");
  assert.equal(positions.length, 24);
  const byValue = new Map(positions.map((entry) => [entry.value, entry]));
  const top = byValue.get(0);
  assert.ok(top);
  assert.equal(Math.round(top.dx * 1000) / 1000, 0);
  assert.equal(Math.round(top.dy * 1000) / 1000, -Math.round(DIAL_RING_RATIO.outer * 1000) / 1000);
  // 12 sitzt genau unter 0, aber auf dem inneren Ring.
  const inner = byValue.get(12);
  assert.ok(inner);
  assert.equal(Math.round(inner.dx * 1000) / 1000, 0);
  assert.ok(Math.abs(inner.dy) < Math.abs(top.dy), "12 liegt naeher an der Mitte als 0");
  // 3 und 15 liegen beide rechts, 3 weiter aussen.
  const three = byValue.get(3);
  const fifteen = byValue.get(15);
  assert.ok(three && fifteen);
  assert.ok(three.dx > fifteen.dx);
  assert.ok(Math.abs(three.dy) < 1e-9, "3 liegt auf der Waagerechten");
});

test("the minute positions are twelve five-minute steps on the outer ring", () => {
  const positions = dialNumberPositions("minute");
  assert.deepEqual(positions.map((entry) => entry.value), [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  for (const entry of positions) {
    const radius = Math.hypot(entry.dx, entry.dy);
    assert.ok(Math.abs(radius - DIAL_RING_RATIO.outer) < 1e-9, `Radius von ${entry.value}`);
  }
});

test("the value under the pointer is the value on that axis", () => {
  // Oben, rechts, unten, links — auf dem aeusseren Ring.
  assert.equal(dialValueAt(0, -1, "hour"), 0);
  assert.equal(dialValueAt(1, 0, "hour"), 3);
  assert.equal(dialValueAt(0, 1, "hour"), 6);
  assert.equal(dialValueAt(-1, 0, "hour"), 9);
});

test("the radius decides the ring for hours", () => {
  // Derselbe Winkel, zwei Ringe: 0 und 12.
  assert.equal(dialValueAt(0, -DIAL_RING_SPLIT, "hour"), 0);
  assert.equal(dialValueAt(0, -DIAL_RING_SPLIT + 0.01, "hour"), 12);
  assert.equal(dialValueAt(0, -0.9, "hour"), 0);
  assert.equal(dialValueAt(0, -0.3, "hour"), 12);
  // Auch schraeg: 13 liegt zwischen 12 und 14 — 35 Grad sind der Sektor von
  // 13, 45 Grad waeren genau die Grenze zu 14.
  const radians = (35 * Math.PI) / 180;
  assert.equal(dialValueAt(Math.sin(radians) * 0.4, -Math.cos(radians) * 0.4, "hour"), 13);
});

test("minutes snap to five, with the boundary at two and a half", () => {
  const at = (degrees) => {
    const radians = (degrees * Math.PI) / 180;
    return dialValueAt(Math.sin(radians), -Math.cos(radians), "minute");
  };
  assert.equal(at(0), 0);
  assert.equal(at(14), 0, "2,33 Minuten runden auf 0");
  assert.equal(at(15), 5, "genau 2,5 Minuten runden auf 5");
  assert.equal(at(16), 5);
  assert.equal(at(44), 5);
  assert.equal(at(46), 10);
  assert.equal(at(354), 0, "kurz vor zwölf bleibt bei 0");
  assert.equal(at(180), 30);
});

test("the dial ignores a pointer at the centre", () => {
  // Der Mittelpunkt hat keinen Winkel; `atan2(0, -0)` ist 0, der Wert also
  // 12 (innen) bzw. 0 (Minuten) — kein NaN, keine Ausnahme.
  assert.equal(dialValueAt(0, 0, "hour"), 12);
  assert.equal(dialValueAt(0, 0, "minute"), 0);
});

// --- Die Masse aus der Vorlage ---------------------------------------------

test("the measured ratios keep the dial inside the dialog", () => {
  // Zifferblatt 600 px auf 712 px Dialogbreite: 84 % — es passt mit Rand.
  assert.ok(PICKER_RATIO.dial < 1);
  assert.ok(PICKER_RATIO.dial > 0.8);
  // Zwei Zeitfelder plus Luecke bleiben schmaler als der Dialog.
  assert.ok(PICKER_RATIO.fieldWidth * 2 < 1);
  // Der gewaehlte Kreis ist kleiner als der Abstand der Ringe zueinander.
  const ringGap = DIAL_RING_RATIO.outer - DIAL_RING_RATIO.inner;
  assert.ok(PICKER_RATIO.bubble / 2 < ringGap);
  // Auf 360 px ist die Tagesziffer mindestens 10 px gross.
  assert.ok(PICKER_WIDTH * PICKER_RATIO.day >= 10);
});
