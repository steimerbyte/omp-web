"use client";

import { useMemo } from "react";
import { useAnimationPreference } from "./AnimationProvider";
import { SHIMMER_DURATION, SWEEP_DURATION } from "./animations";
import type { AnimationMode } from "./animation-mode";

/**
 * Thin accessors over the animation store.
 *
 * `useShimmerProps` exists so callers do not have to branch on the mode. When
 * animations are off it hands back an empty class name, and the element falls
 * back to a flat surface without a conditional at the call site.
 *
 * The two hooks here are deliberately not the same shape. The sweep is a
 * one-shot played *alongside* a panel's own entrance, so it has to be motion
 * keyframes that the caller merges into its own `animate`. The shimmer is the
 * entire effect, so it is a single CSS class (`.omp-shimmer` in globals.css)
 * that owns the gradient and its animation together.
 */

export type ShimmerProps = {
  /**
   * Spread into the element's `className`.
   *
   * Empty when animations are off. This is the whole fix for the frozen band:
   * the wash is one CSS rule, so the gradient and its motion are installed and
   * removed together and cannot come apart. See `useShimmerProps`.
   */
  className: string;
  /**
   * Spread onto the element's `style`.
   *
   * Carries the wash duration as a custom property only. There is deliberately
   * no `backgroundImage` here any more — see the note on `useShimmerProps`.
   */
  style: { "--omp-shimmer-duration": string };
};

/**
 * The sweep half only, for elements that animate something else as well.
 *
 * This must NOT be spread as `{...sweep}` after an `animate` prop: a spread of
 * `animate` replaces the whole object rather than merging into it, so the
 * panel's own `opacity: 1` would be dropped and the element would sit at its
 * `initial` opacity of 0 forever. Instead the caller merges the two keyframes
 * and gives `backgroundPosition` its own value-specific transition, which is
 * what keeps the entrance at 240 ms while the wash runs for its full length.
 */
export type SweepKeys = {
  animate: { backgroundPosition?: string[] };
  transition: { backgroundPosition?: { duration: number; repeat: number; ease: "easeOut" } };
};

/**
 * The one-shot band's background. See `useSweepProps` for why it may live in
 * `style`.
 *
 * `backgroundRepeat` is the load-bearing member and it is typed as the literal
 * rather than `string`, so dropping the fix is a compile error instead of a
 * silent return to the initial-value defect described on `useSweepProps`.
 */
export type WashStyle = {
  backgroundImage: string;
  backgroundSize: string;
  backgroundRepeat: "no-repeat";
};

// Only accent tokens. A colour literal would survive a theme import as the
// wrong hue, because `applyOmpPalette` rewrites these variables at runtime.
//
// The band is transparent at both ends so it can sit on top of whatever the
// element already paints, and the core is bright enough to read against
// --bg-panel in both themes. At the old 26% it was effectively invisible on
// dark panels, which is what made the loading states look like plain blocks.
//
// This builds the one-shot sweep only. The endless wash needs the same shape
// of gradient, but it must move with its animation, so it lives in the
// `.omp-shimmer` rule in globals.css where the two cannot be separated.
const washImage = (strength: number) =>
  `linear-gradient(90deg, transparent 10%, color-mix(in srgb, var(--accent) ${strength}%, transparent) 46%, color-mix(in srgb, var(--text) ${Math.round(strength / 3)}%, transparent) 50%, color-mix(in srgb, var(--accent) ${strength}%, transparent) 54%, transparent 90%)`;

export function useAnimationMode(): AnimationMode {
  return useAnimationPreference();
}

/**
 * The repeating wash for a surface that is waiting on something.
 *
 * This returns a class name and nothing else. It used to return the gradient as
 * an inline `style.backgroundImage` plus a motion `animate` on
 * `backgroundPosition`, and that split is what left lilac panels behind:
 *
 *   - The two halves had separate lifetimes. React wrote `background-image`
 *     into the element's inline style at mount and never took it out again,
 *     while motion owned the `background-position` and simply stopped writing
 *     once its animation stopped. Anything that ended the animation without
 *     unmounting the element — switching the animation setting to "Off" from
 *     the settings dialog, which is the one control that reaches a live
 *     surface — left a gradient with no motion behind it.
 *   - Measured on the AppShell "Opening workspace" surface: with "Off" chosen
 *     before the mount the band froze at `background-position: 0% 0%`, dead
 *     centre of the panel; with "Off" toggled mid-shimmer it froze wherever the
 *     animation happened to be, at `-9% 0%`. In both cases
 *     `getComputedStyle(el).animationName` was `none` and
 *     `el.style.backgroundImage` still held the gradient.
 *
 * A CSS rule cannot have that defect: `.omp-shimmer` declares the gradient and
 * the `omp-shimmer-wash` animation in the same block, so removing the class
 * removes both, and the class is only applied while animations are on. It also
 * means the wash is a real animation the compositor owns, where the motion
 * version wrote `background-position` inline on every frame of every shimmer.
 *
 * The duration travels as a custom property so `SHIMMER_DURATION` stays the one
 * place the number is written down. It is the whole cycle — run plus rest — not
 * the run alone, so the split between them stays a share of one number inside
 * `@keyframes omp-shimmer-wash` instead of a second constant here. The band
 * itself leaves the element rather than circling on it; that needed
 * `background-repeat: no-repeat` in the rule, and the reasoning is on the
 * keyframes.
 */
/**
 * The swept band's background. Three constants, no dependency, so it is built
 * once here rather than per render.
 *
 * It used to be a local `const` inside `useSweepProps` and read from the memo
 * below without being listed in its dependencies — which
 * `react-hooks/exhaustive-deps` flagged, and correctly: a fresh object on
 * every render is precisely the case a memo cannot see through. Hoisting it
 * makes the dependency list true rather than merely unchanged.
 */
const SWEEP_STYLE: WashStyle = {
  backgroundImage: washImage(70),
  backgroundSize: "220% 100%",
  backgroundRepeat: "no-repeat",
};

export function useShimmerProps(): ShimmerProps {
  const mode = useAnimationPreference();

  // Memoised so the className string is stable: it lands in the element's
  // `class` attribute, and a new string per render would be a changed prop on
  // every shimmer on every frame of whatever is streaming behind them.
  return useMemo(
    () => ({
      // No class at all when animations are off, so no gradient is ever
      // painted — there is nothing left behind to go stale.
      className: mode === "off" ? "" : "omp-shimmer",
      style: { "--omp-shimmer-duration": `${SHIMMER_DURATION}s` },
    }),
    [mode],
  );
}

/**
 * The same band, played once when a panel pops up.
 *
 * A one-shot wash is what tells the eye "something just arrived"; the endless
 * one would be wrong here because it would never stop on a panel that is
 * finished loading. The gradient is transparent at the edges, so it needs no
 * wrapper and no `overflow: hidden` — which matters, because the popovers that
 * use this position themselves and must not be clipped by their own entrance.
 *
 * Returns the keyframes and the background, not a ready-made prop set. See
 * `SweepKeys` for why merging is the caller's job.
 */
export function useSweepProps(): SweepKeys & { style: WashStyle } {
  const mode = useAnimationPreference();

  // Same reason as in `useShimmerProps`: a new `animate` object per render
  // replays the one-shot wash on every render, so on a re-rendering panel it
  // never completes and the band sits parked part-way across the surface.
  //
  // The sweep keeps its gradient in `style`, unlike the shimmer, because it is
  // finite: `repeat: 0` runs it once, and the run *ends on a position that
  // paints nothing* — see `backgroundRepeat` below for the measurement. There
  // is no separate gradient to take away afterwards, so the inline style has no
  // residue; a panel that stays mounted after its entrance is exactly what this
  // is for, and the wash has already played out by then. The `off` branch drops
  // the gradient outright.
  //
  // `backgroundRepeat` is the fix, and it is the same line the `.omp-shimmer`
  // rule needed in globals.css. Without it the value defaults to `repeat` and
  // the neighbouring tile closes in behind the departing band and paints what
  // it vacates. The sweep's tile is 220% of the element and its gradient is
  // transparent only over its outer 10% at each end, so one tile paints
  // [0.22, 1.98] in element widths and the gap before the next tile begins is
  // 2 x 0.10 x 220pp = 44pp, while the element's own window is 100pp. A 100pp
  // window cannot fit inside a 44pp gap, so under `repeat` *no* position on the
  // whole travel leaves the element clear.
  //
  // Measured on the swept geometry (tile 220%, travel 220% -> -220%), pixel
  // centres across the element, compositing the neighbouring tiles:
  //
  //   position   repeat                       no-repeat
  //   +220%      100% painted, peak 0.69997   0% painted, peak 0.0000
  //   -220%       56% painted, peak 0.30028   0% painted, peak 0.0000
  //
  // The end position is the one that persists: motion stops writing
  // `background-position` once a `repeat: 0` transition finishes, so the element
  // keeps the gradient *and* the last position, which is what parked a lilac
  // band across the login card (`app/login/page.tsx`) and every AppShell
  // surface that calls this hook. Under `no-repeat` that resting position is
  // empty, so the finished sweep has no visible effect at all — which is the
  // measured answer to whether the inline gradient still has to be removed.
  //
  // `0% 0%` — the value the element carries before motion writes anything, and
  // therefore the resting position of any path that never runs the animation —
  // paints 78% of the element at peak 0.6894 even under `no-repeat`. That is
  // why the run's endpoints have to be outside the painted window and not
  // merely "somewhere off to the side"; see the travel range below.
  // The travel. It has to start and end on positions that paint nothing, and
  // `background-position: P%` moves the tile by P% x (container - image), so a
  // pixel at x sits at tile coordinate (x - P) / 2.2 in element widths. The
  // painted window under `no-repeat` is exactly P in [-66, 165]: at P = +165 the
  // window shows tile coordinates [1.2, 1.65], entirely past this tile's
  // [0.22, 1.98], and at P = -66 it shows [-1.83, -1.37], entirely before it.
  //
  // 220% -> -220% therefore spent 209 of its 440 percentage points — 47% of the
  // run — travelling across nothing, once the repeat stopped papering over it.
  // Measured against `easeOut` over the full 0.72s that left the band visible
  // for 280ms of the 720ms, which is not enough to outlast a 240ms panel
  // entrance: the wash was gone almost as early as the panel finished settling,
  // and the remainder was motion on an already-empty element rather than a
  // pause. 190% -> -90% keeps both endpoints empty with ~25pp of margin and
  // raises the visible pass to 505ms of 720ms, still 2.1x the entrance.
  //
  // It is also the range `@keyframes omp-shimmer-wash` already travels, so the
  // one-shot and the endless wash now run the same arc.
  return useMemo(
    () =>
      mode === "off"
        ? { animate: {}, transition: {}, style: { ...SWEEP_STYLE, backgroundImage: "none" } }
        : {
            animate: { backgroundPosition: ["190% 0%", "-90% 0%"] },
            transition: { backgroundPosition: { duration: SWEEP_DURATION, repeat: 0, ease: "easeOut" as const } },
            style: SWEEP_STYLE,
          },
    [mode],
  );
}