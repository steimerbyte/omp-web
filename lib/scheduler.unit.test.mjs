import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { refreshDirsFromEnv, setAgentDir } from "@oh-my-pi/pi-utils";

async function loadSubject() {
  return import("./scheduler.ts");
}

/**
 * Der Betrieb des Zeitplaners: Timer stellen, ticken, wieder stellen.
 *
 * Die Regel "welche Aufgabe ist faellig" steht ohne Timer in
 * `scheduler.test.mjs`. Hier steht, was nur mit einem Timer sichtbar ist:
 * `startScheduler` haelt genau einen, ein Tick stellt ihn neu, und der Zeiger
 * (`cursorMs`) bleibt monoton — ein Rueckwaertssprung der Uhr darf denselben
 * Slot nicht zweimal faellig machen.
 *
 * `setAgentDir`/`refreshDirsFromEnv` sind der offizielle Weg, das
 * Agent-Verzeichnis der SDK umzuhaengen (sie wird beim ersten Import einmal
 * aufgeloest). Ohne das schriebe dieser Test in das echte `~/.omp`.
 *
 * Uhr und Timer sind ersetzt: der naechste Slot liegt bis zu eine Stunde
 * entfernt, und ein echter Timer waere entweder ein Warten von einer Minute
 * oder ein Test, der eine echte Session startet. Mit stillstehender Uhr ist das
 * Fenster eines Ticks leer, also kann keine Aufgabe laufen.
 */
function withTempEnv(run) {
  const root = mkdtempSync(join(tmpdir(), "omp-scheduler-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  const previous = {
    HOME: process.env.HOME,
    USER: process.env.USER,
    OMP_WEB_HOME_ROOT: process.env.OMP_WEB_HOME_ROOT,
    OMP_WEB_ACCOUNTS_FILE: process.env.OMP_WEB_ACCOUNTS_FILE,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  };
  process.env.HOME = root;
  process.env.USER = "operator";
  process.env.OMP_WEB_HOME_ROOT = join(root, "homes");
  // Keine Kontendatei: der Zeitplaner liest dann nur das Prozessverzeichnis.
  process.env.OMP_WEB_ACCOUNTS_FILE = join(root, "accounts.json");
  setAgentDir(agentDir);

  return {
    agentDir,
    run: async () => {
      try {
        return await run({ agentDir });
      } finally {
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        refreshDirsFromEnv();
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

function withFakeClock(run) {
  const realSetTimeout = globalThis.setTimeout;
  const realDateNow = Date.now;
  const timers = [];
  let now = Date.parse("2026-11-04T09:15:00.000Z");
  globalThis.setTimeout = (callback, delayMs) => {
    timers.push({ callback, delayMs });
    return { unref() {} };
  };
  Date.now = () => now;

  return {
    timers,
    realSetTimeout,
    advance(ms) { now += ms; },
    run: async () => {
      try {
        return await run({ timers, advance: (ms) => { now += ms; } });
      } finally {
        Date.now = realDateNow;
        globalThis.setTimeout = realSetTimeout;
      }
    },
  };
}

/** Genug Mikrotasks und ein Makrotask, bis der Tick fertig ist. */
async function settle(realSetTimeout) {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => realSetTimeout(resolve, 0));
}

function writeTasks(agentDir, tasks) {
  writeFileSync(
    join(agentDir, "omp-web-scheduled-tasks.json"),
    JSON.stringify({ schemaVersion: 1, tasks }),
  );
}

function task(overrides = {}) {
  return {
    id: "task-1",
    name: "Nachtlauf",
    cron: "0 3 * * *",
    prompt: "Fasse den Tag zusammen.",
    provider: "test-provider",
    modelId: "test-model",
    enabled: true,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

test("starting arms exactly one timer and stopping disarms it", async () => {
  const { isSchedulerArmed, startScheduler, stopScheduler } = await loadSubject();
  const env = withTempEnv(async ({ agentDir }) => {
    writeTasks(agentDir, [task()]);
    const clock = withFakeClock(async ({ timers }) => {
      try {
        startScheduler();
        assert.equal(isSchedulerArmed(), true);
        assert.equal(timers.length, 1, "ein Timer fuer alle Aufgaben, nicht einer je Aufgabe");
        assert.ok(timers[0].delayMs > 0, "der Timer steht auf den naechsten Slot");

        // Ein zweiter Start ist ein No-op (Hot-Reload, zweiter Import).
        startScheduler();
        assert.equal(timers.length, 1);
      } finally {
        stopScheduler();
      }
      assert.equal(isSchedulerArmed(), false);
    });
    await clock.run();
  });

  await env.run();
});

test("a tick re-arms the timer and keeps the cursor monotonic", async () => {
  const { isSchedulerArmed, nextScheduledRunMs, startScheduler, stopScheduler } = await loadSubject();
  const env = withTempEnv(async ({ agentDir }) => {
    writeTasks(agentDir, [task()]);
    const clock = withFakeClock(async ({ timers, advance }) => {
      try {
        startScheduler();
        assert.equal(timers.length, 1);
        assert.equal(typeof nextScheduledRunMs(), "number", "die Aufgabe hat einen naechsten Slot");

        // Erster Tick: die Uhr steht, das Fenster ist leer, der Timer wird neu gestellt.
        timers.shift().callback();
        await settle(clock.realSetTimeout);
        assert.equal(timers.length, 1, "der Tick hat den naechsten Timer gestellt");
        assert.equal(isSchedulerArmed(), true);

        // Zweiter Tick mit vorgestellter Uhr: der Zeiger zieht nach, das
        // Fenster reicht bis zur neuen Zeit.
        advance(1000);
        timers.shift().callback();
        await settle(clock.realSetTimeout);
        assert.equal(timers.length, 1);
      } finally {
        stopScheduler();
      }
    });
    await clock.run();
  });

  await env.run();
});

test("without a task nothing is armed and no next run exists", async () => {
  const { isSchedulerArmed, nextScheduledRunMs, startScheduler, stopScheduler } = await loadSubject();
  const env = withTempEnv(async ({ agentDir }) => {
    writeTasks(agentDir, []);
    const clock = withFakeClock(async ({ timers }) => {
      try {
        startScheduler();
        assert.equal(timers.length, 0, "ohne Aufgabe gibt es keinen Slot zu erwarten");
        assert.equal(isSchedulerArmed(), false);
        assert.equal(nextScheduledRunMs(), null);
      } finally {
        stopScheduler();
      }
    });
    await clock.run();
  });

  await env.run();
});

test("a disabled task neither arms the timer nor names a next run", async () => {
  const { isSchedulerArmed, nextScheduledRunMs, startScheduler, stopScheduler } = await loadSubject();
  const env = withTempEnv(async ({ agentDir }) => {
    writeTasks(agentDir, [task({ enabled: false })]);
    const clock = withFakeClock(async ({ timers }) => {
      try {
        startScheduler();
        assert.equal(timers.length, 0);
        assert.equal(isSchedulerArmed(), false);
        assert.equal(nextScheduledRunMs(), null);
      } finally {
        stopScheduler();
      }
    });
    await clock.run();
  });

  await env.run();
});
