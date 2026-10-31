import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * What one identity may load, measured on the lists a session start hands to
 * `createAgentSession`.
 *
 * Every load in `LOAD-LEVEL-SCAN.md` §2 reads `getAgentDir()` and
 * `os.homedir()` from process state, so the operator's `RULES.md`, `AGENTS.md`,
 * `SYSTEM.md`, `APPEND_SYSTEM.md`, prompt templates and slash commands reached a
 * tenant session (§3). `resolveSessionLoads` is the one place that decides
 * otherwise, and each rule is measured here against marker files in a controlled
 * home, agent directory and project: `getAgentDir()` resolves once per process,
 * which is why the probe runs in its own process (same harness as
 * `lib/tenant-settings-isolation.test.mjs`).
 *
 * The two rules under test, and nothing else:
 *
 * 1. a tenant does not inherit the operator's authoring store;
 * 2. project-supplied content follows project trust, with a positive allowlist
 *    for code — a project's `.omp/config.yml` may name a path outside the
 *    project, which an exclusion filter cannot see.
 */

const SDK_INDEX = new URL("../node_modules/@oh-my-pi/pi-coding-agent/src/index.ts", import.meta.url).href;
const DISCOVERY = new URL("../node_modules/@oh-my-pi/pi-coding-agent/src/discovery/index.ts", import.meta.url).href;
const RULE_CAPABILITY = new URL("../node_modules/@oh-my-pi/pi-coding-agent/src/capability/rule.ts", import.meta.url).href;
const LOAD_POLICY = new URL("./load-policy.ts", import.meta.url).href;
const PROJECT_TRUST = new URL("./project-trust.ts", import.meta.url).href;
const OMP_RUNTIME = new URL("./omp-runtime.ts", import.meta.url).href;
const AUTOLEARN_SETTINGS = new URL(
  "../node_modules/@oh-my-pi/pi-coding-agent/src/autolearn/settings.ts",
  import.meta.url,
).href;
const MANAGE_SKILL_TOOL = new URL(
  "../node_modules/@oh-my-pi/pi-coding-agent/src/tools/manage-skill.ts",
  import.meta.url,
).href;
const MEMORY_SETTINGS = new URL(
  "../node_modules/@oh-my-pi/pi-coding-agent/src/memory-backend/settings.ts",
  import.meta.url,
).href;

const PROBE = `
const {
  discoverContextFiles,
  discoverPromptTemplates,
  discoverSessionExtensionPaths,
  discoverSlashCommands,
} = await import(${JSON.stringify(SDK_INDEX)});
const { loadCapability } = await import(${JSON.stringify(DISCOVERY)});
const { ruleCapability } = await import(${JSON.stringify(RULE_CAPABILITY)});
const { resolveSessionLoads, sessionSettings } = await import(${JSON.stringify(LOAD_POLICY)});
const { hasTrustRequiringProjectResources, trustProject } = await import(${JSON.stringify(PROJECT_TRUST)});
const { getSettingsForIdentity } = await import(${JSON.stringify(OMP_RUNTIME)});
const { cfgAutolearnEnabled } = await import(${JSON.stringify(AUTOLEARN_SETTINGS)});
const { cfgMemoryBackend } = await import(${JSON.stringify(MEMORY_SETTINGS)});
const { ManageSkillTool } = await import(${JSON.stringify(MANAGE_SKILL_TOOL)});

const alice = { username: "alice", isAdmin: false };
const admin = { username: "pi", isAdmin: true };
const trusted = process.env.PROBE_TRUSTED;
const narrowed = process.env.PROBE_NARROWED;
const injected = process.env.PROBE_INJECTED;

const summarize = (loads) => ({
  // Which options the policy had to supply. An empty list means "no rule
  // applied", i.e. omp's own discovery decides — the normal path.
  filtered: Object.keys(loads.options).sort(),
  rules: (loads.options.rules ?? []).map((rule) => rule.content.trim()),
  contextFiles: (loads.options.contextFiles ?? []).map((file) => file.content.trim()),
  promptTemplates: (loads.options.promptTemplates ?? []).map((template) => template.name),
  slashCommands: (loads.options.slashCommands ?? []).map((command) => command.name),
  extensionPaths: (loads.options.preloadedExtensionPaths ?? []).map((path) => path.split("/").slice(-1)[0]),
  customToolPaths: (loads.options.preloadedCustomToolPaths ?? []).map((tool) => tool.path.split("/").slice(-1)[0]),
  enableMCP: loads.options.enableMCP,
  appendPrompt: loads.systemPrompts.appendPrompt,
  narrowed: loads.narrowed,
  diagnostics: loads.diagnostics.map((diagnostic) => diagnostic.message),
});

const measure = async (identity, cwd) => summarize(await resolveSessionLoads(identity, cwd, await getSettingsForIdentity(identity, cwd)));

const processAgentDir = process.env.PI_CODING_AGENT_DIR;
// What omp itself discovers for the operator's session, before any policy: the
// baseline each filtered list is compared against.
const discovered = {
  rules: (await loadCapability(ruleCapability.id, { cwd: trusted, agentDir: processAgentDir })).items.map((rule) => rule.content.trim()),
  contextFiles: (await discoverContextFiles(trusted, processAgentDir)).map((file) => file.content.trim()),
  promptTemplates: (await discoverPromptTemplates(trusted, processAgentDir)).map((template) => template.name),
  slashCommands: (await discoverSlashCommands({ cwd: trusted })).map((command) => command.name),
};

const configOnly = process.env.PROBE_CONFIG_ONLY;
const configOnlyTrust = hasTrustRequiringProjectResources(configOnly);
const configOnlySession = await measure(alice, configOnly);

const tenantTrusted = await measure(alice, trusted);
const adminTrusted = await measure(admin, trusted);
const tenantNarrowed = await measure(alice, narrowed);
const adminNarrowed = await measure(admin, narrowed);

// Was the injected path even discovered? That is the escape as measured: the
// project's config.yml is merged into the session's settings for its cwd.
const discoveredNarrowedRules = (
  await loadCapability(ruleCapability.id, { cwd: narrowed, agentDir: processAgentDir })
).items.map((rule) => rule.content.trim());
const injectedDiscovered = (
  await discoverSessionExtensionPaths({}, narrowed, await getSettingsForIdentity(alice, narrowed))
).includes(injected);
const beforeTrust = hasTrustRequiringProjectResources(narrowed);

trustProject(narrowed, (await getSettingsForIdentity(admin, undefined)).getAgentDir());
const adminTrustedAfter = await measure(admin, narrowed);

// The overlay a tenant session runs with.
const tenantBase = await getSettingsForIdentity(alice, undefined);
const tenantSession = sessionSettings(alice, tenantBase);
const adminSession = sessionSettings(admin, tenantBase);

console.log(JSON.stringify({
  discovered,
  discoveredNarrowedRules,
  configOnlyTrust,
  configOnlySession,
  tenantTrusted,
  adminTrusted,
  tenantNarrowed,
  adminNarrowed,
  injectedDiscovered,
  beforeTrust,
  adminTrustedAfter,
  overlay: {
    // ManageSkillTool is gated on exactly this setting and writes through
    // getManagedSkillsDir(), which takes no argument — the process store.
    tenantManageSkillTool: ManageSkillTool.createIf({ settings: tenantSession }) !== null,
    storedManageSkillTool: ManageSkillTool.createIf({ settings: tenantBase }) !== null,
    tenantAutolearn: cfgAutolearnEnabled.get(tenantSession),
    tenantMemory: cfgMemoryBackend.get(tenantSession),
    // The account's own file still says enabled/local: the overlay is a view,
    // not a write.
    storedAutolearn: cfgAutolearnEnabled.get(tenantBase),
    storedMemory: cfgMemoryBackend.get(tenantBase),
    adminIsSameInstance: adminSession === tenantBase,
  },
  // Report whether a session ever sees a path that is neither in the operator's
  // roots nor inside the project — the case the allowlist exists for.
}));
`;

function measureAll() {
  const root = mkdtempSync(join(tmpdir(), "omp-web-load-policy-"));
  const operatorHome = join(root, "home-operator");
  const agentDir = join(root, "process-agent");
  const homeRoot = join(root, "homes");
  const tenantAgentDir = join(homeRoot, "alice", ".omp", "agent");
  const trusted = join(root, "projects", "trusted");
  const narrowed = join(root, "projects", "narrowed");
  const outside = join(root, "outside", "evil.ts");

  const write = (path, content) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  };

  // The operator's authoring store: one marker per load the scan measured.
  write(join(agentDir, "RULES.md"), "oprule-marker\n");
  write(join(agentDir, "AGENTS.md"), "opctx-marker\n");
  write(join(agentDir, "SYSTEM.md"), "opsystem-marker\n");
  write(join(agentDir, "APPEND_SYSTEM.md"), "opappend-marker\n");
  write(join(agentDir, "prompts", "op-prompt.md"), "---\ndescription: op prompt\n---\nop-prompt-body\n");
  write(join(agentDir, "commands", "op-cmd.md"), "op-cmd-body\n");
  write(join(agentDir, "extensions", "op-ext.ts"), "export default {};\n");
  write(join(agentDir, "tools", "op-tool.ts"), "export default {};\n");
  // A user-level prompt file under the *home*: `findConfigFile({ user: true })`
  // walks os.homedir(), not PI_CODING_AGENT_DIR.
  write(join(operatorHome, ".omp", "agent", "APPEND_SYSTEM.md"), "opappend-marker\n");
  // ... and a session's memory and autolearn default live in that store too.
  write(join(operatorHome, ".omp", "agent", "config.yml"), "autolearn:\n  enabled: true\nmemory:\n  backend: local\n");

  // The tenant's own store: own rule, own prompt, own command.
  write(join(tenantAgentDir, "RULES.md"), "tenantrule-marker\n");
  write(join(tenantAgentDir, "prompts", "tenant-prompt.md"), "---\ndescription: tenant prompt\n---\ntenant-prompt-body\n");
  write(join(tenantAgentDir, "commands", "tenant-cmd.md"), "tenant-cmd-body\n");
  write(join(tenantAgentDir, "config.yml"), "autolearn:\n  enabled: true\nmemory:\n  backend: local\n");

  // A project that requires no trust: its own rules, prompts and commands load.
  write(join(trusted, ".omp", "rules", "proj-rule.md"), "projrule-marker\n");
  write(join(trusted, ".omp", "prompts", "proj-prompt.md"), "---\ndescription: proj prompt\n---\nproj-prompt-body\n");
  write(join(trusted, ".omp", "commands", "proj-cmd.md"), "proj-cmd-body\n");
  write(join(trusted, ".omp", "AGENTS.md"), "projctx-marker\n");

  // A project that requires trust, with the measured escape: a `.omp/config.yml`
  // that names an extension *outside* the project.
  write(join(narrowed, ".omp", "extensions", "proj-ext.ts"), "export default {};\n");
  write(join(narrowed, ".omp", "config.yml"), `extensions:\n  - ${outside}\n`);
  write(join(narrowed, ".omp", "rules", "proj-rule.md"), "projrule-marker\n");
  write(join(narrowed, ".omp", "commands", "proj-cmd.md"), "proj-cmd-body\n");
  write(join(narrowed, ".omp", "AGENTS.md"), "projctx-marker\n");
  write(join(narrowed, ".omp", "APPEND_SYSTEM.md"), "projappend-marker\n");
  // The measured escape in its purest form: no `.omp/extensions` at all, only a
  // config file that names a module outside the project.
  const configOnly = join(root, "projects", "config-only");
  write(join(configOnly, ".omp", "config.yml"), `extensions:\n  - ${outside}\n`);
  write(outside, "export default {};\n");

  const probePath = join(root, "probe.mjs");
  write(probePath, PROBE);

  try {
    const out = execFileSync(process.execPath, [probePath], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: operatorHome,
        PI_CODING_AGENT_DIR: agentDir,
        // Keep `findConfigFile`'s .omp user base out of the real home.
        PI_CONFIG_DIR: ".omp",
        OMP_WEB_HOME_ROOT: homeRoot,
        PROBE_TRUSTED: trusted,
        PROBE_NARROWED: narrowed,
        PROBE_CONFIG_ONLY: configOnly,
        PROBE_INJECTED: outside,
        PI_TEST_RUNTIME: "1",
        NODE_ENV: "test",
      },
      cwd: new URL("..", import.meta.url).pathname,
    });
    return {
      ...JSON.parse(out.trim().split("\n").at(-1)),
      agentDir,
      trusted,
      narrowed,
      configOnly,
      outside,
      tenantAgentDir,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const measured = measureAll();
const { discovered, tenantTrusted, adminTrusted, tenantNarrowed, adminNarrowed } = measured;

const includes = (list, marker) => list.some((entry) => entry.includes(marker));
/** Entries of `discovered` that the filtered list dropped. */
const removed = (discoveredList, keptList) =>
  discoveredList.filter((entry) => !keptList.some((kept) => kept.includes(entry) || entry.includes(kept)));

test("the operator's session gets no filtered list at all — omp's own discovery decides", () => {
  // This is the control for every other test: with nothing to gate, the policy
  // returns no pre-built list, so `createAgentSession` discovers exactly what
  // the CLI discovers.
  assert.deepEqual(adminTrusted.filtered, []);
  assert.equal(adminTrusted.appendPrompt, "opappend-marker\n");
  // ... and the markers are there to be discovered.
  assert.ok(includes(discovered.rules, "oprule-marker"), "fixture did not plant the operator rule");
  assert.ok(includes(discovered.contextFiles, "opctx-marker"));
  assert.ok(includes(discovered.promptTemplates, "op-prompt"));
  assert.ok(includes(discovered.slashCommands, "op-cmd"));
});

test("a tenant session carries none of the operator's rules, context files, prompts or commands", () => {
  // Each list is the discovered list minus exactly the operator's files: no
  // blanket ban, no second convention.
  assert.deepEqual(removed(discovered.rules, tenantTrusted.rules), ["oprule-marker"]);
  assert.deepEqual(removed(discovered.contextFiles, tenantTrusted.contextFiles), ["opctx-marker"]);
  assert.deepEqual(removed(discovered.promptTemplates, tenantTrusted.promptTemplates), ["op-prompt"]);
  assert.deepEqual(removed(discovered.slashCommands, tenantTrusted.slashCommands), ["op-cmd"]);
  assert.equal(tenantTrusted.appendPrompt, undefined);
});

test("a tenant keeps its own rules and prompts and the project's content", () => {
  assert.ok(includes(tenantTrusted.rules, "tenantrule-marker"));
  assert.ok(includes(tenantTrusted.promptTemplates, "tenant-prompt"));
  // Not narrowed: the project requires no trust, so its own rules, prompts,
  // commands and context files load exactly as for the operator.
  for (const list of ["rules", "contextFiles", "promptTemplates", "slashCommands"]) {
    assert.ok(includes(tenantTrusted[list], "proj"), `${list}: ${JSON.stringify(tenantTrusted[list])}`);
  }
  // Gap, documented rather than papered over: omp's slash-command loader takes
  // no agent directory, so a tenant has no commands of their own — the bundled
  // ones and the project's remain.
  assert.ok(!includes(tenantTrusted.slashCommands, "tenant-cmd"));
  assert.ok(includes(tenantTrusted.slashCommands, "init"));
});

test("withheld loads surface as one diagnostic with a count, never as a silent drop", () => {
  // Rules and prompt templates are discovered against the tenant's own agent
  // directory, so nothing of the operator's is ever in the list: no drop, no
  // diagnostic. The two loads the SDK gives no per-identity root — context files
  // and slash commands — report what they withheld, with the count.
  assert.deepEqual(tenantTrusted.diagnostics, [
    "1 context file not loaded: this account does not inherit the operator's agent directory.",
    "1 slash command not loaded: this account does not inherit the operator's agent directory.",
  ]);
  // And the operator's rule really was in the baseline the tenant never saw.
  assert.ok(includes(discovered.rules, "oprule-marker"));
  assert.ok(!includes(tenantTrusted.rules, "oprule-marker"));
});

test("MCP is off for a tenant and for a narrowed project", () => {
  assert.equal(tenantTrusted.enableMCP, false);
  assert.equal(tenantNarrowed.enableMCP, false);
  assert.equal(adminTrusted.enableMCP, undefined);
});

test("a project's .omp/config.yml alone is a trust-requiring resource", () => {
  // No `.omp/extensions`, no `.mcp.json` — the settings file is the whole
  // resource. Measured before this rule: the injected module ran while
  // `requiresTrust` was false, so no decision was ever asked for.
  assert.equal(measured.configOnlyTrust, true);
  assert.equal(measured.configOnlySession.narrowed, true);
  assert.deepEqual(measured.configOnlySession.extensionPaths, ["op-ext.ts"]);
});

test("an untrusted project cannot inject an extension through .omp/config.yml", () => {
  // `.omp/config.yml` is merged into the session's settings for that cwd, so the
  // injected path *is* discovered — that is the escape the scan measured.
  assert.equal(measured.beforeTrust, true);
  assert.equal(measured.injectedDiscovered, true);
  // ... and the session never sees it, because the policy hands omp a pre-built
  // list built from the operator's roots.
  assert.deepEqual(adminNarrowed.extensionPaths, ["op-ext.ts"]);
  assert.deepEqual(tenantNarrowed.extensionPaths, ["op-ext.ts"]);
  assert.deepEqual(adminNarrowed.customToolPaths, ["op-tool.ts"]);
  assert.ok(!adminNarrowed.extensionPaths.includes("evil.ts"));
});

test("an untrusted project loads nothing from inside itself", () => {
  assert.ok(!includes(adminNarrowed.rules, "projrule-marker"));
  assert.ok(!includes(adminNarrowed.slashCommands, "proj-cmd"));
  assert.ok(!includes(adminNarrowed.contextFiles, "projctx-marker"));
  // The project's own APPEND_SYSTEM.md is gone; the operator's is not.
  assert.equal(adminNarrowed.appendPrompt, "opappend-marker\n");
  assert.equal(tenantNarrowed.appendPrompt, undefined);
  assert.equal(adminNarrowed.narrowed, true);
  assert.ok(adminNarrowed.diagnostics.some((entry) => entry.includes("this project is not trusted")));
  // The operator's own store is unaffected by the project gate.
  assert.ok(includes(adminNarrowed.rules, "oprule-marker"));
  assert.ok(includes(adminNarrowed.slashCommands, "op-cmd"));
  // A tenant is narrower still: both rules apply at once.
  assert.ok(includes(tenantNarrowed.rules, "tenantrule-marker"));
  assert.ok(!includes(tenantNarrowed.slashCommands, "op-cmd"));
  assert.ok(tenantNarrowed.diagnostics.every((entry) => entry.endsWith(".")));
});

test("a trusted project loads its own rules and extensions again", () => {
  assert.equal(measured.adminTrustedAfter.narrowed, false);
  // The normal path: no pre-built list, so omp's own discovery decides — and
  // that discovery does contain the project's rule and command.
  assert.deepEqual(measured.adminTrustedAfter.filtered, []);
  assert.ok(includes(measured.discoveredNarrowedRules, "projrule-marker"));
  assert.ok(includes(tenantNarrowed.slashCommands, "proj-cmd") === false);
});

test("a tenant session pins autolearn and memory away from the operator's store", () => {
  assert.equal(measured.overlay.tenantAutolearn, false);
  assert.equal(measured.overlay.tenantMemory, "off");
  // The account's own config still says otherwise — the pin is a session view,
  // not a write into the tenant's file.
  assert.equal(measured.overlay.storedAutolearn, true);
  assert.equal(measured.overlay.storedMemory, "local");
  // ... and the mint fails instead of landing in the operator's store: the tool
  // is created from `session.settings`, and that instance says autolearn is off.
  assert.equal(measured.overlay.tenantManageSkillTool, false);
  // Proof the gate is the overlay and not something else: the same account's
  // stored config would hand the tool out.
  assert.equal(measured.overlay.storedManageSkillTool, true);
  // An admin runs on the instance itself; nothing is masked.
  assert.equal(measured.overlay.adminIsSameInstance, true);
});
