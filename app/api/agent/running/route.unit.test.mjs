import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `GET /api/agent/running` — Momentaufnahme der laufenden Session-Ids.
 *
 * Die Ids sind dieselbe Grenze wie in `/api/sessions`: ohne Identitaet gibt es
 * keine Liste (eine leere Liste saehe aus wie "nichts laeuft"), und ein Mandant
 * sieht nur seine eigenen Sessions. Der Bestand wird ueber die Registry in
 * `globalThis` gestellt, wie in `app/api/sessions/runtime-route.test.mjs`.
 */

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { GET } = await jiti.import("./route.ts");

const ALICE = { host: "localhost", "x-omp-user": "alice" };
const ADMIN = { host: "localhost", "x-omp-user": "pi", "x-omp-admin": "1" };
const ANON = { host: "localhost" };

function session(id, owner, running) {
  return {
    sessionId: id,
    isRunning: () => running,
    isAlive: () => true,
    inner: { sessionManager: null },
    sessionFile: `/tmp/${id}.jsonl`,
    cwd: "/tmp",
    shutdown: async () => {},
  };
}

function installRegistry(t) {
  const previousSessions = globalThis.__ompSessions;
  const previousOwners = globalThis.__ompSessionOwners;
  globalThis.__ompSessions = new Map([
    ["alice-running", session("alice-running", "alice", true)],
    ["alice-idle", session("alice-idle", "alice", false)],
    ["bob-running", session("bob-running", "bob", true)],
  ]);
  globalThis.__ompSessionOwners = new Map([
    ["alice-running", "alice"],
    ["alice-idle", "alice"],
    ["bob-running", "bob"],
  ]);
  t.after(() => {
    globalThis.__ompSessions = previousSessions;
    globalThis.__ompSessionOwners = previousOwners;
  });
}

function request(headers) {
  return new Request("http://localhost/api/agent/running", { headers });
}

test("ohne Identitaet gibt es keine Liste", async () => {
  const res = await GET(request(ANON));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Unknown user" });
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("ein Mandant sieht nur seine laufenden Sessions", async (t) => {
  installRegistry(t);
  const res = await GET(request(ALICE));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { runningSessionIds: ["alice-running"] });
});

test("der Admin sieht alle laufenden Sessions", async (t) => {
  installRegistry(t);
  const res = await GET(request(ADMIN));
  assert.equal(res.status, 200);
  const { runningSessionIds } = await res.json();
  assert.deepEqual([...runningSessionIds].sort(), ["alice-running", "bob-running"]);
});

test("eine leere Registry liefert eine leere Liste, keinen Fehler", async (t) => {
  const previousSessions = globalThis.__ompSessions;
  const previousOwners = globalThis.__ompSessionOwners;
  globalThis.__ompSessions = new Map();
  globalThis.__ompSessionOwners = new Map();
  t.after(() => {
    globalThis.__ompSessions = previousSessions;
    globalThis.__ompSessionOwners = previousOwners;
  });

  const res = await GET(request(ALICE));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { runningSessionIds: [] });
});
