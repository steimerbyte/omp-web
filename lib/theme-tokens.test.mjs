import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Warum dieser Test das Stylesheet liest und keine Komponenten.
 *
 * Geometrie hat keinen Kontrast-Test: ein Radius ist ueber seine Rolle richtig
 * oder falsch, nicht ueber eine Rechnung. Festhalten laesst sich aber, dass die
 * drei Tokens genau zweimal stehen — einmal je Theme-Block — und in beiden
 * denselben Wert tragen. Fehlt eine der beiden Deklarationen, faellt der Wert
 * still auf den Browser-Default (`border-radius: 0`) zurueck, und niemand
 * sieht es. Die Werte selbst sind der Vertrag: 6 px fuer Bedienelemente,
 * 10 px fuer Panels, 120 ms fuer Hover und Zustandswechsel.
 *
 * Die Ausnahmen, die die Tokens bewusst NICHT abdecken, bleiben Zahlen in den
 * Komponenten und werden hier nie gelesen — deshalb koennen sie nicht als
 * Fehlschlag auftauchen: 4 fuer die 24/28-px-Zeilen von Baum und Dateiliste,
 * 1 fuer Haarlinien, 0 fuer buendige Kanten, 14 und 999 fuer Composer-Leiste
 * und Pillen.
 */
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

/** Der erste Theme-Block endet dort, wo `html.dark` beginnt. */
const split = css.indexOf("html.dark {");
assert.ok(split > 0, "app/globals.css hat keinen `html.dark {`-Block");
const THEMES = { light: css.slice(0, split), dark: css.slice(split) };

const TOKENS = {
  "--radius-control": { unit: "px", value: 6 },
  "--radius-panel": { unit: "px", value: 10 },
  "--duration-hover": { unit: "ms", value: 120 },
};

function read(half, name) {
  const matches = [...half.matchAll(new RegExp(`${name}\\s*:\\s*([^;]+);`, "g"))];
  assert.equal(matches.length, 1, `${name} muss genau einmal im Block stehen, steht ${matches.length}x`);
  return matches[0][1].trim();
}

for (const [theme, half] of Object.entries(THEMES)) {
  test(`${theme}: die drei Geometrie-Tokens stehen im Theme-Block`, () => {
    for (const [name, { unit, value }] of Object.entries(TOKENS)) {
      assert.equal(read(half, name), `${value}${unit}`, `${theme}: ${name} hat einen anderen Wert`);
    }
  });
}

test("beide Theme-Bloecke tragen dieselbe Geometrie", () => {
  for (const name of Object.keys(TOKENS)) {
    assert.equal(read(THEMES.light, name), read(THEMES.dark, name), `${name} driftet zwischen den Themes`);
  }
  // Panel ist groesser als Control, sonst ist die Rollentrennung kaputt.
  assert.ok(
    Number.parseInt(read(THEMES.light, "--radius-panel"), 10) > Number.parseInt(read(THEMES.light, "--radius-control"), 10),
    "--radius-panel muss groesser als --radius-control sein",
  );
});
