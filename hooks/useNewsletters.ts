"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Newsletter as NewsletterRecord,
  NewsletterIssue,
  NewsletterItem,
  NewsletterSchedule,
  NewsletterSection,
} from "@/lib/newsletter";

/**
 * Die Newsletter des Kontos: laden, schreiben, anzeigen.
 *
 * ### Warum ein Hook und kein Store
 *
 * Angezeigt werden sie an genau einer Stelle — der Newsletter-Ansicht.
 * Dieselbe Entscheidung wie in `hooks/useCalendar.ts` und
 * `hooks/useScheduledTasks.ts`.
 *
 * ### Warum ein Poll und kein SSE-Strom
 *
 * Der Kalender hat einen Strom, weil der *Agent* Termine schreibt und der
 * Nutzer das sofort sehen soll. Hier schreibt der *Zeitplaner*: er startet
 * eine Sitzung, und die Ausgabe entsteht erst Minuten spaeter, wenn der Agent
 * fertig recherchiert hat. Ein Strom waere eine dauerhafte Verbindung fuer
 * eine Anzeige, deren ehrliche Waehrung zehn Sekunden sind — und die Sitzung
 * laeuft ohnehin unabhaengig von diesem Tab. Der Poll liest deshalb alle
 * {@link NEWSLETTER_POLL_MS} Millisekunden, aber nur solange der Tab sichtbar
 * ist: ein Hintergrund-Tab hat niemanden, der die neue Ausgabe liest.
 *
 * ### Warum die Liste nach jeder Aenderung neu geladen wird
 *
 * Der Server rechnet `schedule.nextRun` bei jeder Anfrage neu und haengt die
 * Ausgaben an die gespeicherte Fassung; eine lokal fortgeschriebene Liste
 * wuerde veraltete Termine zeigen. Dieselbe Begruendung wie in
 * `hooks/useScheduledTasks.ts`.
 */

/**
 * Der Takt des Polls.
 *
 * Zehn Sekunden, weil der geplante Agent die Ausgabe Minuten nach dem Start
 * schreibt: feiner waere eine Anfrage pro Sekunde fuer eine Aenderung, die
 * ohnehin selten kommt.
 */
export const NEWSLETTER_POLL_MS = 10_000;

/**
 * Die Domaene kommt aus `lib/newsletter.ts` — dieselbe Form, die die Routen
 * lesen und schreiben, und keine zweite Fassung davon. Der Import ist rein
 * typisch und wird beim Bauen entfernt; er kostet kein Byte im Browser.
 */
export type { NewsletterIssue, NewsletterItem, NewsletterSection, NewsletterSchedule };

/**
 * Der Zeitplan kommt nicht aus dem Datensatz, sondern aus der geplanten
 * Aufgabe: `schedule` joint die Route beim Lesen dazu.
 */
export type Newsletter = NewsletterRecord & { schedule: NewsletterSchedule | null };

/** Die Felder, die der Dialog schickt. */
export interface NewsletterInput {
  name: string;
  topics: string[];
  cron: string;
  provider: string;
  modelId: string;
  /** Der Arbeitsordner des Laufs; `null` heisst "Kontostandard". */
  cwd?: string | null;
}

export interface UseNewslettersResult {
  /** `null`, solange noch nichts geladen ist — das ist der Ladezustand. */
  newsletters: Newsletter[] | null;
  /** `true` nur beim ersten Laden, damit ein Poll die Ansicht nicht leert. */
  loading: boolean;
  error: boolean;
  refresh: () => Promise<void>;
  create: (input: NewsletterInput) => Promise<Newsletter>;
  update: (id: string, input: Partial<NewsletterInput>) => Promise<Newsletter>;
  remove: (id: string) => Promise<void>;
  /** Einen Lauf sofort starten; die Ausgabe holt danach der Poll. */
  runNow: (id: string) => Promise<string>;
}

/** Der Fehler einer Route, wie der Dialog ihn anzeigt. */
export interface NewsletterRequestError extends Error {
  field?: string;
  token?: string;
  /** Der HTTP-Status der Antwort; die Route hat ihn bereits gesetzt. */
  status?: number;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; field?: string; token?: string };
    const error = new Error(body.error ?? `HTTP ${response.status}`) as NewsletterRequestError;
    error.status = response.status;
    if (body.field) error.field = body.field;
    if (body.token) error.token = body.token;
    throw error;
  }
  return response.json() as Promise<T>;
}

export function useNewsletters(): UseNewslettersResult {
  const [newsletters, setNewsletters] = useState<Newsletter[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  /**
   * Der Generationszaehler: die juengste Anfrage gewinnt.
   *
   * Poll und Schreibvorgang koennen sich ueberholen; eine aeltere Antwort,
   * die spaeter eintrifft, darf den neueren Stand nicht ueberschreiben. Form
   * und Grund wie in `hooks/useScheduledTasks.ts`.
   */
  const generation = useRef(0);
  /**
   * **Eine** Anfrage zur Zeit, hintereinander statt gleichzeitig.
   *
   * Ohne die Kette koennte ein Poll starten, waehrend ein Schreibvorgang
   * gerade nachlaedt; die beiden Antworten kaemen in beliebiger Reihenfolge
   * und die aeltere koennte gewinnen. Jede Auffrischung wartet deshalb auf
   * die vorige — und jede Anfrage liest einen Stand, der nach ihrem Vorgaenger
   * entstanden ist.
   */
  const queue = useRef<Promise<void>>(Promise.resolve());

  const reload = useCallback((): Promise<void> => {
    const request = queue.current.then(async () => {
      const mine = ++generation.current;
      try {
        const body = await requestJson<{ newsletters?: Newsletter[] }>("/api/newsletters");
        if (mine !== generation.current) return;
        setNewsletters(body.newsletters ?? []);
        setError(false);
      } catch (cause) {
        if (mine !== generation.current) return;
        console.error("Failed to load the newsletters:", cause);
        setError(true);
      } finally {
        setLoading(false);
      }
    });
    // `reload` faengt jeden Fehler selbst ab; die Kette bleibt damit immer
    // fortsetzbar und braucht kein zweites `catch`.
    queue.current = request;
    return request;
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      // Eine Antwort, die nach dem Abbau eintrifft, setzt nichts mehr.
      generation.current += 1;
    };
  }, [reload]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void reload();
    };
    const interval = setInterval(refresh, NEWSLETTER_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload]);

  const create = useCallback(async (input: NewsletterInput): Promise<Newsletter> => {
    const body = await requestJson<{ newsletter: Newsletter }>("/api/newsletters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    await reload();
    return body.newsletter;
  }, [reload]);

  const update = useCallback(async (id: string, input: Partial<NewsletterInput>): Promise<Newsletter> => {
    const body = await requestJson<{ newsletter: Newsletter }>(`/api/newsletters/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    await reload();
    return body.newsletter;
  }, [reload]);

  const remove = useCallback(async (id: string): Promise<void> => {
    await requestJson<{ ok: boolean }>(`/api/newsletters/${encodeURIComponent(id)}`, { method: "DELETE" });
    await reload();
  }, [reload]);

  /**
   * Ein Handstart ist fuer die Ansicht eine Aenderung wie jede andere: die
   * Route startet die Sitzung und setzt den Zeitplan, der Nutzer soll den
   * neuen Stand sofort sehen. Die *Ausgabe* schreibt der Agent erst spaeter;
   * die holt der Poll.
   */
  const runNow = useCallback(async (id: string): Promise<string> => {
    const body = await requestJson<{ sessionId: string }>(`/api/newsletters/${encodeURIComponent(id)}/run`, {
      method: "POST",
    });
    await reload();
    return body.sessionId;
  }, [reload]);

  return { newsletters, loading, error, refresh: reload, create, update, remove, runNow };
}
