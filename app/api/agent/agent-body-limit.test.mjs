import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * OMP-016: `/api/agent/[id]` bounded the body only through a declared
 * `Content-Length`. The identical 60-MB JSON sent with
 * `Transfer-Encoding: chunked` reached `req.json()` and was executed. Gemessen
 * wird am Route-Handler: ein unterbudgetierter Prompt kommt weiterhin an, ein
 * chunked Body ueber dem Deckel bekommt 413, bevor er geparst oder einem
 * Session-`send` uebergeben wird, und ein deklarierter Riesen-Body bleibt 413.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
});

process.env.OMP_WEB_HOME_ROOT = "/home";

const agentRoute = await jiti.import("./[id]/route.ts");
const { MAX_AGENT_REQUEST_BODY_BYTES } = await jiti.import("@/lib/request-body");

const ALICE = { host: "localhost", "x-omp-user": "alice", "content-type": "application/json" };
const idParams = (id) => ({ params: Promise.resolve({ id }) });

/**
 * Eine laufende Session von `alice`, deren `send` jeden Befehl mitschreibt.
 * `send` ist der Beweis: wenn die Route den Body parst und weiterreicht, steht
 * hier ein Eintrag — auch dann, wenn die Antwort am Ende 500 waere.
 */
function installLiveSession(t) {
  const previousSessions = globalThis.__ompSessions;
  const previousOwners = globalThis.__ompSessionOwners;
  const sent = [];
  globalThis.__ompSessions = new Map([["alice-live", {
    isAlive: () => true,
    isRunning: () => true,
    inner: { sessionManager: null },
    sessionFile: "/tmp/alice-live-not-persisted.jsonl",
    sessionId: "alice-live",
    cwd: "/tmp",
    send: async (command) => {
      sent.push(command?.type);
      return { ok: true };
    },
    shutdown: async () => {},
  }]]);
  globalThis.__ompSessionOwners = new Map([["alice-live", "alice"]]);

  t.after(() => {
    globalThis.__ompSessions = previousSessions;
    globalThis.__ompSessionOwners = previousOwners;
  });
  return sent;
}

/** One 4-MiB buffer, enqueued repeatedly: the fixture never holds a 60-MB body. */
function oversizedChunkedBody(totalBytes) {
  const chunk = new Uint8Array(4 * 1024 * 1024).fill(0x20);
  const state = { reads: 0 };
  const stream = new ReadableStream({
    pull(controller) {
      if (state.reads * chunk.byteLength >= totalBytes) {
        controller.close();
        return;
      }
      state.reads += 1;
      controller.enqueue(chunk);
    },
  });
  return { stream, state };
}

function post(id, headers, body) {
  return new Request(`http://localhost/api/agent/${id}`, { method: "POST", headers, body, duplex: "half" });
}

test("a body under the cap is still executed", async (t) => {
  const sent = installLiveSession(t);
  const response = await agentRoute.POST(
    post("alice-live", ALICE, JSON.stringify({ type: "prompt", text: "hallo" })),
    idParams("alice-live"),
  );

  assert.equal(response.status, 200, `erwartet 200, bekam ${response.status}`);
  assert.deepEqual(sent, ["prompt"]);
});

test("a chunked body over the cap gets 413 and is never executed", async (t) => {
  const sent = installLiveSession(t);
  const { stream } = oversizedChunkedBody(MAX_AGENT_REQUEST_BODY_BYTES + 1024 * 1024);
  const request = post("alice-live", ALICE, stream);
  assert.equal(request.headers.get("content-length"), null, "Fixture ist nicht chunked");

  const response = await agentRoute.POST(request, idParams("alice-live"));

  assert.equal(response.status, 413, `erwartet 413, bekam ${response.status}`);
  const payload = await response.json();
  assert.equal(payload.code, "prompt_rejected");
  assert.equal(payload.accepted, false);
  assert.match(payload.error, /too large/);
  assert.deepEqual(sent, [], "der ueberbudgetierte Body wurde geparst und gesendet");
});

test("a declared oversized body keeps its 413 without being read", async (t) => {
  const sent = installLiveSession(t);
  const { stream } = oversizedChunkedBody(64 * 1024);
  const request = new Request("http://localhost/api/agent/alice-live", {
    method: "POST",
    headers: { ...ALICE, "content-length": String(MAX_AGENT_REQUEST_BODY_BYTES + 1) },
    body: stream,
    duplex: "half",
  });

  const response = await agentRoute.POST(request, idParams("alice-live"));

  assert.equal(response.status, 413, `erwartet 413, bekam ${response.status}`);
  assert.equal((await response.json()).code, "prompt_rejected");
  assert.deepEqual(sent, []);
});
