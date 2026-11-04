// useAudio hat bisher keinen eigenen Test. playTone/play laufen nur im
// Browser-Pfad; hier gegen einen AudioContext-Stub, inklusive Suspended- und
// Closed-Zustand und des Fehlers, wenn der Konstruktor wirft.
import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

const ROOT = new globalThis.URL("..", import.meta.url).pathname;
const jiti = createJiti(`${ROOT}package.json`, { jsx: { runtime: "automatic" }, tsconfigPaths: true });

const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
const ORIGINALS = { window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage, AudioContext: globalThis.AudioContext };
const store = new Map();
const localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
  removeItem: (key) => { store.delete(key); },
};
const tones = [];
class FakeAudioContext {
  static instances = [];
  static fail = false;
  constructor() {
    if (FakeAudioContext.fail) throw new Error("kein Audio");
    this.state = "suspended";
    this.currentTime = 0;
    this.destination = {};
    this.resumeCalls = 0;
    FakeAudioContext.instances.push(this);
  }
  resume() { this.resumeCalls += 1; this.state = "running"; return Promise.resolve(); }
  createOscillator() {
    const osc = {
      type: "sine",
      frequency: { value: 0 },
      connect() {},
      start: (t) => tones.push(["start", t]),
      stop: (t) => tones.push(["stop", t]),
    };
    return osc;
  }
  createGain() {
    return {
      gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {},
    };
  }
}

globalThis.window = win;
globalThis.document = win.document;
globalThis.localStorage = localStorage;
win.localStorage = localStorage;
globalThis.AudioContext = FakeAudioContext;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { useAudio } = await jiti.import(`${ROOT}hooks/useAudio.ts`);

test.after(() => {
  for (const [key, value] of Object.entries(ORIGINALS)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});

test("spielt nur bei aktiviertem Ton, entsperrt den Context und ueberlebt ein geschlossenes Audio", async () => {
  store.set("omp-sound-enabled", "false");
  tones.length = 0;
  const seen = [];
  function Probe() {
    seen.push(useAudio());
    return React.createElement("span", null, String(seen.at(-1).soundEnabled));
  }
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(Probe)); });
  assert.equal(seen.at(-1).soundEnabled, false);

  // Aus: kein AudioContext, kein Ton.
  await act(async () => { seen.at(-1).playDoneSound(); });
  assert.equal(FakeAudioContext.instances.length, 0);

  // Einschalten entsperrt und persistiert.
  await act(async () => { seen.at(-1).onSoundToggle(); });
  assert.equal(seen.at(-1).soundEnabled, true);
  assert.equal(store.get("omp-sound-enabled"), "true");
  const ctx = FakeAudioContext.instances.at(-1);
  assert.equal(ctx.resumeCalls, 1);

  // Laufender Context: zwei Oszillatoren, Start/Stop geplant.
  await act(async () => { seen.at(-1).playDoneSound(); });
  assert.equal(tones.filter(([kind]) => kind === "start").length, 2);
  assert.equal(tones.filter(([kind]) => kind === "stop").length, 2);

  // Suspended: resume().then(play) — der Ton kommt nach dem Microtask.
  ctx.state = "suspended";
  const before = tones.length;
  await act(async () => { seen.at(-1).playDoneSound(); await Promise.resolve(); await Promise.resolve(); });
  assert.equal(ctx.resumeCalls, 2);
  assert.equal(tones.length, before + 4);

  // Geschlossener Context wird ersetzt statt weiterbenutzt.
  ctx.state = "closed";
  await act(async () => { seen.at(-1).playDoneSound(); });
  assert.equal(FakeAudioContext.instances.length, 2);

  // Wirft der Konstruktor, bleibt der Ton aus statt zu stuerzen.
  FakeAudioContext.fail = true;
  FakeAudioContext.instances.at(-1).state = "closed";
  await act(async () => { seen.at(-1).playDoneSound(); seen.at(-1).unlockAudio(true); });
  FakeAudioContext.fail = false;

  await act(async () => { root.unmount(); });
  container.remove();
});
