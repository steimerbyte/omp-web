"use client";

import { useAnimationPreference, setAnimationMode } from "./motion/AnimationProvider";
import type { AnimationMode } from "./motion/AnimationProvider";
import styles from "./SettingsConfig.module.css";

/**
 * The global animation intensity.
 *
 * A pure surface preference with no server side, so it lives in `localStorage`
 * under `omp-animations` — the same line as `omp-sound-enabled` and the theme
 * choice. It deliberately does NOT go through `/api/settings`: that route
 * projects a schema out of the pinned `@oh-my-pi/pi-coding-agent` package, so a
 * new path there would mean patching a foreign dependency for a value the
 * server never reads.
 *
 * `setAnimationMode` writes the DOM attribute as well as storage, so the change
 * lands without a reload.
 */

const OPTIONS: Array<{ mode: AnimationMode; label: string; description: string }> = [
  {
    mode: "full",
    label: "Full",
    description: "Every transition runs. Honours the system setting only where the browser enforces it.",
  },
  {
    mode: "reduced",
    label: "Reduced",
    description: "Follows the operating system. Transform and layout animation is dropped, fades stay.",
  },
  {
    mode: "off",
    label: "Off",
    description: "Nothing moves. Layout is identical, panels and loaders switch instantly.",
  },
];

export function AnimationsConfig() {
  const mode = useAnimationPreference();

  return (
    <div className={styles.scrollContent}>
      <header className={styles.contentHeader}>
        <h2 className={styles.contentTitle}>Animations</h2>
        <p className={styles.contentDescription}>
          Controls every moving surface: panel entrances, the shimmer on loading states, spinners
          and the press feedback on buttons. Stored in this browser only.
        </p>
      </header>
      <div className={styles.settingsBody}>
        <div className={styles.group}>
          {OPTIONS.map((option) => (
            <div className={styles.settingRow} key={option.mode}>
              <div>
                <div className={styles.settingLabel}>{option.label}</div>
                <div className={styles.settingDescription}>{option.description}</div>
              </div>
              <div className={styles.settingControl}>
                <input
                  type="radio"
                  name="omp-animations"
                  aria-label={option.label}
                  checked={mode === option.mode}
                  onChange={() => setAnimationMode(option.mode)}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}