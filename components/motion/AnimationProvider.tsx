"use client";

import { useEffect, useSyncExternalStore } from "react";
import { MotionConfig } from "motion/react";
import {
  ANIMATION_DATASET_KEY,
  ANIMATION_STORAGE_KEY,
  DEFAULT_ANIMATION_MODE,
  isAnimationMode,
  motionConfigFor,
  readStoredAnimationMode,
} from "./animation-mode";
import type { AnimationMode } from "./animation-mode";
import type { ReactNode } from "react";

export type { AnimationMode };
export { ANIMATION_STORAGE_KEY, ANIMATION_DATASET_KEY };

/**
 * The single animation switch for the whole surface.
 *
 * `full` runs everything, `reduced` hands the decision to the OS
 * (`prefers-reduced-motion`), `off` stands still regardless of the OS. The
 * value lives in `localStorage` because it is a pure surface preference with
 * no server side — the same line as `omp-sound-enabled` and the theme choice.
 * It is deliberately NOT a `/api/settings` key: that route projects a schema
 * out of the pinned `@oh-my-pi/pi-coding-agent` package, so a new path there
 * would mean patching a foreign dependency.
 *
 * The store follows the `useSyncExternalStore` shape of
 * `hooks/useDisplaySettings.ts`. `getServerSnapshot` reports the default so
 * the server render and the first client render agree; the stored value is
 * applied in an effect right after, which never produces a hydration mismatch.
 */

const listeners = new Set<() => void>();
let state: AnimationMode = DEFAULT_ANIMATION_MODE;

function emit(): void {
  listeners.forEach((cb) => cb());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): AnimationMode {
  return state;
}

function getServerSnapshot(): AnimationMode {
  return DEFAULT_ANIMATION_MODE;
}

/**
 * Publish the mode on the document element too, so the CSS escape hatch in
 * `globals.css` can stop what motion does not cover (the panel-width
 * transitions, the login CSS module, inline `transition:` strings).
 */
function applyToDocument(mode: AnimationMode): void {
  document.documentElement.dataset.ompAnimations = mode;
}

export function setAnimationMode(mode: AnimationMode): void {
  if (!isAnimationMode(mode)) return;
  try {
    window.localStorage.setItem(ANIMATION_STORAGE_KEY, mode);
  } catch {
    // A failed write must not empty the surface. The mode still applies below,
    // it just will not survive a reload.
  }
  if (state === mode) return;
  state = mode;
  applyToDocument(mode);
  emit();
}

export function useAnimationPreference(): AnimationMode {
  const mode = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    const stored = readStoredAnimationMode();
    applyToDocument(stored);
    if (stored === state) return;
    state = stored;
    emit();
  }, []);

  return mode;
}

export function AnimationProvider({ children }: { children: ReactNode }) {
  const mode = useAnimationPreference();

  return <MotionConfig reducedMotion={motionConfigFor(mode)}>{children}</MotionConfig>;
}