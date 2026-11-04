import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./workspace-memory.ts");
}

/**
 * Der Tab-Speicher, den die Fortsetzungs-Erinnerung benutzt.
 *
 * Alle oeffentlichen Funktionen nehmen einen `storage`-Parameter, damit ein
 * Test ohne DOM auskommt — der *Default* ist aber der echte
 * `window.sessionStorage`, und genau der wird hier geprueft: ein Server-Render
 * hat kein `window` (die Funktion muss `null` liefern statt zu werfen), und ein
 * Browser mit blockiertem Storage wirft beim Zugriff, was ebenfalls `null`
 * ergeben muss statt die Oberflaeche abzubrechen.
 */
function withWindow(value, run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value, configurable: true, writable: true });
  try {
    return run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else delete globalThis.window;
  }
}

function createStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("without a window there is no storage and no continuation", async () => {
  const { getSessionContinuation, rememberSessionContinuation } = await loadSubject();

  await withWindow(undefined, async () => {
    assert.equal(getSessionContinuation("session-1"), undefined);
    // Ein zweiter Aufruf darf nicht werfen — das ist der Server-Render-Pfad.
    rememberSessionContinuation("session-1", "runtime:abc");
    assert.equal(getSessionContinuation("session-1"), undefined);
  });
});

test("the browser session storage carries the continuation", async () => {
  const { getSessionContinuation, rememberSessionContinuation, clearSessionContinuation } = await loadSubject();
  const storage = createStorage();

  await withWindow({ sessionStorage: storage }, async () => {
    rememberSessionContinuation("session-1", "runtime:abc");
    assert.equal(getSessionContinuation("session-1"), "runtime:abc");
    assert.equal(getSessionContinuation("session-2"), undefined, "eine andere Sitzung erbt nichts");

    clearSessionContinuation();
    assert.equal(getSessionContinuation("session-1"), undefined);
    assert.equal(storage.values.size, 0);
  });
});

test("a throwing sessionStorage is treated as absent", async () => {
  const { getSessionContinuation } = await loadSubject();

  await withWindow({
    get sessionStorage() {
      throw new Error("storage is blocked");
    },
  }, async () => {
    assert.equal(getSessionContinuation("session-1"), undefined);
  });
});
