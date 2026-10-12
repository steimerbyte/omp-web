"use client";

import { motion } from "motion/react";
import { forwardRef } from "react";
import { EASE_POP } from "./animations";
import type { HTMLMotionProps } from "motion/react";

/**
 * The entrance for panels that mount on demand. This is what `.omp-pop-in`
 * used to do, minus the wash — the wash is now the `Shimmer`'s job and only
 * runs where it is actually wanted.
 *
 * The transition is 240 ms rather than the old 360 ms because the keyframe
 * spent most of its time on the blur and the background cross-fade, neither of
 * which is carried over.
 *
 * The ref is forwarded because several popovers measure their own box to
 * position themselves; without it they would each have to re-inline these
 * props instead of using this component.
 */
export const Reveal = forwardRef<HTMLDivElement, Omit<HTMLMotionProps<"div">, "ref"> & {
  /** Travel distance along Y. Negative enters from above. */
  y?: number;
}>(function Reveal({ children, className, style, y = -8, ...rest }, ref) {
  return (
    <motion.div
      ref={ref}
      className={className}
      style={style}
      {...rest}
      initial={{ opacity: 0, y, filter: "blur(6px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{ duration: 0.24, ease: EASE_POP }}
    >
      {children}
    </motion.div>
  );
});