import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  __resetRuntimeSecretsCache,
  childEnv,
  getRuntimeSecret,
  inheritedSecretNames,
  runtimeSecrets,
  webAuthEnv,
} from "./runtime-secrets.ts";

/**
 * Die Geheimnisdatei ist der Ersatz fuer `Environment=` in der Unit.
 *
 * Warum das der Schnitt ist und nicht ein `delete process.env`: gemessen auf
 * Bun 1.4.4 entfernt ein `delete` den Wert aus `process.env`, aber nicht aus
 * `/proc/self/environ` und nicht aus einem Kindprozess ohne eigene env-Map —
 * und genau so startet die Brush-Shell des Agenten (SHELL-ISOLATION-SCAN §2b,
 * Fall B gegen Fall C). Ein Test, der nur `process.env` prueft, waere deshalb
 * gruen, waehrend das Geheimnis weiter vererbt wird.
 */

function withSecretsFile(t, content) {
  const dir = mkdtempSync(join(tmpdir(), "omp-secrets-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "omp-web.env");
  writeFileSync(file, content);
  const previous = process.env.OMP_WEB_SECRETS_FILE;
  process.env.OMP_WEB_SECRETS_FILE = file;
  delete process.env.OMP_WEB_PASSWORD;
  delete process.env.BRAVE_API_KEY;
  __resetRuntimeSecretsCache();
  t.after(() => {
    if (previous === undefined) delete process.env.OMP_WEB_SECRETS_FILE;
    else process.env.OMP_WEB_SECRETS_FILE = previous;
    __resetRuntimeSecretsCache();
  });
  return file;
}

test("die Datei traegt das Passwort, obwohl die Prozessumgebung es nicht hat", (t) => {
  withSecretsFile(t, [
    "# Kommentar und Leerzeile werden uebersprungen",
    "",
    'export OMP_WEB_PASSWORD="from-the-file"',
    "BRAVE_API_KEY=brave-from-file",
    "not a key=value line",
    "=novalue",
  ].join("\n"));

  assert.equal(getRuntimeSecret("OMP_WEB_PASSWORD"), "from-the-file");
  assert.equal(getRuntimeSecret("BRAVE_API_KEY"), "brave-from-file");
  assert.equal(process.env.OMP_WEB_PASSWORD, undefined, "the password must not be written into the process env");

  // Die Auth-API liest OMP_WEB_PASSWORD aus der env, die sie bekommt. Genau
  // diese env traegt den Wert, ohne dass er im Prozess steht.
  const env = webAuthEnv();
  assert.equal(env.OMP_WEB_PASSWORD, "from-the-file");
  assert.equal(process.env.OMP_WEB_PASSWORD, undefined);
  // Und der Dateipfad selbst bleibt unveraendert: der mtime-Cache in
  // `lib/web-auth.ts` haengt daran.
  assert.equal(env.OMP_WEB_AUTH_FILE, process.env.OMP_WEB_AUTH_FILE);
});

test("kein Kindprozess erbt ein Geheimnis — gemessen am echten Kind", (t) => {
  withSecretsFile(t, "OMP_WEB_PASSWORD=file-secret\nBRAVE_API_KEY=file-brave\n");
  process.env.OPENROUTER_API_KEY = "process-or-secret";
  t.after(() => delete process.env.OPENROUTER_API_KEY);

  const env = childEnv();
  assert.equal(env.OMP_WEB_PASSWORD, undefined, "must not reach a child");
  assert.equal(env.BRAVE_API_KEY, undefined, "must not reach a child");
  assert.equal(env.OPENROUTER_API_KEY, undefined, "must not reach a child");
  assert.equal(typeof env.PATH, "string", "PATH has to survive, or nothing starts");

  // Der Beleg: ein echtes Kind mit dieser Map sieht die Werte nicht. Das ist
  // die Messung, die zaehlt — `delete process.env` waere hier gruen und im
  // Kind trotzdem rot.
  const out = execFileSync("/usr/bin/env", [], { env, encoding: "utf8" });
  for (const secret of ["OMP_WEB_PASSWORD", "BRAVE_API_KEY", "OPENROUTER_API_KEY", "file-secret", "file-brave", "process-or-secret"]) {
    assert.ok(!out.includes(secret), `${secret} reached the child`);
  }
  assert.match(out, /^PATH=/m);
});

test("die Umgebung meldet, welche Geheimnisse sie noch erbt", (t) => {
  withSecretsFile(t, "OMP_WEB_PASSWORD=file-secret\n");
  process.env.BRAVE_API_KEY = "still-in-the-unit";
  t.after(() => delete process.env.BRAVE_API_KEY);

  // Das ist der Fund fuer die noch nicht umgestellte Unit: der Wert steht in
  // der Umgebung, und KEIN Pfad ohne eigene env-Map kann ihn danach verlieren.
  const inherited = inheritedSecretNames();
  assert.ok(inherited.includes("BRAVE_API_KEY"), `expected BRAVE_API_KEY in ${inherited.join(",")}`);
  // Ein Datei-Schluessel, der nicht in der Umgebung steht, ist kein Fund.
  assert.ok(!inherited.includes("OMP_WEB_PASSWORD"));
});

test("die Datei schlaegt die Umgebung", (t) => {
  withSecretsFile(t, "OMP_WEB_PASSWORD=from-the-file\n");
  process.env.OMP_WEB_PASSWORD = "from-the-environment";
  t.after(() => delete process.env.OMP_WEB_PASSWORD);
  // Ein Betreiber, der beides setzt, hat die Datei bewusst gepflegt; der Wert
  // in der Unit ist der alte Zustand.
  assert.equal(getRuntimeSecret("OMP_WEB_PASSWORD"), "from-the-file");
  assert.equal(runtimeSecrets().get("OMP_WEB_PASSWORD"), "from-the-file");
});

test("eine fehlende Datei ist kein Fehler", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-secrets-none-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.OMP_WEB_SECRETS_FILE;
  process.env.OMP_WEB_SECRETS_FILE = join(dir, "absent.env");
  __resetRuntimeSecretsCache();
  t.after(() => {
    if (previous === undefined) delete process.env.OMP_WEB_SECRETS_FILE;
    else process.env.OMP_WEB_SECRETS_FILE = previous;
    __resetRuntimeSecretsCache();
  });
  assert.equal(runtimeSecrets().size, 0);
  assert.equal(getRuntimeSecret("OMP_WEB_PASSWORD"), undefined);
});
