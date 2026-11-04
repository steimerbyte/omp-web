import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { refreshDirsFromEnv, setAgentDir } from "@oh-my-pi/pi-utils";

/**
 * Die Skill-Liste des Panels, samt Installations-Info.
 *
 * `loadSkillsWithInstallInfo` ist die eine Ansicht, die Panel und Sitzung
 * teilen: dieselbe Discovery (`loadSkills`), derselbe Vertrauensfilter
 * (`trustedProjectSkills`), dieselbe Policy (`resolveSessionLoads`) — zwei
 * getrennte Ansichten waeren genau der Fehler, den die Leiste ueber dem Panel
 * dann anzeigt.
 *
 * Das Agent-Verzeichnis wird per `setAgentDir` umgehaengt (die SDK loest es
 * beim ersten Import einmal auf); ohne das laese dieser Test die Skills des
 * Entwicklers.
 */
function withTempEnv(run) {
  const root = mkdtempSync(join(tmpdir(), "omp-skills-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const previous = {
    HOME: process.env.HOME,
    OMP_WEB_HOME_ROOT: process.env.OMP_WEB_HOME_ROOT,
    PI_CONFIG_DIR: process.env.PI_CONFIG_DIR,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  };
  process.env.HOME = root;
  process.env.PI_CONFIG_DIR = ".omp";
  process.env.OMP_WEB_HOME_ROOT = join(root, "homes");
  setAgentDir(agentDir);

  const skill = (name, extraFrontmatter) => {
    const dir = join(agentDir, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: Ein Skill fuer den Test\n${extraFrontmatter}---\n\nAnweisung.\n`,
    );
  };

  return {
    agentDir,
    projectDir,
    skill,
    run: async () => {
      try {
        return await run({ agentDir, projectDir, skill });
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

test("lists the skills the agent directory holds, with their file paths", async () => {
  const env = withTempEnv(async ({ agentDir, projectDir, skill }) => {
    skill("mein-skill", "disable-model-invocation: true\n");
    skill("still", "");
    const { loadSkillsWithInstallInfo } = await import("./skills-service.ts");

    const result = await loadSkillsWithInstallInfo(projectDir, null);

    // Die Liste ist die Vereinigung aller Quellen (auch der Plugins des
    // Betreibers, deren Cache am Config-Root haengt); geprueft wird, dass die
    // Skills *dieser* Installation mit ihrem echten Pfad darinstehen.
    const byName = new Map(result.skills.map((entry) => [entry.name, entry]));
    assert.equal(byName.get("mein-skill")?.filePath, join(agentDir, "skills", "mein-skill", "SKILL.md"));
    assert.equal(byName.get("still")?.filePath, join(agentDir, "skills", "still", "SKILL.md"));

    // Ein Projekt ohne Ressourcen, die Vertrauen verlangen, ist auf omp's
    // normalem Pfad — die Liste ist geladen, nicht "nicht vertraut".
    assert.equal(result.projectResourcesLoaded, true);

    // Regression: `readDisableModelInvocation` las `frontmatter["disable-model-invocation"]`,
    // aber `parseFrontmatter` der SDK normalisiert Schluessel auf camelCase
    // (`disableModelInvocation`). Der Wert war deshalb immer `false`, auch fuer
    // eine Datei, die ihn setzt.
    assert.equal(byName.get("mein-skill").disableModelInvocation, true);
    assert.equal(byName.get("still").disableModelInvocation, false);
  });

  await env.run();
});
