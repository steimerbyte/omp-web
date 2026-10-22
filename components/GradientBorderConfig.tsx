"use client";

import { useI18n } from "@/hooks/useI18n";
import {
  GRADIENT_BORDER_PRESETS,
  GRADIENT_BORDER_PRESET_IDS,
  matchGradientBorderPreset,
} from "@/components/motion/gradient-border-settings";
import { useGradientBorderState } from "@/components/motion/GradientBorder";
import type { GradientBorderPresetId } from "@/components/motion/gradient-border-settings";
import styles from "./SettingsConfig.module.css";

/**
 * The gradient border around the chat input.
 *
 * A pure surface preference with no server side, so it lives in `localStorage`
 * under `omp-gradient-border` — the same line as `omp-sound-enabled` and
 * `omp-theme`. It deliberately does NOT go through `/api/settings`: that route
 * projects a schema out of the pinned `@oh-my-pi/pi-coding-agent` package, so a
 * new path there would mean patching a foreign dependency for a value the
 * server never reads.
 *
 * The bar reads the same store, so a change lands without a reload.
 */

const PRESET_LABEL_KEYS: Record<GradientBorderPresetId, string> = {
  omphie: "settings.gradientBorderPresetOmphie",
  omphieLight: "settings.gradientBorderPresetOmphieLight",
  cool: "settings.gradientBorderPresetCool",
  warning: "settings.gradientBorderPresetWarning",
  mono: "settings.gradientBorderPresetMono",
};

const COLOR_LABEL_KEYS = [
  "settings.gradientBorderColor1",
  "settings.gradientBorderColor2",
  "settings.gradientBorderColor3",
  "settings.gradientBorderColor4",
];

export function GradientBorderConfig() {
  const { t } = useI18n();
  const { settings, variant, forced, update } = useGradientBorderState();
  const activePreset = matchGradientBorderPreset(settings);

  return (
    <div className={styles.group}>
      <div className={styles.groupTitle}>{t("settings.gradientBorder")}</div>

      <div className={styles.settingRow}>
        <div>
          <div className={styles.settingLabel}>{t("settings.gradientBorderEnabled")}</div>
          <div className={styles.settingDescription}>{t("settings.gradientBorderEnabledDescription")}</div>
        </div>
        <div className={styles.settingControl}>
          <button
            type="button"
            className={styles.switch}
            data-on={settings.enabled}
            aria-pressed={settings.enabled}
            onClick={() => update({ enabled: !settings.enabled })}
          />
        </div>
      </div>

      <div className={styles.settingRow}>
        <div>
          <div className={styles.settingLabel}>{t("settings.gradientBorderPresets")}</div>
          <div className={styles.settingDescription}>{t("settings.gradientBorderPresetsDescription")}</div>
        </div>
        <div className={styles.settingControl}>
          <div className={styles.multiSelect}>
            {GRADIENT_BORDER_PRESET_IDS.map((id) => (
              <span key={id} className={styles.choice} data-selected={activePreset === id}>
                <button
                  type="button"
                  className={styles.choiceToggle}
                  onClick={() => update({ colors: [...GRADIENT_BORDER_PRESETS[id]] })}
                >
                  <span className={styles.gradientPresetSwatch} aria-hidden="true">
                    {GRADIENT_BORDER_PRESETS[id].map((colour) => (
                      <span key={colour} style={{ background: colour }} />
                    ))}
                  </span>
                  {t(PRESET_LABEL_KEYS[id])}
                </button>
              </span>
            ))}
            {activePreset === null && (
              <span className={styles.choice} data-selected="true">
                <span className={styles.choiceToggle}>{t("settings.gradientBorderPresetCustom")}</span>
              </span>
            )}
          </div>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div>
          <div className={styles.settingLabel}>{t("settings.gradientBorderColors")}</div>
          <div className={styles.settingDescription}>{t("settings.gradientBorderColorsDescription")}</div>
        </div>
        <div className={styles.settingControl}>
          <div className={styles.gradientColors}>
            {settings.colors.map((colour, index) => (
              <input
                key={COLOR_LABEL_KEYS[index]}
                type="color"
                className={styles.gradientColorInput}
                value={colour}
                aria-label={t(COLOR_LABEL_KEYS[index])}
                onChange={(event) => {
                  const colors = [...settings.colors] as typeof settings.colors;
                  colors[index] = event.target.value;
                  update({ colors });
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div>
          <div className={styles.settingLabel}>{t("settings.gradientBorderWidth")}</div>
          <div className={styles.settingDescription}>{t("settings.gradientBorderWidthDescription")}</div>
        </div>
        <div className={styles.settingControl}>
          <div className={styles.gradientSliderRow}>
            <input
              type="range"
              className={styles.gradientSlider}
              min={0}
              max={8}
              step={1}
              value={settings.borderWidthPx}
              aria-label={t("settings.gradientBorderWidth")}
              onChange={(event) => update({ borderWidthPx: Number(event.target.value) })}
            />
            <span className={styles.gradientValue}>{settings.borderWidthPx}px</span>
          </div>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div>
          <div className={styles.settingLabel}>{t("settings.gradientBorderDuration")}</div>
          <div className={styles.settingDescription}>{t("settings.gradientBorderDurationDescription")}</div>
        </div>
        <div className={styles.settingControl}>
          <div className={styles.gradientSliderRow}>
            <input
              type="range"
              className={styles.gradientSlider}
              min={0.6}
              max={6}
              step={0.1}
              value={settings.spinDurationMs / 1000}
              aria-label={t("settings.gradientBorderDuration")}
              onChange={(event) => update({ spinDurationMs: Math.round(Number(event.target.value) * 1000) })}
            />
            <span className={styles.gradientValue}>{(settings.spinDurationMs / 1000).toFixed(1)}s</span>
          </div>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div>
          <div className={styles.settingLabel}>{t("settings.gradientBorderGlow")}</div>
          <div className={styles.settingDescription}>{t("settings.gradientBorderGlowDescription")}</div>
        </div>
        <div className={styles.settingControl}>
          <button
            type="button"
            className={styles.switch}
            data-on={settings.glowEnabled}
            aria-pressed={settings.glowEnabled}
            onClick={() => update({ glowEnabled: !settings.glowEnabled })}
          />
        </div>
      </div>

      <div className={styles.settingRow}>
        <div>
          <div className={styles.settingLabel}>{t("settings.gradientBorderGlowOpacity")}</div>
          <div className={styles.settingDescription}>{t("settings.gradientBorderGlowOpacityDescription")}</div>
        </div>
        <div className={styles.settingControl}>
          <div className={styles.gradientSliderRow}>
            <input
              type="range"
              className={styles.gradientSlider}
              min={0}
              max={1}
              step={0.05}
              value={settings.glowOpacity}
              aria-label={t("settings.gradientBorderGlowOpacity")}
              onChange={(event) => update({ glowOpacity: Number(event.target.value) })}
            />
            <span className={styles.gradientValue}>{settings.glowOpacity.toFixed(2)}</span>
          </div>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div>
          <div className={styles.settingLabel}>{t("settings.gradientBorderVariant")}</div>
          <div className={styles.settingDescription}>{t("settings.gradientBorderVariantDescription")}</div>
          {forced && <div className={styles.gradientNote}>{t("settings.gradientBorderVariantForced")}</div>}
        </div>
        <div className={styles.settingControl}>
          <div className={styles.multiSelect}>
            <span className={styles.choice} data-selected={variant === "angle"}>
              <button
                type="button"
                className={styles.choiceToggle}
                onClick={() => update({ variant: "angle" })}
              >
                {t("settings.gradientBorderVariantAngle")}
              </button>
            </span>
            <span className={styles.choice} data-selected={variant === "rotate"}>
              <button
                type="button"
                className={styles.choiceToggle}
                onClick={() => update({ variant: "rotate" })}
              >
                {t("settings.gradientBorderVariantRotate")}
              </button>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
