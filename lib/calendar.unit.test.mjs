import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./calendar.ts");
}

/**
 * Die Eingabe-Filter der Kalender-Formulare.
 *
 * Sie stehen hier und nicht in `calendar.test.mjs`, weil sie dessen Thema
 * (Modell und Farbaufloesung) nicht teilen: es sind zwei `replace`-Aufrufe, die
 * den Tippstand eines Formulars auf die Zeichen begrenzen, die das Formular
 * spaeter parst. Ein Feld, das Buchstaben durchlaesst, erzeugt eine Eingabe, die
 * `parseCalendarTime` (derselbe Tipp-Stand, naechster Schritt) nur noch
 * ablehnen kann.
 */
test("sanitizeTimeInput keeps digits and the colon only", async () => {
  const { sanitizeTimeInput } = await loadSubject();

  assert.equal(sanitizeTimeInput("1a4:3 0"), "14:30");
  assert.equal(sanitizeTimeInput("09.15"), "0915", "der Punkt trennt kein Uhrzeit-Feld");
  assert.equal(sanitizeTimeInput("--:--"), ":", "zwei Striche weg, der Doppelpunkt bleibt");
  assert.equal(sanitizeTimeInput(""), "");
});

test("sanitizeDateInput keeps digits and the dot only", async () => {
  const { sanitizeDateInput } = await loadSubject();

  assert.equal(sanitizeDateInput("31.12.2026"), "31.12.2026");
  assert.equal(sanitizeDateInput("2026-12-31"), "20261231", "der Bindestrich fliegt raus");
  assert.equal(sanitizeDateInput("31/12/2026x"), "31122026");
  assert.equal(sanitizeDateInput(""), "");
});

test("the sanitizers keep a value that is already clean byte for byte", async () => {
  const { sanitizeDateInput, sanitizeTimeInput } = await loadSubject();

  // Ein Formular schreibt bei jedem Tastendruck zurueck. Ein Filter, der ein
  // sauberes Feld noch einmal veraendert, wuerde den Cursor verschieben.
  assert.equal(sanitizeTimeInput("23:59"), "23:59");
  assert.equal(sanitizeDateInput("01.02.2026"), "01.02.2026");
});
