import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Die Grenze von `POST /api/models-config/test`.
 *
 * Der Test ruft `completeSimple` mit dem prozessweiten Key des Betreibers auf
 * und schickt dabei die vom Aufrufer gewaehlte `baseUrl` — das ist eine
 * Admin-Funktion, kein Mandantenwerkzeug. Ausserdem darf der Body die
 * `!`-Kommando-Resolver des SDK nicht erreichen.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-model-test-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const AGENT_DIR = join(HOME_ROOT, "agent");
mkdirSync(AGENT_DIR, { recursive: true });

const route = await jiti.import("./route.ts");
const sdk = await jiti.import("@oh-my-pi/pi-coding-agent");

const previousRuntime = globalThis.__ompRuntimePromise;
globalThis.__ompRuntimePromise = sdk.discoverAuthStorage(AGENT_DIR).then((authStorage) => ({ agentDir: AGENT_DIR, authStorage }));

const ADMIN = { host: "localhost", "x-omp-user": "pi", "x-omp-admin": "1" };
const TENANT = { host: "localhost", "x-omp-user": "alice" };

function post(headers, body) {
  return route.POST(new Request("http://localhost/api/models-config/test", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

/** Kein Provider ohne eigenen Key: `auth: "oauth"` laesst die Process-Key-Suche laufen. */
function body(provider = {}, model = {}) {
  return {
    providerName: "probe",
    provider: { baseUrl: "https://models.example/v1", api: "openai-completions", auth: "oauth", ...provider },
    model: { id: "probe-model", ...model },
  };
}

test.after(() => {
  if (previousRuntime === undefined) delete globalThis.__ompRuntimePromise;
  else globalThis.__ompRuntimePromise = previousRuntime;
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

test("ein Mandant bekommt 403 statt eines Prozess-Key-Probes", async () => {
  const res = await post(TENANT, body());
  assert.equal(res.status, 403);
});

test("der Admin erreicht die Credential-Aufloesung weiterhin", async () => {
  const res = await post(ADMIN, body());
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.match(data.error, /No API key found for "probe"/);
});

test("`!`-Werte in Provider-Headern, apiKey und Modell-Headern werden abgelehnt", async () => {
  const marker = join(HOME_ROOT, "rce-marker");
  const command = `!touch ${marker}`;
  const cases = [
    ["provider header", body({ headers: { "X-Probe": command } })],
    ["provider apiKey", body({ apiKey: command })],
    ["model header", body({}, { headers: { "X-Probe": command } })],
  ];

  for (const [label, payload] of cases) {
    const res = await post(ADMIN, payload);
    assert.equal(res.status, 400, label);
    const data = await res.json();
    assert.match(data.error, /must not be a command value/, label);
    assert.equal(existsSync(marker), false, `${label} wurde als Kommando ausgefuehrt`);
  }
});
