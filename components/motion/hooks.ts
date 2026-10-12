"use client";

import { useAnimationPreference } from "./AnimationProvider";
import { SHIMMER_DURATION } from "./animations";
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
    transition?: { duration: number; repeat: number; ease: "linear" };
  };
  /** Spread onto the element's `style`. */
  style: {
    backgroundImage: string;
    backgroundSize: string;
  };
};

// Only accent tokens. A colour literal would survive a theme import as the
// wrong hue, because `applyOmpPalette` rewrites these variables at runtime.
const WASH_IMAGE =
  "linear-gradient(90deg, transparent 15%, color-mix(in srgb, var(--accent) 26%, transparent) 50%, transparent 85%)";

export function useAnimationMode(): AnimationMode {
  return useAnimationPreference();
}

export function useShimmerProps(): ShimmerProps {
  const mode = useAnimationPreference();
  const style = { backgroundImage: WASH_IMAGE, backgroundSize: "200% 100%" };

  if (mode === "off") return { motion: {}, style };

  return {
    motion: {
      animate: { backgroundPosition: ["200% 0%", "-200% 0%"] },
      transition: { duration: SHIMMER_DURATION, repeat: Infinity, ease: "linear" },
    },
    style,
  };
}