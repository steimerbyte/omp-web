import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { isBashOutputPathReferencedBySession } from "./session-file-references.ts";
import { invalidateSessionListCache } from "./session-reader.ts";

/**
 * Bash-Ausgaben sind nur fuer die Session lesbar, die sie erzeugt hat.
 *
 * Der Test legt eine echte Session-Datei an (kein Ersatzobjekt): der Pfad muss
 * durch `SessionManager.listAll` und `getSessionEntries` gehen, weil genau dort
 * die Identitaetsbindung sitzt.
 */

const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
const previousAgentDir = getAgentDir();
const root = mkdtempSync(join(tmpdir(), "omp-web-bash-output-ref-"));
const homeRoot = join(root, "homes");
const agentDir = join(root, "agent");
process.env.OMP_WEB_HOME_ROOT = homeRoot;
setAgentDir(agentDir);

test.after(() => {
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  setAgentDir(previousAgentDir);
  rmSync(root, { recursive: true, force: true });
});

const ALICE = { username: "alice", isAdmin: false };
const BOB = { username: "bob", isAdmin: false };

async function createSession(identity, outputPath) {
  const cwd = join(homeRoot, identity.username, "project");
  mkdirSync(cwd, { recursive: true });
  const manager = SessionManager.create(cwd, undefined);
  await manager.ensureOnDisk();
  manager.appendMessage({
    role: "bashExecution",
    command: "ls",
    output: "output",
    fullOutputPath: outputPath,
    exitCode: 0,
    timestamp: Date.now(),
  });
  invalidateSessionListCache();
  return manager;
}

test("a bash output path is readable from the session that produced it", async (t) => {
  const outputPath = join(homeRoot, "alice", "project", "bash-output.log");
  const manager = await createSession(ALICE, outputPath);
  t.after(() => manager.close?.());

  assert.equal(await isBashOutputPathReferencedBySession(outputPath, manager.getSessionId(), ALICE), true);
  // A path that session never wrote is not a reference.
  assert.equal(await isBashOutputPathReferencedBySession(join(homeRoot, "alice", "other.log"), manager.getSessionId(), ALICE), false);
});

test("a foreign session cannot vouch for the path", async (t) => {
  const outputPath = join(homeRoot, "bob", "project", "bash-output.log");
  const bobSession = await createSession(BOB, outputPath);
  t.after(() => bobSession.close?.());

  assert.equal(await isBashOutputPathReferencedBySession(outputPath, bobSession.getSessionId(), ALICE), false);
  assert.equal(await isBashOutputPathReferencedBySession(outputPath, bobSession.getSessionId(), BOB), true);
});

test("an unknown or malformed session id never resolves a path", async () => {
  assert.equal(await isBashOutputPathReferencedBySession("/tmp/whatever.log", "not-a-session-id!", ALICE), false);
  assert.equal(await isBashOutputPathReferencedBySession("/tmp/whatever.log", null, ALICE), false);
  assert.equal(await isBashOutputPathReferencedBySession("/tmp/whatever.log", "../etc/passwd", ALICE), false);
  assert.equal(await isBashOutputPathReferencedBySession("/tmp/whatever.log", "0123456789abcdef", ALICE), false);
});
