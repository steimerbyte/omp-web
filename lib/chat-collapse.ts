import type { AgentMessage, AssistantContentBlock, CustomMessage } from "./types";
import { getAssistantErrorMessage, getDisplayableAssistantBlocks } from "./message-display";

/**
 * Die Regel, nach der eine Ausgabe im Transkript zu einer Zeile wird.
 *
 * Drei Ausgaben bleiben offen: die neueste und ihre zwei Vorgaenger — waehrend
 * eines langen Laufs ist das der aktuelle Schritt und der Blick zurueck. Der
 * Rest klappt zu, sobald drei juengere Ausgaben dazugekommen sind oder er
 * fuenf Minuten alt ist. Der Text einer zugeklappten Ausgabe wird nicht
 * gemountet, sondern erst beim Aufklappen: das ist der Grund fuer die Regel,
 * ein Transkript mit hundert Werkzeug-Ergebnissen kostet sonst beim Scrollen
 * fuer jede Zeile Layout und Markdown-Rendering.
 */
export const COLLAPSE_AFTER_OUTPUTS = 3;
export const COLLAPSE_AFTER_MS = 5 * 60_000;
/** Praefix-Laenge der Zusammenfassung; die Zeile ist einzeilig. */
export const COLLAPSE_PREVIEW_CHARS = 120;

export interface CollapseSignal {
  /** Zuklappbare Ausgaben nach dieser, ueber das ganze Transkript gezaehlt. */
  outputsAfter: number;
  /** Alter der Nachricht in ms; null/undefined, wenn sie keinen Zeitstempel hat. */
  ageMs?: number | null;
  isStreaming?: boolean;
  hasUserOverride?: boolean;
  /** Aufklapp-Wunsch des Nutzers, gilt nur mit `hasUserOverride`. */
  userOverride?: boolean;
}

/**
 * Entscheidet nur ueber das automatische Zuklappen; ein Klick des Nutzers
 * gewinnt in beide Richtungen (einmal aufgeklappt bleibt aufgeklappt, einmal
 * zugeklappt bleibt zugeklappt). Der Live-Tail ist kein Sonderfall: waehrend
 * eines Laufs waechst nur er, und ein Schritt mit hundert Werkzeugkarten soll
 * genauso zuklappen wie ein abgeschlossener. Geschuetzt sind nur die neueste
 * Ausgabe und der streamende Text selbst.
 */
export function shouldCollapseOutput(signal: CollapseSignal): boolean {
  if (signal.isStreaming) return false;
  if (signal.hasUserOverride) return signal.userOverride === true;
  if (signal.outputsAfter <= 0) return false;
  if (signal.outputsAfter >= COLLAPSE_AFTER_OUTPUTS) return true;
  return typeof signal.ageMs === "number" && Number.isFinite(signal.ageMs) && signal.ageMs >= COLLAPSE_AFTER_MS;
}

/**
 * Die Einheiten, die eine Zusammenfassungszeile bekommen. Werkzeug-Ergebnisse
 * fehlen: `MessageView` rendert sie inline unter ihrem Aufruf und liefert
 * eigenstaendig `null`, eine Karte darum waere eine leere Zeile.
 *
 * Ein Assistant-Turn ohne sichtbaren Block zaehlt nicht dazu: `MessageView`
 * liefert fuer ihn `null` (abgebrochener Lauf, `stopReason: "aborted"`, leerer
 * Inhalt), die Karte zeigte aber Etikett und Fehlertext — eine Systemzeile
 * mitten im Transkript. Sichtbar bleibt nur, was auch einen Block hat, oder der
 * Fehlertext eines wirklich gescheiterten Requests.
 */
export function isCollapsibleOutput(message: AgentMessage): boolean {
  if (message.role === "assistant") {
    return getDisplayableAssistantBlocks(message).length > 0
      || getAssistantErrorMessage(message) !== null;
  }
  if (message.role === "bashExecution") return true;
  if (message.role === "custom") return (message as CustomMessage).display === true;
  return false;
}

export interface CollapsedOutputSummary {
  /** Uebersetztes Etikett der Zeile ("Antwort", "Befehl", …). */
  label: string;
  /** Einzeilige Klartext-Vorschau, ohne Markdown. */
  preview: string;
  /** Werkzeugnamen der Nachricht in Reihenfolge des Auftretens. */
  toolNames: string[];
}

export interface SummaryHelpers {
  t: (key: string) => string;
}

/**
 * Die Vorschau liest hoechstens 400 Zeichen der Ausgabe: die Zeile zeigt 120,
 * und die Zusammenfassung laeuft fuer jede sichtbare Karte bei jedem Render —
 * sie darf nicht die Groesse der Ausgabe kosten. Deshalb wird der Inhalt auch
 * nie zusammengefuegt, sondern nur der erste nicht-leere Textblock gelesen.
 */
const PREVIEW_SOURCE_CHARS = 400;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Erster nicht-leerer Textblock, ohne Kopie: `\S` statt `trim()`. */
function firstNonEmptyText(content: string | ReadonlyArray<AssistantContentBlock>): string | null {
  if (typeof content === "string") return /\S/.test(content) ? content : null;
  for (const block of content) {
    if (block.type === "text" && /\S/.test(block.text)) return block.text;
  }
  return null;
}

function previewOr(text: string | null, fallback: string): string {
  const plain = oneLine((text ?? "").slice(0, PREVIEW_SOURCE_CHARS)) || oneLine(fallback.slice(0, PREVIEW_SOURCE_CHARS));
  return plain.length > COLLAPSE_PREVIEW_CHARS
    ? `${plain.slice(0, COLLAPSE_PREVIEW_CHARS - 1).trimEnd()}…`
    : plain;
}

/**
 * Etikett, Vorschau und Werkzeugnamen fuer die zugeklappte Zeile. Bewusst ohne
 * React und ohne den Markdown-Renderer: die Funktion laeuft fuer jede Ausgabe im
 * Transkript und darf dafuer nichts nachladen.
 */
export function summarizeCollapsedOutput(message: AgentMessage, { t }: SummaryHelpers): CollapsedOutputSummary {
  if (message.role === "assistant") {
    const toolNames: string[] = [];
    for (const block of message.content) {
      if (block.type === "toolCall" && !toolNames.includes(block.toolName)) toolNames.push(block.toolName);
    }
    const error = message.errorMessage ?? "";
    const body = firstNonEmptyText(message.content) ?? (/\S/.test(error) ? error : null);
    return {
      label: body !== null ? t("chat.collapsedAnswer") : t("chat.collapsedToolStep"),
      preview: previewOr(body, toolNames.join(", ")),
      toolNames,
    };
  }
  if (message.role === "bashExecution") {
    return {
      label: t("chat.collapsedCommand"),
      preview: previewOr(message.command, message.output),
      toolNames: [],
    };
  }
  if (message.role === "custom") {
    const label = message.customType === "compaction"
      ? t("chat.collapsedCompaction")
      : message.customType === "async-result"
        ? t("chat.collapsedBackgroundResult")
        : t("chat.collapsedMessage");
    return {
      label,
      preview: previewOr(firstNonEmptyText(message.content), message.customType),
      toolNames: [],
    };
  }
  const body = message.role === "user" || message.role === "toolResult" ? firstNonEmptyText(message.content) : null;
  return { label: t("chat.collapsedMessage"), preview: previewOr(body, ""), toolNames: [] };
}

/**
 * Der grobe Takt der Altersregel: ein Tick pro Minute reicht, weil zwischen
 * "eben" und "fuenf Minuten" entschieden wird und nicht auf die Sekunde. Er
 * laeuft ueber `setInterval` und nicht ueber einen Render pro Token; der
 * Rueckgabewert haelt ihn an.
 */
export function createOutputClock(onTick: (now: number) => void, intervalMs = 60_000): () => void {
  const timer = setInterval(() => onTick(Date.now()), intervalMs);
  return () => clearInterval(timer);
}
