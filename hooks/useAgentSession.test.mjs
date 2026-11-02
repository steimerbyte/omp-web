import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8");

test("keeps the session event stream open through the idle grace window", () => {
  const finishSource = source.slice(
    source.indexOf("const finishPromptWithoutStream"),
    source.indexOf("const waitForPromptSettlement"),
  );
  const graceSource = source.slice(
    source.indexOf("const scheduleEventStreamClose"),
    source.indexOf("const finishPromptWithoutStream"),
  );
  const agentEndSource = source.slice(
    source.indexOf('case "agent_end"'),
    source.indexOf('case "agent_settled"'),
  );
  const agentStartSource = source.slice(
    source.indexOf('case "agent_start"'),
    source.indexOf('case "agent_end"'),
  );
  const agentSettledSource = source.slice(
    source.indexOf('case "agent_settled"'),
    source.indexOf('case "prompt_done"'),
  );
  const promptDoneSource = source.slice(
    source.indexOf('case "prompt_done"'),
    source.indexOf('case "prompt_error"'),
  );
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback"),
  );

  assert.match(source, /const EVENT_STREAM_IDLE_GRACE_MS = 30_000/);
  assert.match(graceSource, /setTimeout\(\(\) => void checkServerIdle\(\), EVENT_STREAM_IDLE_GRACE_MS\)/);
  assert.match(graceSource, /fetch\(`\/api\/agent\/\$\{encodeURIComponent\(sid\)\}`\)/);
  assert.match(graceSource, /closeEvents\(\)/);
  assert.match(finishSource, /scheduleEventStreamClose\(sid\)/);
  assert.doesNotMatch(finishSource, /closeEvents\(\)/);
  assert.doesNotMatch(agentEndSource, /closeEvents\(\)/);
  assert.match(agentStartSource, /cancelEventStreamGrace\(\)/);
  assert.match(agentSettledSource, /scheduleEventStreamClose\(sid\)/);
  assert.match(agentSettledSource, /onAgentEnd\?\.\(\)/);
  assert.match(promptDoneSource, /notifyPromptStage\(runId\)/);
  assert.match(promptDoneSource, /scheduleEventStreamClose\(sid\)/);
  assert.match(sendSource, /const definitivelyRejected = !promptRequestStarted \|\| isPromptRejectedError\(e\)/);
  assert.match(sendSource, /if \(!definitivelyRejected && sentSessionId\) \{[\s\S]*?waitForPromptSettlement/);
  assert.match(sendSource, /if \(!definitivelyRejected && sentSessionId\) \{[\s\S]*?return;[\s\S]*?\}[\s\S]*?closeEvents\(\)/);
});

test("reuses an open event stream and hides an empty agent phase", () => {
  const ensureSource = source.slice(
    source.indexOf("const ensureEventsConnected"),
    source.indexOf("const respondToExtensionUi"),
  );

  assert.match(ensureSource, /eventSourceSessionIdRef\.current === sid/);
  assert.match(ensureSource, /current\.readyState === EventSource\.OPEN/);
  assert.match(ensureSource, /attempt\?\.source === current && attempt\.pending/);
  assert.match(chatWindowSource, /agentRunning && !streamState\.streamingMessage && agentPhase/);
  assert.match(chatWindowSource, /return null;/);
});

test("plays the enabled sound once for each extension dialog", () => {
  assert.match(chatWindowSource, /soundedExtensionDialogIdRef = useRef<string \| null>\(null\)/);
  assert.match(
    chatWindowSource,
    /soundedExtensionDialogIdRef\.current === extensionDialog\.id/,
  );
  assert.match(chatWindowSource, /soundedExtensionDialogIdRef\.current = extensionDialog\.id/);
  assert.match(chatWindowSource, /playDoneSoundRef\.current\(\)/);
});

test("keeps completed subagents in the session history", () => {
  assert.match(source, /function mergeSubagentSnapshots/);
  assert.match(source, /const finished: SubagentSnapshot/);
  assert.match(source, /progress: previous\?\.progress \? \{ \.\.\.previous\.progress, status: terminalStatus \}/);
  assert.doesNotMatch(source, /payload\.status !== "started"\) \{\s*setSubagents\(\(previous\) => previous\.filter/);
});

test("keeps a nested grandchild snapshot and its status transitions", () => {
  const mergeSource = source.slice(
    source.indexOf("function mergeSubagentSnapshots"),
    source.indexOf("type ExtensionUiDialogRequest"),
  );

  // Rows merge by id only. A grandchild has its own id, so it is kept even
  // though its parentToolCallId differs from every sibling's.
  assert.match(mergeSource, /new Map\(current\.map\(\(subagent\) => \[subagent\.id, subagent\]\)\)/);
  assert.match(mergeSource, /byId\.set\(subagent\.id, subagent\)/);
  assert.doesNotMatch(mergeSource, /parentToolCallId/);
  // Every kept id is emitted; the cap is the only removal, and it runs after
  // active rows were already sorted to the front.
  assert.match(mergeSource, /\[\.\.\.byId\.values\(\)\]/);
  assert.match(mergeSource, /\.slice\(0, MAX_SUBAGENT_HISTORY\)/);
  // Terminal frames replace the live snapshot of the same id, at any depth,
  // and keep the owning tool call for the parent batch.
  const lifecycleSource = source.slice(
    source.indexOf('case "subagent_lifecycle"'),
    source.indexOf('case "subagent_progress"', source.indexOf('case "subagent_lifecycle"')),
  );
  assert.match(lifecycleSource, /const previous = current\.find\(\(subagent\) => subagent\.id === payload\.id\)/);
  assert.match(lifecycleSource, /parentToolCallId: payload\.parentToolCallId \?\? previous\?\.parentToolCallId/);
  assert.match(lifecycleSource, /return mergeSubagentSnapshots\(current, \[finished\]\)/);
});

test("keeps a row's batch owner when a progress frame omits it", () => {
  const progressSource = source.slice(
    source.indexOf('case "subagent_progress"'),
    source.indexOf('case "queue_update"'),
  );

  // A restored/follow-up run emits progress without the owning tool call
  // (task/restore.ts:89-100, workpool.ts:412). Without the fallback the row
  // would leave its batch and group under its own id.
  assert.match(progressSource, /const before = previous\.find\(\(subagent\) => subagent\.id === progress\.id\)/);
  assert.match(progressSource, /sessionFile: payload\.sessionFile \?\? before\?\.sessionFile/);
  assert.match(progressSource, /parentToolCallId: payload\.parentToolCallId \?\? before\?\.parentToolCallId/);
  assert.match(progressSource, /return mergeSubagentSnapshots\(previous, \[snapshot\]\)/);
});

test("binds the subagent registry to the root-scoped subagent bus", async () => {
  // A child session gets its own local `eventBus`; only the inherited
  // root-scoped `subagentEventBus` carries a grandchild's lifecycle/progress
  // frames (omp's own RPC mode subscribes the same slot, rpc-mode.ts:1507).
  const rpcManagerSource = await readFile(new URL("../lib/rpc-manager.ts", import.meta.url), "utf8");
  assert.match(rpcManagerSource, /const \{ session: inner, eventBus, subagentEventBus, setToolUIContext \} = await createAgentSession\(sessionOptions\)/);
  assert.match(rpcManagerSource, /new AgentSessionWrapper\(session, subagentEventBus \?\? eventBus\)/);
});

test("routes blocking extension requests through deduplicated browser attention notifications", () => {
  const completionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleAgentEnd = useCallback"),
    appShellSource.indexOf("  const handleAttentionNeeded = useCallback"),
  );
  const extensionRequestSource = source.slice(
    source.indexOf("  const handleExtensionUiRequest = useCallback"),
    source.indexOf("  const settleUiStage = useCallback"),
  );
  const attentionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleAttentionNeeded = useCallback"),
    appShellSource.indexOf("  const handleAutoName = useCallback"),
  );

  assert.match(
    extensionRequestSource,
    /isBlockingExtensionUiRequest\(request\)[\s\S]*?onAttentionNeeded\?\.\(request\)/,
  );
  assert.match(chatWindowSource, /onAttentionNeeded, onSessionCreated/);
  assert.match(completionSource, /if \(!shouldShowBrowserNotification\(\)\) return/);
  assert.match(attentionSource, /shouldShowBrowserNotification\(\)/);
  assert.match(attentionSource, /claimExtensionAttentionNotification\(request, notifiedAttentionRequestIdsRef\.current\)/);
  assert.match(attentionSource, /tag: `pi-extension-ui:\$\{request\.id\}`/);
  assert.match(appShellSource, /onAttentionNeeded=\{handleAttentionNeeded\}/);
});


test("/fork is consumed locally and surfaces server resolution errors", () => {
  const forkCaseSource = source.slice(
    source.indexOf('case "fork":'),
    source.indexOf('case "goal":', source.indexOf('case "fork":')),
  );

  assert.match(source, /case "fork": \{/);
  assert.match(forkCaseSource, /const result = await handleFork\(\);/);
  assert.doesNotMatch(forkCaseSource, /messages|entryIds|newestUserEntryId/);
  assert.match(forkCaseSource, /complete\(\{ handled: true, error: result\.error \?\? "Fork failed" \}\)/);
  assert.match(forkCaseSource, /complete\(\{ handled: true, message: "Forked a new session" \}\)/);
  // Every branch returns handled, so /fork never reaches the SDK fallback that
  // forwards the message as an LLM prompt — the case ends in a handled return
  // and yields to the next explicit case, not the default bridge.
  assert.doesNotMatch(forkCaseSource, /execute_slash_command/);
  assert.doesNotMatch(forkCaseSource, /type: "prompt"/);
  assert.match(source, /case "fork":[\s\S]*?return complete\(\{ handled: true, message: "Forked a new session" \}\);\s*\}\s*case "goal": \{/);
});

test("fork navigation selects the new session id from the RPC result", () => {
  const forkSource = source.slice(
    source.indexOf("const handleFork = useCallback"),
    source.indexOf("const handleNavigate = useCallback"),
  );

  assert.match(forkSource, /const handleFork = useCallback\(async \([\s\S]*?entryId\?: string,[\s\S]*?Promise<\{ forked: boolean; error\?: string \}>/);
  assert.match(forkSource, /type: "fork"/);
  assert.match(forkSource, /\.\.\.\(entryId \? \{ entryId \} : \{\}\)/);
  assert.match(forkSource, /const \{ cancelled, newSessionId \} = result \?\? \{\};/);
  assert.match(forkSource, /if \(!cancelled && newSessionId\) \{/);
  assert.match(forkSource, /onSessionForked\?\.\(newSessionId\);\s*\n\s*return \{ forked: true \};/);
  assert.match(forkSource, /error: e instanceof Error \? e\.message : String\(e\)/);
  assert.match(forkSource, /setForkingEntryId\(null\)/);
});

test("/handoff forwards the focus text verbatim and keeps the UI busy", () => {
  const handoffCaseSource = source.slice(
    source.indexOf('case "handoff":'),
    source.indexOf("default: {", source.indexOf('case "handoff":')),
  );

  assert.match(source, /case "handoff": \{/);
  // The text after /handoff is forwarded exactly as the handoff focus.
  assert.match(handoffCaseSource, /type: "handoff"/);
  assert.match(handoffCaseSource, /\.\.\.\(args \? \{ customInstructions: args \} : \{\}\)/);
  // The long oneshot generation keeps the composer busy through existing
  // agent-running state, with no new state machine.
  assert.match(handoffCaseSource, /if \(agentRunningRef\.current \|\| bashRunningRef\.current\)/);
  assert.match(handoffCaseSource, /Cannot hand off while the session is busy/);
  assert.match(handoffCaseSource, /agentRunningRef\.current = true/);
  assert.match(handoffCaseSource, /setAgentRunning\(true\)/);
  assert.match(handoffCaseSource, /agentRunningRef\.current = false/);
  assert.match(handoffCaseSource, /setAgentRunning\(false\)/);
  // Cancellation resolves locally as an error; /handoff never falls through to
  // the SDK command bridge or an LLM prompt.
  assert.match(handoffCaseSource, /if \(!result \|\| result\.cancelled\)/);
  assert.match(handoffCaseSource, /complete\(\{ handled: true, error: "Handoff cancelled" \}\)/);
  assert.doesNotMatch(handoffCaseSource, /execute_slash_command/);
  assert.doesNotMatch(handoffCaseSource, /type: "prompt"/);
  const connectIndex = handoffCaseSource.indexOf("await ensureEventsConnected(sid)");
  const dispatchIndex = handoffCaseSource.indexOf('type: "handoff"');
  assert.ok(connectIndex >= 0);
  assert.ok(dispatchIndex > connectIndex);
  assert.match(handoffCaseSource, /scheduleEventStreamClose\(sid\)/);
});

test("/handoff reloads the same session after an in-place compaction", () => {
  const handoffCaseSource = source.slice(
    source.indexOf('case "handoff":'),
    source.indexOf("default: {", source.indexOf('case "handoff":')),
  );

  assert.match(
    handoffCaseSource,
    /sendAgentCommand<\{ cancelled\?: boolean \}>[\s\S]*?type: "handoff"/,
  );
  // omp 18 hands off in place: the session id never changes, so success
  // reloads this transcript instead of navigating to a replacement session.
  assert.doesNotMatch(handoffCaseSource, /newSessionId/);
  assert.doesNotMatch(handoffCaseSource, /onSessionForked/);
  assert.match(handoffCaseSource, /if \(await loadSession\(sid, true\)\) promoteNewSession\(\);/);
  // Every branch returns handled so the command never reaches the SDK
  // fallback — the busy state is torn down in a finally block and the case
  // yields to the default bridge with a return.
  assert.match(handoffCaseSource, /complete\(\{ handled: true, message: "Context handed off and compacted in place" \}\)/);
  assert.match(source, /case "handoff":[\s\S]*?return complete\(\{ handled: true, message: "Context handed off and compacted in place" \}\);\s*\}\s*finally \{[\s\S]*?\}\s*\}\s*default: \{/);
});

test("rehydrates handoff as busy without misreporting compaction", () => {
  assert.match(source, /isHandoffRunning\?: boolean/);
  assert.match(
    source,
    /state\.isStreaming \|\| state\.isPromptRunning \|\| state\.isCompacting \|\| state\.isHandoffRunning/,
  );
  assert.match(
    source,
    /agentState\.state\?\.isStreaming[\s\S]*?agentState\.state\?\.isPromptRunning[\s\S]*?agentState\.state\?\.isHandoffRunning/,
  );
});

test("lets a user scroll pause auto-follow mid-stream", () => {
  const scrollHandlerSource = source.slice(
    source.indexOf("const handleScrollPositionChange"),
    source.indexOf("  // Load session on mount"),
  );

  // The auto-follow effect refreshes the programmatic-scroll window on every
  // streaming chunk, so gating every scroll event on it made the follow flag
  // impossible to clear while the model was producing output.
  assert.match(scrollHandlerSource, /const userDriven = Date\.now\(\) <= userScrollIntentUntilRef\.current/);
  assert.match(scrollHandlerSource, /if \(!userDriven && Date\.now\(\) < ignoreProgrammaticScrollUntilRef\.current\) return/);
  assert.match(scrollHandlerSource, /distanceFromBottom <= AUTO_FOLLOW_BOTTOM_THRESHOLD_PX\)\s*\{\s*setAutoFollow\(true\)/);
  assert.match(scrollHandlerSource, /if \(userDriven\) \{\s*setAutoFollow\(false\)/);
});

test("exposes a paused-follow flag and a jump-to-bottom action", () => {
  // The ref drives the scroll effects and the state drives the button; one
  // writer keeps them from drifting apart.
  assert.match(source, /const setAutoFollow = useCallback\(\(following: boolean\) => \{\s*completionScrollAllowedRef\.current = following;\s*setAutoFollowPaused\(/);
  assert.match(source, /const resumeAutoFollow = useCallback\(\(\) => \{[\s\S]*?userScrollIntentUntilRef\.current = 0;[\s\S]*?setAutoFollow\(true\);[\s\S]*?scrollToBottom\("smooth"\)/);
  assert.match(source, /autoFollowPaused, resumeAutoFollow,/);
  // A new prompt or shell command resumes following.
  assert.doesNotMatch(source, /completionScrollAllowedRef\.current = true;/);

  assert.match(chatWindowSource, /autoFollowPaused, resumeAutoFollow,/);
  assert.match(chatWindowSource, /\{sessionBusy && autoFollowPaused && \(/);
  assert.match(chatWindowSource, /onClick=\{resumeAutoFollow\}/);
});

test("renders the transcript with omp's hideThinkingBlock setting", () => {
  const messageViewSource = readFileSync(new URL("../components/MessageView.tsx", import.meta.url), "utf8");
  assert.match(messageViewSource, /const \{ hideThinkingBlock \} = useDisplaySettings\(\)/);
  assert.match(messageViewSource, /isHiddenAssistantBlock\(block, \{ isStreaming, hideThinking: hideThinkingBlock \}\)/);

  assert.match(chatWindowSource, /useSyncedDisplaySettings\(/);
  assert.match(chatWindowSource, /displayOptions = useMemo<DisplayOptions>\(\(\) => \(\{ hideThinking: hideThinkingBlock \}\)/);
  // Turn grouping has to agree with what MessageView renders, or a message
  // made only of thinking blocks leaves an empty row behind.
  assert.match(chatWindowSource, /hasDisplayableProcessMessage\(messages\[processIdx\], displayOptions\)/);
  assert.match(chatWindowSource, /splitFinalAssistantBlocks\(finalAssistant, displayOptions\)/);
  assert.match(chatWindowSource, /findFinalAssistantIndex\(messages, userIdx, endIdx, displayOptions\)/);
});

test("/vibe is consumed locally and refreshes the toolset", () => {
  const vibeCaseSource = source.slice(
    source.indexOf('case "vibe":'),
    source.indexOf('case "handoff":', source.indexOf('case "vibe":')),
  );

  assert.match(source, /case "vibe": \{/);
  assert.match(vibeCaseSource, /const result = await sendAgentCommand<VibeCommandResult>\(sid, \{ type: "vibe", args \}\)/);
  assert.match(vibeCaseSource, /setVibeStatus\(result\?\.status \?\? null\)/);
  // The mode swaps the active toolset, so the preset must be re-read.
  assert.match(vibeCaseSource, /await loadTools\(sid\)/);
  assert.match(vibeCaseSource, /complete\(\{ handled: true, error: result\.error \}\)/);
  // `/vibe <prompt>` submits the returned prompt as the next turn.
  assert.match(vibeCaseSource, /return \{ handled: true, prompt: result\.prompt \}/);
  // Never forwards the text as an LLM prompt through the SDK fallback.
  assert.doesNotMatch(vibeCaseSource, /execute_slash_command/);
});

test("syncs the vibe status from every get_state response", () => {
  assert.match(source, /vibe\?: VibeStatusInfo \| null;/);
  assert.match(source, /const \[vibeStatus, setVibeStatus\] = useState<VibeStatusInfo \| null>\(null\)/);
  // The live loadSession state handler, the agent_end fetch and the mount path.
  assert.match(source, /if \(liveState\.vibe !== undefined\) setVibeStatus\(liveState\.vibe \?\? null\)/);
  assert.match(source, /if \(d\.state\?\.vibe !== undefined\) setVibeStatus\(d\.state\.vibe \?\? null\)/);
  assert.match(source, /if \(state\.vibe !== undefined\) setVibeStatus\(state\.vibe \?\? null\)/);
  assert.match(source, /\n    vibeStatus,/);
});

test("clears per-session cards and vibe status on a session switch", () => {
  const switchSource = source.slice(
    source.indexOf("const sessionScopeRef"),
    source.indexOf("// Load session on mount"),
  );

  assert.match(switchSource, /if \(sessionScopeRef\.current === next\) return;/);
  assert.match(switchSource, /setSubagents\(\[\]\)/);
  assert.match(switchSource, /setVibeStatus\(null\)/);
  assert.match(switchSource, /\}, \[session\?\.id\]\)/);
});

test("keeps the event stream open while the server reports running", () => {
  const graceSource = source.slice(
    source.indexOf("const scheduleEventStreamClose"),
    source.indexOf("const finishPromptWithoutStream"),
  );
  const runningSource = graceSource.slice(graceSource.indexOf("if (data.running && state?.isCompacting)"));

  // Prompt, compaction and any other server-side work keep the stream open.
  assert.match(runningSource, /if \(data\.running\) \{[\s\S]*?CONTEXT_USAGE_REFRESH_MS[\s\S]*?return;[\s\S]*?\}/);
  assert.match(runningSource, /closeEvents\(\)/);
  // A pending background delegation is "running", not a subagent count.
  assert.doesNotMatch(graceSource, /subagents\?\.length/);
});

test("reconnects the mount-time stream for any running state", () => {
  const mountSource = source.slice(
    source.indexOf("// Load session on mount"),
    source.indexOf("onSystemPromptChange?."),
  );

  assert.match(mountSource, /if \(agentState\?\.running\) \{\s*loadTools\(session\.id\);/);
  // The reload reconnects on `running` alone, before the per-state branches.
  assert.match(mountSource, /if \(agentState\?\.running\) \{[\s\S]*?void connectEvents\(session\.id\);[\s\S]*?agentState\.state\?\.isStreaming/);
  assert.equal(mountSource.match(/connectEvents\(session\.id\)/g)?.length, 1);
  // No second, subagent-only reconnect window.
  assert.doesNotMatch(mountSource, /subagents\?\.length \?\? 0\) > 0/);
});

test("applies vibe_status frames from the event stream", () => {
  const statusSource = source.slice(
    source.indexOf('case "goal_status":'),
    source.indexOf('case "agent_settled":'),
  );

  // Sits next to the goal frame and shares its undefined-means-cleared shape.
  assert.match(statusSource, /case "vibe_status":\s*setVibeStatus\(\(event\.status as VibeStatusInfo \| null \| undefined\) \?\? null\);[\s\S]*?break;/);
  assert.match(statusSource, /case "goal_status":\s*setGoalStatus\(\(event\.status as GoalStatusInfo \| null \| undefined\) \?\? null\);/);
  // The event type is open (`type: string`), so no union needs the new name.
  assert.match(source, /interface AgentEvent \{\s*type: string;/);
});
