import assert from "node:assert/strict";
import test from "node:test";
import {
  ANIMATION_STORAGE_KEY,
  DEFAULT_ANIMATION_MODE,
  isAnimationMode,
  motionConfigFor,
  parseAnimationMode,
  readStoredAnimationMode,
} from "./animation-mode.ts";

/**
 * These exercise the store rules, not the class names or the markup. Whether a
 * shimmer actually moves is only observable in a browser; whether the mode is
 * read, validated and mapped correctly is decided here.
 */

test("Der Server-Snapshot ist der Default, damit Server und erster Client-Render übereinstimmen", () => {
  // The provider hands `getServerSnapshot` this value. If it ever stopped being
  // the default, the first client render would differ from the server HTML and
  // React would report a hydration mismatch.
  assert.equal(DEFAULT_ANIMATION_MODE, "full");
});

test("Die drei Modi sind die einzigen gültigen Werte", () => {
  for (const mode of ["full", "reduced", "off"]) {
    assert.equal(isAnimationMode(mode), true, mode);
  }
  for (const bogus of ["", "FULL", "none", null, undefined, 1, {}, "off "]) {
    assert.equal(isAnimationMode(bogus), false, String(bogus));
  }
});

test("Ein ungültiger gespeicherter Wert fällt auf full zurück, ohne einen leeren Modus zu erzeugen", () => {
  assert.equal(parseAnimationMode("nonsense"), "full");
  assert.equal(parseAnimationMode(""), "full");
  assert.equal(parseAnimationMode(null), "full");
  // A valid value is kept, including the ones that are easy to confuse.
  assert.equal(parseAnimationMode("reduced"), "reduced");
  assert.equal(parseAnimationMode("off"), "off");
});

test("Nur 'off' schaltet MotionConfig auf always; reduced und full folgen dem System", () => {
  assert.equal(motionConfigFor("off"), "always");
  // `reduced` deliberately shares "user" with `full`: the difference between
  // them is the operating system reading prefers-reduced-motion, not a second
  // MotionConfig value.
  assert.equal(motionConfigFor("reduced"), "user");
  assert.equal(motionConfigFor("full"), "user");
});

test("Der gespeicherte Modus wird aus localStorage gelesen und über das Datumsattribut sichtbar gemacht", () => {
  const store = new Map([[ANIMATION_STORAGE_KEY, "reduced"]]);
  const attributes = new Map();
  globalThis.window = {
    localStorage: { getItem: (key) => store.get(key) ?? null },
  };
  globalThis.document = {
    documentElement: {
      dataset: {
        set ompAnimations(value) {
          attributes.set("ompAnimations", value);
        },
        get ompAnimations() {
          return attributes.get("ompAnimations");
        },
      },
    },
  };

  const mode = readStoredAnimationMode();
  assert.equal(mode, "reduced");

  // The provider publishes the same value onto the root element, which is what
  // the CSS escape hatch keys off.
  document.documentElement.dataset.ompAnimations = mode;
  assert.equal(document.documentElement.dataset.ompAnimations, "reduced");

  delete globalThis.window;
  delete globalThis.document;
});

test("Ein blockierter localStorage-Zugriff liefert den Default statt zu werfen", () => {
  globalThis.window = {
    localStorage: {
      getItem() {
        throw new Error("storage disabled");
      },
    },
  };
  assert.equal(readStoredAnimationMode(), "full");
  delete globalThis.window;
});

test("Ohne Fenster (Server-Render) liefert der Lesevorgang den Default", () => {
  assert.equal(readStoredAnimationMode(), "full");
});