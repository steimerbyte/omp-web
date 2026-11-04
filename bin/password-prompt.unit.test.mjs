// bin/password-prompt.js liest im Raw-Modus. Der Test ersetzt stdin/stdout
// durch Attrappen und prueft die Tastenzweige (Enter, Backspace, Escape,
// Ctrl+C/D), die Nicht-TTY-Ablehnung und die Wiederholung in readNewPassword.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { PromptAbortedError, isInteractive, promptHidden, readNewPassword } = require("./password-prompt.js");

class FakeStdin {
  constructor({ isTTY = true } = {}) {
    this.isTTY = isTTY;
    this.isRaw = false;
    this.rawModes = [];
    this.handlers = new Set();
    this.queue = [];
    this.resumed = 0;
    this.paused = 0;
    this.encoding = null;
  }
  setRawMode(value) { this.isRaw = value; this.rawModes.push(value); }
  resume() { this.resumed += 1; }
  pause() { this.paused += 1; }
  setEncoding(encoding) { this.encoding = encoding; }
  on(event, cb) {
    if (event !== "data") return;
    this.handlers.add(cb);
    queueMicrotask(() => {
      if (!this.handlers.has(cb)) return;
      const chunk = this.queue.shift();
      if (chunk !== undefined) cb(chunk);
    });
  }
  removeListener(event, cb) {
    if (event === "data") this.handlers.delete(cb);
  }
  push(chunk) {
    if (this.handlers.size > 0) {
      for (const cb of [...this.handlers]) cb(chunk);
      return;
    }
    this.queue.push(chunk);
  }
}

class FakeStdout {
  constructor({ isTTY = true } = {}) { this.isTTY = isTTY; this.text = ""; }
  write(chunk) { this.text += String(chunk); return true; }
}

function withTerminal(stdin, stdout, fn) {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, "stdout");
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true, writable: true });
  Object.defineProperty(process, "stdout", { value: stdout, configurable: true, writable: true });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      Object.defineProperty(process, "stdin", stdinDescriptor);
      Object.defineProperty(process, "stdout", stdoutDescriptor);
    });
}

test("isInteractive verlangt zwei TTYS", () => withTerminal(new FakeStdin(), new FakeStdout(), () => {
  assert.equal(isInteractive(), true);
  const stdin = new FakeStdin({ isTTY: false });
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true, writable: true });
  assert.equal(isInteractive(), false);
}));

test("promptHidden sammelt Zeichen, verwirft Backspace und Escape-Sequenzen", () => withTerminal(
  new FakeStdin(), new FakeStdout(), async function run() {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const pending = promptHidden("Passwort: ");
    await Promise.resolve();
    assert.match(stdout.text, /Passwort: /);
    assert.equal(stdin.encoding, "utf8");
    assert.deepEqual(stdin.rawModes, [true]);

    stdin.push("abc");
    stdin.push("\u007f"); // Backspace
    stdin.push("d");
    stdin.push("\u001b[A"); // Pfeil hoch: der Rest des Chunks wird ignoriert
    stdin.push("e");
    stdin.push("\r");

    assert.equal(await pending, "abde");
    assert.deepEqual(stdin.rawModes, [true, false]);
    assert.equal(stdin.paused, 1);
    assert.equal(stdout.text.endsWith("\n"), true);
  }));

test("Ctrl+C und Ctrl+D brechen den Prompt ab", async () => {
  await withTerminal(new FakeStdin(), new FakeStdout(), async () => {
    const pending = promptHidden("X: ");
    await Promise.resolve();
    process.stdin.push("\u0003");
    await assert.rejects(pending, (error) => {
      assert.ok(error instanceof PromptAbortedError);
      assert.equal(error.name, "PromptAbortedError");
      assert.equal(error.message, "Password entry cancelled");
      return true;
    });
  });

  // Ctrl+D zaehlt nur bei leerer Eingabe als EOF.
  await withTerminal(new FakeStdin(), new FakeStdout(), async () => {
    const pending = promptHidden("X: ");
    await Promise.resolve();
    process.stdin.push("ab");
    process.stdin.push("\u0004");
    process.stdin.push("\n");
    assert.equal(await pending, "ab");
  });
});

test("ohne TTY wird kein Prompt geoeffnet", () => withTerminal(
  new FakeStdin({ isTTY: false }), new FakeStdout({ isTTY: false }), async function run() {
    await assert.rejects(() => promptHidden("X: "), /A terminal is required to enter a password/);
    assert.equal(process.stdout.text, "");
  }));

test("readNewPassword wiederholt kurze und abweichende Eingaben", () => withTerminal(
  new FakeStdin(), new FakeStdout(), async function run() {
    const stdin = process.stdin;
    const stdout = process.stdout;
    // 1. zu kurz -> neuer Versuch; 2. bestaetigt nicht; 3. passt.
    for (const chunk of ["kurz\r", "langgenug\r", "anders\r", "langgenug\r", "langgenug\r"]) stdin.push(chunk);
    const password = await readNewPassword();
    assert.equal(password, "langgenug");
    assert.match(stdout.text, /at least 8 characters long/);
    assert.match(stdout.text, /The passwords do not match/);
    assert.equal((stdout.text.match(/New password: /g) ?? []).length >= 2, true);
  }));
