/**
 * Der Doppel-Enter im Eingabefeld: wann ist es eine Geste, und was tut sie?
 *
 * ### Was heute passiert
 *
 * Ein einzelnes Enter waehrend eines laufenden Turns schickt die Eingabe
 * bereits als **Steer** (`ChatInput.sendQueued("steer")` →
 * `useAgentSession.handleSteer` → `{type: "steer"}` → `session.steer()`).
 * Gemessen am 30.10.2026: ein Text, der so abgeschickt wird, steht nach 4,5 s
 * im Transkript, waehrend der Turn noch laeuft, und die Steuerung erscheint
 * genau einmal. Der Schalter existiert also schon; diese Datei entscheidet
 * nur, *wann* die Geste gemeint ist.
 *
 * ### Warum die Entscheidung hier und nicht im Handler steht
 *
 * Der Handler ist eine Kette von Bedingungen (IME, Menues, Shift, Leerlauf)
 * und laeuft nur im Browser. Die Regel selbst — "zwei Enter innerhalb von
 * `DOUBLE_ENTER_WINDOW_MS` sind eine Geste" — ist ein Zeitvergleich und
 * braucht kein DOM. Hier ist sie testbar, und der Handler bleibt eine
 * Uebersetzung von Tasten in Aufrufe.
 *
 * ### Warum ein Zustandsobjekt und keine Ref im Handler
 *
 * Der Zeitpunkt des letzten Enter ist die ganze Erinnerung, die die Geste
 * braucht. Ihn als Wert zu uebergeben macht den Ablauf in einem Test
 * nachstellbar, ohne einen Timer zu stellen: der Test gibt `nowMs` vor.
 */

/**
 * Das Fenster zwischen den beiden Enter-Anschlaegen.
 *
 * 400 ms ist die Grenze, die dieser Code als Geste liest; alles darueber ist
 * zweimal Enter, also zwei gewoehnliche Eingaben. Der Wert ist an
 * `COMPOSITION_END_ENTER_GRACE_MS` (100 ms) angelehnt, aber mit Absicht
 * groesser: dort geht es darum, ein *abschliessendes* Enter eines
 * IME-Kandidaten zu erkennen, hier um einen zweiten Willensakt.
 */
export const DOUBLE_ENTER_WINDOW_MS = 400;

/** Was der Handler mit einem Enter tun soll. */
export type EnterAction =
  /** Nichts senden: das Feld ist leer, gesperrt, oder ein IME ist im Spiel. */
  | { kind: "ignore" }
  /** Der gewoehnliche Weg (Senden im Leerlauf, Steer waehrend eines Turns). */
  | { kind: "default" };

/**
 * Der Zustand zwischen zwei Enter-Anschlaegen.
 *
 * `lastEnterAtMs` ist der Zeitstempel des letzten *gezaehlten* Enter
 * (`null` = noch keins). Ein Enter, das nicht als Geste zaehlt (leeres Feld,
 * IME, deaktiviert), setzt ihn zurueck: sonst wuerde ein Tastendruck von vor
 * zehn Sekunden mit einem spaeteren Enter zu einer Geste verschmelzen, sobald
 * das Feld wieder Inhalt hat.
 */
export interface EnterGestureState {
  lastEnterAtMs: number | null;
}

export function createEnterGestureState(): EnterGestureState {
  return { lastEnterAtMs: null };
}

export interface EnterGestureInput {
  /** Der Zeitstempel des Tastendrucks in Epoch-ms. */
  nowMs: number;
  /** Laesst sich ueberhaupt etwas senden? (`value.trim()` oder ein Bild.) */
  hasDraft: boolean;
  /** Das Feld ist gesperrt (kein Modell, keine Sitzung, laeuft schon etwas). */
  disabled: boolean;
  /** Ein IME setzt gerade ein Zeichen zusammen — Enter bestaetigt dort einen Kandidaten. */
  isComposing: boolean;
}

export interface EnterGestureResult {
  action: EnterAction;
  /** Der Zustand fuer den naechsten Tastendruck. */
  state: EnterGestureState;
  /** `true`, wenn dieser Druck die Geste *abschliesst* (zweites Enter im Fenster). */
  gesture: boolean;
}

/**
 * Ein Enter auswerten und den Zustand fortschreiben.
 *
 * Die drei Faelle, die der Aufrufer damit unterscheiden kann:
 *
 * 1. **Einzelnes Enter** — `default`, `gesture: false`. Der Handler macht
 *    genau das, was er ohne diese Funktion taete.
 * 2. **Zweites Enter im Fenster, waehrend ein Turn laeuft** — `default`,
 *    `gesture: true`. Der Aufrufer schickt dieselbe Steuerung wie bei einem
 *    einzelnen Enter, aber die Geste ist der Anlass: sie wird *sofort*
 *    gesendet statt bis zum Ende des Turns zu warten. Weil es derselbe Weg
 *    ist, erscheint der Text genau einmal.
 * 3. **Zweites Enter im Fenster, ohne Turn** — ebenfalls `default`, aber der
 *    Aufrufer sendet **nicht** zweimal: `gesture: true` sagt ihm, dass dieser
 *    Druck der Abschluss der Geste ist, und das erste Enter hat bereits
 *    gesendet. Das Feld ist dann leer, und `hasDraft` verhindert den zweiten
 *    Versand ohnehin — dieser Zweig ist die zweite Sicherung.
 *
 * `isComposing` und `disabled` liefern immer `ignore` und setzen den
 * Zeitstempel zurueck. Ein Enter, das einen IME-Kandidaten bestaetigt, ist
 * keine Eingabe und darf auch nicht die halbe Geste einer spaeteren sein.
 */
export function classifyEnter(
  state: EnterGestureState,
  input: EnterGestureInput,
): EnterGestureResult {
  const reset: EnterGestureState = { lastEnterAtMs: null };

  if (input.disabled || input.isComposing || !input.hasDraft) {
    return { action: { kind: "ignore" }, state: reset, gesture: false };
  }

  const previous = state.lastEnterAtMs;
  const withinWindow = previous !== null && input.nowMs - previous <= DOUBLE_ENTER_WINDOW_MS;

  // Nach der Geste faengt die Zaehlung neu an: zwei weitere Enter in schneller
  // Folge sind eine zweite Geste und nicht die Fortsetzung der ersten.
  return {
    action: { kind: "default" },
    state: { lastEnterAtMs: withinWindow ? null : input.nowMs },
    gesture: withinWindow,
  };
}
