import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React from "react";
import { createJiti } from "jiti";

/**
 * Die Browser-Bindung der Erinnerungen — montiert, nicht im Quelltext gelesen.
 *
 * ### Was hier gemessen wird
 *
 * Der Hook hat genau drei Aufgaben, und keine davon ist im Quelltext
 * sichtbar: eine Benachrichtigung zeigen, sie **nicht** zweimal zeigen, und
 * den Timer auf den naechsten Zeitpunkt stellen. Ein Test, der nur die
 * Logik in `lib/calendar-reminders.ts` prueft, wuerde keine dieser drei
 * Fragen beantworten.
 *
 * Deshalb steht hier ein `Notification`-Stub, der die gezeigten
 * Benachrichtigungen mitschreibt, ein `localStorage` aus einer `Map` und
 * eine **gestellt Uhr**: `Date.now` liefert eine Zahl, die der Test
 * weiterdreht. Damit ist ein Termin „in 30 Sekunden" ohne echtes Warten
 * faellig — und der Timer, den der Hook stellt, feuert im echten
 * `setTimeout` des Prozesses.
 */

/* ------------------------------------------------------------------ *
 * Das Fenster
 * ------------------------------------------------------------------ */

const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;

/** Der Speicher des Tabs — dieselbe Form, die der Hook erwartet. */
const storage = new Map();
win.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
};

/** Die Benachrichtigungen, die der Hook gezeigt hat. */
const shown = [];

/**
 * Der `Notification`-Stub.
 *
 * `permission` ist der Wert, den `Notification.permission` liefert;
 * `requestPermission` loest auf denselben Wert auf, wie es ein Browser nach
 * einem Klick tut.
 */
class FakeNotification {
  static permission = "default";
  static requestPermission = () => Promise.resolve(FakeNotification.permission);
  constructor(title, options) {
    shown.push({ title, options });
  }
}

const REAL_NOTIFICATION = FakeNotification;
win.Notification = FakeNotification;

// Die `notification`-Eigenschaft des Proxys ist **nicht** gebunden: eine
// `bind`-Huelle verliert die statischen Felder (`permission`), und genau
// die liest der Hook.
globalThis.window = new Proxy(win, {
  get(target, prop) {
    return Reflect.get(target, prop, target);
  },
});
globalThis.document = win.document;
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };

/* ------------------------------------------------------------------ *
 * Die Uhr
 * ------------------------------------------------------------------ */

/** Die echte Uhr, die am Ende jedes Tests zurueckkommt. */
const realNow = Date.now;

/** Die gestellte Uhr — der Test dreht sie weiter. */
let clock = 0;

/* ------------------------------------------------------------------ *
 * Der Hook
 * ------------------------------------------------------------------ */

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { useCalendarReminders } = await jiti.import("./useCalendarReminders.ts");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

/** Ein Zeitstempel aus lokaler Wanduhr — dieselbe Rechnung wie im Hook. */
function at(year, month, day, hours = 0, minutes = 0) {
  return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime();
}

/** Ein Termin mit Uhrzeit und einer Erinnerung 15 Minuten vorher. */
function reminderEvent(overrides = {}) {
  return {
    id: "ev-1",
    title: "Zahnarzt",
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:00",
    allDay: false,
    reminders: [{ minutesBefore: 15 }],
    createdAt: "2026-03-01T09:00:00.000Z",
    updatedAt: "2026-03-01T09:00:00.000Z",
    ...overrides,
  };
}

/** Der Zeitpunkt der Erinnerung aus `reminderEvent`. */
const REMINDER_AT = at(2026, 3, 14, 14, 45);

/** Haelt den zuletzt gerenderten Zustand des Hooks. */
function Probe({ sink, events }) {
  sink.current = useCalendarReminders(events);
  return null;
}

/** Setzt Speicher, Benachrichtigungen und die Uhr auf einen sauberen Stand. */
function reset(permission) {
  storage.clear();
  shown.length = 0;
  FakeNotification.permission = permission;
  FakeNotification.requestPermission = () => Promise.resolve(FakeNotification.permission);
  win.Notification = REAL_NOTIFICATION;
  globalThis.Date.now = () => clock;
}

/** Montiert den Hook und liefert den Zustand plus die Wurzel zum Abbauen. */
async function mount(events) {
  const sink = { current: null };
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Probe, { sink, events }));
  });
  return { sink, root };
}

/** Ein Tick, damit Versprechen und Effekte verarbeitet werden. */
async function tick() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Baut die Wurzel ab — und mit ihr beide Effekte des Hooks. */
async function unmount(root) {
  await act(async () => {
    root.unmount();
  });
}

/* ------------------------------------------------------------------ *
 * Die Tests
 * ------------------------------------------------------------------ */

test("a due reminder is shown with its key as the tag, and only once", async () => {
  // Die Erinnerung ist 30 Sekunden vorbei — innerhalb der Zehn-Minuten-Regel.
  clock = REMINDER_AT + 30_000;
  reset("granted");
  const { sink, root } = await mount([reminderEvent()]);
  try {
    assert.equal(sink.current.permission, "granted");
    assert.equal(shown.length, 1, "genau eine Benachrichtigung");
    assert.equal(shown[0].title, "Zahnarzt");
    assert.equal(shown[0].options.body, "in 15 Minuten · 15:00");
    assert.equal(shown[0].options.tag, `ev-1@${REMINDER_AT}`);
    assert.deepEqual(JSON.parse(storage.get("omp-calendar-fired")), [`ev-1@${REMINDER_AT}`]);
  } finally {
    await unmount(root);
  }

  // Ein Neuladen ist ein neuer Mount: der Schluessel steht im Speicher.
  const second = await mount([reminderEvent()]);
  try {
    assert.equal(shown.length, 1, "kein zweites Feuern nach dem Neuladen");
  } finally {
    await unmount(second.root);
  }
});

test("the timer fires the reminder when its moment comes", async () => {
  // Die Uhr steht 20 ms vor dem Zeitpunkt: der Hook stellt den Timer auf 20 ms.
  clock = REMINDER_AT - 20;
  reset("granted");
  const { root } = await mount([reminderEvent()]);
  try {
    assert.equal(shown.length, 0, "noch nicht faellig");
    // Die Uhr geht weiter; der Timer feuert gleich darauf und liest sie neu.
    clock = REMINDER_AT + 1_000;
    // Warten, bis der gestellte Timer feuert — nicht auf eine feste Zahl von
    // Millisekunden hoffen: unter acht parallelen Workern ist der Prozess
    // ausgelastet, und ein 20-ms-Timer kann deutlich spaeter dran sein.
    const deadline = realNow() + 5_000;
    await act(async () => {
      while (shown.length === 0 && realNow() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });
    assert.equal(shown.length, 1);
    assert.equal(shown[0].options.tag, `ev-1@${REMINDER_AT}`);
  } finally {
    await unmount(root);
  }
});

test("the permission is only asked for from a call, never on mount", async () => {
  clock = REMINDER_AT - 60_000;
  reset("default");
  let asked = 0;
  FakeNotification.requestPermission = () => {
    asked += 1;
    FakeNotification.permission = "granted";
    return Promise.resolve("granted");
  };
  const { sink, root } = await mount([reminderEvent()]);
  try {
    assert.equal(sink.current.permission, "default");
    assert.equal(sink.current.hasUpcoming, true, "es gibt eine kuenftige Erinnerung");
    assert.equal(asked, 0, "der Mount fragt nicht");
    assert.equal(shown.length, 0);
    sink.current.requestPermission();
    await tick();
    assert.equal(asked, 1, "der Klick fragt");
    assert.equal(sink.current.permission, "granted");
  } finally {
    await unmount(root);
  }
});

test("without a Notification API nothing happens and nothing crashes", async () => {
  clock = REMINDER_AT + 30_000;
  reset("granted");
  delete win.Notification;
  const { sink, root } = await mount([reminderEvent()]);
  try {
    assert.equal(sink.current.permission, "unsupported");
    assert.equal(shown.length, 0);
    // Der Knopf darf den Hook auch dann aufrufen, wenn es keine API gibt.
    sink.current.requestPermission();
    await tick();
    assert.equal(sink.current.permission, "unsupported");
  } finally {
    await unmount(root);
  }
});

test("a tab coming back from the background checks the clock again", async () => {
  // Eine Stunde vor dem Zeitpunkt: der Timer steht auf eine Stunde.
  clock = REMINDER_AT - 3_600_000;
  reset("granted");
  const { root } = await mount([reminderEvent()]);
  try {
    assert.equal(shown.length, 0);
    // Der Tab war im Hintergrund, die Uhr ist weitergegangen.
    clock = REMINDER_AT + 5_000;
    await act(async () => {
      win.document.dispatchEvent(new win.Event("visibilitychange"));
    });
    assert.equal(shown.length, 1);
    assert.equal(shown[0].options.tag, `ev-1@${REMINDER_AT}`);
  } finally {
    await unmount(root);
  }
});

test("events that arrive later arm the timer, and no events do nothing", async () => {
  clock = REMINDER_AT - 60_000;
  reset("granted");
  const sink = { current: null };
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  try {
    // `null` heisst „noch nicht geladen".
    await act(async () => {
      root.render(React.createElement(Probe, { sink, events: null }));
    });
    assert.equal(sink.current.hasUpcoming, false);
    assert.equal(shown.length, 0);
    // Jetzt kommen die Termine — der Effekt laeuft neu und stellt den Timer.
    await act(async () => {
      root.render(React.createElement(Probe, { sink, events: [reminderEvent()] }));
    });
    assert.equal(sink.current.hasUpcoming, true);
    clock = REMINDER_AT + 1_000;
    await act(async () => {
      win.document.dispatchEvent(new win.Event("visibilitychange"));
    });
    assert.equal(shown.length, 1);
  } finally {
    await unmount(root);
  }
});

test("the stored keys are dropped after a day", async () => {
  // Ein Schluessel von gestern: er wird beim Schreiben des naechsten nicht
  // mehr mitgeschleppt, sonst waechst der Speicher unbegrenzt.
  const stale = `ev-old@${REMINDER_AT - 2 * 86_400_000}`;
  storage.set("omp-calendar-fired", JSON.stringify([stale]));
  clock = REMINDER_AT + 30_000;
  reset("granted");
  storage.set("omp-calendar-fired", JSON.stringify([stale]));
  const { root } = await mount([reminderEvent()]);
  try {
    assert.equal(shown.length, 1);
    assert.deepEqual(JSON.parse(storage.get("omp-calendar-fired")), [`ev-1@${REMINDER_AT}`]);
  } finally {
    await unmount(root);
  }
});

test("the real clock comes back at the end", () => {
  globalThis.Date.now = realNow;
  assert.equal(typeof Date.now(), "number");
});
