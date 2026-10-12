/**
 * The house timings, in one place so the surfaces stay on the same rhythm.
 *
 * The spring values are what the former `omp-modal-panel` curve felt like;
 * the durations map onto the CSS timings they replace (120 ms hover, 200 ms
 * slide-in, 200–300 ms panel). Nothing here is decorative: every component
 * that moves imports from here instead of inventing its own numbers.
 */

export const SPRING_SNAPPY = { type: "spring", stiffness: 420, damping: 32 } as const;
export const SPRING_SOFT = { type: "spring", stiffness: 260, damping: 26 } as const;

/** The 120 ms hover/tap rhythm of the old `.omp-press` transition. */
export const DURATION_FAST = 0.12;
/** The 200 ms entrance of `.omp-slide-in-*`. */
export const DURATION_BASE = 0.2;
/** The 200–300 ms panel transitions; the slow end of that range. */
export const DURATION_PANEL = 0.28;

/** The easing the modal scale-in used, kept so the panel keeps its character. */
export const EASE_POP = [0.2, 0.8, 0.3, 1] as const;

/**
 * The whole shimmer cycle, in seconds: one run of the band plus its rest.
 *
 * It is deliberately the *cycle* and not the run, so that the split stays a
 * share of one number rather than a second constant that has to be kept in
 * step. `@keyframes omp-shimmer-wash` spends the first 75% travelling and holds
 * the last 25% with the band parked off the element — at 1.6s that is a 1.2s
 * run and a 0.4s rest. The rest is why a wash reads as a pass that finished
 * instead of motion that circles forever; changing this number changes both
 * halves together, which is what you want when retuning the rhythm.
 */
export const SHIMMER_DURATION = 1.6;

/**
 * The one-shot wash played when a panel pops up. Longer than the entrance
 * itself (0.24 s) so the band is still travelling while the panel settles,
 * which is what reads as "it arrived" rather than "it appeared".
 */
export const SWEEP_DURATION = 0.72;

/** A full turn. Spinners and gear icons share this so they stay in step. */
export const SPIN_TRANSITION = { repeat: Infinity, duration: 0.8, ease: "linear" } as const;

/** The breathing opacity that stood for "working". */
export const PULSE_TRANSITION = { duration: 1.5, repeat: Infinity, ease: "easeInOut" } as const;