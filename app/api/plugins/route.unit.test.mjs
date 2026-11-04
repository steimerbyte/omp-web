import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `GET /api/plugins?cwd=` is the plugins panel's list: installed packages, their
 * resource rows, and the doctor diagnostics.
 *
 * The store is `<config root>/plugins` — process-global. The test points HOME at
 * a temp dir and rebuilds the SDK's directory resolver, so it never reads the
 * operator's `~/.omp/plugins`; the fixture is a two-package store (one enabled
 * with declared features, one disabled) written directly.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-plugins-"));
const previousHome = process.env.HOME;
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousXdgData = process.env.XDG_DATA_HOME;
const previousProfile = process.env.OMP_PROFILE;
const previousPiProfile = process.env.PI_PROFILE;
// The config root (`~/.omp`) is frozen at module load, so HOME is no lever. The
// data root is: an existing `<XDG_DATA_HOME>/omp` moves the plugin store there,
// and `__resetDirsFromEnvForTests()` makes the resolver see it.
const XDG_DATA = join(HOME_ROOT, "xdg-data");
mkdirSync(join(XDG_DATA, "omp"), { recursive: true });
process.env.XDG_DATA_HOME = XDG_DATA;
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;
// A sibling test file may have called `setAgentDir()` (which pins an override
// that disables the XDG resolution below) or set the profile env. Clear both
// before the resolver is rebuilt.
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.OMP_PROFILE;
delete process.env.PI_PROFILE;

const HOME = join(HOME_ROOT, "plug-alice");
mkdirSync(join(HOME, "project"), { recursive: true });

const route = await jiti.import("./route.ts");
const dirs = await jiti.import("@oh-my-pi/pi-utils");
dirs.__resetDirsFromEnvForTests();

const PLUGINS_DIR = dirs.getPluginsDir();
assert.equal(PLUGINS_DIR.startsWith(HOME_ROOT), true, `Plugin-Store liegt ausserhalb des Temp-Home: ${PLUGINS_DIR}`);

function writePlugin(name, pkg, lockEntry) {
  const dir = join(PLUGINS_DIR, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...pkg }), "utf8");
  // The doctor checks that declared entry points exist; a fixture without them
  // would report a real-looking error the route did not cause.
  for (const relative of [...(pkg.omp?.extensions ?? []), ...(pkg.omp?.commands ?? [])]) {
    mkdirSync(join(dir, relative, ".."), { recursive: true });
    writeFileSync(join(dir, relative), relative.endsWith(".md") ? "# probe\n" : "export default {};\n", "utf8");
  }
  return lockEntry;
}

const lock = { plugins: {} };
lock.plugins["probe-plugin"] = writePlugin("probe-plugin", {
  omp: {
    extensions: ["./src/extension.ts"],
    features: {
      skills: { default: true, skills: ["./skills/probe/SKILL.md"] },
      extra: { default: false, tools: ["./src/extra-tool.ts"], hooks: ["./src/hook.ts"] },
    },
  },
}, { version: "1.0.0", enabledFeatures: null, enabled: true });
lock.plugins["off-plugin"] = writePlugin("off-plugin", {
  omp: { commands: ["./commands/probe.md"] },
}, { version: "1.0.0", enabledFeatures: ["commands"], enabled: false });

mkdirSync(PLUGINS_DIR, { recursive: true });
writeFileSync(
  join(PLUGINS_DIR, "package.json"),
  JSON.stringify({ name: "omp-plugins", private: true, dependencies: { "probe-plugin": "1.0.0", "off-plugin": "1.0.0" } }),
  "utf8",
);
writeFileSync(join(PLUGINS_DIR, "omp-plugins.lock.json"), JSON.stringify(lock), "utf8");

const ORIGIN = "http://localhost:30141";
const TENANT = { host: "localhost:30141", "x-omp-user": "plug-alice" };

function get(query, headers = TENANT) {
  return route.GET(new Request(`${ORIGIN}/api/plugins${query}`, { headers }));
}

test.after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousXdgData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdgData;
  if (previousProfile === undefined) delete process.env.OMP_PROFILE;
  else process.env.OMP_PROFILE = previousProfile;
  if (previousPiProfile === undefined) delete process.env.PI_PROFILE;
  else process.env.PI_PROFILE = previousPiProfile;
  dirs.__resetDirsFromEnvForTests();
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

test("ohne cwd ist 400", async () => {
  const response = await get("");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "cwd required");
});

test("ein cwd ausserhalb der eigenen Wurzeln ist 403", async () => {
  const response = await get(`?cwd=${encodeURIComponent("/etc")}`);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Access denied");
});

test("ohne Identitaet ist kein cwd erlaubt", async () => {
  const response = await get(`?cwd=${encodeURIComponent(join(HOME, "project"))}`, { host: "localhost:30141" });
  assert.equal(response.status, 403);
});

test("die Liste zeigt Ressourcen, Zaehler und den Status je Paket", async () => {
  const response = await get(`?cwd=${encodeURIComponent(join(HOME, "project"))}`);
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.projectResourcesLoaded, true);
  assert.deepEqual(body.diagnostics.filter((entry) => entry.type === "error"), []);

  const probe = body.packages.find((entry) => entry.packageName === "probe-plugin");
  assert.ok(probe, "probe-plugin fehlt");
  assert.equal(probe.status, "loaded");
  assert.equal(probe.disabled, false);
  assert.equal(probe.scope, "global");
  // manifest.extensions + feature `skills` (default) => one extension row; the
  // disabled feature `extra` contributes nothing.
  assert.equal(probe.counts.extensions, 1);
  assert.equal(probe.resources.length, 1);
  assert.equal(probe.resources[0].kind, "extension");
  assert.equal(probe.resources[0].relativePath, "./src/extension.ts");
  assert.equal(probe.resources[0].name, "src/extension");

  const off = body.packages.find((entry) => entry.packageName === "off-plugin");
  assert.equal(off.status, "disabled");
  assert.equal(off.disabled, true);
  // `enabledFeatures: ["commands"]` means "filtered", even while disabled.
  assert.equal(off.filtered, true);
  assert.equal(off.counts.prompts, 1);

  assert.equal(body.totals.extensions, 1);
  assert.equal(body.totals.prompts, 1);
});

test("POST ist admin-only, bevor irgendein Store angefasst wird", async () => {
  const tenant = await route.POST(
    new Request(`${ORIGIN}/api/plugins`, {
      method: "POST",
      headers: { "content-type": "application/json", ...TENANT },
      body: JSON.stringify({ action: "install", cwd: join(HOME, "project") }),
    }),
  );
  assert.equal(tenant.status, 403);
  assert.equal((await tenant.json()).error, "Administrator access is required.");

  const admin = await route.POST(
    new Request(`${ORIGIN}/api/plugins`, {
      method: "POST",
      headers: { "content-type": "text/plain", host: "localhost:30141", "x-omp-user": "plug-admin", "x-omp-admin": "1" },
      body: "{}",
    }),
  );
  assert.equal(admin.status, 415);
});
