import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Welche Skills sieht eine Sitzung?
 *
 * Das ist die Lücke, die den Bestand so lange unbemerkt gelassen hat: kein
 * Test prüfte, ob eine Sitzung überhaupt den Bestand *des Kontos* liest. Der
 * Aufbau ist der gemessene aus `AGENTDIR-SCAN.md` §9:
 *
 * - Prozess-Agent-Verzeichnis bleibt das des Betreibers;
 * - die Sitzung bekommt die **Settings** des Mandanten;
 * - darin steht `skills.customDirectories: [<absolut>/skills]`.
 *
 * Erwartung: die Mandanten-Skill steht in `session.skills`, die des zweiten
 * Mandanten nicht, und ein Aufruf ohne Settings (die Prozess-Sicht) kennt sie
 * nicht. Scheitert der Test, ist die Identitätsauflösung in
 * `lib/rpc-manager.ts` oder im Settings-Cache kaputt.
 *
 * Die Sitzung selbst braucht ein Modell; ohne konfigurierte Modelle (CI) wird
 * dieser eine Test übersprungen, die Settings-/Discovery-Teile laufen immer.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-skills-session-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;
// Ein eigenes Prozess-Agent-Verzeichnis: `getAgentDir()` löst beim Import auf,
// und ein geteilter `bun test`-Prozess würde sonst die Models des Entwicklers
// (oder das Verzeichnis einer anderen Testdatei) erben.
process.env.PI_CODING_AGENT_DIR = join(HOME_ROOT, "process-agent");
mkdirSync(join(HOME_ROOT, "process-agent"), { recursive: true });
process.env.PI_TEST_RUNTIME = "1";
// `bun test` shares `globalThis` across files; several test files install a
// fake runtime there. A leaked fake would hand this file a model registry
// without the real catalogue (`getAll`), so start from a clean slot.
delete globalThis.__ompRuntimePromise;
mkdirSync(join(HOME_ROOT, "alice"), { recursive: true });
mkdirSync(join(HOME_ROOT, "bob"), { recursive: true });
const project = join(HOME_ROOT, "alice", "projects", "demo");
mkdirSync(project, { recursive: true });

const { ensureTenantSkillsRegistration } = await jiti.import("@/lib/skills-manager.ts");
const { getSettingsForIdentity, getOmpRuntime } = await jiti.import("@/lib/omp-runtime.ts");
const { loadSessionSkills } = await jiti.import("@/lib/skills-service.ts");
const { getProjectTrustStatus } = await jiti.import("@/lib/project-trust.ts");
const { cfgSkills } = await jiti.import("@oh-my-pi/pi-coding-agent/extensibility/settings");
const { createAgentSession, getAgentDir, loadSkills, SessionManager } =
  await jiti.import("@oh-my-pi/pi-coding-agent");

const alice = { username: "alice", isAdmin: false };
const bob = { username: "bob", isAdmin: false };

function seedSkill(directory, name, description) {
  mkdirSync(join(directory, name), { recursive: true });
  writeFileSync(
    join(directory, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

test.after(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

test("die Settings des Mandanten machen seine customDirectories sichtbar, die Prozess-Sicht nicht", async () => {
  const aliceStore = await ensureTenantSkillsRegistration(alice);
  const bobStore = await ensureTenantSkillsRegistration(bob);
  seedSkill(aliceStore, "alice-only", "Alice only.");
  seedSkill(bobStore, "bob-only", "Bob only.");

  const aliceSettings = await getSettingsForIdentity(alice, project);
  const aliceSkills = await loadSkills({ cwd: project, ...cfgSkills.get(aliceSettings) });
  assert.ok(aliceSkills.skills.some((skill) => skill.name === "alice-only"), "Alice sieht ihren Skill");
  assert.ok(!aliceSkills.skills.some((skill) => skill.name === "bob-only"), "Alice sieht Bobs Skill nicht");

  // Die Prozess-Settings kennen nur den Betreiber-Bestand; genau deshalb ist
  // die Zeile in `startRpcSession` die Änderung, die "per user" wahr macht.
  const plain = await loadSkills({ cwd: project });
  assert.ok(!plain.skills.some((skill) => skill.name === "alice-only"));
  assert.ok(!plain.skills.some((skill) => skill.name === "bob-only"));
});

const runtime = await getOmpRuntime();
// Die Sitzung braucht ein Modell; der statische Katalog reicht, denn der Test
// schickt keinen Prompt. `getAvailable()` wäre auth- und netzabhängig.
const sessionModel = runtime.modelRegistry.getAll()[0];

test(
  "eine Sitzung mit Mandanten-Settings trägt den Skill im session.skills",
  { skip: sessionModel ? false : "no model catalogue" },
  async () => {
    const aliceStore = await ensureTenantSkillsRegistration(alice);
    const bobStore = await ensureTenantSkillsRegistration(bob);
    seedSkill(aliceStore, "session-alice", "Visible inside Alice's session.");
    seedSkill(bobStore, "session-bob", "Must not leak into Alice's session.");

    const aliceSettings = await getSettingsForIdentity(alice, project);
    const sessionsDir = mkdtempSync(join(tmpdir(), "omp-web-skills-sessions-"));
    const sessionManager = SessionManager.create(project, sessionsDir);
    const created = await createAgentSession({
      cwd: project,
      // Bewusst das Prozess-Verzeichnis, nicht alices: der Loader ignoriert
      // `agentDir` für Skills, und Credentials/History bleiben hier.
      agentDir: getAgentDir(),
      settings: aliceSettings,
      sessionManager,
      authStorage: runtime.authStorage,
      modelRegistry: runtime.modelRegistry,
      model: sessionModel,
      hasUI: true,
    });

    const names = created.session.skills.map((skill) => skill.name);
    assert.ok(names.includes("session-alice"), `session.skills: ${names.join(", ")}`);
    assert.ok(!names.includes("session-bob"), "Bobs Skill darf nicht in Alices Sitzung stehen");
    await created.session.dispose?.();
    rmSync(sessionsDir, { recursive: true, force: true });
  },
);

test(
  "eine nicht vertraute Sitzung trägt den eigenen Skill, nicht den des Projekts",
  { skip: sessionModel ? false : "no model catalogue" },
  async () => {
    // Die Kombination, an der beide Änderungen zusammenwirken: Sitzung mit den
    // Settings des Mandanten (eigener Bestand) in einem Projekt, dem der Nutzer
    // nicht vertraut hat (Projekt-Skills aus). Der gemeinsame Loader liefert die
    // Liste, `createAgentSession` bekommt sie als `skills` — genau wie in
    // `startRpcSession`.
    const aliceStore = await ensureTenantSkillsRegistration(alice);
    seedSkill(aliceStore, "trust-alice", "Own store, outside the untrusted project.");
    const untrustedProject = join(HOME_ROOT, "alice", "untrusted-project");
    mkdirSync(join(untrustedProject, ".omp", "extensions"), { recursive: true });
    seedSkill(join(untrustedProject, ".agents", "skills"), "trust-evil", "Must never load.");

    assert.equal(getProjectTrustStatus(untrustedProject, getAgentDir()).trusted, false);

    const settings = await getSettingsForIdentity(alice, untrustedProject);
    const loaded = await loadSessionSkills(untrustedProject, settings);
    assert.equal(loaded.trusted, false);
    assert.equal(loaded.withheld, 1);
    assert.ok(loaded.skills.some((skill) => skill.name === "trust-alice"), "eigener Skill fehlt");
    assert.ok(!loaded.skills.some((skill) => skill.name === "trust-evil"), "Projekt-Skill geladen");

    const sessionsDir = mkdtempSync(join(tmpdir(), "omp-web-skills-untrusted-"));
    const sessionManager = SessionManager.create(untrustedProject, sessionsDir);
    const created = await createAgentSession({
      cwd: untrustedProject,
      agentDir: getAgentDir(),
      settings,
      sessionManager,
      authStorage: runtime.authStorage,
      modelRegistry: runtime.modelRegistry,
      model: sessionModel,
      hasUI: true,
      skills: loaded.skills,
    });

    const names = created.session.skills.map((skill) => skill.name);
    assert.ok(names.includes("trust-alice"), `session.skills: ${names.join(", ")}`);
    assert.ok(!names.includes("trust-evil"), `Projekt-Skill in session.skills: ${names.join(", ")}`);
    await created.session.dispose?.();
    rmSync(sessionsDir, { recursive: true, force: true });
  },
);
