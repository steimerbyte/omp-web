import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

/**
 * SearchableSelect: Oeffnen per Klick und Pfeiltaste, Suchfeld mit
 * Akzent-Normalisierung, Auswahl per Klick/Enter, Durchlaufen der deaktivierten
 * Optionen und Schliessen per Escape/aussen. Keine Quelltextpruefung.
 */

const ROOT = process.cwd();
const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
restoreLinkedomPrototypesOnExit(win);

const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US" };
const storage = new Map();
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => void storage.set(key, String(value)),
  removeItem: (key) => void storage.delete(key),
};

const ORIGINALS = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
  localStorage: globalThis.localStorage,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
};

win.innerWidth = 1200;
win.innerHeight = 800;
win.localStorage = localStorage;
win.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {} });
globalThis.window = new Proxy(win, {
  get(target, property) {
    if (property === "navigator") return fakeNavigator;
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
  has(target, property) {
    return property === "navigator" || Reflect.has(target, property);
  },
});
globalThis.document = win.document;
globalThis.navigator = fakeNavigator;
globalThis.localStorage = localStorage;
for (const [name, value] of Object.entries(linkedom)) {
  if (name === "parseHTML" || name === "default") continue;
  if (typeof value === "function" && /^[A-Z]/.test(name)) globalThis[name] = value;
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
win.Element.prototype.getBoundingClientRect = function rect() {
  return { top: 20, left: 20, right: 260, bottom: 54, width: 240, height: 34, x: 20, y: 20 };
};
win.Element.prototype.scrollIntoView = function scrollIntoView() {};
// React (canUseDOM:false beim Import) nutzt den Legacy-Input-Event-Pfad und
// ruft attachEvent/detachEvent; linkedom hat beides nicht.
win.Element.prototype.attachEvent = function attachEvent() {};
win.Element.prototype.detachEvent = function detachEvent() {};
win.HTMLInputElement.prototype.attachEvent = function attachEvent() {};
win.HTMLInputElement.prototype.detachEvent = function detachEvent() {};
win.getComputedStyle = () => new Proxy({}, { get: (_target, property) => (typeof property === "string" && property.startsWith("get") ? () => "" : "0px") });
globalThis.getComputedStyle = win.getComputedStyle;

const mounted = [];
test.after(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  for (const key of ["window", "document", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"]) {
    const value = ORIGINALS[key];
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});

const jiti = createJiti(`${ROOT}/package.json`, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { SearchableSelect } = await jiti.import(`${ROOT}/components/SearchableSelect.tsx`);

const OPTIONS = [
  { value: "de", label: "Deutsch", description: "German" },
  { value: "fr", label: "Français", searchText: "frankreich" },
  { value: "es", label: "Español", disabled: true },
  { value: "it", label: "Italiano" },
];

function fire(target, type, props = {}) {
  const event = new win.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(event, key, { value, configurable: true });
  }
  target.dispatchEvent(event);
  return event;
}

function setInputValue(input, value) {
  // Der Polyfill (canUseDOM:false beim React-Import) liest den Wert bei
  // keydown am zuletzt fokussierten Textfeld. linkedom liefert `type` als null,
  // wenn das Attribut fehlt, deshalb zuerst das Attribut setzen.
  input.setAttribute("type", "text");
  fire(input, "focusin", {});
  const descriptor = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value");
  descriptor?.set?.call(input, value);
  if (!descriptor?.set) input.value = value;
  fire(input, "keydown", { key: "a" });
  fire(input, "input", {});
}

async function mount(props = {}) {
  const changes = [];
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    root.render(
      React.createElement(SearchableSelect, {
        value: "de",
        options: OPTIONS,
        onChange: (value) => changes.push(value),
        ariaLabel: "Sprache",
        ...props,
      }),
    );
  });
  mounted.push({ root, container });
  return { root, container, changes };
}

function listbox(container) {
  return container.querySelector('[role="listbox"]');
}

test("zeigt die Auswahl und oeffnet die Liste per Klick und Pfeiltaste", async () => {
  const { root, container, changes } = await mount();
  const trigger = container.querySelector('button[aria-haspopup="listbox"]');
  assert.ok(trigger, "der Trigger fehlt");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.match(trigger.textContent, /Deutsch/);

  await act(async () => {
    fire(trigger, "click");
  });
  assert.equal(container.querySelector('button[aria-haspopup="listbox"]').getAttribute("aria-expanded"), "true");
  const list = listbox(container);
  assert.ok(list, "die Listbox fehlt");
  const options = list.querySelectorAll('[role="option"]');
  assert.equal(options.length, 4);
  assert.equal(options[0].getAttribute("aria-selected"), "true");
  assert.equal(options[0].getAttribute("data-active"), "true", "die aktive Option startet auf der Auswahl");

  // Escape im Suchfeld schliesst, die Pfeiltaste am Trigger oeffnet wieder.
  await act(async () => {
    fire(container.querySelector('input[role="combobox"]'), "keydown", { key: "Escape" });
  });
  assert.equal(listbox(container), null);

  await act(async () => {
    fire(container.querySelector('button[aria-haspopup="listbox"]'), "keydown", { key: "ArrowDown" });
  });
  assert.ok(listbox(container));

  // Akzent-Normalisierung: "francais" findet "Français".
  const search = container.querySelector('input[role="combobox"]');
  assert.ok(search, "das Suchfeld fehlt");
  await act(async () => {
    setInputValue(search, "francais");
  });
  const filtered = listbox(container).querySelectorAll('[role="option"]');
  assert.equal(filtered.length, 1);
  assert.match(filtered[0].textContent, /Français/);

  await act(async () => {
    fire(filtered[0], "mouseover", { relatedTarget: win.document.body });
    fire(filtered[0], "click");
  });
  assert.deepEqual(changes, ["fr"]);
  assert.equal(listbox(container), null, "die Auswahl schliesst die Liste");

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Pfeiltasten ueberspringen deaktivierte Optionen, Enter waehlt", async () => {
  const { root, container, changes } = await mount({ value: "it" });
  const trigger = container.querySelector('button[aria-haspopup="listbox"]');

  await act(async () => {
    fire(trigger, "click");
  });
  const search = container.querySelector('input[role="combobox"]');
  assert.ok(search);

  // Von "Italiano" (letzte Option) einmal herunter: die deaktivierte
  // "Español" wird uebersprungen, die Auswahl landet auf "Deutsch".
  await act(async () => {
    fire(search, "keydown", { key: "ArrowDown" });
  });
  const activeAfterDown = listbox(container).querySelector('[data-active="true"]');
  assert.match(activeAfterDown.textContent, /Deutsch/);

  await act(async () => {
    fire(search, "keydown", { key: "ArrowUp" });
  });
  const activeAfterUp = listbox(container).querySelector('[data-active="true"]');
  assert.match(activeAfterUp.textContent, /Italiano/);

  await act(async () => {
    fire(search, "keydown", { key: "Enter" });
  });
  assert.deepEqual(changes, ["it"]);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Escape, Tab und Klick daneben schliessen die Liste", async () => {
  const { root, container } = await mount();
  const open = async () => {
    await act(async () => {
      fire(container.querySelector('button[aria-haspopup="listbox"]'), "click");
    });
    return container.querySelector('input[role="combobox"]');
  };

  let search = await open();
  await act(async () => {
    fire(search, "keydown", { key: "Escape" });
  });
  assert.equal(listbox(container), null);

  search = await open();
  await act(async () => {
    fire(search, "keydown", { key: "Tab" });
  });
  assert.equal(listbox(container), null);

  search = await open();
  assert.ok(search);
  await act(async () => {
    fire(win.document.body, "pointerdown");
  });
  assert.equal(listbox(container), null);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("ohne Treffer erscheint der No-Results-Text; Disabled verhindert Oeffnen", async () => {
  const { root, container } = await mount({ disabled: true, noResultsLabel: "Nichts gefunden" });
  const trigger = container.querySelector('button[aria-haspopup="listbox"]');
  assert.equal(trigger.hasAttribute("disabled"), true);

  await act(async () => {
    fire(trigger, "click");
  });
  assert.equal(listbox(container), null);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();

  const second = await mount();
  await act(async () => {
    fire(second.container.querySelector('button[aria-haspopup="listbox"]'), "click");
  });
  const search = second.container.querySelector('input[role="combobox"]');
  await act(async () => {
    setInputValue(search, "xyz");
  });
  assert.match(listbox(second.container).textContent, /No matching options/);

  await act(async () => second.root.unmount());
  mounted.splice(0, mounted.length);
  second.container.remove();
});
