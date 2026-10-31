import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Project skills must follow project trust, in the session *and* in
 * `GET /api/skills`. Before this gate an untrusted checkout carrying
 * `.agents/skills/evil/SKILL.md` had that skill in the session while its
 * `.omp/extensions` stayed dormant — a repository the user merely opened could
 * inject instructions into the agent with no trust dialog at all.
 *
 * The fixtures drive omp's real `loadSkills()`, so "which sources are
 * project-scoped" is answered by the loader rather than by a path list copied
 * into this file. `getAgentDir()` resolves process-wide at import time, so each
 * load runs in its own process with its own `PI_CODING_AGENT_DIR` — the same
 * reason `lib/omp-runtime.test.mjs` does it. That process runs with the repo as
 * its cwd: the SDK resolves its native addon through the load path, so a probe
 * outside the tree cannot even import it.
 */
const jiti = createJiti(import.meta.url);
const { hasTrustRequiringProjectResources, trustProject, trustedProjectSkills } =
  await jiti.import("./project-trust.ts");

const SKILL = (name) => `---\nname: ${name}\ndescription: ${name}\n---\nbody ${name}\n`;

/** Project-scoped skill dirs across every provider the loader registers for skills. */
const PROJECT_SKILL_DIRS = [
  ".omp/skills", ".agent/skills", ".agents/skills",
  ".claude/skills", ".codex/skills", ".github/skills", ".opencode/skills",
];

/**
 * The probe must live inside the repo: run from `os.tmpdir()` it cannot resolve
 * `@oh-my-pi/pi-coding-agent`, and without the SDK there is nothing to measure.
 * It is a checked-in file next to this test, not a generated one, so the
 * measurement is reviewable.
 */
const PROBE = new URL("./project-skill-trust.probe.mjs", import.meta.url).pathname;

async function createFixture(t, { trusted = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "omp-web-skill-trust-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  for (const dir of [cwd, agentDir, join(root, "home")]) await mkdir(dir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  // The attack from the scan: a project skill in a project that needs a trust
  // decision. `.omp/extensions` is what makes it need one.
  await mkdir(join(cwd, ".agents", "skills", "evil"), { recursive: true });
  await writeFile(join(cwd, ".agents", "skills", "evil", "SKILL.md"), SKILL("evil"));
  await mkdir(join(cwd, ".omp", "extensions"), { recursive: true });

  // A user-scoped skill: not attacker-controlled, must survive a narrowing.
  await mkdir(join(agentDir, "skills", "good"), { recursive: true });
  await writeFile(join(agentDir, "skills", "good", "SKILL.md"), SKILL("good"));

  if (trusted) trustProject(cwd, agentDir);
  return { root, cwd, agentDir };
}

/**
 * What a session for this project loads, measured by omp's own discovery.
 *
 * `identity` measures `getSettingsForIdentity` (the session's real resolution)
 * instead of a directly loaded Settings; `homeRoot` is then the account root.
 */
function sessionSkills({ cwd, agentDir, root }, { identity, homeRoot } = {}) {
  const out = execFileSync(process.execPath, [PROBE], {
    encoding: "utf8",
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PROBE_CWD: cwd,
      NODE_ENV: "test",
      // A fixture home: user-level scans (`~/.agents/skills`, `~/.claude/skills`)
      // must not measure the developer's machine.
      HOME: join(root, "home"),
      // The identity path builds the process runtime (`getOmpRuntime`); keep its
      // model registry offline exactly as `bun test` would.
      PI_TEST_RUNTIME: "1",
      ...(identity ? { PROBE_IDENTITY: identity, OMP_WEB_HOME_ROOT: homeRoot ?? join(root, "home") } : {}),
    },
    cwd: new URL("..", import.meta.url).pathname,
  });
  return JSON.parse(out.trim().split("\n").at(-1));
}

test("an untrusted project does not load its own skills", async (t) => {
  const fixture = await createFixture(t);
  assert.equal(hasTrustRequiringProjectResources(fixture.cwd), true);

  const result = sessionSkills(fixture);
  assert.ok(!result.names.includes("evil"), `project skill reached the session: ${result.names.join(", ")}`);
  assert.ok(result.names.includes("good"), `user skill dropped: ${result.names.join(", ")}`);
  assert.equal(result.trusted, false);
  assert.equal(result.withheld, 1);
});

test("a trusted project loads the same project skill", async (t) => {
  const fixture = await createFixture(t, { trusted: true });

  const result = sessionSkills(fixture);
  assert.ok(result.names.includes("evil"), `trusted project lost its skill: ${result.names.join(", ")}`);
  assert.ok(result.names.includes("good"));
  assert.equal(result.trusted, true);
  assert.equal(result.withheld, 0);
});

test("user-scoped skills keep loading in an untrusted project", async (t) => {
  const fixture = await createFixture(t);

  const result = sessionSkills(fixture);
  assert.ok(result.names.includes("good"), `user skill missing: ${result.names.join(", ")}`);
});

test("every project-scoped skill source is classified, not just .agents", async (t) => {
  const fixture = await createFixture(t);
  for (const [index, dir] of PROJECT_SKILL_DIRS.entries()) {
    await mkdir(join(fixture.cwd, dir, `projskill${index}`), { recursive: true });
    await writeFile(join(fixture.cwd, dir, `projskill${index}`, "SKILL.md"), SKILL(`projskill${index}`));
  }

  const result = sessionSkills(fixture);
  const leaked = result.names.filter((name) => name.startsWith("projskill"));
  assert.deepEqual(leaked, [], `project sources leaked: ${leaked.join(", ")}`);
  // The fixture already ships `.agents/skills/evil`, so every dir above adds one.
  assert.equal(result.withheld, PROJECT_SKILL_DIRS.length + 1);
});

test("a project cannot smuggle skills in through skills.customDirectories", async (t) => {
  const fixture = await createFixture(t);
  // A custom directory is labelled `custom:user`, so the level alone does not
  // catch this; the path test does. Measured before the gate: `sneaky` loaded.
  const smuggled = join(fixture.cwd, "evil-custom", "sneaky");
  await mkdir(smuggled, { recursive: true });
  await writeFile(join(smuggled, "SKILL.md"), SKILL("sneaky"));
  await writeFile(
    join(fixture.cwd, ".omp", "config.yml"),
    `skills:\n  customDirectories:\n    - ${join(fixture.cwd, "evil-custom")}\n`,
  );

  const result = sessionSkills(fixture);
  assert.ok(!result.names.includes("sneaky"), `custom-directory skill loaded: ${result.names.join(", ")}`);
  // Two, not one: the level drops `.agents/skills/evil`, the path test drops the
  // `custom:user` entry. Without the path half this count is 1 and `sneaky`
  // appears — the assertion is what makes the test measure the path rule.
  assert.equal(result.withheld, 2, `withheld: ${result.withheld} for ${result.names.join(", ")}`);
});

// Der Identitätspfad baut den Prozess-Runtime (`getOmpRuntime`) im Kindprozess;
// in der vollen Suite dauert das länger als das Standard-Limit von 5 s.
test("a tenant's own store survives an untrusted project; the project's skill does not", { timeout: 30_000 }, async (t) => {
  const fixture = await createFixture(t);
  // The tenant's store is outside the project (it is the account's own folder),
  // which is exactly the difference the path rule has to keep: level `user`,
  // file outside `cwd` → keep. The fixture's `.agents/skills/evil` is inside →
  // drop.
  const store = join(fixture.root, "user-skills");
  const tenantAgentDir = join(fixture.root, "home", "alice", ".omp", "agent");
  await mkdir(tenantAgentDir, { recursive: true });
  await mkdir(join(store, "mine"), { recursive: true });
  await writeFile(join(store, "mine", "SKILL.md"), SKILL("mine"));
  await writeFile(
    join(tenantAgentDir, "config.yml"),
    `skills:\n  customDirectories:\n    - ${store}\n`,
  );

  const result = sessionSkills(fixture, { identity: "alice" });
  assert.equal(result.trusted, false);
  assert.ok(result.names.includes("mine"), `tenant store dropped: ${result.names.join(", ")}`);
  assert.ok(result.names.includes("good"), `process-level user skill dropped: ${result.names.join(", ")}`);
  assert.ok(!result.names.includes("evil"), `project skill leaked: ${result.names.join(", ")}`);
  assert.equal(result.withheld, 1);

  // Control: the same tree without the identity does not know the tenant store
  // at all. `mine` therefore proves the identity-resolved Settings, not some
  // path the loader finds on its own.
  const plain = sessionSkills(fixture);
  assert.ok(!plain.names.includes("mine"), `process view saw the tenant store: ${plain.names.join(", ")}`);
});

test("the filter leaves a trusted project on omp's own load path", async (t) => {
  const fixture = await createFixture(t, { trusted: true });

  assert.equal(
    trustedProjectSkills(fixture.cwd, fixture.agentDir, [
      { filePath: join(fixture.cwd, ".agents", "skills", "evil", "SKILL.md"), _source: { provider: "agents", level: "project" } },
    ]),
    undefined,
  );
});

test("the skills API and the session share one discovery and one filter", async () => {
  // Same helper, so "what the panel lists" cannot drift from "what the agent
  // can use". A second filter in the route is exactly the drift this guards.
  const { readFile } = await import("node:fs/promises");
  const service = await readFile(new URL("./skills-service.ts", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/skills/route.ts", import.meta.url), "utf8");
  const rpc = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  assert.match(service, /loadSessionSkills\(cwd, settings\)/, "GET /api/skills must use the shared loader");
  assert.match(rpc, /loadSessionSkills\(sessionCwd, settings\)/, "the session must use the shared loader");
  assert.doesNotMatch(route, /trustedProjectSkills|loadSkills\(/, "the route must not filter skills itself");
});
