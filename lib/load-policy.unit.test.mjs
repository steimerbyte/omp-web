import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { refreshDirsFromEnv, setAgentDir } from "@oh-my-pi/pi-utils";

/**
 * `filterCommands` — der Filter, der nach einer erneuten Discovery laeuft.
 *
 * `AgentSession.refreshSkillsAndCommands()` laedt Slash-Commands immer wieder
 * aus den Prozess-Wurzeln und weiss nichts von einer vorbereiteten Liste; ohne
 * diesen Griff kaemen die Commands des Betreibers bei einem Mandanten zurueck,
 * sobald der irgendeine Discovery-Einstellung aendert. Der Test haelt beide
 * Haelften fest: der Filter existiert fuer einen Mandanten, und er wirft genau
 * die Commands weg, die aus dem Betreiber-Store kommen.
 *
 * `setAgentDir`/`refreshDirsFromEnv` haengen das Agent-Verzeichnis der SDK um
 * (sie wird beim ersten Import einmal aufgeloest); ohne das laese dieser Test
 * die Wurzeln des Entwicklers. Dieselbe Technik wie in
 * `lib/scheduler.unit.test.mjs`.
 */
function withTempEnv(run) {
  const root = mkdtempSync(join(tmpdir(), "omp-loads-"));
  const projectDir = join(root, "project");
  mkdirSync(join(projectDir, ".omp", "commands"), { recursive: true });
  writeFileSync(join(projectDir, ".omp", "commands", "proj.md"), "projekt-command\n");
  const previous = {
    HOME: process.env.HOME,
    OMP_WEB_HOME_ROOT: process.env.OMP_WEB_HOME_ROOT,
    PI_CONFIG_DIR: process.env.PI_CONFIG_DIR,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  };
  process.env.HOME = root;
  process.env.PI_CONFIG_DIR = ".omp";
  process.env.OMP_WEB_HOME_ROOT = join(root, "homes");
  setAgentDir(join(root, "agent"));

  return {
    projectDir,
    run: async () => {
      try {
        return await run({ root, projectDir });
      } finally {
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        refreshDirsFromEnv();
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

test("a tenant session gets a command filter that drops the operator's commands", async () => {
  const env = withTempEnv(async ({ projectDir }) => {
    const { resolveSessionLoads } = await import("./load-policy.ts");
    const { getSettingsForIdentity } = await import("./omp-runtime.ts");
    const alice = { username: "alice", isAdmin: false };

    const loads = await resolveSessionLoads(alice, projectDir, await getSettingsForIdentity(alice, projectDir));

    assert.equal(typeof loads.filterCommands, "function");

    // `discoverSlashCommands` nimmt kein Agent-Verzeichnis; fuer Commands ist das
    // Level damit die einzige Herkunft, die es gibt. Level "user" heisst: aus den
    // Prozess-Wurzeln, also aus dem Store des Betreibers — weg. Level "project"
    // bleibt.
    const commands = [
      { name: "operator", template: "aus dem Betreiber-Store", _source: { level: "user" } },
      { name: "projekt", template: "aus dem Projekt", path: join(projectDir, ".omp", "commands", "proj.md"), _source: { level: "project" } },
    ];
    const before = JSON.stringify(commands);

    assert.deepEqual(loads.filterCommands(commands).map((command) => command.name), ["projekt"]);
    assert.equal(JSON.stringify(commands), before, "der Filter veraendert die uebergebene Liste nicht");
  });

  await env.run();
});
