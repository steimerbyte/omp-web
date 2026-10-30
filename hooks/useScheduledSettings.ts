"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Der Standard-Arbeitsordner des Kontos: laden und setzen.
 *
 * Ein eigener Hook und kein Teil von `useScheduledTasks`: der Standardordner
 * gilt auch ohne eine einzige Aufgabe, und die Aufgabenansicht hat mit ihm
 * nichts zu tun. Dieselbe Aufteilung wie bei `useQuickPhrases` — der Wert
 * gehoert einem Formular, nicht der Liste.
 *
 * Gelesen wird die Ordnerliste aus **derselben** Antwort (`folders`): der
 * Dialog und die Einstellungen brauchen dieselben Auswahlmoeglichkeiten, und
 * zwei Aufrufe von `/api/projects` waeren zwei Listen, die auseinanderlaufen
 * koennen.
 */
export interface ScheduledSettings {
  /** Absolut und innerhalb des Kontos, oder `null` fuer "Home des Kontos". */
  defaultCwd: string | null;
  /** Die Home des Kontos — das Ziel, wenn `defaultCwd` `null` ist. */
  home: string;
  /** Die waehlbaren Ordner: Home und das Projektregister des Kontos. */
  folders: string[];
}

interface SettingsResponse extends Partial<ScheduledSettings> {
  error?: string;
  field?: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as SettingsResponse;
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function useScheduledSettings(): {
  settings: ScheduledSettings | null;
  error: boolean;
  reload: () => Promise<void>;
  save: (defaultCwd: string | null) => Promise<void>;
} {
  const [settings, setSettings] = useState<ScheduledSettings | null>(null);
  const [error, setError] = useState(false);

  const reload = useCallback(async () => {
    try {
      const body = await request<SettingsResponse>("/api/scheduled-settings");
      setSettings({
        defaultCwd: body.defaultCwd ?? null,
        home: body.home ?? "",
        folders: body.folders ?? [],
      });
      setError(false);
    } catch (cause) {
      console.error("Failed to load the scheduled task settings:", cause);
      setError(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Setzt den Standardordner.
   *
   * Der Server antwortet mit dem *gespeicherten* Wert; der wird uebernommen und
   * nicht der eigene. Ein getippter Pfad mit `..` oder einem Symlink kann
   * anders aussehen als das, was gespeichert wurde, und die Anzeige soll das
   * zeigen, was gilt.
   */
  const save = useCallback(async (defaultCwd: string | null) => {
    const body = await request<SettingsResponse>("/api/scheduled-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultCwd }),
    });
    setSettings({
      defaultCwd: body.defaultCwd ?? null,
      home: body.home ?? "",
      folders: body.folders ?? [],
    });
    setError(false);
  }, []);

  return { settings, error, reload, save };
}
