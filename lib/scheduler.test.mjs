import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { root: process.cwd() });
const {
  MAX_TIMER_DELAY_MS,
  isUsableTaskCwd,
  nextWakeupMs,
  selectDueTasks,
} = await jiti.import("./scheduler.ts");

/**
 * Die Faelligkeitsregel, ohne Timer, ohne HTTP und ohne Dateisystem.
 *
 * `selectDueTasks` ist die eine Stelle, an der "jetzt ist es so weit"
 * entschieden wird. Ein Test, der dafuer einen echten Timer abwartet, waere
 * langsam und wuerde bei jedem Fehlschlag die Frage offen lassen, ob die Regel
 * oder der Timer falsch ist. Deshalb bekommt die Funktion zwei Zeitpunkte und
 * sonst nichts.
 *
 * **Die Zeitzone ist die des Servers** — das ist die dokumentierte
 * Entscheidung von `lib/schedule.ts`. Die Zeitpunkte werden deshalb mit
 * `Date.UTC` gebaut und die Slots mit `local()` in lokaler Zeit: eine Erwartung
 * in UTC waere in einer anderen Zone ein anderer Test.
 */

/** Ein Zeitpunkt in lokaler Zeit, wie ihn der Planer auch sieht. */
function local(year, month, day, hour = 0, minute = 0) {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

/** Eine Aufgabe, wie sie im Speicher steht — nur die Felder, die hier zaehlen. */
function task(overrides = {}) {
  return {
    id: "task-1",
    name: "Nachtlauf",
    cron: "0 3 * * *",
    prompt: "Fasse den Tag zusammen.",
    provider: "buds-gateway",
    modelId: "qwen3.8-27b",
    enabled: true,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Ein Fenster ohne Luecke: eine Minute, die gerade abgelaufen ist. */
function minuteWindow(atMs) {
  return { lastTickMs: atMs - 60_000, nowMs: atMs };
}

// --- Die Regel -----------------------------------------------------------------

test("nothing fires before the slot", () => {
  const schedule = task();
  // 02:58 → 03:00: der 03:00-Slot liegt noch nicht im Fenster.
  const window = minuteWindow(local(2026, 3, 14, 2, 59));
  assert.deepEqual(selectDueTasks([schedule], window), []);
});

test("exactly one fire on a slot", () => {
  const schedule = task();
  // Das Fenster endet genau auf dem Slot. `(last, now]` schliesst `now` ein —
  // deshalb gehoert der Slot hierher und nicht in den naechsten Tick.
  const due = selectDueTasks([schedule], minuteWindow(local(2026, 3, 14, 3, 0)));
  assert.equal(due.length, 1);
  assert.equal(due[0].task.id, "task-1");
  assert.equal(due[0].slotMs, local(2026, 3, 14, 3, 0));
});

test("a slot is never fired twice for the same window", () => {
  const schedule = task();
  const slot = local(2026, 3, 14, 3, 0);
  // Zweiter Tick mit dem Fenster, das den Slot schon enthaelt: der Slot liegt
  // jetzt hinter `lastTickMs` und ist nicht mehr faellig.
  assert.deepEqual(selectDueTasks([schedule], { lastTickMs: slot, nowMs: slot + 60_000 }), []);
});

test("a disabled task is skipped, even on its slot", () => {
  const slot = local(2026, 3, 14, 3, 0);
  assert.deepEqual(selectDueTasks([task({ enabled: false })], minuteWindow(slot)), []);
});

test("two tasks due in one window both fire, earliest first", () => {
  const early = task({ id: "frueh", cron: "0 3 * * *" });
  const late = task({ id: "spaet", cron: "30 3 * * *" });
  const window = { lastTickMs: local(2026, 3, 14, 2, 59), nowMs: local(2026, 3, 14, 3, 30) };
  const due = selectDueTasks([late, early], window);
  assert.deepEqual(due.map((entry) => entry.task.id), ["frueh", "spaet"]);
});

test("a six-hour outage fires once, not once per missed slot", () => {
  const schedule = task({ cron: "*/15 * * * *" });
  // Der Server war von 03:00 bis 09:00 aus. Vierundzwanzig Viertelstunden sind
  // verpasst; der Lauf kommt einmal, mit dem *ersten* Slot des Fensters.
  const due = selectDueTasks([schedule], {
    lastTickMs: local(2026, 3, 14, 3, 0),
    nowMs: local(2026, 3, 14, 9, 0),
  });
  assert.equal(due.length, 1);
  assert.equal(due[0].slotMs, local(2026, 3, 14, 3, 15));
});

test("a three-day outage still fires once per task", () => {
  const schedule = task({ cron: "* * * * *" });
  const due = selectDueTasks([schedule], {
    lastTickMs: local(2026, 3, 11, 0, 0),
    nowMs: local(2026, 3, 14, 0, 0),
  });
  assert.equal(due.length, 1);
});

test("a backward clock jump opens no window and fires nothing", () => {
  const schedule = task({ cron: "* * * * *" });
  // Die Uhr ist von 09:00 auf 08:00 gesprungen. `advanceCursor` haelt den
  // Zeiger auf 09:00, also ist das Fenster leer — und bleibt es, bis die Uhr
  // ihn wieder eingeholt hat.
  assert.deepEqual(selectDueTasks([schedule], { lastTickMs: local(2026, 3, 14, 9, 0), nowMs: local(2026, 3, 14, 8, 0) }), []);
  // Dasselbe Fenster der Laenge null.
  assert.deepEqual(selectDueTasks([schedule], { lastTickMs: local(2026, 3, 14, 9, 0), nowMs: local(2026, 3, 14, 9, 0) }), []);
});

test("a task with an unreadable cron is skipped instead of throwing", () => {
  const broken = task({ id: "kaputt", cron: "0 8 L * *" });
  const good = task({ id: "gut" });
  const due = selectDueTasks([broken, good], minuteWindow(local(2026, 3, 14, 3, 0)));
  assert.deepEqual(due.map((entry) => entry.task.id), ["gut"]);
});

test("a non-finite window yields nothing", () => {
  assert.deepEqual(selectDueTasks([task()], { lastTickMs: Number.NaN, nowMs: Date.now() }), []);
  assert.deepEqual(selectDueTasks([task()], { lastTickMs: Date.now(), nowMs: Number.POSITIVE_INFINITY }), []);
});

// --- Die naechste Weckzeit ------------------------------------------------------

test("the next wakeup is the earliest slot across the tasks", () => {
  const early = task({ id: "frueh", cron: "*/15 * * * *" });
  const late = task({ id: "spaet", cron: "0 3 * * *" });
  const after = local(2026, 3, 14, 10, 7);
  assert.equal(nextWakeupMs([late, early], after), local(2026, 3, 14, 10, 15));
});

test("a disabled task does not justify a timer", () => {
  assert.equal(nextWakeupMs([task({ enabled: false })], local(2026, 3, 14, 10, 0)), null);
  assert.equal(nextWakeupMs([], local(2026, 3, 14, 10, 0)), null);
});

test("the timer cap is one hour and is used as a cap, not a schedule", () => {
  // Ein Viertelstundenplan braucht keinen Stundentimer, aber ein Plan in vier
  // Wochen darf den Prozess nicht daran hindern, eine geaenderte Datei zu
  // bemerken. Der Deckel ist deshalb eine Konstante, und die Zahl steht hier.
  assert.equal(MAX_TIMER_DELAY_MS, 60 * 60 * 1000);
  const monthly = task({ cron: "0 3 1 * *" });
  const after = local(2026, 3, 2, 0, 0);
  const next = nextWakeupMs([monthly], after);
  assert.ok(next !== null);
  assert.ok(next - after > MAX_TIMER_DELAY_MS, "der naechste Slot liegt weiter weg als der Deckel");
});

// --- Arbeitsverzeichnis ---------------------------------------------------------

test("a task cwd must be absolute", () => {
  assert.equal(isUsableTaskCwd("/home/alice/workspace"), true);
  assert.equal(isUsableTaskCwd("workspace"), false);
  assert.equal(isUsableTaskCwd(""), false);
  assert.equal(isUsableTaskCwd("  /home/alice/workspace  "), false);
  assert.equal(isUsableTaskCwd(42), false);
});

// --- Kontenaufzaehlung ----------------------------------------------------------
//
// Die Aufzaehlung ist die riskanteste Stelle des Ticks: sie entscheidet, *wessen*
// Dateien ueberhaupt gelesen werden, und sie laeuft ohne Request (Karte R3).
// Ein Fehler hier ist still — die Aufgaben eines Kontos laufen dann einfach nie.

test("the tick enumerates the enabled accounts, the operator, and nothing else", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("fs");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  const crypto = await import("crypto");

  const root = mkdtempSync(join(tmpdir(), "omp-scheduler-accounts-"));
  const accountsFile = join(root, "accounts.json");
  const env = {
    ...process.env,
    OMP_WEB_HOME_ROOT: root,
    OMP_WEB_ACCOUNTS_FILE: accountsFile,
    USER: "operator",
  };
  /** Ein Digest, den `isUsableDigest` akzeptiert — sonst faellt das Konto weg. */
  const digest = () => ({
    algorithm: "scrypt",
    salt: crypto.randomBytes(16).toString("base64"),
    hash: crypto.randomBytes(32).toString("base64"),
    cost: 16384,
    blockSize: 8,
    parallelization: 1,
    keyLength: 64,
  });
  writeFileSync(accountsFile, JSON.stringify({
    version: 1,
    users: [
      { username: "alice", password: digest(), enabled: true },
      { username: "bob", password: digest(), enabled: true, isAdmin: true },
      { username: "carol", password: digest(), enabled: false },
    ],
    updatedAt: new Date().toISOString(),
  }));
  mkdirSync(join(root, "alice"), { recursive: true });
  mkdirSync(join(root, "bob"), { recursive: true });

  try {
    const { listScheduleIdentities } = await jiti.import("./scheduler.ts");
    const identities = listScheduleIdentities(env);
    assert.deepEqual(
      identities.map((identity) => identity.username),
      ["alice", "bob"],
      "carol ist deaktiviert und faellt weg; der Betreiber teilt sich das Verzeichnis mit bob",
    );
    // Zwei Verzeichnisse, nicht drei: bob (Admin) und der Betreiber zeigen auf
    // dasselbe Agent-Verzeichnis, und eine Datei zweimal zu lesen wuerde
    // dieselbe Aufgabe zweimal faellig machen. Verglichen wird deshalb der
    // Pfad, nicht der Name — verschiedene Namen koennen dasselbe Verzeichnis
    // meinen.
    const { resolveTenantAgentDir } = await jiti.import("./tenant-config.ts");
    assert.equal(new Set(identities.map((identity) => resolveTenantAgentDir(identity))).size, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable account list still leaves the operator's directory", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("fs");
  const { tmpdir } = await import("os");
  const { join } = await import("path");

  const root = mkdtempSync(join(tmpdir(), "omp-scheduler-broken-"));
  const accountsFile = join(root, "accounts.json");
  writeFileSync(accountsFile, "{kein json");
  try {
    const { listScheduleIdentities } = await jiti.import("./scheduler.ts");
    // Eine kaputte Kontendatei darf den Zeitplaner nicht anhalten: das
    // Prozessverzeichnis wird trotzdem gelesen, damit eine Installation ohne
    // Konten ihre Aufgaben behaelt.
    const identities = listScheduleIdentities({ ...process.env, OMP_WEB_HOME_ROOT: root,
      OMP_WEB_ACCOUNTS_FILE: accountsFile, USER: "operator" });
    assert.deepEqual(identities.map((identity) => identity.username), ["operator"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
