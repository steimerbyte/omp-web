import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { root: process.cwd(), alias: { "@": process.cwd() } });

/**
 * `OMP_WEB_HOME_ROOT` entscheidet, wo `getUserHome()` nachsieht — dieselbe
 * Vorbemerkung wie in `app/api/scheduled-tasks/route.test.mjs`. Die Dateien
 * landen damit in einem Temp-Baum und nicht in der Home des Testkontos.
 */
const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-newsletters-api-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

// Der Zeitplaner wird angehalten, damit `rescheduleScheduler()` ein No-op ist
// und kein echter Timer die Testdatei am Beenden haelt.
const scheduler = await jiti.import("@/lib/scheduler.ts");
scheduler.stopScheduler();

const route = await jiti.import("./route.ts");
const { getTask, listTasks } = await jiti.import("@/lib/scheduled-tasks-store.ts");
const { readNewsletterFile } = await jiti.import("@/lib/newsletter-store.ts");

/**
 * Die lebende Modellregistrierung wird ersetzt: ohne Attrappe haenge "bekannt"
 * an der Maschine, auf der die Suite laeuft — dieselbe Begruendung wie in
 * `app/api/scheduled-tasks/route.test.mjs`.
 */
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

let accountCounter = 0;

/** Ein eigenes Konto pro Test. */
function createAccount(label) {
  const username = `${label}-${accountCounter++}`;
  mkdirSync(join(HOME_ROOT, username), { recursive: true });
  return { host: "localhost", "x-omp-user": username, username, isAdmin: false };
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

function newsletterInput(overrides = {}) {
  return {
    name: "Wochenblick",
    topics: ["KI-Regulierung", "Klimapolitik"],
    cron: "0 3 * * *",
    ...KNOWN,
    ...overrides,
  };
}

async function createNewsletter(headers, overrides = {}) {
  const response = await route.POST(post("/api/newsletters", headers, newsletterInput(overrides)));
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.newsletter;
}

// --- Guards ---------------------------------------------------------------------

test("a request without an identity is refused with 401", async () => {
  const response = await route.GET(get("/api/newsletters", ANON));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "Authentication is required.");
});

test("creating without an identity is refused with 401 and writes nothing", async () => {
  const response = await route.POST(post("/api/newsletters", ANON, newsletterInput()));
  assert.equal(response.status, 401);
  assert.deepEqual(readNewsletterFile({ username: "niemand", isAdmin: false }).newsletters, []);
});

test("a request from another origin is refused with 403", async () => {
  const headers = { ...createAccount("fremd"), host: "evil.example" };
  assert.equal((await route.GET(get("/api/newsletters", headers))).status, 403);
  assert.equal((await route.POST(post("/api/newsletters", headers, newsletterInput()))).status, 403);
});

test("a write without the JSON content type is a 415", async () => {
  const headers = createAccount("inhalt");
  const response = await route.POST(new Request("http://localhost/api/newsletters", {
    method: "POST",
    headers,
    body: "name=Wochenblick",
  }));
  assert.equal(response.status, 415);
});

// --- Anlegen und Lesen ----------------------------------------------------------

test("a created newsletter carries a task, a schedule and no issue yet", async () => {
  const headers = createAccount("anlegen");
  const newsletter = await createNewsletter(headers);

  assert.equal(newsletter.name, "Wochenblick");
  assert.deepEqual(newsletter.topics, ["KI-Regulierung", "Klimapolitik"]);
  assert.deepEqual(newsletter.issues, []);
  assert.equal(newsletter.schedule.cron, "0 3 * * *");
  assert.equal(newsletter.schedule.enabled, true);
  assert.ok(newsletter.schedule.nextRun > Date.now(), "nextRun is in the future");
  assert.equal(newsletter.schedule.lastRunAt, null);
  assert.equal(newsletter.schedule.lastRunStatus, null);
  // Ohne eigene Wahl gibt es keinen Ordner: der Kontostandard gilt.
  assert.equal(newsletter.schedule.cwd, null);

  const task = getTask(headers, newsletter.taskId);
  assert.ok(task, "the scheduled task exists");
  assert.equal(task.name, "Wochenblick");
  // Der Prompt traegt die Kennung, mit der das Werkzeug die Ausgabe ablegt.
  assert.equal(task.prompt.split(newsletter.id).length - 1, 1);
  assert.match(task.prompt, /KI-Regulierung/);
});

test("a chosen working folder lands on the task and in schedule.cwd", async () => {
  const headers = createAccount("ordner");
  const folder = join(HOME_ROOT, headers.username, "projekt");
  mkdirSync(folder, { recursive: true });

  const newsletter = await createNewsletter(headers, { cwd: folder });

  assert.equal(newsletter.schedule.cwd, folder);
  assert.equal(getTask(headers, newsletter.taskId).cwd, folder);
});

test("a working folder outside the home is a 400 that names the field", async () => {
  const headers = createAccount("aussen");
  const outside = mkdtempSync(join(tmpdir(), "omp-web-newsletters-outside-"));
  try {
    const response = await route.POST(post("/api/newsletters", headers, newsletterInput({ cwd: outside })));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).field, "cwd");
    // Die Pruefung steht vor `createTask`: weder Datensatz noch Aufgabe.
    assert.deepEqual(readNewsletterFile(headers).newsletters, []);
    assert.deepEqual(listTasks(headers), []);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("the list returns the newsletter once", async () => {
  const headers = createAccount("liste");
  const created = await createNewsletter(headers);

  const response = await route.GET(get("/api/newsletters", headers));
  assert.equal(response.status, 200);
  const { newsletters } = await response.json();
  assert.deepEqual(newsletters.map((entry) => entry.id), [created.id]);
  assert.equal(newsletters[0].schedule.nextRun, created.schedule.nextRun);
  // Der Client braucht den Cron, sonst kann er den Zeitplan nicht bearbeiten.
  assert.equal(newsletters[0].schedule.cron, "0 3 * * *");
});

test("two accounts do not see each other's newsletters", async () => {
  const alice = createAccount("alice");
  const bob = createAccount("bob");
  await createNewsletter(alice);

  assert.deepEqual((await (await route.GET(get("/api/newsletters", bob))).json()).newsletters, []);
  assert.equal((await (await route.GET(get("/api/newsletters", alice))).json()).newsletters.length, 1);
});

// --- Validierung ----------------------------------------------------------------

test("an empty name is a 400 that names the field", async () => {
  const response = await route.POST(post("/api/newsletters", createAccount("name"), newsletterInput({ name: "  " })));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).field, "name");
});

test("a name over the limit is a 400, not a silent truncation", async () => {
  const response = await route.POST(post("/api/newsletters", createAccount("lang"), newsletterInput({ name: "x".repeat(101) })));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).field, "name");
});

test("missing topics are a 400 that names the field", async () => {
  const response = await route.POST(post("/api/newsletters", createAccount("themen"), newsletterInput({ topics: [] })));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).field, "topics");
});

test("an unknown model is a 400 with a clear field", async () => {
  const headers = createAccount("modell");
  const response = await route.POST(post("/api/newsletters", headers, newsletterInput({ modelId: "gibt-es-nicht" })));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).field, "modelId");
  // Die Aufgabe ist an der Pruefung gescheitert, der Datensatz darf nicht da sein.
  assert.deepEqual(readNewsletterFile(headers).newsletters, []);
});

test("a bad cron is a 400 that names field and token", async () => {
  const response = await route.POST(post("/api/newsletters", createAccount("cron"), newsletterInput({ cron: "0 3 * *" })));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.field, "expression");
  assert.equal(body.token, "0 3 * *");
});

test("a body that is not an object is a 400", async () => {
  const response = await route.POST(post("/api/newsletters", createAccount("koerper"), []));
  assert.equal(response.status, 400);
});

test.after(() => {
  globalThis.__ompRuntimePromise = previousRuntime;
  rmSync(HOME_ROOT, { recursive: true, force: true });
});
