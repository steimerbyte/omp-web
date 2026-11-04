import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { parse as parseYaml } from "yaml";

/**
 * `/api/models-config` is the credential store for custom providers.
 *
 * `<agentDir>` is **per account** (`lib/tenant-config.ts`): a shared file would
 * let user B bill user A's credits by adding a provider. Every case here reads
 * the file that actually landed on disk, not only the status code.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-models-config-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const ALICE_AGENT = join(HOME_ROOT, "models-cfg-alice", ".omp", "agent");
const BOB_AGENT = join(HOME_ROOT, "models-cfg-bob", ".omp", "agent");
mkdirSync(join(HOME_ROOT, "models-cfg-alice"), { recursive: true });
mkdirSync(ALICE_AGENT, { recursive: true });
// alice already has a legacy JSON file: omp reads it and migrates on write.
writeFileSync(
  join(ALICE_AGENT, "models.json"),
  JSON.stringify({ providers: { legacy: { baseUrl: "https://legacy.example/v1", models: [{ id: "old" }] } } }),
  "utf8",
);
mkdirSync(join(HOME_ROOT, "models-cfg-bob"), { recursive: true });

const route = await jiti.import("./route.ts");

const ORIGIN = "http://localhost:30141";
const ADMIN = { host: "localhost:30141", "x-omp-user": "models-cfg-alice" };
const BOB = { host: "localhost:30141", "x-omp-user": "models-cfg-bob" };

function get(headers = ADMIN) {
  return route.GET(new Request(`${ORIGIN}/api/models-config`, { headers }));
}

function put(headers, body, contentType = "application/json") {
  return route.PUT(
    new Request(`${ORIGIN}/api/models-config`, {
      method: "PUT",
      headers: { ...headers, "content-type": contentType },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

test.after(() => {
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

test("ohne Identitaet gibt es weder Lesen noch Schreiben", async () => {
  assert.equal((await get({ host: "localhost:30141" })).status, 403);
  const write = await put({ host: "localhost:30141" }, { providers: {} });
  assert.equal(write.status, 403);
  assert.equal((await write.json()).error, "Access denied");
});

test("ein fremder Host wird abgewiesen", async () => {
  const response = await get({ ...ADMIN, host: "evil.example" });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Untrusted API request");
});

test("GET liest das Legacy-models.json des Kontos", async () => {
  const response = await get();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.providers.legacy.baseUrl, "https://legacy.example/v1");
});

test("PUT schreibt models.yml in das Agent-Verzeichnis des Aufrufers", async () => {
  const response = await put(BOB, {
    providers: {
      probe: {
        baseUrl: "https://probe.example/v1",
        api: "openai-completions",
        models: [{ id: "probe-model" }, { id: "  " }, { id: 42 }, { name: "no id" }],
      },
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });

  const file = join(BOB_AGENT, "models.yml");
  assert.equal(existsSync(file), true, "models.yml fehlt im Konto-Verzeichnis");
  // The store holds credentials; the file must not be world-readable.
  assert.equal(statSync(file).mode & 0o077, 0);
  const written = parseYaml(readFileSync(file, "utf8"));
  // Blank ids are dropped; a non-string id and an entry without a model id stay
  // visible to the user instead of being rewritten silently.
  assert.deepEqual(written.providers.probe.models, [{ id: "probe-model" }, { id: 42 }, { name: "no id" }]);
  assert.equal(written.providers.probe.baseUrl, "https://probe.example/v1");
});

test("ein Schreibvorgang landet nie im Verzeichnis eines anderen Kontos", async () => {
  const aliceBefore = readFileSync(join(ALICE_AGENT, "models.json"), "utf8");
  await put({ host: "localhost:30141", "x-omp-user": "models-cfg-alice" }, { providers: { mine: { models: [] } } });
  assert.equal(readFileSync(join(ALICE_AGENT, "models.json"), "utf8"), aliceBefore);
  assert.equal(existsSync(join(BOB_AGENT, "models.yml.providers.mine")), false);
  const bobConfig = parseYaml(readFileSync(join(BOB_AGENT, "models.yml"), "utf8"));
  assert.equal(bobConfig.providers.probe !== undefined, true);
  assert.equal(bobConfig.providers.mine, undefined, "alice' Provider steht in bob's Datei");
});

test("ein Nicht-JSON-Content-Type ist 415, ohne die Datei anzufassen", async () => {
  const before = readFileSync(join(BOB_AGENT, "models.yml"), "utf8");
  const response = await put(BOB, { providers: {} }, "text/plain");
  assert.equal(response.status, 415);
  assert.equal(readFileSync(join(BOB_AGENT, "models.yml"), "utf8"), before);
});

test("ein Array, null oder ein kaputter providers-Wert ist 400", async () => {
  for (const [label, body] of [
    ["array", [1, 2, 3]],
    ["null", null],
    ["providers array", { providers: [] }],
    ["providers string", { providers: "probe" }],
  ]) {
    const response = await put(BOB, body);
    assert.equal(response.status, 400, label);
  }
});

test("ungueltiges JSON ist 500 und laesst die Datei unveraendert", async () => {
  const before = readFileSync(join(BOB_AGENT, "models.yml"), "utf8");
  const response = await put(BOB, "{ not json");
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, "Unable to save models config");
  assert.equal(readFileSync(join(BOB_AGENT, "models.yml"), "utf8"), before);
});

test("GET nach PUT spiegelt den neuen Stand und ignoriert das Legacy-File", async () => {
  const body = await (await get(BOB)).json();
  assert.equal(body.providers.probe.baseUrl, "https://probe.example/v1");
});
