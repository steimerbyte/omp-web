import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { root: process.cwd(), alias: { "@": process.cwd() } });

/**
 * `OMP_WEB_HOME_ROOT` entscheidet, wo `getUserHome()` nachsieht — dieselbe
 * Vorbemerkung wie in `lib/calendar-store.test.mjs` und
 * `app/api/calendar/calendar-routes.test.mjs`.
 */
const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-scheduled-api-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

// Der Zeitplaner wird hier nur gestartet, damit `rescheduleScheduler()` ein
// No-op ist; ein Test, der einen echten Timer stellt, wuerde die Testdatei am
// Beenden hindern.
const scheduler = await jiti.import("@/lib/scheduler.ts");

const route = await jiti.import("./route.ts");
const idRoute = await jiti.import("./[id]/route.ts");

/**
 * Die lebende Modellregistrierung wird ersetzt.
 *
 * Die Routen lesen sie aus `globalThis.__ompRuntimePromise` — genau wie
 * `app/api/host-wide-guards.test.mjs` es macht. Ohne Attrappe wuerde jeder
 * Test das echte `agent.db` des Prozesskontos oeffnen, und ob ein Modell
 * "bekannt" ist, haenge an der Maschine, auf der die Suite laeuft.
 */
const KNOWN = { provider: "buds-gateway", modelId: "qwen3.8-27b" };

function installFakeRuntime() {
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
}

installFakeRuntime();

const ANON = { host: "localhost" };

let accountCounter = 0;

/**
 * Ein eigenes Konto pro Test.
 *
 * Die Aufgaben liegen pro Konto in einer Datei; ein gemeinsames Konto wuerde
 * die Aufgaben der vorherigen Tests erben, und ein Test, der "die Liste ist
 * leer" behauptet, scheiterte an einem Bestand, den er selbst erzeugt hat.
 */
function createAccount(label) {
  const username = `${label}-${accountCounter++}`;
  mkdirSync(join(HOME_ROOT, username), { recursive: true });
  return { host: "localhost", "x-omp-user": username };
}

function post(url, headers, body) {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(url, headers) {
  return new Request(`http://localhost${url}`, { headers });
}

function patch(url, headers, body) {
  return new Request(`http://localhost${url}`, {
    method: "PATCH",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function del(url, headers) {
  return new Request(`http://localhost${url}`, { method: "DELETE", headers });
}

const idParams = (id) => ({ params: Promise.resolve({ id }) });

function taskInput(overrides = {}) {
  return {
    name: "Nachtlauf",
    cron: "0 3 * * *",
    prompt: "Fasse die offenen Punkte zusammen.",
    ...KNOWN,
    ...overrides,
  };
}

async function createTask(headers, overrides = {}) {
  const response = await route.POST(post("/api/scheduled-tasks", headers, taskInput(overrides)));
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.task;
}

// --- Guards ---------------------------------------------------------------------

test("a request without an identity is refused with 401", async () => {
  const response = await route.GET(get("/api/scheduled-tasks", ANON));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "Authentication is required.");
});

test("creating without an identity is refused with 401 and writes nothing", async () => {
  const response = await route.POST(post("/api/scheduled-tasks", ANON, taskInput()));
  assert.equal(response.status, 401);
});

test("a mutation without an identity is refused with 401", async () => {
  assert.equal((await idRoute.PATCH(patch("/api/scheduled-tasks/x", ANON, { name: "x" }), idParams("x"))).status, 401);
  assert.equal((await idRoute.DELETE(del("/api/scheduled-tasks/x", ANON), idParams("x"))).status, 401);
});

test("a request from another origin is refused with 403", async () => {
  const headers = { ...createAccount("fremd"), host: "evil.example" };
  const response = await route.GET(get("/api/scheduled-tasks", headers));
  assert.equal(response.status, 403);
});

// --- Round trip -----------------------------------------------------------------

test("create, list, update and delete round-trip through the routes", async () => {
  const headers = createAccount("runde");

  const created = await createTask(headers);
  assert.equal(created.name, "Nachtlauf");
  assert.equal(created.enabled, true);
  assert.ok(created.nextRun > Date.now(), "nextRun is in the future");

  const listResponse = await route.GET(get("/api/scheduled-tasks", headers));
  assert.equal(listResponse.status, 200);
  const { tasks } = await listResponse.json();
  assert.deepEqual(tasks.map((task) => task.id), [created.id]);
  assert.equal(tasks[0].nextRun, created.nextRun);

  const updateResponse = await idRoute.PATCH(
    patch(`/api/scheduled-tasks/${created.id}`, headers, { name: "Mittagslauf", enabled: false }),
    idParams(created.id),
  );
  assert.equal(updateResponse.status, 200);
  const updated = (await updateResponse.json()).task;
  assert.equal(updated.name, "Mittagslauf");
  assert.equal(updated.enabled, false);
  // Eine deaktivierte Aufgabe hat keinen naechsten Lauf.
  assert.equal(updated.nextRun, null);

  const deleteResponse = await idRoute.DELETE(del(`/api/scheduled-tasks/${created.id}`, headers), idParams(created.id));
  assert.equal(deleteResponse.status, 200);
  assert.equal((await route.GET(get("/api/scheduled-tasks", headers))).status, 200);
  assert.deepEqual((await (await route.GET(get("/api/scheduled-tasks", headers))).json()).tasks, []);
});

test("two accounts do not see each other's tasks", async () => {
  const alice = createAccount("alice");
  const bob = createAccount("bob");
  await createTask(alice);

  assert.deepEqual((await (await route.GET(get("/api/scheduled-tasks", bob))).json()).tasks, []);
  assert.equal((await (await route.GET(get("/api/scheduled-tasks", alice))).json()).tasks.length, 1);
});

test("a task of another identity is a 404, not a 403", async () => {
  const alice = createAccount("alice2");
  const bob = createAccount("bob2");
  const task = await createTask(alice);

  const foreignPatch = await idRoute.PATCH(
    patch(`/api/scheduled-tasks/${task.id}`, bob, { name: "Gekapert" }),
    idParams(task.id),
  );
  assert.equal(foreignPatch.status, 404);
  const foreignDelete = await idRoute.DELETE(del(`/api/scheduled-tasks/${task.id}`, bob), idParams(task.id));
  assert.equal(foreignDelete.status, 404);

  // Und die Aufgabe ist unveraendert: 404 heisst hier auch "nichts passiert".
  const still = (await (await route.GET(get("/api/scheduled-tasks", alice))).json()).tasks[0];
  assert.equal(still.name, "Nachtlauf");
});

// --- Validierung ----------------------------------------------------------------

test("a bad cron is a 400 that names field and token", async () => {
  const headers = createAccount("cron");
  const response = await route.POST(post("/api/scheduled-tasks", headers, taskInput({ cron: "0 8 L * *" })));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.field, "dayOfMonth");
  assert.equal(body.token, "L");
  assert.match(body.error, /dayOfMonth/);

  // Nichts wurde geschrieben: eine abgelehnte Aufgabe hinterlaesst keinen Rest.
  assert.deepEqual((await (await route.GET(get("/api/scheduled-tasks", headers))).json()).tasks, []);
});

test("a five-field expression is required, a sixth field is a 400", async () => {
  const headers = createAccount("felder");
  const response = await route.POST(post("/api/scheduled-tasks", headers, taskInput({ cron: "0 0 8 * * *" })));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Expected 5 cron fields/);
});

test("an unknown model pair is a 400 with a clear message", async () => {
  const headers = createAccount("modell");
  const response = await route.POST(post("/api/scheduled-tasks", headers, taskInput({ modelId: "gibt-es-nicht" })));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.field, "modelId");
  assert.match(body.error, /Unknown model buds-gateway\/gibt-es-nicht/);
});

test("an unknown model pair in a patch is a 400 and changes nothing", async () => {
  const headers = createAccount("modell2");
  const task = await createTask(headers);
  const response = await idRoute.PATCH(
    patch(`/api/scheduled-tasks/${task.id}`, headers, { provider: "fremd" }),
    idParams(task.id),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).field, "modelId");
  const still = (await (await route.GET(get("/api/scheduled-tasks", headers))).json()).tasks[0];
  assert.equal(still.provider, KNOWN.provider);
});

test("an empty name or prompt is a 400", async () => {
  const headers = createAccount("leer");
  assert.equal((await route.POST(post("/api/scheduled-tasks", headers, taskInput({ name: "  " })))).status, 400);
  assert.equal((await route.POST(post("/api/scheduled-tasks", headers, taskInput({ prompt: "" })))).status, 400);
});

test("a non-boolean enabled is a 400, not a silent coercion", async () => {
  const headers = createAccount("schalter");
  const response = await route.POST(post("/api/scheduled-tasks", headers, taskInput({ enabled: "false" })));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).field, "enabled");
});

test("a missing JSON content type is a 415", async () => {
  const headers = createAccount("typ");
  const response = await route.POST(new Request("http://localhost/api/scheduled-tasks", {
    method: "POST",
    headers,
    body: JSON.stringify(taskInput()),
  }));
  assert.equal(response.status, 415);
});

test("an unknown id answers 404 for both PATCH and DELETE", async () => {
  const headers = createAccount("fehlt");
  const missing = "00000000-0000-4000-8000-000000000000";
  assert.equal((await idRoute.PATCH(patch(`/api/scheduled-tasks/${missing}`, headers, { name: "x" }), idParams(missing))).status, 404);
  assert.equal((await idRoute.DELETE(del(`/api/scheduled-tasks/${missing}`, headers), idParams(missing))).status, 404);
});

test("a task cwd outside the account home is a 400", async () => {
  const headers = createAccount("cwd");
  const response = await route.POST(post("/api/scheduled-tasks", headers, taskInput({ cwd: "/etc" })));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).field, "cwd");
});

test("a task cwd inside the account home is stored", async () => {
  const headers = createAccount("cwd2");
  const workspace = join(HOME_ROOT, headers["x-omp-user"], "workspace");
  // Der Ordner muss existieren: `assertUsableCwd` prueft, dass der Lauf
  // tatsaechlich irgendwo starten kann, und nicht nur, wie der Pfad aussieht.
  mkdirSync(workspace, { recursive: true });
  const created = await createTask(headers, { cwd: workspace });
  assert.equal(created.cwd, workspace);
});

// Der Zeitplaner bleibt angehalten: diese Datei testet Antworten, nicht Timer.
test.after(() => {
  scheduler.stopScheduler();
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

// --- Jetzt ausfuehren ------------------------------------------------------------

const runRoute = await jiti.import("./[id]/run/route.ts");

/**
 * Der Start wird ersetzt — ueber den Parameter von `runTaskNow`, nicht ueber
 * `mock.module`.
 *
 * Ein Modul-Mock ist prozessweit und nicht rueckgaengig zu machen; er hat
 * sieben fremde Testdateien rot gemacht, die `@/lib/session-reader` oder den
 * Session-Start spaeter selbst importieren. Die Route bekommt den Ersatz
 * deshalb durchgereicht: `runTaskNow` nimmt ihn als dritten Parameter.
 */
let runCalls = 0;
let runFailure = null;

async function fakeStarter() {
  runCalls += 1;
  if (runFailure) throw runFailure;
  return { session: { send: async () => {} }, realSessionId: "sitzung-1" };
}

/** Die Route mit dem Ersatz-Start; der Handler selbst bleibt unveraendert. */
function postRun(id, headers) {
  return runRoute.POST(runRequest(`/api/scheduled-tasks/${id}/run`, headers), idParams(id), fakeStarter);
}

function runRequest(url, headers) {
  return new Request(`http://localhost${url}`, { method: "POST", headers });
}

test("running without an identity is refused with 401 and starts nothing", async () => {
  runCalls = 0;
  const response = await postRun("x", ANON);
  assert.equal(response.status, 401);
  assert.equal(runCalls, 0);
});

test("running from another origin is refused with 403 and starts nothing", async () => {
  runCalls = 0;
  const headers = { ...createAccount("run-fremd"), host: "evil.example" };
  const response = await postRun("x", headers);
  assert.equal(response.status, 403);
  assert.equal(runCalls, 0);
});

test("running an unknown id is a 404 and starts nothing", async () => {
  runCalls = 0;
  const headers = createAccount("run-fehlt");
  const missing = "00000000-0000-4000-8000-000000000000";
  const response = await postRun(missing, headers);
  assert.equal(response.status, 404);
  assert.equal(runCalls, 0);
});

test("running a task of another identity is a 404 with no side effect", async () => {
  runCalls = 0;
  const alice = createAccount("run-alice");
  const bob = createAccount("run-bob");
  const task = await createTask(alice);

  const response = await postRun(task.id, bob);
  // 404, nicht 403: die Aufgabe existiert in Bobs Datei nicht.
  assert.equal(response.status, 404);
  assert.equal(runCalls, 0);

  // Und bei Alice ist nichts passiert.
  const still = (await (await route.GET(get("/api/scheduled-tasks", alice))).json()).tasks[0];
  assert.equal(still.lastRunAt, undefined);
  assert.equal(still.lastRunSessionId, undefined);
});

test("a manual run answers with the session id and records the run", async () => {
  runCalls = 0;
  const headers = createAccount("run-ok");
  const task = await createTask(headers);

  const response = await postRun(task.id, headers);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sessionId: "sitzung-1" });
  assert.equal(runCalls, 1);

  const stored = (await (await route.GET(get("/api/scheduled-tasks", headers))).json()).tasks[0];
  assert.equal(stored.lastRunSessionId, "sitzung-1");
  assert.equal(stored.lastRunStatus, "ok");
  assert.ok(stored.lastRunAt, "lastRunAt fehlt");
});

test("a disabled task can be run manually and stays disabled", async () => {
  runCalls = 0;
  const headers = createAccount("run-aus");
  const task = await createTask(headers, { enabled: false });

  const response = await postRun(task.id, headers);
  assert.equal(response.status, 200);
  assert.equal(runCalls, 1);

  const stored = (await (await route.GET(get("/api/scheduled-tasks", headers))).json()).tasks[0];
  assert.equal(stored.enabled, false);
  assert.equal(stored.lastRunStatus, "ok");
  // Ein Handstart setzt keinen Slot: die Aufgabe bleibt ohne naechsten Lauf,
  // weil sie deaktiviert ist — aber sie wurde auch nicht eingeschaltet.
  assert.equal(stored.nextRun, null);
});

test("a failing start is a 500 and records the error", async () => {
  runCalls = 0;
  runFailure = new Error("Model is not available in the enabled scope: buds-gateway/gibt-es-nicht");
  const headers = createAccount("run-fehler");
  try {
    const task = await createTask(headers);
    const response = await postRun(task.id, headers);
    assert.equal(response.status, 500);

    const stored = (await (await route.GET(get("/api/scheduled-tasks", headers))).json()).tasks[0];
    assert.equal(stored.lastRunStatus, "error");
    assert.equal(stored.lastRunSessionId, undefined);
  } finally {
    runFailure = null;
  }
});
