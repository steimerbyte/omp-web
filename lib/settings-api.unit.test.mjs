import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./settings-api.ts");
}

/**
 * Welche Einstellung nur ein Admin schreiben darf.
 *
 * Die Regel ist die Praefix-Grenze: `skills` sperrt `skills` und
 * `skills.customDirectories`, aber nicht `skillsets` — ein `startsWith` ohne
 * den Punkt waere eine Sperre fuer jedes Feld, das zufaellig so anfaengt.
 * Die Route benutzt dieselbe Funktion fuer die Antwort, deshalb muss sie hier
 * stimmen und nicht erst dort.
 */
test("a setting and its children are admin only", async () => {
  const { isAdminOnlySetting } = await loadSubject();

  assert.equal(isAdminOnlySetting("skills"), true);
  assert.equal(isAdminOnlySetting("skills.customDirectories"), true);
  assert.equal(isAdminOnlySetting("disabledProviders"), true);
  assert.equal(isAdminOnlySetting("autolearn.enabled"), true);
});

test("a merely similar name is not admin only", async () => {
  const { isAdminOnlySetting } = await loadSubject();

  assert.equal(isAdminOnlySetting("skillsets"), false);
  assert.equal(isAdminOnlySetting("themes"), false);
  assert.equal(isAdminOnlySetting(""), false);
});

test("ordinary settings stay writable for their account", async () => {
  const { isAdminOnlySetting } = await loadSubject();

  assert.equal(isAdminOnlySetting("theme"), false);
  assert.equal(isAdminOnlySetting("display.compact"), false);
});
