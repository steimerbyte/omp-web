import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `/api/skills` is the skills panel: discovery for one cwd (GET) and the
 * admin-only toggle for `disable-model-invocation` (PATCH).
 *
 * The PATCH edits a file in the agent dir, so the test writes a real `SKILL.md`
 * and asserts the *file* afterwards: a 200 that leaves the frontmatter untouched
 * would be the interesting failure, not a 403.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-skills-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;
const AGENT_DIR = join(HOME_ROOT, "agent");
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

const HOME = join(HOME_ROOT, "skills-alice");
const PROJECT = join(HOME, "project");
const SKILL_DIR = join(AGENT_DIR, "skills", "probe");
mkdirSync(PROJECT, { recursive: true });
mkdirSync(SKILL_DIR, { recursive: true });

const SKILL_FILE = join(SKILL_DIR, "SKILL.md");
writeFileSync(
  SKILL_FILE,
  ["---", "name: probe", "description: a probe skill", "---", "", "# Probe", ""].join("\n"),
  "utf8",
);

const route = await jiti.import("./route.ts");
const sdk = await jiti.import("@oh-my-pi/pi-coding-agent");

// `bun test` shares one process: a sibling file may have been the first to
// load the SDK, and its agent dir would then be this file's too.
const dirs = await jiti.import("@oh-my-pi/pi-utils");
dirs.setAgentDir(AGENT_DIR);

const settings = await sdk.Settings.loadIsolated({ agentDir: AGENT_DIR });
const previousRuntime = globalThis.__ompRuntimePromise;
globalThis.__ompRuntimePromise = Promise.resolve({
  agentDir: AGENT_DIR,
  settings,
  authStorage: { findApiKey: async () => undefined },
  modelRegistry: { getAvailable: () => [], getAll: () => [], getError: () => undefined },
});

const ORIGIN = "http://localhost:30141";
const ADMIN = { host: "localhost:30141", "x-omp-user": "skills-admin", "x-omp-admin": "1" };
const TENANT = { host: "localhost:30141", "x-omp-user": "skills-alice" };

function get(query, headers = TENANT) {
  return route.GET(new Request(`${ORIGIN}/api/skills${query}`, { headers }));
}

function patch(headers, body, contentType = "application/json") {
  return route.PATCH(
    new Request(`${ORIGIN}/api/skills`, {
      method: "PATCH",
      headers: { ...headers, "content-type": contentType },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

test.after(() => {
  if (previousRuntime === undefined) delete globalThis.__ompRuntimePromise;
  else globalThis.__ompRuntimePromise = previousRuntime;
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  dirs.__resetDirsFromEnvForTests();
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

test("GET ohne cwd ist 400, fremder Host 403, fremdes cwd 403", async () => {
  assert.equal((await get("")).status, 400);

  const untrusted = await get(`?cwd=${encodeURIComponent(PROJECT)}`, { ...TENANT, host: "evil.example" });
  assert.equal(untrusted.status, 403);

  const outside = await get(`?cwd=${encodeURIComponent("/etc")}`);
  assert.equal(outside.status, 403);
  assert.equal((await outside.json()).error, "Access denied");
});

test("GET listet die Skills inklusive Fundort", async () => {
  const response = await get(`?cwd=${encodeURIComponent(PROJECT)}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  const probe = body.skills.find((skill) => skill.name === "probe");
  assert.ok(probe, `probe-Skill fehlt: ${JSON.stringify(body.skills.map((s) => s.name))}`);
  assert.equal(probe.filePath, SKILL_FILE);
  assert.equal(probe.disableModelInvocation, false);
  assert.ok(Array.isArray(body.diagnostics));
});

test("PATCH ohne JSON oder ohne Identitaet wird abgewiesen", async () => {
  assert.equal((await patch(TENANT, { filePath: SKILL_FILE, disableModelInvocation: true }, "text/plain")).status, 415);
  const anonymous = await patch({ host: "localhost:30141" }, { filePath: SKILL_FILE, disableModelInvocation: true });
  assert.equal(anonymous.status, 403);
});

test("ein Mandant darf kein SKILL.md umschreiben", async () => {
  const before = readFileSync(SKILL_FILE, "utf8");
  const response = await patch(TENANT, { filePath: SKILL_FILE, disableModelInvocation: true });
  assert.equal(response.status, 403);
  assert.equal(readFileSync(SKILL_FILE, "utf8"), before);
});

test("nur SKILL.md und nur mit Boolean", async () => {
  const noPath = await patch(ADMIN, { disableModelInvocation: true });
  assert.equal(noPath.status, 400);
  assert.equal((await noPath.json()).error, "filePath required");

  const noBool = await patch(ADMIN, { filePath: SKILL_FILE });
  assert.equal(noBool.status, 400);
  assert.equal((await noBool.json()).error, "disableModelInvocation must be boolean");

  const otherFile = await patch(ADMIN, { filePath: join(AGENT_DIR, "config.yml"), disableModelInvocation: true });
  assert.equal(otherFile.status, 400);
  assert.equal((await otherFile.json()).error, "Only SKILL.md files can be changed");

  const missing = await patch(ADMIN, { filePath: join(SKILL_DIR, "nope", "SKILL.md"), disableModelInvocation: true });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "file not found");
});

test("der Admin setzt disable-model-invocation in der Datei", async () => {
  const before = readFileSync(SKILL_FILE, "utf8");
  const on = await patch(ADMIN, { filePath: SKILL_FILE, disableModelInvocation: true });
  assert.equal(on.status, 200);
  assert.equal(
    readFileSync(SKILL_FILE, "utf8"),
    before.replace(/^---\n/, "---\ndisable-model-invocation: true\n"),
  );

  // Regression: `parseFrontmatter()` normalizes keys to camelCase, so a kebab
  // lookup left `alreadySet` false — a second `true` appended a duplicate and
  // `false` never removed the line.
  const second = await patch(ADMIN, { filePath: SKILL_FILE, disableModelInvocation: true });
  assert.equal(second.status, 200);
  const duplicated = readFileSync(SKILL_FILE, "utf8").split("disable-model-invocation: true").length - 1;
  assert.equal(duplicated, 1, "ein zweites `true` darf die Zeile nicht duplizieren");

  const off = await patch(ADMIN, { filePath: SKILL_FILE, disableModelInvocation: false });
  assert.equal(off.status, 200);
  assert.equal(readFileSync(SKILL_FILE, "utf8"), before);
  assert.doesNotMatch(readFileSync(SKILL_FILE, "utf8"), /disable-model-invocation/);

  // A hand-written `false` line is rewritten in place, not shadowed by a
  // prepended second key (YAML keeps the last one).
  const dormant = before.replace(/^---\n/, "---\ndisable-model-invocation: false\n");
  writeFileSync(SKILL_FILE, dormant, "utf8");
  assert.equal((await patch(ADMIN, { filePath: SKILL_FILE, disableModelInvocation: true })).status, 200);
  assert.equal(
    readFileSync(SKILL_FILE, "utf8"),
    dormant.replace("disable-model-invocation: false", "disable-model-invocation: true"),
  );
});
