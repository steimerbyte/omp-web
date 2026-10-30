import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  claimRun,
  createTask,
  deleteTask,
  getScheduledTasksPath,
  getTask,
  isScheduledTasksPathAllowed,
  listTasks,
  markRun,
  normalizeScheduledTask,
  normalizeScheduledTasks,
  readScheduledTasksFile,
  SCHEDULED_TASKS_SCHEMA_VERSION,
  ScheduledTaskError,
  updateTask,
} = await jiti.import("./scheduled-tasks-store.ts");

const { ScheduleError } = await jiti.import("./schedule.ts");

/**
 * `OMP_WEB_HOME_ROOT` entscheidet, wo `getUserHome()` nachsieht — dieselbe
 * Vorbemerkung wie in `lib/calendar-store.test.mjs`. Ohne diesen Wert wandern
 * die Fixture-Pfade ins echte Heimatverzeichnis des Rechners.
 */
const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-scheduled-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

/**
 * Ein Modell-Paar, das der Test als bekannt erklaert.
 *
 * Der Speicher haelt *keine* Modellliste: das Paar kommt von aussen, damit
 * diese Datei nicht zu einer zweiten, veraltenden Kopie von `config.yml` wird.
 * `knownModel` ist deshalb genau die Form, die eine Route mit
 * `modelRegistry.find(provider, modelId) != null` beantwortet.
 */
const KNOWN = { provider: "buds-gateway", modelId: "qwen3.8-27b" };
const knownModel = (provider, modelId) => provider === KNOWN.provider && modelId === KNOWN.modelId;

/**
 * Legt das Heimatverzeichnis eines Kontos an und gibt es zurueck.
 *
 * Der Heimatordner selbst muss existieren, weil `resolveTenantAgentDir`
 * `<home>/.omp/agent` bildet und der Speicher nur das Agent-Verzeichnis
 * anlegt.
 */
function createAccount(username) {
  const home = join(HOME_ROOT, username);
  mkdirSync(home, { recursive: true });
  return { home, identity: { username, isAdmin: false } };
}

function input(overrides = {}) {
  return {
    name: "Nachtlauf",
    cron: "0 3 * * *",
    prompt: "Fasse die offenen Punkte des Tages zusammen.",
    ...KNOWN,
    ...overrides,
  };
}

// --- Pfad ----------------------------------------------------------------------

test("the task file of two accounts is two different files", () => {
  assert.notEqual(
    getScheduledTasksPath({ username: "alice", isAdmin: false }),
    getScheduledTasksPath({ username: "bob", isAdmin: false }),
  );
});

test("the task file carries the omp-web prefix and lives in the agent dir", () => {
  const path = getScheduledTasksPath({ username: "alice", isAdmin: false });
  assert.ok(path.endsWith("/.omp/agent/omp-web-scheduled-tasks.json"), path);
});

test("the path of a foreign home is refused", () => {
  const identity = { username: "alice", isAdmin: false };
  assert.equal(isScheduledTasksPathAllowed(identity, getScheduledTasksPath(identity)), true);
  assert.equal(isScheduledTasksPathAllowed(identity, "/etc/passwd"), false);
});

// --- Anlegen, Lesen, Aendern, Loeschen -------------------------------------------

test("create then list returns the task, and the file carries the schema version", () => {
  const { home, identity } = createAccount("runde");
  try {
    const task = createTask(identity, input(), knownModel);
    assert.equal(task.name, "Nachtlauf");
    assert.equal(task.cron, "0 3 * * *");
    assert.equal(task.enabled, true);
    assert.match(task.id, /^[0-9a-f-]{36}$/);

    assert.deepEqual(listTasks(identity).map((entry) => entry.id), [task.id]);
    assert.deepEqual(getTask(identity, task.id), task);

    const raw = JSON.parse(readFileSync(getScheduledTasksPath(identity), "utf8"));
    assert.equal(raw.schemaVersion, SCHEDULED_TASKS_SCHEMA_VERSION);
    assert.equal(raw.tasks.length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the task file is written privately, and no temp file is left behind", () => {
  const { home, identity } = createAccount("rechte");
  try {
    createTask(identity, input(), knownModel);
    const path = getScheduledTasksPath(identity);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const leftovers = readdirSync(path.slice(0, path.lastIndexOf("/"))).filter((name) => name.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("one account's tasks are not in another account's list", () => {
  const alice = createAccount("alice2");
  const bob = createAccount("bob2");
  try {
    createTask(alice.identity, input({ name: "Alices Lauf" }), knownModel);
    assert.deepEqual(listTasks(bob.identity), []);
  } finally {
    rmSync(alice.home, { recursive: true, force: true });
    rmSync(bob.home, { recursive: true, force: true });
  }
});

test("a task can be updated field by field", () => {
  const { home, identity } = createAccount("update");
  try {
    const created = createTask(identity, input(), knownModel);
    const updated = updateTask(
      identity,
      created.id,
      { name: "Mittagslauf", cron: "30 12 * * 1-5", enabled: false },
      knownModel,
    );
    assert.equal(updated.name, "Mittagslauf");
    assert.equal(updated.cron, "30 12 * * 1-5");
    assert.equal(updated.enabled, false);
    // Nicht im Patch genannte Felder bleiben: der Patch ist eine Teilmenge.
    assert.equal(updated.prompt, created.prompt);
    assert.equal(updated.createdAt, created.createdAt);

    assert.deepEqual(getTask(identity, created.id), updated);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("update replaces the model pair when it is known", () => {
  const { home, identity } = createAccount("modell");
  try {
    const created = createTask(identity, input({ modelId: "zweitmodell" }), () => true);
    assert.equal(created.modelId, "zweitmodell");
    const updated = updateTask(identity, created.id, { modelId: KNOWN.modelId }, knownModel);
    assert.equal(updated.provider, KNOWN.provider);
    assert.equal(updated.modelId, KNOWN.modelId);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an unknown model pair is refused on create", () => {
  const { home, identity } = createAccount("unbekannt");
  try {
    assert.throws(
      () => createTask(identity, input({ modelId: "gibt-es-nicht" }), knownModel),
      (error) => error instanceof ScheduledTaskError && error.field === "modelId" && /Unknown model/.test(error.message),
    );
    // Nichts wurde geschrieben: eine abgelehnte Aufgabe hinterlaesst keine Datei.
    assert.deepEqual(listTasks(identity), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("update refuses an unknown model pair without changing the row", () => {
  const { home, identity } = createAccount("unbekannt2");
  try {
    const created = createTask(identity, input(), knownModel);
    assert.throws(
      () => updateTask(identity, created.id, { provider: "fremd" }, knownModel),
      (error) => error instanceof ScheduledTaskError && error.field === "modelId",
    );
    assert.deepEqual(getTask(identity, created.id), created);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("thinkingLevel is optional, can be set and can be removed", () => {
  const { home, identity } = createAccount("denken");
  try {
    const plain = createTask(identity, input(), knownModel);
    assert.equal("thinkingLevel" in plain, false);

    const withLevel = updateTask(identity, plain.id, { thinkingLevel: "high" }, knownModel);
    assert.equal(withLevel.thinkingLevel, "high");

    const cleared = updateTask(identity, plain.id, { thinkingLevel: null }, knownModel);
    assert.equal("thinkingLevel" in cleared, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("enabled only accepts a real boolean", () => {
  const { home, identity } = createAccount("schalter");
  try {
    // `"false"` ist wahr, `0` ist falsch — beides waere eine stille Umdeutung
    // dessen, was der Aufrufer geschickt hat.
    for (const value of ["false", 0, null]) {
      assert.throws(
        () => createTask(identity, input({ enabled: value }), knownModel),
        (error) => error instanceof ScheduledTaskError && error.field === "enabled",
        `enabled: ${JSON.stringify(value)} must be refused`,
      );
    }
    const created = createTask(identity, input({ enabled: false }), knownModel);
    assert.equal(created.enabled, false);
    assert.throws(
      () => updateTask(identity, created.id, { enabled: "true" }, knownModel),
      (error) => error instanceof ScheduledTaskError && error.field === "enabled",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an unknown thinking level is refused", () => {
  const { home, identity } = createAccount("denken2");
  try {
    assert.throws(
      () => createTask(identity, input({ thinkingLevel: "turbo" }), knownModel),
      (error) => error instanceof ScheduledTaskError && error.field === "thinkingLevel",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("delete removes exactly one task", () => {
  const { home, identity } = createAccount("loeschen");
  try {
    const first = createTask(identity, input({ name: "Erster" }), knownModel);
    const second = createTask(identity, input({ name: "Zweiter" }), knownModel);

    assert.equal(deleteTask(identity, first.id), true);
    assert.deepEqual(listTasks(identity).map((task) => task.id), [second.id]);
    assert.equal(deleteTask(identity, first.id), false);
    assert.equal(getTask(identity, first.id), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("update and delete of an unknown id answer null and false", () => {
  const { home, identity } = createAccount("fehlt");
  try {
    createTask(identity, input(), knownModel);
    assert.equal(updateTask(identity, "gibt-es-nicht", { name: "Neu" }, knownModel), null);
    assert.equal(deleteTask(identity, "gibt-es-nicht"), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- Eingabepruefung --------------------------------------------------------------

test("an empty name and an empty prompt are refused", () => {
  const { home, identity } = createAccount("leer");
  try {
    assert.throws(
      () => createTask(identity, input({ name: "   " }), knownModel),
      (error) => error instanceof ScheduledTaskError && error.field === "name",
    );
    assert.throws(
      () => createTask(identity, input({ prompt: "  \n " }), knownModel),
      (error) => error instanceof ScheduledTaskError && error.field === "prompt",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("name and prompt are capped at 120 and 20000 characters", () => {
  const { home, identity } = createAccount("laenge");
  try {
    const exactName = "n".repeat(120);
    assert.equal(createTask(identity, input({ name: exactName }), knownModel).name, exactName);
    assert.throws(
      () => createTask(identity, input({ name: "n".repeat(121) }), knownModel),
      (error) => error instanceof ScheduledTaskError && error.field === "name" && /at most 120/.test(error.message),
    );

    const exactPrompt = "p".repeat(20_000);
    assert.equal(createTask(identity, input({ prompt: exactPrompt }), knownModel).prompt.length, 20_000);
    assert.throws(
      () => createTask(identity, input({ prompt: "p".repeat(20_001) }), knownModel),
      (error) => error instanceof ScheduledTaskError && error.field === "prompt" && /at most 20000/.test(error.message),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an invalid cron is refused by the schedule parser, not stored", () => {
  const { home, identity } = createAccount("cron");
  try {
    assert.throws(
      () => createTask(identity, input({ cron: "0 8 L * *" }), knownModel),
      (error) => error instanceof ScheduleError && error.field === "dayOfMonth" && error.token === "L",
    );
    assert.deepEqual(listTasks(identity), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- Normalisierung ----------------------------------------------------------------

test("a malformed row is dropped, not repaired, and the good rows survive", () => {
  const { home, identity } = createAccount("kaputt");
  try {
    const good = createTask(identity, input({ name: "Gut" }), knownModel);
    const path = getScheduledTasksPath(identity);
    // Die Datei wird mit dem echten Schreiber erzeugt und danach verfaelscht:
    // ein handgeschriebenes JSON wuerde testen, was ein Writer emittiert, nicht
    // was der Parser liest.
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    onDisk.tasks.push(
      { ...good, id: "kaputte-zeile", cron: "0 8 L * *" },
      { ...good, id: "ohne-name", name: "" },
      { ...good, id: "ohne-prompt", prompt: 42 },
      // Dieselbe id wie die gute Zeile: zwei Karten fuer eine Aufgabe waeren
      // eine, deren Inhalt von der Reihenfolge in der Datei abhaengt.
      { ...good },
      "kein Objekt",
      null,
    );
    writeFileSync(path, JSON.stringify(onDisk));

    const tasks = listTasks(identity);
    assert.deepEqual(tasks.map((task) => task.id), [good.id]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("unreadable content counts as existing but empty", () => {
  const { home, identity } = createAccount("unlesbar");
  try {
    const path = getScheduledTasksPath(identity);
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(path, "{kein json");
    const { exists, tasks } = readScheduledTasksFile(identity);
    // Die Datei existiert: ein Seed darf jetzt nicht ueber den Bestand laufen.
    assert.equal(exists, true);
    assert.deepEqual(tasks, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an account without a file has no file yet, which is not an empty list", () => {
  const { home, identity } = createAccount("nichts");
  try {
    assert.deepEqual(readScheduledTasksFile(identity), { exists: false, tasks: [], versionMismatch: false });
    assert.equal(existsSync(getScheduledTasksPath(identity)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a file from another schema version is read but never overwritten", () => {
  const { home, identity } = createAccount("version");
  try {
    const created = createTask(identity, input(), knownModel);
    const path = getScheduledTasksPath(identity);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    onDisk.schemaVersion = SCHEDULED_TASKS_SCHEMA_VERSION + 1;
    // Ein Feld, das nur ein neuerer Build kennt. Wird die Datei ueberschrieben,
    // ist es weg — und niemand merkt es.
    onDisk.tasks[0].futureField = "gehoert einer anderen Fassung";
    writeFileSync(path, JSON.stringify(onDisk));

    const { exists, tasks, versionMismatch } = readScheduledTasksFile(identity);
    assert.equal(exists, true);
    assert.equal(versionMismatch, true);
    assert.deepEqual(tasks.map((task) => task.id), [created.id]);

    assert.throws(
      () => updateTask(identity, created.id, { name: "Neu" }, knownModel),
      (error) => error instanceof ScheduledTaskError && error.field === "version",
    );
    // Die fremde Datei steht unveraendert da, samt ihrem Feld.
    const after = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(after.schemaVersion, SCHEDULED_TASKS_SCHEMA_VERSION + 1);
    assert.equal(after.tasks[0].futureField, "gehoert einer anderen Fassung");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("normalizeScheduledTask invents no field", () => {
  // Kein `createdAt`: die Zeile ist ungueltig, statt mit "jetzt" erfunden zu
  // werden — der Nutzer wuerde sonst glauben, er haette die Aufgabe heute
  // angelegt.
  assert.equal(normalizeScheduledTask({ id: "x", name: "A", cron: "* * * * *", prompt: "p", provider: "a", modelId: "b", enabled: true, updatedAt: "2026-03-01T00:00:00.000Z" }), null);
  // Ein gesetztes, aber unlesbares optionales Feld verschwindet; die Zeile bleibt.
  const repairedOptional = normalizeScheduledTask({
    id: "x",
    name: "A",
    cron: "* * * * *",
    prompt: "p",
    provider: "a",
    modelId: "b",
    enabled: true,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    thinkingLevel: "turbo",
    lastRunStatus: "vielleicht",
    claimedSlotMs: 1.5,
  });
  assert.deepEqual(Object.keys(repairedOptional).sort(), [
    "createdAt", "cron", "enabled", "id", "modelId", "name", "prompt", "provider", "updatedAt",
  ]);
  assert.deepEqual(normalizeScheduledTasks("keine Liste"), []);
});

// --- Lauf und Claim ----------------------------------------------------------------

test("markRun records the run without touching updatedAt", () => {
  const { home, identity } = createAccount("lauf");
  try {
    const created = createTask(identity, input(), knownModel);
    const at = Date.UTC(2026, 2, 14, 7, 0);
    const marked = markRun(identity, created.id, { at, sessionId: "sitzung-1", status: "ok" });
    assert.equal(marked.lastRunAt, new Date(at).toISOString());
    assert.equal(marked.lastRunSessionId, "sitzung-1");
    assert.equal(marked.lastRunStatus, "ok");
    // `updatedAt` ist der Zeitpunkt der letzten Bearbeitung, ein Lauf ist keine.
    assert.equal(marked.updatedAt, created.updatedAt);

    assert.equal(markRun(identity, "gibt-es-nicht", { at, status: "error" }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("claimRun claims one slot once and the next slot again", () => {
  const { home, identity } = createAccount("claim");
  try {
    const created = createTask(identity, input(), knownModel);
    const slot = Date.UTC(2026, 2, 14, 2, 0);

    assert.equal(claimRun(identity, created.id, slot), true);
    assert.equal(claimRun(identity, created.id, slot), false);
    // Der Claim liegt in der Datei: eine frische Lesung sieht ihn.
    assert.equal(getTask(identity, created.id).claimedSlotMs, slot);

    assert.equal(claimRun(identity, created.id, slot + 24 * 60 * 60 * 1000), true);
    // Ein alter Slot ist nach dem neuen vorbei und wird nicht wieder faellig.
    assert.equal(claimRun(identity, created.id, slot), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("claimRun answers false for an unknown or disabled task", () => {
  const { home, identity } = createAccount("claim2");
  try {
    const created = createTask(identity, input({ enabled: false }), knownModel);
    assert.equal(claimRun(identity, created.id, 1_000), false);
    assert.equal(claimRun(identity, "gibt-es-nicht", 1_000), false);
    // Eine deaktivierte Aufgabe bekommt keinen Slot vermerkt.
    assert.equal(getTask(identity, created.id).claimedSlotMs, undefined);

    updateTask(identity, created.id, { enabled: true }, knownModel);
    assert.equal(claimRun(identity, created.id, 1_000), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("claimRun refuses a timestamp that is not a whole millisecond", () => {
  const { home, identity } = createAccount("claim3");
  try {
    const created = createTask(identity, input(), knownModel);
    assert.throws(() => claimRun(identity, created.id, 1.5), (error) => error instanceof ScheduledTaskError);
    assert.throws(() => claimRun(identity, created.id, -1), (error) => error instanceof ScheduledTaskError);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** Behauptet eine Aufgabe aus einem zweiten Prozess und gibt seine Antwort zurueck. */
function claimInChildProcess(identity, id, slotMs) {
  const moduleUrl = new URL("./scheduled-tasks-store.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `const { claimRun } = await import(${JSON.stringify(moduleUrl)});
       process.stdout.write(String(claimRun(${JSON.stringify(identity)}, ${JSON.stringify(id)}, ${slotMs})));`,
    ],
    // `process.execPath` ist Bun, also kann das Kind die TS-Quelle laden. Ein
    // Fehlschlag hier ist ein Fehler des Tests, nicht des Stores — deshalb
    // wird der Exitcode mitgeprueft.
    { encoding: "utf8", env: { ...process.env } },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("a second process cannot take a fresh lock", () => {
  const { home, identity } = createAccount("sperre-renn");
  try {
    const created = createTask(identity, input(), knownModel);
    writeFileSync(`${getScheduledTasksPath(identity)}.lock`, "");

    // Die Sperre liegt da und ist frisch: ein zweiter Prozess bekommt sie
    // nicht, statt sie zu uebernehmen. Ohne diesen Test waere die Uebernahme
    // nach 30 s die einzige gepruefte Haelfte der Regel.
    assert.equal(claimInChildProcess(identity, created.id, 1_000), "false");
    assert.equal(claimRun(identity, created.id, 1_000), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a claim made by another process is the one this process sees", () => {
  const { home, identity } = createAccount("claim-prozess");
  try {
    const created = createTask(identity, input(), knownModel);
    // Der Claim liegt in der Datei, nicht im Speicher des Schreibers: genau das
    // laesst ihn einen Neustart und eine zweite Instanz ueberleben.
    assert.equal(claimInChildProcess(identity, created.id, 5_000), "true");
    assert.equal(claimRun(identity, created.id, 5_000), false);
    assert.equal(getTask(identity, created.id).claimedSlotMs, 5_000);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a lock file older than 30 seconds is taken over instead of wedging the store", () => {
  const { home, identity } = createAccount("sperre-alt");
  try {
    createTask(identity, input(), knownModel);
    const lockPath = `${getScheduledTasksPath(identity)}.lock`;
    writeFileSync(lockPath, "");
    // Der Absturz im kritischen Abschnitt: die Datei bleibt liegen, ihr
    // Zeitstempel ist der des Absturzes. Ohne Uebernahme waere der Zeitplan
    // fuer dieses Konto fuer immer stumm.
    const longAgo = new Date(Date.now() - 31_000);
    utimesSync(lockPath, longAgo, longAgo);

    const second = createTask(identity, input({ name: "Nach dem Absturz" }), knownModel);
    assert.equal(second.name, "Nach dem Absturz");
    assert.equal(listTasks(identity).length, 2);
    // Die Sperre wird nicht als Rest zurueckgelassen.
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a leftover lock file younger than 30 seconds blocks a write instead of losing it", () => {
  const { home, identity } = createAccount("sperre");
  try {
    createTask(identity, input(), knownModel);
    // Eine fremde Instanz haelt die Sperre: die Datei existiert und ist frisch.
    writeFileSync(`${getScheduledTasksPath(identity)}.lock`, "");

    assert.throws(
      () => createTask(identity, input({ name: "Zweiter" }), knownModel),
      (error) => error instanceof ScheduledTaskError && error.field === "lock",
    );
    // Nichts ging verloren, und die Sperre wird nicht von einem Fremden geloescht.
    assert.equal(listTasks(identity).length, 1);
    assert.equal(existsSync(`${getScheduledTasksPath(identity)}.lock`), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a hand-edited cwd outside the account home is dropped on read, the task stays", () => {
  const { home, identity } = createAccount("cwd-fremd");
  try {
    const created = createTask(identity, input(), knownModel);
    const path = getScheduledTasksPath(identity);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    // Am Schreibpfad vorbei: eine von Hand bearbeitete Datei. Der Zeitplaner
    // startet dann eine Session in diesem Verzeichnis — und `lib/session-reader.ts`
    // leitet den Besitz einer Session aus ihrem `cwd` ab.
    onDisk.tasks[0].cwd = "/etc";
    onDisk.tasks.push({ ...onDisk.tasks[0], id: "zweitens", cwd: "/srv/fremd" });
    writeFileSync(path, JSON.stringify(onDisk));

    const tasks = listTasks(identity);
    assert.equal(tasks.length, 2, "die Aufgaben bleiben");
    for (const task of tasks) assert.equal(task.cwd, undefined, "nur der Pfad faellt weg");
    assert.equal(tasks[0].id, created.id);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
