import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { root: process.cwd(), alias: { "@": process.cwd() } });

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-newsletter-id-api-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const scheduler = await jiti.import("@/lib/scheduler.ts");
scheduler.stopScheduler();

const listRoute = await jiti.import("../route.ts");
const route = await jiti.import("./route.ts");
const { deleteTask, getTask } = await jiti.import("@/lib/scheduled-tasks-store.ts");
const { readNewsletterFile } = await jiti.import("@/lib/newsletter-store.ts");

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

function request(method, url, headers, body) {
  return new Request(`http://localhost${url}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createNewsletter(headers, overrides = {}) {
  const response = await listRoute.POST(request("POST", "/api/newsletters", headers, {
    name: "Wochenblick",
    topics: ["KI-Regulierung", "Klimapolitik"],
    cron: "0 3 * * *",
    ...KNOWN,
    ...overrides,
  }));
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.newsletter;
}

// --- Guards ---------------------------------------------------------------------

test("changing or deleting without an identity is refused with 401", async () => {
  assert.equal((await route.PATCH(request("PATCH", "/api/newsletters/x", ANON, { name: "x" }), idParams("x"))).status, 401);
  assert.equal((await route.DELETE(request("DELETE", "/api/newsletters/x", ANON), idParams("x"))).status, 401);
});

test("a request from another origin is refused with 403", async () => {
  const headers = createAccount("fremd");
  const newsletter = await createNewsletter(headers);
  const evil = { ...headers, host: "evil.example" };
  assert.equal((await route.PATCH(request("PATCH", `/api/newsletters/${newsletter.id}`, evil, { name: "x" }), idParams(newsletter.id))).status, 403);
  assert.equal((await route.DELETE(request("DELETE", `/api/newsletters/${newsletter.id}`, evil), idParams(newsletter.id))).status, 403);
});

test("a patch without the JSON content type is a 415", async () => {
  const headers = createAccount("inhalt");
  const newsletter = await createNewsletter(headers);
  const response = await route.PATCH(
    new Request(`http://localhost/api/newsletters/${newsletter.id}`, { method: "PATCH", headers, body: "name=neu" }),
    idParams(newsletter.id),
  );
  assert.equal(response.status, 415);
});

// --- Aendern --------------------------------------------------------------------

test("a patch renames the record and the scheduled task together", async () => {
  const headers = createAccount("umbenennen");
  const newsletter = await createNewsletter(headers);

  const response = await route.PATCH(
    request("PATCH", `/api/newsletters/${newsletter.id}`, headers, { name: "Morgenblick" }),
    idParams(newsletter.id),
  );
  assert.equal(response.status, 200);
  const updated = (await response.json()).newsletter;
  assert.equal(updated.name, "Morgenblick");
  assert.equal(updated.taskId, newsletter.taskId);
  assert.equal(updated.schedule.cron, "0 3 * * *");
  assert.equal(updated.schedule.enabled, true);

  const task = getTask(headers, newsletter.taskId);
  assert.equal(task.name, "Morgenblick");
  assert.match(task.prompt, /Morgenblick/);
});

test("a patch with new topics rebuilds the prompt and deduplicates them", async () => {
  const headers = createAccount("themen");
  const newsletter = await createNewsletter(headers);

  const response = await route.PATCH(
    request("PATCH", `/api/newsletters/${newsletter.id}`, headers, { topics: ["Klimapolitik", "klimapolitik", "Raumfahrt"] }),
    idParams(newsletter.id),
  );
  assert.equal(response.status, 200);
  const updated = (await response.json()).newsletter;
  assert.deepEqual(updated.topics, ["Klimapolitik", "Raumfahrt"]);

  const task = getTask(headers, newsletter.taskId);
  assert.match(task.prompt, /Raumfahrt/);
  assert.match(task.prompt, /Klimapolitik/);
});

test("a disabled newsletter has no next run", async () => {
  const headers = createAccount("aus");
  const newsletter = await createNewsletter(headers);

  const response = await route.PATCH(
    request("PATCH", `/api/newsletters/${newsletter.id}`, headers, { enabled: false }),
    idParams(newsletter.id),
  );
  assert.equal(response.status, 200);
  const updated = (await response.json()).newsletter;
  assert.equal(updated.schedule.enabled, false);
  assert.equal(updated.schedule.nextRun, null);
  assert.equal(getTask(headers, newsletter.taskId).enabled, false);
});

test("an empty name is a 400 that names the field", async () => {
  const headers = createAccount("leer");
  const newsletter = await createNewsletter(headers);
  const response = await route.PATCH(
    request("PATCH", `/api/newsletters/${newsletter.id}`, headers, { name: " " }),
    idParams(newsletter.id),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).field, "name");
});

test("an unknown id is a 404 for PATCH and DELETE", async () => {
  const headers = createAccount("unbekannt");
  assert.equal((await route.PATCH(request("PATCH", "/api/newsletters/fehlt", headers, { name: "x" }), idParams("fehlt"))).status, 404);
  assert.equal((await route.DELETE(request("DELETE", "/api/newsletters/fehlt", headers), idParams("fehlt"))).status, 404);
});

test("a newsletter that was deleted outside can be recreated through a patch with a cron", async () => {
  const headers = createAccount("neu-anlegen");
  const folder = join(HOME_ROOT, headers.username, "projekt");
  mkdirSync(folder, { recursive: true });
  const newsletter = await createNewsletter(headers);
  deleteTask(headers, newsletter.taskId);

  // Ohne Cron gibt es keinen Zeitplan, den die Aufgabe bekommen koennte.
  const withoutCron = await route.PATCH(
    request("PATCH", `/api/newsletters/${newsletter.id}`, headers, { name: "Wieder da" }),
    idParams(newsletter.id),
  );
  assert.equal(withoutCron.status, 400);
  assert.equal((await withoutCron.json()).field, "cron");

  const response = await route.PATCH(
    request("PATCH", `/api/newsletters/${newsletter.id}`, headers, { cron: "0 6 * * 1", cwd: folder }),
    idParams(newsletter.id),
  );
  assert.equal(response.status, 200);
  const updated = (await response.json()).newsletter;
  assert.notEqual(updated.taskId, newsletter.taskId);
  assert.equal(updated.schedule.cron, "0 6 * * 1");
  // Die neu angelegte Aufgabe traegt die Ordnerwahl des Patches mit.
  assert.equal(updated.schedule.cwd, folder);
  const task = getTask(headers, updated.taskId);
  assert.equal(task.cron, "0 6 * * 1");
  assert.equal(task.cwd, folder);
  assert.match(task.prompt, /Wochenblick/);
});

test("a patch stores the working folder, and cwd: null clears it again", async () => {
  const headers = createAccount("ordner");
  const folder = join(HOME_ROOT, headers.username, "projekt");
  mkdirSync(folder, { recursive: true });
  const newsletter = await createNewsletter(headers);
  assert.equal(newsletter.schedule.cwd, null);

  const set = await route.PATCH(
    request("PATCH", `/api/newsletters/${newsletter.id}`, headers, { cwd: folder }),
    idParams(newsletter.id),
  );
  assert.equal(set.status, 200);
  assert.equal((await set.json()).newsletter.schedule.cwd, folder);
  assert.equal(getTask(headers, newsletter.taskId).cwd, folder);

  // `null` ist eine Loeschung und kein "Feld fehlt".
  const cleared = await route.PATCH(
    request("PATCH", `/api/newsletters/${newsletter.id}`, headers, { cwd: null }),
    idParams(newsletter.id),
  );
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).newsletter.schedule.cwd, null);
  assert.equal(getTask(headers, newsletter.taskId).cwd ?? null, null);
});

test("a working folder outside the home is a 400 that names the field", async () => {
  const headers = createAccount("aussen");
  const newsletter = await createNewsletter(headers);
  const outside = mkdtempSync(join(tmpdir(), "omp-web-newsletter-outside-"));
  try {
    const response = await route.PATCH(
      request("PATCH", `/api/newsletters/${newsletter.id}`, headers, { cwd: outside }),
      idParams(newsletter.id),
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).field, "cwd");
    // Die Aufgabe bleibt unveraendert — kein halber Zustand.
    assert.equal(getTask(headers, newsletter.taskId).cwd ?? null, null);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

// --- Loeschen -------------------------------------------------------------------

test("deleting a newsletter drops the record and the task", async () => {
  const headers = createAccount("loeschen");
  const newsletter = await createNewsletter(headers);

  const response = await route.DELETE(request("DELETE", `/api/newsletters/${newsletter.id}`, headers), idParams(newsletter.id));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(readNewsletterFile(headers).newsletters, []);
  assert.equal(getTask(headers, newsletter.taskId), null);
});

test("a newsletter of another identity is a 404, not a 403", async () => {
  const alice = createAccount("alice");
  const bob = createAccount("bob");
  const newsletter = await createNewsletter(alice);

  assert.equal((await route.DELETE(request("DELETE", `/api/newsletters/${newsletter.id}`, bob), idParams(newsletter.id))).status, 404);
  assert.equal(readNewsletterFile(alice).newsletters.length, 1);
  assert.ok(getTask(alice, newsletter.taskId), "the task is untouched");
});

test.after(() => {
  globalThis.__ompRuntimePromise = previousRuntime;
  rmSync(HOME_ROOT, { recursive: true, force: true });
});
