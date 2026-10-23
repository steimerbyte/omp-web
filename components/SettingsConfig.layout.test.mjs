import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Why a CSS-text test is admissible here, and what it is allowed to say.
 *
 * The defect is a layout defect, and jsdom computes no geometry — it cannot
 * reproduce a row that outgrew its box, so no mount-and-measure test exists for
 * it. What CAN be asserted in jsdom is the declaration that causes it. The repo
 * already reads stylesheets as text and asserts rules with `assert.match` in
 * five places (`SearchableSelect.placement.test.mjs`, `MobilePwaLayout.test.mjs`,
 * `SubagentPanel.test.mjs`, `motion/motion.test.mjs`, `login/login-motion.test.mjs`),
 * so this file follows that convention rather than inventing one.
 *
 * The line between an admissible test and a weak one is this: assert the
 * property the defect turns on, not a string. `.window` is `display: grid`
 * whose only row was left implicit, so the row sized itself to its CONTENT
 * (`auto`) while the box was bounded by `height`, and `overflow: hidden` cut
 * the difference away — 141px on a 390x844 phone (28 buttons below the window's
 * bottom edge, `elementFromPoint` returning the backdrop), 53px at 1440x900.
 *
 * The defect is not the absence of one exact declaration. It is that the row
 * was free to outgrow the box. So `assertBoundedRow` accepts ANY track list
 * that is pinned to the container and rejects every form that reproduces the
 * bug — including the near miss `minmax(auto, 1fr)`, which is `auto` with a
 * friendly-looking wrapper and behaves exactly like the implicit row.
 *
 * Measured 2026-10-21 on a production build, Chromium 1237, Models section open:
 *   before  grid-template-rows 967px   against clientHeight 826px  (390x844)
 *          grid-template-rows 910.5px against clientHeight 858px  (1440x900)
 *   after   826px and 858px, 0 buttons below the bottom edge, the window itself
 *          no longer scrolls, `.nav` measures 730 against 871 and scrolls.
 */

const css = readFileSync(new URL("./SettingsConfig.module.css", import.meta.url), "utf8");
const globals = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

/** The declarations of a block that a selector opens, brace-matched. */
function blockBody(source, selector) {
  const start = source.indexOf(selector);
  assert.notEqual(start, -1, `${selector} nicht gefunden`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  assert.fail(`${selector} ist nicht geschlossen`);
}

/** A hex colour of a custom property inside a block, as [r, g, b]. */
function colourOf(block, property) {
  const m = block.match(new RegExp(`${property}\\s*:\\s*#([0-9a-f]{6})\\s*;`, "i"));
  assert.ok(m, `${property} nicht gefunden`);
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The channel value of a linear sRGB colour, per WCAG 2.1. */
function channel(value) {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** The relative luminance of a colour, per WCAG 2.1. */
function luminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The contrast ratio of two opaque colours, per WCAG 2.1. */
function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** The colour a text of `colour` at `alpha` leaves on a background. */
function composited(colour, background, alpha) {
  return colour.map((c, i) => c * alpha + background[i] * (1 - alpha));
}

/**
 * The body of one rule with comments removed, so a comment block can never
 * satisfy an assertion — the comment above documents the very defect under test
 * and mentions `grid-template-rows` and `minmax(0, 1fr)` in the same breath.
 */
function ruleBody(source, selector) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = withoutComments.match(new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `${selector} nicht in SettingsConfig.module.css gefunden`);
  return m[1];
}

/** The declared value of one property inside a rule body, or undefined. */
function declaration(body, property) {
  const m = body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]+)`));
  return m ? m[1].trim() : undefined;
}

/**
 * A row track is BOUNDED when the container's height decides its size. It is
 * UNBOUNDED — the defect — when the content decides it.
 *
 * Rejected, each of these a way to ship the original bug again:
 *   absent      the row is implicit, and implicit means `auto`
 *   `auto`      sized by content
 *   `967px`     a fixed length: taller content overflows it just the same
 *   `min-content` / `max-content`
 *   `minmax(auto, 1fr)`   `auto` as the minimum — the wrapper does not help
 *   `minmax(180px, 1fr)`  a floor above zero still lets it outgrow a short box
 *
 * Accepted: a fraction track, with a floor of zero or none.
 */
function assertBoundedRow(rowValue, context) {
  assert.notEqual(rowValue, undefined,
    `${context}: grid-template-rows fehlt. Ohne die Angabe ist die Zeile ` +
    `implizit, und eine implizite Zeile ist \`auto\` — sie misst sich am ` +
    `Inhalt und wächst über die per height begrenzte Box hinaus.`);
  const value = rowValue.replace(/\s+/g, "");

  assert.ok(!/^(auto|none)$/.test(value),
    `${context}: grid-template-rows: ${rowValue} lässt die Zeile vom Inhalt ` +
    `abhängen statt von der Box — das ist genau der Defekt.`);
  assert.ok(!/^\d/.test(value) && !/px|em|rem|vh|vw|%/.test(value),
    `${context}: grid-template-rows: ${rowValue} ist eine feste oder relative ` +
    `Länge. Eine feste Zeile läuft bei genug Inhalt genauso über wie eine ` +
    `auto-Zeile.`);
  assert.ok(!/min-content|max-content/.test(value),
    `${context}: grid-template-rows: ${rowValue} hängt von einem Intrinsikwert ab.`);

  // A `minmax()` floor is the sharpest edge: minmax(auto, 1fr) and
  // minmax(180px, 1fr) both keep the track free to outgrow a short box.
  const minmax = value.match(/^minmax\(([^,]+),(.+)\)$/);
  if (minmax) {
    const floor = minmax[1];
    assert.ok(/^0(px|%)?$|^0$/.test(floor),
      `${context}: grid-template-rows: ${rowValue} setzt eine Untergrenze von ` +
      `"${floor}". Nur eine Untergrenze von 0 verhindert, dass die Zeile ihre ` +
      `Box überragt; minmax(auto, 1fr) reproduziert den Defekt.`);
  }
  assert.match(value, /\dfr|\bfr\b/,
    `${context}: grid-template-rows: ${rowValue} enthält keine ` +
    `fraktionelle Spur, die sich am Rest der Box ausrichtet.`);
}

test("the settings window binds its grid row to the window height", () => {
  const body = ruleBody(css, ".window");

  assert.match(body, /display:\s*grid/,
    ".window muss ein Grid-Container sein — ohne grid entfällt die Zeile ganz.");

  // The cause, and the only assertion that carries it.
  assertBoundedRow(declaration(body, "grid-template-rows"), ".window");

  // Two columns, the second taking the rest of the row and allowed to shrink.
  // Deliberately NOT the 238px: that width is design. If someone re-sizes the
  // sidebar, nothing here should fail.
  const columns = declaration(body, "grid-template-columns");
  assert.ok(columns, ".window braucht grid-template-columns.");
  const tracks = columns.split(/\s+(?![^(]*\))/);
  assert.equal(tracks.length, 2,
    `.window erwartet zwei Spalten, gefunden: ${tracks.length} (${columns})`);
  assert.match(tracks[1], /minmax\(\s*0\s*,\s*1fr\s*\)/,
    `die zweite Spalte muss minmax(0, 1fr) sein, damit sie unter ihre ` +
    `Inhaltsbreite schrumpfen kann; gefunden: ${tracks[1]}`);
});

test("the disabled nav labels are no dimmer than the panel's other disabled controls", () => {
  // The number the comment in the stylesheet names, pinned.
  assert.equal(
    declaration(ruleBody(css, ".navButton:disabled"), "opacity"),
    ".55",
    "die abgeschalteten Eintraege brauchen eine Deckkraft von .55 — bei .36 " +
    "sind genau ihre Beschriftungen das unlesbarste im Panel",
  );

  // The outcome, not a magic number: the contrast a disabled nav label reaches
  // against the panel background, compared with the contrast the faintest
  // other disabled control of the same panel reaches. The nav labels used to
  // be the dimmest thing in the panel — 0.36 where the switches and the reload
  // notice use 0.55 and the primary button 0.5 — and the composited colour
  // said so: 1.62:1 against 2.00:1 in the light theme, measured in Chromium
  // 152 on 2026-10-23. The floor comes from the panel's own rules, so it
  // moves with them instead of being a number I invented.
  const navOpacity = Number.parseFloat(
    declaration(ruleBody(css, ".navButton:disabled"), "opacity"),
  );
  const others = [...css.matchAll(/([^{}\s]+:disabled)\s*\{([^}]*)\}/g)]
    .filter(([, selector]) => selector !== ".navButton:disabled")
    .map(([, , body]) => Number.parseFloat(declaration(body, "opacity")))
    .filter((value) => Number.isFinite(value));
  assert.ok(others.length > 0,
    "das Panel braucht mindestens eine weitere deaktivierte Regel als Vergleich");
  const floor = Math.min(...others);

  for (const [name, block] of [
    ["hell", blockBody(globals, ":root {")],
    ["dunkel", blockBody(globals, "html.dark {")],
  ]) {
    const text = colourOf(block, "--text-muted");
    const background = colourOf(block, "--bg-panel");
    const reached = contrast(composited(text, background, navOpacity), background);
    const floorReached = contrast(composited(text, background, floor), background);
    assert.ok(
      reached >= floorReached,
      `im Thema ${name} erreicht die deaktivierte Beschriftung ${reached.toFixed(2)}:1, ` +
      `die blasseste andere deaktivierte Kontrolle des Panels aber ` +
      `${floorReached.toFixed(2)}:1 — die Beschriftungen der Navigation dürfen ` +
      `nicht das blasseste im Panel sein`,
    );
  }
});

test("the nav labels are drawn in a weight that reaches their own colour", () => {
  // Measured in Chromium 152 on 2026-10-23 on the rendered label "Themes" in
  // the running panel: the darkest pixel of the label against the panel
  // background, next to the colour the label asks for (--text-muted,
  // rgb(108,108,108)).
  //
  //   12 px / 500   rgb(141,141,141)   the label never reaches its own colour
  //   12 px / 600   rgb(108,108,108)   exactly --text-muted
  //
  // The stem of a monospace glyph is thinner than a pixel at weight 500: the
  // browser spreads it over two pixels and blends it into a lighter grey,
  // which is the hairline that made "Themes" read as "Themed". At weight 600
  // the stem is a full pixel wide, and the label is drawn in exactly the
  // colour it asks for.
  //
  // This is the repair of a defect: the element was drawn in a lighter
  // colour than its own colour declaration, and it was never cut off.
  const body = ruleBody(css, ".navButton");
  assert.equal(
    declaration(body, "font"),
    "600 12px/1 var(--font-mono)",
    "die Navigationsbeschriftung braucht Gewicht 600 — bei 500 wird sie in " +
    "einer helleren Farbe gezeichnet als der eigenen Farbangabe, und das " +
    "letzte Zeichen der Monospace-Schrift faellt zwischen den Haarlinien " +
    "zusammen, sodass das Wort wie ein anderes liest",
  );
});

test("the narrow-viewport override cannot widen the row again", () => {
  // The 760px block re-declares .window (width, height, columns, radius). It
  // does not set grid-template-rows at all today, so the bounded row from the
  // base rule carries over. The invariant is NOT "it must stay silent" — if a
  // future author repeats the rule explicitly and correctly, that is fine. The
  // invariant is: if it sets the row, the row it sets must be bounded.
  const start = css.indexOf("@media (max-width: 760px)");
  assert.notEqual(start, -1, "@media (max-width: 760px) fehlt");
  const block = css.slice(start);

  let mobileWindow = null;
  for (const m of block.matchAll(/(?:^|[},])\s*\.window\s*\{([^}]*)\}/g)) {
    mobileWindow = m[1];  // last wins, as in CSS
  }
  assert.ok(mobileWindow, ".window wird im Mobile-Block nicht ueberschrieben");

  const row = declaration(mobileWindow, "grid-template-rows");
  if (row === undefined) {
    // Nothing set: the base rule's bounded row still applies. That is the
    // state we ship in, and it is correct.
    return;
  }
  assertBoundedRow(row, ".window @media (max-width: 760px)");
});