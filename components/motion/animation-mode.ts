/**
 * The animation preference, as plain data.
 *
 * This is deliberately free of React and of the JSX so the store rules can be
 * tested directly instead of inferred from component source. The React
 * binding lives in `AnimationProvider.tsx`.
 */

export type AnimationMode = "full" | "reduced" | "off";

export const ANIMATION_STORAGE_KEY = "omp-animations";
export const ANIMATION_DATASET_KEY = "ompAnimations";
export const DEFAULT_ANIMATION_MODE: AnimationMode = "full";

const MODES: Record<string, true> = { full: true, reduced: true, off: true };

export function isAnimationMode(value: unknown): value is AnimationMode {
  return typeof value === "string" && value in MODES;
}

/**
 * A stored value that is not one of the three modes is not a mode. Falling
 * back to the default keeps a stale or hand-edited entry from leaving the
 * surface in an unnamed state.
 */
export function parseAnimationMode(raw: unknown): AnimationMode {
  return isAnimationMode(raw) ? raw : DEFAULT_ANIMATION_MODE;
}

export function readStoredAnimationMode(): AnimationMode {
  if (typeof window === "undefined") return DEFAULT_ANIMATION_MODE;
  try {
    return parseAnimationMode(window.localStorage.getItem(ANIMATION_STORAGE_KEY));
  } catch {
    // Blocked storage or private mode. Animations are cosmetic, so the default
    // is a fine answer and a throw here would take the whole surface down.
    return DEFAULT_ANIMATION_MODE;
  }
}

/**
 * `MotionConfig` takes "always" to stand still and "user" to defer to the OS,
 * so "reduced" and "full" share the same value on purpose: the difference
 * between them is handled by the operating system, not by us.
 */
export function motionConfigFor(mode: AnimationMode): "always" | "user" {
  return mode === "off" ? "always" : "user";
}