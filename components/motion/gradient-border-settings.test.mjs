import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The rules of the gradient border, without React and without a DOM.
 *
 * The behaviour is what is asserted here — what a stored value turns into,
 * what a broken stored value falls back to, which variant runs — and never the
 * spelling of the code that does it.
 */

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const {
  DEFAULT_GRADIENT_BORDER_SETTINGS,
  GRADIENT_BORDER_LIMITS,
  GRADIENT_BORDER_PRESETS,
  GRADIENT_BORDER_STORAGE_KEY,
  detectGradientBorderCapabilities,
  gradientBorderCssVariables,
  gradientBorderGlowSpread,
  gradientBorderRingGeometry,
  gradientBorderSettingsEqual,
  isHexColor,
  matchGradientBorderPreset,
  parseGradientBorderSettings,
  readStoredGradientBorderSettings,
  resolveGradientBorderVariant,
  writeStoredGradientBorderSettings,
} = await jiti.import("./gradient-border-settings.ts");

/** A storage that behaves like the browser's, so the rules can be read back. */
function fakeStorage() {
  const entries = new Map();
  return {
    entries,
    getItem: (key) => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => { entries.set(key, String(value)); },
    removeItem: (key) => { entries.delete(key); },
    clear: () => { entries.clear(); },
  };
}

test("the defaults are the ones the panel shows", () => {
  assert.equal(DEFAULT_GRADIENT_BORDER_SETTINGS.enabled, false, "the effect is off until it is asked for");
  assert.equal(DEFAULT_GRADIENT_BORDER_SETTINGS.borderWidthPx, 6);
  assert.equal(DEFAULT_GRADIENT_BORDER_SETTINGS.spinDurationMs, 2400);
  assert.equal(DEFAULT_GRADIENT_BORDER_SETTINGS.glowEnabled, true);
  assert.equal(DEFAULT_GRADIENT_BORDER_SETTINGS.glowOpacity, 0.25);
  assert.equal(DEFAULT_GRADIENT_BORDER_SETTINGS.glowSpreadPx, 3);
  assert.equal(DEFAULT_GRADIENT_BORDER_SETTINGS.glowBlurPx, 4);
  assert.equal(DEFAULT_GRADIENT_BORDER_SETTINGS.variant, "angle");
  assert.deepEqual(DEFAULT_GRADIENT_BORDER_SETTINGS.colors, GRADIENT_BORDER_PRESETS.omphie);
});

test("the panel ranges are the ranges the rules clamp into", () => {
  assert.deepEqual(GRADIENT_BORDER_LIMITS.borderWidthPx, { min: 0, max: 8 });
  assert.deepEqual(GRADIENT_BORDER_LIMITS.spinDurationMs, { min: 600, max: 6000 });
  assert.deepEqual(GRADIENT_BORDER_LIMITS.glowOpacity, { min: 0, max: 1 });
  assert.deepEqual(GRADIENT_BORDER_LIMITS.glowSpreadPx, { min: 0, max: 24 });
  assert.deepEqual(GRADIENT_BORDER_LIMITS.glowBlurPx, { min: 0, max: 24 });
});

test("the ring ends at the border and never reaches into the padding", () => {
  // The containing block of the layer is the bar's padding box, and the
  // bar's border is one pixel, so the bar's padding box starts one pixel
  // inside the bar's border box. The band that is left over between the
  // layer's border box and its padding box is the ring.
  for (const width of [0, 1, 2, 4, 6, 8]) {
    const geometry = gradientBorderRingGeometry(width);
    assert.equal(Math.abs(geometry.outerEdgePx), width, `the ring reaches ${width} px beyond the bar`);
    assert.ok(geometry.outerEdgePx <= 0, `the ring lies outside the bar at width ${width}`);
    assert.equal(geometry.innerEdgePx, 1, `the ring ends at the border at width ${width}`);
    assert.equal(geometry.eatsPaddingPx, 0, `the ring eats no padding at width ${width}`);
    assert.equal(
      geometry.paddingPx,
      width + 1,
      `the band is as thick as the width plus the border at ${width}`,
    );
  }
});

test("the offsets of the ring are the ones the stylesheet reads", () => {
  for (const width of [0, 2, 6, 8]) {
    const geometry = gradientBorderRingGeometry(width);
    const variables = gradientBorderCssVariables({
      ...DEFAULT_GRADIENT_BORDER_SETTINGS,
      borderWidthPx: width,
    });
    assert.equal(variables["--omp-gradient-ring-inset"], `${geometry.insetPx}px`);
    assert.equal(variables["--omp-gradient-ring-padding"], `${geometry.paddingPx}px`);
  }
});

test("the halo reaches beyond the ring at every width", () => {
  for (const width of [0, 2, 6, 8]) {
    const geometry = gradientBorderRingGeometry(width);
    const spread = gradientBorderGlowSpread(width, 3);
    assert.ok(
      spread > -geometry.outerEdgePx,
      `the halo starts further out than the ring ends at width ${width}`,
    );
    assert.equal(spread, width + 1 + 3, `the spread is the width plus the border plus the base at ${width}`);
  }
});

test("a stored value is read back as it was written", () => {
  const stored = JSON.stringify({
    enabled: true,
    colors: ["#111111", "#222222", "#333333", "#444444"],
    borderWidthPx: 4,
    spinDurationMs: 1200,
    glowEnabled: false,
    glowOpacity: 0.25,
    glowSpreadPx: 3,
    glowBlurPx: 8,
    variant: "rotate",
  });
  const parsed = parseGradientBorderSettings(stored);
  assert.equal(parsed.enabled, true);
  assert.deepEqual(parsed.colors, ["#111111", "#222222", "#333333", "#444444"]);
  assert.equal(parsed.borderWidthPx, 4);
  assert.equal(parsed.spinDurationMs, 1200);
  assert.equal(parsed.glowEnabled, false);
  assert.equal(parsed.glowOpacity, 0.25);
  assert.equal(parsed.glowSpreadPx, 3);
  assert.equal(parsed.glowBlurPx, 8);
  assert.equal(parsed.variant, "rotate");
});

test("a broken stored value falls back to the default instead of breaking the page", () => {
  const fallback = DEFAULT_GRADIENT_BORDER_SETTINGS;
  for (const broken of ["", "not json", "[]", "42", "null", '"a string"']) {
    const parsed = parseGradientBorderSettings(broken);
    assert.equal(parsed.enabled, fallback.enabled, `enabled after ${JSON.stringify(broken)}`);
    assert.deepEqual(parsed.colors, fallback.colors, `colours after ${JSON.stringify(broken)}`);
    assert.equal(parsed.borderWidthPx, fallback.borderWidthPx, `width after ${JSON.stringify(broken)}`);
    assert.equal(parsed.spinDurationMs, fallback.spinDurationMs, `duration after ${JSON.stringify(broken)}`);
    assert.equal(parsed.variant, fallback.variant, `variant after ${JSON.stringify(broken)}`);
  }
});

test("a missing field falls back to the default for that field alone", () => {
  const parsed = parseGradientBorderSettings(JSON.stringify({ enabled: true }));
  assert.equal(parsed.enabled, true, "the field that was there is kept");
  assert.equal(parsed.borderWidthPx, DEFAULT_GRADIENT_BORDER_SETTINGS.borderWidthPx);
  assert.equal(parsed.spinDurationMs, DEFAULT_GRADIENT_BORDER_SETTINGS.spinDurationMs);
  assert.deepEqual(parsed.colors, DEFAULT_GRADIENT_BORDER_SETTINGS.colors);
});

test("a number outside the range is clamped into it", () => {
  const parsed = parseGradientBorderSettings(JSON.stringify({
    borderWidthPx: 99,
    spinDurationMs: 1,
    glowOpacity: 4,
    glowSpreadPx: -10,
    glowBlurPx: 1000,
  }));
  assert.equal(parsed.borderWidthPx, GRADIENT_BORDER_LIMITS.borderWidthPx.max);
  assert.equal(parsed.spinDurationMs, GRADIENT_BORDER_LIMITS.spinDurationMs.min);
  assert.equal(parsed.glowOpacity, GRADIENT_BORDER_LIMITS.glowOpacity.max);
  assert.equal(parsed.glowSpreadPx, GRADIENT_BORDER_LIMITS.glowSpreadPx.min);
  assert.equal(parsed.glowBlurPx, GRADIENT_BORDER_LIMITS.glowBlurPx.max);
});

test("a colour that is not a hex colour does not reach the gradient", () => {
  const parsed = parseGradientBorderSettings(JSON.stringify({
    colors: ["#ffb347", "green", "#00b4ff", "#a78bfa"],
  }));
  assert.deepEqual(parsed.colors, DEFAULT_GRADIENT_BORDER_SETTINGS.colors);

  const short = parseGradientBorderSettings(JSON.stringify({ colors: ["#fff", "#000", "#123", "#456"] }));
  assert.deepEqual(short.colors, DEFAULT_GRADIENT_BORDER_SETTINGS.colors);
});

test("an unknown variant falls back to the angle variant", () => {
  assert.equal(parseGradientBorderSettings(JSON.stringify({ variant: "spin" })).variant, "angle");
  assert.equal(parseGradientBorderSettings(JSON.stringify({ variant: "rotate" })).variant, "rotate");
});

test("the settings survive a round trip through the storage", () => {
  const storage = fakeStorage();
  const previousWindow = globalThis.window;
  globalThis.window = { localStorage: storage };
  try {
    const next = { ...DEFAULT_GRADIENT_BORDER_SETTINGS, enabled: true, borderWidthPx: 3, colors: [...GRADIENT_BORDER_PRESETS.cool] };
    writeStoredGradientBorderSettings(next);
    assert.ok(storage.entries.has(GRADIENT_BORDER_STORAGE_KEY), "the value is under the key of the surface preferences");
    const read = readStoredGradientBorderSettings();
    assert.equal(read.enabled, true);
    assert.equal(read.borderWidthPx, 3);
    assert.deepEqual(read.colors, GRADIENT_BORDER_PRESETS.cool);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("a storage that refuses to answer leaves the default standing", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    get localStorage() {
      throw new Error("storage is blocked");
    },
  };
  try {
    const read = readStoredGradientBorderSettings();
    assert.equal(read.enabled, DEFAULT_GRADIENT_BORDER_SETTINGS.enabled);
    assert.equal(read.borderWidthPx, DEFAULT_GRADIENT_BORDER_SETTINGS.borderWidthPx);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("the settings become the custom properties the stylesheet reads", () => {
  const variables = gradientBorderCssVariables({
    ...DEFAULT_GRADIENT_BORDER_SETTINGS,
    colors: ["#111111", "#222222", "#333333", "#444444"],
    borderWidthPx: 5,
    spinDurationMs: 1500,
    glowEnabled: true,
    glowOpacity: 0.3,
    glowSpreadPx: 5,
    glowBlurPx: 7,
  });
  assert.equal(variables["--omp-gradient-c1"], "#111111");
  assert.equal(variables["--omp-gradient-c2"], "#222222");
  assert.equal(variables["--omp-gradient-c3"], "#333333");
  assert.equal(variables["--omp-gradient-c4"], "#444444");
  assert.equal(variables["--omp-gradient-width"], "5px");
  assert.equal(variables["--omp-gradient-duration"], "1500ms");
  assert.equal(variables["--omp-gradient-glow-opacity"], "0.3");
  assert.equal(variables["--omp-gradient-glow-spread"], "11px", "the spread is the width plus the border plus the base");
  assert.equal(variables["--omp-gradient-glow-blur"], "7px");
});

test("a switched off glow paints no light at all", () => {
  const variables = gradientBorderCssVariables({ ...DEFAULT_GRADIENT_BORDER_SETTINGS, glowEnabled: false, glowOpacity: 0.4 });
  assert.equal(variables["--omp-gradient-glow-opacity"], "0");
});

test("a browser that cannot animate an angle turns the layer instead", () => {
  assert.equal(resolveGradientBorderVariant("angle", true), "angle");
  assert.equal(resolveGradientBorderVariant("rotate", true), "rotate");
  assert.equal(resolveGradientBorderVariant("angle", false), "rotate", "the layer is the only one left there");
  assert.equal(resolveGradientBorderVariant("rotate", false), "rotate");
});

test("the capability probe asks the browser what it can do", () => {
  const full = detectGradientBorderCapabilities({
    supports: () => true,
    registerProperty: () => {},
  });
  assert.equal(full.conicGradient, true);
  assert.equal(full.animatableAngle, true);

  const withoutProperty = detectGradientBorderCapabilities({ supports: () => true });
  assert.equal(withoutProperty.conicGradient, true);
  assert.equal(withoutProperty.animatableAngle, false, "without registerProperty the angle cannot be animated");

  const alreadyRegistered = detectGradientBorderCapabilities({
    supports: () => true,
    registerProperty: () => { throw new Error("already registered"); },
  });
  assert.equal(alreadyRegistered.animatableAngle, true, "a property that exists is a property the browser has");

  const nothing = detectGradientBorderCapabilities({});
  assert.equal(nothing.conicGradient, false);
  assert.equal(nothing.animatableAngle, false);
});

test("the preset the colours came from is recognised, and a custom set is not", () => {
  assert.equal(matchGradientBorderPreset(DEFAULT_GRADIENT_BORDER_SETTINGS), "omphie");
  assert.equal(matchGradientBorderPreset({ ...DEFAULT_GRADIENT_BORDER_SETTINGS, colors: [...GRADIENT_BORDER_PRESETS.mono] }), "mono");
  assert.equal(matchGradientBorderPreset({ ...DEFAULT_GRADIENT_BORDER_SETTINGS, colors: ["#010203", "#040506", "#070809", "#0a0b0c"] }), null);
});

test("the preset for a light surface is deep enough to read as a line", () => {
  // The contrast against white, measured with the same formula the eye
  // uses: the ring is a line, so it has to clear the surface it stands on.
  const luminance = (hex) => {
    const channel = (value) => {
      const srgb = value / 255;
      return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    };
    return (
      0.2126 * channel(Number.parseInt(hex.slice(1, 3), 16)) +
      0.7152 * channel(Number.parseInt(hex.slice(3, 5), 16)) +
      0.0722 * channel(Number.parseInt(hex.slice(5, 7), 16))
    );
  };
  const contrast = (a, b) => {
    const light = Math.max(luminance(a), luminance(b));
    const dark = Math.min(luminance(a), luminance(b));
    return (light + 0.05) / (dark + 0.05);
  };

  for (const color of GRADIENT_BORDER_PRESETS.omphieLight) {
    const onWhite = contrast(color, "#ffffff");
    const onDark = contrast(color, "#151820");
    assert.ok(onWhite >= 3, `${color} reaches ${onWhite.toFixed(2)}:1 against white`);
    assert.ok(onDark >= 3, `${color} reaches ${onDark.toFixed(2)}:1 against the dark surface`);
  }

  // The green of the dark preset does not clear the bar on white.
  assert.ok(
    contrast(GRADIENT_BORDER_PRESETS.omphie[1], "#ffffff") < 1.5,
    "the green of the dark preset is below 1.5:1 against white",
  );
});

test("the colour check accepts a hex colour and nothing else", () => {
  assert.equal(isHexColor("#ffb347"), true);
  assert.equal(isHexColor("#FFB347"), true);
  assert.equal(isHexColor("#ffb34"), false);
  assert.equal(isHexColor("ffb347"), false);
  assert.equal(isHexColor("red"), false);
  assert.equal(isHexColor(null), false);
});

test("two settings are the same when every field is the same", () => {
  assert.equal(
    gradientBorderSettingsEqual(DEFAULT_GRADIENT_BORDER_SETTINGS, { ...DEFAULT_GRADIENT_BORDER_SETTINGS, colors: [...DEFAULT_GRADIENT_BORDER_SETTINGS.colors] }),
    true,
  );
  assert.equal(gradientBorderSettingsEqual(DEFAULT_GRADIENT_BORDER_SETTINGS, { ...DEFAULT_GRADIENT_BORDER_SETTINGS, enabled: true }), false);
  assert.equal(
    gradientBorderSettingsEqual(DEFAULT_GRADIENT_BORDER_SETTINGS, { ...DEFAULT_GRADIENT_BORDER_SETTINGS, colors: ["#000000", "#000000", "#000000", "#000000"] }),
    false,
  );
});
