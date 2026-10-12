"use client";

import { motion } from "motion/react";
import type { HTMLMotionProps } from "motion/react";
import { forwardRef } from "react";
import { DURATION_FAST } from "./animations";
import { useAnimationPreference } from "./AnimationProvider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ReactNode } from "react";

/**
 * The press feedback every button in the app shares.
 *
 * This replaces three classes that existed for different reasons:
 * `.omp-press` (plain), `.omp-press-scale` and `.omp-press-tint` (with the
 * accent flash). The `-scale` variant existed only because a CSS keyframe
 * overwrote `transform` outright and clobbered an element's own transform —
 * motion composes instead, so that limitation is gone. The tint is now opt-in
 * via `tint`, because a scale alone is invisible on a full-width bar.
 *
 * A disabled button never fires `:active`, and `whileTap` likewise never
 * fires on a disabled control, so the dead-button case is handled for free.
 *
 * **An optional `tooltip` does not touch the animation.** Radix's
 * `Tooltip.Trigger` renders `asChild`, which merges its props onto the child
 * through `Slot` instead of wrapping it — so the trigger *is* the
 * `motion.button`, not a `<span>` around one. That matters: a wrapper element
 * would swallow `whileTap` and the press feedback, and a `title` attribute
 * cannot be replaced by a real tooltip without losing the native fallback.
 * Without `tooltip` the markup is byte-identical to before.
 *
 * **`MotionConfig` does not cover this.** `reducedMotion` is consulted when an
 * `animate` target is resolved and for layout animations; a gesture animation
 * runs straight through `animateSingleValue` and never sees it. Measured: with
 * the setting on "Off" a tap still scaled the button. So the mode is checked
 * here explicitly — without a `whileTap` there is no press to animate.
 */

const TAP_SCALE = { scale: 0.96 };
const TAP_TINT = { scale: 0.96, backgroundColor: "var(--accent-hover, var(--accent))" };

export const Pressable = forwardRef<HTMLButtonElement, HTMLMotionProps<"button"> & {
  tint?: boolean;
  /** Shows a Radix tooltip on hover/focus. Omit it and no tooltip is rendered. */
  tooltip?: string;
  children?: ReactNode;
}>(function Pressable({ tint, tooltip, style, children, ...rest }, ref) {
  const mode = useAnimationPreference();

  const button = (
    <motion.button
      ref={ref}
      whileTap={mode === "off" ? undefined : tint ? TAP_TINT : TAP_SCALE}
      transition={{ duration: DURATION_FAST }}
      style={style}
      {...rest}
    >
      {children}
    </motion.button>
  );

  if (!tooltip) return button;

  return (
    <Tooltip>
      {/* asChild, not a wrapping element: the trigger has to BE the motion
          button, otherwise whileTap lands on a parent and the press feedback
          is gone. Slot merges the trigger props onto the child in place. */}
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
});