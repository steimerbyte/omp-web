import assert from "node:assert/strict";
import test from "node:test";

/**
 * Der gemeinsame Zeitplan-Editor.
 *
 * Der Vertrag, den die beiden Ansichten teilen, ist die *Rundreise*: was der
 * Editor aus einem gespeicherten Cron liest, muss er unveraendert
 * zurueckschreiben — sonst aendert ein Oeffnen-und-Speichern einen Zeitplan,
 * den niemand angefasst hat. Der zweite Teil ist die Abgrenzung: alles, was
 * der Editor nicht darstellen kann, liefert `null` statt einer geratenen
 * Uebersetzung.
 */

async function loadSubject() {
  return import("./schedule-editor.ts");
}

test("reads a simple expression into its three fields", async () => {
  const { toEditorValue } = await loadSubject();

  assert.deepEqual(toEditorValue("0 8 * * *"), { minute: "0", hour: "8", weekday: "*" });
  assert.deepEqual(toEditorValue(" 30\t18 * * 1-5 "), { minute: "30", hour: "18", weekday: "1-5" });
});

test("keeps both Sunday spellings and padded numbers exactly as written", async () => {
  const { toEditorValue, toCron } = await loadSubject();

  // `0` und `7` sind beide Sonntag; ein Editor, der `7` auf `0` normalisiert,
  // schreibt beim naechsten Speichern einen anderen Ausdruck als gelesen.
  assert.equal(toCron(toEditorValue("0 8 * * 7")), "0 8 * * 7");
  assert.equal(toCron(toEditorValue("0 8 * * 0")), "0 8 * * 0");
  assert.equal(toCron(toEditorValue("05 09 * * 1")), "05 09 * * 1");
});

test("refuses everything the three fields cannot express", async () => {
  const { toEditorValue } = await loadSubject();

  for (const cron of [
    "* * * * *",        // jede Minute: kein fester Wert
    "*/15 * * * *",     // Schritt
    "0 8 1 * *",        // Tag im Monat
    "0 8 * 3 *",        // Monat
    "0 8 * *",          // vier Felder
    "0 8 * * * 2026",   // sechs Felder
  ]) {
    assert.equal(toEditorValue(cron), null, `${cron} haette abgelehnt werden muessen`);
  }
});

test("names every weekday value, with 7 falling on Sunday like 0", async () => {
  const { weekdayLabelKey } = await loadSubject();

  assert.equal(weekdayLabelKey("*"), "scheduled.weekdayEveryDay");
  assert.equal(weekdayLabelKey("1-5"), "scheduled.weekdayWeekdays");
  assert.equal(weekdayLabelKey("0"), "scheduled.weekdaySun");
  assert.equal(weekdayLabelKey("7"), "scheduled.weekdaySun");
  assert.equal(weekdayLabelKey("1"), "scheduled.weekdayMon");
  assert.equal(weekdayLabelKey("6"), "scheduled.weekdaySat");
});

test("offers both Sunday spellings in the weekday field", async () => {
  const { WEEKDAY_VALUES } = await loadSubject();

  assert.deepEqual(WEEKDAY_VALUES, ["*", "1-5", "1", "2", "3", "4", "5", "6", "0", "7"]);
});

test("builds a cron from the three fields", async () => {
  const { toCron } = await loadSubject();

  assert.equal(toCron({ minute: "15", hour: "7", weekday: "1-5" }), "15 7 * * 1-5");
});
