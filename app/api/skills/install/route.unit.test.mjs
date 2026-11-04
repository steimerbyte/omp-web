import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `POST /api/skills/install` runs `npx skills add` and writes into either the
 * process-wide `~/.agents` (global) or the project.
 *
 * That makes every branch *before* the spawn the interesting surface: a global
 * install is admin-only, a project install needs `cwd` inside the caller's
 * roots, and it needs the project to be trusted. No case here reaches the spawn.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-skills-install-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;
const AGENT_DIR = join(HOME_ROOT, "agent");
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

const HOME = join(HOME_ROOT, "install-alice");
const CLEAN = join(HOME, "clean");
const CODEY = join(HOME, "codey");
mkdirSync(CLEAN, { recursive: true });
mkdirSync(join(CODEY, ".omp", "skills", "probe"), { recursive: true });
writeFileSync(
  join(CODEY, ".omp", "skills", "probe", "SKILL.md"),
  "---\nname: probe\ndescription: project skill\n---\n",
  "utf8",
);
mkdirSync(AGENT_DIR, { recursive: true });

const route = await jiti.import("./route.ts");

// `bun test` shares one process: a sibling file may have been the first to
// load the SDK, and its agent dir would then be this file's too.
const dirs = await jiti.import("@oh-my-pi/pi-utils");
dirs.setAgentDir(AGENT_DIR);

const ORIGIN = "http://localhost:30141";
const TENANT = { host: "localhost:30141", "x-omp-user": "install-alice" };
const ADMIN = { host: "localhost:30141", "x-omp-user": "install-admin", "x-omp-admin": "1" };

function post(body, headers = TENANT, contentType = "application/json") {
  return route.POST(
    new Request(`${ORIGIN}/api/skills/install`, {
      method: "POST",
      headers: { ...headers, "content-type": contentType },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

test.after(() => {
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  dirs.__resetDirsFromEnvForTests();
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

test("ohne JSON ist 415, ein fremder Host 403", async () => {
  assert.equal((await post({ package: "owner/repo@skill", scope: "project" }, TENANT, "text/plain")).status, 415);
  const untrusted = await post({ package: "owner/repo@skill", scope: "project", cwd: CLEAN }, { ...TENANT, host: "evil.example" });
  assert.equal(untrusted.status, 403);
});

test("package und scope werden geprueft, bevor irgendetwas laeuft", async () => {
  const noPackage = await post({ scope: "project", cwd: CLEAN });
  assert.equal(noPackage.status, 400);
  assert.equal((await noPackage.json()).error, "package required");

  // `pkg`, not a URL and not something that could be read as an option.
  for (const bad of ["-g", "owner/repo", "owner/repo@", "owner/repo@1/2", "a".repeat(257)]) {
    const response = await post({ package: bad, scope: "project", cwd: CLEAN });
    assert.equal(response.status, 400, bad);
    assert.match((await response.json()).error, /GitHub skill reference/);
  }

  const badScope = await post({ package: "owner/repo@skill", scope: "everywhere", cwd: CLEAN });
  assert.equal(badScope.status, 400);
  assert.equal((await badScope.json()).error, "scope must be global or project");
});

test("ein globaler Install ist fuer Mandanten gesperrt", async () => {
  const response = await post({ package: "owner/repo@skill", scope: "global" });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Access denied");
  // The same call without an identity is refused even earlier.
  const anonymous = await post({ package: "owner/repo@skill", scope: "global" }, { host: "localhost:30141" });
  assert.equal(anonymous.status, 403);
});

test("ein Projekt-Install braucht ein erlaubtes cwd", async () => {
  const noCwd = await post({ package: "owner/repo@skill", scope: "project" });
  assert.equal(noCwd.status, 400);
  assert.equal((await noCwd.json()).error, "cwd required for project install");

  const outside = await post({ package: "owner/repo@skill", scope: "project", cwd: "/etc" });
  assert.equal(outside.status, 403);
  assert.equal((await outside.json()).error, "Access denied");
});

test("ein unvertrautes Projekt wird nicht beschrieben", async () => {
  const response = await post({ package: "owner/repo@skill", scope: "project", cwd: CODEY }, ADMIN);
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /must be trusted/);
});
