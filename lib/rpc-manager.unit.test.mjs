import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import {
  AgentSessionWrapper,
  destroyRpcSessionsForCwd,
  getAllRunningRpcSessionIds,
  getRpcSession,
  getRpcSessionOwner,
  getRunningRpcSessionIds,
  hasBusyRpcSessionForCwd,
  notifyRunningChange,
  rootAgentId,
  startRpcSession,
  subscribeRunningSessions,
} from "./rpc-manager.ts";
import { setAgentDir, getAgentDir } from "@oh-my-pi/pi-utils";

/**
 * Der Wrapper um eine AgentSession: was der Browser ueber RPC sieht, und die
 * Registry dahinter. Alles laeuft gegen eine Attrappe der Session — der echte
 * Agent braucht ein Modell und einen Prozess.
 */

const ORIGINAL_CWD = process.cwd();
const LIFECYCLE = "task:subagent:lifecycle";
const PROGRESS = "task:subagent:progress";

function makeEventBus() {
  const handlers = new Map();
  return {
    on(channel, listener) {
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel).add(listener);
      return () => handlers.get(channel)?.delete(listener);
    },
    emit(channel, payload) {
      for (const listener of [...(handlers.get(channel) ?? [])]) listener(payload);
    },
  };
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-rpc-unit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeInner(overrides = {}) {
  const state = {
    activeTools: ["read", "bash", "web_search"],
    systemPrompt: ["base prompt"],
    planState: undefined,
    planHandler: null,
    planReference: null,
    planFilePath: undefined,
    reloadCount: 0,
    written: [],
    modeChanges: [],
  };
  const inner = Object.assign({
    sessionId: "session-1",
    sessionFile: "",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    thinkingLevel: "off",
    model: undefined,
    agent: { state: { systemPrompt: ["base prompt"], thinkingLevel: "low" }, waitForIdle: async () => {} },
    extensionRunner: undefined,
    queuedMessageCount: 0,
    settings: Settings.isolated({}),
    getContextUsage: () => undefined,
    getQueuedMessages: () => ({ steering: [], followUp: [] }),
    abort: async () => {},
    abortBash: () => {},
    dispose: async () => {},
    handoff: async () => undefined,
    subscribe: () => () => {},
    sessionManager: {
      getCwd: () => "/tmp/session-cwd",
      getEntries: () => [],
      getBranch: () => [],
      getSessionId: () => "session-1",
      getSessionName: () => "Session One",
      setSessionName: async (name) => { state.sessionName = name; },
      getSessionFile: () => state.sessionFile,
      getHeader: () => ({ type: "session", version: 3, id: "session-1", cwd: "/tmp/session-cwd", timestamp: "2026-01-01T00:00:00.000Z" }),
      getArtifactsDir: () => "/tmp/artifacts",
      getLeafId: () => "leaf-1",
      getSessionDir: () => "/tmp/sessions",
      appendModeChange: (mode, data) => { state.modeChanges.push([mode, data]); return "entry"; },
      captureState: () => ({ cwd: "/tmp/session-cwd" }),
      moveSession: async (path) => { state.movedTo = path; },
    },
    getEnabledToolNames: () => state.activeTools,
    getActiveToolNames: () => state.activeTools,
    getAllToolNames: () => state.activeTools,
    getToolByName: (name) => ({ name, description: `description of ${name}` }),
    setActiveToolsByName: async (names) => { state.activeTools = names; },
    configuredThinkingLevel: () => "off",
    setThinkingLevel: (level) => { inner.thinkingLevel = level; },
    getPlanModeState: () => state.planState,
    setPlanModeState: (next) => { state.planState = next; },
    setPlanProposalHandler: (handler) => { state.planHandler = handler; },
    preparePlanForReview: async (title) => ({ details: { planFilePath: state.planFilePath, title } }),
    setPlanReferencePath: (path) => { state.planReference = path; },
    getSessionStats: () => ({ tokens: 12, requests: 3 }),
    getLastAssistantText: () => "last text",
    setAutoCompactionEnabled: (enabled) => { state.autoCompaction = enabled; },
    setAutoRetryEnabled: (enabled) => { state.autoRetry = enabled; },
    clearQueue: () => ({ steering: ["plain", { text: "object" }], followUp: [{ text: "later" }] }),
    executeBash: async () => { state.written.push("bash"); return { output: "ok", exitCode: 0 }; },
    abortCompaction: () => { state.abortedCompaction = true; },
    reload: async () => { state.reloadCount += 1; },
    refreshSkills: async () => { state.skillsRefreshed = true; },
    resolveRoleModel: (role) => role === "default" ? { provider: "fake", id: "role-model" } : undefined,
    setModel: async (model, role) => { state.model = model; state.modelRole = role; },
    navigateTree: async (targetId) => ({ cancelled: targetId !== "ok" }),
    moveSession: async (path) => { state.movedTo = path; },
    promptCustomMessage: async () => {},
    modelRegistry: {
      find: (provider, modelId) => ({ provider, id: modelId, name: "Found" }),
      refresh: async () => {},
    },
    ...overrides,
  }, {});
  return { inner, state };
}

function makeWrapper(overrides) {
  const { inner, state } = makeInner(overrides);
  const bus = makeEventBus();
  const wrapper = new AgentSessionWrapper(inner, bus);
  wrapper.start();
  return { wrapper, inner, state, bus };
}

function collect(wrapper) {
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  return events;
}

async function waitForEvent(events, predicate, { from = 0, timeoutMs = 2_000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = events.slice(from).find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("expected event was not emitted");
}

test("wrapper getters and lifecycle flags mirror the inner session", (t) => {
  const { wrapper, state } = makeWrapper();
  t.after(() => wrapper.destroy());

  assert.equal(wrapper.sessionId, "session-1");
  assert.equal(wrapper.sessionFile, "", "a missing file is an empty string, not undefined");
  assert.equal(wrapper.cwd, "/tmp/session-cwd");
  assert.equal(wrapper.isAlive(), true);
  assert.equal(wrapper.isRunning(), false);

  wrapper.inner.isStreaming = true;
  assert.equal(wrapper.isRunning(), true, "a running turn counts as running");
  wrapper.inner.isStreaming = false;

  let status;
  wrapper.bindToolUiContext((context, hasUI) => {
    status = { hasUI, hasAsk: typeof context.askDialog === "function" };
  });
  assert.deepEqual(status, { hasUI: true, hasAsk: true });

  wrapper.setForceEmptySystemPrompt(true);
  assert.deepEqual(wrapper.inner.agent.state.systemPrompt, [], "all tools off clears the prompt");
  state.systemPrompt = [];
});

test("tool listing and presets expose extension tools alongside the builtins", async (t) => {
  const { wrapper, state } = makeWrapper();
  t.after(() => wrapper.destroy());

  const tools = await wrapper.send({ type: "get_tools" });
  assert.deepEqual(tools.map((entry) => entry.name), ["read", "bash", "web_search"]);
  assert.deepEqual(tools.map((entry) => entry.description), [
    "description of read",
    "description of bash",
    "description of web_search",
  ]);
  assert.deepEqual(tools.map((entry) => entry.active), [true, true, true]);

  // A preset keeps every non-builtin tool active.
  await wrapper.send({ type: "set_tools", toolNames: ["read", "edit"] });
  assert.deepEqual(state.activeTools, ["read", "edit", "web_search"]);

  // Empty means all off: no extension tools either, and no system prompt.
  await wrapper.send({ type: "set_tools", toolNames: [] });
  assert.deepEqual(state.activeTools, []);
  assert.deepEqual(wrapper.inner.agent.state.systemPrompt, []);
});

test("command results are shaped for the browser", async (t) => {
  const { wrapper } = makeWrapper();
  t.after(() => wrapper.destroy());

  assert.deepEqual(await wrapper.send({ type: "clear_queue" }), {
    steering: ["plain", "object"],
    followUp: ["later"],
  });
  assert.deepEqual(await wrapper.send({ type: "get_last_assistant_text" }), { text: "last text" });
  assert.deepEqual(await wrapper.send({ type: "get_session_stats" }), {
    tokens: 12,
    requests: 3,
    sessionName: "Session One",
  });

  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.sessionId, "session-1");
  assert.equal("sessionName" in state, false);
  assert.equal(state.thinkingLevel, "low");
  assert.equal(state.configuredThinkingLevel, "off");
  assert.deepEqual(state.extensionStatuses, []);
  assert.deepEqual(state.subagents, []);
});

test("subagent lifecycle and progress frames are kept for history", async (t) => {
  const { wrapper, bus } = makeWrapper();
  t.after(() => wrapper.destroy());

  bus.emit(LIFECYCLE, {
    id: "sub-1",
    index: 2,
    agent: "task",
    agentSource: "bundled",
    description: "search the docs",
    status: "started",
    sessionFile: "/tmp/sub-1.jsonl",
  });
  bus.emit(PROGRESS, {
    index: 2,
    agent: "task",
    agentSource: "bundled",
    progress: { id: "sub-1", status: "running", description: "searching", step: "grep" },
  });

  let state = await wrapper.send({ type: "get_state" });
  assert.deepEqual(state.subagents.map((entry) => [entry.id, entry.status]), [["sub-1", "running"]]);

  // The terminal frame arrives after the registry dropped the live entry.
  bus.emit(LIFECYCLE, { id: "sub-1", status: "completed", index: 2, agent: "task" });

  state = await wrapper.send({ type: "get_subagents" });
  assert.equal(state.subagents.length, 1);
  assert.equal(state.subagents[0].status, "completed");
  assert.equal(state.subagents[0].sessionFile, "/tmp/sub-1.jsonl");
  assert.equal(state.subagents[0].progress.status, "completed");
});

test("extension binding reports send and runtime errors as session events", async (t) => {
  let actions;
  let contexts;
  let errorReporter;
  let emitted = [];
  const runner = {
    initialize(nextActions, nextContexts) {
      actions = nextActions;
      contexts = nextContexts;
    },
    onError(listener) { errorReporter = listener; },
    async emit(event) { emitted.push(event); },
  };
  const { wrapper } = makeWrapper({
    extensionRunner: runner,
    sendCustomMessage: async () => { throw new Error("send exploded"); },
  });
  t.after(() => wrapper.destroy());
  const events = collect(wrapper);

  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  assert.deepEqual(emitted, [{ type: "session_start" }]);

  // A failed extension send lands as an extension_error frame.
  actions.sendMessage({}, {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events.filter((event) => event.type === "extension_error").map((event) => event.error), [
    "send exploded",
  ]);

  // The runner's own error hook is forwarded.
  errorReporter({ extensionPath: "/ext/a.ts", event: "tool_call", error: "boom" });
  assert.deepEqual(events.at(-1), {
    type: "extension_error",
    extensionPath: "/ext/a.ts",
    event: "tool_call",
    error: "boom",
  });

  // Shutdown is refused with a visible notice instead of killing the server.
  contexts.shutdown();
  const notice = events.at(-1);
  assert.equal(notice.type, "extension_ui_request");
  assert.equal(notice.method, "notify");
  assert.equal(notice.notifyType, "warning");
  assert.match(notice.message, /shutdown is not supported/);
});

test("extension UI questions round-trip through extension_ui_response", async (t) => {
  const { wrapper } = makeWrapper();
  t.after(() => wrapper.destroy());
  const events = collect(wrapper);
  let context;
  wrapper.bindToolUiContext((next) => { context = next; });

  const answer = async (promise, response) => {
    const request = events.filter((event) => event.type === "extension_ui_request").at(-1);
    await wrapper.send({ type: "extension_ui_response", id: request.id, ...response });
    return promise;
  };

  assert.deepEqual(
    await answer(context.askDialog([{ question: "Continue?" }]), { value: JSON.stringify({ action: "yes" }) }),
    { action: "yes" },
  );
  assert.equal(await answer(context.select("Pick", ["a", "b"]), { value: "b" }), "b");
  assert.equal(await answer(context.confirm("Sure?", "Really?"), { confirmed: true }), true);
  assert.equal(await answer(context.input("Name", "placeholder"), { value: "typed" }), "typed");
  assert.equal(await answer(context.editor("Edit", "prefill"), { value: "edited" }), "edited");

  // A malformed ask payload is "no answer", not a crash.
  assert.equal(
    await answer(context.askDialog([{ question: "?" }]), { value: "{not json" }),
    undefined,
  );
  // A response for an unknown id is ignored.
  await wrapper.send({ type: "extension_ui_response", id: "unknown", value: "x" });

  // Cancelled and timed-out questions resolve to their defaults.
  const aborter = new AbortController();
  aborter.abort();
  assert.equal(await context.input("Name", "p", { signal: aborter.signal }), undefined);
  assert.equal(await context.confirm("Sure?", "message", { timeout: 5 }), false);
});

test("custom extension UI renders, takes input and closes with a value", async (t) => {
  const { wrapper } = makeWrapper();
  t.after(() => wrapper.destroy());
  const events = collect(wrapper);
  let context;
  wrapper.bindToolUiContext((next) => { context = next; });

  const widths = [];
  let inputHandler;
  let disposeCount = 0;
  let doneCallback;
  const pending = context.custom((tui, theme, keybindings, done) => {
    doneCallback = done;
    assert.equal(tui.terminal.columns, 50, "the overlay width reaches the TUI");
    assert.equal(typeof keybindings?.matches, "function");
    // The identity theme is what an extension's renderer sees.
    assert.equal(theme.getThinkingBorderColor("high")("thinking"), "thinking");
    return {
      render(width) { widths.push(width); return [`custom line ${widths.length}`]; },
      handleInput(data) {
        inputHandler = data;
        if (data === "finish") done("picked");
      },
      dispose() { disposeCount += 1; },
    };
  }, { overlayOptions: () => ({ width: 50 }) });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const opened = events.find((event) => event.type === "extension_ui_request" && event.method === "custom");
  assert.ok(opened, "the first render is emitted");
  assert.deepEqual(opened.lines, ["custom line 1"]);
  assert.equal(widths[0], 50);

  await wrapper.send({ type: "extension_ui_input", id: opened.id, data: "x" });
  assert.equal(inputHandler, "x");
  assert.deepEqual(widths, [50, 50], "handleInput re-renders while mounted");

  await wrapper.send({ type: "extension_ui_input", id: opened.id, data: "finish" });
  assert.equal(await pending, "picked");
  assert.equal(disposeCount, 1);
  const closed = events.filter((event) => event.type === "extension_ui_request" && event.method === "custom").at(-1);
  assert.equal(closed.closed, true);
  assert.deepEqual(closed.lines, []);

  // Input for an unknown custom UI is ignored.
  await wrapper.send({ type: "extension_ui_input", id: "unknown", data: "x" });
});

test("custom UI width is clamped, defaulted and resolved from a function", async (t) => {
  const { wrapper } = makeWrapper();
  t.after(() => wrapper.destroy());
  const events = collect(wrapper);
  let context;
  wrapper.bindToolUiContext((next) => { context = next; });

  const widthOf = async (options) => {
    const seen = [];
    void context.custom(() => ({
      render: (width) => { seen.push(width); return []; },
    }), options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return seen[0];
  };

  assert.equal(await widthOf(undefined), 92);
  assert.equal(await widthOf({ overlayOptions: { width: 500 } }), 140);
  assert.equal(await widthOf({ overlayOptions: { width: 30 } }), 40);
  assert.equal(await widthOf({ overlayOptions: { width: Number.NaN } }), 92);
  assert.equal(await widthOf({ overlayOptions: { width: "50" } }), 92);
});

test("a custom UI factory that refuses or throws resolves undefined", async (t) => {
  const { wrapper } = makeWrapper();
  t.after(() => wrapper.destroy());
  const events = collect(wrapper);
  let context;
  wrapper.bindToolUiContext((next) => { context = next; });

  assert.equal(await context.custom(undefined), undefined);
  assert.equal(await context.custom((_tui, _theme, _keys, done) => { done("early"); return undefined; }), "early");
  assert.equal(await context.custom(() => { throw new Error("factory failed"); }), undefined);

  const error = events.find((event) => event.type === "extension_error" && event.event === "custom_ui");
  assert.equal(error.error, "factory failed");
});

test("an editor overlay error closes the custom UI with an extension error", async (t) => {
  const { wrapper } = makeWrapper();
  t.after(() => wrapper.destroy());
  const events = collect(wrapper);
  let context;
  wrapper.bindToolUiContext((next) => { context = next; });

  const pending = context.custom(() => ({
    render: () => ["line"],
    handleInput: () => { throw new Error("input exploded"); },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const opened = events.find((event) => event.type === "extension_ui_request" && event.method === "custom");
  await wrapper.send({ type: "extension_ui_input", id: opened.id, data: "x" });

  const error = events.find((event) => event.type === "extension_error" && event.event === "custom_ui_input");
  assert.equal(error.error, "input exploded");
  assert.equal(await pending, undefined);
});

test("a plan proposal is answered through the plan_review question", async (t) => {
  const dir = tempDir(t);
  const planFile = join(dir, "plan.md");
  writeFileSync(planFile, "# The Plan\n\n1. Do the thing\n");
  const { wrapper, state } = makeWrapper({
    getPlanModeState: () => ({ enabled: true, planFilePath: join(dir, "old.md"), workflow: "parallel", reentry: true }),
  });
  t.after(() => wrapper.destroy());
  wrapper.inner.sessionManager.getCwd = () => dir;
  const events = collect(wrapper);
  // `start()` installed the handler because plan mode is enabled.
  assert.equal(typeof state.planHandler, "function");
  state.planFilePath = planFile;

  const answer = async (response) => {
    const from = events.length;
    const pending = state.planHandler("Ship It");
    const request = await waitForEvent(
      events,
      (event) => event.type === "extension_ui_request" && event.method === "plan_review",
      { from },
    );
    assert.equal(request.planContent, "# The Plan\n\n1. Do the thing\n");
    await wrapper.send({ type: "extension_ui_response", id: request.id, value: JSON.stringify(response) });
    return pending;
  };

  const refined = await answer({ action: "refine", feedback: "add a rollout step" });
  assert.match(refined.content[0].text, /Plan refinement requested/);
  assert.match(refined.content[0].text, /add a rollout step/);
  assert.deepEqual(refined.details, { planFilePath: planFile, title: "Ship It", planExists: true });
  // The proposal moved the plan file, so the mode entry follows it.
  assert.deepEqual(state.modeChanges.at(-1), ["plan", { planFilePath: planFile }]);

  const approved = await answer({ action: "approve" });
  assert.match(approved.content[0].text, /Plan approved/);
  assert.equal(state.planReference, planFile);
  assert.equal(state.planHandler, null);
  assert.equal(state.planState, undefined);
  assert.deepEqual(state.modeChanges.at(-1), ["none", undefined]);
});

test("the browser-side editor emitters forward their frames", (t) => {
  const { wrapper } = makeWrapper();
  t.after(() => wrapper.destroy());
  const events = collect(wrapper);
  let context;
  wrapper.bindToolUiContext((next) => { context = next; });

  context.setTitle("My session");
  context.pasteToEditor("pasted text");
  context.setEditorText("typed text");

  assert.deepEqual(events.map((event) => [event.method, event.title ?? event.text]), [
    ["setTitle", "My session"],
    ["set_editor_text", "pasted text"],
    ["set_editor_text", "typed text"],
  ]);
});

test("/move re-scopes the process and runs the plugin reload", async (t) => {
  const dir = tempDir(t);
  const target = join(dir, "moved");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(target, { recursive: true });
  const { wrapper, state } = makeWrapper();
  t.after(() => wrapper.destroy());
  t.after(async () => {
    const { setProjectDir } = await import("@oh-my-pi/pi-utils");
    setProjectDir(ORIGINAL_CWD);
  });
  wrapper.inner.sessionManager.getCwd = () => dir;
  wrapper.inner.sessionManager.getAdditionalDirectories = () => [];
  wrapper.inner.sessionManager.rollbackMove = async () => {};
  wrapper.inner.setTitleSystemPrompt = () => {};
  wrapper.inner.refreshSkillsAndCommands = async () => {};

  const result = await wrapper.send({ type: "execute_slash_command", message: `/move ${target}` });

  assert.equal(result.handled, true);
  assert.equal(state.movedTo, target, JSON.stringify(result.output));
  // `reloadPlugins` is the callback the action re-runs after the re-scope.
  assert.equal(state.reloadCount, 1);
  assert.equal(state.skillsRefreshed, true);
  assert.ok(result.output.length > 0, "the command reports its result");
});

test("a bash-only session is persisted before the first assistant message", async (t) => {
  const dir = tempDir(t);
  const sessionFile = join(dir, "bash-only.jsonl");
  const { wrapper, state } = makeWrapper();
  t.after(() => wrapper.destroy());
  state.sessionFile = sessionFile;
  wrapper.inner.sessionManager.getSessionFile = () => sessionFile;
  wrapper.inner.sessionManager.getEntries = () => [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "run it" } },
    { type: "message", id: "b1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "bashExecution", command: "ls" } },
  ];

  assert.deepEqual(await wrapper.send({ type: "bash", command: "ls" }), { output: "ok", exitCode: 0 });

  const lines = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 3, "header plus the two generated entries");
  assert.equal(lines[0].type, "session");
  assert.equal(lines[2].message.role, "bashExecution");
  assert.equal(wrapper.inner.sessionManager.flushed, true, "the manager knows it was flushed");

  // A second bash run must not overwrite the file.
  await wrapper.send({ type: "bash", command: "ls" });
  assert.equal(readFileSync(sessionFile, "utf8").trim().split("\n").length, 3);
});

test("a committed fork shuts the old wrapper down and keeps the new id", async (t) => {
  const dir = tempDir(t);
  const { wrapper, state } = makeWrapper();
  t.after(() => wrapper.destroy());
  state.sessionFile = join(dir, "parent.jsonl");
  wrapper.inner.sessionFile = state.sessionFile;
  wrapper.inner.sessionManager.getCwd = () => dir;
  wrapper.inner.sessionManager.getSessionDir = () => join(dir, "sessions");
  wrapper.inner.sessionManager.getBranch = () => [
    { id: "u1", type: "message", message: { role: "user" } },
  ];
  wrapper.inner.sessionManager.getEntry = (id) => id === "u1" ? { id: "u1", parentId: undefined } : undefined;

  const result = await wrapper.send({ type: "fork" });

  assert.equal(result.cancelled, false);
  assert.ok(result.newSessionId);
  assert.equal(wrapper.isAlive(), false, "the old wrapper is gone after the committed fork");
});

test("an unsupported command is refused by name", async (t) => {
  const { wrapper } = makeWrapper();
  t.after(() => wrapper.destroy());

  await assert.rejects(() => wrapper.send({ type: "does_not_exist" }), /Unsupported command: does_not_exist/);
});

test("running-session registry: visibility, busy cwds and broadcasts", async (t) => {
  const cwd = "/tmp/registry-cwd";
  const previousSessions = globalThis.__ompSessions;
  const previousOwners = globalThis.__ompSessionOwners;
  const previousListeners = globalThis.__ompRunningListeners;
  const previousStarting = globalThis.__ompStartingSessionCwds;
  t.after(() => {
    globalThis.__ompSessions = previousSessions;
    globalThis.__ompSessionOwners = previousOwners;
    globalThis.__ompRunningListeners = previousListeners;
    globalThis.__ompStartingSessionCwds = previousStarting;
  });

  const shutdowns = [];
  const fake = (id, { running = true, alive = true, dir = cwd } = {}) => ({
    sessionId: id,
    cwd: dir,
    isAlive: () => alive,
    isRunning: () => running,
    shutdown: async () => { shutdowns.push(id); },
  });
  globalThis.__ompSessions = new Map([
    ["alice-session", fake("alice-session")],
    ["bob-session", fake("bob-session", { dir: "/tmp/other" })],
    ["idle-session", fake("idle-session", { running: false })],
  ]);
  globalThis.__ompSessionOwners = new Map([["alice-session", "alice"], ["bob-session", "bob"]]);

  assert.equal(getRpcSession("alice-session")?.sessionId, "alice-session");
  assert.equal(getRpcSession("missing"), undefined);
  assert.equal(getRpcSessionOwner("alice-session"), "alice");
  assert.equal(getRpcSessionOwner("idle-session"), undefined, "no owner entry means nobody owns it");

  assert.equal(hasBusyRpcSessionForCwd(cwd), true);
  assert.equal(hasBusyRpcSessionForCwd("/tmp/other"), true);
  assert.equal(hasBusyRpcSessionForCwd("/tmp/nobody"), false);
  // A start that has not registered yet still counts as busy.
  globalThis.__ompStartingSessionCwds = new Map([[cwd, 1]]);
  assert.equal(hasBusyRpcSessionForCwd(cwd), true);
  globalThis.__ompStartingSessionCwds = new Map();

  assert.deepEqual(getAllRunningRpcSessionIds().sort(), ["alice-session", "bob-session"]);
  assert.deepEqual(getRunningRpcSessionIds(null).sort(), ["alice-session", "bob-session"]);
  assert.deepEqual(getRunningRpcSessionIds({ username: "alice", isAdmin: false }), ["alice-session"]);
  assert.deepEqual(getRunningRpcSessionIds({ username: "pi", isAdmin: true }).sort(), ["alice-session", "bob-session"]);
  assert.deepEqual(getRunningRpcSessionIds({ username: "carol", isAdmin: false }), []);

  // The broadcast carries every running id; subscribers filter themselves.
  const seen = [];
  const unsubscribe = subscribeRunningSessions((ids) => seen.push([...ids].sort()));
  notifyRunningChange();
  notifyRunningChange(); // unchanged snapshot: no second call
  assert.deepEqual(seen, [["alice-session", "bob-session"]]);

  globalThis.__ompSessions.get("idle-session").isRunning = () => true;
  notifyRunningChange();
  assert.deepEqual(seen.at(-1), ["alice-session", "bob-session", "idle-session"]);

  unsubscribe();
  notifyRunningChange();
  assert.equal(seen.length, 2);

  const destroyed = await destroyRpcSessionsForCwd(cwd);
  assert.equal(destroyed, 2, "both sessions in the cwd are shut down");
  assert.deepEqual(shutdowns.sort(), ["alice-session", "idle-session"]);
});

test("startRpcSession registers the wrapper under its real id and forgets it on shutdown", async (t) => {
  const previousAgentDir = getAgentDir();
  const dir = tempDir(t);
  setAgentDir(join(dir, "agent"));
  t.after(() => setAgentDir(previousAgentDir));

  const cwd = join(dir, "project");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(cwd, { recursive: true });

  const { session, realSessionId } = await startRpcSession("requested-id", "", cwd, { owner: "alice" });
  t.after(() => session.shutdown().catch(() => undefined));

  assert.equal(getRpcSession(realSessionId), session);
  assert.equal(getRpcSessionOwner(realSessionId), "alice");
  assert.equal(getRpcSession("requested-id"), undefined, "the requested id is not the runtime id");

  // The real proof of the fix: this root is addressable under its own key and
  // has not claimed the SDK's process-global "Main" slot.
  const { AgentRegistry } = await import("@oh-my-pi/pi-coding-agent/registry/agent-registry");
  const ref = AgentRegistry.global().get(rootAgentId("requested-id"));
  assert.equal(ref?.id, rootAgentId("requested-id"), "the root registered under its own agent id");
  assert.equal(AgentRegistry.global().get("Main"), undefined, "no root claims the singleton Main");

  await session.shutdown();
  assert.equal(getRpcSession(realSessionId), undefined);
  assert.equal(getRpcSessionOwner(realSessionId), undefined);
});

test("rootAgentId gives every root its own agent://-safe registry key", () => {
  assert.equal(rootAgentId("abc"), rootAgentId("abc"), "deterministic");
  assert.notEqual(rootAgentId("a"), rootAgentId("b"), "one key per root");
  assert.notEqual(rootAgentId("abc"), "Main");
  assert.equal(rootAgentId("abc").includes("Main"), false);

  const safe = /^[A-Za-z0-9._-]+$/;
  assert.match(rootAgentId("__new__1f8a3c1e-6f0b-4a1e-9c1a-2b3c4d5e6f70"), safe);
  assert.match(rootAgentId("1f8a3c1e-6f0b-4a1e-9c1a-2b3c4d5e6f70"), safe);
  assert.match(rootAgentId("a/b?c#d:e"), safe, "no / ? # and no port colon");
  assert.equal(rootAgentId("").length > 0, true, "an empty id still yields a key");
});
