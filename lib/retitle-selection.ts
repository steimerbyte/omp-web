/**
 * Welche Session-Dateien ein Titel-Lauf anfassen darf — ohne Dateisystem,
 * ohne Modell, nur die Regel. Das Skript `scripts/retitle-sessions.mjs` liest
 * die Fakten ein und ruft `decideRetitle`; hier ist die Regel damit testbar.
 */

export type RetitleDecision =
  | "title"
  | "skip-subagent"
  | "skip-recent"
  | "skip-user"
  | "skip-unknown"
  | "skip-titled";

export interface RetitleCandidate {
  /** Segmente des Pfads relativ zum Sessions-Wurzelverzeichnis; Top-Level-Sessions haben 2. */
  depth: number;
  /** Erster Titel-Slot der Datei; leer heisst "noch nie benannt". */
  title: string;
  /** `"auto"`, `"user"`, oder `undefined` bei alten Records ohne Feld. */
  source: string | undefined;
  mtimeMs: number;
}

export interface RetitlePolicy {
  nowMs: number;
  /** Juenger als das gilt als laufende Session und wird nicht angefasst. */
  recentMs: number;
  /** Auch vom Operator getippte Namen ueberschreiben. */
  includeUser: boolean;
  /** Nur leere Titel fuellen, auch `auto`-Titel in Ruhe lassen. */
  onlyEmpty: boolean;
}

/** Sekunden bis ein Lauf eine Session als ruhend ansieht (30 Minuten). */
export const RETITLE_RECENT_MS = 30 * 60 * 1000;

/**
 * Die Entscheidung fuer eine Datei. Reihenfolge ist Absicht: eine zu junge
 * Datei wird immer geschont (sie kann gerade schreiben), auch wenn sie sonst
 * ein Kandidat waere; Subagent-Dateien tragen keinen sichtbaren Namen; ein
 * nicht-leerer Titel ohne bekannte Herkunft wird nie ueberschrieben.
 */
export function decideRetitle(candidate: RetitleCandidate, policy: RetitlePolicy): RetitleDecision {
  if (candidate.depth >= 3) return "skip-subagent";
  if (policy.nowMs - candidate.mtimeMs < policy.recentMs) return "skip-recent";
  if (!candidate.title.trim()) return "title";
  if (candidate.source === "auto") return policy.onlyEmpty ? "skip-titled" : "title";
  if (candidate.source === "user") return policy.includeUser ? "title" : "skip-user";
  return "skip-unknown";
}
