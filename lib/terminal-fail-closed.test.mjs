import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TerminalManager, TerminalUnavailableError } from "./terminal-manager.ts";

/**
 * Das Terminal ist fail-closed.
 *
 * Die alte Fassung oeffnete bei jedem Fehlschlag eine **unconfined** Shell und
 * reichte die volle Dienstumgebung durch — dreifach gemessen in
 * SHELL-ISOLATION-SCAN §2: fehlendes `bwrap`, cwd ausserhalb des Homes,
 * fehlendes Home. Hier sind die zwei Zweige, die sich ohne Attrappe pruefen
 * lassen: die Absage fuer einen Mandanten und der bewusst unconfined Admin.
 */

const IS_LINUX = process.platform !== "win32";

function sandboxRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "omp-term-isolation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("ein Mandant bekommt keine Shell, wenn die Sandbox nicht gebaut werden kann", async (t) => {
  const homeRoot = sandboxRoot(t);
  mkdirSync(join(homeRoot, "alice"), { recursive: true });
  const previous = process.env.OMP_WEB_HOME_ROOT;
  process.env.OMP_WEB_HOME_ROOT = homeRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.OMP_WEB_HOME_ROOT;
    else process.env.OMP_WEB_HOME_ROOT = previous;
  });

  const manager = new TerminalManager();
  // `/etc` liegt ausserhalb des Kontohomes. Der Plan lehnt ab — und jetzt wird
  // der Spawn abgelehnt, statt eine Shell in `/etc` unconfined zu starten.
  await assert.rejects(
    () => manager.spawn("/etc", 80, 24, "alice", false),
    (error) => {
      assert.ok(error instanceof TerminalUnavailableError, `expected a refusal, saw ${error?.constructor?.name}`);
      assert.ok(
        ["cwd-outside-home", "bwrap-missing", "userns-disabled"].includes(error.reason),
        `unexpected reason ${error.reason}`,
      );
      assert.ok(error.remediation.length > 0, "a refusal without remediation is a dead end");
      return true;
    },
  );
  assert.deepEqual(manager.list(), [], "a refused spawn must not register a terminal");
});

test("der Admin laeuft bewusst unconfined, aber ohne die Umgebung der Unit", { skip: !IS_LINUX && "the unsandboxed branch is POSIX-only", timeout: 30_000 }, async (t) => {
  const dir = sandboxRoot(t);
  const previous = { password: process.env.OMP_WEB_PASSWORD, brave: process.env.BRAVE_API_KEY };
  process.env.OMP_WEB_PASSWORD = "admin-pass-DO-NOT-LEAK";
  process.env.BRAVE_API_KEY = "brave-secret-DO-NOT-LEAK";
  t.after(() => {
    if (previous.password === undefined) delete process.env.OMP_WEB_PASSWORD;
    else process.env.OMP_WEB_PASSWORD = previous.password;
    if (previous.brave === undefined) delete process.env.BRAVE_API_KEY;
    else process.env.BRAVE_API_KEY = previous.brave;
  });

  const manager = new TerminalManager();
  const info = await manager.spawn(dir, 80, 24, "operator", true);
  t.after(() => manager.kill(info.id).catch(() => undefined));

  // `sandboxed: false` ist die Wahrheit, die die API ausgibt: der Admin ist der
  // Host, seine Grenze ist keine. Was bleiben muss, ist die Umgebung.
  assert.equal(info.sandboxed, false);

  const dump = join(dir, "env.txt");
  await manager.write(info.id, `env | sort > ${dump}; exit\n`);
  for (let i = 0; i < 200 && !existsSync(dump); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(existsSync(dump), "the admin shell did not run the command");
  const out = readFileSync(dump, "utf8");

  // Der gemessene Defekt war genau hier: die drei Werte standen in der Shell.
  for (const value of ["OMP_WEB_PASSWORD", "BRAVE_API_KEY", "admin-pass-DO-NOT-LEAK", "brave-secret-DO-NOT-LEAK"]) {
    assert.ok(!out.includes(value), `${value} reached the unsandboxed shell`);
  }
  // Und sie ist benutzbar: PATH und HOME sind da.
  assert.match(out, /^PATH=/m);
  assert.match(out, /^HOME=/m);
});
