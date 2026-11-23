import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Das Dither-Muster: eine Definition, mehrere Flaechen.
 *
 * Die Nothing-Optik lebt von einer Textur, und die teuerste Art, sie zu
 * verlieren, ist eine zweite Kopie. Genau das war der Zustand vor diesem Test:
 * die Login-Seite trug ihre Punktflaeche als eigene Regel in ihrem Modul-CSS,
 * jede weitere Flaeche haette dieselben Zahlen danebengelegt, und nach der
 * ersten Aenderung haetten zwei Flaechen zwei Dichten gehabt.
 *
 * Geprueft wird deshalb nicht, wie es aussieht (das kann nur ein Browser),
 * sondern die eine Sache, die ein Unit-Test halten kann: das Muster steht
 * einmal in `globals.css`, und die Flaechen nennen die Klasse, statt das
 * Muster erneut zu schreiben. Dazu, dass nichts davon animiert — eine Textur,
 * die sich bewegt, kostet einen Frame pro Bild fuer ein Bild, das still sein
 * soll, und `prefers-reduced-motion` haette daran nichts zu schalten.
 */

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const globals = read("../app/globals.css");
const loginCss = read("../app/login/login.module.css");
const loginPage = read("../app/login/page.tsx");
const recoverCss = read("../app/recover/recover.module.css");
const chatWindow = read("../components/ChatWindow.tsx");
const dialog = read("../components/ui/dialog.tsx");

/** Der Rumpf einer Regel, per Klammerzaehlung. */
function ruleBody(css, selector) {
  const at = css.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `die Regel \`${selector}\` fehlt`);
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`die Regel \`${selector}\` ist nicht geschlossen`);
}

const count = (haystack, needle) => haystack.split(needle).length - 1;

test("das Punktmuster ist in globals.css einmal definiert", () => {
  // Ein `:root`-Block traegt beide Variablen; ein zweiter waere die Kopie, die
  // dieser Test verhindern soll.
  assert.equal(count(globals, "--dither-dot:"), 1, "--dither-dot muss genau einmal deklariert sein");
  assert.equal(count(globals, "--dither-tile:"), 1, "--dither-tile muss genau einmal deklariert sein");
  assert.equal(count(globals, "radial-gradient(circle at 1px 1px,"), 1,
    "das Punktmuster darf nur an einer Stelle als Verlauf stehen");
});

test("die Flaechen nennen die Klasse statt eines eigenen Verlaufs", () => {
  // Login und Recover: die Login-Flaeche hatte den Verlauf selbst; seit der
  // Klasse steht er dort nicht mehr.
  assert.doesNotMatch(loginCss, /radial-gradient/, "die Login-Flaeche schreibt ihr eigenes Muster");
  assert.doesNotMatch(recoverCss, /radial-gradient/, "die Recover-Flaeche schreibt ihr eigenes Muster");
  assert.match(loginPage, /dot-field/, "die Login-Seite traegt die Punktflaeche nicht");
  assert.match(read("../app/recover/page.tsx"), /dot-field/, "die Recover-Seite traegt die Punktflaeche nicht");
  // Leerer Chat: die Flaeche hinter Wortmarke und Composer.
  assert.match(chatWindow, /dot-field/, "der leere Chat traegt die Punktflaeche nicht");
  // Dialog-Hintergrund: dieselbe Textur wie die Seite, damit ein Fenster nicht
  // auf einer saubereren Flaeche steht als die App.
  assert.match(dialog, /dot-field/, "der Dialog-Hintergrund traegt die Punktflaeche nicht");
});

test("Projektkarte und Trennlinie lesen dasselbe Muster", () => {
  const corner = ruleBody(globals, ".omp-project-card::after");
  assert.match(corner, /var\(--dither-dot\)/, "die Karten-Ecke liest das Muster nicht");
  assert.match(corner, /pointer-events: none/, "die Ecke muss Klicks durchlassen");
  // Die Trennlinie im Markdown war ein Verlauf nach transparent; ein harter
  // Punktstrich ist die Nothing-Fassung derselben Linie.
  const hr = ruleBody(globals, ".markdown-body hr");
  assert.match(hr, /repeating-linear-gradient/, "die Markdown-Trennlinie ist kein Punktstrich");
  assert.match(hr, /border: none/, "die Trennlinie zeichnet zusaetzlich einen Rahmen");
  assert.doesNotMatch(hr, /linear-gradient\(90deg, transparent/,
    "die weiche Kante steht noch da");
});

test("die Zahlen in AGENTS.md stehen auch hier", () => {
  // AGENTS.md nennt 4 px Raster, 6 % Textfarbe und Doto ab 36 px. Eine Zahl in
  // einer Notiz ist eine Erinnerung; nur ein Test merkt, wenn sie nicht mehr
  // stimmt.
  assert.match(globals.match(/--dither-dot:[^;]+;/)[0], /6%/, "die Punktdichte ist nicht mehr 6 %");
  assert.match(globals.match(/--dither-tile:[^;]+;/)[0], /4px 4px/, "das Raster ist nicht mehr 4 px");
  assert.match(ruleBody(loginCss, ".title"), /font-size: 36px/, "der Login-Titel ist nicht mehr 36 px");
  assert.match(ruleBody(recoverCss, ".title"), /font-size: 36px/, "der Recover-Titel ist nicht mehr 36 px");
});

test("die Texturen stehen still", () => {
  for (const selector of [".dot-field", ".omp-project-card::after"]) {
    const body = ruleBody(globals, selector);
    assert.doesNotMatch(body, /\banimation\b|\btransition\b/,
      `\`${selector}\` animiert; die Textur ist statisch`);
  }
});
