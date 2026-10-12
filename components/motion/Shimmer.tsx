"use client";

import { useShimmerProps } from "./hooks";
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

/**
 * A left-to-right light wash, the one motion primitive every loading surface
 * shares.
 *
 * It generalises what the old `omp-pop-in-wash` keyframe did — a skewed band
 * travelling across the element — as a background-position sweep instead, so it
 * works on a panel of any size and composes with whatever border radius the
 * caller already has. `radius` has no default on purpose: leaving it unset
 * lets the caller's own CSS class keep owning the radius.
 *
 * A plain `div`, not a `motion.div`. The wash used to be motion keyframes plus a
 * separately-installed gradient, and those two halves could come apart: React
 * wrote the inline `background-image` at mount and never removed it, motion
 * stopped writing `background-position` as soon as its animation ended, and
 * what was left was a painted lilac band that no longer moved. Both now live in
 * one CSS rule (`.omp-shimmer`), applied by `useShimmerProps`, so there is no
 * combination of props that leaves a gradient behind. See `useShimmerProps`.
 *
 * `aria-hidden` is forwarded because `Skeleton` uses this component for
 * placeholders that must stay out of the accessibility tree, and it used to
 * mark them only on the branch that rendered no wash — so a placeholder was
 * announced while it shimmered and silent once the animations were off.
 */
export function Shimmer({ children, radius, className, style, ...rest }: {
  children?: ReactNode;
  radius?: number;
  className?: string;
  style?: CSSProperties;
} & Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "children">) {
  const { className: shimmerClass, style: shimmerStyle } = useShimmerProps();

  return (
    <div
      {...rest}
      className={className ? `${shimmerClass} ${className}`.trim() : shimmerClass || undefined}
      style={{ ...shimmerStyle, ...(radius === undefined ? null : { borderRadius: radius }), ...style }}
    >
      {children}
    </div>
  );
}