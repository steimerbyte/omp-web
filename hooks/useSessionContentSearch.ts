"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Die Suche in den Transkripten — Inhalt statt Titel.
 *
 * ### Warum ein eigener Hook und keine Zeile in der Seitenleiste
 *
 * Die Suche hat drei Dinge, die schiefgehen: ein Tastendruck pro Zeichen
 * waere eine Anfrage pro Zeichen; eine Antwort, die spaeter eintrifft als die
 * naechste Frage, wuerde die Anzeige auf einen alten Suchbegriff
 * zuruecksetzen; und ein Fehler darf die Liste nicht mitreissen. Alle drei
 * sind Zeitverhalten und gehoeren deshalb hierher, nicht in das Rendern der
 * Zeilen.
 *
 * ### Warum der Server sucht und nicht der Browser
 *
 * Die Transkripte liegen auf der Platte des Servers, nicht in der Antwort von
 * `GET /api/sessions` — die traegt nur den Titel. Jede Session samt Inhalt an
 * den Browser zu schicken waere ein Vielfaches an Bytes fuer eine Suche, die
 * der Server in einer Anfrage beantwortet. `lib/session-search.ts` begrenzt
 * die Arbeit (25 Treffer, 40 Sessions, 64 MiB, 2 s) und meldet mit
 * `truncated`, wenn eine Grenze gegriffen hat.
 *
 * ### Warum die Generation und der Abbruch
 *
 * Ein `AbortController` beendet die alte Anfrage, sobald ein neuer Begriff da
 * ist — das spart die Antwort. Er allein reicht aber nicht: eine Antwort kann
 * den Abbruch ueberholt haben und erst danach ankommen. Der Zaehler
 * entscheidet, wessen Antwort gilt, und die alte wird verworfen.
 */

/** Kuerzere Fragen beantwortet die Route nicht — dieselbe Grenze wie dort. */
export const CONTENT_SEARCH_MIN_LENGTH = 2;

/** Laengere Fragen lehnt die Route mit 400 ab; sie werden gar nicht erst gestellt. */
export const CONTENT_SEARCH_MAX_LENGTH = 100;

/** So lange wird getippt, bevor gefragt wird. */
export const CONTENT_SEARCH_DEBOUNCE_MS = 300;

/** Ein Treffer, wie ihn `GET /api/sessions/search` liefert. */
export interface SessionContentMatch {
  sessionId: string;
  title: string;
  cwd: string;
  projectRoot?: string;
  hits: number;
  snippet: string;
  lastMatchedAt?: string;
}

export interface SessionContentSearchResult {
  matches: SessionContentMatch[];
  /** Eine Grenze des Servers hat die Suche vorzeitig beendet. */
  truncated: boolean;
  /** Eine Anfrage laeuft oder wartet auf den naechsten Tastendruck. */
  searching: boolean;
  /** Der Satz des Servers oder der Netzfehler; `null`, wenn nichts schiefging. */
  error: string | null;
}

const IDLE: SessionContentSearchResult = {
  matches: [],
  truncated: false,
  searching: false,
  error: null,
};

export function useSessionContentSearch(query: string): SessionContentSearchResult {
  const trimmed = query.trim();
  const active = trimmed.length >= CONTENT_SEARCH_MIN_LENGTH && trimmed.length <= CONTENT_SEARCH_MAX_LENGTH;
  const [state, setState] = useState<SessionContentSearchResult>(IDLE);
  /** Die juengste Frage gewinnt; eine aeltere Antwort setzt nichts mehr. */
  const generation = useRef(0);

  useEffect(() => {
    if (!active) {
      // Auch eine noch laufende Antwort ist damit veraltet.
      generation.current += 1;
      setState(IDLE);
      return;
    }
    const mine = ++generation.current;
    const controller = new AbortController();
    const apply = (next: SessionContentSearchResult) => {
      if (mine === generation.current) setState(next);
    };
    setState((current) => ({ ...current, searching: true, error: null }));

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(
            `/api/sessions/search?q=${encodeURIComponent(trimmed)}`,
            { signal: controller.signal },
          );
          const body = await response.json().catch(() => ({})) as Partial<SessionContentSearchResult> & { error?: string };
          if (!response.ok) {
            apply({ matches: [], truncated: false, searching: false, error: body.error ?? `HTTP ${response.status}` });
            return;
          }
          apply({
            matches: Array.isArray(body.matches) ? body.matches : [],
            truncated: body.truncated === true,
            searching: false,
            error: null,
          });
        } catch (cause) {
          // Der eigene Abbruch ist kein Fehler, sondern der naechste Begriff.
          if (controller.signal.aborted) return;
          apply({
            matches: [],
            truncated: false,
            searching: false,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      })();
    }, CONTENT_SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, active]);

  return state;
}
