import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./vibe-mode.ts");
}

/**
 * A stand-in for the SDK session. The real worker registry is never touched:
 * the controller takes `registry` in its options and every test injects a stub.
 */
function makeSession(options = {}) {
  const entries = options.entries ?? [];
  const calls = {
    activate: [],
    deactivate: [],
    modeChanges: [],
    contexts: [],
    aborted: 0,
    teardowns: 0,
  };
  let tools = options.tools ?? ["read", "bash", "edit"];
  let state = options.state;
  let streaming = options.isStreaming ?? false;

  const session = {
    isStreaming: streaming,
    calls,
    settings: {},
    sessionManager: {
      getEntries: () => entries,
      appendModeChange: (mode, data) => {
        calls.modeChanges.push({ mode, data });
        entries.push({ type: "mode_change", mode, data });
        return `entry-${calls.modeChanges.length}`;
      },
      getSessionId: () => "session-1",
      getSessionFile: () => options.sessionFile ?? null,
    },
    getAgentId: () => "main",
    getActiveModelString: () => undefined,
    get toolNames() {
      return tools;
    },
    getEnabledToolNames: () => tools,
    hasBuiltInTool: (name) => (options.builtIn ?? ["todo"]).includes(name),
    activateVibeTools: async (base) => {
      calls.activate.push(base);
      if (options.activateGate) {
        options.activateGate.started.resolve();
        await options.activateGate.release.promise;
      }
      tools = [...base, "vibe_spawn", "vibe_send"];
    },
    deactivateVibeTools: async (next) => {
      calls.deactivate.push(next);
      tools = next;
    },
    sendVibeModeContext: async (contextOptions) => {
      calls.contexts.push(contextOptions);
    },
    abort: async () => {
      calls.aborted += 1;
      streaming = false;
    },
  };
  if (options.teardown !== false) {
    session.runModeExitTeardown = async (teardown) => {
      calls.teardowns += 1;
      await teardown();
    };
  }
  if (options.noModeState !== true) {
    session.getVibeModeState = () => state;
    session.setVibeModeState = (next) => {
      state = next;
    };
  }
  // Only present when a test asks for the branch-resolved view; otherwise the
  // controller falls back to the flat ledger, which the other tests exercise.
  if (options.context) session.sessionManager.buildSessionContext = () => options.context;
  return session;
}

function deferred() {
  const box = {};
  box.promise = new Promise((resolve) => {
    box.resolve = resolve;
  });
  return box;
}

function makeRegistry(options = {}) {
  const scope = { ownerId: "main", parentSessionId: "session-1", parentSessionFile: null };
  const calls = { scopes: 0, activated: 0, rehydrated: 0, killAll: 0, listed: 0 };
  return {
    calls,
    ownerScope: () => {
      calls.scopes += 1;
      return scope;
    },
    activateScope: () => {
      calls.activated += 1;
    },
    listIds: () => {
      calls.listed += 1;
      return options.ids ?? [];
    },
    rehydrate: async () => {
      calls.rehydrated += 1;
      if (options.rehydrateFails && calls.rehydrated <= options.rehydrateFails) {
        throw new Error("rehydrate failed");
      }
      return 0;
    },
    killAll: async () => {
      calls.killAll += 1;
      return options.killed ?? 0;
    },
  };
}

function setup(options = {}) {
  return loadSubject().then(({ VibeModeController }) => {
    const session = makeSession(options.session);
    const registry = makeRegistry(options.registry);
    const statuses = [];
    const controller = new VibeModeController(session, {
      onStatus: (status) => statuses.push(status),
      conflicts: options.conflicts,
      registry,
    });
    return { controller, session, registry, statuses };
  });
}

test("/vibe parses its subcommand, and anything else is a task", async () => {
  const { parseVibeCommand } = await loadSubject();
  const cases = [
    ["", "toggle"],
    ["   ", "toggle"],
    ["on", "on"],
    ["start", "on"],
    ["ENTER", "on"],
    ["off", "off"],
    ["exit", "off"],
    ["Stop", "off"],
    ["status", "status"],
  ];
  for (const [args, action] of cases) {
    assert.deepEqual(parseVibeCommand(args), { action }, args);
  }
  assert.deepEqual(parseVibeCommand("write a poem"), { action: "on", prompt: "write a poem" });
  assert.deepEqual(parseVibeCommand("  fix the failing tests  "), { action: "on", prompt: "fix the failing tests" });
  // A task word must not be read through Object.prototype.
  assert.deepEqual(parseVibeCommand("constructor"), { action: "on", prompt: "constructor" });
});

test("entering reduces the toolset to read + todo and records the previous set", async () => {
  const { controller, session, registry, statuses } = await setup();
  const result = await controller.handleCommand("");

  assert.deepEqual(session.calls.activate, [["read", "todo"]]);
  assert.deepEqual(session.calls.modeChanges, [{ mode: "vibe", data: { previousTools: ["read", "bash", "edit"] } }]);
  assert.deepEqual(result.status, { enabled: true, workers: 0 });
  assert.equal(result.prompt, undefined);
  assert.match(result.message, /Vibe mode enabled/);
  assert.equal(registry.calls.activated, 1, "spawn admission reopened for the owner scope");
  assert.deepEqual(statuses.at(-1), { enabled: true, workers: 0 });
});

test("a session without the todo builtin enters with read alone", async () => {
  const { controller, session } = await setup({ session: { builtIn: [] } });
  await controller.handleCommand("on");
  assert.deepEqual(session.calls.activate, [["read"]]);
});

test("a streaming session is steered into the new mode", async () => {
  const streaming = await setup({ session: { isStreaming: true } });
  await streaming.controller.handleCommand("on");
  assert.deepEqual(streaming.session.calls.contexts, [{ deliverAs: "steer" }]);

  const idle = await setup();
  await idle.controller.handleCommand("on");
  assert.deepEqual(idle.session.calls.contexts, []);
});

test("free text enters the mode and comes back as the prompt to submit", async () => {
  const { controller, session } = await setup();
  const result = await controller.handleCommand("write a poem");
  assert.equal(result.prompt, "write a poem");
  assert.deepEqual(session.calls.activate, [["read", "todo"]]);
  assert.equal(result.status?.enabled, true);
});

test("a second on keeps the toolset, a toggle turns the mode off", async () => {
  const { controller, session } = await setup();
  await controller.handleCommand("on");
  const again = await controller.handleCommand("on");
  assert.deepEqual(session.calls.activate, [["read", "todo"]], "already enabled: no second activation");
  assert.equal(again.status?.enabled, true);

  const toggled = await controller.handleCommand("");
  assert.equal(toggled.status, null);
  assert.deepEqual(session.calls.deactivate, [["read", "bash", "edit"]]);
});

test("two overlapping entries activate once and keep the pre-vibe snapshot", async () => {
  const { controller, session } = await setup();
  const [first, second] = await Promise.all([controller.handleCommand("on"), controller.handleCommand("on")]);

  assert.deepEqual(session.calls.activate, [["read", "todo"]], "the second /vibe joins the first entry");
  assert.equal(session.calls.modeChanges.length, 1, "exactly one mode_change");
  assert.deepEqual(session.calls.modeChanges[0].data.previousTools, ["read", "bash", "edit"]);
  assert.equal(first.status?.enabled, true);
  assert.equal(second.status?.enabled, true);
});

test("an in-flight entry is pending and not yet enabled", async () => {
  const gate = { started: deferred(), release: deferred() };
  const { controller } = await setup({ session: { activateGate: gate } });

  const entering = controller.handleCommand("on");
  await gate.started.promise;

  assert.equal(controller.isPending(), true, "a tool-set change must be refused mid-entry");
  assert.equal(controller.getStatus(), null, "the mode is not enabled until the entry settles");

  gate.release.resolve();
  const result = await entering;
  assert.equal(controller.isPending(), false);
  assert.deepEqual(result.status, { enabled: true, workers: 0 });
});

test("an off typed during a slow entry leaves the mode disabled", async () => {
  const gate = { started: deferred(), release: deferred() };
  const { controller, session } = await setup({ session: { activateGate: gate } });

  const entering = controller.handleCommand("on");
  await gate.started.promise;
  const leaving = controller.handleCommand("off");
  gate.release.resolve();

  await entering;
  const result = await leaving;
  assert.doesNotMatch(result.message, /not enabled/);
  assert.equal(result.message, "Vibe mode disabled.");
  assert.deepEqual(session.calls.deactivate, [["read", "bash", "edit"]], "the pre-entry snapshot is restored");
  assert.equal(controller.getStatus(), null, "the entry completed, then the off left");
});

test("exiting tears down inside runModeExitTeardown and leaves the mode_change to killAll", async () => {
  const { controller, session, registry, statuses } = await setup({
    session: { isStreaming: true },
    registry: { killed: 2 },
  });
  await controller.handleCommand("");
  const result = await controller.handleCommand("off");

  assert.equal(session.calls.teardowns, 1);
  assert.equal(session.calls.aborted, 1);
  assert.equal(registry.calls.killAll, 1);
  assert.deepEqual(session.calls.deactivate, [["read", "bash", "edit"]]);
  assert.equal(session.getVibeModeState(), undefined);
  // killAll writes the "none" entry itself (atomically, and its zero-record
  // path already leaves the ledger there); the controller must not double it.
  assert.deepEqual(
    session.calls.modeChanges.map((change) => change.mode),
    ["vibe"],
    "no second mode_change from the controller",
  );
  assert.equal(result.message, "Vibe mode disabled. Killed 2 worker sessions.");
  assert.equal(result.status, null);
  assert.equal(statuses.at(-1), null);
});

test("exit reports a single killed worker without plural and survives a missing teardown hook", async () => {
  const { controller, session } = await setup({ session: { teardown: false }, registry: { killed: 1 } });
  await controller.handleCommand("on");
  const result = await controller.handleCommand("off");
  assert.equal(session.calls.teardowns, 0);
  assert.equal(result.message, "Vibe mode disabled. Killed 1 worker session.");
});

test("leaving a mode that is not on does nothing", async () => {
  const { controller, session, registry } = await setup();
  const result = await controller.handleCommand("off");
  assert.equal(result.message, "Vibe mode is not enabled.");
  assert.equal(result.status, null);
  assert.equal(session.calls.teardowns, 0);
  assert.equal(registry.calls.killAll, 0);
  assert.deepEqual(session.calls.modeChanges, []);
});

test("a persisted vibe mode is restored without a new mode_change", async () => {
  const entries = [
    { type: "mode_change", mode: "none" },
    { type: "mode_change", mode: "vibe", data: { previousTools: ["read", "bash"] } },
  ];
  const { controller, session, registry } = await setup({ session: { entries } });
  await controller.restore();

  assert.equal(registry.calls.rehydrated, 1);
  assert.deepEqual(session.calls.activate, [["read", "todo"]]);
  assert.equal(controller.getStatus()?.enabled, true);
  assert.deepEqual(session.calls.modeChanges, [], "restore must not append a second entry");
});

test("restore ignores a session whose last mode change is not vibe", async () => {
  const entries = [{ type: "mode_change", mode: "goal", data: { objective: "x" } }];
  const { controller, session, registry } = await setup({ session: { entries } });
  await controller.restore();
  assert.equal(registry.calls.rehydrated, 0);
  assert.deepEqual(session.calls.activate, []);
  assert.equal(controller.getStatus(), null);
});

test("restore runs once even when called again", async () => {
  const entries = [{ type: "mode_change", mode: "vibe", data: { previousTools: ["read"] } }];
  const { controller, session } = await setup({ session: { entries } });
  await Promise.all([controller.restore(), controller.restore()]);
  await controller.restore();
  assert.deepEqual(session.calls.activate, [["read", "todo"]]);
});

test("a command acts on the restored state, not the unrestored one", async () => {
  const entries = [{ type: "mode_change", mode: "vibe", data: { previousTools: ["read", "bash"] } }];
  const { controller, session } = await setup({ session: { entries } });
  const result = await controller.handleCommand("off");
  assert.deepEqual(session.calls.activate, [["read", "todo"]], "restore entered first");
  assert.deepEqual(session.calls.deactivate, [["read", "bash"]]);
  assert.equal(result.status, null);
  assert.deepEqual(session.calls.modeChanges, [], "restore and exit leave the ledger to the SDK");
});

test("a conflict blocks entry but never traps a session already in the mode", async () => {
  const conflict = { value: undefined };
  const { controller, session } = await setup({ conflicts: () => conflict.value });
  await controller.handleCommand("on");
  conflict.value = "Exit plan mode first.";

  assert.equal((await controller.handleCommand("status")).status?.enabled, true);
  const result = await controller.handleCommand("off");
  assert.equal(result.error, undefined);
  assert.equal(result.status, null);
  assert.deepEqual(session.calls.deactivate, [["read", "bash", "edit"]]);
});

test("a partly invalid tool snapshot falls back to the live toolset", async () => {
  const entries = [{ type: "mode_change", mode: "vibe", data: { previousTools: ["read", 42] } }];
  const { controller, session } = await setup({ session: { entries } });
  await controller.restore();
  assert.deepEqual(session.calls.activate, [["read", "todo"]]);
  await controller.handleCommand("off");
  assert.deepEqual(session.calls.deactivate, [["read", "bash", "edit"]], "the live set, not the broken record");
});

test("an empty persisted snapshot falls back to the live toolset", async () => {
  const entries = [{ type: "mode_change", mode: "vibe", data: { previousTools: [] } }];
  const { controller, session } = await setup({ session: { entries } });
  await controller.restore();
  assert.equal(controller.getStatus()?.enabled, true);
  await controller.handleCommand("off");
  assert.deepEqual(session.calls.deactivate, [["read", "bash", "edit"]], "the live set, not the empty record");
});

test("an empty snapshot with no live tools refuses to enter and leaves the toolset alone", async () => {
  const entries = [{ type: "mode_change", mode: "vibe", data: { previousTools: [] } }];
  const { controller, session } = await setup({ session: { entries, tools: [] } });
  await controller.restore();
  assert.deepEqual(session.calls.activate, []);
  assert.deepEqual(session.toolNames, []);

  const result = await controller.handleCommand("on");
  assert.equal(result.error, "Enable tools before entering vibe mode.");
  assert.equal(controller.getStatus(), null);
  assert.deepEqual(session.calls.activate, []);
});

test("the branch-resolved mode decides restore, not the flat ledger", async () => {
  // navigate_tree can leave a "vibe" entry behind on a dead branch.
  const removed = await setup({
    session: { entries: [{ type: "mode_change", mode: "vibe" }], context: { mode: "none" } },
  });
  await removed.controller.restore();
  assert.equal(removed.registry.calls.rehydrated, 0);
  assert.deepEqual(removed.session.calls.activate, []);

  const active = await setup({
    session: {
      entries: [{ type: "mode_change", mode: "none" }],
      context: { mode: "vibe", modeData: { previousTools: ["read", "bash"] } },
    },
  });
  await active.controller.restore();
  assert.equal(active.registry.calls.rehydrated, 1);
  await active.controller.handleCommand("off");
  assert.deepEqual(active.session.calls.deactivate, [["read", "bash"]]);
});

test("a failed restore is retried by the next attempt", async () => {
  const entries = [{ type: "mode_change", mode: "vibe", data: { previousTools: ["read", "bash"] } }];
  const { controller, session, registry } = await setup({ session: { entries }, registry: { rehydrateFails: 1 } });
  await assert.rejects(controller.restore());
  await controller.restore();
  assert.equal(registry.calls.rehydrated, 2);
  assert.deepEqual(session.calls.activate, [["read", "todo"]]);
  assert.equal(controller.getStatus()?.enabled, true);
});

test("a mode conflict is refused before any toolset change", async () => {
  const { controller, session, registry } = await setup({ conflicts: () => "Exit plan mode first." });
  const result = await controller.handleCommand("on");
  assert.equal(result.error, "Exit plan mode first.");
  assert.equal(result.status, null);
  assert.deepEqual(session.calls.activate, []);
  assert.equal(registry.calls.scopes, 0);
});

test("an empty toolset is refused", async () => {
  const { controller, session } = await setup({ session: { tools: [] } });
  const result = await controller.handleCommand("");
  assert.equal(result.error, "Enable tools before entering vibe mode.");
  assert.deepEqual(session.calls.activate, []);
  assert.deepEqual(session.calls.modeChanges, []);
});

test("a session that cannot hold a mode state is refused before the toolset shrinks", async () => {
  const { controller, session, registry } = await setup({ session: { noModeState: true } });
  const result = await controller.handleCommand("on");
  assert.match(result.error, /cannot enter vibe mode/);
  assert.deepEqual(session.calls.activate, [], "no reduce-then-forget");
  assert.equal(registry.calls.scopes, 0);
});

test("status reports the live worker count and nothing when off", async () => {
  const off = await setup();
  const offResult = await off.controller.handleCommand("status");
  assert.equal(offResult.status, null);
  assert.equal(offResult.message, "Vibe mode is not enabled.");

  const on = await setup({ registry: { ids: ["fast-1", "good-2"] } });
  await on.controller.handleCommand("on");
  const onResult = await on.controller.handleCommand("status");
  assert.deepEqual(onResult.status, { enabled: true, workers: 2 });
  assert.match(onResult.message, /2 worker sessions active/);
});
