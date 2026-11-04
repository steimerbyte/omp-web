import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `GET /api/models` drives the model selector.
 *
 * It is the composition: the registry's load error is surfaced instead of
 * swallowed, the enabled-models scope is resolved through omp's resolver (globs,
 * not string equality), the role table is shipped, and a cwd that is not
 * allowed is refused before the registry is asked.
 *
 * The registry is replaced by the two calls the route makes (`getAvailable`,
 * `getError`) — a real one would need provider credentials and a catalog fetch.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-models-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;
const AGENT_DIR = join(HOME_ROOT, "agent");
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

const HOME = join(HOME_ROOT, "models-alice");
mkdirSync(join(HOME, "project"), { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });

const route = await jiti.import("./route.ts");
const sdk = await jiti.import("@oh-my-pi/pi-coding-agent");

const MODELS = [
  { id: "zeta", name: "Zeta", provider: "prov", api: "openai-completions", reasoning: true },
  { id: "alpha", name: "alpha", provider: "prov", api: "openai-completions", reasoning: false },
  { id: "beta", name: "Beta", provider: "aaa", api: "openai-completions", reasoning: false },
];

function installRuntime({ models = MODELS, error } = {}) {
  globalThis.__ompRuntimePromise = Promise.resolve({
    agentDir: AGENT_DIR,
    settings,
    authStorage: { findApiKey: async () => undefined },
    modelRegistry: {
      getAvailable: () => models,
      getAll: () => models,
      getError: () => error,
    },
  });
}

const settings = await sdk.Settings.loadIsolated({ agentDir: AGENT_DIR });
const previousRuntime = globalThis.__ompRuntimePromise;
installRuntime();

const ORIGIN = "http://localhost:30141";

function get(query, headers = { "x-omp-user": "models-alice" }) {
  return route.GET(new Request(`${ORIGIN}/api/models${query}`, { headers: { host: "localhost:30141", ...headers } }));
}

test.after(() => {
  if (previousRuntime === undefined) delete globalThis.__ompRuntimePromise;
  else globalThis.__ompRuntimePromise = previousRuntime;
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

test("ein nicht existierendes cwd ist 400, bevor die Registry gefragt wird", async () => {
  const response = await get(`?cwd=${encodeURIComponent(join(HOME, "missing"))}`);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Directory does not exist/);
});

test("eine Datei statt eines Verzeichnisses ist 400", async () => {
  const file = join(HOME, "project", "notes.txt");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, "x");
  const response = await get(`?cwd=${encodeURIComponent(file)}`);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Not a directory/);
});

test("ein cwd ausserhalb der erlaubten Wurzeln ist 403", async () => {
  const response = await get(`?cwd=${encodeURIComponent("/etc")}`);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Access denied");
});

test("die Liste ist nach Name sortiert und die Namenstabelle passt dazu", async () => {
  const response = await get(`?cwd=${encodeURIComponent(join(HOME, "project"))}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  // `Intl.Collator({ sensitivity: "base" })`: case-insensitive, so "alpha"
  // sorts before "Beta" — matching what the selector shows.
  assert.deepEqual(body.modelList, [
    { id: "alpha", name: "alpha", provider: "prov" },
    { id: "beta", name: "Beta", provider: "aaa" },
    { id: "zeta", name: "Zeta", provider: "prov" },
  ]);
  assert.deepEqual(body.models, {
    "prov:zeta": "Zeta",
    "prov:alpha": "alpha",
    "aaa:beta": "Beta",
  });
  assert.deepEqual(body.thinkingLevels["prov:zeta"], []);
  assert.equal(Array.isArray(body.roles), true);
  assert.ok(body.roles.some((role) => role.role === "default"));
});

test("ein Modellfehler der Registry steht im Payload, statt die Liste zu leeren", async () => {
  installRuntime({ error: { message: "catalog unavailable" } });
  // A second cwd: the payload is cached per directory, and the cache is part of
  // the route's contract (the next request must not re-resolve the registry).
  const errorProject = join(HOME, "project-error");
  mkdirSync(errorProject, { recursive: true });
  try {
    const response = await get(`?cwd=${encodeURIComponent(errorProject)}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.modelError, "catalog unavailable");
    assert.equal(body.modelList.length, 3);
  } finally {
    installRuntime();
  }
});

test("ohne cwd nimmt die Route das Prozessverzeichnis — und die Wurzeln entscheiden", async () => {
  // `process.cwd()` is the repository; a tenant does not own it.
  const response = await get("");
  assert.equal(response.status, 403);
});
