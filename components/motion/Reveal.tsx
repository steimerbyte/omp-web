"use client";

import { motion } from "motion/react";
import { forwardRef } from "react";
import { DURATION_ENTER_PANEL, EASE_EMPHASIZED } from "./animations";
import { useSweepProps } from "./hooks";
import type { HTMLMotionProps } from "motion/react";

/**
 * The entrance for panels that mount on demand: the rise and the un-blur, plus
 * the one-shot light wash. Both halves matter — without the wash a panel just
 * appears, and the wash is what says it arrived.
 *
 * Der Übergang ist 220 ms (`DURATION_ENTER_PANEL`) auf `EASE_EMPHASIZED`:
 * hier kommt eine große Fläche an. Die alten 240 ms auf der kurzen Kurve
 * `[0.2, 0.8, 0.3, 1]` wirkten am Anfang gehetzt und standen am Ende still.
 * Animiert werden ausschließlich `opacity`, `transform` und `filter` —
 * nichts hier kann ein Layout auslösen.
 *
 * The ref is forwarded because several popovers measure their own box to
 * position themselves; without it they would each have to re-inline these
 * props instead of using this component.
 */
export const Reveal = forwardRef<HTMLDivElement, Omit<HTMLMotionProps<"div">, "ref"> & {
  /** Travel distance along Y. Negative enters from above. */
  y?: number;
}>(function Reveal({ children, className, style, y = -8, ...rest }, ref) {
  const sweep = useSweepProps();

  return (
    <motion.div
      ref={ref}
      className={className}
      {...rest}
      initial={{ opacity: 0, y, filter: "blur(6px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)", ...sweep.animate }}
      transition={{ duration: DURATION_ENTER_PANEL, ease: EASE_EMPHASIZED, ...sweep.transition }}
      style={{ ...style, ...sweep.style }}
    >
      {children}
    </motion.div>
  );
});