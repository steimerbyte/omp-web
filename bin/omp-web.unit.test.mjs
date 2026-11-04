// bin/omp-web.js fuehrt beim require sofort aus: Options lesen, Passwortstatus
// klaeren, dann `next start` spawnen. Der Test ersetzt child_process.spawn
// (kein echter Server, kein Browser) und process.exit (sonst stirbt der
// Testprozess). Jede Szene laedt das Modul frisch.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const store = require("./web-auth-store.js");
const MODULE = require.resolve("./omp-web.js");

// Der Launcher bricht ohne Build-Verzeichnis ab. In einem frischen Checkout
// (CI) fehlt .next; der Test legt dann ein leeres an und raeumt es wieder weg.
const NEXT_DIR = new URL("../.next", import.meta.url).pathname;
const createdNextDir = !existsSync(NEXT_DIR);
if (createdNextDir) mkdirSync(NEXT_DIR);

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.unrefCalls = 0;
  }
  unref() { this.unrefCalls += 1; }
}

const spawnCalls = [];
const originalSpawn = childProcess.spawn;
// process.exit wird global ersetzt: der exit-Handler von startServer liest es
// erst, wenn das Kind endet — also nach dem Ende von load().
const originalExit = process.exit;
const fileExits = [];
process.exit = (code) => { fileExits.push(code); };
// Auch console bleibt ersetzt: setPasswordInteractively loggt erst nach dem
// Ende von load(), wenn die Passwortabfrage beantwortet ist.
const originalConsole = { log: console.log, warn: console.warn, error: console.error };
let currentLogs = [];
for (const level of ["log", "warn", "error"]) {
  console[level] = (...parts) => currentLogs.push([level, parts.map(String).join(" ")]);
}

const flush = async (rounds = 3) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function makeRoot() {
  return mkdtempSync(join(tmpdir(), "omp-web-bin-"));
}

/**
 * Laedt bin/omp-web.js mit einer frischen Modulinstanz. `prepare` darf die
 * Dateisystem-Fixtures anlegen, bevor das Modul liest.
 */
async function load({ args = [], root, prepare } = {}) {
  const base = root ?? makeRoot();
  const authFile = join(base, "omp-web-auth.json");
  const secretsFile = join(base, "omp-web.env");
  if (!prepare) writeFileSync(secretsFile, "");
  prepare?.({ root: base, authFile, secretsFile });

  const logs = [];
  const exits = [];
  const real = {
    argv: process.argv,
    env: { ...process.env },
  };
  spawnCalls.length = 0;
  fileExits.length = 0;
  currentLogs = logs;
  process.argv = ["bun", "omp-web", ...args];
  for (const key of ["OMP_WEB_AUTHENTICATED", "OMP_WEB_NO_OPEN", "OMP_WEB_HOSTNAME", "OMP_WEB_BUN", "OMP_WEB_PASSWORD", "PORT"]) delete process.env[key];
  process.env.OMP_WEB_AUTH_FILE = authFile;
  process.env.OMP_WEB_SECRETS_FILE = secretsFile;
  childProcess.spawn = (command, spawnArgs, options) => {
    const child = new FakeChild();
    spawnCalls.push({ command, args: spawnArgs, options, child });
    return child;
  };
  store.clearEnvironmentFileCache();

  const children = [];
  try {
    delete require.cache[MODULE];
    require("./omp-web.js");
    await flush();
    for (const call of spawnCalls) children.push(call.child);
    // Live-Referenz: startServer spawnt xdg-open erst nach dem Ready-Signal.
    return { logs, exits: fileExits, calls: spawnCalls, authFile, secretsFile, root: base };
  } finally {
    childProcess.spawn = originalSpawn;
    process.argv = real.argv;
    for (const key of Object.keys(process.env)) if (!(key in real.env)) delete process.env[key];
    Object.assign(process.env, real.env);
  }
}

test.after(() => {
  childProcess.spawn = originalSpawn;
  process.exit = originalExit;
  Object.assign(console, originalConsole);
  if (createdNextDir) {
    try { rmdirSync(NEXT_DIR); } catch { /* schon weg oder nicht leer */ }
  }
});

test("ohne Flags: Loopback-Warnung entfaellt, Ready oeffnet den Browser, exit reicht durch", async () => {
  const run = await load({});
  assert.equal(run.calls.length, 1);
  const start = run.calls[0];
  assert.equal(start.command, process.execPath);
  assert.match(start.args[0], /next[\\/]dist[\\/]bin[\\/]next$/);
  assert.deepEqual(start.args.slice(1), ["start", "-p", "30141", "-H", "127.0.0.1"]);
  assert.equal(start.options.env.OMP_WEB_AUTH_FILE, run.authFile);
  assert.equal(start.options.env.OMP_WEB_LAUNCH_CWD, process.cwd());
  assert.equal(run.logs.some(([level]) => level === "warn"), false);

  start.child.stdout.emit("data", Buffer.from("▲ Ready in 2s\n"));
  assert.equal(run.calls.length, 2);
  assert.deepEqual(run.calls[1].args, ["http://127.0.0.1:30141"]);
  assert.equal(run.calls[1].child.unrefCalls, 1);

  start.child.emit("exit", 3);
  assert.deepEqual(run.exits, [3]);
  rmSync(run.root, { recursive: true, force: true });
});

test("--authenticated ohne TTY und ohne Passwort: klare Meldung, exit 1", async () => {
  const run = await load({ args: ["--authenticated"] });
  assert.deepEqual(run.exits, [1]);
  assert.equal(run.calls.length, 0);
  assert.match(run.logs.at(-1)[1], /--authenticated has to ask for a password/);
  rmSync(run.root, { recursive: true, force: true });
});

test("--reset-password mit Umgebungs-Passwort warnt vor der Prioritaet", async () => {
  const run = await load({
    args: ["--reset-password"],
    prepare: ({ authFile, secretsFile }) => {
      writeFileSync(secretsFile, "OMP_WEB_PASSWORD=geheim123\n");
      void authFile;
    },
  });
  assert.deepEqual(run.exits, [1]);
  assert.ok(run.logs.some(([, line]) => line.includes(`Password access is configured by ${run.secretsFile}`)));
  assert.ok(run.logs.some(([level, line]) => level === "warn" && line.includes("takes precedence")));
  rmSync(run.root, { recursive: true, force: true });
});

test("--authenticated schaltet ein gespeichertes Passwort wieder scharf", async () => {
  const run = await load({
    args: ["--authenticated"],
    prepare: ({ authFile, secretsFile }) => {
      writeFileSync(secretsFile, "");
      store.setWebPassword("password123", { file: authFile });
      store.setWebPasswordEnabled(false, { file: authFile });
    },
  });
  assert.equal(run.calls.length, 1);
  assert.ok(run.logs.some(([, line]) => line.includes("Password access enabled with the password already stored")));
  assert.equal(store.getWebAuthStatus({ file: run.authFile }).enabled, true);
  rmSync(run.root, { recursive: true, force: true });
});

test("--authenticated mit OMP_WEB_PASSWORD startet ohne Prompt", async () => {
  const run = await load({
    args: ["--authenticated"],
    prepare: ({ secretsFile }) => writeFileSync(secretsFile, "OMP_WEB_PASSWORD=geheim123\n"),
  });
  assert.equal(run.calls.length, 1);
  assert.ok(run.logs.some(([, line]) => line.includes("Password access is already required: OMP_WEB_PASSWORD is set.")));
  rmSync(run.root, { recursive: true, force: true });
});

test("interaktiv wird das Passwort zweimal abgefragt und gespeichert", async () => {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, "stdout");
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (value) => { stdin.isRaw = value; };
  const ttyOut = { isTTY: true, text: "", write(chunk) { this.text += String(chunk); return true; } };
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true, writable: true });
  Object.defineProperty(process, "stdout", { value: ttyOut, configurable: true, writable: true });
  try {
    const run = await load({ args: ["--authenticated"] });
    await flush(2);
    assert.match(run.logs.map(([, line]) => line).join("\n"), /--authenticated was requested/);

    stdin.write("password123\r");
    await flush(4);
    stdin.write("password123\r");
    await flush(6);

    assert.equal(store.getWebAuthStatus({ file: run.authFile }).stored, true);
    assert.equal(store.getWebAuthStatus({ file: run.authFile }).enabled, true);
    assert.ok(run.logs.some(([, line]) => line.includes("Password saved.")));
    assert.equal(run.calls.length, 1);
    assert.ok(ttyOut.text.includes("New password: "));
    rmSync(run.root, { recursive: true, force: true });
  } finally {
    Object.defineProperty(process, "stdin", stdinDescriptor);
    Object.defineProperty(process, "stdout", stdoutDescriptor);
  }
});

test("eine oeffentliche Adresse warnt vor fehlender Authentifizierung", async () => {
  const run = await load({ args: ["-H", "0.0.0.0"] });
  assert.equal(run.calls.length, 1);
  assert.ok(run.logs.some(([level, line]) => level === "warn" && line.includes("without authentication")));
  rmSync(run.root, { recursive: true, force: true });
});
