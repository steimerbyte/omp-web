import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  TerminalManager,
  TerminalUnavailableError,
  getTerminalManager,
  resolveDefaultShellCwd,
} from "./terminal-manager.ts";

/**
 * Die Verwaltung einer Shell: Besitz, Sichtbarkeit und das Aufraeumen.
 *
 * Ein echter Prozess ist noetig, weil `attach`/`write`/`kill` an ihm haengen.
 * Der Admin-Zweig ist bewusst unconfined (siehe `terminal-fail-closed`), also
 * laeuft hier eine normale `bash` in einem Temp-Verzeichnis.
 */

const IS_LINUX = process.platform !== "win32";
const HAS_SCRIPT = existsSync("/usr/bin/script");
const canSpawn = IS_LINUX && HAS_SCRIPT;

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-terminal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeWriter() {
  const chunks = [];
  return {
    chunks,
    write(chunk) {
      chunks.push(Buffer.from(chunk).toString("utf8"));
      return Promise.resolve();
    },
    close() {
      return Promise.resolve();
    },
  };
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not reached");
}

test("a relative cwd resolves to the process cwd", () => {
  assert.equal(resolveDefaultShellCwd("/tmp/absolute"), "/tmp/absolute");
  assert.equal(resolveDefaultShellCwd("relative/dir"), process.cwd());
});

test("getTerminalManager is a process singleton", () => {
  assert.equal(getTerminalManager(), getTerminalManager());
  assert.equal(new TerminalManager(), getTerminalManager());
});

test("spawn rejects an account name that cannot go into a shell", async () => {
  const manager = getTerminalManager();

  await assert.rejects(
    () => manager.spawn("/tmp", 80, 24, "bad name; rm -rf /", true),
    (error) => error instanceof TerminalUnavailableError && error.reason === "bad-username",
  );
});

test("admin shell: ownership, listing and lifecycle", { skip: !canSpawn && "needs Linux and /usr/bin/script", timeout: 30_000 }, async (t) => {
  const dir = tempDir(t);
  const manager = getTerminalManager();
  const info = await manager.spawn(dir, 100, 30, "operator", true);
  t.after(() => manager.kill(info.id).catch(() => undefined));

  assert.equal(info.owner, "operator");
  assert.equal(info.sandboxed, false);
  assert.equal(info.cols, 100);
  assert.equal(info.rows, 30);
  assert.equal(info.status, "running");
  assert.equal(info.exitCode, null);

  // Visibility is ownership: another account does not see this shell.
  assert.deepEqual(manager.listAll().map((entry) => entry.id), [info.id]);
  assert.deepEqual(manager.listOwnedBy("operator").map((entry) => entry.id), [info.id]);
  assert.deepEqual(manager.listOwnedBy("someone-else"), []);
  assert.equal(manager.get(info.id)?.id, info.id);
  assert.equal(manager.get("unknown-id"), null);
  assert.equal(manager.isOwnedBy(info.id, "operator"), true);
  assert.equal(manager.isOwnedBy(info.id, "someone-else"), false);
  assert.equal(manager.isOwnedBy("unknown-id", "operator"), false);

  // A valid size is accepted (kept for the UI), an impossible one is refused.
  await manager.resize(info.id, 120, 40);
  await assert.rejects(() => manager.resize(info.id, 1, 0), /Invalid terminal size/);

  // The attach writer receives the shell's output and can be detached again.
  const writer = fakeWriter();
  const detach = manager.attach(info.id, writer);
  await manager.write(info.id, `printf 'attached-out\\n'; exit\n`);
  await waitFor(() => writer.chunks.join("").includes("attached-out"));
  detach();
  assert.ok(writer.chunks.length > 0);

  // The shell exits on its own; the info reports it and stays queryable.
  await waitFor(() => manager.get(info.id)?.status === "exited");
  assert.equal(manager.get(info.id)?.exitCode, 0);

  await assert.rejects(() => manager.write(info.id, "echo\n"), /has exited/);
  await assert.rejects(() => manager.write("unknown-id", "echo\n"), /Unknown terminal session/);

  await manager.kill(info.id);
  assert.equal(manager.get(info.id), null);
  // Killing twice is a no-op.
  await manager.kill(info.id);
});

test("a detached shell buffers early output for the next client", { skip: !canSpawn && "needs Linux and /usr/bin/script", timeout: 30_000 }, async (t) => {
  const dir = tempDir(t);
  const manager = getTerminalManager();
  const info = await manager.spawn(dir, 80, 24, "operator", true);
  t.after(() => manager.kill(info.id).catch(() => undefined));

  // Let the banner arrive while nobody is attached: it is buffered.
  await manager.write(info.id, `printf 'buffered-%s\\n' later; exit\n`);
  await waitFor(() => manager.get(info.id)?.status === "exited");

  const writer = fakeWriter();
  const detach = manager.attach(info.id, writer);
  await waitFor(() => writer.chunks.join("").includes("buffered-later"));
  detach();

  await manager.kill(info.id);
});

test("the process-wide kill hook tears down every registered shell", { skip: !canSpawn && "needs Linux and /usr/bin/script", timeout: 30_000 }, async (t) => {
  const dir = tempDir(t);
  const manager = getTerminalManager();
  const first = await manager.spawn(dir, 80, 24, "operator", true);
  const second = await manager.spawn(dir, 80, 24, "operator", true);
  t.after(() => Promise.all([manager.kill(first.id), manager.kill(second.id)]));

  await manager.write(first.id, "printf 'one\\n'\n");
  await manager.write(second.id, "printf 'two\\n'\n");

  // The constructor registered this handler with `process.once("SIGTERM", …)`
  // and it calls the same private `killAll`.
  process.emit("SIGTERM");

  assert.equal(manager.get(first.id), null);
  assert.equal(manager.get(second.id), null);
});

test("a shell writes into its own cwd and environment", { skip: !canSpawn && "needs Linux and /usr/bin/script", timeout: 30_000 }, async (t) => {
  const dir = tempDir(t);
  const manager = getTerminalManager();
  const info = await manager.spawn(dir, 80, 24, "operator", true);
  t.after(() => manager.kill(info.id).catch(() => undefined));

  assert.equal(info.cwd, dir);
  const dump = join(dir, "env.txt");
  await manager.write(info.id, `printf '%s' "$PWD" > ${JSON.stringify(dump)}; exit\n`);
  await waitFor(() => existsSync(dump) && readFileSync(dump, "utf8").length > 0);
  assert.equal(readFileSync(dump, "utf8"), dir);

  // `script` allocates the PTY, so the shell is not the test process's.
  assert.ok(info.pid > 0);
  assert.equal(dirname(dir), dirname(info.cwd));
});
