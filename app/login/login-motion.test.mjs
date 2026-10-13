import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

/**
 * Die Scanline auf der Login-Karte gegen den Einblend von `Reveal`.
 *
 * `Reveal` schreibt seinen `y: -8` als Inline-`transform: translateY(…)` und
 * erneuert ihn in jedem Frame des 240-ms-Einblendens. Eine CSS-Animation auf
 * demselben Element schlaegt im Kaskadenkontext diesen Inline-Style. Die
 * Scanline sitzt deshalb auf `::after` und nicht auf der Karte — sie hat
 * keinen Inline-`transform`, mit dem sie kollidieren koennte.
 *
 * Die zweite, wichtigere Regel ist eine andere: die Karte darf ihre Groesse
 * nie aendern. Playwright vergleicht den bounding box ueber zwei animation
 * frames, bevor es klickt, also brachte jeder `infinite`-Loop auf der Karte
 * jeden Klick zum Timeout. In Chromium gemessen, 30 Frames, Breite ueber alle
 * Frames protokolliert: mit `scale` 30 verschiedene Boxen, mit der Scanline
 * eine.
 */

const css = await readFile(new URL("./login.module.css", import.meta.url), "utf8");
const page = await readFile(new URL("./page.tsx", import.meta.url), "utf8");

/**
 * Die Datei ohne Kommentare.
 *
 * Ohne das laufen Muster wie `[^}]*` ueber die geschlossenen Klammern eines
 * Kommentars hinweg und pruefen danach die falsche Regel. Genau das ist
 * passiert: drei Tests schlugen fehl, obwohl die CSS stimmte.
 */
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Der Rumpf einer CSS-Regel, ohne sie ueber Kommentargrenzen hinweg zu lesen. */
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cssNoComments.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.notEqual(match, null, `die Regel \`${selector}\` fehlt`);
  return match[1];
}

/** Die `@keyframes`-Regel, unabhengig von Leerzeichen und Kommentaren. */
function keyframeBody(name) {
  const start = css.indexOf(`@keyframes ${name}`);
  assert.notEqual(start, -1, `@keyframes ${name} fehlt`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`@keyframes ${name} ist nicht geschlossen`);
}

test("Die Scanline sitzt auf ::after und nicht auf der Karte", () => {
  const card = ruleBody(".scanline");
  const after = ruleBody(".scanline::after");
  // Auf der Karte selbst wuerde sie mit dem Inline-`transform` von `Reveal`
  // um dieselbe Achse konkurrieren.
  assert.doesNotMatch(
    card,
    /animation:/,
    "die Karte darf selbst keine Animation tragen, nur ihr Pseudo-Element",
  );
  assert.doesNotMatch(
    card,
    /\bscale\b/,
    "`scale` aendert den bounding box in jedem Frame und blockiert jeden Klick",
  );
  assert.match(after, /animation:\s*login-scanline\b/);
});

test("Die Karte clippt die Scanline und blendet sie aus dem Klick aus", () => {
  // Ohne Clipping waere die Fahrt ein sichtbarer Streifen auf der Seite,
  // und ohne `pointer-events: none` wuerde sie Klicks abfangen.
  assert.match(ruleBody(".scanline"), /overflow:\s*hidden/);
  assert.match(ruleBody(".scanline::after"), /pointer-events:\s*none/);
});

test("Die Scanline faehrt transform, weil sie keinen Inline-Style hat", () => {
  // Die alte Achsen-Regel galt fuer die Karte. Auf `::after` gibt es nichts
  // zu schonen, und `transform` ist hier auch die einzige Bewegung, die
  // den bounding box der Karte unberuehrt laesst.
  const body = keyframeBody("login-scanline");
  assert.match(body, /\btransform\s*:\s*translateY/);
});

test("Die Scanline endet, und `prefers-reduced-motion` schaltet sie ab", () => {
  // Der entscheidende Unterschied zum Atem-Loop: eine abgeschlossene Fahrt.
  // `infinite` waere genau der Zustand, der Playwright blockiert, und genau
  // der, den die Einstellung fuer Endlosbewegung abschaffen will.
  assert.match(ruleBody(".scanline::after"), /animation:\s*login-scanline\b/);
  assert.doesNotMatch(
    ruleBody(".scanline::after"),
    /\binfinite\b/,
    "eine Endlosschleife auf der Login-Karte blockiert jeden Playwright-Klick",
  );
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion"));
  assert.match(reduced, /\.scanline::after\s*\{\s*animation:\s*none/);
});

test("Die Karte traegt die Scanline und den Einblend zugleich", () => {
  // `Reveal` setzt den Inline-`transform`, `.scanline` die Positionierung und
  // das Clipping. Die Bewegung sitzt auf `::after`.
  assert.match(page, /<Reveal className=\{`\$\{styles\.card\} \$\{styles\.scanline\}`\}>/);
});

test("Der Kommentar nennt die Kollision und nicht das Gegenteil", () => {
  // Der alte Kommentar behauptete, `Reveal` fahre nur `opacity` und `filter`
  // und die beidenAnimationen griffen nicht in dieselbe Eigenschaft ein. Genau
  // diese Behauptung hat die kollidierende Achse eingefuegt; wer sie
  // wiederherstellt, baut den Fehler erneut ein.
  assert.doesNotMatch(
    css,
    /griffen nicht in dieselbe Eigenschaft ein/,
    "die alte, falsche Begruendung ist wieder da",
  );
  // Der Satz steht IM Kommentar, also duerfen die Kommentare nicht weg — nur
  // die fuehrenden ` * ` pro Zeile. Ein Ersetzen der Bloecke wuerde genau den
  // Satz entfernen, den dieser Test sucht.
  const undecorated = css.replace(/^[ \t]*\*[ \t]?/gm, "");
  // Der Satz kann "Inline-Style" oder "Inline-`transform`" sagen, je nachdem
  // an welcher Stelle der Kommentar stand. Beides meint dasselbe: die
  // Animation schlaegt den Inline-Style von `Reveal`.
  assert.match(undecorated, /schlaegt\s+im Kaskadenkontext\s+den\s+Inline-(Style|`transform)/);
});