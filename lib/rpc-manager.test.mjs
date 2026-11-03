import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./rpc-manager.ts");
  } catch {
    return import("./rpc-manager.ts");
  }
}

const { AgentSessionWrapper, resolveForkEntryId } = await loadSubject();

function makeEventBus() {
  return { on: () => () => {} };
}

function makeInner(overrides = {}) {
  return Object.assign({
    sessionId: "old-session",
    sessionFile: "/tmp/omp-web-old-session.jsonl",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    configuredThinkingLevel: () => undefined,
    model: undefined,
    agent: { state: {} },
    extensionRunner: undefined,
    queuedMessageCount: 0,
    getContextUsage: () => undefined,
    getQueuedMessages: () => ({ steering: [], followUp: [] }),
    abort: async () => {},
    abortBash: () => {},
    dispose: async () => {},
    handoff: async () => undefined,
  }, overrides);
}

// A session that can actually enter and leave vibe mode: the real controller
// drives it, so the mode gates are exercised instead of asserted from source.
function makeModeSession(overrides = {}) {
  const state = { vibeOn: false, activeTools: ["read", "bash", "edit"] };
  const session = Object.assign({
    sessionId: "s1",
    sessionFile: "",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    configuredThinkingLevel: () => undefined,
    model: undefined,
    agent: { state: {} },
    extensionRunner: undefined,
    queuedMessageCount: 0,
    getContextUsage: () => undefined,
    getQueuedMessages: () => ({ steering: [], followUp: [] }),
    abort: async () => {},
    abortBash: () => {},
    dispose: async () => {},
    subscribe: () => () => {},
    settings: Settings.isolated({}),
    sessionManager: {
      appendModeChange: () => "entry",
      getEntries: () => [],
      getBranch: () => [],
      getSessionId: () => "s1",
      getSessionFile: () => "",
    },
    getEnabledToolNames: () => state.activeTools,
    getActiveToolNames: () => state.activeTools,
    getAllToolNames: () => state.activeTools,
    setActiveToolsByName: async (names) => {
      state.activeTools = names;
    },
    activateVibeTools: async (base) => {
      state.activeTools = [...base, "vibe"];
    },
    deactivateVibeTools: async (next) => {
      state.activeTools = next;
    },
    hasBuiltInTool: () => true,
    getAgentId: () => undefined,
    getActiveModelString: () => undefined,
    getVibeModeState: () => (state.vibeOn ? { enabled: true } : undefined),
    setVibeModeState: (next) => {
      state.vibeOn = next?.enabled === true;
    },
  }, overrides);
  return { session, state };
}

function pausedGoalState() {
  return {
    enabled: false,
    mode: "active",
    goal: {
      id: "goal-1",
      objective: "ship it",
      status: "paused",
      tokensUsed: 10,
      timeUsedSeconds: 5,
      createdAt: 1,
      updatedAt: 2,
    },
  };
}

test("RPC session startup reuses the shared omp runtime instead of a per-session one", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /getOmpRuntime\(\)/);
  assert.match(startupSource, /getSettingsForIdentity\(identity, sessionCwd\)/);
  assert.match(startupSource, /modelRegistry,/);
});

test("a tenant session uses its own settings but keeps the process agent directory", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  // Skills are discovered from the *effective Settings instance*, so a session
  // built with the process settings would list the operator's store for every
  // tenant. The agent directory must stay the process one: omp's loader ignores
  // the `agentDir` option for skills, and moving it would split credentials,
  // memory and `agent.db` from them (measured in AGENTDIR-SCAN.md).
  assert.match(startupSource, /const identity = options\.identity \?\? null/);
  assert.match(startupSource, /const agentDir = getAgentDir\(\)/);
  assert.doesNotMatch(startupSource, /agentDir = ensureTenantAgentDir/);
  assert.match(startupSource, /ensureTenantSkillsRegistration\(identity\)/);
  // Preferences must land in the session's own config.yml, not the operator's.
  assert.match(startupSource, /persistExplicitStartupPreferences\(\s*settings/);
});

test("RPC session startup applies the load policy before creating the session", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const policyIndex = startupSource.indexOf("resolveSessionLoads(identity, sessionCwd, settings)");
  const createIndex = startupSource.indexOf("createAgentSession(sessionOptions)");

  assert.ok(policyIndex >= 0);
  assert.ok(createIndex > policyIndex);
  // The policy's options are spread whole: one enforcement point for the
  // pre-built lists, the MCP switch and the project gate (`lib/load-policy.ts`).
  assert.match(startupSource, /\.\.\.loads\.options/);
  // Skills stay in `loadSessionSkills`; the policy only reports whether trust
  // narrowed this project.
  assert.match(startupSource, /loads\.narrowed/);
});

test("RPC session startup applies SYSTEM.md / APPEND_SYSTEM.md to the session options", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const resolveIndex = startupSource.indexOf("const systemPrompts = loads.systemPrompts");
  const applyIndex = startupSource.indexOf("applyResolvedSystemPromptInputs(");
  const createIndex = startupSource.indexOf("createAgentSession(sessionOptions)");

  assert.ok(resolveIndex >= 0);
  assert.ok(applyIndex > resolveIndex);
  assert.ok(createIndex > applyIndex);
  assert.match(
    startupSource,
    /applyResolvedSystemPromptInputs\(sessionOptions, systemPrompts\.systemPrompt, systemPrompts\.appendPrompt\)/,
  );
});

test("RPC session startup resolves and passes the SDK-native enabled model scope", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const resolveIndex = startupSource.indexOf("resolveVisibleModels(");
  const createIndex = startupSource.indexOf("createAgentSession(");

  assert.ok(resolveIndex >= 0);
  assert.ok(createIndex > resolveIndex);
  assert.match(startupSource, /selectInitialModelScope\(/);
  assert.match(startupSource, /scopedModels: initial\.scopedModels/);
  assert.match(startupSource, /model: initial\.model/);
  assert.match(startupSource, /thinkingLevel: initial\.thinkingLevel/);
});

test("RPC session startup treats only sessions with messages as continuing", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(
    startupSource,
    /const hasExistingMessages = sessionManager\.buildSessionContext\(\)\.messages\.length > 0/,
  );
  assert.match(startupSource, /const initial = hasExistingMessages/);
  assert.doesNotMatch(startupSource, /const initial = sessionFile/);
  assert.doesNotMatch(startupSource, /const hasExistingMessages = sessionManager\.getBranch\(\)/);
});

test("RPC session startup opens an existing session file only once and trusts its cwd", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const routeSource = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const eventRouteSource = await readFile(new URL("../app/api/agent/[id]/events/route.ts", import.meta.url), "utf8");
  const autoNameRouteSource = await readFile(new URL("../app/api/sessions/[id]/auto-name/route.ts", import.meta.url), "utf8");

  assert.equal((startupSource.match(/SessionManager\.open\(/g) ?? []).length, 1);
  assert.match(startupSource, /const sessionCwd = sessionManager\.getCwd\(\)/);
  assert.match(startupSource, /resolveSessionLoads\(identity, sessionCwd, settings\)/);
  assert.match(startupSource, /cwd: sessionCwd/);
  for (const route of [routeSource, eventRouteSource, autoNameRouteSource]) {
    assert.doesNotMatch(route, /SessionManager\.open\(/);
  }
});

test("RPC wrapper avoids per-chunk idle and running-state maintenance", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startSource = source.slice(
    source.indexOf("  start(): void"),
    source.indexOf("  setForceEmptySystemPrompt"),
  );
  const notifySource = source.slice(
    source.indexOf("export function notifyRunningChange"),
    source.indexOf("export async function startRpcSession"),
  );

  assert.match(startSource, /IDLE_RESET_EVENT_TYPES\.has\(event\.type\)/);
  assert.match(startSource, /RUNNING_STATE_EVENT_TYPES\.has\(event\.type\)/);
  assert.doesNotMatch(startSource, /subscribe\(\(event: AgentEvent\) => \{\s*this\.resetIdleTimer\(\)/);
  assert.match(notifySource, /if \(listeners\.size === 0\)/);
  assert.match(notifySource, /lastRunningSnapshot = ""/);
});

test("normal session teardown paths use graceful extension shutdown", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const deleteRouteSource = await readFile(new URL("../app/api/sessions/[id]/route.ts", import.meta.url), "utf8");
  const trustRouteSource = await readFile(new URL("../app/api/project-trust/route.ts", import.meta.url), "utf8");
  const idleSource = source.slice(
    source.indexOf("  private resetIdleTimer"),
    source.indexOf("  private persistBashOnlySession"),
  );
  const forkSource = source.slice(
    source.indexOf('case "fork"'),
    source.indexOf('case "navigate_tree"'),
  );

  assert.match(idleSource, /this\.shutdown\(\)/);
  assert.match(forkSource, /await this\.shutdownAfterCommittedFork\(newSessionId\)/);
  assert.match(deleteRouteSource, /await getRpcSession\(id\)\?\.shutdown\(\)/);
  assert.match(trustRouteSource, /await destroyRpcSessionsForCwd\(result\.cwd\)/);
});

test("new-session route applies model scope during construction instead of follow-up commands", async () => {
  const source = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");

  assert.match(source, /initialModel: \{ provider, modelId \}/);
  assert.match(source, /thinkingLevel: explicitThinkingLevel/);
  assert.doesNotMatch(source, /session\.send\(\{ type: "set_model"/);
  assert.doesNotMatch(source, /session\.send\(\{ type: "set_thinking_level"/);
  assert.match(source, /model: state\.model/);
  assert.match(source, /thinkingLevel: state\.thinkingLevel/);
});

test("RPC session startup persists explicit preferences without replaying setters", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  // The session's Settings are the caller's: a tenant's model choice must land
  // in their `config.yml`, not the operator's.
  assert.match(startupSource, /persistExplicitStartupPreferences\(\s*settings/);
  assert.match(startupSource, /modelDefaultChanged\) invalidateModelsCache\(\)/);
});

test("custom extension UI receives the fixed headless terminal facade", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const customUiSource = source.slice(
    source.indexOf("private requestExtensionCustomUi"),
    source.indexOf("private requestExtensionUi"),
  );

  assert.match(customUiSource, /createHeadlessCustomUiTui\(/);
  assert.match(customUiSource, /width,/);
});

test("reloading a session invalidates the models cache", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const reloadSource = source.slice(
    source.indexOf('case "reload"'),
    source.indexOf('case "abort_compaction"'),
  );

  assert.match(reloadSource, /await this\.inner\.reload\(\)/);
  assert.match(reloadSource, /this\.applyForcedEmptySystemPrompt\(\);\s*invalidateModelsCache\(\)/);
});

test("RPC command bridge dispatches omp text-mode slash builtins", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const commandSource = source.slice(
    source.indexOf('case "execute_slash_command"'),
    source.indexOf('case "set_tools"'),
  );

  assert.match(commandSource, /executeAcpBuiltinSlashCommand\(/);
  assert.match(commandSource, /output\.push\(text\)/);
  assert.match(commandSource, /handled: true/);
  assert.match(commandSource, /prompt: result\.prompt/);
});
test("RPC state retains completed subagent snapshots for history", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const stateSource = source.slice(
    source.indexOf('case "get_state"'),
    source.indexOf('case "get_subagent_messages"'),
  );

  assert.match(source, /private readonly subagentHistory = new Map<string, SubagentSnapshot>\(\)/);
  assert.match(source, /private getSubagentSnapshots\(\)/);
  assert.match(stateSource, /subagents: this\.getSubagentSnapshots\(\)/);
  assert.match(source, /this\.subagentHistory\.clear\(\)/);
  assert.match(source, /this\.subagents\.getSubagents\(\)\.length > 0/);
});

test("AgentSessionLike declares the handoff member matching the SDK result", async () => {
  const ompTypesSource = await readFile(new URL("./omp-types.ts", import.meta.url), "utf8");
  const likeSource = ompTypesSource.slice(ompTypesSource.indexOf("export interface AgentSessionLike"));

  // The structural view mirrors the SDK's session.handoff(): custom instructions
  // in, a document/savedPath result out, undefined meaning cancelled.
  assert.match(
    likeSource,
    /handoff\(customInstructions\?: string\): Promise<\{ document: string; savedPath\?: string \} \| undefined>;/,
  );
});

test("latest-session fork resolution is atomic and preserves explicit tree targets", () => {
  const branch = [
    { id: "user-old", type: "message", message: { role: "user" } },
    { id: "assistant", type: "message", message: { role: "assistant" } },
    { id: "custom", type: "custom" },
    { id: "user-latest", type: "message", message: { role: "user" } },
  ];

  assert.equal(resolveForkEntryId(branch), "user-latest");
  assert.equal(resolveForkEntryId(branch, "explicit-entry"), "explicit-entry");
  assert.equal(resolveForkEntryId([{ id: "assistant", type: "message", message: { role: "assistant" } }]), undefined);
});

test("RPC handoff reports distinct running state and rejects concurrent mutations", async () => {
  let finishHandoff;
  const inner = makeInner({
    handoff: () => new Promise((resolve) => {
      finishHandoff = resolve;
    }),
  });
  const wrapper = new AgentSessionWrapper(inner, makeEventBus());
  const handoff = wrapper.send({ type: "handoff", customInstructions: "focus" });
  await Promise.resolve();

  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.isHandoffRunning, true);
  assert.equal(state.isCompacting, false);
  await assert.rejects(
    wrapper.send({ type: "fork" }),
    /Cannot modify the session while a handoff is in progress/,
  );
  await assert.rejects(
    wrapper.send({ type: "handoff" }),
    /Cannot modify the session while a handoff is in progress/,
  );

  finishHandoff(undefined);
  assert.deepEqual(await handoff, { cancelled: true });
  assert.equal(wrapper.isAlive(), true);
  wrapper.destroy();
});

test("RPC handoff compacts in place and keeps the session serving", async () => {
  let receivedInstructions;
  const inner = makeInner({
    handoff: async (instructions) => {
      receivedInstructions = instructions;
      return { document: "handoff context" };
    },
  });
  const wrapper = new AgentSessionWrapper(inner, makeEventBus());

  // omp 18 commits the handoff document as this session's compaction entry
  // instead of minting a replacement, so there is no id to hand back and the
  // wrapper must survive to keep serving the same session.
  assert.deepEqual(
    await wrapper.send({ type: "handoff", customInstructions: "focus exactly here" }),
    { cancelled: false },
  );

  assert.equal(receivedInstructions, "focus exactly here");
  assert.equal(inner.sessionId, "old-session");
  assert.equal(inner.sessionFile, "/tmp/omp-web-old-session.jsonl");
  assert.equal(wrapper.isAlive(), true);
  wrapper.destroy();
});

test("RPC wrapper wires /vibe through the shared mode controller", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const sendSource = source.slice(
    source.indexOf('case "goal"'),
    source.indexOf('case "execute_slash_command"'),
  );
  const stateSource = source.slice(
    source.indexOf('case "get_state"'),
    source.indexOf('case "get_subagent_messages"'),
  );
  const startSource = source.slice(
    source.indexOf("  start(): void"),
    source.indexOf("  setForceEmptySystemPrompt"),
  );

  // /vibe sits next to /goal: both are mode commands the browser serves itself.
  assert.match(sendSource, /case "goal": \{[\s\S]*case "vibe": \{\s*return await this\.vibeMode\.handleCommand/);
  assert.match(stateSource, /vibe: this\.vibeMode\.getStatus\(\)/);
  assert.match(source, /BROWSER_NATIVE_SLASH_COMMANDS = \["fork", "goal", "vibe"\] as const/);
  assert.match(startSource, /void this\.vibeMode\.restore\(\)\.catch/);
  // Vibe mode is exclusive with plan and goal mode, like omp's own handler; the
  // goal check reads the raw state, so an active or paused goal blocks.
  assert.match(source, /if \(this\.inner\.getPlanModeState\?\.\(\)\?\.enabled\) return "Exit plan mode first\.";/);
  assert.match(source, /if \(goalState\?\.goal && \(goalState\.enabled \|\| goalState\.goal\.status === "paused"\)\)/);
  assert.match(source, /this\.vibeMode = new VibeModeController\(this\.inner as unknown as VibeModeSession/);
  // Status travels the same stream goal mode uses; without it another client's
  // toggle leaves this tab's bar and picker stale until its next turn settles.
  assert.match(source, /onStatusChange: \(status\) => this\.emit\(\{ type: "goal_status", status \}\)/);
  assert.match(source, /onStatus: \(status\) => \{\s*this\.emit\(\{ type: "vibe_status", status \}\);\s*notifyRunningChange\(\);/);
});

test("a pending background job keeps the session running until it settles", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const runningSource = source.slice(
    source.indexOf("  isRunning(): boolean"),
    source.indexOf("  bindToolUiContext"),
  );
  // A task/vibe worker finishing after the turn injects a follow-up turn; an
  // idle snapshot there closed the browser's SSE stream and dropped the result.
  assert.match(runningSource, /jobs\?\.getRunningJobs\(\)\.length \?\? 0\) > 0/);
  assert.match(runningSource, /jobs\?\.hasPendingDeliveries\(\) === true/);
  assert.match(source, /onJobSettled\(\(\) => \{\s*if \(this\.isAlive\(\)\) notifyRunningChange\(\);/);
  assert.match(source, /this\.unsubscribeJobSettled\?\.\(\);/);

  let pending = 1;
  let settle;
  const jobs = {
    getRunningJobs: () => (pending > 0 ? [{}] : []),
    hasPendingDeliveries: () => pending > 0,
    onJobSettled: (listener) => {
      settle = listener;
      return () => {
        settle = undefined;
      };
    },
  };
  const wrapper = new AgentSessionWrapper(makeInner({ asyncJobManager: jobs }), makeEventBus());

  assert.equal(wrapper.isRunning(), true);
  pending = 0;
  assert.equal(typeof settle, "function");
  assert.equal(wrapper.isRunning(), false);
  wrapper.destroy();
  assert.equal(settle, undefined);
});

test("set_tools refuses to overwrite the vibe toolset while vibe mode is on", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const setToolsSource = source.slice(
    source.indexOf('case "set_tools"'),
    source.indexOf('case "reload"'),
  );

  // The composer disables the preset picker, but a stale tab or another client
  // can still POST set_tools: a UI-only gate is not a gate. `isPending()` also
  // closes the entry window, where the FIFO tool write would land afterwards.
  assert.match(
    setToolsSource,
    /if \(this\.vibeMode\.getStatus\(\)\?\.enabled \|\| this\.vibeMode\.isPending\(\)\) \{\s*return \{ error: "Exit vibe mode before changing the tool preset\." \};\s*\}/,
  );
  // Refusals return the goal-mode-style { error } so the browser can show it,
  // and the check must precede the write or the preset lands anyway.
  assert.ok(setToolsSource.indexOf("vibeMode.getStatus()") < setToolsSource.indexOf("setActiveToolsByName"));
});

test("agent GET reports the session's work state, not mere wrapper liveness", async () => {
  // Guard only, not the proof: the HTTP-level behaviour comes from the
  // integration smoke test, which can see the stream actually close.
  const source = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const getSource = source.slice(source.indexOf("export async function GET"));

  // `running` gates the browser's grace event stream, so a live-but-idle
  // wrapper must answer false or every stream polls forever.
  assert.match(getSource, /running: session\.isRunning\(\), state/);
  assert.doesNotMatch(getSource, /running: true/);
  assert.doesNotMatch(getSource, /running: session\.isAlive\(\)/);
  // A dead or absent wrapper still answers false without a get_state round-trip.
  assert.match(getSource, /if \(!session \|\| !session\.isAlive\(\)\) \{\s*return NextResponse\.json\(\{ running: false \}\);/);
});

test("subagent registry binds the root-scoped bus so nested subagents reach the browser", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  // Nested frames travel on the root-scoped bus, so binding the session-local
  // one hides grandchildren: this keeps the binding, it does not prove the bus.
  assert.match(source, /const \{ session: inner, eventBus, subagentEventBus, setToolUIContext \} = await createAgentSession\(sessionOptions\)/);
  assert.match(source, /new AgentSessionWrapper\(session, subagentEventBus \?\? eventBus\)/);
});

test("a paused goal still blocks vibe entry", async () => {
  const { session } = makeModeSession({ getGoalModeState: pausedGoalState });
  const wrapper = new AgentSessionWrapper(session, makeEventBus());

  // A paused goal maps to enabled:false, so an enabled-only check let vibe in
  // and two loops then drove one session.
  const result = await wrapper.send({ type: "vibe", args: "on" });
  assert.deepEqual(result, { error: "Exit goal mode first.", status: null });
  assert.equal(session.getVibeModeState(), undefined);
  assert.deepEqual(session.getEnabledToolNames(), ["read", "bash", "edit"]);
  wrapper.destroy();
});

test("a finished goal does not block vibe entry", async () => {
  const finished = { ...pausedGoalState().goal, status: "complete" };
  const { session } = makeModeSession({
    getGoalModeState: () => ({ enabled: false, mode: "active", goal: finished }),
  });
  const wrapper = new AgentSessionWrapper(session, makeEventBus());

  // A leftover state object must not make vibe mode unreachable for good.
  const result = await wrapper.send({ type: "vibe", args: "on" });
  assert.equal(result.error, undefined);
  assert.equal(result.status?.enabled, true);
  assert.equal(session.getVibeModeState()?.enabled, true);
  assert.ok(session.getEnabledToolNames().includes("vibe"));
  wrapper.destroy();
});

test("vibe mode blocks starting a goal on its reduced toolset", async () => {
  const { session } = makeModeSession({
    getVibeModeState: () => ({ enabled: true }),
    goalRuntime: {
      createGoal: async () => { throw new Error("goal must not be created"); },
      replaceGoal: async () => { throw new Error("goal must not be replaced"); },
    },
  });
  const wrapper = new AgentSessionWrapper(session, makeEventBus());

  for (const args of ["ship it", "set ship it", "resume"]) {
    const result = await wrapper.send({ type: "goal", args });
    assert.equal(result.error, "Exit vibe mode first.");
  }
  // Non-entry subcommands still reach the controller.
  assert.equal((await wrapper.send({ type: "goal", args: "show" })).error, "No goal set.");
  wrapper.destroy();
});

test("set_tools is refused while the vibe entry is still activating", async () => {
  const { session, state } = makeModeSession();
  let release;
  let activated = false;
  session.activateVibeTools = async (base) => {
    activated = true;
    await new Promise((resolve) => {
      release = resolve;
    });
    state.activeTools = [...base, "vibe"];
  };
  const wrapper = new AgentSessionWrapper(session, makeEventBus());

  const entering = wrapper.send({ type: "vibe", args: "on" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(activated, true);

  // The SDK applies tool mutations FIFO, so a preset accepted here would land
  // after the activation and wipe the vibe toolset.
  const refused = await wrapper.send({ type: "set_tools", toolNames: ["read", "bash", "edit", "write", "grep", "glob"] });
  assert.deepEqual(refused, { error: "Exit vibe mode before changing the tool preset." });

  release();
  await entering;
  assert.deepEqual(state.activeTools, ["read", "todo", "vibe"]);
  wrapper.destroy();
});

// The builtin writers resolve their user-scope paths from `getAgentDir()` —
// process state, not the session's Settings — so the caller's identity is the
// only guard. These cases point the agent directory at a temp dir and watch
// that directory instead of the host's real `~/.omp`.
function withTempAgentDir(run) {
  const original = getAgentDir();
  const dir = mkdtempSync(join(tmpdir(), "omp-web-slash-scope-"));
  setAgentDir(dir);
  return (async () => {
    try {
      return await run(dir);
    } finally {
      setAgentDir(original);
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

function makeSlashSession(cwd = process.cwd()) {
  const { session } = makeModeSession();
  session.sessionManager.getCwd = () => cwd;
  return session;
}

test("a tenant session cannot run user-scope or always-operator slash mutations", async () => {
  await withTempAgentDir(async (agentDir) => {
    const wrapper = new AgentSessionWrapper(makeSlashSession(), makeEventBus());
    wrapper.setIdentity({ username: "agent123", isAdmin: false });

    // `--scope user` for the scope-dependent verbs; enable/disable/reauth and
    // the marketplace/plugin writers always touch the shared store.
    for (const message of [
      "/mcp add omp-audit-probe --scope user -- /bin/true",
      "/mcp:add omp-audit-probe --scope user -- /bin/true",
      "/mcp add omp-audit-probe --scope=user -- /bin/true",
      // Missing value: the builtin rejects it, the gate fails closed.
      "/mcp add omp-bare-scope --scope -- /bin/true",
      "/mcp remove omp-audit-probe --scope user",
      "/mcp enable omp-audit-probe",
      "/mcp disable omp-audit-probe",
      "/mcp reauth omp-audit-probe",
      "/ssh add probe --host example.invalid --scope user",
      "/ssh remove probe --scope user",
      "/marketplace remove probe-market",
      "/plugins disable some-plugin",
    ]) {
      const result = await wrapper.send({ type: "execute_slash_command", message });
      assert.equal(result.handled, true, message);
      assert.match(result.output.join("\n"), /needs administrator access/, message);
    }

    // The refusal is not a message on top of a write: nothing appeared.
    assert.deepEqual(readdirSync(agentDir), [], "no refused verb wrote a file");

    // Reading is not a mutation and stays available to the tenant.
    assert.deepEqual(
      await wrapper.send({ type: "execute_slash_command", message: "/mcp list" }),
      { handled: true, output: ["No MCP servers configured."] },
    );
    wrapper.destroy();
  });
});

test("a tenant keeps project-scope mcp writes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "omp-web-project-scope-"));
  try {
    await withTempAgentDir(async (agentDir) => {
      const wrapper = new AgentSessionWrapper(makeSlashSession(cwd), makeEventBus());
      wrapper.setIdentity({ username: "agent123", isAdmin: false });

      for (const message of [
        "/mcp add omp-proj --scope project -- /bin/true",
        // Default scope is project (`helpers/mcp.ts:125`).
        "/mcp add omp-default -- /bin/true",
        // Behind `--` these are command tokens, not options (`helpers/mcp.ts:136`).
        "/mcp add omp-after-sep -- /bin/true --scope user",
      ]) {
        const result = await wrapper.send({ type: "execute_slash_command", message });
        assert.match(result.output.join("\n"), /Added MCP server/, message);
      }

      const project = JSON.parse(readFileSync(join(cwd, ".omp", "mcp.json"), "utf8"));
      assert.deepEqual(Object.keys(project.mcpServers).sort(), [
        "omp-after-sep",
        "omp-default",
        "omp-proj",
      ]);
      assert.deepEqual(readdirSync(agentDir), [], "the user store stayed untouched");
      wrapper.destroy();
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an admin session still runs /mcp add --scope user", async () => {
  await withTempAgentDir(async (agentDir) => {
    const wrapper = new AgentSessionWrapper(makeSlashSession(), makeEventBus());
    wrapper.setIdentity({ username: "steimerbyte", isAdmin: true });

    const result = await wrapper.send({
      type: "execute_slash_command",
      message: "/mcp add omp-audit-probe --scope user -- /bin/true",
    });

    assert.equal(result.handled, true);
    assert.match(result.output.join("\n"), /Added MCP server "omp-audit-probe" \(user\)/);
    const config = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    assert.equal(config.mcpServers["omp-audit-probe"].command, "/bin/true");
    wrapper.destroy();
  });
});

test("the slash gate follows the caller, not the session's creator", async () => {
  await withTempAgentDir(async (agentDir) => {
    const wrapper = new AgentSessionWrapper(makeSlashSession(), makeEventBus());
    const tenant = { username: "agent123", isAdmin: false };
    const admin = { username: "steimerbyte", isAdmin: true };

    // Started by a tenant, re-addressed by an admin: the admin path works.
    wrapper.setIdentity(tenant);
    wrapper.setIdentity(admin);
    const accepted = await wrapper.send({
      type: "execute_slash_command",
      message: "/mcp add omp-audit-probe --scope user -- /bin/true",
    });
    assert.match(accepted.output.join("\n"), /Added MCP server/);
    const written = readFileSync(join(agentDir, "mcp.json"), "utf8");

    // Started by an admin, re-addressed by a tenant: refused, file unchanged.
    wrapper.setIdentity(tenant);
    const refused = await wrapper.send({
      type: "execute_slash_command",
      message: "/mcp remove omp-audit-probe --scope user",
    });
    assert.match(refused.output.join("\n"), /needs administrator access/);
    assert.equal(readFileSync(join(agentDir, "mcp.json"), "utf8"), written);

    // The per-dispatch argument is the caller even when the binding is stale.
    wrapper.setIdentity(admin);
    const stale = await wrapper.send(
      { type: "execute_slash_command", message: "/mcp add omp-probe-2 --scope user -- /bin/true" },
      tenant,
    );
    assert.match(stale.output.join("\n"), /needs administrator access/);
    wrapper.destroy();
  });
});

test("the agent route binds the caller's identity for every dispatch", async () => {
  const source = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const post = source.slice(source.indexOf("export async function POST"));
  const identity = post.indexOf("getRequestIdentity(req.headers)");
  assert.ok(identity !== -1, "the route reads no identity");
  assert.ok(post.indexOf("existing.send(body, identity)") > identity, "the fast path does not bind the caller");
  assert.ok(post.indexOf("session.send(body, identity)") > identity, "the cold path does not bind the caller");
  // The identity comes from the proxy headers, never from the request body.
  assert.doesNotMatch(post, /body\.(identity|user|isAdmin)/);
});

// ---------------------------------------------------------------------------
// Per-run budget (OMP-015): a prompt run is bounded by its own model-request
// frames (`turn_start`) and a wall clock, and the browser is told why.
// ---------------------------------------------------------------------------

function makeBudgetSession() {
  const listeners = [];
  const aborts = [];
  const prompts = [];
  let resolvePrompt;
  let resolveContinuation;
  const { session } = makeModeSession({
    prompt(message, options) {
      prompts.push({ message, options });
      return new Promise((resolve) => {
        resolvePrompt = resolve;
      });
    },
    promptCustomMessage() {
      return new Promise((resolve) => {
        resolveContinuation = resolve;
      });
    },
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      };
    },
    abort: async () => {
      aborts.push(Date.now());
    },
    steer: async () => {},
    followUp: async () => {},
  });
  return {
    session,
    prompts,
    aborts,
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    settle() {
      resolvePrompt?.();
    },
    settleContinuation() {
      resolveContinuation?.();
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a run aborts at the model-request cap and a steer shares that budget", async () => {
  const fake = makeBudgetSession();
  const wrapper = new AgentSessionWrapper(fake.session, makeEventBus(), {
    maxRequests: 3,
    maxWallClockMs: 60_000,
  });
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  wrapper.start();
  try {
    await wrapper.send({ type: "prompt", message: "work" });
    for (let i = 0; i < 3; i += 1) fake.emit({ type: "turn_start" });
    await tick();
    assert.equal(fake.aborts.length, 0, "the cap's own requests are still allowed");

    // A steer inside the run shares the budget: it must not reset the counter.
    await wrapper.send({ type: "steer", message: "go on" });
    fake.emit({ type: "turn_start" });
    await tick();

    assert.equal(fake.aborts.length, 1, "the frame past the cap aborts the run");
    const notice = events.find((event) => event.type === "prompt_error");
    assert.ok(notice, "the reason must be visible to the browser");
    assert.match(notice.errorMessage, /3 model requests/);
  } finally {
    fake.settle();
    await tick();
    wrapper.destroy();
  }
});

test("a new prompt run starts with a fresh request budget", async () => {
  const fake = makeBudgetSession();
  const wrapper = new AgentSessionWrapper(fake.session, makeEventBus(), {
    maxRequests: 3,
    maxWallClockMs: 60_000,
  });
  wrapper.start();
  try {
    await wrapper.send({ type: "prompt", message: "first" });
    for (let i = 0; i < 3; i += 1) fake.emit({ type: "turn_start" });
    fake.settle();
    await tick();
    await tick();

    await wrapper.send({ type: "prompt", message: "second" });
    for (let i = 0; i < 3; i += 1) fake.emit({ type: "turn_start" });
    await tick();
    assert.equal(fake.aborts.length, 0, "the second run's cap is counted from zero");

    fake.emit({ type: "turn_start" });
    await tick();
    assert.equal(fake.aborts.length, 1);
  } finally {
    fake.settle();
    await tick();
    wrapper.destroy();
  }
});

test("a run that exceeds the wall-clock ceiling is aborted, not left streaming", async () => {
  const fake = makeBudgetSession();
  const wrapper = new AgentSessionWrapper(fake.session, makeEventBus(), {
    maxRequests: 1000,
    maxWallClockMs: 10,
  });
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  wrapper.start();
  try {
    await wrapper.send({ type: "prompt", message: "stall" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(fake.aborts.length, 1);
    const notice = events.find((event) => event.type === "prompt_error");
    assert.ok(notice);
    assert.match(notice.errorMessage, /minutes/);
  } finally {
    fake.settle();
    await tick();
    wrapper.destroy();
  }
});

test("a short run ends before either limit and leaves no timer behind", async () => {
  const fake = makeBudgetSession();
  const wrapper = new AgentSessionWrapper(fake.session, makeEventBus(), {
    maxRequests: 50,
    maxWallClockMs: 10,
  });
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  wrapper.start();
  try {
    await wrapper.send({ type: "prompt", message: "quick" });
    fake.emit({ type: "turn_start" });
    fake.emit({ type: "turn_start" });
    fake.settle();
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(fake.aborts.length, 0);
    assert.equal(events.some((event) => event.type === "prompt_error"), false);
  } finally {
    wrapper.destroy();
  }
});

test("a goal's continuation chain is bounded per goal lifetime, not per continuation", async () => {
  const fake = makeBudgetSession();
  const wrapper = new AgentSessionWrapper(fake.session, makeEventBus(), {
    maxRequests: 4,
    maxWallClockMs: 60_000,
  });
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  wrapper.start();
  try {
    // What /goal set (or the model's goal tool) commits through goalRuntime.
    fake.emit({
      type: "goal_updated",
      state: { enabled: true, mode: "active", goal: { id: "g1", status: "active" } },
    });

    // Two continuations, two model requests each: both stay under the per-run
    // cap of 4, while the goal has spent its full lifetime budget of 4.
    for (let i = 0; i < 2; i += 1) {
      const continuation = wrapper.runGoalContinuation("continue");
      fake.emit({ type: "turn_start" });
      fake.emit({ type: "turn_start" });
      fake.settleContinuation();
      await continuation;
    }
    assert.equal(fake.aborts.length, 0, "each continuation is under the per-run cap");

    const third = wrapper.runGoalContinuation("continue");
    fake.emit({ type: "turn_start" });
    await tick();

    assert.equal(fake.aborts.length, 1, "the goal lifetime cap aborts the chain");
    const notice = events.filter((event) => event.type === "prompt_error").at(-1);
    assert.ok(notice);
    assert.match(notice.errorMessage, /^Goal paused after 4 model requests for this goal\./);

    // The SDK pauses the goal on that abort; the continuation chain stops.
    fake.emit({
      type: "goal_updated",
      state: { enabled: false, mode: "active", goal: { id: "g1", status: "paused" } },
    });
    fake.settleContinuation();
    await third;
  } finally {
    fake.settleContinuation();
    await tick();
    wrapper.destroy();
  }
});

test("a new goal after a paused goal starts a fresh goal budget", async () => {
  const fake = makeBudgetSession();
  const wrapper = new AgentSessionWrapper(fake.session, makeEventBus(), {
    maxRequests: 4,
    maxWallClockMs: 60_000,
  });
  wrapper.start();
  try {
    fake.emit({ type: "goal_updated", state: { enabled: true, goal: { id: "g1", status: "active" } } });
    for (let i = 0; i < 2; i += 1) {
      const continuation = wrapper.runGoalContinuation("continue");
      fake.emit({ type: "turn_start" });
      fake.emit({ type: "turn_start" });
      fake.settleContinuation();
      await continuation;
    }
    const third = wrapper.runGoalContinuation("continue");
    fake.emit({ type: "turn_start" });
    await tick();
    assert.equal(fake.aborts.length, 1);
    fake.emit({ type: "goal_updated", state: { enabled: false, goal: { id: "g1", status: "paused" } } });
    fake.settleContinuation();
    await third;

    // A new /goal starts a new lifetime, so the counter starts at zero again.
    fake.emit({ type: "goal_updated", state: { enabled: true, goal: { id: "g2", status: "active" } } });
    const fresh = wrapper.runGoalContinuation("continue");
    for (let i = 0; i < 4; i += 1) fake.emit({ type: "turn_start" });
    await tick();
    assert.equal(fake.aborts.length, 1, "the new goal gets its own 4-request budget");
    fake.emit({ type: "turn_start" });
    await tick();
    assert.equal(fake.aborts.length, 2);
    fake.settleContinuation();
    await fresh;
  } finally {
    fake.settleContinuation();
    await tick();
    wrapper.destroy();
  }
});
