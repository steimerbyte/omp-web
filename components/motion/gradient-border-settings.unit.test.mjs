import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `isGradientBorderPresetId` ist das Tor, durch das ein gespeicherter oder
 * importierter Wert muss, bevor er als Preset-Name gilt. Der Test prueft die
 * Grenze, nicht die Liste: jeder echte Name ja, alles andere nein.
 */

const ROOT = process.cwd();
const jiti = createJiti(`${ROOT}/package.json`, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { isGradientBorderPresetId, GRADIENT_BORDER_PRESETS, GRADIENT_BORDER_PRESET_IDS } =
  await jiti.import(`${ROOT}/components/motion/gradient-border-settings.ts`);

test("jeder vorhandene Preset-Name wird erkannt", () => {
  assert.ok(GRADIENT_BORDER_PRESET_IDS.length > 0);
  for (const id of GRADIENT_BORDER_PRESET_IDS) {
    assert.equal(isGradientBorderPresetId(id), true, `${id} wurde nicht erkannt`);
    assert.ok(GRADIENT_BORDER_PRESETS[id], `fuer ${id} gibt es keine Farben`);
  }
});

test("alles, was kein Preset-Name ist, wird abgelehnt", () => {
  assert.equal(isGradientBorderPresetId("omphie"), true);
  assert.equal(isGradientBorderPresetId("Omphie"), false);
  assert.equal(isGradientBorderPresetId("omphie "), false);
  assert.equal(isGradientBorderPresetId(""), false);
  assert.equal(isGradientBorderPresetId(undefined), false);
  assert.equal(isGradientBorderPresetId(null), false);
  assert.equal(isGradientBorderPresetId(42), false);
  assert.equal(isGradientBorderPresetId({ id: "omphie" }), false);
  assert.equal(isGradientBorderPresetId(["omphie"]), false);
});
