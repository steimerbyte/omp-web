import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * `ModelsConfigFile` ist ein Modul-Singleton mit eigenem Parse-Cache, und sein
 * Pfad steht beim Laden des SDK fest. Beides ist in einem Testprozess, der die
 * SDK-Module mit anderen Testdateien teilt, nicht mehr umzubiegen — deshalb
 * laeuft der Nachweis in einem eigenen Prozess mit eigenem Agent-Verzeichnis.
 */
const MODELS_CONFIG = new URL("../node_modules/@oh-my-pi/pi-coding-agent/src/config/models-config.ts", import.meta.url).href;
const OMP_RUNTIME = new URL("./omp-runtime.ts", import.meta.url).href;

const PROBE = `
import { writeFileSync } from "node:fs";
const dir = process.env.PI_CODING_AGENT_DIR;
const { ModelsConfigFile } = await import(${JSON.stringify(MODELS_CONFIG)});
const { invalidateOmpRuntime } = await import(${JSON.stringify(OMP_RUNTIME)});
const file = dir + "/models.yml";
const writeProvider = (name) => writeFileSync(file, "providers:\\n  " + name + ":\\n    auth: none\\n    baseUrl: http://" + name + ".example\\n");
const providers = () => Object.keys(ModelsConfigFile.load()?.providers ?? {}).join(",");
writeProvider("alpha");
console.log("path=" + ModelsConfigFile.path());
console.log("first=" + providers());
// Der Edit landet in der Datei, der Cache hielte aber die alte Liste: genau das
// war der Fehler — der Picker zeigte den neuen Provider nie.
writeProvider("beta");
console.log("stale=" + providers());
invalidateOmpRuntime();
console.log("fresh=" + providers());
`;

test("invalidateOmpRuntime drops the SDK's cached models.yml parse", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-models-cache-"));
  const probePath = join(agentDir, "probe.mjs");
  writeFileSync(probePath, PROBE);
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));

  const out = execFileSync(process.execPath, [probePath], {
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, NODE_ENV: "test" },
  });
  const lines = new Map(out.trim().split("\n").map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));

  assert.equal(lines.get("path"), join(agentDir, "models.yml"));
  assert.equal(lines.get("first"), "alpha");
  assert.equal(lines.get("stale"), "alpha");
  assert.equal(lines.get("fresh"), "beta");
});

test("der models-config-PUT verwirft den Cache nach dem Schreiben", () => {
  const source = readFileSync(new URL("../app/api/models-config/route.ts", import.meta.url), "utf8");
  const putSource = source.slice(source.indexOf("export async function PUT"));

  assert.match(putSource, /writeModelsConfig\(/);
  assert.ok(
    putSource.indexOf("writeModelsConfig(") < putSource.indexOf("invalidateOmpRuntime()"),
    "the runtime must be dropped after the write, not before",
  );
});
