"use client";

import { motion } from "motion/react";
import { useShimmerProps } from "./hooks";
import type { CSSProperties, ReactNode } from "react";

/**
 * A left-to-right light wash, the one motion primitive every loading surface
 * shares.
 *
 * It generalises what the old `omp-pop-in-wash` keyframe did — a skewed band
 * travelling across the element — as a background-position sweep instead, so it
 * works on a panel of any size and composes with whatever border radius the
 * caller already has. `radius` has no default on purpose: leaving it unset
 * lets the caller's own CSS class keep owning the radius.
 */
export function Shimmer({ children, radius, className, style }: {
  children?: ReactNode;
  radius?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const { motion: motionProps, style: shimmerStyle } = useShimmerProps();

  return (
    <motion.div
      className={className}
      {...motionProps}
      style={{ ...shimmerStyle, ...(radius === undefined ? null : { borderRadius: radius }), ...style }}
    >
      {children}
    </motion.div>
  );
}