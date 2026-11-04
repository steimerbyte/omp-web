import assert from "node:assert/strict";
import test from "node:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";

async function loadSubject() {
  return import("./goal-mode.ts");
}

/**
 * `/goal set` bei einem **laufenden** Ziel.
 *
 * Der andere Weg (`set` startet ein Ziel) steht in `goal-mode.test.mjs`. Hier
 * geht es um die Verzweigung, die nur dann greift, wenn schon ein Ziel aktiv
 * ist: sie darf nicht neu starten (das wuerde das Ziel ersetzen und die
 * Werkzeuge erneut setzen), sondern ruft `replaceGoal` und uebernimmt dessen
 * Zustand. Ein Controller, der stattdessen `createGoal` riefe, verloere den
 * Fortschritt des alten Ziels und den Werkzeugsatz, den er sich gemerkt hat.
 */
function goal(overrides = {}) {
  return {
    id: "goal-1",
    objective: "alte Fassung",
    status: "active",
    tokensUsed: 100,
    timeUsedSeconds: 30,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function makeSession() {
  const calls = { replaceGoal: [], createGoal: [], stateChanges: [] };
  let state = { enabled: true, mode: "active", goal: goal() };

  const session = {
    isStreaming: false,
    calls,
    settings: Settings.isolated({ "goal.enabled": true }),
    sessionManager: {
      getEntries: () => [],
      appendModeChange: () => {},
      appendCustomEntry: () => {},
    },
    getGoalModeState: () => state,
    setGoalModeState: (next) => { state = next; calls.stateChanges.push(next); },
    getEnabledToolNames: () => ["read", "bash"],
    setActiveToolsByName: async () => {},
    sendGoalModeContext: async () => {},
    getPlanModeState: () => undefined,
    goalRuntime: {
      replaceGoal: async ({ objective }) => {
        calls.replaceGoal.push(objective);
        return { enabled: true, mode: "active", goal: goal({ id: "goal-2", objective }) };
      },
      createGoal: async ({ objective }) => {
        calls.createGoal.push(objective);
        return { enabled: true, mode: "active", goal: goal({ objective }) };
      },
    },
  };
  return session;
}

test("setting an objective while a goal is active replaces it in place", async () => {
  const { GoalModeController } = await loadSubject();
  const session = makeSession();
  const controller = new GoalModeController(session, { cwd: "/tmp" });

  const result = await controller.handleCommand("set neue Fassung");

  assert.deepEqual(session.calls.replaceGoal, ["neue Fassung"]);
  assert.deepEqual(session.calls.createGoal, [], "ein laufendes Ziel wird ersetzt, nicht neu gestartet");
  assert.equal(result.prompt, "neue Fassung");
  assert.equal(result.message, "Goal replaced.");
  assert.equal(result.status?.objective, "neue Fassung");
  assert.equal(controller.getStatus()?.objective, "neue Fassung", "der Zustand ist uebernommen");
  controller.dispose();
});

test("setting an objective without text explains the usage", async () => {
  const { GoalModeController } = await loadSubject();
  const session = makeSession();
  const controller = new GoalModeController(session, { cwd: "/tmp" });

  const result = await controller.handleCommand("set");

  assert.deepEqual(session.calls.replaceGoal, []);
  assert.match(result.error, /Usage: \/goal set/);
  controller.dispose();
});

test("a paused goal must be resumed before a new objective", async () => {
  const { GoalModeController } = await loadSubject();
  const session = makeSession();
  // `enabled` false *und* das Ziel als pausiert markiert: nur das ist "pausiert".
  session.getGoalModeState = () => ({ enabled: false, mode: "active", goal: goal({ status: "paused" }) });
  const controller = new GoalModeController(session, { cwd: "/tmp" });

  const result = await controller.handleCommand("set neue Fassung");

  assert.deepEqual(session.calls.replaceGoal, []);
  assert.deepEqual(session.calls.createGoal, []);
  assert.match(result.error, /Resume the current goal first/);
  controller.dispose();
});
