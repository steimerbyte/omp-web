import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  MAX_REPLAY_BYTES,
  TerminalManager,
  TerminalReplayBuffer,
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
    closed: 0,
    write(chunk) {
      chunks.push(Buffer.from(chunk).toString("utf8"));
      return Promise.resolve();
    },
    close() {
      this.closed += 1;
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

// ---------------------------------------------------------------------------
// Replay-Puffer: die Grenze ist ohne Prozess messbar, deshalb hier.
// ---------------------------------------------------------------------------

const replayText = (buffer) => Buffer.concat([...buffer.snapshot()]).toString("utf8");
const countOf = (text, needle) => text.split(needle).length - 1;

test("the replay buffer keeps the newest bytes in order and drops the oldest", () => {
  const buffer = new TerminalReplayBuffer(10);
  buffer.append(Buffer.from("012345"));
  assert.equal(replayText(buffer), "012345");

  buffer.append(Buffer.from("6789AB"));
  assert.equal(replayText(buffer), "23456789AB", "die aeltesten Bytes fallen zuerst");

  buffer.append(Buffer.from("CD"));
  assert.equal(replayText(buffer), "456789ABCD");
  assert.equal(Buffer.concat([...buffer.snapshot()]).length, 10);
});

test("a single chunk larger than the budget keeps only its own tail", () => {
  const buffer = new TerminalReplayBuffer(4);
  buffer.append(Buffer.from("abcdefgh"));
  assert.deepEqual([...buffer.snapshot()].map((chunk) => chunk.toString("utf8")), ["efgh"]);

  // Und ein Chunk, der das Budget genau trifft, bleibt vollstaendig.
  buffer.append(Buffer.from("wxyz"));
  assert.equal(replayText(buffer), "wxyz");
});

test("the default budget is 256 KiB", () => {
  assert.equal(MAX_REPLAY_BYTES, 256 * 1024);
  const buffer = new TerminalReplayBuffer();
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  for (let i = 0; i < 5; i += 1) buffer.append(chunk);
  assert.equal(Buffer.concat([...buffer.snapshot()]).length, MAX_REPLAY_BYTES);
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

  // A valid size is accepted and reported to the UI, an impossible one is refused.
  await manager.resize(info.id, 120, 40);
  assert.equal(manager.get(info.id)?.cols, 120);
  assert.equal(manager.get(info.id)?.rows, 40);
  await assert.rejects(() => manager.resize(info.id, 1, 0), /Invalid terminal size/);
  // Eine unbekannte Id ist folgenlos: die Route prueft den Besitz vorher.
  await manager.resize("unknown-id", 90, 30);

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

test("kill() closes an attached stream", { skip: !canSpawn && "needs Linux and /usr/bin/script", timeout: 30_000 }, async (t) => {
  const dir = tempDir(t);
  const manager = getTerminalManager();
  const info = await manager.spawn(dir, 80, 24, "operator", true);

  const writer = fakeWriter();
  manager.attach(info.id, writer);
  await manager.write(info.id, "printf 'before-kill\\n'\n");
  await waitFor(() => writer.chunks.join("").includes("before-kill"));

  await manager.kill(info.id);
  assert.equal(manager.get(info.id), null);
  assert.equal(writer.closed, 1, "der Strom muss geschlossen werden");
  assert.match(writer.chunks.at(-1), /\[Process exited with code -1\]/);
  // Ein zweites kill() ist folgenlos und schliesst nicht noch einmal.
  await manager.kill(info.id);
  assert.equal(writer.closed, 1);
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

test("a reattached client gets the history once, then live output", { skip: !canSpawn && "needs Linux and /usr/bin/script", timeout: 30_000 }, async (t) => {
  const dir = tempDir(t);
  const manager = getTerminalManager();
  const info = await manager.spawn(dir, 80, 24, "operator", true);
  t.after(() => manager.kill(info.id).catch(() => undefined));

  // Der Spawn setzt die echte PTY-Winsize, nicht nur COLUMNS/LINES — sonst
  // steht dort `0 0` und `vim`/`htop` lesen den falschen ioctl.
  const sizeDump = join(dir, "size.txt");
  await manager.write(info.id, `stty size > ${JSON.stringify(sizeDump)}\n`);
  await waitFor(() => existsSync(sizeDump) && readFileSync(sizeDump, "utf8").trim() !== "");
  assert.equal(readFileSync(sizeDump, "utf8").trim(), "24 80");

  // Erster Client haengt sich an eine Shell, die den Banner schon geschrieben
  // hat: er bekommt ihn aus dem Verlauf.
  const first = fakeWriter();
  const detachFirst = manager.attach(info.id, first);
  const banner = first.chunks.join("");
  assert.match(banner, /\[omp-web terminal\]/);
  assert.match(banner, /\(shell=[A-Za-z0-9._-]+\)/, "der aufgeloeste Shell-Name, nicht die leere $0");
  assert.doesNotMatch(banner, /\(shell= ?\)/);

  await manager.write(info.id, `printf 'MARK-%s\\n' ONE\n`);
  await manager.write(info.id, `printf 'MARK-%s\\n' TWO\n`);
  await waitFor(() => first.chunks.join("").includes("MARK-TWO"));

  // Das Echo der Kommandos enthaelt "MARK-%s", die Ausgabe "MARK-ONE"; jedes
  // Markenzeichen kommt beim ersten Client genau einmal an.
  const live = first.chunks.join("");
  assert.equal(countOf(live, "MARK-ONE"), 1);
  assert.equal(countOf(live, "MARK-TWO"), 1);
  detachFirst();

  // Zweiter Client: der Verlauf kommt aus dem Puffer, in Reihenfolge, je
  // einmal — und nicht doppelt, obwohl der erste Client ihn auch gesehen hat.
  const second = fakeWriter();
  manager.attach(info.id, second);
  const replay = second.chunks.join("");
  assert.equal(countOf(replay, "MARK-ONE"), 1);
  assert.equal(countOf(replay, "MARK-TWO"), 1);
  assert.ok(replay.indexOf("MARK-ONE") < replay.indexOf("MARK-TWO"));
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
