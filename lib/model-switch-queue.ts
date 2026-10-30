import { AgentCommandTimeoutError } from "./agent-client";

/** A model to switch to; a role switch names the role instead of the pair. */
export type ModelTarget =
  | { kind: "model"; provider: string; modelId: string }
  | { kind: "role"; role: string };

/**
 * Die Antwort des Servers auf `set_model` / `set_role_model`.
 *
 * Sie traegt den Zustand, den der Client braucht, um den Wechsel ohne einen
 * zweiten Request zu uebernehmen: das Modell, das jetzt gilt, und den
 * Thinking-Level, den die SDK dabei nachgezogen hat (`#reapplyThinkingLevel`).
 * `leafId` ist der Leaf nach dem `model_change`-Eintrag — die Stelle, die der
 * fruehere `loadSession` mitgenommen hat.
 */
export interface ModelSwitchResult {
  id: string;
  provider: string;
  role?: string;
  thinkingLevel?: string;
  configuredThinkingLevel?: string;
  leafId?: string | null;
}

export function commandForTarget(target: ModelTarget): Record<string, unknown> {
  return target.kind === "role"
    ? { type: "set_role_model", role: target.role }
    : { type: "set_model", provider: target.provider, modelId: target.modelId };
}

export function modelTargetKey(target: ModelTarget): string {
  return target.kind === "role"
    ? `role:${target.role}`
    : `model:${target.provider}/${target.modelId}`;
}

/**
 * Der Zustand eines Modellwechsels im Composer: hoechstens eine Anfrage
 * gleichzeitig, und der zuletzt gewuenschte Zielzustand gewinnt.
 *
 * ### Warum das nicht im Hook als Ref steht
 *
 * Der Hook kann den Fehler, um den es geht, nicht zeigen: `modelSwitchPendingRef`
 * ist ein Wahrheitswert, und ein Klick waehrend einer laufenden Anfrage fiel
 * vorher still aus der Funktion. Dieser Baustein trennt die Frage „welcher
 * Wechsel laeuft gerade" von „was will der Nutzer" — damit ist der zweite Klick
 * eine Buchung statt eines Rueckgabewerts, und der letzte gewinnt.
 *
 * Der Zustand ist Wert, nicht Ref: `accept` gibt den neuen Zustand zurueck, statt
 * ihn zu veraendern. Ein aufrufender Hook haelt ihn in einem `useRef`, aber die
 * Tests brauchen die Uebergaenge ohne React.
 */
export interface ModelSwitchQueue {
  /** Der laufende Wechsel, solange eine Anfrage offen ist. */
  readonly inFlight: ModelTarget | null;
  /** Der zuletzt gewuenschte, noch nicht uebertragene Wechsel. */
  readonly queued: ModelTarget | null;
}

export function createModelSwitchQueue(): ModelSwitchQueue {
  return { inFlight: null, queued: null };
}

/**
 * Bucht einen Klick.
 *
 * `ok: false` bedeutet „nimm den Klick nicht an" — genauer: er aendert den
 * Zustand nicht. Das ist der Fall, wenn derselbe Wechsel schon laeuft oder
 * schon gebucht ist; ein zweiter Klick auf das Ziel, das ohnehin gleich
 * geschaltet wird, erzeugt keine zweite Anfrage.
 */
export function acceptModelSwitch(
  state: ModelSwitchQueue,
  target: ModelTarget,
): { state: ModelSwitchQueue; ok: boolean } {
  const key = modelTargetKey(target);
  if (state.inFlight && modelTargetKey(state.inFlight) === key) return { state, ok: false };
  if (state.queued && modelTargetKey(state.queued) === key) return { state, ok: false };
  if (!state.inFlight) return { state: { inFlight: target, queued: null }, ok: true };
  return { state: { inFlight: state.inFlight, queued: target }, ok: true };
}

/**
 * Die laufende Anfrage ist beantwortet (Erfolg oder Fehler).
 *
 * Gibt zurueck, was der Aufrufer als naechstes schicken soll: den gebuchten
 * Wechsel, oder `null`, wenn nichts mehr offen ist. Der gebuchte Wechsel wandert
 * dabei in `inFlight`, damit ein dritter Klick waehrend der zweiten Anfrage
 * wieder nur bucht statt zu verdraengen.
 */
export function settleModelSwitch(
  state: ModelSwitchQueue,
): { state: ModelSwitchQueue; next: ModelTarget | null } {
  if (state.queued) return { state: { inFlight: state.queued, queued: null }, next: state.queued };
  return { state: { inFlight: null, queued: null }, next: null };
}

/** Was vom gescheiterten Wechsel uebrig bleibt, nachdem der Fehler gelesen ist. */
export interface ModelSwitchFailure {
  /** Der Server hat nicht rechtzeitig geantwortet (nicht: hat abgelehnt). */
  timeout: boolean;
  /** Die Serverantwort, roh. Leer, wenn es keine gibt. */
  detail: string;
}

export function toModelSwitchFailure(error: unknown): ModelSwitchFailure {
  return {
    // `instanceof` allein reicht nicht: liegt das Modul zweimal im Prozess (etwa
    // wenn der Test es mit `moduleCache: false` ein zweites Mal laedt), ist die
    // Klasse eine andere und ein Timeout saehe wie eine Absage aus. Der Name
    // wird von `AgentCommandTimeoutError` genau dafuer gesetzt.
    timeout:
      error instanceof AgentCommandTimeoutError ||
      (error instanceof Error && error.name === "AgentCommandTimeoutError"),
    detail: error instanceof Error ? error.message : String(error ?? ""),
  };
}

/**
 * Der Text, den der Composer bei einem gescheiterten Wechsel zeigt.
 *
 * `translate` wird hereingereicht, weil dieser Baustein sprachfrei bleibt: die
 * Texte stehen in den Katalogen, hier stehen nur die Schluessel. Die
 * Serverantwort wird angehaengt, nicht ersetzt — sie nennt den Grund
 * („No API key for …"), und ohne sie waere die Meldung nicht zu beheben. Beim
 * Timeout entfaellt sie: dort gibt es keine Antwort, und „AbortError" waere
 * fuer den Nutzer nur Rauschen.
 */
export function describeModelSwitchFailure(
  failure: ModelSwitchFailure,
  translate: (key: string) => string,
): string {
  const base = translate(failure.timeout ? "chat.modelSwitchTimeout" : "chat.modelSwitchFailed");
  return failure.timeout || !failure.detail ? base : `${base} ${failure.detail}`;
}
