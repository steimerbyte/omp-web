import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./directory-browser.ts");
}

/**
 * Die Laufwerksliste des Windows-Pickers.
 *
 * `listWindowsDrives` fragt 26 Kandidaten mit `stat` und behaelt die, die es
 * wirklich gibt. Auf einem POSIX-System gibt es keines davon, und genau das ist
 * die Zusage: eine leere Liste, kein Fehler. Ein Wurf waere ein Picker, der auf
 * dem Entwicklungsserver nicht rendert.
 */
test("returns only drives that exist as directories", async () => {
  const { listWindowsDrives } = await loadSubject();

  const drives = await listWindowsDrives();

  assert.ok(Array.isArray(drives));
  for (const drive of drives) {
    assert.match(drive.name, /^[A-Z]:$/);
    assert.equal(drive.path, `${drive.name}\\`);
  }
  if (process.platform !== "win32") {
    assert.deepEqual(drives, [], "auf POSIX gibt es keine Laufwerksbuchstaben");
  }
});
