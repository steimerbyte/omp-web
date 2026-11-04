import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./open-external.ts");
}

/**
 * Ein Link aus der App heraus oeffnen.
 *
 * Im Browser ist das `window.open(..., "_blank", "noopener,noreferrer")`; in
 * der Tauri-Webview oeffnet derselbe Aufruf ein *zweites Fenster*, und der
 * OAuth-Login landet in einer Ansicht ohne die Sitzung, die ihn gestartet hat.
 * Deshalb geht der Desktop-Fall ueber den Opener-IPC-Befehl — und nur, wenn
 * `window.__TAURI__` wirklich da ist.
 */
async function withGlobal(name, value, run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  try {
    // Bis zum Ende warten: der Tauri-Fehlerpfad laeuft in einem `.catch`, also
    // nach dem Mikrotask — eine Wiederherstellung vorher nimmt ihm `window`.
    return await run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
}

test("opens a browser tab when the desktop bridge is absent", async () => {
  const { openExternal } = await loadSubject();
  const opened = [];

  await withGlobal("window", { open: (...args) => opened.push(args) }, () => openExternal("https://example.com/login"));

  assert.deepEqual(opened, [["https://example.com/login", "_blank", "noopener,noreferrer"]]);
});

test("routes through the opener plugin inside Tauri", async () => {
  const { openExternal } = await loadSubject();
  const invoked = [];
  const opened = [];
  const tauri = {
    core: {
      invoke: async (command, args) => { invoked.push({ command, args }); },
    },
  };

  await withGlobal("window", { open: (...args) => opened.push(args) }, () =>
    withGlobal("__TAURI__", tauri, () => openExternal("https://example.com/login")));

  assert.deepEqual(invoked, [{
    command: "plugin:opener|open_url",
    args: { url: "https://example.com/login" },
  }]);
  assert.deepEqual(opened, [], "der Opener ersetzt den Webview-Fensteraufruf");
});

test("falls back to a browser tab when the opener command fails", async () => {
  const { openExternal } = await loadSubject();
  const opened = [];
  const tauri = { core: { invoke: async () => { throw new Error("opener missing"); } } };

  await withGlobal("window", { open: (...args) => opened.push(args) }, () =>
    withGlobal("__TAURI__", tauri, () => openExternal("https://example.com/login")));

  assert.deepEqual(opened, [["https://example.com/login", "_blank", "noopener,noreferrer"]]);
});
