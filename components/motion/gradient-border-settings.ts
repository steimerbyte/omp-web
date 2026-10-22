/**
 * The gradient border around the chat input, as plain data.
 *
 * This is deliberately free of React and of the JSX so the store rules can be
 * tested directly instead of inferred from component source. The React binding
 * lives in `GradientBorder.tsx`, the same split as `animation-mode.ts` and
 * `AnimationProvider.tsx`.
 *
 * The values are a surface preference with no server side, so they live in
 * `localStorage` under `omp-gradient-border`: the same line as
 * `omp-sound-enabled` and `omp-theme`, and deliberately NOT a `/api/settings`
 * key, because that route projects a schema out of the pinned
 * `@oh-my-pi/pi-coding-agent` for a value the server never reads.
 *
 * Every number in this file is asserted by `gradient-border-settings.test.mjs`.
 */

export const GRADIENT_BORDER_STORAGE_KEY = "omp-gradient-border";

/**
 * How the gradient turns.
 *
 * `angle` animates the cone's start angle through a registered custom
 * property. `rotate` turns a separate square layer that carries the very same
 * gradient, which works in every browser that knows `conic-gradient` — and in
 * a browser that cannot animate a custom property it is the only variant left.
 */
export type GradientBorderVariant = "angle" | "rotate";

export type GradientBorderColors = [string, string, string, string];

export interface GradientBorderSettings {
  /** Whether the border is painted at all. */
  enabled: boolean;
  /** The four colours of the cone, clockwise. */
  colors: GradientBorderColors;
  /** How thick the ring is, in CSS pixels. */
  borderWidthPx: number;
  /** How long one turn takes, in milliseconds. */
  spinDurationMs: number;
  /** Whether the soft halo under the ring is painted. */
  glowEnabled: boolean;
  /** How strong that halo is. */
  glowOpacity: number;
  /** How far that halo reaches beyond the ring, in CSS pixels. */
  glowSpreadPx: number;
  /** How far that halo is blurred. */
  glowBlurPx: number;
  /** Which of the two rotation variants is preferred. */
  variant: GradientBorderVariant;
}

export const GRADIENT_BORDER_PRESET_IDS = ["omphie", "omphieLight", "cool", "warning", "mono"] as const;
export type GradientBorderPresetId = (typeof GRADIENT_BORDER_PRESET_IDS)[number];

export const GRADIENT_BORDER_PRESETS: Record<GradientBorderPresetId, GradientBorderColors> = {
  omphie: ["#ffb347", "#00ff88", "#00b4ff", "#a78bfa"],
  // The same hues with enough depth to read as a line on a white surface.
  // The contrast against white is measured, not guessed: the four colours
  // reach 3.19:1 at the weakest and 5.70:1 at the strongest, and they keep
  // 3.11:1 against the dark surface of the app.
  omphieLight: ["#16a34a", "#d97706", "#0284c7", "#7c3aed"],
  cool: ["#4f8cff", "#00d4ff", "#6366f1", "#a78bfa"],
  warning: ["#d4c090", "#ffb347", "#ff7a45", "#ff4757"],
  mono: ["#e8ecf4", "#9ca3b0", "#6b7280", "#00b4ff"],
};

export const DEFAULT_GRADIENT_BORDER_SETTINGS: GradientBorderSettings = {
  enabled: false,
  colors: [...GRADIENT_BORDER_PRESETS.omphie],
  borderWidthPx: 6,
  spinDurationMs: 2400,
  glowEnabled: true,
  glowOpacity: 0.25,
  glowSpreadPx: 3,
  glowBlurPx: 4,
  variant: "angle",
};

/**
 * The range every number is clamped into. The panel offers the same ranges,
 * and a hand-edited `localStorage` entry cannot push the ring out of the
 * layout with them.
 */
export const GRADIENT_BORDER_LIMITS = {
  borderWidthPx: { min: 0, max: 8 },
  spinDurationMs: { min: 600, max: 6000 },
  glowOpacity: { min: 0, max: 1 },
  glowSpreadPx: { min: 0, max: 24 },
  glowBlurPx: { min: 0, max: 24 },
} as const;

/**
 * The geometry of the ring, in pixels.
 *
 * The ring is a band around the bar that must not eat into the padding the
 * content lives in, at no width. The containing block of an absolutely
 * positioned layer is the PADDING box of its positioned ancestor, and the
 * bar's border is one pixel, so the bar's padding box starts one pixel
 * inside the bar's border box.
 *
 * `inset: -O` puts the layer's border box O pixels outside the bar's padding
 * box, so it starts at 1 - O in the bar's border box. `padding: P` puts the
 * layer's padding box P pixels inside that, so it starts at 1 - O + P. The
 * gradient is clipped to the border box, the solid cover to the padding box,
 * and what is left between them is the ring.
 *
 * With O = P = W + 1 the band runs from 1 - (W + 1) to 1:
 *
 *   W = 2  ->  from -2 to 1: two pixels outside the bar's border box, over
 *              its one pixel border, and not one pixel into the padding.
 *   W = 6  ->  from -6 to 1: six pixels outside, over the border, and not
 *              one pixel into the padding.
 *
 * The bar's border is one pixel wide, so the ring covers it exactly and the
 * content keeps every pixel of its padding. The offsets are written down as
 * custom properties, so the stylesheet and this rule cannot drift apart.
 */
export function gradientBorderRingGeometry(widthPx: number): {
  insetPx: number;
  paddingPx: number;
  outerEdgePx: number;
  innerEdgePx: number;
  eatsPaddingPx: number;
} {
  const width = Math.max(0, widthPx);
  const offset = width + 1;
  return {
    insetPx: -offset,
    paddingPx: offset,
    outerEdgePx: 1 - offset,
    innerEdgePx: 1,
    eatsPaddingPx: 0,
  };
}

/**
 * How far the halo reaches beyond the ring.
 *
 * A halo that lies inside the ring is not a halo but a smear, so the spread
 * is derived from the width of the ring: the ring ends `borderWidthPx` pixels
 * beyond the bar's border box, and the halo has to start further out than
 * that. What is left is the base distance, which is the part the user can
 * still feel.
 */
export function gradientBorderGlowSpread(borderWidthPx: number, baseSpreadPx: number): number {
  return Math.max(0, borderWidthPx) + 1 + Math.max(0, baseSpreadPx);
}

export function defaultGradientBorderSettings(): GradientBorderSettings {
  return { ...DEFAULT_GRADIENT_BORDER_SETTINGS, colors: [...DEFAULT_GRADIENT_BORDER_SETTINGS.colors] };
}

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

export function isGradientBorderPresetId(value: unknown): value is GradientBorderPresetId {
  return typeof value === "string" && (GRADIENT_BORDER_PRESET_IDS as readonly string[]).includes(value);
}

/**
 * A number that is inside the range the panel offers.
 *
 * A value that is not a number at all falls back to the default instead of
 * becoming `NaN`, which would poison the custom property it is written into.
 */
function clampLimit(value: unknown, limit: { min: number; max: number }, fallback: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(limit.max, Math.max(limit.min, numeric));
}

/**
 * Read the settings out of whatever is in storage.
 *
 * A value that is not a known shape falls back to the default instead of
 * throwing: the border is cosmetic, and a throw here would take the whole
 * composer down with it.
 */
export function parseGradientBorderSettings(raw: unknown): GradientBorderSettings {
  const fallback = defaultGradientBorderSettings();
  if (typeof raw !== "string") return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;

  const source = parsed as Record<string, unknown>;
  const colors: GradientBorderColors =
    Array.isArray(source.colors) &&
    source.colors.length === 4 &&
    source.colors.every((entry) => isHexColor(entry))
      ? ([...source.colors] as GradientBorderColors)
      : fallback.colors;

  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : fallback.enabled,
    colors,
    borderWidthPx: clampLimit(source.borderWidthPx, GRADIENT_BORDER_LIMITS.borderWidthPx, fallback.borderWidthPx),
    spinDurationMs: clampLimit(source.spinDurationMs, GRADIENT_BORDER_LIMITS.spinDurationMs, fallback.spinDurationMs),
    glowEnabled: typeof source.glowEnabled === "boolean" ? source.glowEnabled : fallback.glowEnabled,
    glowOpacity: clampLimit(source.glowOpacity, GRADIENT_BORDER_LIMITS.glowOpacity, fallback.glowOpacity),
    glowSpreadPx: clampLimit(source.glowSpreadPx, GRADIENT_BORDER_LIMITS.glowSpreadPx, fallback.glowSpreadPx),
    glowBlurPx: clampLimit(source.glowBlurPx, GRADIENT_BORDER_LIMITS.glowBlurPx, fallback.glowBlurPx),
    variant: source.variant === "rotate" ? "rotate" : "angle",
  };
}

export function readStoredGradientBorderSettings(): GradientBorderSettings {
  if (typeof window === "undefined") return defaultGradientBorderSettings();
  try {
    return parseGradientBorderSettings(window.localStorage.getItem(GRADIENT_BORDER_STORAGE_KEY));
  } catch {
    // Blocked storage or private mode. The border is cosmetic, so the default
    // is a fine answer and a throw here would take the whole surface down.
    return defaultGradientBorderSettings();
  }
}

export function writeStoredGradientBorderSettings(settings: GradientBorderSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(GRADIENT_BORDER_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // A failed write must not empty the surface. The border still applies, it
    // just does not survive a reload.
  }
}

/**
 * The settings as the custom properties the CSS in `app/globals.css` reads.
 *
 * The colours travel as the values they are — no literal is written into the
 * stylesheet, because a literal there would survive a theme import as the
 * wrong hue.
 */
export function gradientBorderCssVariables(settings: GradientBorderSettings): Record<string, string> {
  const geometry = gradientBorderRingGeometry(settings.borderWidthPx);
  return {
    "--omp-gradient-c1": settings.colors[0],
    "--omp-gradient-c2": settings.colors[1],
    "--omp-gradient-c3": settings.colors[2],
    "--omp-gradient-c4": settings.colors[3],
    "--omp-gradient-width": `${settings.borderWidthPx}px`,
    "--omp-gradient-duration": `${settings.spinDurationMs}ms`,
    "--omp-gradient-ring-inset": `${geometry.insetPx}px`,
    "--omp-gradient-ring-padding": `${geometry.paddingPx}px`,
    "--omp-gradient-glow-opacity": settings.glowEnabled ? String(settings.glowOpacity) : "0",
    "--omp-gradient-glow-spread": `${gradientBorderGlowSpread(settings.borderWidthPx, settings.glowSpreadPx)}px`,
    "--omp-gradient-glow-blur": `${settings.glowBlurPx}px`,
  };
}

/**
 * Which variant actually runs.
 *
 * A browser that cannot animate a registered custom property would show a
 * gradient that jumps instead of turning, so the layer variant takes over
 * there — whether the user picked it or not. The panel says so.
 */
export function resolveGradientBorderVariant(
  preferred: GradientBorderVariant,
  supportsAnimatableAngle: boolean,
): GradientBorderVariant {
  return supportsAnimatableAngle ? preferred : "rotate";
}

export interface GradientBorderPropertyDescriptor {
  name: string;
  syntax: string;
  inherits: boolean;
  initialValue?: string;
}

export interface GradientBorderCssApi {
  supports?: (property: string, value: string) => boolean;
  registerProperty?: (descriptor: GradientBorderPropertyDescriptor) => void;
}

export interface GradientBorderCapabilities {
  /** Whether the browser can paint a cone at all. */
  conicGradient: boolean;
  /** Whether the browser can animate a registered custom property. */
  animatableAngle: boolean;
}

/**
 * The browser's own `CSS` object.
 *
 * It is read through `Reflect` because `CSS` is a namespace in the DOM lib and
 * a plain object in a browser, and it is not there at all under Node. Every
 * member is checked before it is used.
 */
function globalCssApi(): GradientBorderCssApi | null {
  if (typeof globalThis === "undefined") return null;
  const candidate: unknown = Reflect.get(globalThis, "CSS");
  if (!candidate || typeof candidate !== "object") return null;
  const scope = candidate as Partial<GradientBorderCssApi>;
  const api: GradientBorderCssApi = {};
  if (typeof scope.supports === "function") api.supports = scope.supports;
  if (typeof scope.registerProperty === "function") api.registerProperty = scope.registerProperty;
  return api;
}

/**
 * What this browser can do.
 *
 * `registerProperty` is the probe for an animatable custom property: it is
 * the API that registers one, and a browser without it cannot interpolate
 * the cone's angle. The probe registers a property that no rule uses, so it
 * costs nothing but the registration itself.
 */
export function detectGradientBorderCapabilities(css?: GradientBorderCssApi | null): GradientBorderCapabilities {
  const api = css ?? globalCssApi();

  const conicGradient =
    typeof api?.supports === "function"
      ? api.supports("background-image", "conic-gradient(from 0deg,#000,#fff)") === true
      : false;

  let animatableAngle = false;
  if (typeof api?.registerProperty === "function") {
    try {
      api.registerProperty({
        name: "--omp-gradient-probe-angle",
        syntax: "<angle>",
        inherits: false,
        initialValue: "0deg",
      });
      animatableAngle = true;
    } catch {
      // The property is already registered, which means this browser supports
      // registered custom properties. The first run registers it, every later
      // run throws.
      animatableAngle = true;
    }
  }

  return { conicGradient, animatableAngle };
}

/**
 * Which preset the current colours came from, or `null` when they are the
 * user's own.
 */
export function matchGradientBorderPreset(settings: GradientBorderSettings): GradientBorderPresetId | null {
  for (const id of GRADIENT_BORDER_PRESET_IDS) {
    const preset = GRADIENT_BORDER_PRESETS[id];
    if (preset.every((colour, index) => colour.toLowerCase() === settings.colors[index].toLowerCase())) {
      return id;
    }
  }
  return null;
}

/** Whether two sets of settings are the same, so the store can skip a write. */
export function gradientBorderSettingsEqual(a: GradientBorderSettings, b: GradientBorderSettings): boolean {
  return (
    a.enabled === b.enabled &&
    a.borderWidthPx === b.borderWidthPx &&
    a.spinDurationMs === b.spinDurationMs &&
    a.glowEnabled === b.glowEnabled &&
    a.glowOpacity === b.glowOpacity &&
    a.glowSpreadPx === b.glowSpreadPx &&
    a.glowBlurPx === b.glowBlurPx &&
    a.variant === b.variant &&
    a.colors.every((colour, index) => colour.toLowerCase() === b.colors[index].toLowerCase())
  );
}
