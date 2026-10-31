import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * A tenant's `Settings` instance must never reach the process singleton.
 *
 * The session resolves settings per identity (`getSettingsForIdentity`) while
 * the agent directory stays the process one. That is only safe if the instance
 * a tenant writes through (a) is not the singleton, (b) keeps the singleton's
 * cwd untouched when it is cloned for a project, and (c) flushes into the
 * tenant's `config.yml`, not the operator's. Each of the three has a plausible
 * failure mode (`cloneForCwd` sharing a layer, `flush()` targeting the source
 * path, the admin branch returning a cached tenant instance), so each is
 * measured in its own process: `getAgentDir()` and `Settings.init()` resolve
 * once per process.
 *
 * The probe runs the same order `startRpcSession` does: registration on the
 * cached base instance, then the cwd-scoped clone, then a write through the
 * clone.
 */
const SETTINGS = new URL("../node_modules/@oh-my-pi/pi-coding-agent/src/config/settings.ts", import.meta.url).href;
const EXT_SETTINGS = new URL("../node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/settings.ts", import.meta.url).href;
const OMP_RUNTIME = new URL("./omp-runtime.ts", import.meta.url).href;

const PROBE = `
import { existsSync, readFileSync } from "node:fs";
const { Settings } = await import(${JSON.stringify(SETTINGS)});
const { cfgSkillsCustomDirectories } = await import(${JSON.stringify(EXT_SETTINGS)});
const { getOmpRuntime, getSettingsForIdentity } = await import(${JSON.stringify(OMP_RUNTIME)});

const project = process.env.PROBE_PROJECT;
const tenantStore = process.env.PROBE_TENANT_STORE;
const alice = { username: "alice", isAdmin: false };
const admin = { username: "pi", isAdmin: true };

const { settings: processSettings, agentDir: processAgentDir } = await getOmpRuntime();
const processCwd = processSettings.getCwd();
// Baseline after the runtime's own init: from here on, a tenant write must not
// change this file.
const processConfig = readFileSync(processAgentDir + "/config.yml", "utf8");

const tenantBase = await getSettingsForIdentity(alice, undefined);
const baseCwd = tenantBase.getCwd();
// What ensureTenantSkillsRegistration does on the cached base instance.
cfgSkillsCustomDirectories.set(tenantBase, [tenantStore]);
await tenantBase.flush();

// What startRpcSession does next: the same identity, scoped to the cwd.
const sessionSettings = await getSettingsForIdentity(alice, project);
// What persistExplicitStartupPreferences writes through.
cfgSkillsCustomDirectories.set(sessionSettings, [tenantStore, tenantStore + "-next"]);
await sessionSettings.flush();

const adminSingleton = await getSettingsForIdentity(admin, undefined);
const adminSession = await getSettingsForIdentity(admin, project);
const tenantConfig = readFileSync(tenantBase.getAgentDir() + "/config.yml", "utf8");
const after = readFileSync(processAgentDir + "/config.yml", "utf8");

console.log(JSON.stringify({
  processAgentDir,
  tenantAgentDir: tenantBase.getAgentDir(),
  processIsSingleton: adminSingleton === processSettings,
  adminUsesProcessDir: adminSession.getAgentDir() === processAgentDir,
  adminClonedForProject: adminSession !== processSettings,
  tenantIsNotProcess: tenantBase !== processSettings,
  sessionIsClone: sessionSettings !== tenantBase,
  baseCwdUnchanged: tenantBase.getCwd() === baseCwd,
  processCwdUnchanged: processSettings.getCwd() === processCwd,
  sessionSeesRegistration: cfgSkillsCustomDirectories.get(sessionSettings) ?? [],
  processSeesTenantStore: (cfgSkillsCustomDirectories.get(processSettings) ?? []).includes(tenantStore),
  adminSeesTenantStore: (cfgSkillsCustomDirectories.get(adminSession) ?? []).includes(tenantStore),
  tenantConfigHasStore: tenantConfig.includes(tenantStore),
  processConfigUnchanged: processConfig === after,
  processConfigSeeded: processConfig.includes("test/process-owner"),
  processConfigHasStore: after.includes(tenantStore),
  projectConfigWritten: existsSync(project + "/.omp/config.yml"),
}));
`;

function measure() {
  const root = mkdtempSync(join(tmpdir(), "omp-web-tenant-settings-"));
  const processAgentDir = join(root, "process-agent");
  const homeRoot = join(root, "home");
  const project = join(root, "project");
  const tenantStore = join(root, "tenant-skills");
  for (const dir of [processAgentDir, homeRoot, join(project, ".omp"), tenantStore]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(processAgentDir, "config.yml"), "modelRoles:\n  default: test/process-owner\n");
  const probePath = join(root, "probe.mjs");
  writeFileSync(probePath, PROBE);

  try {
    const out = execFileSync(process.execPath, [probePath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: processAgentDir,
        OMP_WEB_HOME_ROOT: homeRoot,
        PROBE_PROJECT: project,
        PROBE_TENANT_STORE: tenantStore,
        // The probe builds the process runtime; keep its model registry offline
        // exactly as `bun test` does.
        PI_TEST_RUNTIME: "1",
        NODE_ENV: "test",
      },
      cwd: new URL("..", import.meta.url).pathname,
    });
    const result = JSON.parse(out.trim().split("\n").at(-1));
    return { ...result, processAgentDir, project, tenantStore };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const measured = measure();

test("a tenant's Settings is a separate instance with its own agent directory", () => {
  assert.equal(measured.tenantIsNotProcess, true);
  assert.equal(measured.sessionIsClone, true);
  assert.notEqual(measured.tenantAgentDir, measured.processAgentDir);
  assert.equal(measured.tenantAgentDir.endsWith(join("home", "alice", ".omp", "agent")), true);
});

test("the admin branch returns the process singleton, never the tenant instance", () => {
  assert.equal(measured.processIsSingleton, true);
  assert.equal(measured.adminUsesProcessDir, true);
  assert.equal(measured.adminClonedForProject, true);
  assert.equal(measured.adminSeesTenantStore, false);
});

test("cloning for a cwd does not mutate the instance it came from", () => {
  assert.equal(measured.baseCwdUnchanged, true);
  assert.equal(measured.processCwdUnchanged, true);
});

test("a registration on the base instance reaches the session clone", () => {
  // The order in `startRpcSession`: registration, then settings resolution.
  // If `cloneForCwd` copied the layers before the write, a tenant's folder
  // would be missing from the very session that just registered it.
  assert.ok(
    measured.sessionSeesRegistration.includes(measured.tenantStore),
    `session saw: ${measured.sessionSeesRegistration.join(", ")}`,
  );
});

test("tenant writes land in the tenant's config.yml and never in the process one", () => {
  assert.equal(measured.tenantConfigHasStore, true);
  assert.equal(measured.processConfigHasStore, false);
  assert.equal(measured.processConfigUnchanged, true);
  assert.equal(measured.processSeesTenantStore, false);
  // A global-layer write must not create or touch a project config.
  assert.equal(measured.projectConfigWritten, false);
});

test("the process config really was read (the leak assertions are not vacuous)", () => {
  assert.equal(measured.processConfigSeeded, true);
});
