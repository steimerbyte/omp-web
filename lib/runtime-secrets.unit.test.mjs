import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./runtime-secrets.ts");
}

/**
 * Die Diagnose "gibt es ueberhaupt eine Geheimnisdatei?"
 *
 * Sie steht im Startlog und entscheidet nichts; der Wert ist deshalb nur dann
 * brauchbar, wenn er den *konfigurierten* Pfad meint und nicht einen fest
 * eingebauten. Ein leerer Override zaehlt nicht als Pfad — sonst zeigte die
 * Zeile auf `""` und meldete "keine Datei" fuer eine Installation, die ihre
 * Geheimnisse sehr wohl hat.
 */
test("reports whether the configured secrets file exists", async () => {
  const { secretsFileExists, DEFAULT_SECRETS_FILE } = await loadSubject();
  const dir = mkdtempSync(join(tmpdir(), "omp-secrets-"));

  try {
    const present = join(dir, "omp-web.env");
    writeFileSync(present, "BRAVE_API_KEY=abc\n");

    assert.equal(secretsFileExists({ OMP_WEB_SECRETS_FILE: present }), true);
    assert.equal(secretsFileExists({ OMP_WEB_SECRETS_FILE: join(dir, "missing.env") }), false);
    assert.equal(secretsFileExists({ OMP_WEB_SECRETS_FILE: "   " }), existsSync(DEFAULT_SECRETS_FILE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
