import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./calendar-store.ts");
}

/**
 * `calendarEventColor` ist die Lesesicht auf das gespeicherte Feld: der Wert
 * kommt aus der Datei und wird fuer die Anzeige nicht aufgeloest (das macht
 * `resolveEventColor`), aber er wird in die eine gespeicherte Schreibweise
 * gebracht. Ein Termin mit einem kaputten Farbwert soll wie ein Termin ohne
 * Farbe aussehen, nicht wie ein Termin mit einem unbekannten Namen.
 */
test("calendarEventColor returns the stored preset name", async () => {
  const { calendarEventColor } = await loadSubject();

  assert.equal(calendarEventColor({ color: "accent" }), "accent");
});

test("calendarEventColor normalizes a hex code to the stored spelling", async () => {
  const { calendarEventColor } = await loadSubject();

  assert.equal(calendarEventColor({ color: " #FF00AA " }), "#ff00aa");
  assert.equal(calendarEventColor({ color: "#f0a" }), "#ff00aa");
});

test("calendarEventColor drops a value that is neither preset nor hex", async () => {
  const { calendarEventColor } = await loadSubject();

  assert.equal(calendarEventColor({ color: "chartreuse" }), undefined);
  assert.equal(calendarEventColor({ color: "#12345" }), undefined);
  assert.equal(calendarEventColor({}), undefined);
});
