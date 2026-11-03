import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Der letzte vertrauenswuerdige Punkt vor dem SDK: `resolveModelDiscoveryAuth`
 * schreibt den Provider in ein temporaeres `models.json`, und das SDK fuehrt
 * jeden `!`-Wert daraus per `/bin/sh -c` aus. Ein HTTP-Body darf dort nie
 * ankommen — auch nicht, wenn eine kuenftige Route den Guard davor vergisst.
 */

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { commandConfigValuePath, resolveModelDiscoveryAuth } = await jiti.import("./model-discovery-auth.ts");

const ROOT = mkdtempSync(join(tmpdir(), "omp-web-model-discovery-auth-"));

test.after(() => rmSync(ROOT, { recursive: true, force: true }));

test("commandConfigValuePath findet `!`-Werte in verschachtelten Provider-Feldern", () => {
  assert.equal(commandConfigValuePath({ headers: { "X-Probe": "!touch /tmp/x" } }, "provider"), "provider.headers.X-Probe");
  assert.equal(commandConfigValuePath({ apiKey: "!op read key" }, "provider"), "provider.apiKey");
  assert.equal(commandConfigValuePath({ models: [{ headers: { "X-Probe": "!touch /tmp/x" } }] }, "provider"), "provider.models[0].headers.X-Probe");
  assert.equal(commandConfigValuePath({ headers: { "X-Probe": "$ENV_VAR" } }, "provider"), null);
});

test("resolveModelDiscoveryAuth lehnt `!`-Werte ab, bevor ein Kommando laufen kann", async () => {
  const marker = join(ROOT, "rce-marker");
  await assert.rejects(
    resolveModelDiscoveryAuth("probe", {
      baseUrl: "https://models.example/v1",
      api: "openai-completions",
      headers: { "X-Probe": `!touch ${marker}` },
    }),
    /must not be a command value/,
  );
  assert.equal(existsSync(marker), false, "der Header wurde als Kommando ausgefuehrt");
});
