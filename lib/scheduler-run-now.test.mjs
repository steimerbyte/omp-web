import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * "Jetzt ausfuehren": was der Handstart darf und was nicht.
 *
 * ### Warum `startRpcSession` ersetzt wird
 *
 * Ein echter Start oeffnet eine Session mit Modell, Arbeitsverzeichnis und
 * SDK — das haengt an der Maschine, an `agent.db` und an einem Modell, das
 * gerade konfiguriert ist. Geprueft werden soll hier aber die **Regel** um den
 * Start herum: dass ein Handstart denselben Weg nimmt, `lastRun*` schreibt und
 * `claimedSlotMs` **nicht** anfasst. Das ist genau die Grenze, die ein zweiter
 * Startweg falsch machen wuerde, und dafuer ist der Ersatz ausreichend.
 *
 * Der Ersatz geht als Parameter hinein (`runTaskNow(identity, task, starter)`),
 * nicht als `mock.module`. Ein Modul-Mock ist prozessweit und laesst sich
 * nicht zuruecknehmen; er hat hier tatsaechlich sieben fremde Testdateien rot
 * gemacht, die `@/lib/session-reader` bzw. den Session-Start spaeter selbst
 * importieren. Der Parameter ist derselbe Startweg mit fremder
 * Implementierung — die Naht, die der Test braucht, ohne einen zweiten
 * Produktionspfad.
 */

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-runnow-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

/** Was der Ersatz gesehen hat, und ob er scheitern soll. */
let starts = [];
let failWith = null;

/** Derselbe Startweg, nur ohne Session: Kennung, Prompt und Fehler sind die Frage. */
async function fakeStarter(sessionId, _file, cwd, options) {
  const record = { sessionId, cwd, options };
  starts.push(record);
  if (failWith) throw failWith;
  return {
    session: { send: async (message) => { record.prompt = message.message; } },
    realSessionId: "sitzung-von-hand-1",
  };
}

const jiti = createJiti(import.meta.url, { root: process.cwd(), alias: { "@": process.cwd() } });

const { runSchedulerTick, runTaskNow, selectDueTasks } = await jiti.import("@/lib/scheduler.ts");
const { claimRun, createTask, getTask, listTasks } = await jiti.import("@/lib/scheduled-tasks-store.ts");

let accountCounter = 0;

function createAccount(label) {
  const username = `${label}-${accountCounter++}`;
  const home = join(HOME_ROOT, username);
  mkdirSync(home, { recursive: true });
  return { identity: { username, home }, home };
}

const knownModel = (provider, modelId) => provider === "buds-gateway" && modelId === "qwen3.8-27b";

function input(overrides = {}) {
  return {
    name: "Nachtlauf",
    cron: "0 3 * * *",
    prompt: "Fasse die offenen Punkte zusammen.",
    provider: "buds-gateway",
    modelId: "qwen3.8-27b",
    ...overrides,
  };
}

test.beforeEach(() => {
  starts = [];
  failWith = null;
});

test("a manual run starts a session and records it as the last run", async () => {
  const { identity, home } = createAccount("hand");
  try {
    const task = createTask(identity, input(), knownModel);
    const result = await runTaskNow(identity, task, fakeStarter);

    assert.deepEqual(result, { sessionId: "sitzung-von-hand-1" });
    // Derselbe Weg wie der Zeitplan: eigener Aufrufer-Schluessel, Modell und
    // Prompt aus der Aufgabe.
    assert.equal(starts.length, 1);
    assert.match(starts[0].sessionId, /^__scheduled__/);
    assert.equal(starts[0].prompt, task.prompt);
    assert.deepEqual(starts[0].options.initialModel, { provider: "buds-gateway", modelId: "qwen3.8-27b" });
    // Der Besitzer ist der Name des Kontos, nicht seine Rolle.
    assert.equal(starts[0].options.owner, identity.username);

    // Und die Aufgabe traegt den Lauf.
    const stored = getTask(identity, task.id);
    assert.equal(stored.lastRunSessionId, "sitzung-von-hand-1");
    assert.equal(stored.lastRunStatus, "ok");
    assert.ok(typeof stored.lastRunAt === "string" && stored.lastRunAt.length > 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a manual run does not claim a slot and does not stop the next scheduled firing", async () => {
  // Das ist die Zusicherung, die den Handstart von einem Zeitplan trennt: ein
  // Klick darf den naechsten faelligen Slot weder verschlucken noch
  // verschieben. Behauptet waere das Gegenteil genau dann, wenn `runTaskNow`
  // `claimRun` mitriefe — deshalb wird der Slot danach wirklich beansprucht.
  const { identity, home } = createAccount("slot");
  try {
    const task = createTask(identity, input(), knownModel);
    const slotMs = Date.UTC(2026, 2, 14, 3, 0);

    await runTaskNow(identity, task, fakeStarter);
    assert.equal(getTask(identity, task.id).claimedSlotMs, undefined,
      "ein Handstart hat einen Slot beansprucht");

    // Der geplante Lauf fuer denselben Slot findet ihn noch frei.
    assert.equal(claimRun(identity, task.id, slotMs), true,
      "der Slot war nach dem Handstart nicht mehr zu haben");
    // Und nur einmal.
    assert.equal(claimRun(identity, task.id, slotMs), false);

    // Ein Handstart nach einem geplanten Lauf laesst den Claim stehen.
    await runTaskNow(identity, getTask(identity, task.id), fakeStarter);
    assert.equal(getTask(identity, task.id).claimedSlotMs, slotMs);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a manual run is allowed on a disabled task and leaves it disabled", async () => {
  // `enabled` sagt, ob der Takt die Aufgabe startet — nicht, ob ein Mensch sie
  // starten darf. Wer deaktiviert und dann klickt, hat den Lauf bestellt.
  const { identity, home } = createAccount("aus");
  try {
    const task = createTask(identity, input({ enabled: false }), knownModel);
    const result = await runTaskNow(identity, task, fakeStarter);

    assert.equal(result.sessionId, "sitzung-von-hand-1");
    const stored = getTask(identity, task.id);
    assert.equal(stored.enabled, false, "der Handstart hat die Aufgabe eingeschaltet");
    assert.equal(stored.lastRunStatus, "ok");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a failed manual start records the error and is rethrown to the caller", async () => {
  // Der Zeitplan schluckt den Fehler (ein kaputter Eintrag darf den Durchlauf
  // nicht beenden); der Handstart nicht — die Oberflaeche soll den Grund
  // zeigen. Vermerkt wird er in beiden Faellen.
  const { identity, home } = createAccount("fehler");
  try {
    const task = createTask(identity, input(), knownModel);
    failWith = new Error("Model is not available in the enabled scope: buds-gateway/qwen3.8-27b");

    await assert.rejects(() => runTaskNow(identity, task, fakeStarter), /not available in the enabled scope/);

    const stored = getTask(identity, task.id);
    assert.equal(stored.lastRunStatus, "error");
    // Ein gescheiterter Start hinterlaesst keine Session-Kennung, die es nicht gibt.
    assert.equal(stored.lastRunSessionId, undefined);
    // Und er hat nichts anderes angelegt.
    assert.equal(listTasks(identity).length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * Der Durchlauf: ein Fehler bei einer Aufgabe beendet die anderen nicht.
 *
 * Die Regel steht seit dem Umbau als `try/catch` im Tick und nicht mehr in
 * `runTask` — `runTask` meldet den Fehler jetzt an seinen Aufrufer zurueck.
 * Genau diese Naht ist gefaehrdet: wer den `catch` herauszieht, bemerkt das
 * an keiner anderen Stelle. Der Test trifft den Tick deshalb an seiner
 * Eintrittstelle, mit zwei Aufgaben im **selben** Fenster, von denen die
 * erste wirft — dieselbe Form wie im Betrieb (ein Modell, das die
 * Registrierung nicht mehr kennt, waehrend die naechste Aufgabe gesund ist).
 *
 * Die Konten kommen als Parameter, nicht ueber `USER`/`PI_CODING_AGENT_DIR`:
 * die sind prozessweit und wuerden jede andere Testdatei mitverstellen (in
 * der vollen Suite wurde der Test dadurch rot, allein lief er gruen).
 */
test("der Durchlauf laeuft weiter, wenn eine Aufgabe nicht startet", async () => {
  const account = createAccount("tick");
  // Zwei gesunde Aufgaben: welche von beiden wirft, entscheidet erst die
  // Reihenfolge des Ticks — siehe unten.
  createTask(account.identity, input({ name: "Aufgabe A" }), knownModel);
  createTask(account.identity, input({ name: "Aufgabe B" }), knownModel);
  const slot = Date.UTC(2026, 2, 14, 3, 0);
  const window = { lastTickMs: slot - 60_000, nowMs: slot };

  try {
    // Beide muessen im selben Fenster faellig sein — sonst pruefte der Test
    // nur, dass eine einzelne Aufgabe scheitern darf.
    const due = selectDueTasks(listTasks(account.identity), window).map((run) => run.task.id);
    assert.equal(due.length, 2, `erwartet zwei faellige Aufgaben, waren ${JSON.stringify(due)}`);

    // Welche zuerst kommt, entscheidet `selectDueTasks` bei gleichem Slot nach
    // der Kennung — und die ist eine frisch erzeugte UUID. Die Aufgabe, die
    // wirft, wird deshalb aus der tatsaechlichen Reihenfolge genommen, nicht
    // aus der Anlagereihenfolge; sonst haenge der Test am Zufall der UUIDs.
    const failingId = due[0];
    const succeedingId = due[1];

    // Der erste Start wirft, der zweite laeuft normal.
    let calls = 0;
    const flaky = async (sessionId, file, cwd, options) => {
      calls += 1;
      if (calls === 1) throw new Error("Model is not available in the enabled scope: buds-gateway/entfernt");
      return fakeStarter(sessionId, file, cwd, options);
    };

    // (d) Der Tick wirft nicht.
    const started = await runSchedulerTick(window, flaky, [account.identity]);

    // (a) Die zweite Aufgabe wurde trotzdem gestartet,
    assert.equal(calls, 2, "die zweite Aufgabe wurde nach dem Fehler nicht mehr gestartet");
    // (c) und gezaehlt werden nur die erfolgreichen Starts.
    assert.equal(started, 1, "der Tick hat die gescheiterte Aufgabe mitgezaehlt");

    assert.equal(getTask(account.identity, succeedingId).lastRunStatus, "ok");
    // (b) Die gescheiterte traegt den Fehler und keine erfundene Session.
    const failed = getTask(account.identity, failingId);
    assert.equal(failed.lastRunStatus, "error");
    assert.equal(failed.lastRunSessionId, undefined);
  } finally {
    rmSync(account.home, { recursive: true, force: true });
  }
});

test.after(() => {
  rmSync(HOME_ROOT, { recursive: true, force: true });
});
