import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The two paths of `POST /api/models-config/test` that had no test: a provider
 * that *answers* (so `getAssistantText` runs) and a provider that *throws* (so
 * `errorMessage` runs).
 *
 * Both need a real `completeSimple` round trip. The upstream is a loopback
 * server that speaks the OpenAI streaming protocol — 127.0.0.1 only, no network,
 * and the response is what the SDK's parser sees.
 *
 * The guard cases (tenant 403, `!`-values, 415) already live in route.test.mjs;
 * this file is about the response handling behind the guard.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-model-probe-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;
const AGENT_DIR = join(HOME_ROOT, "agent");
mkdirSync(AGENT_DIR, { recursive: true });

const route = await jiti.import("./route.ts");
const sdk = await jiti.import("@oh-my-pi/pi-coding-agent");

const authStorage = await sdk.discoverAuthStorage(AGENT_DIR);
const previousRuntime = globalThis.__ompRuntimePromise;
globalThis.__ompRuntimePromise = Promise.resolve({
  agentDir: AGENT_DIR,
  authStorage,
  settings: { getCwd: () => undefined },
  modelRegistry: { getAvailable: () => [], getAll: () => [], getError: () => undefined },
});

const ADMIN = { host: "localhost:30141", "x-omp-user": "probe-admin", "x-omp-admin": "1" };

const sse = (delta, finish) =>
  `data: ${JSON.stringify({
    id: "probe",
    object: "chat.completion.chunk",
    created: 1,
    model: "probe-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch() {
    return new Response(
      sse({ role: "assistant", content: "OK" }, null) + sse({}, "stop") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});

function post(headers, body) {
  return route.POST(
    new Request("http://localhost:30141/api/models-config/test", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function body(baseUrl) {
  return {
    providerName: "probe",
    provider: { baseUrl, api: "openai-completions", apiKey: "test-key", auth: "apiKey" },
    model: { id: "probe-model" },
  };
}

test.after(() => {
  server.stop(true);
  if (previousRuntime === undefined) delete globalThis.__ompRuntimePromise;
  else globalThis.__ompRuntimePromise = previousRuntime;
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

test("eine antwortende Gegenstelle liefert ok mit Antworttext", async () => {
  const response = await post(ADMIN, body(`http://127.0.0.1:${server.port}/v1`));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.responseText, "OK");
  // `onResponse` reports the upstream status the probe saw.
  assert.equal(data.status, 200);
  assert.equal(typeof data.latencyMs, "number");
});

test("ein Fehler im try-Zweig endet als 500 mit der Meldung, nicht als leerer Erfolg", async () => {
  // `mkdtempSync` runs inside the handler's try; an unusable TMPDIR makes it
  // throw, which is exactly the `catch` that `errorMessage()` serves. The
  // upstream server is never contacted.
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = join(HOME_ROOT, "does-not-exist");
  try {
    const response = await post(ADMIN, body(`http://127.0.0.1:${server.port}/v1`));
    assert.equal(response.status, 500);
    const data = await response.json();
    assert.equal(data.ok, false);
    assert.match(data.error, /ENOENT|no such file/i);
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
  }
});
