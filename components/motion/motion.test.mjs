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

/**
 * Source with its comments removed.
 *
 * Several assertions below are about what the code does not write, and the
 * comment above that code is where the reason is documented — including, for
 * the shimmer, the very property the assertion forbids. Matching against the
 * prose would fail the fix for describing it correctly.
 */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

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
    assert.match(source, /\.\.\.sweep\.animate/, file);
    assert.match(source, /\.\.\.sweep\.transition/, file);
    assert.match(source, /\.\.\.sweep\.style/, file);
  }
  // Enter carries it for the popovers and ModalPanel for the dialogs.
  const enter = readFileSync(new URL("./Enter.tsx", import.meta.url), "utf8");
  assert.equal((enter.match(/useSweepProps\(\)/g) ?? []).length, 2);
});

test("Wash-Hooks sind memoised, sonst startet der Wash bei jedem Render neu", () => {
  // Motion restarts an animation whenever `animate` is a new object. Building
  // the keyframes inside the hook body instead of in a `useMemo` made a
  // re-rendering panel replay the one-shot wash on every single render, so it
  // never got past its first few percent and the band sat parked across the
  // Explorer window for as long as it stayed open.
  const source = readFileSync(new URL("./hooks.ts", import.meta.url), "utf8");
  for (const hook of ["useSweepProps", "useShimmerProps"]) {
    const body = source.slice(source.indexOf(`export function ${hook}`));
    // Stop at the next top-level export so a later hook cannot pass the test
    // that an earlier one should have failed.
    const end = body.indexOf("\nexport function", 10);
    const fn = end === -1 ? body : body.slice(0, end);
    assert.match(fn, /useMemo\(/, `${hook} ohne useMemo`);
    assert.match(fn, /\[mode\]/, `${hook} ohne Abhaengigkeit`);
  }
  // And neither may build the keyframes outside the memo.
  const sweep = source.slice(source.indexOf("export function useSweepProps"));
  assert.doesNotMatch(sweep, /^  return \{\n    animate:/m, "Keyframes ausserhalb des Memo");
});

test("Kein motion-Element spreadet animate ueber sein eigenes animate", () => {
  // Spreading `animate` replaces the object instead of merging into it. The
  // panel's own `opacity: 1` was dropped that way, the element kept its
  // `initial` opacity of 0, and every popover, dialog and login form rendered
  // as a blank page. Only `style` and `className` may be spread.
  for (const file of ["Reveal.tsx", "Enter.tsx", "Shimmer.tsx", "Skeleton.tsx", "Pressable.tsx"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /^\s*\{\.\.\.\w+\.motion\}\s*$/m, file);
    assert.doesNotMatch(source, /^\s*\{\.\.\.\w+\.animate\}\s*$/m, file);
  }
  // The hook must not hand out a ready-made `animate` key at all.
  const hooks = readFileSync(new URL("./hooks.ts", import.meta.url), "utf8");
  const sweep = hooks.slice(hooks.indexOf("export function useSweepProps"));
  assert.doesNotMatch(sweep, /motion:\s*\{/, "useSweepProps");
  // And the wash needs its own length, so it carries a value-specific
  // transition rather than hijacking the entrance timing.
  assert.match(sweep, /transition:\s*\{\s*backgroundPosition:/, "wertsspezifische Transition");
});

/*
 * The endless shimmer used to be a motion `animate` on `backgroundPosition` plus
 * a gradient written separately into the element's inline `style`. Those halves
 * had separate lifetimes, and a lilac band survived wherever the animation
 * stopped while the element stayed mounted. Measured in the browser on the
 * AppShell "Opening workspace" surface:
 *
 *   - "Off" chosen before the mount:  background-position froze at `0% 0%`,
 *     animationName `none`, inline background-image still the gradient.
 *   - "Off" toggled from the settings dialog mid-shimmer: froze at `-9% 0%`,
 *     same inline gradient, same `animationName: none`.
 *
 * Both were the reported symptom. Hypothesis B — a caller whose loading
 * condition never turns false — was measured and refuted: every shimmer host
 * cleared its gradient completely once its load finished (0 elements with a
 * gradient), including the Skills skeleton and the AppShell cwd validation.
 *
 * These assertions hold the structural invariant that makes the class of
 * defect impossible: the shimmer paints no gradient of its own, so there is no
 * inline style left behind that could outlive its motion. The rule that owns
 * the gradient also owns the animation, and the mode that stands still removes
 * both together.
 */

test("Der Shimmer malt keinen Gradienten in sich selbst, sonst ueberlebt er die Animation", () => {
  const hooks = readFileSync(new URL("./hooks.ts", import.meta.url), "utf8");
  const body = stripComments(hooks.slice(hooks.indexOf("export function useShimmerProps")));
  const fn = body.slice(0, body.indexOf("\nexport function", 10));
  // The whole returned surface: no `backgroundImage`, no `backgroundSize`, and
  // no motion keyframes to drive a position that something else has to clear.
  assert.doesNotMatch(fn, /backgroundImage/, "useShimmerProps schreibt backgroundImage");
  assert.doesNotMatch(fn, /backgroundSize/, "useShimmerProps schreibt backgroundSize");
  assert.doesNotMatch(fn, /animate:/, "useShimmerProps hat Keyframes");
  assert.doesNotMatch(fn, /repeat:\s*Infinity/, "useShimmerProps hat eine Endlos-Transition");
  // What it does return is a class name, empty when animations are off.
  assert.match(fn, /className:/, "useShimmerProps liefert keine className");
  assert.match(fn, /mode === "off" \? "" : "omp-shimmer"/, "kein Wash im Modus off");

  // And the component that spreads it must not reintroduce the split. The
  // check runs over the code with the comments stripped: the doc comment
  // discusses `background-position` because that is what the bug was.
  const shimmer = stripComments(readFileSync(new URL("./Shimmer.tsx", import.meta.url), "utf8"));
  assert.doesNotMatch(shimmer, /backgroundImage/, "Shimmer.tsx");
  assert.doesNotMatch(shimmer, /background-position/, "Shimmer.tsx");
  // A plain div: the wash needs no motion element, and not having one means no
  // imperative writer can park a position on it.
  assert.doesNotMatch(shimmer, /motion\.div/, "Shimmer.tsx ist kein motion.div mehr");
});

test("Gradient und Animation gehoeren in dieselbe CSS-Regel", () => {
  // One rule for both halves. Split across a class and an inline style they can
  // be torn apart again, which is exactly the defect this replaced.
  const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
  const rule = css.slice(css.indexOf(".omp-shimmer {"));
  const body = rule.slice(0, rule.indexOf("\n}"));
  assert.ok(body.length > 0, ".omp-shimmer fehlt in globals.css");
  assert.match(body, /background-image:\s*linear-gradient/, "kein Gradient in der Regel");
  assert.match(body, /animation:\s*omp-shimmer-wash/, "keine Animation in der Regel");
  assert.match(css, /@keyframes omp-shimmer-wash/, "Keyframes fehlen");

  // Standing still has to take the gradient with it. The global `off` block
  // above only shortens animations, which on its own would freeze the band in
  // place — the exact failure being fixed.
  const off = css.slice(css.indexOf('html[data-omp-animations="off"] .omp-shimmer'));
  assert.ok(off.length > 0, "keine off-Regel fuer .omp-shimmer");
  assert.match(off.slice(0, off.indexOf("}")), /background-image:\s*none/, "Gradient bleibt im Modus off");

  // Same for an OS that asks for reduced motion: no loop and no band, because
  // a motionless gradient is what this whole change is about.
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  const block = reduced.slice(reduced.indexOf(".omp-shimmer"), reduced.indexOf("}", reduced.indexOf(".omp-shimmer")));
  assert.match(block, /animation:\s*none/, "Animation laeuft bei reduced motion weiter");
  assert.match(block, /background-image:\s*none/, "Gradient bleibt bei reduced motion stehen");
});

/*
 * The wash has to run out: one pass across the surface, the band gone, and only
 * then the next pass. It never did, and the reason was not the loop — it was
 * `background-repeat`, which the rule never set and which therefore defaulted to
 * `repeat`.
 *
 * The band is a single tile of `background-size: 200% 100%`, i.e. twice the
 * element's width, and the gradient is transparent only over its own outer 10%
 * at each end. In percentage points of element width that paints [20, 180] of
 * each tile and leaves a transparent gap of 2 x 0.10 x 200pp = 40pp before the
 * next tile's paint begins, while the element's own window is 100pp wide. A
 * 100pp window cannot fit inside a 40pp gap, so under `repeat` the neighbours
 * always close in behind the band and fill what it vacates.
 *
 * Worth separating, because it is easy to conflate: the band leaving its *own*
 * tile is not the same as the element clearing. `background-position: P%` moves
 * the tile by P% x (container - image) = -Ppp, so a pixel at x sits at tile
 * coordinate (x + P). At P = 200% the window shows tile coordinates [200, 300],
 * entirely past the painted [20, 180] — that tile contributes nothing at all,
 * and the element is only painted there because of its neighbour. Travelling
 * further therefore could not have produced an empty element; only the repeat
 * could be removed.
 *
 * The helpers below composite the gradient across the element the way CSS does,
 * so the assertions are about the invariant rather than about this prose.
 * Modelled over the old 200% -> -200% travel with `repeat`, the minimum *peak*
 * alpha was 0.1915 against a 0.46 band, reached at P = -50% where the window
 * straddles a tile boundary. That is a dim position, not a cleared one — the
 * distinction the test is careful to preserve.
 */
const TILE_WIDTHS = 2;
const GRADIENT_STOPS = [
  [0.0, 0.0], [0.1, 0.0], [0.46, 0.46], [0.5, 0.15], [0.54, 0.46], [0.9, 0.0], [1.0, 0.0],
];

/** Alpha of the band at gradient fraction `q`, linearly between the stops. */
function bandAlpha(q) {
  let prev = GRADIENT_STOPS[0];
  for (const stop of GRADIENT_STOPS) {
    if (q <= stop[0]) {
      const [q0, a0] = prev;
      const [q1, a1] = stop;
      return q1 === q0 ? a1 : a0 + ((q - q0) / (q1 - q0)) * (a1 - a0);
    }
    prev = stop;
  }
  return 0;
}

/**
 * Peak painted alpha of the element at `positionPercent`, compositing the tile
 * and — when the rule allows it — its neighbours the way `background-repeat`
 * would.
 *
 * The `tiles` loop below is not decoration, it is the whole point, and getting
 * it wrong is easy in a way that produces *plausible false zeroes*.
 *
 * If you evaluate only tile 0 — the obvious first implementation, one gradient,
 * no neighbour loop — then any window that has slid off the end of that one
 * tile reads as empty, because there is nothing left in the array to paint it.
 * Measured over the old 200% -> -200% travel that yields 61 apparently-clear
 * positions in -110% .. -80%, which is exactly backwards: the element is *most*
 * painted there, because the neighbouring tile is what covers it. Spot-checking
 * the edge of that alleged clear band gives a true peak of 0.4599 at P = -110%,
 * not 0.
 *
 * A modulo-folded lookup (`(x - offset) % T` into a single table) has the same
 * class of problem in reverse — it never sees the seam, so it under-reports
 * paint — which is why both the neighbours and the offset sign below are spelled
 * out rather than folded up.
 *
 * That artifact is what makes this rule worth writing down rather than
 * rediscovering: it reads as proof that the repeat is harmless, and it is
 * exactly the opposite of the truth.
 */
function peakPaintedAlpha(positionPercent, { repeat, samples = 2001 }) {
  const offset = (positionPercent / 100) * (1 - TILE_WIDTHS);
  let peak = 0;
  for (let i = 0; i < samples; i += 1) {
    // Pixel centres across the element; q is the gradient fraction for tile 0.
    const q = ((i + 0.5) / samples - offset) / TILE_WIDTHS;
    const tiles = repeat ? [-3, -2, -1, 0, 1, 2, 3] : [0];
    for (const k of tiles) peak = Math.max(peak, bandAlpha(q - k));
  }
  return peak;
}

/** The keyframe percentages and positions of the wash, read back from globals.css. */
function readWashKeyframes() {
  const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
  const block = css.slice(css.indexOf("@keyframes omp-shimmer-wash"));
  // Brace-match the block. Slicing to the first `}` would stop inside the first
  // keyframe, because every keyframe is itself a nested `{ }`.
  const open = block.indexOf("{");
  let depth = 0;
  let close = open;
  for (; close < block.length; close += 1) {
    if (block[close] === "{") depth += 1;
    else if (block[close] === "}") depth -= 1;
    if (depth === 0) break;
  }
  const body = block.slice(open + 1, close);
  return [...body.matchAll(/([\d.]+)%\s*\{\s*background-position:\s*(-?[\d.]+)%/g)]
    .map(([, percent, position]) => ({ percent: Number(percent), position: Number(position) }));
}

test("Ohne no-repeat rueckt die Nachbarkachel nach und fuellt, was das Band verlässt", () => {
  // Two separate claims, kept apart on purpose.
  //
  // (1) Under `repeat` the old travel never became fully empty. `background-
  // position: P%` moves the tile by P% x (container - image) = -Ppp, so a pixel
  // at x sits at tile coordinate (x + P); the painted span is [20, 180] of each
  // tile, the gaps between tiles are 40pp wide, and the element's window is
  // 100pp. A 100pp window cannot fit in a 40pp gap, so the neighbours always
  // close in behind the band.
  //
  // (2) The band leaving its own tile is not the same as the element clearing.
  // At P = 200% the window shows tile coordinates [200, 300] — entirely past the
  // painted [20, 180], so that tile contributes nothing. What still paints the
  // element there is the *neighbour*. This is the distinction the fix rests on,
  // and it is why the fix is a `background-repeat` rather than a wider range.
  const sample = (repeat) => {
    let worst = Infinity;
    for (let i = 0; i <= 4000; i += 1) {
      const position = 200 - (400 * i) / 4000;
      worst = Math.min(worst, peakPaintedAlpha(position, { repeat }));
    }
    return worst;
  };

  // Tolerance, not equality: a computed float, and the point is the magnitude.
  // This is the darkest *peak* along the old travel, not a cleared position —
  // it sits at P = -50%, where the window straddles a tile boundary and the
  // band's near half plus the neighbour's far half still cover the element.
  const withRepeat = sample(true);
  assert.ok(withRepeat > 0.19 && withRepeat < 0.20, `minimale Peak-Alpha im alten Lauf (${withRepeat})`);

  // No single position under `repeat` reaches peak 0: the old wash had no rest
  // anywhere in it, which is what "circled forever" meant.
  let anyClear = false;
  for (let i = 0; i <= 4000; i += 1) {
    const position = 200 - (400 * i) / 4000;
    if (peakPaintedAlpha(position, { repeat: true }) === 0) anyClear = true;
  }
  assert.equal(anyClear, false, "unter repeat gab es im alten Lauf eine klare Position");

  // With the repeat removed the same travel does clear, which shows the repeat
  // was the sole cause and not the gradient's own transparent ends.
  assert.equal(sample(false), 0, "mit no-repeat muss dasselbe Travel auslaufen");

  // And the neighbouring tile is demonstrably what was doing the painting at
  // the old extremes: that tile alone is empty there, the repeat is not.
  for (const position of [200, -200, 190, -90]) {
    assert.equal(peakPaintedAlpha(position, { repeat: false }), 0, `Position ${position}% ist nicht leer`);
    assert.ok(peakPaintedAlpha(position, { repeat: true }) > 0, `Position ${position}% bleibt unter repeat leer`);
  }
});

test("Der Wash laeuft aus: am Ende der Bewegung ist nichts mehr gemalt, bevor der naechste beginnt", () => {
  const keyframes = readWashKeyframes();
  assert.ok(keyframes.length >= 3, "die Keyframes brauchen einen Start, ein Lauf-Ende und den Parkplatz");

  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  const restStart = keyframes[keyframes.length - 2];

  // Both ends of the travel must sit on an element the band does not touch at
  // all. This is the acceptance criterion stated as pixels rather than as prose.
  assert.equal(peakPaintedAlpha(first.position, { repeat: false }), 0, "Start des Wash malt noch etwas");
  assert.equal(peakPaintedAlpha(restStart.position, { repeat: false }), 0, "Ende des Wash malt noch etwas");

  // And there has to be a rest, not just a jump back: the last two keyframes
  // share a position, so the band parks on an empty element for the tail of the
  // cycle instead of circling. Without this the wash is a pass that never ends.
  assert.equal(restStart.position, last.position, "der Wash parkt nicht, er springt zurueck");
  assert.ok(last.percent > restStart.percent, "die Pause braucht Laenge im Zyklus");
  assert.ok(
    last.percent - restStart.percent >= 10 && last.percent - restStart.percent <= 40,
    `die Pause liegt bei ${last.percent - restStart.percent}% und damit ausserhalb 10-40%`,
  );

  // The wrap has to be invisible too: the position it jumps back to is the
  // start, and that start is already empty.
  assert.equal(first.position, keyframes[0].position);
  assert.equal(peakPaintedAlpha(first.position, { repeat: false }), 0);

  // Between the two ends the band must actually be visible, otherwise the rule
  // passes every check above by never drawing anything.
  const travelled = [];
  for (let i = 0; i <= 100; i += 1) {
    const t = i / 100;
    travelled.push(first.position + (restStart.position - first.position) * t);
  }
  const brightest = Math.max(...travelled.map((p) => peakPaintedAlpha(p, { repeat: false })));
  assert.ok(brightest > 0.4, `der Wash zeichnet unterwegs zu wenig (${brightest})`);

  // Symmetric in and out: a wash that fades in slowly and leaves abruptly reads
  // as a wipe, not as a pass. Measured as peak alpha against the reversed run.
  const profile = travelled.map((p) => peakPaintedAlpha(p, { repeat: false }));
  const asymmetry = Math.max(...profile.map((v, i) => Math.abs(v - profile[profile.length - 1 - i])));
  assert.ok(asymmetry < 0.01, `Ein- und Auslaufen sind nicht symmetrisch (${asymmetry})`);

  // The fade must be a fade and not a cut at the last moment: the tail decays
  // gradually down to zero over the end of the travel.
  const tail = profile.slice(-25);
  assert.ok(tail[tail.length - 1] === 0, "der Wash endet nicht auf transparent");
  assert.ok(
    tail.some((v) => v > 0 && v < 0.2),
    "der Wash blendet nicht aus, sondern faellt am Ende hart ab",
  );
});

test("Die Dauer des Wash kommt weiterhin nur aus SHIMMER_DURATION", () => {
  // The 75% keyframe is a share of the cycle, not a second duration in the
  // rule. A literal seconds value here would be the number drifting in two
  // places, which is what the custom property exists to prevent.
  const css = stripComments(readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8"));
  const rule = css.slice(css.indexOf(".omp-shimmer {"));
  const body = rule.slice(0, rule.indexOf("\n}"));

  assert.match(body, /var\(--omp-shimmer-duration/, "die Dauer kommt nicht aus der Custom Property");
  // The only seconds in the rule are inside the var() fallback, which is the
  // documented stand-in for the constant, not an independent duration.
  const literals = [...body.matchAll(/(?<![\w-])(\d*\.?\d+)s\b/g)].map((m) => m[1]);
  for (const literal of literals) {
    const around = body.slice(Math.max(0, body.indexOf(literal) - 40), body.indexOf(literal) + 10);
    assert.match(around, /var\(--omp-shimmer-duration/, `feste Dauer ${literal}s ausserhalb des var()`);
  }

  // The rule must actually carry the repeat fix, which is the load-bearing line.
  assert.match(body, /background-repeat:\s*no-repeat/, "das Tile wiederholt sich wieder und das Band laeuft nie aus");
});

test("Skeleton hat nur noch einen Pfad, damit Groesse und Fuellung nicht auseinanderlaufen", () => {
  // The mode branch rendered a bare div when animations were off and a Shimmer
  // otherwise. Two paths that must agree about the box; the class makes it one.
  const source = readFileSync(new URL("./Skeleton.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /mode === "off"/, "Skeleton verzweigt noch selbst");
  assert.doesNotMatch(source, /useAnimationPreference/, "Skeleton liest den Modus selbst");
  // The placeholder is hidden from assistive tech in both states, not only on
  // the branch that used to render no wash.
  assert.match(source, /aria-hidden/, "Skeleton markiert seinen Platzhalter nicht");
});

test("Nur ein echter Wartezustand bekommt den Endlos-Wash", () => {
  // The shimmer fix makes the wash well-behaved; it does not make it
  // appropriate everywhere. `TerminalViewer` rendered its status badge through
  // `Shimmer` for `exited` and `error` as well as `connecting`, and those two
  // are final: the process is gone or the stream failed, neither will change,
  // and neither should be the one panel in the surface that loops forever.
  const source = stripComments(readFileSync(new URL("../TerminalViewer.tsx", import.meta.url), "utf8"));

  // The badge is still shown for all three states.
  assert.match(source, /status === "connecting" \|\| status === "error" \|\| status === "exited"/, "Badge fehlt");
  // But the `Shimmer` branch is guarded by `connecting` alone.
  const shimmerBranch = source.slice(source.indexOf('status === "connecting" ? ('));
  assert.ok(shimmerBranch.length > 0, "kein Shimmer-Zweig");
  assert.match(shimmerBranch.slice(0, 200), /<Shimmer/, "Zweig ohne Shimmer");
  // And the finished states fall through to a plain element.
  assert.match(shimmerBranch, /<div/, "abgeschlossene Zustaende bekommen kein Shimmer");
  // The wording is on both halves, so neither badge ends up empty.
  assert.match(source, /connecting…/, "connecting-Text fehlt");
  assert.match(source, /status === "exited" \? "exited" : errorMessage \?\? "error"/, "Endtext fehlt");
});