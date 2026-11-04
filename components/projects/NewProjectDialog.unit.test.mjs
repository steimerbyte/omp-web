import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";
import { restoreLinkedomPrototypesOnExit } from "../../lib/test-linkedom.mjs";

/**
 * Der Anlegen-Dialog: die Bezeichnung wird vor dem Absenden geprueft, weil sie
 * zum Ordnernamen wird. Der Test tippt deshalb wirklich in das Feld (native
 * Setter + `input`/`keyup`, wie React es an kontrollierten Feldern erwartet),
 * statt den Zustand zu setzen, und liest danach den Fehler, den deaktivierten
 * Knopf und schliesslich die Argumente von `onSubmit`.
 *
 * `isValidFolderName` wird zusaetzlich direkt mit konkreten Namen geprueft:
 * es ist die Regel, die der Nutzer als Hinweis sieht.
 */

const ROOT = process.cwd();
const jiti = createJiti(`${ROOT}/package.json`, { jsx: { runtime: "automatic" }, tsconfigPaths: true });

/* Die Globals, die diese Datei ersetzt, gehoeren ihr nicht: `bun test` faehrt
 * alle Dateien in einem Prozess, und was hier stehen bleibt, sieht die
 * naechste Datei. Der Schnappschuss entsteht vor dem ersten Eingriff. */
const ORIGINALS = {
  window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator,
  getComputedStyle: globalThis.getComputedStyle, matchMedia: globalThis.matchMedia,
  localStorage: globalThis.localStorage, Event: globalThis.Event, EventTarget: globalThis.EventTarget,
  DOMRect: globalThis.DOMRect, NodeFilter: globalThis.NodeFilter,
};
test.after(() => {
  for (const [name, value] of Object.entries(ORIGINALS)) {
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  }
});

const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
// Prototyp-Stubs dieser Datei werden am Ende zurueckgegeben; linkedom teilt
// sie prozessweit.
restoreLinkedomPrototypesOnExit(win);
const fakeNavigator = { userAgent: "test", languages: ["de-DE"], language: "de-DE", platform: "linux" };
win.getComputedStyle = () => new Proxy({}, { get: (_t, p) => (typeof p === "string" && p.startsWith("get") ? () => "" : "0px") });
globalThis.window = new Proxy(win, {
  get(target, prop) {
    if (prop === "navigator") return fakeNavigator;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
  has(target, prop) { return prop === "navigator" || Reflect.has(target, prop); },
});
globalThis.document = win.document;
globalThis.navigator = fakeNavigator;
globalThis.getComputedStyle = win.getComputedStyle;
globalThis.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent() { return false; } });
win.matchMedia = globalThis.matchMedia;
for (const [name, value] of Object.entries(linkedom)) {
  if (name === "parseHTML" || name === "default") continue;
  if (typeof value === "function" && /^[A-Z]/.test(name)) globalThis[name] = value;
}
/* Reacts alter Input-Polyfill (aktiv, wenn eine fruehere Datei `react-dom`
 * ohne `document.oninput` geladen hat) haengt sich per `attachEvent` an das
 * aktive Feld. linkedom kennt die Methode nicht; ohne sie wirft schon der
 * Fokus. Die Abbildung auf `addEventListener` genuegt, weil der Polyfill den
 * Wert ohnehin ueber `keyup` liest. */
for (const name of ["attachEvent", "detachEvent"]) {
  if (win.HTMLElement.prototype[name]) continue;
  win.HTMLElement.prototype[name] = function (type, handler) {
    const event = String(type).replace(/^on/, "");
    if (name === "attachEvent") this.addEventListener(event, handler);
    else this.removeEventListener(event, handler);
  };
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
globalThis.DOMRect = class DOMRect {
  constructor(x = 0, y = 0, width = 0, height = 0) { Object.assign(this, { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height }); }
  static fromRect(rect = {}) { return new DOMRect(rect.x, rect.y, rect.width, rect.height); }
};
const storage = new Map([["pi-locale", "de"]]);
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => void storage.set(key, String(value)),
  removeItem: (key) => void storage.delete(key),
  clear: () => storage.clear(),
};
win.localStorage = globalThis.localStorage;
win.document.oninput = null;
win.document.onchange = null;

const { createRoot } = await import("react-dom/client");
const { NewProjectDialog, isValidFolderName } = await jiti.import(`${ROOT}/components/projects/NewProjectDialog.tsx`);
const { I18nProvider } = await jiti.import(`${ROOT}/hooks/useI18n.tsx`);
const { deLocale } = await jiti.import(`${ROOT}/lib/i18n/messages/de.ts`);
const de = deLocale.messages;

const PRIORITIES = [
  { id: "now", name: "Sofort", colorValue: "var(--danger)" },
  { id: "important", name: "Wichtig", colorValue: "var(--warning)" },
  { id: "later", name: "Später", colorValue: "var(--accent)" },
  { id: "done", name: "Erledigt", colorValue: "var(--success)" },
  { id: "parked", name: "Geparkt", colorValue: "var(--text-dim)" },
];

const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); }); };
const buttons = () => [...win.document.querySelectorAll("button")];
const buttonWith = (text) => buttons().find((button) => button.textContent.trim() === text);

/** Tippt in ein React-Feld: native Setter, dann die Ereignisse, die React liest. */
async function type(input, value) {
  // linkedom meldet fuer ein Feld ohne `type`-Attribut `type === null`; ein
  // Browser meldet "text". React entscheidet an `elem.type`, ob es ein
  // Texteingabefeld ist — ohne diese Angleichung feuert `onChange` nie.
  if (!input.type) input.setAttribute("type", "text");
  await act(async () => { input.dispatchEvent(new win.Event("focusin", { bubbles: true })); });
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    input.dispatchEvent(new win.Event("keyup", { bubbles: true }));
  });
  await flush();
}

async function mount(props) {
  win.document.body.innerHTML = "";
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(NewProjectDialog, {
      home: "/home/alice",
      priorities: PRIORITIES,
      busy: false,
      onSubmit: () => {},
      onCancel: () => {},
      ...props,
    })));
  });
  await flush();
  return { container, root };
}

test("die Regel fuer Ordnernamen: Kebab-case, keine Pfade, keine Fuehrungszeichen", () => {
  assert.equal(isValidFolderName("mein-projekt"), true);
  assert.equal(isValidFolderName("a"), true);
  assert.equal(isValidFolderName("projekt-2026"), true);
  // Grossbuchstaben, Leerzeichen, Unterstrich: kein Kebab-case.
  assert.equal(isValidFolderName("Mein-Projekt"), false);
  assert.equal(isValidFolderName("mein projekt"), false);
  assert.equal(isValidFolderName("mein_projekt"), false);
  // Der eigentliche Grund fuer die Regel: nichts, was einen Pfad verlaesst.
  assert.equal(isValidFolderName("../etc"), false);
  assert.equal(isValidFolderName("a/b"), false);
  assert.equal(isValidFolderName("a\\b"), false);
  assert.equal(isValidFolderName(".."), false);
  assert.equal(isValidFolderName("."), false);
  // Ein fuehrender Strich waere ein Kommandozeilen-Flag, ein Punkt ein
  // versteckter Ordner.
  assert.equal(isValidFolderName("-rf"), false);
  assert.equal(isValidFolderName(".hidden"), false);
  // Leer und zu lang.
  assert.equal(isValidFolderName(""), false);
  assert.equal(isValidFolderName("a".repeat(65)), false);
  assert.equal(isValidFolderName(null), false);
  assert.equal(isValidFolderName(42), false);
});

test("eine ungueltige Bezeichnung zeigt den Fehler und blockiert das Absenden", async () => {
  const submitted = [];
  const { container, root } = await mount({ onSubmit: (input) => submitted.push(input) });
  const input = container.querySelector("#omp-project-name");
  assert.ok(input, "das Namensfeld fehlt");
  assert.equal(input.getAttribute("placeholder"), de["projects.create.namePlaceholder"]);
  // Ohne Eingabe ist der Knopf aus.
  const submit = buttonWith(de["projects.create.submit"]);
  assert.equal(submit.disabled, true);

  await type(input, "Mein Projekt");
  assert.match(container.textContent, new RegExp(de["projects.create.nameInvalid"]));
  assert.doesNotMatch(container.textContent, new RegExp(de["projects.create.nameHelp"]));
  assert.equal(buttonWith(de["projects.create.submit"]).disabled, true);
  await act(async () => { buttonWith(de["projects.create.submit"]).click(); });
  assert.deepEqual(submitted, []);

  // Ein gueltiger Name nimmt den Fehler zurueck.
  await type(input, "mein-projekt");
  assert.match(container.textContent, new RegExp(de["projects.create.nameHelp"]));
  assert.equal(buttonWith(de["projects.create.submit"]).disabled, false);
  await act(async () => { root.unmount(); });
});

test("das Absenden uebergibt Name, Prioritaet und die Git-Wahl", async () => {
  const submitted = [];
  const { container, root } = await mount({ onSubmit: (input) => submitted.push(input) });
  const input = container.querySelector("#omp-project-name");
  await type(input, "  mein-projekt  ");

  // Eine andere Prioritaet waehlen.
  const priority = buttonWith("Wichtig");
  assert.ok(priority, "die Prioritaets-Auswahl fehlt");
  await act(async () => { priority.click(); });
  await flush();

  // Git abwaehlen: der Haken ist eine bewusste Wahl, kein Standard.
  const git = container.querySelector('input[type="checkbox"]');
  assert.equal(git.checked, true);
  // linkedom gibt dem Klick auf eine Checkbox keine Standard-Aktion; ein
  // Browser kippt `checked` vor dem `click`-Ereignis. Also beides.
  await act(async () => {
    git.checked = false;
    git.dispatchEvent(new win.Event("click", { bubbles: true }));
  });
  await flush();
  assert.equal(git.checked, false);

  await act(async () => { buttonWith(de["projects.create.submit"]).click(); });
  await flush();

  assert.deepEqual(submitted, [{ name: "mein-projekt", priority: "important", initGit: false }]);
  await act(async () => { root.unmount(); });
});

test("waehrend des Anlegens ist der Knopf aus und nennt den Zustand", async () => {
  const submitted = [];
  const { container, root } = await mount({ busy: true, onSubmit: (input) => submitted.push(input) });
  const input = container.querySelector("#omp-project-name");
  await type(input, "mein-projekt");

  const working = buttonWith(de["projects.create.working"]);
  assert.ok(working, "der laufende Zustand hat keinen eigenen Text");
  assert.equal(working.disabled, true);
  await act(async () => { working.click(); });
  assert.deepEqual(submitted, []);
  await act(async () => { root.unmount(); });
});

test("Abbrechen und der Klick daneben schliessen, der Klick im Panel nicht", async () => {
  const calls = [];
  const { container, root } = await mount({ onCancel: () => calls.push("cancel") });
  const panel = container.querySelector('[role="dialog"]');
  assert.ok(panel);
  await act(async () => { panel.querySelector("h2").click(); });
  assert.deepEqual(calls, []);
  await act(async () => { container.querySelector('[role="dialog"]').parentElement.click(); });
  assert.deepEqual(calls, ["cancel"]);
  await act(async () => { buttonWith(de["common.cancel"]).click(); });
  assert.deepEqual(calls, ["cancel", "cancel"]);
  await act(async () => { root.unmount(); });
});
