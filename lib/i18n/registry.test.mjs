import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getLocalePlugin,
  getSupportedLocales,
  registerLocale,
  resolveBrowserLocale,
} = await jiti.import("./registry.ts");

test("uses the first supported browser language and falls back to English", () => {
  assert.equal(resolveBrowserLocale(["zh-CN", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["en-US", "zh-CN"]), "en");
  assert.equal(resolveBrowserLocale(["fr-FR", "zh-CN"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["fr-FR"]), "en");
  assert.equal(resolveBrowserLocale([]), "en");
  // Deutsch wird erkannt, bevor das Englisch-Fallback greift: eine deutsche
  // Browser-Sprache darf nicht auf Englisch zurueckfallen.
  assert.equal(resolveBrowserLocale(["de-DE", "en-US"]), "de");
  assert.equal(resolveBrowserLocale(["de"]), "de");
  assert.equal(resolveBrowserLocale(["de-AT", "en-US"]), "de");
});

test("returns only registered locales", () => {
  assert.deepEqual(getSupportedLocales(), ["en", "zh-CN", "de"]);
  assert.equal(getLocalePlugin("en").id, "en");
  assert.equal(getLocalePlugin("de").id, "de");
  assert.equal(getLocalePlugin("missing"), undefined);
});

test("allows a new locale plugin and rejects duplicate ids", () => {
  registerLocale({ id: "test", label: "Test", messages: { "common.ok": "OK" } });
  assert.equal(getLocalePlugin("test")?.label, "Test");
  assert.throws(() => registerLocale({ id: "test", label: "Again", messages: {} }));
});
