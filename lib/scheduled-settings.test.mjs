import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { root: process.cwd(), alias: { "@": process.cwd() } });

/**
 * Arbeitsordner fuer geplante Aufgaben: die Reihenfolge, die Pruefung und der
 * Speicher.
 *
 * Dieselbe Vorbemerkung wie in `lib/calendar-store.test.mjs`: die Konten
 * bekommen ihre Home unter einem Wegwerf-Wurzelverzeichnis, sonst legte der
 * Test Verzeichnisse im echten Heimatverzeichnis an.
 */
const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-cwd-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

// Der Zeitplaner wird nur geladen, damit `rescheduleScheduler()` ein No-op ist.
await jiti.import("@/lib/scheduler.ts");

const tasksRoute = await jiti.import("@/app/api/scheduled-tasks/route.ts");
const idRoute = await jiti.import("@/app/api/scheduled-tasks/[id]/route.ts");
const settingsRoute = await jiti.import("@/app/api/scheduled-settings/route.ts");
const settings = await jiti.import("@/lib/scheduled-settings.ts");
const { runSchedulerTick, runTaskNow } = await jiti.import("@/lib/scheduler.ts");

const KNOWN = { provider: "buds-gateway", modelId: "qwen3.8-27b" };

/**
 * Die Modellregistrierung wird ersetzt, wie in `app/api/scheduled-tasks/route.test.mjs`:
 * sonst haengt "ist dieses Modell bekannt" an der Maschine.
 */
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

let accountCounter = 0;

/** Ein eigenes Konto je Test: die Aufgaben liegen pro Konto in einer Datei. */
function createAccount(label) {
  const username = `${label}-${accountCounter++}`;
  const home = join(HOME_ROOT, username);
  mkdirSync(home, { recursive: true });
  return { headers: { host: "localhost", "x-omp-user": username }, identity: { username, home }, home };
}

/** Ein Ordner in der Home des Kontos — das ist der erlaubte Bereich. */
function folder(home, name) {
  const path = join(home, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function post(url, headers, body) {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function put(url, headers, body) {
  return new Request(`http://localhost${url}`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch(url, headers, body) {
  return new Request(`http://localhost${url}`, {
    method: "PATCH",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(url, headers) {
  return new Request(`http://localhost${url}`, { headers });
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
  const response = await tasksRoute.POST(post("/api/scheduled-tasks", headers, taskInput(overrides)));
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.task;
}

test.after(() => {
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

// --- Die Reihenfolge ------------------------------------------------------------

/**
 * Der Ersatz fuer den Session-Start: er merkt sich das Arbeitsverzeichnis.
 *
 * Dieselbe Naht wie in `lib/scheduler-run-now.test.mjs` und aus demselben
 * Grund: `mock.module` ist prozessweit und laesst sich nicht zuruecknehmen.
 */
function recordingStarter() {
  const starts = [];
  const starter = async (sessionId, _file, cwd, options) => {
    starts.push({ sessionId, cwd, options });
    return { session: { send: async () => {} }, realSessionId: `sitzung-${starts.length}` };
  };
  return { starts, starter };
}

test("die Aufgabe gewinnt gegen den Standardordner des Kontos", async () => {
  const { identity, home } = createAccount("vorrang");
  const eigen = folder(home, "eigen");
  const standard = folder(home, "standard");
  settings.writeScheduledSettings(identity, standard);

  const task = { ...taskInput({ cwd: eigen }), id: "a", enabled: true };
  const { starts, starter } = recordingStarter();
  await runTaskNow(identity, task, starter);
  assert.equal(starts[0].cwd, eigen);
});

test("ohne eigene Angabe gilt der Standardordner des Kontos", async () => {
  const { identity, home } = createAccount("standard");
  const standard = folder(home, "standard");
  settings.writeScheduledSettings(identity, standard);

  const task = { ...taskInput(), id: "b", enabled: true };
  const { starts, starter } = recordingStarter();
  await runTaskNow(identity, task, starter);
  assert.equal(starts[0].cwd, standard);
});

test("ohne Standardordner gilt die Home des Kontos", async () => {
  const { identity, home } = createAccount("home");
  const task = { ...taskInput(), id: "c", enabled: true };
  const { starts, starter } = recordingStarter();
  await runTaskNow(identity, task, starter);
  assert.equal(starts[0].cwd, home);
});

test("ein leerer Standardordner ist kein Standardordner", async () => {
  const { identity, home } = createAccount("leer");
  settings.writeScheduledSettings(identity, null);
  const task = { ...taskInput(), id: "d", enabled: true };
  const { starts, starter } = recordingStarter();
  await runTaskNow(identity, task, starter);
  assert.equal(starts[0].cwd, home);
});

// --- Die Pruefung beim Anlegen und Aendern --------------------------------------

/** Eine Anfrage, die mit `400` und `field: "cwd"` abgelehnt werden muss. */
async function assertRejected(account, cwd) {
  const created = await tasksRoute.POST(post("/api/scheduled-tasks", account.headers, taskInput({ cwd })));
  const body = await created.json();
  assert.equal(created.status, 400, `POST ${String(cwd)}: ${JSON.stringify(body)}`);
  assert.equal(body.field, "cwd");
}

test("ein relativer Arbeitsordner ist ein 400 mit dem Feld cwd", async () => {
  await assertRejected(createAccount("relativ"), "workspace");
});

test("ein nicht existierender Arbeitsordner ist ein 400 mit dem Feld cwd", async () => {
  const account = createAccount("fehlt");
  await assertRejected(account, join(account.home, "gibt-es-nicht"));
});

test("eine Datei als Arbeitsordner ist ein 400 mit dem Feld cwd", async () => {
  const account = createAccount("datei");
  const file = join(account.home, "notiz.txt");
  writeFileSync(file, "kein Verzeichnis");
  await assertRejected(account, file);
});

test("ein Arbeitsordner ausserhalb der Home ist ein 400 mit dem Feld cwd", async () => {
  await assertRejected(createAccount("aussen"), "/etc");
});

test("ein ungueltiger Arbeitsordner in einem Patch ist ein 400 und aendert nichts", async () => {
  const account = createAccount("patch");
  const gueltig = folder(account.home, "gueltig");
  const task = await createTask(account.headers, { cwd: gueltig });

  const response = await idRoute.PATCH(
    patch(`/api/scheduled-tasks/${task.id}`, account.headers, { cwd: "/etc" }),
    idParams(task.id),
  );
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.field, "cwd");

  const list = await (await tasksRoute.GET(get("/api/scheduled-tasks", account.headers))).json();
  assert.equal(list.tasks[0].cwd, gueltig, "die gespeicherte Angabe bleibt stehen");
});

test("ein gueltiger Arbeitsordner in einem Patch wird gespeichert", async () => {
  const account = createAccount("patch-ok");
  const erster = folder(account.home, "eins");
  const zweiter = folder(account.home, "zwei");
  const task = await createTask(account.headers, { cwd: erster });

  const response = await idRoute.PATCH(
    patch(`/api/scheduled-tasks/${task.id}`, account.headers, { cwd: zweiter }),
    idParams(task.id),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).task.cwd, zweiter);
});

test("cwd null im Patch loescht die Angabe, die Aufgabe bleibt", async () => {
  const account = createAccount("patch-null");
  const ordner = folder(account.home, "weg");
  const task = await createTask(account.headers, { cwd: ordner });

  const response = await idRoute.PATCH(
    patch(`/api/scheduled-tasks/${task.id}`, account.headers, { cwd: null }),
    idParams(task.id),
  );
  assert.equal(response.status, 200);
  const body = (await response.json()).task;
  assert.equal("cwd" in body, false, "kein Feld in der Antwort heisst: keine Angabe");
  assert.equal(body.name, task.name, "die uebrigen Felder bleiben");
});

// --- Der Speicher der Einstellung -----------------------------------------------

test("die Einstellung geht hin und zurueck", async () => {
  const { identity, home, headers } = createAccount("rundreise");
  const ordner = folder(home, "projekte");

  const saved = await settingsRoute.PUT(put("/api/scheduled-settings", headers, { defaultCwd: ordner }));
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).defaultCwd, ordner);

  const read = await settingsRoute.GET(get("/api/scheduled-settings", headers));
  assert.equal((await read.json()).defaultCwd, ordner);

  // Und der Weg ueber den Speicher direkt liefert dasselbe.
  assert.equal(settings.readScheduledSettings(identity).defaultCwd, ordner);
});

test("ein leerer Standardordner loescht die Angabe", async () => {
  const { identity, home, headers } = createAccount("leeren");
  const ordner = folder(home, "projekte");
  await settingsRoute.PUT(put("/api/scheduled-settings", headers, { defaultCwd: ordner }));

  const cleared = await settingsRoute.PUT(put("/api/scheduled-settings", headers, { defaultCwd: null }));
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).defaultCwd, null);
  assert.equal(settings.readScheduledSettings(identity).defaultCwd, null);
});

test("eine kaputte Einstellungsdatei faellt auf null zurueck statt zu werfen", async () => {
  const { identity } = createAccount("kaputt");
  const path = settings.getScheduledSettingsPath(identity);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "{ das ist kein JSON");

  assert.deepEqual(settings.readScheduledSettings(identity), { schemaVersion: 1, defaultCwd: null });
});

test("eine Einstellungsdatei mit fremdem Pfad wird beim Lesen verworfen", async () => {
  const { identity } = createAccount("fremdpfad");
  const path = settings.getScheduledSettingsPath(identity);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, defaultCwd: "/etc" }));

  assert.equal(settings.readScheduledSettings(identity).defaultCwd, null);
});

test("zwei Konten teilen keinen Standardordner", async () => {
  const alice = createAccount("alice");
  const bob = createAccount("bob");
  const aliceOrdner = folder(alice.home, "a");
  const bobOrdner = folder(bob.home, "b");

  await settingsRoute.PUT(put("/api/scheduled-settings", alice.headers, { defaultCwd: aliceOrdner }));
  await settingsRoute.PUT(put("/api/scheduled-settings", bob.headers, { defaultCwd: bobOrdner }));

  assert.equal(settings.readScheduledSettings(alice.identity).defaultCwd, aliceOrdner);
  assert.equal(settings.readScheduledSettings(bob.identity).defaultCwd, bobOrdner);
});

test("der Standardordner eines fremden Kontos ist ein 400", async () => {
  const alice = createAccount("alice-fremd");
  const bob = createAccount("bob-fremd");
  const bobOrdner = folder(bob.home, "b");

  const response = await settingsRoute.PUT(put("/api/scheduled-settings", alice.headers, { defaultCwd: bobOrdner }));
  const body = await response.json();
  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.field, "cwd");
});

test("der Durchlauf loest den Ordner genauso auf wie der Handstart", async () => {
  const { identity, home } = createAccount("tick");
  const standard = folder(home, "standard");
  const eigen = folder(home, "eigen");
  settings.writeScheduledSettings(identity, standard);

  // Beide Aufgaben sind im selben Fenster faellig; die eine mit eigener
  // Angabe, die andere ohne. Damit steht in einem Durchlauf nebeneinander,
  // was die beiden Wege tun — ein Test, der nur `runTaskNow` prueft, wuerde
  // eine zweite Aufloesung im Tick nicht bemerken.
  const { createTask: create } = await jiti.import("@/lib/scheduled-tasks-store.ts");
  const isKnownModel = (provider, modelId) => provider === KNOWN.provider && modelId === KNOWN.modelId;
  const slot = Date.UTC(2026, 2, 14, 3, 0);
  create(identity, taskInput({ cwd: eigen, cron: "0 3 * * *" }), isKnownModel);
  create(identity, taskInput({ cron: "0 3 * * *" }), isKnownModel);

  const { starts, starter } = recordingStarter();
  const started = await runSchedulerTick(
    { lastTickMs: slot - 60_000, nowMs: slot },
    starter,
    [identity],
  );
  assert.equal(started, 2);
  assert.deepEqual(starts.map((start) => start.cwd).sort(), [eigen, standard].sort());
});
