"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useAnimationPreference } from "./AnimationProvider";
import {
  DEFAULT_GRADIENT_BORDER_SETTINGS,
  detectGradientBorderCapabilities,
  gradientBorderCssVariables,
  gradientBorderSettingsEqual,
  readStoredGradientBorderSettings,
  resolveGradientBorderVariant,
  writeStoredGradientBorderSettings,
} from "./gradient-border-settings";
import type {
  GradientBorderCapabilities,
  GradientBorderSettings,
  GradientBorderVariant,
} from "./gradient-border-settings";
import type { CSSProperties } from "react";

/**
 * The gradient border around the chat input — the React binding.
 *
 * The rules live in `gradient-border-settings.ts` and carry no React, so they
 * can be tested directly; this file is the store and the hook, the same split
 * as `animation-mode.ts` and `AnimationProvider.tsx`.
 *
 * The store follows the `useSyncExternalStore` shape of
 * `hooks/useDisplaySettings.ts`. `getServerSnapshot` reports the default so the
 * server render and the first client render agree; the stored value is applied
 * in an effect right after, which never produces a hydration mismatch.
 *
 * The mode is asked for explicitly, because `MotionConfig` does not cover a
 * CSS animation: it is consulted for the animations motion owns. A border that
 * keeps turning while the setting says "Off" would be exactly the defect
 * `Pressable` and `Spin` guard against.
 */

const listeners = new Set<() => void>();
let state: GradientBorderSettings = DEFAULT_GRADIENT_BORDER_SETTINGS;

function emit(): void {
  listeners.forEach((cb) => cb());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): GradientBorderSettings {
  return state;
}

function getServerSnapshot(): GradientBorderSettings {
  return DEFAULT_GRADIENT_BORDER_SETTINGS;
}

export function setGradientBorderSettings(next: GradientBorderSettings): void {
  writeStoredGradientBorderSettings(next);
  if (gradientBorderSettingsEqual(state, next)) return;
  state = next;
  emit();
}

export function updateGradientBorderSettings(patch: Partial<GradientBorderSettings>): void {
  setGradientBorderSettings({ ...state, ...patch });
}

/** Read the current values. Every consumer re-renders when they change. */
export function useGradientBorderSettings(): GradientBorderSettings {
  const settings = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    const stored = readStoredGradientBorderSettings();
    if (gradientBorderSettingsEqual(state, stored)) return;
    state = stored;
    emit();
  }, []);

  return settings;
}

/**
 * What this browser can do.
 *
 * The probe needs a real browser, so it runs in an effect: the server render
 * and the first client render both report the optimistic answer, and the
 * browser corrects it a tick later. A browser that cannot animate a custom
 * property is corrected to the layer variant there and then.
 */
export function useGradientBorderCapabilities(): GradientBorderCapabilities {
  const [capabilities, setCapabilities] = useState<GradientBorderCapabilities | null>(null);

  useEffect(() => {
    setCapabilities(detectGradientBorderCapabilities());
  }, []);

  return capabilities ?? { conicGradient: true, animatableAngle: true };
}

export interface GradientBorderState {
  settings: GradientBorderSettings;
  /** The variant that actually runs. */
  variant: GradientBorderVariant;
  /** Whether the browser forced the layer variant because it cannot animate an angle. */
  forced: boolean;
  capabilities: GradientBorderCapabilities;
  update: (patch: Partial<GradientBorderSettings>) => void;
}

export function useGradientBorderState(): GradientBorderState {
  const settings = useGradientBorderSettings();
  const capabilities = useGradientBorderCapabilities();
  const variant = resolveGradientBorderVariant(settings.variant, capabilities.animatableAngle);

  return {
    settings,
    variant,
    forced: !capabilities.animatableAngle && settings.variant !== variant,
    capabilities,
    update: updateGradientBorderSettings,
  };
}

export interface GradientBorderBar {
  /** The classes the bar carries. Empty when the border is not painted. */
  className: string;
  /** The custom properties the CSS reads. */
  style: CSSProperties;
  /** Whether the ring is painted at all. */
  active: boolean;
  /** Which of the two rotation variants runs. */
  variant: GradientBorderVariant;
}

export interface GradientBorderBarOptions {
  /** Whether an agent is working right now. */
  running: boolean;
  /** Whether the bar must not carry the border at all. */
  suppressed?: boolean;
}

/**
 * What the chat input bar needs to know.
 *
 * The ring is a ring, not a frame: it is drawn over the border box of the bar
 * and the interior is painted back over, so the bar keeps its own padding and
 * its own size. Nothing here changes a box — the border stays, it only loses
 * its colour while the gradient covers it.
 */
export function useGradientBorderBar({ running, suppressed }: GradientBorderBarOptions): GradientBorderBar {
  const { settings, variant, capabilities } = useGradientBorderState();
  const mode = useAnimationPreference();

  // Without a cone there is no ring, and the bar would be left with the
  // transparent border of a ring that is never painted. So the whole effect
  // waits for a browser that can paint one.
  const active =
    running &&
    !suppressed &&
    settings.enabled &&
    mode !== "off" &&
    capabilities.conicGradient &&
    settings.borderWidthPx > 0;

  const style = useMemo(
    () => gradientBorderCssVariables(settings) as CSSProperties,
    [settings],
  );

  const className = active
    ? variant === "rotate"
      ? "omp-gradient-border is-running omp-gradient-rotate"
      : "omp-gradient-border is-running"
    : "";

  return { className, style, active, variant };
}
