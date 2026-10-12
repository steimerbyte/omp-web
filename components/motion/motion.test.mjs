import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
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

/*
 * The two failures below were only visible in a browser. The first one was a
 * `background` shorthand inside `Skeleton` overwriting the `backgroundImage`
 * the shimmer installs, which deleted the gradient outright — the loading
 * state rendered as a flat block and looked like no animation at all. The
 * second is that `MotionConfig` never reaches gesture animations.
 */

test("Skeleton setzt die Flaeche über backgroundColor, nicht über den background-Shorthand", () => {
  const source = readFileSync(new URL("./Skeleton.tsx", import.meta.url), "utf8");
  // The shorthand resets background-image, which is exactly the wash.
  assert.doesNotMatch(source, /background:\s*"var\(--/);
  assert.match(source, /backgroundColor:\s*"var\(--bg-hover\)"/);
});

test("Pressable und Spin prüfen den Modus selbst, weil reducedMotion Gesten nicht erfasst", () => {
  // motion evaluates shouldReduceMotion only when resolving an `animate`
  // target and for layout animations; a gesture runs straight through
  // animateSingleValue and never sees it. Measured: with the setting on "Off"
  // a whileTap still scaled the button.
  for (const file of ["Pressable.tsx", "Enter.tsx"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.match(source, /useAnimationPreference\(\)/, file);
    assert.match(source, /mode === "off"/, file);
  }
});

test("Jede aufpoppende Flaeche spielt den Wash, nicht nur die Ladeflaechen", () => {
  // A panel that only rises and un-blurs says "it appeared"; the sweep says
  // "it arrived". Both halves are required.
  for (const file of ["Reveal.tsx", "Enter.tsx"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.match(source, /useSweepProps\(\)/, file);
    assert.match(source, /\.\.\.sweep\.motion/, file);
    assert.match(source, /\.\.\.sweep\.style/, file);
  }
  // Enter carries it for the popovers and ModalPanel for the dialogs.
  const enter = readFileSync(new URL("./Enter.tsx", import.meta.url), "utf8");
  assert.equal((enter.match(/useSweepProps\(\)/g) ?? []).length, 2);
});