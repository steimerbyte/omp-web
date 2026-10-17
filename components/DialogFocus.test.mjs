import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React from "react";
import { createJiti } from "jiti";

/**
 * Die drei Befunde an `ProjectTrustDialog` und `DirectoryPicker`, gemessen
 * nach dem Commit und nicht im Quelltext nachgeschlagen.
 *
 * Der Fokus-Befund ist der Grund fuer den ganzen Harness. `preventDefault()`
 * im Quelltext zu pruefen faengt nichts: derselbe Aufruf ist auf dem
 * Abbruch-Weg richtig und auf dem Bestaetigungs-Weg falsch. Unterschieden wird
 * er erst dadurch, dass `AppShell` beim Bestaetigen in einem Commit `trusted`
 * setzt und damit den Knopf entfernt, auf den `restoreFocusTo` zeigt. Der
 * Test baut genau diesen Commit nach — dieselbe Komponente, derselbe Aufrufer,
 * dieselbe Reihenfolge — und liest danach `document.activeElement`.
 *
 * `linkedom` hat keinen Fokus: `document.activeElement` ist immer `undefined`
 * und `HTMLElement.prototype.focus()` tut nichts. Beides wird hier ersetzt.
 * `isConnected` loest der echte DOM-Stand auf, und ein Element, das
 * ausgebaut wurde, verliert den Fokus wieder — sonst haette der Test die
 * Antwort auf jeden Fall `body` bekommen und der Fix waere unbewiesen geblieben.
 */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const win = dom.window;
const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };

// linkedom fuehrt kein Layout aus. Radix fragt beim Einrasten die Scrollbar-
// Breite ueber `getComputedStyle` ab, und `react-remove-scroll-bar` ruft
// `window.getComputedStyle(document.body)`; ohne die gibt es sofort einen
// TypeError und der Dialog mountet ueberhaupt nicht.
const computed = () => new Proxy({}, {
  get: (_target, prop) => (typeof prop === "string" && prop.startsWith("get") ? () => "" : "0px"),
});
win.getComputedStyle = computed;

let activeElement = win.document.body;

/**
 * `focus()` schreibt hier den Fokus fest; `setActive` ist der einzige Weg
 * dorthin, damit `no-this-alias` nicht greift (siehe Aufrufstelle).
 */
function setActive(element) {
  activeElement = element;
}
/**
 * Chromium-Regel, nachgebaut: der Fokus faellt auf `body` zurueck, wenn das
 * Element, das ihn hatte, aus dem Dokument entfernt wird. Genau daran haengt
 * der Befund — ohne diese Zeile waere `restoreFocusTo.isConnected === false`
 * ein Detail, das im Test niemals auffaellt.
 */
const resolveActive = () =>
  activeElement && activeElement.isConnected === false ? win.document.body : activeElement;
Object.defineProperty(win.document, "activeElement", { get: resolveActive, configurable: true });
win.HTMLElement.prototype.focus = function focus() {
  // Ein `div` ohne `tabindex` ist in Chromium nicht fokussierbar; `focus()`
  // wird dort stillschweigend verworfen. Genau das ist der Grund, warum der
  // Ersatz-Zielknoten unten ein `tabindex="-1"` braucht.
  // `no-this-alias` verbietet, `this` in eine Variable zu schreiben. Der
  // Test braucht das Element aber, um es spaeter als `activeElement` zu
  // lesen — also wird es ueber eine eigene Setter-Funktion gereicht statt
  // ueber `activeElement = this`. Das Verhalten ist identisch, die
  // Regelverletzung nicht.
  const tag = this.tagName;
  const nativelyFocusable = tag === "BUTTON" || tag === "INPUT" || tag === "TEXTAREA" || tag === "A" || tag === "SELECT";
  if (!nativelyFocusable && !this.hasAttribute("tabindex")) return;
  setActive(this);
};

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
  // `dom.window.window` ist das blosse linkedom-Fenster; es zu kopieren wuerde
  // die navigator-Falle oben aushebeln.
  if (name === "window") continue;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor && !descriptor.writable) continue;
  globalThis[name] = win[name];
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;

// linkedom kennt weder `select()` noch `setSelectionRange()` und fuehrt auch
// keine Markierung. Nachgebaut wird das, was Chromium anbietet — dort
// gemessen: `select()` auf leerem `0/0`, auf gefuelltem `0/18`, und
// `setSelectionRange(0, value.length)` in beiden Faellen `0/value.length`.
for (const proto of [win.HTMLInputElement?.prototype, win.HTMLTextAreaElement?.prototype]) {
  if (!proto) continue;
  let selectionStart = 0;
  let selectionEnd = 0;
  Object.defineProperty(proto, "selectionStart", { get: () => selectionStart, configurable: true });
  Object.defineProperty(proto, "selectionEnd", { get: () => selectionEnd, configurable: true });
  proto.setSelectionRange = function setSelectionRange(start, end) {
    const max = String(this.value ?? "").length;
    selectionStart = Math.min(Math.max(0, start), max);
    selectionEnd = Math.min(Math.max(selectionStart, end), max);
  };
  proto.select = function select() { this.setSelectionRange(0, String(this.value ?? "").length); };
}
// Chromium legt den Cursor ans Ende, wenn der Wert eines fokussierten Feldes
// ersetzt wird; das ist der Grund fuer den zweiten `selectWholeInput`-Aufruf.
for (const proto of [win.HTMLInputElement?.prototype, win.HTMLTextAreaElement?.prototype]) {
  if (!proto) continue;
  const raw = Object.getOwnPropertyDescriptor(proto, "value");
  if (!raw?.get) continue;
  Object.defineProperty(proto, "value", {
    ...raw,
    set(value) {
      raw.set.call(this, value);
      if (this.setSelectionRange) this.setSelectionRange(String(value ?? "").length, String(value ?? "").length);
    },
  });
}

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
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  clear: () => { storage.clear(); },
};
globalThis.localStorage = localStorage;
win.localStorage = localStorage;

// Scoped to this file and put back afterwards. The replacement was permanent,
// and `lib/http-dispatcher.ts` snapshots `globalThis.fetch` when it loads and
// only restores it when the snapshot still matches. A foreign override left
// behind made that comparison fail, `undici.install()` ran and replaced the
// linkedom globals above, and every React `act()` in every later test file
// failed with "not configured to support act" — measured: 298 warnings, and
// `components/DialogFocus.test.mjs` green only because it ran first.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ path: "/home/user/project", parentPath: "/home/user", directories: [], drives: null }),
});
test.after(() => { globalThis.fetch = originalFetch; });

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { ProjectTrustDialog } = await jiti.import("./ProjectTrustDialog.tsx");
const { DirectoryPicker } = await jiti.import("./DirectoryPicker.tsx");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

async function mount(element) {
  // Radix haengt sein Portal an `document.body`, und das ueberlebt
  // `root.unmount()` in linkedom. Ohne vorheriges Abraeumen zaehlt der
  // naechste Test die Overlays des Vorgängers mit und schlaegt fehl, obwohl
  // die Komponente in Ordnung ist. Geprueft wird deshalb immer gegen ein
  // leeres Dokument.
  win.document.body.innerHTML = "";
  activeElement = win.document.body;
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(I18nProvider, null, element)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
  return { container, root };
}

/** Wartet die `setTimeout(0)` ab, in der Radix' `FocusScope` zurueckgibt. */
async function settle() {
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

const activeId = () => {
  const element = resolveActive();
  return element === win.document.body ? "body" : element.id || element.tagName;
};

/**
 * Baut den Aufrufer aus `AppShell` nach: das Warnzeichen steht unter dem
 * Guard `requiresTrust && !trusted`, und das Bestaetigen setzt `trusted` und
 * schliesst den Dialog im selben Commit.
 */
function trustHarness({ onConfirm } = {}) {
  return function Harness() {
    const [trusted, setTrusted] = React.useState(false);
    const [open, setOpen] = React.useState(false);
    return React.createElement("div", null,
      React.createElement("div", { id: "top-bar" },
        React.createElement("button", { id: "language", onClick: () => {} }, "de"),
        !trusted && React.createElement("button", {
          id: "warn",
          onClick: () => setOpen(true),
        }, "!")),
      React.createElement("button", { id: "after", onClick: () => {} }, "nachher"),
      open && React.createElement(ProjectTrustDialog, {
        cwd: "/home/user/project",
        busy: false,
        error: null,
        onCancel: () => setOpen(false),
        onConfirm: () => {
          setTrusted(true);
          setOpen(false);
          onConfirm?.();
        },
      }));
  };
}

test("Nach dem Bestaetigen landet der Fokus nicht auf dem body", async () => {
  const { container, root } = await mount(React.createElement(trustHarness()));
  const warn = win.document.getElementById("warn");
  await act(async () => { warn.focus(); warn.click(); });
  await settle();

  const confirm = [...win.document.querySelectorAll("button")].find((b) => b.textContent.includes("Trust"));
  assert.ok(confirm, "der Bestaetigungs-Knopf wurde nicht gerendert");
  await act(async () => { confirm.click(); });
  await settle();

  // Der Knopf, auf den `restoreFocusTo` zeigte, ist im selben Commit weg.
  assert.equal(win.document.getElementById("warn"), null, "der Aufrufer muss verschwunden sein");
  assert.notEqual(activeId(), "body", `Fokus ist auf dem body gelandet (${activeId()})`);
  assert.equal(resolveActive().id, "top-bar");

  await act(async () => { root.unmount(); });
  void container;
});

test("Der Abbruch-Weg legt den Fokus zurueck auf den Knopf, der den Dialog geoeffnet hat", async () => {
  const { root } = await mount(React.createElement(trustHarness()));
  const warn = win.document.getElementById("warn");
  await act(async () => { warn.focus(); warn.click(); });
  await settle();

  const cancel = [...win.document.querySelectorAll("button")].find((b) => b.textContent.includes("Cancel"));
  assert.ok(cancel, "der Abbrechen-Knopf wurde nicht gerendert");
  await act(async () => { cancel.click(); });
  await settle();

  assert.ok(win.document.getElementById("warn"), "der Aufrufer muss beim Abbruch stehen bleiben");
  assert.equal(resolveActive().id, "warn");

  await act(async () => { root.unmount(); });
});

test("Der Warn-Dialog rendert genau ein Overlay und ohne backdrop-filter darauf", async () => {
  const { root } = await mount(React.createElement(trustHarness()));
  const warn = win.document.getElementById("warn");
  await act(async () => { warn.focus(); warn.click(); });
  await settle();

  const overlays = win.document.querySelectorAll('[data-slot="dialog-overlay"]');
  assert.equal(overlays.length, 1, `erwartet genau ein Overlay, gefunden ${overlays.length}`);

  await act(async () => { root.unmount(); });
});

function pickerHarness() {
  return function Harness() {
    const [open, setOpen] = React.useState(true);
    return React.createElement("div", null,
      React.createElement("button", { id: "cwd", onClick: () => setOpen(true) }, "cwd"),
      open && React.createElement(DirectoryPicker, {
        onCancel: () => setOpen(false),
        onSelect: () => setOpen(false),
      }));
  };
}

test("Der Verzeichnis-Picker rendert genau ein Overlay", async () => {
  const { root } = await mount(React.createElement(pickerHarness()));
  await settle();

  const overlays = win.document.querySelectorAll('[data-slot="dialog-overlay"]');
  assert.equal(overlays.length, 1, `erwartet genau ein Overlay, gefunden ${overlays.length}`);

  await act(async () => { root.unmount(); });
});

test("Beide Dialoge tragen ihre z-Ebene am Overlay und am Panel", async () => {
  for (const [Harness, zIndex] of [[trustHarness, 1100], [pickerHarness, 1000]]) {
    const { root } = await mount(React.createElement(Harness()));
    if (zIndex === 1100) {
      const warn = win.document.getElementById("warn");
      await act(async () => { warn.focus(); warn.click(); });
    }
    await settle();

    const overlay = win.document.querySelector('[data-slot="dialog-overlay"]');
    const content = win.document.querySelector('[data-slot="dialog-content"]');
    assert.ok(overlay, `kein Overlay bei z=${zIndex}`);
    assert.ok(content, `kein Panel bei z=${zIndex}`);
    // Das Inline-`z-index` gewinnt gegen die `z-50`-Klasse von Radix und
    // haelt die Ebene zwischen den uebrigen Overlays.
    assert.equal(overlay.style.zIndex, String(zIndex));
    assert.equal(content.style.zIndex, String(zIndex));

    await act(async () => { root.unmount(); });
  }
});

test("Kein Overlay traegt ein backdrop-filter, das es vorher nicht gab", async () => {
  const { root } = await mount(React.createElement(pickerHarness()));
  await settle();

  // `DialogOverlay` bringt `supports-backdrop-filter:backdrop-blur-xs` mit.
  // Der alte Backdrop hatte keinen, deshalb hebt `NO_BACKDROP_BLUR` ihn auf.
  // `linkedom` wertet Klassen nicht aus, deshalb wird die Kette hier als
  // Zeichenkette geprueft: `backdrop-blur-xs` und `backdrop-blur-none` duerfen
  // nie nebeneinander stehen, sonst entscheidet die Reihenfolge im Stylesheet
  // und nicht mehr der Code.
  for (const overlay of win.document.querySelectorAll('[data-slot="dialog-overlay"]')) {
    const className = String(overlay.getAttribute("class") ?? "");
    assert.doesNotMatch(className, /backdrop-blur-xs(?![\s\S]*backdrop-blur-none)/,
      `das Overlay weichzeichnet ohne sichtbaren Grund: ${className}`);
    assert.match(className, /backdrop-blur-none/);
  }

  await act(async () => { root.unmount(); });
});

/** Das Wegfeld des Pickers, sobald der Dialog steht. */
function pathInput() {
  const input = win.document.getElementById("directory-path");
  assert.ok(input, "das Wegfeld wurde nicht gerendert");
  return input;
}

test("Das Wegfeld markiert die ganze Eingabe, auch wenn es leer ist", async () => {
  const { root } = await mount(React.createElement(pickerHarness()));
  await settle();

  const input = pathInput();
  assert.equal(resolveActive(), input, "das Wegfeld muss beim Oeffnen den Fokus tragen");
  assert.equal(input.selectionStart, 0);
  assert.equal(input.selectionEnd, input.value.length);

  await act(async () => { root.unmount(); });
});

test("Die Markierung ueberlebt den asynchron nachgelieferten Pfad", async () => {
  const { root } = await mount(React.createElement(pickerHarness()));
  await settle();

  const input = pathInput();
  // `navigateTo()` liefert den ersten Pfad per `fetch`; der Stub oben gibt
  // `/home/user/project` zurueck. React setzt den Wert, Chromium legt den
  // Cursor ans Ende — das war der Grund fuer den zweiten `selectWholeInput`.
  assert.equal(input.value, "/home/user/project");
  assert.equal(input.selectionStart, 0, "der Cursor liegt am Ende statt am Anfang");
  assert.equal(input.selectionEnd, input.value.length);

  await act(async () => { root.unmount(); });
});

test("Ein leeres Wegfeld ergibt eine leere, gueltige Markierung", async () => {
  // `select()` und `setSelectionRange(0, value.length)` sind in Chromium
  // gleichwertig, auch leer — beide `0/0`. Der Unterschied liegt im Zeitpunkt:
  // der erste Aufruf passiert, bevor der Pfad da ist. Der zweite Test
  // weiter oben deckt genau das ab.
  const input = win.document.createElement("input");
  input.value = "";
  input.setSelectionRange(0, input.value.length);
  assert.equal(input.selectionStart, 0);
  assert.equal(input.selectionEnd, 0);

  input.value = "/home/user/project";
  input.setSelectionRange(0, input.value.length);
  assert.equal(input.selectionStart, 0);
  assert.equal(input.selectionEnd, 18);
});