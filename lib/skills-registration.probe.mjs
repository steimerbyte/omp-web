/**
 * What `ensureTenantSkillsRegistration` writes for one tenant, measured with
 * the process started *inside* a project that has its own
 * `skills.customDirectories`.
 *
 * That is the point: `getSettingsForIdentity(identity, undefined)` builds the
 * account instance with the process cwd, so its merged view contains the
 * operator project's layer. Reading that merged view and writing it back would
 * bake the operator's path into the tenant's `config.yml`. Only the global
 * layer may be copied. `getProjectDir()` caches on import, hence the separate
 * process.
 */
import { createJiti } from "jiti";

const repo = new URL("..", import.meta.url).pathname;
const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { "@": repo } });

const { ensureTenantSkillsRegistration } = await jiti.import("@/lib/skills-manager.ts");
const { getSettingsForIdentity } = await jiti.import("@/lib/omp-runtime.ts");
const { cfgSkillsCustomDirectories } = await jiti.import(
  "@oh-my-pi/pi-coding-agent/extensibility/settings",
);

const alice = { username: "alice", isAdmin: false };
const directory = await ensureTenantSkillsRegistration(alice);
const sessionSettings = await getSettingsForIdentity(alice, process.env.PROBE_PROJECT);
const globalSettings = sessionSettings.getGlobalSettings();
const globalSkills = globalSettings.skills;

console.log(
  JSON.stringify({
    directory,
    global: globalSkills?.customDirectories ?? null,
    session: cfgSkillsCustomDirectories.get(sessionSettings) ?? [],
  }),
);
