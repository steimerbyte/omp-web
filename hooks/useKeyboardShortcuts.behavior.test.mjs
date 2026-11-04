// Der Hook ist bisher nur indirekt ueber AppShell-Quelltext geprueft. Hier
// laeuft der globale keydown-Handler: Esc mit/ohne Handler, Tab-Felder und
// Ctrl+Alt+N.
import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

const ROOT = new globalThis.URL("..", import.meta.url).pathname;
const jiti = createJiti(`${ROOT}package.json`, { jsx: { runtime: "automatic" }, tsconfigPaths: true });

const dom = linkedom.parseHTML("<!doctype html><html><body><textarea id=\"a\"></textarea><input id=\"b\"></body></html>");
const win = dom.window;
const ORIGINALS = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement };
globalThis.window = win;
globalThis.document = win.document;
globalThis.HTMLElement = win.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { useGlobalKeyboardShortcuts, registerAbortHandler } = await jiti.import(`${ROOT}hooks/useKeyboardShortcuts.ts`);

const keyEvent = (target, props) => {
  const event = new win.Event("keydown", { bubbles: true, cancelable: true });
  Object.assign(event, props);
  let defaultPrevented = false;
  event.preventDefault = () => { defaultPrevented = true; };
  target.dispatchEvent(event);
  return { get defaultPrevented() { return defaultPrevented; } };
};

test.after(() => {
  for (const [key, value] of Object.entries(ORIGINALS)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});

test("Esc stoppt den Agenten nur ausserhalb von Textfeldern, Ctrl+Alt+N oeffnet eine Sitzung", async () => {
  const newSessions = [];
  let aborts = 0;
  const container = win.document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(function Probe() {
      useGlobalKeyboardShortcuts({ activeCwd: "/projekt", onNewSession: (cwd) => newSessions.push(cwd) });
      return null;
    }));
  });

  // Ohne registrierten Handler ist Esc ein No-op.
  registerAbortHandler(null);
  assert.equal(keyEvent(win, { key: "Escape" }).defaultPrevented, false);
  assert.equal(aborts, 0);

  registerAbortHandler(() => { aborts += 1; });
  const onWindow = keyEvent(win, { key: "Escape" });
  assert.equal(onWindow.defaultPrevented, true);
  assert.equal(aborts, 1);

  // In TEXTAREA/INPUT gehoert Esc dem ChatInput.
  assert.equal(keyEvent(win.document.getElementById("a"), { key: "Escape" }).defaultPrevented, false);
  assert.equal(keyEvent(win.document.getElementById("b"), { key: "Escape" }).defaultPrevented, false);
  assert.equal(aborts, 1);

  const shortcut = keyEvent(win, { key: "n", ctrlKey: true, altKey: true });
  assert.equal(shortcut.defaultPrevented, true);
  assert.deepEqual(newSessions, ["/projekt"]);

  // Ohne ctrl/alt ist es normales Tippen.
  assert.equal(keyEvent(win, { key: "n" }).defaultPrevented, false);
  assert.deepEqual(newSessions, ["/projekt"]);

  registerAbortHandler(null);
  await act(async () => { root.unmount(); });
});

test("ohne aktives Projekt oder Callback bleibt Ctrl+Alt+N wirkungslos", async () => {
  const calls = [];
  const container = win.document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(function Probe() {
      useGlobalKeyboardShortcuts({ activeCwd: null, onNewSession: (cwd) => calls.push(cwd) });
      return null;
    }));
  });
  assert.equal(keyEvent(win, { key: "n", ctrlKey: true, altKey: true }).defaultPrevented, false);
  assert.deepEqual(calls, []);
  await act(async () => { root.unmount(); });
});
