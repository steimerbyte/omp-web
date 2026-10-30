"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ScheduledTask } from "@/lib/scheduled-tasks-store";

/**
 * Die geplanten Aufgaben des Kontos: laden, schreiben, anzeigen.
 *
 * ### Warum ein Hook und kein Store
 *
 * Die Aufgaben werden an genau einer Stelle angezeigt — der Aufgabenansicht.
 * Ein globaler Store wuerde die Frage aufwerfen, wer die Daten beim Start
 * laedt, und einen zweiten Abnehmer gibt es nicht. Dieselbe Entscheidung wie
 * in `hooks/useCalendar.ts`.
 *
 * ### Warum kein SSE-Strom
 *
 * Der Kalender hat einen, weil der *Agent* Termine schreibt und der Nutzer
 * das sofort sehen soll. Eine geplante Aufgabe wird nur von der Oberflaeche
 * selbst geschrieben; der Zeitplaner aendert nur `lastRun*`, und diese Felder
 * sind nach einem Lauf beim naechsten Oeffnen der Ansicht aktuell genug. Ein
 * zweiter Strom waere eine Verbindung fuer eine Anzeige, die um Sekunden
 * genauer waere.
 *
 * ### Warum die Liste nach jeder Aenderung neu geladen wird
 *
 * Der Server antwortet mit der gespeicherten Fassung, aber `nextRun` rechnet
 * er bei jeder Anfrage neu — eine lokal fortgeschriebene Liste wuerde einen
 * veralteten naechsten Lauf zeigen. Dieselbe Begruendung wie in
 * `hooks/useCalendar.ts`.
 */

/** Eine Aufgabe, wie die Route sie liefert: mit serverseitigem `nextRun`. */
export interface ScheduledTaskView extends ScheduledTask {
  /** Epoch-ms des naechsten Laufs, oder `null` (deaktiviert / trifft nie). */
  nextRun?: number | null;
}

/** Die Felder, die der Dialog schickt. */
export interface ScheduledTaskInput {
  name: string;
  cron: string;
  prompt: string;
  provider: string;
  modelId: string;
  thinkingLevel?: string | null;
  enabled?: boolean;
}

export interface UseScheduledTasksResult {
  tasks: ScheduledTaskView[] | null;
  error: boolean;
  reload: () => Promise<void>;
  create: (input: ScheduledTaskInput) => Promise<ScheduledTaskView>;
  update: (id: string, input: Partial<ScheduledTaskInput>) => Promise<ScheduledTaskView>;
  remove: (id: string) => Promise<void>;
}

/** Der Fehler einer Route, wie der Dialog ihn anzeigt. */
export interface ScheduledTaskRequestError extends Error {
  field?: string;
  token?: string;
  /**
   * Der HTTP-Status der Antwort.
   *
   * Er steht hier, weil die Route ihn bereits gesetzt hat und die Oberflaeche
   * ihn sonst aus dem Text erraten muesste: `409` heisst "andere Schemafassung",
   * `503` heisst "gerade gesperrt". Ein eigenes `code`-Feld in der Antwort
   * waere ein zweiter Ausdruck derselben Aussage — der Status ist der
   * maschinenlesbare Teil, den HTTP schon mitliefert.
   */
  status?: number;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; field?: string; token?: string };
    const error = new Error(body.error ?? `HTTP ${response.status}`) as ScheduledTaskRequestError;
    error.status = response.status;
    if (body.field) error.field = body.field;
    if (body.token) error.token = body.token;
    throw error;
  }
  return response.json() as Promise<T>;
}

export function useScheduledTasks(): UseScheduledTasksResult {
  const [tasks, setTasks] = useState<ScheduledTaskView[] | null>(null);
  const [error, setError] = useState(false);
  /**
   * Der Generationszaehler: die juengste Anfrage gewinnt.
   *
   * Bei jedem Anlegen und Loeschen laufen zwei Ladevorgaenge (der eigene des
   * Schreibvorgangs und der naechste nach dem naechsten Schreibvorgang). Eine
   * aeltere Antwort, die spaeter eintrifft, darf den neueren Stand nicht
   * ueberschreiben. Dieselbe Form und derselbe Grund wie in
   * `hooks/useCalendar.ts`.
   */
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const body = await requestJson<{ tasks?: ScheduledTaskView[] }>("/api/scheduled-tasks");
      if (mine !== generation.current) return;
      setTasks(body.tasks ?? []);
      setError(false);
    } catch (cause) {
      if (mine !== generation.current) return;
      console.error("Failed to load the scheduled tasks:", cause);
      setError(true);
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      // Eine Antwort, die nach dem Abbau eintrifft, setzt nichts mehr.
      generation.current += 1;
    };
  }, [reload]);

  const create = useCallback(async (input: ScheduledTaskInput): Promise<ScheduledTaskView> => {
    const body = await requestJson<{ task: ScheduledTaskView }>("/api/scheduled-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    await reload();
    return body.task;
  }, [reload]);

  const update = useCallback(async (id: string, input: Partial<ScheduledTaskInput>): Promise<ScheduledTaskView> => {
    const body = await requestJson<{ task: ScheduledTaskView }>(`/api/scheduled-tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    await reload();
    return body.task;
  }, [reload]);

  const remove = useCallback(async (id: string): Promise<void> => {
    await requestJson<{ deleted: boolean }>(`/api/scheduled-tasks/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    await reload();
  }, [reload]);

  return { tasks, error, reload, create, update, remove };
}
