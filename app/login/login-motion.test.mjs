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

test("Die Ruhe ist kuerzer als die Fahrt, und es sind mehr als ein Durchlauf", () => {
  // Das ist die Regression, die gemeldet wurde. Vorher standen 2.4 s Fahrt
  // 4.8 s Ruhe gegenueber, ein Lauf, und auf Produktion waren 46 von 57
  // Frames im Pixelvergleich exakt der geparkte Zustand — von 7.2 s waren 4.8 s
  // nichts zu sehen, danach nichts mehr. Der Benutzer hat das als "kaputt"
  // gelesen, und das war auch die richtige Lesart.
  //
  // Der Test liest die Zahlen aus der CSS und rechnet selbst, statt einen
  // festen Wert zu vergleichen: sonst koennte man `7.2s` wieder eintragen und
  // die Assertion trotzdem passieren lassen, indem man nur die Prozentzahl
  // anfasst.
  const rule = ruleBody(".scanline::after");
  const [, seconds, count] =
    /animation:\s*login-scanline\s+([\d.]+)s[^;]*?\s(\d+)\s+both/.exec(rule) ?? [];
  assert.ok(seconds, "`animation: login-scanline <dauer>s ... <zaehler> both` fehlt");
  assert.ok(count, "die Laufzahl steht nicht in der Kurzform");

  // Der Keyframe, an dem die Fahrt endet, ist der, der `translateY(0)` setzt.
  const body = keyframeBody("login-scanline");
  const stop = /(\d+(?:\.\d+)?)%\s*\{\s*transform:\s*translateY\(0\)/.exec(body);
  assert.ok(stop, "es gibt keinen Keyframe, der die Fahrt bei translateY(0) beendet");

  const travel = Number(stop[1]);
  const rest = 100 - travel;
  assert.ok(
    travel > rest,
    `die Fahrt (${travel} %) muss laenger sein als die Ruhe (${rest} %)` +
      " — sonst ist die Karte laenger unsichtbar als sichtbar",
  );
  assert.ok(
    travel >= 60,
    `${travel} % Fahrt sind zu wenig; unter 60 % liest die Karte als abgeschaltet`,
  );

  // Und sie muss mehr als einmal laufen, sonst gibt es nach dem ersten
  // Durchlauf nur noch den geparkten Zustand.
  assert.ok(
    Number(count) >= 2,
    `ein einziger Durchlauf (${count}) endet in einem fuer immer stillen Zustand`,
  );
  // Nie endlos: die Karte soll am Ende stillstehen.
  assert.notEqual(count, "infinite");
});

test("Die Fahrt deckt die ganze Kartenhoehe, nicht einen Bruchteil davon", () => {
  // Das ist der Fehler, den der Benutzer als "bricht in der Mitte ab und
  // wiederholt sich bis zur Mitte" beschrieben hat, und kein Test deckte ihn
  // ab: die anderen pruefen Timing und Deckkraft, aber keine einzige
  // Pruefung sah nach der STRECKE.
  //
  // `translateY(100 %)` rechnet immer gegen die EIGENE Hoehe des
  // Pseudo-Elements. Die Strecke in Kartenhoehen ist darum
  //
  //     (Weg der Keyframes in % der eigenen Hoehe / 100)
  //   * (eigene Hoehe / Kartenhoehe)
  //
  // Mit `height: 34 %` und einem Weg von -100 % auf 0 % sind das 0.34
  // Kartenhoehen: gemessen 138.7 px bei einer 410.06 px hohen Karte. Der
  // Streifen verliess die Karte oben und kam oben wieder, ohne sie je zu
  // durchfahren zu haben. Der Test liest beide Faktoren aus der CSS und
  // rechnet selbst, statt eine Pixellzahl festzuschreiben.
  const after = ruleBody(".scanline::after");

  // Die eigene Hoehe als Anteil der Karte: entweder ausdruecklich als
  // Prozent, oder — wenn die Regel ueber `inset: 0` die volle Kartenhoehe
  // nimmt — als 1.
  const percentHeight = /(?:^|[;\s])height:\s*([\d.]+)%/.exec(after);
  const spansCard =
    /(?:^|[;\s])inset:\s*0\s*(?:;|$)/.test(after) ||
    /(?:^|[;\s])(?:bottom|block-size):\s*0\b/.test(after);
  const ownHeight = percentHeight
    ? Number(percentHeight[1]) / 100
    : spansCard
      ? 1
      : null;
  assert.ok(
    ownHeight !== null,
    "die Hoehe des Pseudo-Elements ist nicht ableitbar: weder `height: <n>%` noch eine Regel, die die volle Kartenhoehe nimmt",
  );

  const body = keyframeBody("login-scanline");
  // `translateY(0)` steht ohne Einheit im Keyframe und ist 0 % wie 0 px
  // gleichwertig — nur eine Längenangabe in px waere hier ein Fehler.
  const offsets = [...body.matchAll(/translateY\(\s*(-?[\d.]+)(%?)\s*\)/g)].map((m) => {
    assert.ok(
      m[2] === "%" || Number(m[1]) === 0,
      `translateY(${m[0]}) gibt die Strecke in px an; der Keyframe kann die Kartenhoehe nicht kennen`,
    );
    return Number(m[1]);
  });
  assert.ok(offsets.length >= 2, "die Keyframes fahren mit weniger als zwei Stopps");

  // Der Start muss den Streifen vollstaendig ueber die Oberkante bringen:
  // -100 % der eigenen Hoehe ist bei einem gleich hohen Element genau der
  // Punkt, an dem die Unterkante genau auf der Oberkante liegt.
  assert.equal(
    Math.min(...offsets),
    -100,
    `das Pseudo-Element muss mit translateY(-100 %) starten, damit es oben vollstaendig hinausfaehrt (gefunden: ${Math.min(...offsets)} %)`,
  );

  const travel = ((Math.max(...offsets) - Math.min(...offsets)) / 100) * ownHeight;
  assert.ok(
    travel >= 1,
    `die Fahrt legt ${travel.toFixed(2)} Kartenhoehen zurueck, sie muss mindestens 1 sein —` +
      " ein Streifen, der nur einen Bruchteil der Karte hoch ist, verschwindet oben und kommt oben wieder",
  );
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