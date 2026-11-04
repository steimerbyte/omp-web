import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./file-fuzzy.ts");
}

/**
 * Der Text, den ein bestaetigter @-Vorschlag in die Eingabe schreibt.
 *
 * Zwei Formen, zwei Absichten: eine Datei schliesst das Token (Leerzeichen
 * dahinter, Cursor am Ende), ein Verzeichnis laesst den Menuepunkt offen
 * (Schraegstrich, kein Leerzeichen), damit der naechste Vorschlag greifen kann.
 * Ein Pfad mit Leerzeichen muss in Anfuehrungszeichen, sonst endet das Token
 * mitten im Namen.
 */
test("a file closes the token with a trailing space", async () => {
  const { buildAtInsertText } = await loadSubject();

  const insertion = buildAtInsertText("src/app.ts", false);
  assert.equal(insertion.text, "@src/app.ts ");
  assert.equal(insertion.cursorOffset, insertion.text.length);
});

test("a directory keeps the token open for drill-down", async () => {
  const { buildAtInsertText } = await loadSubject();

  const insertion = buildAtInsertText("src", true);
  assert.equal(insertion.text, "@src/");
  assert.equal(insertion.cursorOffset, insertion.text.length);
});

test("a path with a space is quoted, and a quoted directory is inserted closed", async () => {
  const { buildAtInsertText } = await loadSubject();

  const file = buildAtInsertText("my dir/app.ts", false);
  assert.equal(file.text, '@"my dir/app.ts" ');
  assert.equal(file.cursorOffset, file.text.length);

  const directory = buildAtInsertText("my dir", true);
  assert.equal(directory.text, '@"my dir/"');
  // Der Cursor steht *vor* dem schliessenden Anfuehrungszeichen: weiter tippen
  // und manuell vervollstaendigen halten das Token so beide wohlgeformt.
  assert.equal(directory.cursorOffset, directory.text.length - 1);
});

test("forceQuotes quotes a path that would not need it", async () => {
  const { buildAtInsertText } = await loadSubject();

  assert.equal(buildAtInsertText("src/app.ts", false, true).text, '@"src/app.ts" ');
  assert.equal(buildAtInsertText("src", true, true).text, '@"src/"');
});
