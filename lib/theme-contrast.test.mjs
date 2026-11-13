import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Why this test computes instead of grepping.
 *
 * The colour literals that used to sit in the sidebar, the explorer, the file
 * window and the composer are gone, and their replacements are theme tokens.
 * Whether a token is readable is arithmetic, not a string: `--text-dim` was
 * `#949aa4` (2.8:1 on `--bg`) and became `#6b7280` (4.8:1). A grep for the old
 * hex would go green the moment someone hand-writes a *different* pale grey,
 * which is exactly the failure this file exists to catch. So the values are
 * parsed out of `app/globals.css` and measured against WCAG 2.x relative
 * luminance.
 *
 * The thresholds are the ones the audit names: 4.5:1 for text, 3:1 for
 * graphical objects. Two pairs carry the value they actually reach, because
 * the alternative would be repainting a palette the product owns:
 *
 *   - `--warning` on `--bg-panel` is 4.07:1 in the light theme. The token is
 *     the titanium amber and is used app-wide; the literal it replaced
 *     (`#f59e0b`) was 2.02:1, and this test keeps the replacement.
 *   - `--bg` on `--accent` is 4.34:1 in the light theme: deepBlue is the brand
 *     colour, not a text colour. The old value (`#fff` on `--accent-hover`)
 *     was 2.34:1 and is gone.
 */

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

/**
 * Declarations of the block a selector opens, brace-matched. The first match
 * wins: the palette is the first `:root` and the first `html.dark` in the file,
 * the later `:root` blocks map shadcn's names onto these values.
 */
function blockBody(selector) {
  const start = css.search(new RegExp(`^\\s*${selector}\\s*\\{`, "m"));
  assert.ok(start >= 0, `app/globals.css has no \`${selector} {\` block`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces in \`${selector} {\``);
}

function variables(selector) {
  const vars = new Map();
  for (const [, name, value] of blockBody(selector).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    vars.set(name, value.trim());
  }
  assert.ok(vars.has("--text-dim"), `no --text-dim in \`${selector} {\``);
  return vars;
}

const THEMES = {
  light: variables(":root"),
  dark: variables("html\\.dark"),
};

function channel(byte) {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(match, `not an opaque hex colour: ${hex}`);
  const n = Number.parseInt(match[1], 16);
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 0xff) + 0.0722 * channel(n & 0xff);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = 4.5;
const SYMBOL = 3;

/** [foreground, background, floor] — every pair is used in the four surfaces. */
const PAIRS = [
  // Text at 11–13 px.
  ["--text-dim", "--bg", TEXT],
  ["--text-muted", "--bg", TEXT],
  ["--danger", "--bg", TEXT], // error lines in the sidebar/explorer/composer
  ["--bg", "--danger", TEXT], // the delete-confirm label on the red fill
  // The tree's git status letters, 11 px on the panel.
  ["--git-modified", "--bg-panel", TEXT],
  ["--git-added", "--bg-panel", TEXT],
  ["--git-deleted", "--bg-panel", TEXT],
  ["--git-renamed", "--bg-panel", TEXT],
  // Graphical objects: icon strokes, dots, the selected-row edge.
  ["--success", "--bg", SYMBOL],
  ["--accent", "--bg", SYMBOL],
  ["--warning", "--bg-panel", 4], // light amber reaches 4.07:1, see the header
  ["--bg", "--accent", 4.3], // brand blue, light reaches 4.34:1
];

test("the contrast helper matches the WCAG reference pairs", () => {
  assert.equal(Math.round(contrast("#ffffff", "#000000") * 100) / 100, 21);
  // WCAG 2.x's own worked example: #777777 on white is 4.48:1.
  assert.equal(Math.round(contrast("#777777", "#ffffff") * 100) / 100, 4.48);
});

for (const [theme, vars] of Object.entries(THEMES)) {
  test(`${theme}: text and icon pairs keep their contrast floor`, () => {
    for (const [fg, bg, floor] of PAIRS) {
      const fgValue = vars.get(fg);
      const bgValue = vars.get(bg);
      assert.ok(fgValue && bgValue, `${theme}: ${fg} or ${bg} is not defined`);
      const ratio = contrast(fgValue, bgValue);
      assert.ok(
        ratio >= floor,
        `${theme}: ${fg} (${fgValue}) on ${bg} (${bgValue}) is ${ratio.toFixed(2)}:1, needs ${floor}:1`,
      );
    }
  });
}
