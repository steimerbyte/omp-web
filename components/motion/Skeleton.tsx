"use client";

import { useAnimationPreference } from "./AnimationProvider";
import { Shimmer } from "./Shimmer";

/**
 * A shimmering placeholder block.
 *
 * With animations on it is a `Shimmer` over a slightly raised surface. With
 * them off it is a flat block of the same size — the box is reserved either
 * way, so switching the setting never makes the layout jump.
 */
export function Skeleton({ width, height, radius = 4 }: {
  width?: number | string;
  height?: number | string;
  radius?: number;
}) {
  const mode = useAnimationPreference();

  if (mode === "off") {
    return (
      <div
        aria-hidden
        style={{
          // backgroundColor, never the `background` shorthand: the shorthand
          // resets background-image, which is the shimmer's gradient.
          backgroundColor: "var(--bg-hover)",
          width,
          height,
          borderRadius: radius,
        }}
      />
    );
  }

  return (
    <Shimmer radius={radius} style={{ backgroundColor: "var(--bg-hover)", width, height }} />
  );
}