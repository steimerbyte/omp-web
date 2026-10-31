import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manager = readFileSync(new URL("./terminal-manager.ts", import.meta.url), "utf8");
const listRoute = readFileSync(new URL("../app/api/terminal/route.ts", import.meta.url), "utf8");
const itemRoute = readFileSync(new URL("../app/api/terminal/[id]/route.ts", import.meta.url), "utf8");

/**
 * Die Verdrahtung zwischen Manager, Sandbox und HTTP-Antwort.
 *
 * Die Laufzeitpruefung von `lib/sandbox.test.mjs` deckt das *Modul* ab, die von
 * `terminal-fail-closed.test.mjs` den Manager. Hier geht es um die Naht, die
 * sonst niemand sieht: dass `spawn()` die Sandbox benutzt, dass die Umgebung aus
 * der Allow-Liste kommt (nicht aus `process.env` mit einem `delete`), dass eine
 * fehlende Sandbox eine Absage und keine unconfined Shell ist, und dass die API
 * sagt, ob isoliert wurde.
 */
test("spawn() baut die Shell ueber den Sandbox-Plan, nicht als nackten Prozess", () => {
  assert.match(manager, /planSandboxSpawn\(/);
  // `cmd = plan.argv` ist der Punkt, an dem aus "Voraussetzungen vorhanden"
  // eine tatsaechlich sandboxte Shell wird.
  assert.match(manager, /cmd = plan\.argv/);
});

test("die Umgebung kommt aus der Allow-Liste, nicht aus process.env mit einem delete", () => {
  assert.match(manager, /buildTerminalEnv\(/);
  // Der gemessene falsche Weg: `delete env.OMP_WEB_PASSWORD` entfernt einen
  // Schluessel aus der Kopie und laesst `BRAVE_API_KEY` und alles andere in der
  // Shell stehen. Ein `...process.env` im Spawn waere derselbe Defekt.
  assert.ok(!/delete env\./.test(manager), "the env must not be built by deleting from a copy of process.env");
  assert.ok(!/\.\.\.process\.env/.test(manager), "the terminal must not inherit process.env");
});

test("ohne Sandbox wird die Shell verweigert, nicht unconfined geoeffnet", () => {
  // Die alte Fassung loggte `console.warn` und machte weiter. Ein `throw` ist
  // die Zusage, auf die sich die Route (503) und der Test verlassen.
  assert.match(manager, /throw new TerminalUnavailableError\(/);
  assert.ok(!/shell runs unisolated/.test(manager), "fail-open must be gone, not renamed");
});

test("die Geheimnisdatei des Dienstes wird unter dem gebundenen /etc maskiert", () => {
  // `/etc` ist ganz gebunden, damit eine Shell ueberhaupt funktioniert. Ohne
  // Maske liegt die Geheimnisdatei darin und gehoert dem Dienstbenutzer — die
  // Namespace aendert die uid nicht, `cat /etc/omp-web.env` liefert dann das
  // Admin-Passwort. Gemessen: ein `/dev/null`-Bind scheitert an MS_NODEV, eine
  // leere regulaere Datei nicht.
  assert.match(manager, /maskFiles:/);
  assert.match(manager, /resolveWebAuthFile\(\)/);
  assert.match(manager, /sessionKeyFile\(\)/);
  assert.match(manager, /resolveSecretsFile\(\)/);
});

test("Windows verweigert die Mandanten-Shell, statt sie unconfined zu oeffnen", () => {
  // Die alte Bedingung `!isWindows && …` hat auf win32 jeden Mandanten
  // durchgelassen; `sandboxed: false` war dann die Ausgabe.
  assert.match(manager, /isWindows && !isAdmin/);
});

test("die API verweigert ein cwd ausserhalb des eigenen Homes", () => {
  assert.match(listRoute, /isPathInUserHome\(/);
  assert.match(listRoute, /status: 503/);
});

test("die API nennt, ob eine Shell wirklich sandboxed ist", () => {
  // Beide Serialisierungen, sonst sieht ein Client je nach Route etwas
  // anderes. Der Schluessel muss vorhanden sein, nicht nur deklariert.
  assert.match(listRoute, /sandboxed: info\.sandboxed/);
  assert.match(itemRoute, /sandboxed: info\.sandboxed/);
  assert.match(manager, /sandboxed,/);
});
