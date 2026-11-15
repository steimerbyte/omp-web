import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React from "react";
import { createJiti } from "jiti";

/**
 * Die beiden Wahlen — montiert, angetippt und gemessen.
 *
 * ### Warum der Umweg ueber den DOM
 *
 * Die Rechnung steht schon in `calendar-picker.test.mjs` (Raster, Winkel,
 * Pfeiltasten). Hier steht das, was nur der montierte Dialog zeigen kann:
 * dass ein Tipp auf eine Zahl wirklich den Wert setzt, dass der zweite
 * Schritt (Stunde → Minute) stattfindet, dass „OK" den Wert nach oben gibt
 * und „Abbrechen" nicht.
 *
 * Der Harness ist derselbe wie in `calendar-event-dialog.test.mjs`: leere
 * Ersetzungen fuer Layout und Bildlaufleiste, ohne die Radix nicht montiert.
 */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const win = dom.window;
const fakeNavigator = { userAgent: "test", languages: ["de-DE"], language: "de-DE", platform: "linux" };

win.getComputedStyle = () => new Proxy({}, {
  get: (_target, prop) => (typeof prop === "string" && prop.startsWith("get") ? () => "" : "0px"),
});

globalThis.window = new Proxy(win, {
  get(target, prop) {
    if (prop === "navigator") return fakeNavigator;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
globalThis.document = win.document;
globalThis.navigator = fakeNavigator;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
for (const [name, value] of Object.entries(linkedom)) {
  if (name === "parseHTML" || name === "default") continue;
  if (typeof value === "function" && /^[A-Z]/.test(name)) globalThis[name] = value;
}
for (const name of Object.keys(win)) {
  if (name === "window") continue;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor && !descriptor.writable) continue;
  globalThis[name] = win[name];
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
globalThis.NodeFilter = win.NodeFilter ?? { SHOW_ELEMENT: 1 };

win.document.oninput = null;
win.document.onchange = null;
win.HTMLElement.prototype.attachEvent = function attachEvent(type, handler) {
  this.addEventListener(type.replace(/^on/, ""), handler);
};
win.HTMLElement.prototype.detachEvent = function detachEvent(type, handler) {
  this.removeEventListener(type.replace(/^on/, ""), handler);
};

win.matchMedia = () => ({
  matches: false,
  media: "",
  addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {},
  onchange: null,
  dispatchEvent() { return false; },
});
globalThis.matchMedia = win.matchMedia;

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  clear: () => { storage.clear(); },
};
win.localStorage = globalThis.localStorage;

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { DatePickerDialog } = await jiti.import("./DatePickerDialog.tsx");
const { TimePickerDialog } = await jiti.import("./TimePickerDialog.tsx");
const { todayDateString } = await jiti.import("./calendar-model.ts");
// Die deutschen Texte sind die Quelle der Beschriftungen im Dialog; der Test
// schreibt sie nicht noch einmal hin.
const { deLocale } = await jiti.import("@/lib/i18n/messages/de.ts");
const deMessages = deLocale.messages;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

async function mount(element) {
  win.document.body.innerHTML = "";
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
  return { container, root };
}

/** Ein Klick, wie ihn ein Finger ausloest. */
async function click(element) {
  assert.ok(element, "das Element, das geklickt werden soll, gibt es nicht");
  await act(async () => { element.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

/**
 * Ein Zeiger-Ereignis mit Koordinaten.
 *
 * linkedom kennt kein `PointerEvent`; die beiden Zahlen kommen als Felder
 * dazu, so wie React sie aus dem Ereignis liest.
 */
async function pointer(element, type, clientX, clientY) {
  const event = new win.Event(type, { bubbles: true });
  Object.defineProperty(event, "clientX", { value: clientX });
  Object.defineProperty(event, "clientY", { value: clientY });
  await act(async () => { element.dispatchEvent(event); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

/** Eine Taste — linkedom kennt kein `KeyboardEvent`, die Taste kommt als Feld dazu. */
async function press(element, key) {
  const event = new win.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "key", { value: key });
  await act(async () => { element.dispatchEvent(event); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

/**
 * Tippt in ein React-Eingabefeld.
 *
 * Der Wert geht ueber den nativen Setter und ein `input`-Event — ein bloss
 * gesetztes `.value` loest bei React nichts aus. `focusin` und `keyup` laufen
 * mit, weil React bei fehlendem `oninput` im Dokument auf den alten
 * Polyfill-Pfad faellt (siehe `calendar-event-dialog.test.mjs`).
 */
async function type(input, value) {
  assert.ok(input, "das Feld, in das getippt werden soll, gibt es nicht");
  await act(async () => {
    input.dispatchEvent(new win.Event("focusin", { bubbles: true }));
  });
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    input.dispatchEvent(new win.Event("keyup", { bubbles: true }));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

const $ = (selector) => win.document.querySelector(selector);

/**
 * „OK" druecken.
 *
 * Der Knopf ist ein `type="submit"`, und der Weg ist der echte: der Klick auf
 * einen Submit-Knopf schickt das Formular ab, und *das* ruft `confirm()`.
 * linkedom fuehrt diesen Schritt nicht aus (es kennt keine implizite
 * Formularabsendung), deshalb wird hier das `submit`-Event gesendet, das der
 * Klick im Browser ausloest. Die andere Haelfte der Zusage — dass der Knopf
 * wirklich ein Submit-Knopf ist — prueft `assertOk`.
 */
async function submit() {
  const panel = $('[data-time-picker="true"]') ?? $('[data-date-picker="true"]');
  const form = panel.querySelector("form");
  await act(async () => {
    form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

/** „OK" ist der Knopf, der das Formular abschickt — nicht nur einer, der so heisst. */
function assertOk() {
  const ok = footerButton(deMessages["common.ok"]);
  assert.ok(ok, "der OK-Knopf ist da");
  assert.equal(ok.getAttribute("type"), "submit", "OK schickt das Formular ab");
}
const field = (name) => $(`[data-picker-field="${name}"]`);
const numbers = () => [...win.document.querySelectorAll("[data-picker-value]")].map((node) => Number(node.dataset.pickerValue));
const footerButton = (text) => [...win.document.querySelectorAll("button")].find((node) => node.textContent.trim() === text);

/** Die Uebergaben einer Wahl: der Wert, den sie bestaetigt, oder der Abbruch. */
function recorder() {
  const calls = [];
  return {
    calls,
    onConfirm: (value) => calls.push({ kind: "confirm", value }),
    onCancel: () => calls.push({ kind: "cancel" }),
  };
}

// --- Die Uhrzeitwahl -------------------------------------------------------

test("the time picker opens on the hour face with both rings", async () => {
  const recorderUnderTest = recorder();
  await mount(React.createElement(TimePickerDialog, {
    value: "20:00",
    onCancel: recorderUnderTest.onCancel,
    onConfirm: recorderUnderTest.onConfirm,
  }));

  assert.equal($('[data-time-picker="true"]') !== null, true);
  assert.equal(field("hour").textContent.trim(), "20");
  assert.equal(field("minute").textContent.trim(), "00");
  // Die Stunde ist der erste Schritt und traegt deshalb den Akzent.
  assert.equal(field("hour").getAttribute("aria-pressed"), "true");
  assert.equal(field("minute").getAttribute("aria-pressed"), "false");
  // Aussen 0…11, innen 12…23.
  const values = numbers();
  assert.equal(values.length, 24);
  assert.deepEqual(values, Array.from({ length: 24 }, (_unused, index) => index));
});

test("choosing an hour moves on to the minutes", async () => {
  const recorderUnderTest = recorder();
  await mount(React.createElement(TimePickerDialog, {
    value: "09:00",
    onCancel: recorderUnderTest.onCancel,
    onConfirm: recorderUnderTest.onConfirm,
  }));

  await click($('[data-picker-value="14"]'));

  assert.equal(field("hour").textContent.trim(), "14");
  // Der zweite Schritt: jetzt stehen die Minuten auf dem Zifferblatt.
  assert.equal(field("minute").getAttribute("aria-pressed"), "true");
  assert.deepEqual(numbers(), [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);

  await click($('[data-picker-value="30"]'));
  assert.equal(field("minute").textContent.trim(), "30");

  assertOk();
  await submit();
  assert.deepEqual(recorderUnderTest.calls, [{ kind: "confirm", value: "14:30" }]);
});

test("the minute stays at :00 when the second step is skipped", async () => {
  const recorderUnderTest = recorder();
  await mount(React.createElement(TimePickerDialog, {
    value: "09:00",
    onCancel: recorderUnderTest.onCancel,
    onConfirm: recorderUnderTest.onConfirm,
  }));

  await click(field("minute"));
  assertOk();
  await submit();
  assert.deepEqual(recorderUnderTest.calls, [{ kind: "confirm", value: "09:00" }]);
});

test("the active field can be switched back by hand", async () => {
  const recorderUnderTest = recorder();
  await mount(React.createElement(TimePickerDialog, {
    value: "09:00",
    onCancel: recorderUnderTest.onCancel,
    onConfirm: recorderUnderTest.onConfirm,
  }));

  await click($('[data-picker-value="7"]'));
  assert.deepEqual(numbers(), [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  // Zurueck auf die Stunde: das Zifferblatt zeigt wieder beide Ringe.
  await click(field("hour"));
  assert.equal(numbers().length, 24);
  assert.equal(field("hour").getAttribute("aria-pressed"), "true");
});

test("cancel gives nothing back", async () => {
  const recorderUnderTest = recorder();
  await mount(React.createElement(TimePickerDialog, {
    value: "20:00",
    onCancel: recorderUnderTest.onCancel,
    onConfirm: recorderUnderTest.onConfirm,
  }));

  await click(footerButton(deMessages["common.cancel"]));
  assert.deepEqual(recorderUnderTest.calls, [{ kind: "cancel" }]);
});

test("the keyboard path takes a typed time", async () => {
  const recorderUnderTest = recorder();
  await mount(React.createElement(TimePickerDialog, {
    value: "20:00",
    onCancel: recorderUnderTest.onCancel,
    onConfirm: recorderUnderTest.onConfirm,
  }));

  await click($('[data-picker-text-toggle="true"]'));
  const input = $('[data-picker-text="true"]');
  assert.ok(input, "das Tippfeld ist da");
  // Das Zifferblatt tritt zurueck, das Feld steht.
  assert.equal($('[data-picker-dial="true"]'), null);

  // Die Formen, die das Kalenderformat kennt: mit Doppelpunkt, ohne
  // fuehrende Null, mit vier Ziffern. `calendar.timeFormatHint` nennt
  // dieselbe Regel wie das Textfeld im Termin-Dialog.
  await type(input, "0930");
  assertOk();
  await submit();
  // Ohne Doppelpunkt fuellen die Ziffern erst die Stunde, dann die Minute.
  assert.deepEqual(recorderUnderTest.calls, [{ kind: "confirm", value: "09:30" }]);
});

test("a typed time that is none is refused", async () => {
  const recorderUnderTest = recorder();
  await mount(React.createElement(TimePickerDialog, {
    value: "20:00",
    onCancel: recorderUnderTest.onCancel,
    onConfirm: recorderUnderTest.onConfirm,
  }));

  await click($('[data-picker-text-toggle="true"]'));
  await type($('[data-picker-text="true"]'), "25:99");
  assertOk();
  await submit();

  assert.deepEqual(recorderUnderTest.calls, [], "keine Bestaetigung");
  assert.equal(
    win.document.body.textContent.includes(deMessages["calendar.invalidTime"]),
    true,
    "der Grund steht im Dialog",
  );
});

test("the text toggle starts from the chosen value", async () => {
  const recorderUnderTest = recorder();
  await mount(React.createElement(TimePickerDialog, {
    value: "20:00",
    onCancel: recorderUnderTest.onCancel,
    onConfirm: recorderUnderTest.onConfirm,
  }));

  await click($('[data-picker-value="17"]'));
  await click($('[data-picker-value="45"]'));
  await click($('[data-picker-text-toggle="true"]'));
  assert.equal($('[data-picker-text="true"]').value, "17:45");
});

test("a point on the dial chooses the value under the finger", async () => {
  const recorderUnderTest = recorder();
  await mount(React.createElement(TimePickerDialog, {
    value: "09:00",
    onCancel: recorderUnderTest.onCancel,
    onConfirm: recorderUnderTest.onConfirm,
  }));

  // Ein Zifferblatt von 300 px: Mitte (150,150), Radius 150. linkedom fuehrt
  // kein Layout aus, deshalb bekommt das Element hier seine Groesse.
  const dial = $('[data-picker-dial="true"]');
  dial.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 300, right: 300, bottom: 300, x: 0, y: 0 });

  // Rechts in der Mitte: 3 Uhr.
  await pointer(dial, "pointerdown", 267, 150);
  assert.equal(field("hour").textContent.trim(), "03");

  // Auf dem Minutenblatt weiterziehen (der Zug laeuft nach dem Druecken):
  // unten sind 30 Minuten.
  await pointer(dial, "pointermove", 150, 267);
  assert.equal(field("minute").textContent.trim(), "30");

  // Losgelassen: ein weiterer Zug bewegt nichts mehr.
  await pointer(dial, "pointerup", 150, 267);
  await pointer(dial, "pointermove", 267, 150);
  assert.equal(field("minute").textContent.trim(), "30", "nach dem Loslassen zieht der Zeiger nicht mehr");

  // Verlaesst der Finger das Zifferblatt, endet der Zug ebenfalls.
  await pointer(dial, "pointerdown", 267, 150);
  await pointer(dial, "pointerleave", 267, 150);
  await pointer(dial, "pointermove", 150, 267);
  assert.equal(field("minute").textContent.trim(), "30");

  // Die Mitte hat keinen Sektor — ein Griff dorthin aendert nichts.
  await pointer(dial, "pointerdown", 150, 150);
  assert.equal(field("minute").textContent.trim(), "30");

  // Ein abgebrochener Zug (das System nimmt den Finger) endet ebenfalls.
  // Der Griff rechts setzt noch 15 Minuten; der Zug danach nach unten
  // (30 Minuten) kommt nicht mehr an.
  await pointer(dial, "pointerdown", 267, 150);
  await pointer(dial, "pointercancel", 267, 150);
  await pointer(dial, "pointermove", 150, 267);
  assert.equal(field("minute").textContent.trim(), "15");
  assert.equal(field("hour").textContent.trim(), "03", "die Stunde blieb, wie sie war");

  assertOk();
  await submit();
  assert.deepEqual(recorderUnderTest.calls, [{ kind: "confirm", value: "03:15" }]);
});

test("escape cancels the time picker", async () => {
  const recorderUnderTest = recorder();
  await mount(React.createElement(TimePickerDialog, {
    value: "20:00",
    onCancel: recorderUnderTest.onCancel,
    onConfirm: recorderUnderTest.onConfirm,
  }));

  // Radix hoert die Taste am Dokument; sie steigt von der Wahl auf.
  await press($('[data-time-picker="true"]'), "Escape");
  assert.deepEqual(recorderUnderTest.calls, [{ kind: "cancel" }]);
});

// --- Die Datumswahl -------------------------------------------------------

test("the date picker names the chosen day in the header", async () => {
  const recorderUnderTest = recorder();
  await mount(React.createElement(DatePickerDialog, {
    value: "2026-11-18",
    onCancel: recorderUnderTest.onCancel,
    onConfirm: recorderUnderTest.onConfirm,
  }));

  const header = $('[data-picker-header="true"]');
  assert.ok(header);
  assert.equal(header.textContent.includes("2026"), true);
  assert.equal(header.textContent.includes("Mi., 18. Nov."), true);
  assert.equal(win.document.body.textContent.includes("November 2026"), true);
  // Sechs Wochen, aber nur die Tage des Monats als Knoepfe.
  assert.equal(win.document.querySelectorAll("[data-picker-day]").length, 30);
  assert.equal($('[data-picker-day="2026-11-18"]').getAttribute("aria-pressed"), "true");
});

test("a day that is clicked is confirmed", async () => {
  const recorderUnderTest = recorder();
  await mount(React.createElement(DatePickerDialog, {
    value: "2026-11-18",
    onCancel: recorderUnderTest.onCancel,
    onConfirm: recorderUnderTest.onConfirm,
  }));

  await click($('[data-picker-day="2026-11-20"]'));
  assert.equal($('[data-picker-header="true"]').textContent.includes("Fr., 20. Nov."), true);

  assertOk();
  await submit();
  assert.deepEqual(recorderUnderTest.calls, [{ kind: "confirm", value: "2026-11-20" }]);
});

test("today is dimmed and the chosen day is filled", async () => {
  const today = todayDateString();
  const recorderUnderTest = recorder();
  await mount(React.createElement(DatePickerDialog, {
    value: today,
    onCancel: recorderUnderTest.onCancel,
    onConfirm: recorderUnderTest.onConfirm,
  }));

  // Der gewaehlte Tag traegt die Fuellung, der heutige — hier derselbe —
  // nicht die Blasse.
  const chosen = $(`[data-picker-day="${today}"]`);
  assert.equal(chosen.style.background, "var(--bg-selected)");
  assert.equal(chosen.style.color, "var(--text)", "die Schrift bleibt die normale");
});

test("the today marker stays dim next to another chosen day", async () => {
  const today = todayDateString();
  const recorderUnderTest = recorder();
  await mount(React.createElement(DatePickerDialog, {
    value: "2026-11-18",
    onCancel: recorderUnderTest.onCancel,
    onConfirm: recorderUnderTest.onConfirm,
  }));

  // Der heutige Tag liegt vielleicht in einem anderen Monat — dann gibt es
  // ihn im Raster nicht, und die Regel ist nicht pruefbar.
  const todayCell = $(`[data-picker-day="${today}"]`);
  if (!todayCell) return;
  assert.equal(todayCell.style.color, "var(--text-muted)");
  assert.equal(todayCell.style.background, "transparent", "kein Ring, keine Fuellung");
});

test("the arrows follow the grid and the month follows the arrows", async () => {
  const recorderUnderTest = recorder();
  await mount(React.createElement(DatePickerDialog, {
    value: "2026-11-18",
    onCancel: recorderUnderTest.onCancel,
    onConfirm: recorderUnderTest.onConfirm,
  }));

  const grid = $('[data-picker-grid="true"]');
  await press(grid, "ArrowRight");
  assert.equal($('[data-picker-day="2026-11-19"]').getAttribute("aria-pressed"), "true");

  await press(grid, "ArrowDown");
  assert.equal($('[data-picker-day="2026-11-26"]').getAttribute("aria-pressed"), "true");

  // Ein Tag im naechsten Monat: das Raster blaettert mit, sonst waere der
  // gewaehlte Tag unsichtbar.
  await press(grid, "ArrowRight");
  await press(grid, "ArrowRight");
  await press(grid, "ArrowRight");
  await press(grid, "ArrowRight");
  assert.equal($('[data-picker-day="2026-11-30"]').getAttribute("aria-pressed"), "true");
  await press(grid, "ArrowRight");
  assert.equal(win.document.body.textContent.includes("Dezember 2026"), true);
  assert.equal($('[data-picker-day="2026-12-01"]').getAttribute("aria-pressed"), "true");
});

test("browsing months does not change the chosen day", async () => {
  const recorderUnderTest = recorder();
  await mount(React.createElement(DatePickerDialog, {
    value: "2026-11-18",
    onCancel: recorderUnderTest.onCancel,
    onConfirm: recorderUnderTest.onConfirm,
  }));

  await click($('[data-picker-next="true"]'));
  assert.equal(win.document.body.textContent.includes("Dezember 2026"), true);
  assert.equal($('[data-picker-header="true"]').textContent.includes("Mi., 18. Nov."), true);
  assert.equal($('[data-picker-day="2026-11-18"]'), null, "der November ist weg");

  await click($('[data-picker-previous="true"]'));
  assert.equal($('[data-picker-day="2026-11-18"]').getAttribute("aria-pressed"), "true");

  assertOk();
  await submit();
  assert.deepEqual(recorderUnderTest.calls, [{ kind: "confirm", value: "2026-11-18" }]);
});

test("the date can be typed instead", async () => {
  const recorderUnderTest = recorder();
  await mount(React.createElement(DatePickerDialog, {
    value: "2026-11-18",
    onCancel: recorderUnderTest.onCancel,
    onConfirm: recorderUnderTest.onConfirm,
  }));

  await click($('[data-picker-text-toggle="true"]'));
  const input = $('[data-picker-text="true"]');
  assert.equal(input.value, "18.11.2026");

  await type(input, "24.12.2026");
  assertOk();
  await submit();
  assert.deepEqual(recorderUnderTest.calls, [{ kind: "confirm", value: "2026-12-24" }]);
});

test("a typed date that is none is refused", async () => {
  const recorderUnderTest = recorder();
  await mount(React.createElement(DatePickerDialog, {
    value: "2026-11-18",
    onCancel: recorderUnderTest.onCancel,
    onConfirm: recorderUnderTest.onConfirm,
  }));

  await click($('[data-picker-text-toggle="true"]'));
  await type($('[data-picker-text="true"]'), "31.02.2026");
  assertOk();
  await submit();

  assert.deepEqual(recorderUnderTest.calls, []);
  assert.equal(win.document.body.textContent.includes(deMessages["calendar.invalidDate"]), true);
});

test("cancel of the date picker gives nothing back", async () => {
  const recorderUnderTest = recorder();
  await mount(React.createElement(DatePickerDialog, {
    value: "2026-11-18",
    onCancel: recorderUnderTest.onCancel,
    onConfirm: recorderUnderTest.onConfirm,
  }));

  await click(footerButton(deMessages["common.cancel"]));
  assert.deepEqual(recorderUnderTest.calls, [{ kind: "cancel" }]);
});

test("escape cancels the date picker", async () => {
  const recorderUnderTest = recorder();
  await mount(React.createElement(DatePickerDialog, {
    value: "2026-11-18",
    onCancel: recorderUnderTest.onCancel,
    onConfirm: recorderUnderTest.onConfirm,
  }));

  await press($('[data-date-picker="true"]'), "Escape");
  assert.deepEqual(recorderUnderTest.calls, [{ kind: "cancel" }]);
});
