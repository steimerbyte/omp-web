"use client";

import { useEffect, useState } from "react";
import { CwdPicker } from "./CwdPicker";
import { useI18n } from "@/hooks/useI18n";
import { useScheduledSettings } from "@/hooks/useScheduledSettings";
import styles from "./SettingsConfig.module.css";

/**
 * Einstellungen → Geplante Aufgaben: der Standard-Arbeitsordner des Kontos.
 *
 * Eine Einstellung, ein Knopf. Kein automatisches Speichern wie bei den Quick
 * Phrases: der Ordner wird geprueft (existiert, ist ein Verzeichnis, liegt im
 * Konto), und eine Pruefung bei jedem Tastendruck waere eine Anfrage pro
 * Buchstaben mit einem Fehler mittendrin. Der Nutzer drueckt "Ordner
 * speichern", und der Server antwortet mit dem, was gilt.
 *
 * Der Leerwert ist ein *ausdruecklicher* Wert und nicht "nichts gesetzt": die
 * Beschriftung sagt "Dein Heimatverzeichnis", damit klar ist, wohin der Lauf
 * dann geht. Das ist der Punkt, an dem eine leere Einstellung sonst wie eine
 * kaputte aussieht.
 */
export function ScheduledTasksSettings() {
  const { t } = useI18n();
  const { settings, error, save } = useScheduledSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Erst nach der ersten Befuellung gehoert das Feld dem Benutzer: sonst
  // ueberschriebe ein spaeter eintreffender Ladevorgang die Eingabe.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (hydrated || settings === null) return;
    setDraft(settings.defaultCwd);
    setHydrated(true);
  }, [settings, hydrated]);

  const handleSave = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await save(draft);
      setMessage(t("settings.scheduledSaved"));
    } catch (cause) {
      setMessage(`${t("settings.scheduledSaveFailed")} ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h2 className={styles.contentTitle}>{t("settings.scheduled")}</h2>
      <p className={styles.contentDescription}>{t("settings.scheduledDescription")}</p>
      {error ? (
        <p style={{ margin: "0 0 12px", color: "var(--danger)" }} role="alert">
          {t("settings.scheduledLoadFailed")}
        </p>
      ) : null}
      <label
        htmlFor="settings-scheduled-cwd"
        className={styles.phraseFieldLabel}
        style={{ display: "block", marginBottom: 6 }}
      >
        {t("settings.scheduledDefaultCwd")}
      </label>
      <CwdPicker
        id="settings-scheduled-cwd"
        value={draft}
        home={settings?.home ?? ""}
        folders={settings?.folders ?? []}
        inheritLabel={t("settings.scheduledInherit")}
        onChange={(next) => { setDraft(next); setMessage(null); }}
        disabled={busy}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
        <button type="button" className={styles.addPhrase} disabled={busy || !hydrated} onClick={() => void handleSave()}>
          {busy ? t("settings.scheduledSaving") : t("settings.scheduledSave")}
        </button>
        {message ? <span style={{ fontSize: 12, color: "var(--text-muted)" }} role="status">{message}</span> : null}
      </div>
    </div>
  );
}
