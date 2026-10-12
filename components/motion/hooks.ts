"use client";

import { useMemo } from "react";
import { useAnimationPreference } from "./AnimationProvider";
import { SHIMMER_DURATION, SWEEP_DURATION } from "./animations";
import type { AnimationMode } from "./animation-mode";

/**
 * Thin accessors over the animation store.
 *
 * `useShimmerProps` exists so callers do not have to branch on the mode. When
 * animations are off it hands back no motion props and a neutral background,
 * and the component falls back to a flat surface without a conditional at the
 * call site. The two halves are returned separately because `animate` and
 * `transition` are motion props, while the gradient belongs in `style`.
 */

export type ShimmerProps = {
  /** Spread onto the `motion` element. Empty when animations are off. */
  motion: {
    animate?: { backgroundPosition: string[] };
    transition?: { duration: number; repeat: number; ease: "linear" | "easeOut" };
  };
  /** Spread onto the element's `style`. */
  style: {
    backgroundImage: string;
    backgroundSize: string;
  };
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

// Only accent tokens. A colour literal would survive a theme import as the
// wrong hue, because `applyOmpPalette` rewrites these variables at runtime.
//
// The band is transparent at both ends so it can sit on top of whatever the
// element already paints, and the core is bright enough to read against
// --bg-panel in both themes. At the old 26% it was effectively invisible on
// dark panels, which is what made the loading states look like plain blocks.
const washImage = (strength: number) =>
  `linear-gradient(90deg, transparent 10%, color-mix(in srgb, var(--accent) ${strength}%, transparent) 46%, color-mix(in srgb, var(--text) ${Math.round(strength / 3)}%, transparent) 50%, color-mix(in srgb, var(--accent) ${strength}%, transparent) 54%, transparent 90%)`;

const LOOP_IMAGE = washImage(46);

export function useAnimationMode(): AnimationMode {
  return useAnimationPreference();
}

/** The endless wash for a surface that is waiting on something. */
export function useShimmerProps(): ShimmerProps {
  const mode = useAnimationPreference();
  const style = { backgroundImage: LOOP_IMAGE, backgroundSize: "200% 100%" };

  // Memoised, and not cosmetic. Motion restarts an animation whenever the
  // `animate` prop is a new object, and a surface that re-renders — a panel
  // with a streaming file list behind it — re-renders constantly. Building the
  // keyframes fresh every render therefore replayed the wash forever and it
  // never got past its first few percent.
  return useMemo(
    () =>
      mode === "off"
        ? { motion: {}, style }
        : {
            motion: {
              animate: { backgroundPosition: ["200% 0%", "-200% 0%"] },
              transition: { duration: SHIMMER_DURATION, repeat: Infinity, ease: "linear" as const },
            },
            style,
          },
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
export function useSweepProps(): SweepKeys & { style: ShimmerProps["style"] } {
  const mode = useAnimationPreference();
  const style = { backgroundImage: washImage(70), backgroundSize: "220% 100%" };

  // Same reason as in `useShimmerProps`: a new `animate` object per render
  // replays the one-shot wash on every render, so on a re-rendering panel it
  // never completes and the band sits parked part-way across the surface.
  return useMemo(
    () =>
      mode === "off"
        ? { animate: {}, transition: {}, style: { backgroundImage: "none", backgroundSize: style.backgroundSize } }
        : {
            animate: { backgroundPosition: ["220% 0%", "-220% 0%"] },
            transition: { backgroundPosition: { duration: SWEEP_DURATION, repeat: 0, ease: "easeOut" as const } },
            style,
          },
    [mode],
  );
}