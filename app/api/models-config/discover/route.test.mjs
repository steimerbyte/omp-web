import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Die Grenze von `POST /api/models-config/discover`.
 *
 * Beide Befunde, die diese Datei festnagelt, sind gemessen:
 * `!`-praefixierte Header aus dem Request-Body liefen durch die SDK-Resolver
 * in `/bin/sh -c`, und der prozessweite Key des Betreibers ging an die vom
 * Aufrufer gewaehlte `baseUrl`. Der Fix ist die Rollenpruefung: die Route
 * gibt den Key des Prozesskontos aus, also darf sie nur der Admin benutzen.
 *
 * Die Teste rufen die Route auf und beobachten zwei Dinge: die Antwort und
 * den `fetch`. Ein "403, aber der Request ging raus"-Fehler waere genau die
 * Variante, die eine reine Statuspruefung nicht sieht.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-model-discover-"));
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
const ANON = { host: "localhost" };

function post(headers, body) {
  return route.POST(new Request("http://localhost/api/models-config/discover", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

/** Stubbt `fetch` und gibt die Aufrufe zurueck; der echte Fetch kommt zurueck. */
function stubFetch(reply) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return reply();
  };
  return {
    calls,
    restore() { globalThis.fetch = realFetch; },
  };
}

test.after(() => {
  if (previousRuntime === undefined) delete globalThis.__ompRuntimePromise;
  else globalThis.__ompRuntimePromise = previousRuntime;
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

test("ein Mandant bekommt 403 und keine Anfrage an seine baseUrl", async () => {
  const stub = stubFetch(() => new Response("{}", { status: 200 }));
  try {
    const res = await post(TENANT, {
      providerName: "probe",
      provider: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions" },
    });
    assert.equal(res.status, 403);
    assert.equal(stub.calls.length, 0, "die Route hat die fremde baseUrl angesprochen");
  } finally {
    stub.restore();
  }
});

test("ein Aufruf ohne Identitaet bekommt 403", async () => {
  const stub = stubFetch(() => new Response("{}", { status: 200 }));
  try {
    const res = await post(ANON, {
      providerName: "probe",
      provider: { baseUrl: "https://models.example/v1", api: "openai-completions" },
    });
    assert.equal(res.status, 403);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("ein `!`-Header eines Mandanten wird nicht ausgefuehrt", async () => {
  const marker = join(HOME_ROOT, "tenant-rce-marker");
  const stub = stubFetch(() => new Response("{}", { status: 200 }));
  try {
    const res = await post(TENANT, {
      providerName: "probe",
      provider: {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        headers: { "X-Probe": `!touch ${marker}` },
      },
    });
    assert.equal(res.status, 403);
    assert.equal(stub.calls.length, 0);
    assert.equal(existsSync(marker), false, "der Header wurde als Kommando ausgefuehrt");
  } finally {
    stub.restore();
  }
});

test("ein `!`-Header oder `!`-apiKey wird auch fuer den Admin abgelehnt", async () => {
  const marker = join(HOME_ROOT, "admin-rce-marker");
  const command = `!touch ${marker}`;
  const stub = stubFetch(() => new Response("{}", { status: 200 }));
  try {
    const cases = [
      ["header", { baseUrl: "https://models.example/v1", api: "openai-completions", headers: { "X-Probe": command } }],
      ["apiKey", { baseUrl: "https://models.example/v1", api: "openai-completions", apiKey: command }],
    ];
    for (const [label, provider] of cases) {
      const res = await post(ADMIN, { providerName: "probe", provider });
      assert.equal(res.status, 400, label);
      const data = await res.json();
      assert.match(data.error, /must not be a command value/, label);
    }
    assert.equal(stub.calls.length, 0);
    assert.equal(existsSync(marker), false, "ein Wert wurde als Kommando ausgefuehrt");
  } finally {
    stub.restore();
  }
});

test("der Admin bekommt weiterhin Modelle und der Request traegt seinen Key", async () => {
  const stub = stubFetch(() => new Response(JSON.stringify({
    data: [{ id: "probe-model", name: "Probe Model" }],
  }), { status: 200, headers: { "content-type": "application/json" } }));
  try {
    const res = await post(ADMIN, {
      providerName: "probe",
      provider: {
        baseUrl: "https://models.example/v1",
        api: "openai-completions",
        apiKey: "sk-own-key",
      },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.models, [{ id: "probe-model", name: "Probe Model" }]);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, "https://models.example/v1/models");
    assert.equal(stub.calls[0].headers.get("authorization"), "Bearer sk-own-key");
  } finally {
    stub.restore();
  }
});
