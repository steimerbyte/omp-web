// Der Thunderbird-Probe ist ein Einmal-Diagnose-Skript. `invoke` laeuft auch
// ohne eingerichtetes Thunderbird: der erste Aufruf findet kein Tool und wirft
// "tool not registered". Ein leeres Agent-Verzeichnis haelt den Lauf hermetisch.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = new URL("./check-thunderbird-mcp.ts", import.meta.url).pathname;

test("invoke meldet ein fehlendes Tool, statt still nichts zu tun", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-thunderbird-agent-"));
  const original = { dir: process.env.PI_CODING_AGENT_DIR, log: console.log, cwd: process.cwd() };
  const lines = [];
  console.log = (...parts) => lines.push(parts.map(String).join(" "));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // Leeres Arbeitsverzeichnis: kein Projekt-.mcp.json aus dem Repo.
  process.chdir(agentDir);
  let error = null;
  try {
    await import(`${SCRIPT}?case=${Math.random()}`);
  } catch (thrown) {
    error = thrown;
  } finally {
    console.log = original.log;
    process.chdir(original.cwd);
    if (original.dir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original.dir;
    rmSync(agentDir, { recursive: true, force: true });
  }
  assert.ok(error, "ohne Thunderbird-Tool muss der Aufruf scheitern");
  assert.match(error.message, /tool not registered: listAccounts/);
  assert.ok(lines.some((line) => line.includes("connected servers:")));
  assert.ok(lines.some((line) => line.includes("tools: 0 total")));
});
