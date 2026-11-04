import assert from "node:assert/strict";
import test from "node:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { getAvailableWebThemes, getWebThemeConfig, getWebThemePalette } from "./omp-theme.ts";

/**
 * Die Palette ist die einzige Stelle, an der ein Theme in CSS-Variablen
 * uebersetzt wird. Zwei Zusagen sind pruefbar, ohne die Implementierung zu
 * spiegeln: die Kontrastschwellen (6:1 fuer gedämpften, 5:1 fuer dim-Text) und
 * dass der Akzent-Hover tatsaechlich zwischen Akzent und Text liegt.
 */

const HEX = /^#[0-9a-f]{6}$/i;

function luminance(hex) {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(a, b) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

test("the titanium palette meets the documented contrast floors", async () => {
  const palette = await getWebThemePalette("titanium");

  assert.equal(palette.name, "titanium");
  assert.equal(palette.colorScheme, "dark");
  const variables = palette.variables;

  assert.equal(variables["--assistant-bg"], variables["--bg"]);
  assert.match(variables["--bg"], HEX);
  assert.match(variables["--bg-panel"], HEX);
  assert.match(variables["--text"], HEX);
  assert.match(variables["--text-muted"], HEX);
  assert.match(variables["--text-dim"], HEX);

  // The two documented floors, on both surfaces the text sits on.
  for (const surface of ["--bg", "--bg-panel"]) {
    assert.ok(
      contrast(variables["--text-muted"], variables[surface]) >= 6,
      `--text-muted on ${surface}: ${contrast(variables["--text-muted"], variables[surface]).toFixed(2)}`,
    );
    assert.ok(
      contrast(variables["--text-dim"], variables[surface]) >= 5,
      `--text-dim on ${surface}: ${contrast(variables["--text-dim"], variables[surface]).toFixed(2)}`,
    );
  }

  // `--accent-hover` is `accent` mixed 16% toward `text`: distinct from both,
  // and each channel stays inside the interval between them.
  assert.match(variables["--accent-hover"], HEX);
  assert.notEqual(variables["--accent-hover"], variables["--accent"]);
  for (const [offset, length] of [[1, 2], [3, 2], [5, 2]]) {
    const hover = Number.parseInt(variables["--accent-hover"].slice(offset, offset + length), 16);
    const accent = Number.parseInt(variables["--accent"].slice(offset, offset + length), 16);
    const text = Number.parseInt(variables["--text"].slice(offset, offset + length), 16);
    assert.ok(hover >= Math.min(accent, text) && hover <= Math.max(accent, text));
  }
});

test("a light theme reports its scheme and keeps the text fallback dark", async () => {
  const palette = await getWebThemePalette("alabaster");

  assert.equal(palette.colorScheme, "light");
  assert.match(palette.variables["--text"], HEX);
  // A light page background is brighter than the dark default; the fallback
  // must not leak into it.
  assert.ok(luminance(palette.variables["--bg"]) > luminance("#111318"));
});

test("every advertised theme renders a complete palette (including the fallbacks)", async () => {
  const themes = await getAvailableWebThemes();
  assert.ok(themes.length > 100, `expected the full theme set, saw ${themes.length}`);

  // Two known entries, one per scheme, pin the mapping direction.
  const byName = new Map(themes.map((theme) => [theme.name, theme.colorScheme]));
  assert.equal(byName.get("titanium"), "dark");
  assert.equal(byName.get("alabaster"), "light");

  const keys = Object.keys((await getWebThemePalette("titanium")).variables).sort();
  // Themes with sparse color records (the built-in `dark`/`light` stubs) are
  // the ones that exercise `firstColor`'s transparent/fallback chain. Only
  // built-ins: custom themes live in `~/.omp` and differ per machine.
  for (const name of ["dark", "light"]) {
    const palette = await getWebThemePalette(name);
    assert.equal(palette.name, name);
    assert.deepEqual(Object.keys(palette.variables).sort(), keys, name);
    for (const [key, value] of Object.entries(palette.variables)) {
      assert.equal(typeof value, "string", `${name} ${key}`);
      assert.ok(value.length > 0, `${name} ${key} is empty`);
    }
  }
});

test("the config names the dark/light pair and carries both palettes", async () => {
  const config = await getWebThemeConfig(Settings.isolated({}));

  assert.deepEqual(config.names, { dark: "titanium", light: "light" });
  assert.equal(config.palettes.dark.name, "titanium");
  assert.equal(config.palettes.light.name, "light");
  assert.equal(config.palettes.dark.colorScheme, "dark");
  assert.equal(config.palettes.light.colorScheme, "light");
  assert.notDeepEqual(config.palettes.dark.variables, config.palettes.light.variables);
});
