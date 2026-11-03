import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  getProjectTrustStatus,
  hasTrustRequiringProjectResources,
  isInsideProject,
  trustProject,
  trustedProjectSkills,
  untrustedProjectSessionOptions,
} = await createJiti(import.meta.url).import("./project-trust.ts");

async function createProjectFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "omp-web-project-trust-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, cwd, agentDir };
}

test("clean projects stay on the normal trusted load path", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);

  assert.equal(hasTrustRequiringProjectResources(cwd), false);
  assert.deepEqual(getProjectTrustStatus(cwd, agentDir), {
    requiresTrust: false,
    trusted: true,
  });
  assert.equal(
    untrustedProjectSessionOptions(cwd, agentDir, { extensionPaths: [], customToolPaths: [] }),
    undefined,
  );
});

test("code-bearing project directories require an explicit trust decision", async (t) => {
  for (const dir of [".omp/extensions", ".omp/hooks", ".omp/tools", ".claude/tools", ".agents/hooks"]) {
    const { cwd, agentDir } = await createProjectFixture(t);
    await mkdir(join(cwd, dir), { recursive: true });

    assert.equal(hasTrustRequiringProjectResources(cwd), true, dir);
    assert.deepEqual(getProjectTrustStatus(cwd, agentDir), { requiresTrust: true, trusted: false }, dir);
  }
});

test("an MCP manifest requires trust because omp would spawn its servers", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  await writeFile(join(cwd, ".mcp.json"), "{}");

  assert.deepEqual(getProjectTrustStatus(cwd, agentDir), { requiresTrust: true, trusted: false });
});

test("a project skill raises the trust dialog, so it cannot load without one", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  await mkdir(join(cwd, ".omp", "skills", "demo"), { recursive: true });
  await writeFile(join(cwd, ".omp", "skills", "demo", "SKILL.md"), "---\nname: demo\n---\n");

  // Skills are still not executed — but they are prompt text, and a project
  // that carries nothing else used to bypass the dialog while its skill landed
  // in the session. Requiring trust is what makes the skill gate reachable.
  assert.deepEqual(getProjectTrustStatus(cwd, agentDir), { requiresTrust: true, trusted: false });
});

test("rules and prompts alone still never require trust", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  await mkdir(join(cwd, ".omp"), { recursive: true });
  await writeFile(join(cwd, ".omp", "RULES.md"), "# rules\n");
  await writeFile(join(cwd, ".omp", "APPEND_SYSTEM.md"), "extra\n");

  assert.deepEqual(getProjectTrustStatus(cwd, agentDir), { requiresTrust: false, trusted: true });
});

test("an untrusted project drops only its own extensions, tools, and MCP servers", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  await mkdir(join(cwd, ".omp", "extensions"), { recursive: true });

  const projectExtension = join(cwd, ".omp", "extensions", "probe.ts");
  const userExtension = join(agentDir, "extensions", "user.ts");
  const projectTool = { path: join(cwd, ".omp", "tools", "probe.ts"), source: { level: "project" } };
  const userTool = { path: join(agentDir, "tools", "user.ts"), source: { level: "user" } };

  const gated = untrustedProjectSessionOptions(cwd, agentDir, {
    extensionPaths: [projectExtension, userExtension],
    customToolPaths: [projectTool, userTool],
  });

  assert.deepEqual(gated.preloadedExtensionPaths, [userExtension]);
  assert.deepEqual(gated.preloadedCustomToolPaths, [userTool]);
  assert.equal(gated.enableMCP, false);
});

test("trusting a project persists the decision and restores the normal load path", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  await mkdir(join(cwd, ".omp", "extensions"), { recursive: true });
  const projectExtension = join(cwd, ".omp", "extensions", "probe.ts");

  assert.deepEqual(trustProject(cwd, agentDir), { requiresTrust: true, trusted: true });
  assert.deepEqual(getProjectTrustStatus(cwd, agentDir), { requiresTrust: true, trusted: true });
  assert.equal(
    untrustedProjectSessionOptions(cwd, agentDir, {
      extensionPaths: [projectExtension],
      customToolPaths: [],
    }),
    undefined,
  );

  const stored = JSON.parse(await readFile(join(agentDir, "omp-web-trusted-projects.json"), "utf8"));
  assert.equal(Object.values(stored)[0], true);
});

test("isInsideProject does not treat sibling directories as project-local", () => {
  assert.equal(isInsideProject("/repo/.omp/extensions/a.ts", "/repo"), true);
  assert.equal(isInsideProject("/repo", "/repo"), true);
  assert.equal(isInsideProject("/repo-worktrees/other/a.ts", "/repo"), false);
  assert.equal(isInsideProject("/home/user/.omp/agent/extensions/a.ts", "/repo"), false);
});

test("every project-resource entry point enforces project trust", async () => {
  const rpcSource = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const policySource = await readFile(new URL("./load-policy.ts", import.meta.url), "utf8");
  const skillsSource = await readFile(new URL("./skills-service.ts", import.meta.url), "utf8");
  const skillsInstallSource = await readFile(new URL("../app/api/skills/install/route.ts", import.meta.url), "utf8");

  // The session's code gate lives in the policy now; the policy is the one place
  // that calls it for a session start.
  assert.match(policySource, /untrustedProjectSessionOptions\(cwd, agentDir, \{ extensionPaths, customToolPaths \}\)/);
  assert.match(rpcSource, /resolveSessionLoads\(identity, sessionCwd, settings\)/);
  assert.match(skillsSource, /getProjectTrustStatus\(cwd, agentDir\)\.trusted/);
  assert.match(skillsInstallSource, /getProjectTrustStatus\(cwd, getAgentDir\(\)\)\.trusted/);
});

// ---------------------------------------------------------------------------
// OMP-010: the decision belongs to the project root, not the session cwd
// ---------------------------------------------------------------------------

test("trust is decided at the project root, not at the session cwd", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "omp-web-project-root-"));
  const repo = join(root, "repo");
  const cwd = join(repo, "src");
  const agentDir = join(root, "agent");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(join(repo, ".agents", "skills", "evil"), { recursive: true });
  await writeFile(join(repo, ".agents", "skills", "evil", "SKILL.md"), "---\nname: evil\n---\nbody\n");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  // `/api/project-trust` and `/api/skills` both decide on this result.
  assert.equal(hasTrustRequiringProjectResources(cwd), true);
  assert.deepEqual(getProjectTrustStatus(cwd, agentDir), { requiresTrust: true, trusted: false });

  // The same gate the session and the panel apply to skills.
  const evil = {
    filePath: join(repo, ".agents", "skills", "evil", "SKILL.md"),
    _source: { provider: "agents", level: "project" },
  };
  assert.deepEqual(trustedProjectSkills(cwd, agentDir, [evil]), []);

  // Trusting from the subdirectory stores the repo root, so the decision covers
  // the resource wherever the session starts.
  assert.deepEqual(trustProject(cwd, agentDir), { requiresTrust: true, trusted: true });
  const stored = JSON.parse(await readFile(join(agentDir, "omp-web-trusted-projects.json"), "utf8"));
  assert.deepEqual(Object.keys(stored), [realpathSync(repo)]);
  assert.equal(trustedProjectSkills(cwd, agentDir, [evil]), undefined);
});

// ---------------------------------------------------------------------------
// OMP-011: the process home is not a code allowlist
// ---------------------------------------------------------------------------

test("an untrusted project cannot name code from the home directory itself", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  await mkdir(join(cwd, ".omp", "extensions"), { recursive: true });
  await mkdir(join(agentDir, "extensions"), { recursive: true });

  // `repo/.omp/config.yml` naming a sibling under the process home: inside
  // `os.homedir()`, outside every root omp scans for user-installed code.
  const homeEscape = join(homedir(), ".cache", "omp-web-untrusted-probe.ts");
  // A symlink in the user's own extensions folder that leaves it.
  const linked = join(agentDir, "extensions", "linked.ts");
  const outside = join(cwd, "..", "outside.ts");
  await writeFile(outside, "export default {};\n");
  await symlink(outside, linked);
  const userExtension = join(agentDir, "extensions", "user.ts");
  await writeFile(userExtension, "export default {};\n");

  const gated = untrustedProjectSessionOptions(cwd, agentDir, {
    extensionPaths: [homeEscape, userExtension, linked],
    customToolPaths: [
      { path: homeEscape, source: { level: "user" } },
      { path: userExtension, source: { level: "user" } },
    ],
  });

  assert.deepEqual(gated.preloadedExtensionPaths, [userExtension]);
  assert.deepEqual(gated.preloadedCustomToolPaths, [{ path: userExtension, source: { level: "user" } }]);
});

test("the trust API invalidates cached models and restricted runtimes", async () => {
  const source = await readFile(new URL("../app/api/project-trust/route.ts", import.meta.url), "utf8");
  const rpcSource = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  assert.match(source, /trustProject\(result\.cwd, agentDir\)/);
  assert.match(source, /invalidateModelsCache\(\)/);
  assert.match(source, /destroyRpcSessionsForCwd\(result\.cwd\)/);
  assert.match(source, /hasBusyRpcSessionForCwd\(result\.cwd\)/);
  assert.match(rpcSource, /trackStartingSession\(sessionCwd\)/);
  assert.match(rpcSource, /realpathSync\(resolvedCwd\)/);
});
