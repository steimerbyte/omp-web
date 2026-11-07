import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

/**
 * CollapsibleMessage: Die Zeile ist der einzige Teil, der im DOM steht, solange
 * die Ausgabe zugeklappt ist. Der Test prueft genau das — nicht nur
 * `aria-expanded`, sondern dass der Inhalt wirklich nicht gemountet wird.
 */

const ROOT = process.cwd();
const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
restoreLinkedomPrototypesOnExit(win);

const fakeNavigator = { userAgent: "test", languages: ["de-DE"], language: "de-DE" };
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
const { I18nProvider } = await jiti.import(`${ROOT}/hooks/useI18n.tsx`);
const { CollapsibleMessage } = await jiti.import(`${ROOT}/components/CollapsibleMessage.tsx`);

function fire(target, type) {
  const event = new win.Event(type, { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function Harness() {
  const [open, setOpen] = useState(false);
  return React.createElement(
    I18nProvider,
    null,
    React.createElement(
      CollapsibleMessage,
      {
        id: "output-card",
        open,
        onToggle: () => setOpen((value) => !value),
        label: "Antwort",
        preview: "eine kurze Vorschau",
        meta: ["read"],
        timestamp: Date.UTC(2026, 0, 2, 9, 30),
      },
      React.createElement("span", { id: "child-content" }, "VERBORGENER-INHALT"),
    ),
  );
}

async function mount() {
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    root.render(React.createElement(Harness));
  });
  mounted.push({ root, container });
  return { root, container };
}

test("zugeklappt steht nur die Zeile im DOM, der Inhalt fehlt ganz", async () => {
  const { container } = await mount();

  const button = container.querySelector("button");
  assert.ok(button, "die Zusammenfassungszeile fehlt");
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(button.getAttribute("aria-controls"), "output-card");
  assert.equal(button.getAttribute("title"), "Ausgabe ausklappen");
  assert.match(button.textContent, /Antwort/);
  assert.match(button.textContent, /eine kurze Vorschau/);
  assert.match(button.textContent, /read/);
  assert.match(button.textContent, /\d{2}:\d{2}/);
  assert.ok(container.querySelector("#output-card"), "das Ziel von aria-controls fehlt");
  assert.equal(container.querySelector("#child-content"), null, "zugeklappter Inhalt darf nicht im DOM stehen");
});

test("ein Klick klappt auf, mountet den Inhalt und dreht aria-expanded", async () => {
  const { container } = await mount();

  await act(async () => {
    fire(container.querySelector("button"), "click");
  });

  const open = container.querySelector("button");
  assert.equal(open.getAttribute("aria-expanded"), "true");
  assert.equal(open.getAttribute("title"), "Ausgabe einklappen");
  // Offen traegt die Karte ihre eigene erste Zeile nicht doppelt vor sich her.
  assert.equal(open.textContent.includes("eine kurze Vorschau"), false);
  const child = container.querySelector("#child-content");
  assert.ok(child, "der Inhalt wurde nicht gemountet");
  assert.equal(child.textContent, "VERBORGENER-INHALT");

  await act(async () => {
    fire(open, "click");
  });

  assert.equal(container.querySelector("button").getAttribute("aria-expanded"), "false");
  assert.equal(container.querySelector("#child-content"), null, "der Inhalt blieb nach dem Zuklappen im DOM");
});
