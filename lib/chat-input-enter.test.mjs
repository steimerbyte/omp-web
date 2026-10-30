import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  DOUBLE_ENTER_WINDOW_MS,
  classifyEnter,
  createEnterGestureState,
} = await jiti.import("./chat-input-enter.ts");

/**
 * Der Doppel-Enter als reine Entscheidung.
 *
 * Geprueft wird die Regel selbst: wann zwei Anschlaege eine Geste sind und
 * wann nicht. Was der Handler daraus macht (steuern statt senden, nichts
 * doppelt schicken), steht in `components/ChatInput.enter-gesture.test.mjs` —
 * dort laeuft der echte Handler, hier nur der Zeitvergleich.
 *
 * `nowMs` wird vorgegeben und nicht gemessen: ein Test, der auf eine echte Uhr
 * wartet, ist entweder langsam oder unzuverlaessig, und beides waere hier
 * unnoetig.
 */

const DRAFT = { hasDraft: true, disabled: false, isComposing: false };

/** Ein einzelner Anschlag, dann der zweite nach `deltaMs`. */
function twoPresses(deltaMs, first = DRAFT, second = DRAFT) {
  const first1 = classifyEnter(createEnterGestureState(), { nowMs: 1_000, ...first });
  const second1 = classifyEnter(first1.state, { nowMs: 1_000 + deltaMs, ...second });
  return { first: first1, second: second1 };
}

test("the window constant is the documented 400 ms", () => {
  // Der Wert steht im Kommentar und in der Antwort an den Nutzer; ein Test
  // haelt ihn fest, weil eine stille Aenderung sonst die Geste verschiebt,
  // ohne dass irgendwo etwas rot wird.
  assert.equal(DOUBLE_ENTER_WINDOW_MS, 400);
});

test("a single press is the ordinary path", () => {
  const decided = classifyEnter(createEnterGestureState(), { nowMs: 1_000, ...DRAFT });
  assert.deepEqual(decided.action, { kind: "default" });
  assert.equal(decided.gesture, false, "ein Anschlag ist keine Geste");
  assert.equal(decided.state.lastEnterAtMs, 1_000);
});

test("two presses inside the window are one gesture", () => {
  const { first, second } = twoPresses(DOUBLE_ENTER_WINDOW_MS);
  assert.equal(first.gesture, false);
  assert.equal(second.gesture, true, "der zweite Anschlag schliesst die Geste ab");
  assert.deepEqual(second.action, { kind: "default" }, "die Aktion bleibt die gewoehnliche");
});

test("the second press exactly on the boundary is still the gesture", () => {
  // `<=`, nicht `<`: die Grenze selbst gehoert dazu. Sonst waere der Wert im
  // Kommentar eine Aussage ueber 399 ms, und ein Anschlag bei genau 400 ms
  // fiele ohne Grund heraus.
  const { second } = twoPresses(DOUBLE_ENTER_WINDOW_MS);
  assert.equal(second.gesture, true);
});

test("two presses outside the window are two separate sends", () => {
  const { first, second } = twoPresses(DOUBLE_ENTER_WINDOW_MS + 1);
  assert.equal(first.gesture, false);
  assert.equal(second.gesture, false, "jenseits des Fensters ist es ein neuer Anfang");
  assert.equal(second.state.lastEnterAtMs, 1_000 + DOUBLE_ENTER_WINDOW_MS + 1);
});

test("a press with an empty draft is ignored and does not arm the next one", () => {
  const empty = classifyEnter(createEnterGestureState(), { nowMs: 1_000, ...DRAFT, hasDraft: false });
  assert.deepEqual(empty.action, { kind: "ignore" });
  assert.equal(empty.state.lastEnterAtMs, null, "ein leeres Feld setzt die Zaehlung zurueck");

  // Ein Anschlag 100 ms spaeter mit Inhalt ist deshalb der *erste* — nicht der
  // Abschluss einer Geste, die mit dem leeren Feld angefangen haette.
  const next = classifyEnter(empty.state, { nowMs: 1_100, ...DRAFT });
  assert.equal(next.gesture, false);
});

test("a press while composing is ignored and does not arm the next one", () => {
  const composing = classifyEnter(createEnterGestureState(), { nowMs: 1_000, ...DRAFT, isComposing: true });
  assert.deepEqual(composing.action, { kind: "ignore" });
  assert.equal(composing.state.lastEnterAtMs, null);

  const next = classifyEnter(composing.state, { nowMs: 1_050, ...DRAFT });
  assert.equal(next.gesture, false, "das Enter eines IME-Kandidaten ist keine halbe Geste");
});

test("a press while disabled is ignored", () => {
  const decided = classifyEnter(createEnterGestureState(), { nowMs: 1_000, ...DRAFT, disabled: true });
  assert.deepEqual(decided.action, { kind: "ignore" });
  assert.equal(decided.state.lastEnterAtMs, null);
});

test("the counter restarts after a gesture, so a third press is not a gesture", () => {
  // Drei schnelle Anschlaege sind eine Geste plus ein neuer Anfang — nicht
  // zwei Gesten. Sonst waere ein zitternder Finger ein zweiter Steer.
  const first = classifyEnter(createEnterGestureState(), { nowMs: 1_000, ...DRAFT });
  const second = classifyEnter(first.state, { nowMs: 1_100, ...DRAFT });
  const third = classifyEnter(second.state, { nowMs: 1_200, ...DRAFT });
  assert.equal(second.gesture, true);
  assert.equal(third.gesture, false, "nach der Geste faengt die Zaehlung neu an");
  assert.equal(third.state.lastEnterAtMs, 1_200);
});

test("the no-turn case behaves like one send: the gesture is reported, not a second action", () => {
  // Der Aufrufer unterscheidet die Faelle an `gesture` und am leeren Feld:
  // `default` + `gesture: true` heisst "das war der Abschluss der Geste, das
  // erste Enter hat gesendet". Es gibt keinen zweiten Aktionswert, den ein
  // Aufrufer versehentlich als "nochmal senden" lesen koennte.
  const { first, second } = twoPresses(120);
  assert.deepEqual(first.action, { kind: "default" });
  assert.deepEqual(second.action, { kind: "default" });
  assert.equal(second.gesture, true);
});
