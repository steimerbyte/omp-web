import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

/**
 * Der Atem-Loop auf der Login-Karte gegen den Einblend von `Reveal`.
 *
 * `Reveal` schreibt seinen `y: -8` als Inline-`transform: translateY(…)` und
 * erneuert ihn in jedem Frame des 240-ms-Einblendens. Eine CSS-Animation
 * schlaegt im Kaskadenkontext den Inline-Style — der Loop stand deshalb
 * waehrend des gesamten Einblendens auf der falschen Achse, und die Karte
 * stieg nicht mehr hoch.
 *
 * In Chromium gemessen, jeweils `transform: translateY(…)` als Inline-Style und
 * alle 40 ms:
 *
 *   mit `transform: scale()`   computed matrix(1.00045, 0, 0, 1.00045, 0, 0)
 *   mit `scale: 1.012`         computed matrix(1, 0, 0, 1, 0, -0.84)
 *
 * Bei der alten Fassung ist die fuenfte Komponente (`translateY`) in jedem
 * Sample `0`; in der neuen laeuft sie von -8 auf 0. Geprueft wird hier die
 * Eigenschaft, die den Konflikt ausloest — die Laufzeit ist Sache des
 * Browsers, und ein Test kann sie nicht behaupten, nur belegen.
 */

const css = await readFile(new URL("./login.module.css", import.meta.url), "utf8");
const page = await readFile(new URL("./page.tsx", import.meta.url), "utf8");

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

test("Der Atem-Loop faehrt scale und nicht transform", () => {
  const body = keyframeBody("login-idle-breathe");
  assert.doesNotMatch(
    body,
    /\btransform\s*:/,
    "die Keyframes schreiben wieder `transform` und wuerden den Inline-Style von `Reveal` ueberschreiben",
  );
  assert.match(body, /\bscale\s*:/, "der Loop muss `scale` fahren, damit der Aufstieg sichtbar bleibt");
});

test("Der Loop laeuft weiter, schaltet `prefers-reduced-motion` aber ab", () => {
  // Der Atem-Loop darf nicht mit verschwinden: eine unbegrenzte Schleife ist
  // genau die Bewegung, die `prefers-reduced-motion` abschaffen soll — und
  // genau deshalb muss sie die Einstellung auch beachten.
  assert.match(css, /\.idleLoop\s*\{[^}]*animation:\s*login-idle-breathe\b[^}]*infinite/);
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion"));
  assert.match(reduced, /\.idleLoop\s*\{\s*animation:\s*none/);
});

test("Die Karte traegt den Loop und den Einblend zugleich", () => {
  // Das ist die Voraussetzung fuer den Konflikt: `Reveal` setzt den Inline-
  // `transform`, `.idleLoop` die Animation, beides auf demselben Element.
  assert.match(page, /<Reveal className=\{`\$\{styles\.card\} \$\{styles\.idleLoop\}`\}>/);
});

test("Der Kommentar nennt die Kollision und nicht das Gegenteil", () => {
  // Der alte Kommentar behauptete, `Reveal` fahre nur `opacity` und `filter`
  // und die beidenAnimationen griffen nicht in dieselbe Eigenschaft ein. Genau
  // diese Behauptung hat die kollidierende Achse eingefuegt; wer sie
  // wiederherstellt, baut den Fehler erneut ein.
  assert.doesNotMatch(
    css,
    /greifen nicht in dieselbe Eigenschaft ein/,
    "die alte, falsche Begruendung ist wieder da",
  );
  assert.match(css, /schlaegt im Kaskadenkontext den Inline-Style/);
});