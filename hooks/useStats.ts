"use client";

import { useCallback, useEffect, useState } from "react";
import type { DashboardStats, ToolDashboardStats } from "@oh-my-pi/omp-stats";
import type { StatsPayload } from "@/lib/stats";

/**
 * Der Datenabruf der Statistik-Seite.
 *
 * Die Route ist admin-only und antwortet beim ersten Aufruf möglicherweise mit
 * `stats: null, syncing: true`, weil omp die vorhandenen Sitzungen noch
 * indiziert. Diese Datei hält die zwei Dinge, die daraus folgen: den letzten
 * guten Stand nicht wegwerfen, und den ersten Sync nach einem festen, begrenzten
 * Zeitplan nachfragen.
 */

/** Die Zeitfenster, die die Seite anbietet (die Route kennt auch `1h`/`all`). */
export type StatsRange = "24h" | "7d" | "30d" | "90d";

export const STATS_RANGE_OPTIONS: readonly StatsRange[] = ["24h", "7d", "30d", "90d"];

/** Der Abstand zwischen zwei Nachfragen, solange der Sync läuft. */
export const STATS_POLL_INTERVAL_MS = 2_000;

/**
 * Wie lange die Seite den Sync höchstens nachfragen darf.
 *
 * Dieselbe Überlegung wie in `lib/project-size-poll.ts`: das Fenster muss die
 * Arbeit überdauern, auf die es wartet, und es braucht ein Ende. Ein erster
 * Sync über eine große Sitzungsablage dauert Minuten, nicht Sekunden; ein
 * hängender Sync darf die Seite aber nicht für immer fragen lassen, denn das
 * ist ein Timer, der das Tab überlebt.
 */
export const STATS_POLL_WINDOW_MS = 120_000;

/**
 * Wie viele Nachfragen in das Fenster passen.
 *
 * Die erste Nachfrage kommt nach `STATS_POLL_INTERVAL_MS`, nicht sofort — die
 * Antwort des ersten Aufrufs ist ja schon da. `L` Nachfragen spannen daher
 * `L` Intervalle, nicht `L − 1`.
 */
export function statsPollLimitFor(
  windowMs = STATS_POLL_WINDOW_MS,
  intervalMs = STATS_POLL_INTERVAL_MS,
): number {
  return Math.ceil(windowMs / intervalMs);
}

export interface UseStatsResult {
  /** Der letzte gute Stand. Er bleibt stehen, während eine Nachfrage läuft. */
  payload: StatsPayload | null;
  stats: DashboardStats | null;
  tools: ToolDashboardStats | null;
  /** Der erste Abruf für dieses Zeitfenster läuft noch. */
  loading: boolean;
  /** Die Route hat mit 403 geantwortet — dieser Account darf sie nicht lesen. */
  forbidden: boolean;
  /** Ein Abruf ist fehlgeschlagen. Der letzte gute Stand steht weiter. */
  error: string | null;
  /** Ein Sync läuft (und die Nachfrage ist nicht an einem Fehler gestorben). */
  syncing: boolean;
  /** Neu laden, etwa aus dem Fehlerzustand heraus. */
  refresh: () => void;
}

export function useStats(range: StatsRange = "24h"): UseStatsResult {
  const [payload, setPayload] = useState<StatsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Ein Zähler, kein Boolean: jeder Klick auf "Erneut versuchen" startet neu. */
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const pollLimit = statsPollLimitFor();

    // Ein Zeitfensterwechsel beginnt bei nichts: die Zahlen auf dem Schirm
    // gehören zum alten Fenster und wären unter dem neuen eine Lüge. Eine
    // Nachfrage für dasselbe Fenster lässt den Stand dagegen stehen.
    setPayload((current) => (current?.range === range ? current : null));
    setLoading(true);
    setError(null);
    setForbidden(false);

    const load = async (): Promise<void> => {
      try {
        const response = await fetch(`/api/stats?range=${range}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 403) {
          if (stopped) return;
          // Kein Poll: die Route wird diesem Account nicht plötzlich antworten.
          setForbidden(true);
          setPayload(null);
          setError(null);
          setLoading(false);
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as {
          success?: boolean;
          data?: StatsPayload;
          error?: string;
        };
        // Die Form wird hier geprüft, an der Grenze. Ein Payload, der nicht
        // die versprochene Antwort ist, darf nicht als `undefined` in die
        // Tabellen laufen.
        if (body.success !== true || !body.data || typeof body.data.syncing !== "boolean") {
          throw new Error(body.error ?? "unexpected answer from /api/stats");
        }
        if (stopped) return;
        setPayload(body.data);
        setError(null);
        setForbidden(false);
        setLoading(false);

        if (!body.data.syncing || polls >= pollLimit) return;
        polls += 1;
        timer = setTimeout(() => {
          timer = undefined;
          void load();
        }, STATS_POLL_INTERVAL_MS);
      } catch (cause) {
        if (stopped) return;
        // Der Abruf selbst ist gescheitert. Der letzte gute Stand bleibt
        // stehen; die Nachfrage endet, bis der Nutzer sie neu startet.
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      }
    };

    void load();

    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [range, reloadKey]);

  const refresh = useCallback(() => setReloadKey((key) => key + 1), []);

  return {
    payload,
    stats: payload?.stats ?? null,
    tools: payload?.tools ?? null,
    loading,
    forbidden,
    error,
    // Ein Fehler beendet die Nachfrage; "läuft noch" wäre dann eine Behauptung
    // über einen Timer, den es nicht mehr gibt.
    syncing: error === null && payload?.syncing === true,
    refresh,
  };
}
