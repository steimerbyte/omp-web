import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";

/**
 * Der Doppel-Enter im echten Handler von `ChatInput`.
 *
 * ### Warum ein gemounteter Handler und nicht nur die reine Funktion
 *
 * `lib/chat-input-enter.test.mjs` beweist den Zeitvergleich. Was dort nicht
 * sichtbar wird, ist die Naht dazwischen: dass der Handler den zweiten
 * Anschlag **verbraucht** und nicht sendet. Genau dort sitzt der Fehler, den
 * diese Geste reparieren muss — zwei Anschlaege im selben Frame sehen beide
 * noch denselben `value`, und ohne die Sperre ginge derselbe Text zweimal
 * hinaus. Ein Test der reinen Funktion kann das nicht finden.
 *
 * Der Aufbau ist derselbe wie in `ChatInput.gradient-border.test.mjs`:
 * linkedom, `act`, ein gemountetes `ChatInput` mit Attrappen fuer `onSend`,
 * `onSteer` und `onFollowUp`.
 */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };
globalThis.window = new Proxy(dom.window, {
  get(target, prop) {
    if (prop === "navigator") return fakeNavigator;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
globalThis.document = dom.document;
globalThis.navigator = fakeNavigator;

const storage = new Map();
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  clear: () => { storage.clear(); },
};
globalThis.localStorage = localStorage;
dom.window.localStorage = localStorage;
globalThis.CSS = { supports: () => true, registerProperty: () => {} };
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { clearDraft } = await jiti.import("../lib/draft-store.ts");
const { createRoot } = await import("react-dom/client");

const mountedRoots = [];

/**
 * Ein aufgebautes Eingabefeld.
 *
 * `sent` sammelt, was der Handler nach aussen gibt: `onSend` im Leerlauf,
 * `onSteer`/`onFollowUp` waehrend eines Turns. Die Nummer im Text sagt, welcher
 * Anschlag gemeint war — so ist "zweimal gesendet" von "einmal gesendet"
 * unterscheidbar, ohne die Uhr zu befragen.
 */
async function mountInput(props = {}) {
  const sent = { sends: [], steers: [], follows: [] };
  const handle = React.createRef();
  const container = document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(ChatInput, {
      ref: handle,
      onSend: (message) => sent.sends.push(message),
      onAbort() {},
      onSteer: (message) => sent.steers.push(message),
      onFollowUp: (message) => sent.follows.push(message),
      modelList: [],
      modelNames: {},
      ...props,
    })));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  const textarea = container.querySelector("textarea");
  assert.ok(textarea, "das Eingabefeld wurde gerendert");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return { container, sent, textarea, handle };
}

/**
 * Text eingeben — ueber das `onChange` des Feldes, wie ein Tastendruck es tut.
 *
 * Damit laeuft derselbe Pfad wie beim Menschen: `setValue` **und**
 * `valueRef` werden gesetzt. Ein direkt gesetztes `textarea.value` liaesse
 * `valueRef` auf dem alten Stand und wuerde den Fehler verstecken, um den
 * diese Geste herumgebaut ist.
 */
async function type(textarea, text) {
  const { props } = reactHandler(textarea, "onChange");
  await act(async () => {
    props.onChange({ target: { value: text }, currentTarget: textarea, nativeEvent: {} });
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

/**
 * Der React-Handler eines Knotens.
 *
 * linkedom und React DOM 19 koennen ein Event auf einem Formularelement nicht
 * gemeinsam zustellen: `dispatchEvent` auf dem `<textarea>` scheitert in
 * Reacts eigenem Event-System (`inst.tag` ist `null`, weil linkedom das Ziel
 * nicht zur Fiber zurueckfuehrt). Auf einem `<div>` ginge es — der Fehler
 * haengt am Element, nicht am Framework.
 *
 * Deshalb wird der Handler ueber die React-Props des Knotens aufgerufen. Das
 * ist genau der Weg, den `dispatchEvent` sonst nimmt, nur ohne die
 * Uebersetzung, die hier fehlt; `act` ist derselbe Rahmen. Der Aufruf sieht
 * das Ereignisobjekt, das der Handler auch im Browser sieht (`key`,
 * `shiftKey`, `nativeEvent`, `preventDefault`, `currentTarget`).
 */
function reactHandler(element, name) {
  const key = Object.keys(element).find((k) => k.startsWith("__reactProps"));
  assert.ok(key, `kein React-Props-Objekt an ${name}`);
  const handler = element[key][name];
  return { handler, props: element[key] };
}

/** Ein Enter, so wie React ihn dem Handler reicht. */
async function pressEnter(textarea, extra = {}) {
  const { handler } = reactHandler(textarea, "onKeyDown");
  assert.equal(typeof handler, "function", "das Feld hat einen onKeyDown-Handler");
  await act(async () => {
    handler({
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      nativeEvent: { isComposing: false, keyCode: 13 },
      preventDefault() {},
      currentTarget: textarea,
      target: textarea,
      ...extra,
    });
  });
}

/**
 * Zwei Enter-Anschlaege **ohne Rerender dazwischen** — der harte Fall.
 *
 * In zwei getrennten `act`-Aufrufen flusht React den Zustand zwischendurch,
 * also sieht der zweite Anschlag das geleerte Feld und der Test waere gruen,
 * egal wie der Handler gebaut ist. Der Fall, um den es hier geht, ist der
 * ohne Flush: dann ist `value` aus dem Abschluss des letzten Renderns noch der
 * alte Text, und nur wer synchron (`valueRef`) liest, sieht das Leerzeichen.
 *
 * Genau dieser Unterschied ist der Zweck des Tests: er faellt, sobald der
 * Handler wieder den gerenderten `value` befragt.
 */
async function pressEnterTwice(textarea) {
  const { handler } = reactHandler(textarea, "onKeyDown");
  const makeEvent = () => ({
    key: "Enter",
    shiftKey: false,
    isComposing: false,
    nativeEvent: { isComposing: false, keyCode: 13 },
    preventDefault() {},
    currentTarget: textarea,
    target: textarea,
  });
  await act(async () => {
    handler(makeEvent());
    handler(makeEvent());
  });
}

test.afterEach(async () => {
  for (const root of mountedRoots.splice(0)) {
    await act(async () => { root.unmount(); });
  }
  storage.clear();
  clearDraft("enter-gesture-test");
});

test("a single Enter in an idle composer sends once", async () => {
  const { sent, textarea } = await mountInput({ draftKey: "enter-gesture-test" });
  await type(textarea, "EINE Nachricht");
  await pressEnter(textarea);

  assert.deepEqual(sent.sends, ["EINE Nachricht"], "genau ein Senden");
  assert.deepEqual(sent.steers, [], "ohne laufenden Turn wird nicht gesteuert");
});

test("a single Enter while a turn runs steers — the existing path, unchanged", async () => {
  const { sent, textarea } = await mountInput({ isStreaming: true, draftKey: "enter-gesture-test" });
  await type(textarea, "STEUERUNG eins");
  await pressEnter(textarea);

  assert.deepEqual(sent.steers, ["STEUERUNG eins"], "ein Enter waehrend eines Turns steuert");
  assert.deepEqual(sent.sends, [], "und sendet nicht als neuen Prompt");
});

test("two Enter presses while a turn runs steer exactly once", async () => {
  // Der Kern: der zweite Anschlag ist die Geste und darf den Text nicht ein
  // zweites Mal in den Steuerkanal legen. Zweimal gesteuert hiesse zweimal
  // derselbe Satz im Transkript.
  const { sent, textarea } = await mountInput({ isStreaming: true, draftKey: "enter-gesture-test" });
  await type(textarea, "STEUERUNG doppelt");
  await pressEnterTwice(textarea);

  assert.deepEqual(sent.steers, ["STEUERUNG doppelt"], "genau ein Steer");
  assert.deepEqual(sent.sends, [], "kein zusaetzlicher Prompt");
});

test("two Enter presses with an idle agent send exactly once", async () => {
  // Der Leerlauf-Fall: der zweite Anschlag wird von der Geste verbraucht. Das
  // Feld ist nach dem ersten Anschlag leer, und `hasDraft` haelt ihn zusaetzlich
  // zurueck — zwei Sicherungen fuer dieselbe Zusage.
  const { sent, textarea } = await mountInput({ draftKey: "enter-gesture-test" });
  await type(textarea, "IDLE doppelt");
  await pressEnterTwice(textarea);

  assert.deepEqual(sent.sends, ["IDLE doppelt"], "genau ein Senden, nicht zwei");
  assert.deepEqual(sent.steers, []);
});

test("Shift+Enter still inserts a newline and sends nothing", async () => {
  const { sent, textarea } = await mountInput({ draftKey: "enter-gesture-test" });
  await type(textarea, "erste Zeile");
  await pressEnter(textarea, { shiftKey: true });
  assert.deepEqual(sent.sends, [], "Shift+Enter sendet nicht");
  assert.deepEqual(sent.steers, []);
});

test("Enter during IME composition neither sends nor steers", async () => {
  // Ein Enter, das einen chinesischen oder japanischen Kandidaten bestaetigt,
  // ist keine Eingabe. Der Handler liest dafuer `isComposing` aus dem Event
  // und den Ref; hier wird der Event-Weg geprueft, weil das der ist, den der
  // Browser bei einer echten Zusammensetzung schickt.
  const { sent, textarea } = await mountInput({ isStreaming: false, draftKey: "enter-gesture-test" });
  await type(textarea, "zhong");
  // Der Handler liest `nativeEvent.isComposing` (und `keyCode === 229`) — das
  // ist der Punkt, an dem ein echter Browser eine laufende Zusammensetzung
  // meldet. Ein `isComposing` auf dem synthetischen React-Event waere die
  // falsche Stelle und wuerde hier gruen, ohne dass der echte Fall gedeckt ist.
  await pressEnter(textarea, { nativeEvent: { isComposing: true, keyCode: 13 } });
  assert.deepEqual(sent.sends, [], "das Enter eines IME-Kandidaten sendet nicht");
  assert.deepEqual(sent.steers, []);
});

test("an empty composer does not send on a double Enter", async () => {
  const { sent, textarea } = await mountInput({ isStreaming: true, draftKey: "enter-gesture-test" });
  await pressEnterTwice(textarea);
  assert.deepEqual(sent.steers, [], "ohne Text gibt es nichts zu steuern");
  assert.deepEqual(sent.sends, []);
});

test("a third Enter does not steer a second time", async () => {
  // Drei Anschlaege sind eine Geste und ein neuer Anfang. Ein zitternder
  // Finger darf keinen zweiten Steer ausloesen.
  const { sent, textarea } = await mountInput({ isStreaming: true, draftKey: "enter-gesture-test" });
  await type(textarea, "STEUERUNG drei");
  await pressEnter(textarea);
  await pressEnter(textarea);
  await pressEnter(textarea);
  assert.deepEqual(sent.steers, ["STEUERUNG drei"], "nur der erste Anschlag steuert");
});
