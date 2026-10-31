import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * Registering a tenant's skill folder must copy only the account's own global
 * layer, never the merged view.
 *
 * The process may run inside a project with its own `.omp/config.yml`
 * (`skills.customDirectories`); `getSettingsForIdentity(identity, undefined)`
 * builds the account instance with that cwd, so its merged view contains the
 * operator's entry. Writing the merged list back persists the operator's path
 * in the tenant's `config.yml`, where it is user-level and therefore survives
 * the project-trust filter. Measured in a child process because `getProjectDir()`
 * caches at import.
 */
const PROBE = new URL("./skills-registration.probe.mjs", import.meta.url).pathname;

const root = mkdtempSync(join(tmpdir(), "omp-web-skills-registration-"));
const fixture = {
  root,
  operatorProject: join(root, "operator-project"),
  operatorSkills: join(root, "operator-skills"),
  homeRoot: join(root, "home"),
  processAgentDir: join(root, "process-agent"),
  aliceProject: join(root, "home", "alice", "project"),
};
for (const dir of [
  join(fixture.operatorProject, ".omp"),
  fixture.operatorSkills,
  fixture.aliceProject,
  fixture.processAgentDir,
]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(
  join(fixture.operatorProject, ".omp", "config.yml"),
  `skills:\n  customDirectories:\n    - ${fixture.operatorSkills}\n`,
);
test.after(() => rmSync(root, { recursive: true, force: true }));

const out = execFileSync(process.execPath, [PROBE], {
  encoding: "utf8",
  // The cwd is the point: its project layer must not reach the tenant config.
  cwd: fixture.operatorProject,
  env: {
    ...process.env,
    OMP_WEB_HOME_ROOT: fixture.homeRoot,
    PI_CODING_AGENT_DIR: fixture.processAgentDir,
    PI_TEST_RUNTIME: "1",
    PROBE_PROJECT: fixture.aliceProject,
    NODE_ENV: "test",
  },
});
const measured = JSON.parse(out.trim().split("\n").at(-1));
const tenantConfig = readFileSync(join(fixture.homeRoot, "alice", ".omp", "agent", "config.yml"), "utf8");

test("the registration writes the account's folder", () => {
  assert.equal(measured.directory, join(fixture.homeRoot, "alice", ".omp", "agent", "skills"));
  assert.ok(Array.isArray(measured.global), `global layer: ${JSON.stringify(measured.global)}`);
  assert.deepEqual(measured.global, [measured.directory]);
});

test("the process project's custom directory does not reach the tenant", () => {
  assert.ok(!tenantConfig.includes(fixture.operatorSkills), tenantConfig);
  assert.ok(!JSON.stringify(measured.global).includes(fixture.operatorSkills), tenantConfig);
  assert.ok(!measured.session.includes(fixture.operatorSkills), JSON.stringify(measured.session));
  assert.ok(measured.session.includes(measured.directory), JSON.stringify(measured.session));
});
