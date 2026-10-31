import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { makeSessionShellGuard } from "./session-shell-guard.ts";

/**
 * Die einzige Grenze, die der Agent-`bash` bekommen kann.
 *
 * Das SDK 18.14.0 hat keine Sandbox fuer seinen Shell (`SHELL-ISOLATION-SCAN`
 * §5), aber einen `tool_call`-Haken, der blocken darf. Was hier geprueft wird,
 * ist die Entscheidung, nicht die Mechanik: Home ja, fremder Pfad nein, Admin
 * ohne Grenze, andere Werkzeuge unberuehrt.
 */

function identity(username, isAdmin = false) {
  return { username, isAdmin };
}

function fakePi() {
  const handlers = {};
  return {
    cwd: "/",
    on(event, handler) {
      (handlers[event] ??= []).push(handler);
    },
    handlers,
  };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "omp-shell-guard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "alice");
  mkdirSync(join(home, "sub"), { recursive: true });
  const previous = process.env.OMP_WEB_HOME_ROOT;
  process.env.OMP_WEB_HOME_ROOT = root;
  t.after(() => {
    if (previous === undefined) delete process.env.OMP_WEB_HOME_ROOT;
    else process.env.OMP_WEB_HOME_ROOT = previous;
  });
  return { root, home };
}

async function decide(guard, identity_, event, cwd) {
  const pi = fakePi();
  guard(pi);
  const call = pi.handlers.tool_call?.[0];
  assert.ok(call, "the guard has to register a tool_call handler");
  return call(event, { cwd });
}

test("bash im eigenen Home laeuft", async (t) => {
  const { home } = fixture(t);
  const result = await decide(makeSessionShellGuard(identity("alice")), null, {
    type: "tool_call",
    toolCallId: "1",
    toolName: "bash",
    input: { command: "ls" },
  }, home);
  assert.equal(result, undefined, "a command in the account's own home must not be blocked");
});

test("bash ausserhalb des Homes wird geblockt, mit Grund", async (t) => {
  fixture(t);
  const result = await decide(makeSessionShellGuard(identity("alice")), null, {
    type: "tool_call",
    toolCallId: "2",
    toolName: "bash",
    input: { command: "cat /etc/shadow" },
  }, "/etc");
  assert.equal(result?.block, true);
  assert.match(result.reason, /inside .*alice/);
});

test("ein cwd-Argument ausserhalb des Homes wird geblockt, auch wenn die Sitzung im Home liegt", async (t) => {
  const { home } = fixture(t);
  const result = await decide(makeSessionShellGuard(identity("alice")), null, {
    type: "tool_call",
    toolCallId: "3",
    toolName: "bash",
    input: { command: "ls", cwd: "/home/someone-else" },
  }, home);
  assert.equal(result?.block, true);
});

test("ein relatives cwd bleibt im Home und laeuft", async (t) => {
  const { home } = fixture(t);
  const result = await decide(makeSessionShellGuard(identity("alice")), null, {
    type: "tool_call",
    toolCallId: "4",
    toolName: "bash",
    input: { command: "ls", cwd: "sub" },
  }, home);
  assert.equal(result, undefined);
});

test("ein URL-cwd ist kein Arbeitsverzeichnis", async (t) => {
  fixture(t);
  const result = await decide(makeSessionShellGuard(identity("alice")), null, {
    type: "tool_call",
    toolCallId: "5",
    toolName: "bash",
    input: { command: "ls", cwd: "https://example.com/x" },
  }, "/tmp");
  assert.equal(result?.block, true);
});

test("andere Werkzeuge bleiben unberuehrt", async (t) => {
  const { home } = fixture(t);
  const result = await decide(makeSessionShellGuard(identity("alice")), null, {
    type: "tool_call",
    toolCallId: "6",
    toolName: "read",
    input: { path: "/etc/hostname" },
  }, home);
  assert.equal(result, undefined, "only bash is gated here; read/write are the route allowlist's business");
});

test("ein Admin bekommt keine Grenze", () => {
  const pi = fakePi();
  makeSessionShellGuard(identity("operator", true))(pi);
  assert.deepEqual(
    Object.keys(pi.handlers),
    [],
    "an admin is the host; the guard must not pretend otherwise",
  );
});
test("ein cd in den Kommandotext sieht der Haken nicht — die gemessene Grenze", async (t) => {
  const { home } = fixture(t);
  // Das Parameterschema des bash-Werkzeugs ist in 18.14.0 `{command, timeout}`:
  // es gibt keinen cwd-Parameter, also entscheidet der Haken gegen `ctx.cwd`.
  // Ein `cd /` im Text ist damit erlaubt, und dieser Test haelt das fest, statt
  // es spaeter fuer eine Luecke im Filter zu halten.
  const result = await decide(makeSessionShellGuard(identity("alice")), null, {
    type: "tool_call",
    toolCallId: "7",
    toolName: "bash",
    input: { command: "cd / && ls /" },
  }, home);
  assert.equal(result, undefined, "the gate reads the session cwd, not the shell language");
});
