"use client";

import { forwardRef } from "react";
import { useAnimationMode } from "./hooks";
import { THINKING_DOT_DURATION } from "./animations";
import type { CSSProperties, HTMLAttributes } from "react";

/**
 * The one "an agent is working" indicator.
 *
 * A 7x7 dither field whose cells twinkle out of step. One grid layer, 49 cells,
 * and a cell animates nothing but its own `opacity`; the glow is a static
 * `box-shadow` on the cell, so it fades with the cell instead of being a second
 * animated property. Colours come only from `--accent` and `color-mix`,
 * because `applyOmpPalette` rewrites the palette at runtime.
 *
 * The phase is written per cell as a negative `animation-delay` and a slightly
 * different period, both derived from an integer hash of the index. No
 * `Math.random()`: the server and the first client render would otherwise
 * disagree about all 49 cells and React would throw the tree away.
 *
 * The box is always mounted and always the same size — callers may show or hide
 * the dots without the line they sit in moving by a pixel.
 */

const DOT_COUNT = 49;

/**
 * An integer hash, so the fan is identical on every engine.
 *
 * Floating point would be enough for a delay, but not enough for a test to pin
 * the exact same numbers the server rendered. `Math.imul` is exact by
 * definition and `>>>` keeps it unsigned.
 */
function hashDot(index: number): number {
  let h = Math.imul(index + 1, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

/**
 * Delay and period of one cell, as CSS time strings.
 *
 * The delay is negative so a cell starts mid-cycle instead of all cells taking
 * their first breath together. The period stays within 0.7x to 1.3x of the
 * shared token, which is what keeps neighbouring cells drifting apart without
 * any one of them looking slower than the indicator as a whole.
 */
export function dotTiming(index: number): { delay: string; duration: string } {
  const h = hashDot(index);
  return {
    delay: `-${((h % 1000) / 1000).toFixed(3)}s`,
    duration: `${(THINKING_DOT_DURATION * (0.7 + (h % 600) / 1000)).toFixed(3)}s`,
  };
}

export type ThinkingDotsProps = {
  /** Whether an agent is working. The box is rendered either way. */
  isWorking: boolean;
  /** Edge length of the square grid in pixels. */
  size?: number;
  className?: string;
  style?: CSSProperties;
} & Omit<HTMLAttributes<HTMLSpanElement>, "className" | "style" | "children">;

export const ThinkingDots = forwardRef<HTMLSpanElement, ThinkingDotsProps>(function ThinkingDots(
  { isWorking, size = 20, className, style, ...rest },
  ref,
) {
  const mode = useAnimationMode();
  // `MotionConfig`'s reducedMotion never reaches a CSS loop, so the mode is
  // read here as well; the `off` catch-all in globals.css is the second line.
  const live = isWorking && mode !== "off";

  return (
    <span
      {...rest}
      ref={ref}
      aria-hidden="true"
      data-working={isWorking ? "true" : "false"}
      className={className ? `omp-thinking-dots ${className}` : "omp-thinking-dots"}
      style={{ width: size, height: size, ...style }}
    >
      {Array.from({ length: DOT_COUNT }, (_, index) => {
        const timing = dotTiming(index);
        return (
          <span
            key={index}
            className={live ? "omp-thinking-dot is-live" : "omp-thinking-dot"}
            style={{
              "--omp-thinking-dot-delay": timing.delay,
              "--omp-thinking-dot-duration": timing.duration,
            } as CSSProperties}
          />
        );
      })}
    </span>
  );
});
