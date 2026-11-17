import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { root: process.cwd(), alias: { "@": process.cwd() } });

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-newsletter-run-api-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const scheduler = await jiti.import("@/lib/scheduler.ts");
scheduler.stopScheduler();

const listRoute = await jiti.import("../../route.ts");
const route = await jiti.import("./route.ts");
const { deleteTask, getTask } = await jiti.import("@/lib/scheduled-tasks-store.ts");

const KNOWN = { provider: "buds-gateway", modelId: "qwen3.8-27b" };
const previousRuntime = globalThis.__ompRuntimePromise;
globalThis.__ompRuntimePromise = Promise.resolve({
  agentDir: "/nonexistent/omp-web-test",
  settings: { getCwd: () => "/nonexistent" },
  modelRegistry: {
    find: (provider, modelId) => (provider === KNOWN.provider && modelId === KNOWN.modelId
      ? { provider, id: modelId }
      : undefined),
    getAvailable: () => [],
  },
  authStorage: { keys: { source: () => undefined, keyless: () => false }, credentials: { list: () => [] } },
});

const ANON = { host: "localhost" };
const idParams = (id) => ({ params: Promise.resolve({ id }) });

let accountCounter = 0;

function createAccount(label) {
  const username = `${label}-${accountCounter++}`;
  mkdirSync(join(HOME_ROOT, username), { recursive: true });
  return { host: "localhost", "x-omp-user": username, username, isAdmin: false };
}

async function createNewsletter(headers) {
  const response = await listRoute.POST(new Request("http://localhost/api/newsletters", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      name: "Wochenblick",
      topics: ["KI-Regulierung"],
      cron: "0 3 * * *",
      ...KNOWN,
    }),
  }));
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.newsletter;
}

/**
 * Der Start wird ersetzt — ueber den Parameter von `runTaskNow`, nicht ueber
 * `mock.module`. Die Begruendung steht in
 * `app/api/scheduled-tasks/route.test.mjs`.
 */
let runCalls = 0;
let runFailure = null;

async function fakeStarter() {
  runCalls += 1;
  if (runFailure) throw runFailure;
  return { session: { send: async () => {} }, realSessionId: "sitzung-1" };
}

function postRun(id, headers) {
  return route.POST(
    new Request(`http://localhost/api/newsletters/${id}/run`, { method: "POST", headers }),
    idParams(id),
    fakeStarter,
  );
}

// --- Guards ---------------------------------------------------------------------

test("running without an identity is refused with 401 and starts nothing", async () => {
  runCalls = 0;
  assert.equal((await postRun("x", ANON)).status, 401);
  assert.equal(runCalls, 0);
});

test("running from another origin is refused with 403 and starts nothing", async () => {
  runCalls = 0;
  const headers = { ...createAccount("run-fremd"), host: "evil.example" };
  assert.equal((await postRun("x", headers)).status, 403);
  assert.equal(runCalls, 0);
});

test("running an unknown id is a 404 and starts nothing", async () => {
  runCalls = 0;
  assert.equal((await postRun("fehlt", createAccount("run-unbekannt"))).status, 404);
  assert.equal(runCalls, 0);
});

test("a newsletter whose task is gone cannot be run", async () => {
  runCalls = 0;
  const headers = createAccount("run-ohne-aufgabe");
  const newsletter = await createNewsletter(headers);
  deleteTask(headers, newsletter.taskId);

  assert.equal((await postRun(newsletter.id, headers)).status, 404);
  assert.equal(runCalls, 0);
});

// --- Der Lauf -------------------------------------------------------------------

test("a manual run answers with the session id and records it on the task", async () => {
  runCalls = 0;
  runFailure = null;
  const headers = createAccount("run-erfolg");
  const newsletter = await createNewsletter(headers);

  const response = await postRun(newsletter.id, headers);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sessionId: "sitzung-1" });
  assert.equal(runCalls, 1);

  const task = getTask(headers, newsletter.taskId);
  assert.equal(task.lastRunStatus, "ok");
  assert.equal(task.lastRunSessionId, "sitzung-1");
  assert.equal(typeof task.lastRunAt, "string");
});

test("a failing start is a 500 and records the error", async () => {
  runCalls = 0;
  runFailure = new Error("kein Modell");
  try {
    const headers = createAccount("run-fehler");
    const newsletter = await createNewsletter(headers);

    const response = await postRun(newsletter.id, headers);
    assert.equal(response.status, 500);
    assert.equal(runCalls, 1);
    assert.equal(getTask(headers, newsletter.taskId).lastRunStatus, "error");
  } finally {
    runFailure = null;
  }
});

test.after(() => {
  globalThis.__ompRuntimePromise = previousRuntime;
  rmSync(HOME_ROOT, { recursive: true, force: true });
});
