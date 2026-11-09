// instrumentation.ts hatte keinen Test. register() laedt vier Module ueber
// process.cwd(); der Test legt dafuer Stubs an, wechselt das Verzeichnis und
// prueft beide Runtimes plus die Fehlerzweige.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const INSTRUMENTATION = pathToFileURL(new URL("./instrumentation.ts", import.meta.url).pathname).href;

function makeStubRoot(logPath, { scheduler = true, migration = "ok" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "omp-instrumentation-"));
  mkdirSync(join(root, "lib"), { recursive: true });
  const log = (line) => `appendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(`${line}\n`)});`;
  writeFileSync(join(root, "lib", "http-dispatcher.ts"), `
import { appendFileSync } from "node:fs";
export async function configureHttpDispatcher() { ${log("configureHttpDispatcher")} }
export function ensureLoopbackNotProxied() { ${log("ensureLoopbackNotProxied")} }
`);
  writeFileSync(join(root, "lib", "runtime-secrets.ts"), `
import { appendFileSync } from "node:fs";
function log(line) { appendFileSync(${JSON.stringify(logPath)}, line + "\\n"); }
export function resolveSecretsFile() { log("resolveSecretsFile"); return "/tmp/keine-secrets"; }
export function secretsFileExists() { log("secretsFileExists"); return process.env.HB_SECRETS === "1"; }
export function runtimeSecrets() { log("runtimeSecrets"); return new Map([["A", "1"], ["B", "2"]]); }
export function inheritedSecretNames() { log("inheritedSecretNames"); return process.env.HB_INHERITED === "1" ? ["BRAVE_API_KEY"] : []; }
`);
  if (scheduler) {
    writeFileSync(join(root, "lib", "scheduler.ts"), `
import { appendFileSync } from "node:fs";
export function startScheduler() { appendFileSync(${JSON.stringify(logPath)}, "startScheduler\\n"); }
`);
  }
  if (migration) {
    writeFileSync(join(root, "lib", "tenant-session-migration.ts"), `
import { appendFileSync } from "node:fs";
export function runTenantArchiveMigrationAtStartup() {
  appendFileSync(${JSON.stringify(logPath)}, "runTenantArchiveMigrationAtStartup\\n");
  ${migration === "throws" ? 'throw new Error("kaputt");' : ""}
}
`);
  }
  return root;
}

function captureConsole() {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const lines = { log: [], warn: [], error: [] };
  for (const level of ["log", "warn", "error"]) {
    console[level] = (...args) => { lines[level].push(args.map(String).join(" ")); };
  }
  return { lines, restore: () => Object.assign(console, original) };
}

test("Node-Runtime: Dispatcher, Secrets und Scheduler werden geladen", async () => {
  const logPath = join(mkdtempSync(join(tmpdir(), "omp-instrumentation-log-")), "log.txt");
  const root = makeStubRoot(logPath);
  const cwd = process.cwd();
  const env = { ...process.env };
  const consoleCapture = captureConsole();
  try {
    process.chdir(root);
    process.env.NEXT_RUNTIME = "nodejs";
    delete process.env.HB_INHERITED;
    process.env.HB_SECRETS = "1";
    const { register } = await import(INSTRUMENTATION);
    await register();
    const lines = readFileSync(logPath, "utf8");
    assert.match(lines, /configureHttpDispatcher/);
    assert.match(lines, /resolveSecretsFile/);
    assert.match(lines, /runtimeSecrets/);
    assert.match(lines, /startScheduler/);
    assert.match(lines, /runTenantArchiveMigrationAtStartup/);
    assert.ok(consoleCapture.lines.log.some((line) => line.includes("2 secret(s) loaded from")));
  } finally {
    consoleCapture.restore();
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Edge-Runtime: nur die Loopback-Ausnahme, kein Scheduler", async () => {
  const logPath = join(mkdtempSync(join(tmpdir(), "omp-instrumentation-log-")) , "log.txt");
  const root = makeStubRoot(logPath);
  const cwd = process.cwd();
  const env = { ...process.env };
  const consoleCapture = captureConsole();
  try {
    process.chdir(root);
    process.env.NEXT_RUNTIME = "edge";
    const { register } = await import(INSTRUMENTATION);
    await register();
    assert.match(readFileSync(logPath, "utf8"), /ensureLoopbackNotProxied/);
    assert.doesNotMatch(readFileSync(logPath, "utf8"), /startScheduler/);
    assert.doesNotMatch(readFileSync(logPath, "utf8"), /runTenantArchiveMigrationAtStartup/, "kein Dateizugriff im Edge-Runtime");
  } finally {
    consoleCapture.restore();
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Geheimnisse aus der Umgebung werden gemeldet statt still uebernommen", async () => {
  const logPath = join(mkdtempSync(join(tmpdir(), "omp-instrumentation-log-")), "log.txt");
  const root = makeStubRoot(logPath);
  const cwd = process.cwd();
  const env = { ...process.env };
  const consoleCapture = captureConsole();
  try {
    process.chdir(root);
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.HB_INHERITED = "1";
    const { register } = await import(INSTRUMENTATION);
    await register();
    assert.ok(consoleCapture.lines.warn.some((line) => line.includes("BRAVE_API_KEY")));
  } finally {
    consoleCapture.restore();
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(root, { recursive: true, force: true });
  }
});

test("ein kaputter Scheduler haelt den Server nicht an", async () => {
  const logPath = join(mkdtempSync(join(tmpdir(), "omp-instrumentation-log-")), "log.txt");
  const root = makeStubRoot(logPath, { scheduler: false });
  const cwd = process.cwd();
  const env = { ...process.env };
  const consoleCapture = captureConsole();
  try {
    process.chdir(root);
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.HB_SECRETS = "0";
    delete process.env.HB_INHERITED;
    const { register } = await import(INSTRUMENTATION);
    await assert.doesNotReject(() => register());
    assert.ok(consoleCapture.lines.error.some((line) => line.includes("[scheduler] could not be started")));
  } finally {
    consoleCapture.restore();
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(root, { recursive: true, force: true });
  }
});

test("eine scheiternde Migration haelt den Server nicht an", async () => {
  const logPath = join(mkdtempSync(join(tmpdir(), "omp-instrumentation-log-")), "log.txt");
  const root = makeStubRoot(logPath, { migration: "throws" });
  const cwd = process.cwd();
  const env = { ...process.env };
  const consoleCapture = captureConsole();
  try {
    process.chdir(root);
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.HB_SECRETS = "0";
    delete process.env.HB_INHERITED;
    const { register } = await import(INSTRUMENTATION);
    await assert.doesNotReject(() => register());
    // Eine Zeile, und nur der Befund: `register` laeuft weiter und der Start
    // gelingt. Der Bestand bleibt liegen — das ist schlimm genug zum Melden,
    // aber kein Grund, den Server nicht zu bedienen.
    assert.ok(consoleCapture.lines.error.some((line) => line.includes("[archive-migration] could not be started")));
  } finally {
    consoleCapture.restore();
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(root, { recursive: true, force: true });
  }
});
