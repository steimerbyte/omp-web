"use client";

import { motion } from "motion/react";
import { forwardRef } from "react";
import { DURATION_BASE, EASE_POP, SPIN_TRANSITION } from "./animations";
import { useAnimationPreference } from "./AnimationProvider";
import { useSweepProps } from "./hooks";
import type { HTMLMotionProps } from "motion/react";

/**
 * Entrance and looping primitives for containers that mount on demand.
 *
 * `Enter` replaces the four `.omp-slide-in-*` classes. The axis is a prop
 * instead of a class name so the dropdown surfaces pick their direction from
 * the same value that positions them, rather than keeping a second switch.
 *
 * Every one of these forwards its ref: menus and popovers measure their own
 * box to decide which side to open on, and a component that cannot hand back a
 * ref gets reimplemented inline instead of reused.
 */

export type EnterDirection = "down" | "up" | "left" | "right";

const OFFSET: Record<EnterDirection, { x: number; y: number }> = {
  down: { x: 0, y: -8 },
  up: { x: 0, y: 8 },
  left: { x: -12, y: 0 },
  right: { x: 12, y: 0 },
};

const initialFor = (direction: EnterDirection) => ({
  opacity: 0,
  x: OFFSET[direction].x,
  y: OFFSET[direction].y,
  ...(direction === "left" || direction === "right" ? null : { scale: 0.98 }),
});

export const Enter = forwardRef<HTMLDivElement, Omit<HTMLMotionProps<"div">, "ref"> & {
  direction?: EnterDirection;
}>(function Enter({ children, direction = "down", className, style, ...rest }, ref) {
  const sweep = useSweepProps();

  return (
    <motion.div
      ref={ref}
      className={className}
      {...rest}
      initial={initialFor(direction)}
      animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
      transition={{ duration: DURATION_BASE, ease: EASE_POP }}
      {...sweep.motion}
      style={{ ...style, ...sweep.style }}
    >
      {children}
    </motion.div>
  );
});

/** The modal pair. They animate different properties, so they stay separate. */
export const ModalBackdrop = forwardRef<HTMLDivElement, Omit<HTMLMotionProps<"div">, "ref">>(function ModalBackdrop({ children, className, style, ...rest }, ref) {
  return (
    <motion.div
      ref={ref}
      className={className}
      style={style}
      {...rest}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
});

export const ModalPanel = forwardRef<HTMLDivElement, Omit<HTMLMotionProps<"div">, "ref">>(function ModalPanel({ children, className, style, ...rest }, ref) {
  const sweep = useSweepProps();

  return (
    <motion.div
      ref={ref}
      className={className}
      {...rest}
      initial={{ opacity: 0, scale: 0.96, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.2, ease: EASE_POP }}
      {...sweep.motion}
      style={{ ...style, ...sweep.style }}
    >
      {children}
    </motion.div>
  );
});

/**
 * The endless turn for spinners and gear icons.
 *
 * `will-change` is deliberately not set here: motion manages it per
 * animation, and pinning it on a permanently spinning element holds a
 * compositing layer for the life of the page.
 */
export const Spin = forwardRef<HTMLDivElement, Omit<HTMLMotionProps<"div">, "ref"> & {
  /** Overrides the shared 0.8 s turn for a deliberately slower indicator. */
  duration?: number;
}>(function Spin({ children, className, style, duration, ...rest }, ref) {
  const mode = useAnimationPreference();

  return (
    <motion.div
      ref={ref}
      className={className}
      style={style}
      {...rest}
      // An endless turn is the one thing a stand-still setting must never
      // leave running, so it is gated here rather than left to MotionConfig.
      animate={mode === "off" ? undefined : { rotate: 360 }}
      transition={duration === undefined ? SPIN_TRANSITION : { ...SPIN_TRANSITION, duration }}
    >
      {children}
    </motion.div>
  );
});