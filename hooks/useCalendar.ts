"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CalendarEvent } from "@/lib/calendar";

/**
 * Der Kalender des Kontos: Termine laden, schreiben und live halten.
 *
 * ### Warum ein Hook und nicht ein Store
 *
 * Der Kalender wird an genau einer Stelle angezeigt — der Kalenderansicht.
 * Ein globalser Store wuerde die Frage aufwerfen, wer die Daten beim Start
 * laedt, und ein zweiter Abnehmer (die Seitenleiste?) gibt es nicht. Der Hook
 * haelt den Zustand dort, wo er gebraucht wird.
 *
 * ### Warum ein SSE-Strom und kein Polling
 *
 * Der Kalender wird von zwei Seiten geschrieben: von der Oberflaeche und vom
 * Agenten. Ohne einen Strom sieht der Nutzer einen Termin, den der Agent
 * gerade angelegt hat, erst nach einem Neuladen — und im Chat steht
 * gleichzeitig "Ich habe einen Termin angelegt". Das ist die Art von
 * Widerspruch, die ein Werkzeug unbrauchbar macht.
 *
 * ### Warum der Strom sich selbst neu verbindet
 *
 * `EventSource` verbindet sich nach einem Abbruch nicht wieder. Das ist hier
 * kein Randfall: der Server beendet die Verbindung im Leerlauf, und ein
 * Browser im Hintergrund verliert sie ohnehin. Ohne Wiederverbindung waere
 * der Kalender nach einem Tab-Wechsel stumm — und niemand wuerde es merken,
 * weil der Kalender dann einfach *alt* aussieht.
 */

export interface UseCalendarResult {
  /** Die Termine, sortiert nach Beginn. `null`, solange sie nicht geladen sind. */
  events: CalendarEvent[] | null;
  /** `true`, wenn der erste Ladeversuch fehlgeschlagen ist. */
  error: boolean;
  /** Lädt die Termine neu — etwa nach dem SSE-Strom. */
  reload: () => Promise<void>;
  /** Legt einen Termin an und liefert die gespeicherte Fassung. */
  create: (input: CalendarEventInput) => Promise<CalendarEvent>;
  /**
   * Aendert einen Termin und liefert die gespeicherte Fassung.
   *
   * `input` ist bewusst unvollstaendig: eine Verschiebung schickt nur den
   * neuen Beginn und das neue Ende, und `PATCH` laesst den Rest stehen. Ein
   * `PUT`-Semantik wuerde beim Verschieben den Ort und die Notiz loeschen.
   */
  update: (id: string, input: Partial<CalendarEventInput>) => Promise<CalendarEvent>;
  /** Loescht einen Termin. */
  remove: (id: string) => Promise<void>;
}

/** Die Felder, die die Oberflaeche beim Anlegen und Aendern schickt. */
export interface CalendarEventInput {
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  description?: string;
  location?: string;
  /** Die Farbe des Termins: ein Preset-Name oder ein Hex-Code. */
  color?: string;
}

/**
 * Die JSON-Antwort der Kalender-Routen.
 *
 * Die Routen antworten bei einem Fehler mit `{ error: "..." }` und einem
 * Statuscode ungleich 200. Beides wird hier zu einem Fehler — die
 * Oberflaeche soll nicht zwischen "kein Kalender" und "Server nicht
 * erreichbar" unterscheiden muessen, sondern nur wissen, dass es gerade
 * nicht geklappt hat.
 */
async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}) as { error?: string });
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function useCalendar(): UseCalendarResult {
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [error, setError] = useState(false);
  /**
   * Die laufende Anfrage.
   *
   * Sie wird beim Wechsel der Ansicht nicht abgebrochen — der Kalender laedt
   * fuer alle drei Ansichten dieselbe Liste — sondern nur beim Aendern der
   * Identitaet. Sonst wuerde ein schneller Klick auf "Heute" zwei Anfragen
   * erzeugen, deren Antworten in beliebiger Reihenfolge eintreffen.
   */
  const inFlight = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const body = await requestJson<{ events?: CalendarEvent[] }>("/api/calendar", {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setEvents(body.events ?? []);
      setError(false);
    } catch (cause) {
      // Ein abgebrochener Request ist kein Fehler: er wurde absichtlich
      // verwaorfen, weil ein neuer kam.
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      console.error("Failed to load the calendar:", cause);
      setError(true);
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => { inFlight.current?.abort(); };
  }, [reload]);

  /**
   * Der SSE-Strom der Kalender-Aenderungen.
   *
   * Die Verbindung wird beim Aufbauen des Streams geoeffnet und beim
   * Abbau wieder geschlossen. `EventSource` verbindet sich nach einem
   * Abbruch nicht von selbst — deshalb der eigene Wiederverbindungsversuch
   * mit Verzoegerung, der erst nach einer echten Fehlstellung beginnt.
   */
  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = () => {
      if (closed) return;
      source = new EventSource("/api/calendar/events");

      source.addEventListener("calendar_changed", () => {
        void reload();
      });

      source.onerror = () => {
        // `readyState === CLOSED` heisst: der Browser hat die Verbindung
        // aufgegeben und wird sie nicht wieder aufbauen. Dann ist der
        // eigene Versuch noetig.
        source?.close();
        if (closed) return;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(connect, 3000);
      };
    };

    connect();

    return () => {
      closed = true;
      clearTimeout(retryTimer);
      source?.close();
    };
  }, [reload]);

  const create = useCallback(async (input: CalendarEventInput): Promise<CalendarEvent> => {
    const body = await requestJson<{ event: CalendarEvent }>("/api/calendar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    // Der Server antwortet mit dem *validierten* Termin. Die Liste wird aus
    // dem Serverstand neu geladen, damit die Anzeige nicht von einer
    // optimistischen Fassung abweicht, die der Server gar nicht gespeichert
    // hat.
    await reload();
    return body.event;
  }, [reload]);

  const update = useCallback(async (id: string, input: Partial<CalendarEventInput>): Promise<CalendarEvent> => {
    const body = await requestJson<{ event: CalendarEvent }>(`/api/calendar/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    await reload();
    return body.event;
  }, [reload]);

  const remove = useCallback(async (id: string): Promise<void> => {
    await requestJson<{ ok: boolean }>(`/api/calendar/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    await reload();
  }, [reload]);

  return { events, error, reload, create, update, remove };
}
