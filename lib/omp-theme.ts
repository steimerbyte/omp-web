import {
  getAvailableThemes,
  getResolvedThemeColors,
  getThemeExportColors,
  isLightTheme,
} from "@oh-my-pi/pi-tui/theme";
import { cfgThemeDark, cfgThemeLight } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { Settings } from "@oh-my-pi/pi-coding-agent";
import type { WebThemeConfig, WebThemePalette } from "@/lib/settings-api";

function firstColor(...values: Array<string | undefined>): string {
  return values.find((value) => typeof value === "string" && value.length > 0) ?? "transparent";
}

type Rgb = [red: number, green: number, blue: number];

function parseHex(value: string): Rgb | null {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return null;
  const hex = match[1];
  return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)];
}

function mixHex(from: string, to: string, amount: number): string {
  const fromRgb = parseHex(from);
  const toRgb = parseHex(to);
  if (!fromRgb || !toRgb) return from;
  const mixed = fromRgb.map((channel, index) => Math.round(channel + (toRgb[index] - channel) * amount));
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function relativeLuminance(value: string): number | null {
  const rgb = parseHex(value);
  if (!rgb) return null;
  const [red, green, blue] = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number | null {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  if (foregroundLuminance === null || backgroundLuminance === null) return null;
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function ensureContrast(color: string, target: string, backgrounds: string[], minimum: number): string {
  const hasContrast = (candidate: string) => backgrounds.every((background) => {
    const ratio = contrastRatio(candidate, background);
    return ratio === null || ratio >= minimum;
  });
  if (hasContrast(color)) return color;
  if (!hasContrast(target)) return target;

  let low = 0;
  let high = 1;
  for (let index = 0; index < 12; index += 1) {
    const midpoint = (low + high) / 2;
    if (hasContrast(mixHex(color, target, midpoint))) high = midpoint;
    else low = midpoint;
  }
  return mixHex(color, target, high);
}

/**
 * The app's own palettes, selectable in Settings -> Themes next to omp's.
 *
 * They are the same values as `app/globals.css` (the login page renders before
 * `/api/theme` is asked, so the stylesheet cannot be derived from here), and
 * `lib/omp-theme.unit.test.mjs` compares the two — a drift fails the suite
 * instead of showing up as a login page in another palette.
 */
const APP_THEMES: Record<string, WebThemePalette> = {
  noctalia: {
    name: "noctalia",
    colorScheme: "dark",
    variables: {
      "--bg": "#15162e",
      "--bg-panel": "#20213d",
      "--bg-hover": "#27284a",
      "--bg-selected": "#2e2f58",
      "--border": "#3e4166",
      "--text": "#ece9f4",
      "--text-muted": "#a5a7c6",
      "--text-dim": "#8c8eac",
      "--accent": "#f7e9a8",
      "--accent-fg": "#302c1e",
      "--accent-hover": "#f9f0c2",
      "--user-bg": "#1a1b35",
      "--assistant-bg": "#15162e",
      "--tool-bg": "#171831",
      "--bg-subtle": "rgba(236,233,244,0.06)",
      "--success": "#a0ddc0",
      "--danger": "#ed8296",
      "--warning": "#f4c5a2",
      "--violet": "#b3b8ed",
    },
  },
  "noctalia-light": {
    name: "noctalia-light",
    colorScheme: "light",
    variables: {
      "--bg": "#dcddea",
      "--bg-panel": "#cfd2e4",
      "--bg-hover": "#c2c6dd",
      "--bg-selected": "#b5bad5",
      "--border": "#a4aac9",
      "--text": "#292b45",
      "--text-muted": "#414765",
      "--text-dim": "#505675",
      "--accent": "#5058b1",
      "--accent-fg": "#f0eff7",
      "--accent-hover": "#373b91",
      "--user-bg": "#d5d7e7",
      "--assistant-bg": "#dcddea",
      "--tool-bg": "#cfd2e4",
      "--bg-subtle": "rgba(41,43,69,0.05)",
      "--success": "#4b6056",
      "--danger": "#a53c59",
      "--warning": "#685b1b",
      "--violet": "#555e88",
    },
  },
};

export async function getWebThemePalette(name: string): Promise<WebThemePalette> {
  const appTheme = APP_THEMES[name];
  if (appTheme) return appTheme;
  const [colors, exported] = await Promise.all([
    getResolvedThemeColors(name),
    getThemeExportColors(name),
  ]);
  const colorScheme = isLightTheme(name) ? "light" : "dark";
  const pageBg = firstColor(exported.pageBg, colors.userMessageBg, colorScheme === "light" ? "#ffffff" : "#111318");
  const panelBg = firstColor(exported.cardBg, colors.statusLineBg, colors.toolPendingBg, pageBg);
  const hoverBg = firstColor(colors.borderMuted, colors.border, panelBg);
  const selectedBg = firstColor(colors.selectedBg, colors.borderAccent, hoverBg);
  const text = firstColor(colors.text, colorScheme === "light" ? "#17191d" : "#e5e7eb");
  const rawMuted = firstColor(colors.muted, text);
  const rawDim = firstColor(colors.dim, rawMuted);
  const muted = ensureContrast(rawMuted, text, [pageBg, panelBg], 6);
  const dim = ensureContrast(rawDim, text, [pageBg, panelBg], 5);
  const accent = firstColor(colors.accent, colors.borderAccent, text);

  return {
    name,
    colorScheme,
    variables: {
      "--bg": pageBg,
      "--bg-panel": panelBg,
      "--bg-hover": hoverBg,
      "--bg-selected": selectedBg,
      "--border": firstColor(colors.borderMuted, colors.border, hoverBg),
      "--text": text,
      "--text-muted": muted,
      "--text-dim": dim,
      "--accent": accent,
      "--accent-hover": mixHex(accent, text, 0.16),
      "--user-bg": firstColor(colors.userMessageBg, panelBg),
      "--assistant-bg": pageBg,
      "--tool-bg": firstColor(colors.toolPendingBg, panelBg),
      "--bg-subtle": firstColor(exported.infoBg, colors.customMessageBg, hoverBg),
      "--success": firstColor(colors.success, colors.toolDiffAdded, accent),
      "--danger": firstColor(colors.error, colors.toolDiffRemoved, "#dc2626"),
      "--warning": firstColor(colors.warning, "#d97706"),
      "--omp-md-heading": firstColor(colors.mdHeading, accent),
      "--omp-md-link": firstColor(colors.mdLink, accent),
      "--omp-md-code": firstColor(colors.mdCode, colors.syntaxString, accent),
    },
  };
}

export async function getWebThemeConfig(settings: Settings): Promise<WebThemeConfig> {
  const dark = cfgThemeDark.get(settings) ?? "titanium";
  const light = cfgThemeLight.get(settings) ?? "light";
  const [darkPalette, lightPalette] = await Promise.all([
    getWebThemePalette(dark),
    getWebThemePalette(light),
  ]);
  return {
    names: { dark, light },
    palettes: { dark: darkPalette, light: lightPalette },
  };
}

export async function getAvailableWebThemes(): Promise<Array<{ name: string; colorScheme: "dark" | "light" }>> {
  const names = await getAvailableThemes();
  return [
    ...Object.values(APP_THEMES).map((theme) => ({ name: theme.name, colorScheme: theme.colorScheme })),
    ...names
      .filter((name) => !(name in APP_THEMES))
      .map((name) => ({ name, colorScheme: isLightTheme(name) ? "light" as const : "dark" as const })),
  ];
}
