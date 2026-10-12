"use client";

import { Shimmer } from "./Shimmer";

/**
 * A shimmering placeholder block.
 *
 * With animations on it is a `Shimmer` over a slightly raised surface. With
 * them off it is a flat block of the same size — the box is reserved either
 * way, so switching the setting never makes the layout jump.
 *
 * There is no mode branch here any more. It used to render a bare `div` when
 * animations were off, and a `Shimmer` otherwise, which meant two code paths
 * that had to agree about the size and the fill. `Shimmer` now applies no wash
 * at all in that mode, so a single path covers both: the same raised surface,
 * with the shimmer layered on or not.
 *
 * `backgroundColor`, never the `background` shorthand: the shorthand resets
 * background-image, which is the shimmer's gradient.
 */
export function Skeleton({ width, height, radius = 4 }: {
  width?: number | string;
  height?: number | string;
  radius?: number;
}) {
  return (
    <Shimmer
      radius={radius}
      aria-hidden
      style={{ backgroundColor: "var(--bg-hover)", width, height }}
    />
  );
}