# omp-web - Development Notes

## Quick Start

```bash
bun install
bun run dev   # port 30141
```

Typecheck: `bun run typecheck`
Lint: `bun run lint`
Tests: `bun test`
**Never run `bun run build` during dev** — pollutes `.next/` and breaks `bun run dev`.
Exception: `bun run desktop:build` (via `scripts/stage-desktop.mjs`) is safe — it builds
into `src-tauri/server/.next` through `OMP_WEB_DIST_DIR` and never touches the dev `.next/`.

### Everything runs on Bun

`@oh-my-pi/pi-*` is published as **TypeScript sources** and imports `bun:sqlite`,
so Node cannot load it at all (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).
The server half of omp-web therefore only runs on Bun; `bin/omp-web.js` finds a
Bun binary and re-executes `next start` through it.

Two consequences worth remembering:

- `next.config.ts` externalizes **every** `@oh-my-pi/*` request as an ESM
  `import`, not `commonjs`. The SDK's `exports` map declares only an `import`
  condition, so a `require()` of it cannot resolve — that is what
  "Cannot find module '@oh-my-pi/pi-coding-agent'" during *Collecting page data*
  means. `serverExternalPackages` alone is not sufficient: it misses the SDK's
  own transitive entry points.
- `bun test`, not `node --test`. The test files are `node:test`-based and Bun
  runs them; Node cannot import the SDK the tests exercise.

---

## Architecture

```
Browser                Next.js Server (Bun)        AgentSession (in-process)
  │                        │                               │
  ├─ GET /api/sessions ────▶ reads ~/.omp/agent/sessions/  │  ← filtered by owner, see below
  ├─ GET /api/sessions/[id] reads .jsonl file directly     │  ← filtered by owner, see below
  ├─ GET /api/agent/running ───────▶ running id snapshot   │  ← filtered by owner, see below
  │                        │                               │
  ├─ send message ─────────▶ POST /api/agent/[id]          │
  │                        │   startRpcSession() ─────────▶│ createAgentSession()
  │                        │   session.send(cmd) ─────────▶│ session.prompt()
  │                        │                               │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events    │
  │                        │   session.onEvent() ◀─────────│ session.subscribe()
  │◀── data: {...} ─────────│                               │
```

**Session browsing** (read-only): reads `.jsonl` files through SDK helpers and
`lib/session-reader.ts` — no AgentSession created.
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` creates an
AgentSession in-process.

---

## File Map

```
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/export/route.ts   GET exported HTML for a session
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state (`running` = isRunning()) | POST any command
  agent/[id]/events/route.ts      GET SSE stream
  agent/running/route.ts          GET currently-running session ids
  agent/running/events/route.ts   GET SSE stream of currently-running session ids
  stats/route.ts                  GET stats payload, admin-only, range validation
  auth/all-providers/route.ts     GET API-key provider list
  auth/api-key/[provider]/route.ts GET/POST/DELETE provider API key status/storage
  auth/login/[provider]/route.ts  GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts POST OAuth logout
  auth/providers/route.ts         GET OAuth provider list
  calendar/route.ts               GET/POST the account's calendar events
  calendar/[id]/route.ts          PATCH/DELETE one calendar event
  calendar/events/route.ts        GET SSE stream of calendar changes
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/omp-cwd-YYYYMMDD
  files/[...path]/route.ts        GET file contents for viewer
  home/route.ts                   GET user home directory
  model-roles/route.ts            GET/PUT omp's modelRoles record
  models/route.ts                 GET { models, modelList, defaultModel, roles }
  models-config/route.ts          GET/PUT — read/write ~/.omp/agent/models.yml
  models-config/catalog/route.ts  GET models.dev pricing presets
  models-config/discover/route.ts POST fetch a configured provider's upstream model list
  models-config/test/route.ts     POST test a configured model/provider
  plugins/route.ts                GET/POST omp plugin management
  projects/route.ts               GET/PUT/POST the projects dashboard registry
  projects/sizes/route.ts         GET the folder sizes (the cheap poll)
  projects/[...root]/route.ts     GET/DELETE one project
  quick-phrases/route.ts          GET/PUT the account's composer phrase list
  skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
  skills/install/route.ts         POST install skills through npx skills add
  web-access/route.ts             GET/PUT the password lock (settings -> Access)
  web-access/recovery/route.ts    POST recovery code request/redeem (unauthenticated)
  worktrees/route.ts              GET/POST/DELETE git worktrees

lib/
  agent-client.ts      typed fetch helper for /api/agent commands
  draft-store.ts       local draft persistence helpers
  file-access.ts       allowed file roots for /api/files and worktrees
  file-paths.ts        client/server path encoding helpers
  markdown.ts          shared markdown helpers
  model-roles.ts       omp's model roles, read/written for the browser
  model-scope.ts       enabledModels resolution shared by UI and startup
  npx.ts               npx runner used by skill install
  omp-runtime.ts       shared Settings + AuthStorage + ModelRegistry
  omp-types.ts         structural view of omp's AgentSession
  project-size.ts      du -sb for one or many folders, bounded in parallel
  project-size-poll.ts the rule of the size poll (interval, limit, end)
  project-trust.ts     gates a project's executable resources
  projects-guards.ts   the shared identity guard of the projects routes
  projects-schema.ts   the shape of the projects registry and its validation
  projects-sizes.ts    the background size measurement and its in-flight lock
  projects-store.ts    the per-account registry file
  rpc-manager.ts       AgentSessionWrapper + registry + startRpcSession
  session-reader.ts    session listing + path cache + buildSessionContext adapter
  session-system-prompt.ts  SYSTEM.md / APPEND_SYSTEM.md resolution per session cwd
  session-title.ts     thin wrapper over omp's own title generator
  stats.ts             stats data service: cache + single-flight sync
  subagent-groups.ts   pure panel grouping: isSubagentActive, groupSubagentRows
  tool-presets.ts      PRESET_NONE/DEFAULT/FULL + getPresetFromTools()
  vibe-mode.ts         VibeModeController — `/vibe` on the SDK's public API
  calendar.ts          the calendar domain: event shape, German date rules, holidays
  calendar-store.ts    the per-account calendar file
  calendar-tool.ts     the calendar_read / calendar_write agent tools
  types.ts             shared TypeScript types
  normalize.ts         normalizeToolCalls() — field name mismatch between file format and our types
  worktree.ts          project/worktree resolution and git worktree operations

components/
  AccessConfig.tsx    password lock panel inside the settings modal
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/role/thinking/tools/compact controls
  MessageView.tsx     renders one message; vibe_* results get a screen wall
  SubagentPanel.tsx   live subagent workers of the current session
  StatsView.tsx       stats page: KPIs, inline SVG, tables, 403/empty/error
  BranchNavigator.tsx in-session branch switcher
  ChatMinimap.tsx     scroll minimap alongside the message list
  MarkdownBody.tsx    markdown renderer
  ModelsConfig.tsx    modal for providers/auth (opened from sidebar bottom)
  ModelRolesPanel.tsx per-role model assignment inside that modal
  PluginsConfig.tsx   modal for installed omp plugins
  SkillsConfig.tsx    modal for loaded/search/installable skills
  FileExplorer.tsx    file tree inside sidebar
  FileIcons.tsx       file icon helpers
  FileViewer.tsx      file content in a tab
  TabBar.tsx          tab bar (Chat + open file tabs)
  CalendarView.tsx    the calendar (month/week/day)
  calendar/
    calendar-model.ts     where an event sits on screen; presentation only
    CalendarEventDialog.tsx  create/edit dialog for one event

hooks/
  useAgentSession.ts  messages + streaming + SSE + fork/navigate/reconciliation logic
  useAudio.ts         completion sound + browser AudioContext unlock
  useDragDrop.ts      shared drag/drop state
  useIsMobile.ts      responsive breakpoint hook
  useProjectSizes.ts  React binding for the size poll
  useStats.ts         stats fetch + bounded syncing poll + range state
  useTheme.ts         theme state
```

---

## Key Design Decisions & Traps

### AgentSession lifecycle (`lib/rpc-manager.ts`)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__ompSessions`
- `globalThis` survives Next.js hot-reload; plain module-level Map does not
- Idle timeout: 10 minutes. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__ompStartLocks`)
- Extensions are bound with omp's own `initializeExtensions()` from
  `@oh-my-pi/pi-coding-agent/modes/runtime-init` — the same wiring `omp --mode rpc`
  uses — with a browser-backed `ExtensionUIContext` layered on top. Do not
  reimplement the action set; a mismatch shows up as extensions silently doing
  nothing.

### One runtime, many requests (`lib/omp-runtime.ts`)
omp's CLI builds `Settings` + `AuthStorage` + `ModelRegistry` once per process.
omp-web does the same and caches them on `globalThis`; a second `AuthStorage`
would open a second SQLite handle on `~/.omp/agent/agent.db` and split
`credential_disabled` events. Per-project settings come from
`settings.cloneForCwd(cwd)`, never from a second `Settings.init()`.

Anything that mutates credentials or `models.yml` must call
`invalidateOmpRuntime()` as well as `invalidateModelsCache()`.

### Model roles are the model selector
omp assigns a model per scope of work (`default`, `smol`, `slow`, `vision`,
`plan`, `designer`, `commit`, `tiny`, `task`, `advisor`), stored in the
`modelRoles` record in `config.yml`. `lib/model-roles.ts` reads and writes that
record; `GET /api/models` ships the resolved table so `ChatInput` can list roles
above the flat model list, and `set_role_model` switches the session **and
records the role** so the transcript matches what `/model` writes in the TUI.

An explicit model pick in the browser is persisted as `modelRoles.default`
(`lib/startup-preferences.ts`), which is the same slot the TUI writes.

**The displayed model is the live one, not the file's.** The composer prefers
the session's live value (`state.model` from `get_state`) over the file-based
`context.model`. The reader builds `context.model` from `models.default` in the
session file, and the SDK stores a role-scoped `model_change` under its role
without also moving it to `models.default` — so after a role switch and a
reload the file-based value still names the model you left. The live value is
adopted in `loadSession`'s `includeState` branch, and only while no model
switch is in flight (`modelSwitchQueueRef.current.inFlight === null`): a switch
the user just triggered is the optimistic value, and the poll must not overwrite
it with the server's older answer.

`currentModelOverride` is therefore the **only** carrier of the displayed
model, and `loadSession` must never reset it — not on the file half, not on the
state half. `get_state` is the one writer, guarded by that in-flight check; the
other writer is the confirmed switch itself. Resetting from `context.model`
looks harmless because both name a model, and it is exactly how `/vibe off`
flashed the old default model after a role switch. The same reason is why
`/vibe` loads with `includeState`: the context meter is served by the live
session too, and a file-only load leaves it describing the old one.

### Fork must destroy the wrapper immediately
`AgentSession.fork()` **mutates the wrapper's inner state in-place** — after fork, `inner.sessionId` is the *new* session's id. If the wrapper stays alive in the registry under the old id, the next request gets the already-forked state and subsequent forks produce a corrupt `parentSession` chain.

**Fix**: `send("fork")` captures `newSessionId`, then calls `this.destroy()` before returning. The next request for the original session reloads a clean AgentSession from the original file.

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (omp does this itself during migrations). Used when cascade-reparenting children on delete.

### `SessionManager.open()` is async
Every omp `SessionManager.open()` / `forkFrom()` / `continueRecent()` returns a
Promise, and `setSessionName()` / `newSession()` / `flush()` do too. Forgetting
an `await` yields `Property 'getEntries' does not exist on type 'Promise<…>'`.

### Transcript ordering follows omp, not the LLM context
`buildSessionContext()` in `lib/session-reader.ts` mirrors omp's live-chat
transcript (`{ transcript: true, collapseCompactedHistory: true }`): history
replaced by the latest compaction is elided, and the summary renders **at the
chronological compaction point** — after the kept messages, before the
post-compaction turns. It is not the LLM context, where the summary comes first.
`entryIds` is a parallel array to `messages` and is walked locally because omp's
`buildSessionContext` does not return entry ids.

### ToolCall field normalization
omp stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and `ChatWindow.handleAgentEvent()` (streaming).

### New session tool preset
Tool names are passed at session creation (`POST /api/agent/new` → `toolNames[]`). For existing sessions, the active preset is inferred on mount via `get_tools` → `getPresetFromTools()`. When tools are fully disabled (`toolNames = []`), `rpc-manager.ts` passes `toolNames: []` with `restrictToolNames: true` and forces `agent.state.systemPrompt = []` after startup and reloads.

### `/vibe` is TUI-only, so omp-web reproduces it (`lib/vibe-mode.ts`)

`/vibe` has only `handleTui` in omp (`builtin-modes.ts`). The ACP dispatcher
(`executeAcpBuiltinSlashCommand`) runs nothing but commands with a text-mode
`handle` and answers `false` for the rest, so a `/vibe` sent as chat text would
reach the model as plain prose. The browser therefore sends it as a command —
`{ "type": "vibe", "args": "<rest>" }` on the existing `POST /api/agent/[id]`,
`case "vibe"` in `lib/rpc-manager.ts` — and `VibeModeController` in
`lib/vibe-mode.ts` reproduces the transition on the SDK's **public** session
API. The worker registry is the SDK's own (`VibeSessionRegistry` from
`@oh-my-pi/pi-coding-agent/vibe/runtime`), so the browser drives the same state
the TUI does — and a restart re-attaches to workers through `rehydrate`, which
reads the `vibe-session-lifecycle` custom entries the registry writes into the
session file. The SDK is not patched and not forked.

The palette entry needs two halves: `BUILTIN_SLASH_COMMANDS` in
`components/ChatInput.tsx` offers `/vibe` even before the server advertises
anything, and `BROWSER_NATIVE_SLASH_COMMANDS` in `lib/rpc-manager.ts` names the
commands the browser answers itself (`fork`, `goal`, `vibe`), which
`getAvailableSlashCommands` adds to the discovered list and the existing
`get_commands` ships. A command offered by only one half is either invisible or
forwarded to the model.

**Both submit paths ask the handler, and `BUILTIN_SLASH_COMMANDS` is only a
label.** `handleSend` and the streaming path (`sendQueued`, Enter during a
turn) both call `runBuiltinCommand`; the streaming one is where a slash command
used to slip past the handler and be sent as a steer prompt, so the command ran
nowhere and the transcript gained a user message that read like a command. The
gate is the `switch` in `handleBuiltinSlashCommand` (`hooks/useAgentSession.ts`),
not the list — the list decides what the palette shows. Only the command's own
returned `prompt` may be sent with the turn's streaming behavior; everything
else is consumed. An unknown slash command must fail loudly
(`Unknown command: /…`), because forwarding it as prose makes it look executed
and leaves the user waiting for a mode that never turned on; the text stays in
the input field so it can be fixed.

`parseVibeCommand` splits `/vibe [on|off|status] [task]`: no argument toggles,
and `on`/`start`/`enter`, `off`/`exit`/`stop` and `status` act. Anything else
is the task that starts the mode — the lookup is a `hasOwnProperty` check, so a
task beginning with `constructor` is still a task and not a command.

The plan/goal conflict gate applies to **entry only**. `handleCommand` resolves
`off` and a toggle that is currently on before it ever asks `conflicts()`, the
same order as the TUI, where `handleVibeModeCommand` exits on
`vibeModeEnabled` before it checks plan or goal: a mode that cannot be left is
worse than one that cannot be entered. Entering is also refused when the live
toolset is empty and no `mode_change` entry supplied a snapshot — there would be
nothing to restore on exit.

Entry is serialized behind one in-flight promise (`#entry`), the way the TUI
stores `#vibeModeEntry`: a second `/vibe` (another tab, a double click, a
`/vibe` with a prompt while the first is still awaiting `activateVibeTools`)
awaits that promise instead of snapshotting a toolset that is already the
reduced one. A second snapshot would make `previousTools` record `read` + the
vibe tools, and the exit would restore a mode instead of leaving it. The entry
also refuses before shrinking anything when the session cannot hold the flag
(no `setVibeModeState`) — a session stuck read-only that shows no mode is worse
than a refused command.

Entering, in this order, mirroring the TUI's `#enterVibeMode`:

1. `previousTools` — the restore snapshot: the `mode_change` entry's recorded
   list when restoring, otherwise `session.getEnabledToolNames()`
2. `registry.ownerScope(session)` + `activateScope(scope)`
3. `base = ["read"]`, plus `"todo"` when the session has that builtin
4. `await session.activateVibeTools(base)`
5. `session.setVibeModeState({ enabled: true })`
6. `sessionManager.appendModeChange("vibe", { previousTools })` — skipped on a
   restore (`persist: false`)
7. `sendVibeModeContext({ deliverAs: "steer" })` when the session is
   streaming, so the running turn learns that its toolset just shrank

Leaving runs the teardown through `runModeExitTeardown`: abort when streaming →
`killAll` on the registry → `deactivateVibeTools(previousTools)` →
`setVibeModeState(undefined)`. `runModeExitTeardown` raises the session's
drain-suppression depth for the duration and schedules the idle drain only
afterwards, so no queued turn runs while the toolset is being swapped. The
abort is inside the teardown for the same reason one level down: without it a
queued steer would restart on the still-live vibe toolset that the next step
removes (`lib/vibe-mode.ts` says so next to the call; the TUI does the same).

`killAll` persists the exit itself — `#persistModeExit` appends the worker
tombstones **and** `mode_change("none")` in one `appendEntriesAtomically`
block — so a leaving session says so whether a TUI or the browser drove it. Its
zero-records early return reads the branch and skips the write when the last
entry there already says `none`, so the exit is not recorded twice either. The
browser therefore must not append its own `none`: it would duplicate the entry
in every session file this mode ever touches.

Restore resolves the mode from the **active branch**, not from the last
`mode_change` line in the file: `SessionManager.buildSessionContext()` walks the
path to the current leaf and reports `mode`/`modeData` from the last entry on it
(`session-context.ts`), which is why `#modeContext()` prefers that and keeps the
flat ledger only as a fallback for a manager without the method. A flat scan
from the end of the ledger is wrong precisely because the browser ships
`navigate_tree`: a session can sit on a branch where vibe mode is off while a
later sibling branch turned it on, and the flat scan would resurrect the mode
there. `restore()` then calls `rehydrate`, re-enters with `persist: false` (no
second mode entry, the file already says what the session was in), memoizes its
promise, and `handleCommand` awaits it first, so a `/vibe` typed during startup
acts on the settled mode instead of a half-restored one.

**Exclusivity with goal mode is symmetric, and a paused goal still counts.**
`/goal` entry is refused while vibe is on (`case "goal"`), and `/vibe on` is
refused while a goal is active **or paused**: `planOrGoalConflict` reports
`goalState.enabled || goalState.goal.status === "paused"`, because a paused goal
reports `enabled: false` but still owns the session — the TUI uses the same
`goalModeEnabled || goalModePaused` pair (`interactive-mode.ts:3661-3684`). A
finished or dropped goal does not block. Plan mode blocks too, but the browser
has no entry command for it: `/plan` is not in `BROWSER_NATIVE_SLASH_COMMANDS`,
entry happens through the session-mode path inside the SDK (`acp-agent.ts`
installs the plan-proposal handler), and `lib/rpc-manager.ts` only *restores*
a persisted `plan` mode and clears it on approval. The reduced vibe toolset
cannot reach that path, so the conflict is one-directional for now.

**The activation window is a second gate, not a detail.** The tool set is
rebuilt asynchronously and the SDK serializes every tool mutation FIFO
(`runToolRegistryMutation` in `session-tools.ts:836-848`). A `set_tools` that
arrives *during* the entry would therefore pass an `enabled` check that is
still false and then land after the activation, overwriting the reduced set
with the full one — a mode that is on with a toolset its exit cannot restore.
`VibeModeController.isPending()` is true from before the `activateVibeTools`
await until it settles, and the gate refuses on `enabled || isPending()`. The
same promise serializes commands: `handleCommand` awaits `#entry` before it
parses anything, so a `/vibe off` typed during a slow entry is answered against
the settled state instead of the one it was meant to undo.

**A `vibe_status` frame goes out on the session event stream**, like
`goal_status`: `onStatus` in the controller's constructor emits it, so an idle
browser tab learns about a mode change made in another tab instead of keeping
a bar that contradicts the session. Without the frame the bar would only be
correct in the tab that pressed the button.

**A brand-new session must be promoted, or the bar has no host.** When `/vibe`
runs in a session that does not exist yet, the server creates it
(`ensureNewSession()`) and the mode really is on — while `ChatWindow` renders
neither `VibeBar` nor `GoalBar` inside its `isEmptyNew` branch, so there is no
bar to show it. The client therefore brings the session into the view after a
successful command, exactly like `/compact`: `await loadSession(sid)` then
`promoteNewSession()`. Two details make this easy to get wrong. `loadSession(sid)`
without `includeState` resolves to `null` **on success** (its `if (!includeState)
return null` is the normal exit), so a truthiness guard around the call is dead
code that reads as a failure check. And the promotion needs no guard of its own:
the command's own `result?.error` check already returned, and `promoteNewSession`
refuses unless `isNew` still holds.

### The VIBE bar locks the tool preset

While the mode is on, `VibeBar` in `components/ChatWindow.tsx` shows the live
worker count, and the tool-preset control is locked (`vibeEnabled` in
`components/ChatInput.tsx`). The count is not polled separately: `get_state`
carries `vibe: { enabled, workers } | null` next to `goal`, so a page refresh
finds the mode the way it finds every other piece of session state.

`VibeBar` is a readout, not a switch: it states the mode, the worker count and
that the toolset is read-only with the presets locked. Entering, leaving and
the task text all go through `/vibe`, so there is no second control that could
disagree with the `mode_change` entry in the transcript.

Applying a preset would `set_tools` the full set back over `read` + the vibe
tools, and the mode would be on with its toolset gone — a state the exit
cannot unwind, because `previousTools` no longer describes what runs. The lock
is therefore on both sides: the control is disabled in the composer, and
`case "set_tools"` in `lib/rpc-manager.ts` refuses with *Exit vibe mode before
changing the tool preset* — a client that does not draw the disabled state
must not be able to break the mode either. For the same reason the client's
`case "vibe"` calls `loadTools()` after the command: the preset indicator
follows the toolset the mode just swapped.

`/vibe <prompt>` enters first and submits the prompt afterwards, so the prompt
runs under the reduced set like the next turn would.

### A background delegation is a running session

`task` and the vibe workers return immediately and deliver their result as a
follow-up turn minutes later. While that delivery is pending the session is
**not** idle, yet the browser closes its SSE stream as soon as the server
reports idle — the follow-up would then land in a stream nobody reads, and the
result would never render. This is the trap: `running` used to mean "a wrapper
exists", which is true for the whole idle timeout.

`AgentSessionWrapper.isRunning()` in `lib/rpc-manager.ts` answers *"this session
still owes work"* — prompt, handoff, streaming, compaction and bash, the live
subagent registry, and the session's own `AsyncJobManager`:
`getRunningJobs()` plus `hasPendingDeliveries()`. `onJobSettled` fires
`notifyRunningChange()`, so the `/api/agent/running` snapshot drops the id only
when the queue is really empty.

`GET /api/agent/[id]` returns that value as `running`, and that is the whole
fix: `checkServerIdle` in `hooks/useAgentSession.ts` closes the SSE stream only
when `running` is false, so the follow-up turn of a finished delegation still
arrives on the stream that was open when it started. The mount path in the same
hook connects the stream for **any** running state (`if (agentState?.running)`
in its mount effect), so a page refresh in the middle of a delegation
reattaches; a narrower condition on the mount path loses exactly the case this
is about, a pending delivery with no subagent and no streaming turn.

The manager is per session — `sdk.ts:2326` creates one per
`createAgentSession` — which is what makes the count exact: it cannot include
a sibling session's jobs, so no owner filter is needed here.

**Nested subagents need the root event bus.** A subagent can spawn subagents,
and the SDK emits those nested lifecycle and progress frames on the
**root-scoped** `subagentEventBus` — `createAgentSession` creates it
(`sdk.ts:1786-1787`) and the executor publishes each frame to the session bus
*and* that one (`emitSubagentFrame` in `utils/event-bus.ts`). omp's own
RPC mode binds its observer there (`rpc-mode.ts:1507`), and omp-web bound its
`RpcSubagentRegistry` to the session-local `eventBus` instead, so a grandchild
never reached the browser: it ran, its parent waited for it, and the panel
showed nothing.

`startRpcSession` therefore constructs the wrapper with
`subagentEventBus ?? eventBus`. Grandchildren appear in the roster and answer
`get_subagents` / `get_subagent_messages` by their own id, because the registry
is subscribed where they are published. The fallback is not a second code path:
a session built without the root bus behaves exactly as before.

The snapshot carries `parentToolCallId` but **no depth**
(`RpcSubagentSnapshot` in `rpc-types.d.ts`), and the protocol cannot express
nesting. The panel therefore groups the rows that share a parent tool call and
never invents a tree: a batch reads as a batch, and a row's depth is not
knowable from the frame. That rule is pure and lives in
`lib/subagent-groups.ts` (`isSubagentActive`, `groupSubagentRows`) — the panel
imports it, its test imports it directly, and it may only reorder, never drop a
row. Any future tree view needs a depth field on the snapshot first.

### Subagent state belongs to one session, and is reachable on a phone

- `mergeSubagentSnapshots` merges by id, so the snapshots survive a session
  switch by default. Today `components/AppShell.tsx` bumps `sessionKey` in its
  switch paths (select, fork, new session, cwd change, delete, restore), so
  `ChatWindow` remounts and its state is fresh anyway — which makes the
  clearing branch in `hooks/useAgentSession.ts` a **guard, not a repair**: the
  invariant lives at the hook so a future wiring that stops remounting cannot
  show session A's workers inside session B. The failure it prevents is not
  silent: the panel would ask `get_subagent_messages`,
  `RpcSubagentRegistry.resolveSessionFile` would throw *Unknown subagent or
  session file unavailable: <id>* (`rpc-subagents.ts`), and
  `POST /api/agent/[id]` maps **any** command error to HTTP 500 — the route's
  only 404 is "Session not found". The guard's live part is the promotion skip:
  a `null` id replaced by the session's first real id is the same scope and
  must not wipe a `/vibe` that was just entered.
- On a narrow screen the panel is not a column — `showSubagentPanel` in
  `components/AppShell.tsx` requires `!isMobile` — but `SubagentMobileToggle`
  (in `components/SubagentPanel.tsx`) shows a count pill above the chat and
  opens the same panel as a dialog sheet. A width check that only hides the
  column makes running delegations invisible on a phone; the pill is the only
  sign there that workers are running, so it names the count, not just "details".
  The sheet passes `translate-x-0 translate-y-0` to the dialog primitive's
  `DialogContent`, because the primitive's base classes carry
  `-translate-x-1/2 -translate-y-1/2`: a sheet that overrides only the anchoring
  (`left`/`bottom`) keeps the horizontal translate and lands half its width
  off-screen. Before the fix the 390 px screenshot showed exactly that left
  strip; after it, a Playwright/Chromium measurement at 96 % of the entrance
  animation read x=8, width=375 — the centering of the 0.961 zoom, not a shift.

### `enabledModels` scoping
The `enabledModels` setting uses omp's `--models` syntax: globs against
`provider/modelId` or a bare `modelId`, fuzzy matching for non-glob patterns, and
an optional `:thinkingLevel` suffix. Never compare those patterns as literal
strings — `lib/model-scope.ts` delegates to the SDK's `resolveModelScope()` so
omp-web and the TUI agree on the visible model list, and falls back to all
available models when patterns resolve to nothing. Diagnostics are produced by
re-resolving each pattern alone, because omp's resolver drops unmatched patterns
silently.

### Project trust is omp-web's own
omp has no trust store — it runs a repository's extensions because you ran it
there. A browser tab is not that decision, so `lib/project-trust.ts` keeps a
store in `~/.omp/agent/omp-web-trusted-projects.json`. A project requires trust
when it ships executable resources (extension, hook and tool directories, an
MCP manifest), a project skill, or a settings file whose *keys* name code:
`.omp/config.yml`, `.omp/settings.json`, `.claude/settings.json`. The settings
files are on that list because `.omp/config.yml` carries `extensions` and omp
honours it from the merged project layer — measured,
`extensions: [/tmp/outside-evil2/ext.ts]` ran while the detector reported
nothing to decide.

For an untrusted project nothing loads from inside it: rules, `AGENTS.md` and
the other context files, prompt templates, slash commands, a project's
`SYSTEM.md` / `APPEND_SYSTEM.md`, extensions, custom tools and skills. Code is
filtered by a **positive allowlist**, not by "not under the project": only
paths under `getAgentDir()` or `os.homedir()` survive, because a project's
`config.yml` can name a path *outside* itself and an exclusion test cannot see
that. An extension the operator configured at `/opt/foo.ts` therefore does not
load in a project they have not trusted, and comes back when they trust it.
The container is `filterLoads` in `lib/load-policy.ts`; the code half is
`untrustedProjectSessionOptions()`.

Skills follow trust because they are prompt text a merely-opened repository must
not write. `trustedProjectSkills` keeps anything `level: "user"` **and** outside
the project root — the level alone misses a project pointing
`skills.customDirectories` at itself. `loadSessionSkills()` is the one loader
`GET /api/skills` and the session both call, so the panel never lists a skill
the agent lacks. See `docs/project-trust.md`.

### The load policy decides what an identity loads
`lib/load-policy.ts` is the one place that decides it. `startRpcSession()` calls
`resolveSessionLoads(identity, sessionCwd, settings)` once and spreads
`loads.options` into `createAgentSession`; `GET /api/skills` merges the same
`diagnostics`. Two rules, no more: project trust (above) and the identity.

- **A tenant does not inherit the operator's authoring store.** omp's loaders
  take `getAgentDir()` and `os.homedir()` from process state, so every session
  reads the operator's files unless the caller decides otherwise. `AGENTS.md`,
  `RULES.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, custom prompt templates and
  slash commands from the operator's agent directory and home do not reach a
  tenant, the `~/.agents` and `~/.claude` variants included. Their own
  `$HOME/.omp/agent` rules and prompt templates load: `resolveSessionLoads()`
  resolves those against `resolveTenantAgentDir()`. Context files are the
  exception — `discoverContextFiles()` ignores its agent-directory argument,
  so a tenant's `AGENTS.md` is the project's and the operator's is what gets
  dropped.
- **What a tenant keeps** is what a session needs to work: the provider catalog
  and credentials (`getOmpRuntime()`), the skills the operator installed (the
  v0.20.0 decision — rule 1 does not apply to skills), installed extensions and
  custom tools, and a project's own content while it requires no trust.
  Installed tooling is deliberately not filtered by identity: it is the
  operator's store, not authored material for their agent.
- **`lib/session-system-prompt.ts` takes the identity.** User-level prompt
  files live in the process roots, so they are resolved for an admin or a
  `null` identity only, and that lookup passes `project: false` — `user: true`
  alone still scans the project roots and would hand an untrusted project's
  file back. A tenant gets none rather than a guess at their own root, because
  `findConfigFile` takes no agent directory.
- **MCP is off for a tenant**, not only for an untrusted project. `enableMCP`
  is the only lever omp has (`sdk.ts:783`), and an operator MCP server is a
  process with this host's rights; a per-account MCP manager does not exist.
  Known gap: `/api/mcp` still lists the project scope a tenant is allowed to
  edit, while his sessions start with `enableMCP: false` — the panel therefore
  offers entries the session will not launch until a per-account manager can
  decide per server.
- **Memory and autolearn are pinned off.** `sessionSettings()` hands a tenant an
  in-memory `Settings.overlay` with `memory.backend: "off"` and
  `autolearn.enabled: false`. A session reads `getMemoryRoot(agentDir, cwd)`
  with the process agent directory (`memoryAgentDir: agentDir`, `sdk.ts:4941`),
  and `autolearn` gates `manage_skill`, whose `getManagedSkillsDir()` defaults
  to the process agent directory — without the pins a tenant would read the
  operator's memory and mint skills into the operator's store. Known gap:
  memory for tenants needs an SDK seam (`memoryAgentDir` is not a session
  option), so it is off rather than redirected.
- **One asymmetry is a gap.** A tenant has no slash commands of their own:
  `discoverSlashCommands({ cwd })` takes no agent directory, so the operator's
  are dropped and nothing replaces them. Bundled commands remain, and a
  project's own while it requires no trust.
- **Withheld loads are never silent.** Each shortened list yields one `info`
  diagnostic with a count ("3 rules not loaded: this project is not
  trusted."), `GET /api/skills` merges the same lines, and the session start
  logs each one with a `[load-policy]` prefix.
- **A reload cannot widen the list.** Rules, context files, prompt templates and
  skills are pinned at creation (pre-built lists; a `skills` list sets
  `skillsReloadable: false`). Slash commands are not:
  `refreshSkillsAndCommands()` re-discovers them from the process roots, so the
  session subscribes to `subscribeCommandMetadataChanged()` and re-applies the
  filter with `setSlashCommands()`.
- **Settings that decide what every session loads are admin-only.**
  `isAdminOnlySetting()` (`lib/settings-api.ts`) covers `skills.*`,
  `commands.*`, `autolearn.*`, `memory.*`, `extensions`, `disabledExtensions`,
  `enabledProviders`, `disabledProviders`; `PATCH /api/settings` answers 403
  through `requireAdmin()`, and `GET` marks the same fields `writable: false`
  so the panel disables the control. Theme and UI settings stay per-account.

### `SYSTEM.md` / `APPEND_SYSTEM.md` are resolved per session cwd
`omp` resolves both files before it creates a session and passes them as
`customSystemPrompt` / `appendSystemPrompt`. `startRpcSession()` builds its own
options, so `lib/session-system-prompt.ts` does the same for the browser: omp's
`findConfigFile` (never a hand-rolled lookup) project-first then user-level,
`resolvePromptInput` to read it, and omp's `applyResolvedSystemPromptInputs` to
set the fields — so the text goes through the same templates the CLI renders it
with. Every lookup is bound to the session's cwd, because the CLI's default
(`getProjectDir()`) is the server's own directory here, not the project's.
`lib/session-system-prompt.ts` takes the identity because of two gates: a
project's prompt files are dropped for an untrusted project (they are data, but
they are instructions too — `docs/project-trust.md`), and user-level ones come
from the process roots, so `resolveSessionSystemPrompts(cwd, identity)` asks for
them only for an admin or a `null` identity — with `project: false`, because
`findConfigFile({ user: true })` scans the project roots too. A tenant gets
none rather than a guess at their own root, because `findConfigFile` takes no
agent directory.
Skills do **not** load for an untrusted project either — a `SKILL.md` is prompt
text a merely-opened repository must not write on its own.

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

### Compaction SSE events
Newer omp emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking POST — the button stays disabled until the response returns.

### Running state polling + reconciliation
- The sidebar polls `/api/agent/running` every 2.5 seconds while the tab is visible and pauses polling in background tabs. The session-list response remains the initial fallback.
- `GET /api/agent/[id]` answers `running` with `session.isRunning()`, i.e. "this session still owes work" (see *A background delegation is a running session*). A pending background delivery counts as running, and the browser keeps its SSE stream open exactly as long as the field is true.
- `useAgentSession` treats per-session SSE as primary for chat events and opens it before each prompt. `prompt_done` completes the current UI stage and notification immediately, but the idle SSE stays open for a 30-second grace window and is reused by the next prompt. `agent_start` cancels that close timer; `agent_settled` finishes extension-injected runs that have no wrapper-level `prompt_done` and starts a fresh grace window. Do not close on the first `agent_end`: retries, compaction, and extension-queued messages can continue the same logical prompt.
- While a run is active, `useAgentSession` periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed terminal events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.
- `running` is not the same as "a prompt is streaming": a pending background delivery counts too. On mount the stream is connected for any `running` session, not only for a streaming or subagent-carrying one.

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.

### File access allow-list
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from session cwds, their resolved project roots, `~/omp-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- The allow-list is **per account**, not per process. `getAllowedFileRoots(identity)` takes the caller's `WebIdentity`; a missing identity yields the empty set, and it does not even reach `listAllSessions` there, because an unfiltered scan would rebuild the set the identity is there to narrow. Roots live in a `Map` keyed by identity. `"/"` and `OMP_WEB_ALLOWED_ROOTS` are added in the **admin branch only** — a non-admin never sees them.
- Admins are `pi`, `omp`, `steimerbyte` by default, overridable through `OMP_WEB_ADMINS`. The exemption is deliberate and covers writes: a compromised admin password is host compromise, not just a stolen tenant. The write boundary is narrower than the read one — `isWritePathAllowed` filters the filesystem root out of the writable set even for an admin, so `/etc` is readable and not writable.
- Writes are guarded by `isWritePathAllowed` / `authorizeTransfer`, which take an identity with no default. A route that writes and does not call one is a hole; `grep -c isWritePathAllowed 'app/api/files/[...path]/route.ts'` returning 0 used to mean exactly that.
- The identity arrives in the `x-omp-user` / `x-omp-admin` request headers, and `proxy.ts` is the only thing that may set them. It deletes both before it sets them, on **every** path that lets a request through, including the anonymous one. A delete that a branch never reaches is not a protection: on an unlocked server `identity` is null, and a client-supplied `x-omp-admin: 1` used to survive into the route and grant full admin access.
- Accounts live in a separate `omp-web-accounts.json` beside the credential file, with its own schema version, lifetime and ownership. `validateAccountName` rejects anything that is not `/^[a-z_][a-z0-9_-]{0,31}$/`, checked before any `mkdir`, so `../etc` never becomes a directory. With `OMP_WEB_PASSWORD` set there is exactly one account; several accounts need the account file.
- `models.yml` and `config.yml` are per account under that account's agent directory. The **admin's own skills** are the process agent dir (`~/.omp/agent/skills`), as they always were. A **tenant's own skills** live in their account's agent dir. `startRpcSession` keeps the **process** agent directory on purpose — omp's skill loader reads `getAgentDir()` from process state and ignores the `agentDir` passed to `createAgentSession` (`discoverSkills(cwd, _agentDir)`); moving it would split credentials, memory and `agent.db` from the skills without moving the skills. What it does resolve per identity is the **Settings instance** (`getSettingsForIdentity`), and `skills.customDirectories` in the account's `config.yml` is where omp's `loadSkills()` finds the tenant folder. `GET /api/skills/user` registers that absolute entry idempotently, preserving every other key, and `ensureTenantAgentDir` runs before the flush. Without the Settings change a tenant's session read the operator's store while the manager showed him his own. Nothing is migrated: a new account starts empty on purpose, because copying the operator's `models.yml` would hand his API key to the first tenant.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable — but only for an admin. For any other account the candidate is checked against the account's own home with `isPathInUserHome()` and nothing is granted, because the allowlist lives in one process serving every operator: a grant made by one user would widen the filesystem for all of them, permanently.
- `allowFileRoot()` buckets grants per identity. A call without an identity lands in the unattributed bucket, which only admins can see.
- `/api/sessions` and `/api/terminal` filter by owner, and so do the `agent/running` snapshot and its event stream — the ids those two publish are what the rest of the API addresses things by, so leaving them unfiltered leaks through an open SSE channel. A foreign session or shell answers **404, not 403**: a 403 would confirm that the id exists, and the point of the filter is that another account's work is not merely unreadable but undiscoverable. Session ownership comes from the `cwd` in the session file, which means the sessions live in one shared tree owned by the account the service runs as — see the containment note below.
- `lib/sandbox.ts` is the one boundary here that the kernel enforces rather than this code: a tenant shell runs in a `bubblewrap` user namespace, and **exactly one `--bind`**, the tenant's own home, is the whole invariant. Everything else is either a read-only system directory or absent. Measured on the build host: a foreign home answers `No such file or directory` (not `Permission denied` — it is not mounted at all), `/etc/shadow` is `Permission denied`, `sudo -n true` reports that no new privileges flag is set, `su nobody` fails on the token, and `uid=0` in the namespace is not host root. Without root, sudo or `setpriv` the OS-user-per-account route is unavailable, which is why this exists.
- The sandbox refuses rather than guesses, and a tenant terminal **fails closed**: a username that would escape its path segment is `bad-username`, a home that does not exist is `home-missing`, a home of `/` is `admin-home` (never `--bind /`, which is the whole disk read-write), a working directory outside the home is `cwd-outside-home`, and a missing `bwrap` or disabled user namespaces is `bwrap-missing`/`userns-disabled`. Every one of them comes back with a `detail` and a `remediation`, and `POST /api/terminal` answers **503**: no shell starts. Passing such a cwd through verbatim would only surface later as `[Process exited with code 1]` in the SSE stream, and the earlier fail-open branch was worse than either — it opened an unconfined shell with the full service environment (`SHELL-ISOLATION-SCAN.md` §2, measured three ways).
- The terminal's environment is a **positive allowlist behind `--clearenv`** (`TERMINAL_ENV_ALLOWLIST` in `lib/sandbox.ts`), on the sandboxed *and* the admin branch. A `delete env.X` is the wrong shape twice over: it is a blocklist against an environment that grows from outside, and on Bun it does not even remove the value from `/proc/self/environ` let alone from a child. Adding a variable there is a decision that needs a reason. **The allowlist is what the spawn hands over, not the final environment:** the interactive shell is started through `script(1)` and reads `/etc/profile`, so `/etc/profile.d/*` adds to it — measured in a tenant shell: `VSSCRIPT_PATH`, `VIRTUAL_ENV_DISABLE_PROMPT` and `XDG_DATA_DIRS` were present without being in the allowlist. That is root-owned, read-only inside the sandbox, and none of it is a service secret; a secret cannot arrive this way because it is not in the service environment at all.
- An **admin** terminal is never sandboxed, and that is a decision: `getUserHome` gives an admin `/`, and a sandbox around `/` is the disk. `sandboxed: false` in `GET /api/terminal` carries it, the environment is still the allowlist, and the route passes the real `isAdmin` flag into `spawn()` instead of the old hardcoded `isAdmin: false`.
- **Service secrets are not in the process environment, and not readable inside the tenant's shell.** `/etc` is bound read-only (a shell needs it), so the service's own secret files under it — secrets, credential, accounts, session key — are masked with an empty file each (`--ro-bind <empty> <path>`; `/dev/null` fails on `MS_NODEV`, measured).
- **Service secrets are not in the process environment.** The keys omp-web itself reads (`OMP_WEB_PASSWORD`, `GITHUB_TOKEN`) come from `OMP_WEB_SECRETS_FILE` (default `/etc/omp-web.env`) through `lib/runtime-secrets.ts` and `bin/web-auth-store.js`, which keep them in a module value; the unit must not use `Environment=`/`EnvironmentFile=` for them, because every child inherits the process environment — the agent's `bash` (its shell is in-process and reads the native environ, measured), MCP stdio servers (they build `{...Bun.env}`), the scheduler, `git`, `npx`. Keys the SDK resolves itself (model providers, MCP server env) are not read from this file: they belong in the SDK's own store, or they stay in the environment and stay inheritable. `childEnv()` is the map the app hands to the children it starts itself; it drops anything whose name looks like a secret or is a key of the secrets file. Startup logs the names of secrets it still finds inherited.
- **`git` runs with hooks and repo-defined drivers disabled, and without the service env** (`lib/git-safe.ts`: `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `diff.external=`, `--no-optional-locks`, plus `filter.*.clean/smudge/process` and `diff.*.textconv/command` from the repo's own `.git/config`; the diffs pass `--no-textconv`). A driver pulled in through `include.path` stays open — that is the edge of this fix, not an oversight. A tenant-writable repository is otherwise a shell: a `core.fsmonitor` hook received `BRAVE_API_KEY`, `OMP_WEB_PASSWORD` and `OPENROUTER_API_KEY` on the first `git status` (`SHELL-ISOLATION-SCAN.md` §4b, measured).
- **The agent's `bash` tool has no sandbox and cannot get one from this SDK** (18.14.0 has no `sandbox`/`allowedPaths`/`noNewPrivs`, and the shell is embedded, so there is no `bash` binary to wrap). What it does get is a per-session `tool_call` guard (`lib/session-shell-guard.ts`, registered through `CreateAgentSessionOptions.extensions`): `bash` is refused when the session cwd is outside the account's home and the roots explicitly granted to it. **That is the whole gate, measured:** the bash tool's LLM-facing schema in 18.14.0 is `{command, timeout}` — `BashToolOptions` has a `spawnHook`, but the tool input carries no working directory, so the hook resolves one value per call (the session cwd; a `cwd` key only appears if the model invents one) and a `cd /` inside the command text is invisible to it. The shell also runs as the service user with whatever the uid can read, and the guard therefore narrows nothing beyond "this session was opened in a directory the account may use". Only per-account OS users (unavailable, see `lib/sandbox.ts`) or an SDK spawn hook would change that; `docs/inventory-tools.md` states the residual plainly.
- None of the others are containment. Every one is an assignment decided from data the service process can write, so they stop an account from seeing another's work by accident and through the routes that exist, not against someone who edits the underlying files. `docs/authentication.md` says so in the place a reader of this file is pointed at.

### Plugins and skills
- `/api/plugins` drives omp's `PluginManager` (`~/.omp/plugins`): install, uninstall, enable/disable, plus `doctor()` output as diagnostics. omp has no in-place update, so "update" reinstalls the spec with `force`.
- `/api/skills` uses omp's own `loadSkills()`, so `.omp/skills`, `~/.omp/agent/skills`, `.claude/skills`, plugin skills and `.agents/skills` are listed exactly as a session sees them. The list is resolved with the caller's identity (its Settings instance), but it is still the *union*: an admin sees the managed/global entries, a tenant additionally sees their own `custom:user` folder. Under an untrusted project it drops the project-scoped entries through the same filter the session uses (`trustedProjectSkills`); the panel must never advertise what the session did not load.
- The **skills manager** (`?view=skills`, `components/SkillsManagerView.tsx`) reads and writes only the caller's own store: `<agent dir>/skills/<name>/SKILL.md`. Its routes are `/api/skills/user` and `/api/skills/user/[name]`. They address a **name**, never a path, validate it with the managed-skill rule `^[a-z0-9][a-z0-9-]{0,63}$`, derive the folder themselves, refuse symlinks, and write atomically. A foreign tenant's name answers **404**, because the folder is derived from the caller's home and does not exist there.
- These routes deliberately bypass `protectedRootReason` (the `omp-runtime` 403 that refuses every `.omp` write through `/api/file-actions`). Do **not** loosen that shared guard: its refusal is what stopped the 2026-10-20 recursive delete, and it has no identity argument to reason with. The manager bypasses it by never accepting a path and by owning one narrow subtree; that is the difference.
- A skill without a frontmatter `description` is skipped by omp **silently** (`requireDescription: true`). The editor refuses such a save and shows a diagnostics badge on any existing skill that has one, because a stored skill that never loads is the most common failure.
- Toggling is still `PATCH /api/skills`, still **admin-only**, and edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives. It edits whatever `filePath` the union discovery produced (including the operator's) and is not the manager's write path; making it identity-aware would be a second, weaker write boundary next to the manager. The manager never calls it.
- `/api/skills/install` shells through `npx skills add ... --agent claude-code`. The `skills` CLI has no `omp` agent, and its `pi` agent writes `~/.pi/agent/skills`, which omp does **not** read; the Claude layout is discovered by default.

### The calendar is per account, and the agent is bound to one
- The calendar lives in `omp-web-calendar.json` in the tenant's agent dir — the same shape as `omp-web-quick-phrases.json` and `omp-web-projects.json`. One file per account, `omp-web-` prefix, atomic write with `0o600` (`lib/calendar-store.ts`).
- **Time is local and zone-less.** `2026-03-14` for an all-day event, `2026-03-14T15:00` for a timed one. No `Z`, no offset. A calendar shows events in the reader's timezone, and a stored offset has to be converted at read time — that is exactly where a calendar starts showing the wrong time. No zone means nothing to convert.
- **`calendar_read` and `calendar_write` are native `customTools`**, registered next to `present_files` in `lib/rpc-manager.ts`. Native because the calendar belongs to the *account*, not the project: a `.omp/extensions` file would depend on project trust (`lib/project-trust.ts`), and the calendar depends on the identity that opened the session.
- **The identity travels with the session.** The tools run in the server process and find no request to read the account from, so `RpcSessionStartOptions.identity` carries it in and the factory closes over it. Without that binding every account would share one file, and a tenant's agent would read and write the operator's calendar.
- **The domain has no `fs` and no `fetch`** (`lib/calendar.ts`), so the browser and the server answer "what is a valid event" identically. The screen layout — where an event sits, how a move preserves the duration — is presentation and lives in `components/calendar/calendar-model.ts`.
- **The month grid is always six weeks.** The number of weeks a month covers varies with the weekday it starts on; a table that changes its height jumps while you page through it, and a calendar that jumps is unusable because you hit the wrong event.
- **The ISO week uses the Thursday, not the 1 January.** ISO 8601's first week is the one containing 4 January, and 1 January can belong to the last week of the previous year. `firstThursdayOfYear()` is the Thursday of the week containing 4 January — for 2026 that is 1 January, because 4 January is a Sunday.
- **The import is two steps, and without the second one nothing is written.** `POST /api/calendar/import` parses the file and reports what it would import; only `apply: true` writes. An import cannot be undone, and the preview makes the mistake visible *before* the write instead of after it.
- **The parser does not guess.** A rule it cannot evaluate is reported, not expanded into something that merely looks right. A rule without an end is not expanded at all: the caps are `MAX_ICS_OCCURRENCES_PER_EVENT` (1000) and `MAX_ICS_OCCURRENCES_PER_IMPORT` (2000), both asserted by number in `lib/calendar-ics.test.mjs` — "an endless rule never expands without a limit" holds the first, "an import with too many events stops at the limit of the import" the second — because a file that would yield more events than a calendar can hold must not hang the import.
- **The zones follow the storage rule.** A `Z` is converted to the local time of the machine that runs the import; a `TZID` is not, because the wall time is what the calendar shows. The calendar knows no zones — the same decision as when storing an event.
- `docs/calendar.md` has the rest.

### Scheduled tasks start a normal session, and the timer is one timer
- A scheduled task is a cron schedule, a model and a prompt. When it is due the
  scheduler starts an **ordinary omp session** with that prompt, so the run
  shows up in the tenant's normal history. There is no second kind of run and
  no separate transcript: `lib/scheduler.ts` calls `startRpcSession` and
  writes nothing else.
- **Every run is a fresh session, deliberately.** Writing the prompt into an
  existing session would interrupt a conversation the user is having — and
  `send({type:"prompt"})` throws outright while a shell command is running
  there. A fresh session is also why the idle reaper is not a problem: the run
  is reaped after its own idle timeout like any other session.
- **The session needs `owner`, or it is invisible to its own tenant.** Without
  `owner`, `startRpcSession` stores the empty string as the owner and
  `isRpcSessionVisibleTo` matches no account — the run would not appear in the
  history that asked for it.
- **The schedule math is `lib/schedule.ts` and has no `fs`.** Five fields,
  `*` / number / `a-b` / `a-b/n` / `*/n` / comma lists, nothing else: `L`, `W`,
  `#`, `@reboot` and six fields are refused with a typed error naming the field
  and the token, not interpreted. Day-of-month and day-of-week combine with OR
  when both are restricted (POSIX). Times are **server local time** — the agent
  runs on the same machine, and hand-rolled zone math is where a schedule
  starts firing at the wrong hour.
- **`nextRunAfter` scans minute by minute**, bounded by `MAX_SCAN_MINUTES` =
  2921 days. The number is measured, not guessed: it is the largest gap
  between two 29 Februaries in the Gregorian calendar (2096 → 2104, over the
  missing leap day 2100). Four years was the first attempt and it refused a
  valid `0 8 29 2 *` scheduled from 2097. `lib/schedule.test.mjs` asserts the
  number in the error message.
- **The firing rule is pure.** `selectDueTasks(tasks, {lastTickMs, nowMs})`
  takes no timer and no HTTP, so "what is due" is testable without waiting. It
  fires when a task is enabled and a slot lies in `(lastTickMs, nowMs]`, once
  per task per window, with the **first** slot of the window. A six-hour outage
  therefore produces one run, not twenty-four: there is no catch-up storm and
  no queue. The cursor is monotone, so a **backward** clock jump stops firing
  until the clock catches up — the quiet direction, chosen on purpose: a missed
  run is better than a doubled one.
- **The timer is a singleton, and there is exactly one.** It lives on
  `globalThis.__ompScheduler` (a module variable is empty again after the dev
  server's hot reload, which would mean a second timer next to the first) and
  it is armed for the *earliest* due slot across all accounts. A timer per task
  would be one wakeup per task, nearly all of them finding nothing. It is
  re-armed after every tick and by every API mutation (`rescheduleScheduler`),
  so a changed schedule takes effect immediately instead of at the next
  wakeup. The delay is capped at one hour (`MAX_TIMER_DELAY_MS`) so a task
  scheduled weeks out cannot stop the process from noticing a changed file.
- **The scheduler never keeps the UI from booting.** It is started from
  `instrumentation.ts` — the only lifecycle hook Next offers — inside a
  `try`/`catch` that logs and continues. A broken scheduler is a missing
  feature; an instrumentation that throws is a server that does not start.
- **`claimRun` is what stops a double fire.** The claim lives in the file, not
  in memory, so it survives a restart and covers a second server process on the
  same host. It compares `slotMs <= claimedSlotMs`, so a slot that is already
  behind is past. The order is claim first, start second: two processes both
  starting and then finding out is the failure the claim exists to prevent.
  The check-and-write runs under a lock file (`<store>.lock`, `wx`, taken over
  after 30 s by rename-and-verify, not rm-and-create); within one process the
  guard is unnecessary because the section is synchronous, but two instances
  on one filesystem are normal here.
- **A second long-lived process is normal** (`scripts/deploy-local.sh` serves a
  live and a verify instance from the same accounts), which is the reason the
  claim is a file and not a `globalThis` lock. `lib/projects-sizes.ts` uses the
  in-process lock because its unit of work is one registry *path* and a run it
  loses only costs a measurement; a run this scheduler loses would cost a
  duplicated agent session.
- **Tasks live in `omp-web-scheduled-tasks.json`, one file per account**, in
  `resolveTenantAgentDir(identity)` — the same shape, prefix, `0o600` atomic
  write and path guard as the calendar and quick phrases
  (`lib/scheduled-tasks-store.ts`).
- **A malformed row is dropped, not repaired.** The app must never fail to boot
  because of one bad row, and a normaliser must not invent fields: a missing
  `createdAt` drops the row instead of stamping "now", because the user would
  then believe they created it today. Only *optional* fields (`thinkingLevel`,
  `lastRun*`, `claimedSlotMs`, `cwd`) degrade to absent when unreadable.
- **`schemaVersion` is compared on read, and a mismatch refuses to write.** A
  newer build may have added fields this one drops; overwriting would destroy
  them, so every mutating helper throws with `field: "version"` (HTTP 409)
  instead.
- **No model list is hardcoded.** The store takes a `KnownModelLookup`, the
  routes pass `modelRegistry.find(provider, modelId) !== undefined`, so there is
  no second, stale copy of `config.yml`.
- The UI is `components/ScheduledTasksView.tsx` + `hooks/useScheduledTasks.ts`,
  reached as `?view=scheduled`; its delete confirmation is a state inside the
  dialog, like the calendar's, because `window.confirm()` always returns false
  in the desktop shell. The view is listed in `skipInitialProjectSelection`, so
  `?view=scheduled` survives the sidebar's automatic first cwd adoption: that
  adoption counts as "go to the work" and would otherwise switch the view away
  from the page the URL asked for.
- **This re-opens the "background work is request-triggered" stance.** The
  projects dashboard measures only while somebody looks at it; a scheduled task
  by definition has nobody looking at it, so this feature is the one timer in
  the process. It is bounded by design — one timer, one wakeup per due slot, no
  queue and no catch-up — so the load it creates without a request is a session
  the user asked for in advance, not work on a TTL.

### The stats dashboard is embedded, not proxied
- **No second server, no second browser.** The CLI's `/stats` starts its own
  HTTP server and opens a browser. omp-web does neither: `@oh-my-pi/omp-stats`
  is a library (data in `~/.omp/stats.db`, aggregation and rollups), and
  `lib/stats.ts` serves a cached payload from it. `startServer()` is never
  called and `closeDb()` is never called — the handle is shared and
  long-lived, and an import of the library stays lazy so merely importing a
  route does not open a SQLite handle and its sync workers.
- **`GET /api/stats` is admin-only, and that is a boundary, not a preference.**
  `requireAdmin()` guards it because that database is process-global and
  aggregates every account's sessions on this host — served to a tenant it
  would be the operator's work, read back through someone else's page. The
  ranges are `STATS_RANGES` (`1h`, `24h`, `7d`, `30d`, `90d`, `all`, default
  `24h`); an unknown range, `?range=` included, answers **400** with the
  allowed list instead of silently serving a different window.
- **The sync is request-triggered and backgrounded**, the same rule as the
  projects dashboard: single-flight per range on `globalThis` (a module-level
  map is empty again after the dev server's hot reload, which would start a
  second sync next to the first), a TTL (`STATS_TTL_MS`), and a `get()` that
  never awaits IO. A first call may answer `stats: null, syncing: true`; a
  failed sync **keeps the last good payload and records `error`** — an error is
  an answer, not an empty dashboard. `?refresh=1` starts the sync before the
  read, so the payload it returns already reports `syncing`. A forced refresh
  starts a sync **unless the cache is younger than `STATS_MIN_REFRESH_MS`**
  (5 s); the TTL decides only whether an *unforced* read needs one. The floor is
  a rate limit, not a TTL guard — which is why a forced payload can report
  `syncing: true` while the cache is still fresh, and why a held-down refresh
  button syncs once every 5 s rather than walking the database.
- **The page** is `components/StatsView.tsx` + `hooks/useStats.ts` at
  `?view=stats`, persisted through `lib/initial-navigation.ts`. Its button lives
  in the sidebar's bottom action stack **directly above Settings** — the stack
  is rendered by the `sidebarContent` block inside `components/AppShell.tsx`,
  not by `SessionSidebar.tsx` — and it is hidden for a non-admin, using the
  `isAdmin` the shell already reads from `/api/whoami`: a button offered and
  then refused is worse than no button. Charts are inline SVG with the theme's
  CSS variables; there is no chart dependency and no iframe (nor an iframe
  fallback), so the page follows an imported theme like the rest of the app.
- **`@oh-my-pi/omp-stats` is not a direct dependency**, and that is a risk
  taken knowingly: it resolves through `@oh-my-pi/pi-coding-agent`, the same
  house habit as `@oh-my-pi/pi-catalog`. An upstream bump that drops it would
  turn `lib/stats.ts` into an import failure at runtime, and the honest fix is a
  direct entry in `package.json` — nothing was added there by this change set.
- **The poll rule is one rule**, in `hooks/useStats.ts` and modelled on
  `lib/project-size-poll.ts`: 2 s interval (`STATS_POLL_INTERVAL_MS`), a 120 s
  window (`STATS_POLL_WINDOW_MS`), and it stops as soon as the server reports
  `syncing: false`. A second, separately written poll would drift from the
  first the moment one of them is tuned.
- **What this first integration does not cover**: only overview, time series,
  models, projects/folders and tools are rendered. The CLI dashboard's
  trace, frustration and gain views need separate endpoints that are not
  exposed here, so the page does not pretend to be the whole CLI dashboard.

### The update check compares against this repository's releases
- This fork is published as a GitHub release in `steimerbyte/omp-web` (`docs/release.md`). The npm package `omp-web` belongs to the **upstream** line and is a different build; the publish workflow is disabled here.
- `lib/omp-updates.ts` therefore reads exactly one source: `https://api.github.com/repos/steimerbyte/omp-web/releases/latest`. The npm registry is not consulted at all, and every release link that leaves the server points at `steimerbyte/omp-web` — a payload that names another repository has its `html_url` replaced, not forwarded.
- There is no automatic install: `install.canInstall` is permanently `false` and `install.reason` says why (`manual`, `disabled`, `current-version-unknown`). The releases carry no server artifact a route could install, and the one command the upstream code knew — `npm install --global omp-web@latest` — would have replaced the running server with the foreign build.
- `POST /api/updates` stays admin-only and answers 409 with the status; `GET` stays open. The indicator renders nothing while `updateAvailable` is false, as before.
- `lib/omp-updates.test.mjs` pins all of this: which URL is asked, that a foreign package with a higher version changes nothing, and that the module names neither the upstream repository nor the npm registry.

### Auth and model config
- Credentials live in omp's SQLite `agent.db` via `AuthStorage`, not in `auth.json`. Writes go through `authStorage.set()` / `remove()` / `logout()` so the CLI and omp-web share one store and one lock.
- Provider listing is capability-driven: `lib/provider-listing-runtime.ts` folds the catalog (`@oh-my-pi/pi-catalog`), the OAuth registry (`@oh-my-pi/pi-ai/oauth`) and stored credential types into the flat shape `lib/provider-listing.ts` expects, so a dual-auth provider appears exactly once. An OAuth login whose `storeCredentialsAs` differs from its id is keyed by the id the catalog uses.
- OAuth flows are streamed by `GET /api/auth/login/[provider]` through `authStorage.login()`; `onAuth`/`onPrompt`/`onManualCodeInput` become browser input requests with short-lived tokens stored in `globalThis.__ompLoginCallbacks`.
- API-key status endpoints must never return the raw key.
- `models.yml` is YAML: `/api/models-config` parses whichever of `models.yml` / `models.yaml` / `models.json` exists and always writes back `models.yml`.
- A header value in `models.yml` that names an environment variable is written as the **bare name** (`X-Token: MY_VAR`), not `$MY_VAR`.

### Password access is verified in the proxy, stored hashed, and shared with `bin/`
`bin/web-auth-store.js` is the single source of truth for the password lock, and
it is CommonJS in `bin/` on purpose: the launcher needs it before Bun is even
resolved, and `bin/` is the only directory (besides `.next`) in the published
npm `files` list, so `lib/` cannot hold it. `bin/web-auth-store.d.ts` is what the
TypeScript half type-checks against — keep the two in sync.

- The password is stored **only** as a scrypt digest in
  `<agentDir>/omp-web-auth.json` (`0600`, atomic replace). Nothing can read it
  back, which is why `/recover` and `--reset-password` exist.
- `proxy.ts` runs on Next.js 16's Node.js runtime (proxy always does), so
  `node:fs` and `node:crypto` are available there. Do **not** import the omp SDK
  into it — `next.config.ts` only externalizes `@oh-my-pi/*` for the server
  build, and the SDK cannot be bundled. That is why the store re-derives the
  agent directory instead of calling `getAgentDir()`.
- `resolveWebAuthPolicy()` distinguishes a missing credential file (unlocked)
  from an unreadable one (`unavailable` -> 503). Never collapse those: the
  second one failing open would silently unlock the server.
- Successful verifications are cached for five minutes keyed by the digest that
  accepted them, because scrypt runs on every request otherwise. The key
  includes the digest, so a password change invalidates the cache across
  bundles.
- `/recover` and `POST /api/web-access/recovery` are the only unauthenticated
  paths. They still go through the host allow-list and cross-site checks, and
  the recovery code is printed on the server's stdout, never returned in the
  response.
- The session cookie is **one attribute set**, written only by
  `sessionCookieOptions()`: `HttpOnly`, `SameSite=lax`, `Path=/`, `Secure` only
  when the request arrived over HTTPS, and `Max-Age` from `SESSION_TTL_MS`
  (30 days, sliding — re-issued past half its life). Login, `proxy.ts`'s
  renewal and logout all call it, because two `Set-Cookie` headers that differ
  in an attribute are two cookies. `lax` and not `strict` is deliberate: a link
  from another app is a cross-site top-level navigation, `strict` withholds the
  cookie on exactly that request and lands a signed-in user on `/login`. It is
  not the lock on the API — `isApiRequestAllowed()` refuses
  `sec-fetch-site: cross-site` before the cookie is read.
- **Passing `proxy.ts` is not being an admin.** The proxy answers three
  questions — host allow-list, cross-site, valid credentials — and releases
  *every* valid account. A tenant passes it exactly like the operator. Every
  route that changes something host-wide (`/api/web-access`,
  `/api/web-access/users`, global skill writes, and the host-wide keys of
  `PATCH /api/settings` — see "The load policy decides what an identity
  loads") calls `requireAdmin()` from `lib/request-identity.ts`, next to
  `isAdminIdentity`; that function is not copied into routes. A route
  that writes and does not call one is a hole, the same way `isWritePathAllowed`
  is — and on 12.10.2026 a comment claiming the proxy had already covered it
  is exactly what let `bob` turn the password lock off and walk in.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` as `omp-sound-enabled` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

### Quick phrases
- `lib/quick-phrases.ts` holds the shape, the validation, the defaults and the
  caption — no `fs`, no `fetch`, so the browser bundle and the route share it.
  It must **not** go through `/api/settings`: that endpoint projects a schema
  owned by a pinned package, and these phrases are not part of it. The agent
  never reads them either; they are composer input.
- **The list lives on the server, one file per account.**
  `app/api/quick-phrases/route.ts` (GET/PUT) follows the `models-config` route:
  `requireIdentity`, 403 in both handlers, 415 without a JSON content type. The
  file is `omp-web-quick-phrases.json` inside `resolveTenantAgentDir(identity)`,
  written with `writePrivateFileAtomicSync` (0o600, temp file + rename).
- The `omp-web-` prefix matches `omp-web-trusted-projects.json` in
  `lib/project-trust.ts`: the file lives in the agent directory but is not omp
  configuration and must never be read or overwritten by omp.
- **The path is checked before the directory is created.**
  `requireIdentity` calls `isQuickPhrasesPathAllowed`, which runs
  `isPathWithinRoots` against `getUserHome(identity)` — the same ordering as
  `app/api/default-cwd/route.ts`. Creating first and checking afterwards leaves
  a file in a foreign home for every refused request.
- `exists` in the GET response is the seed flag. A file that exists with an
  empty list is a decision by the user and is never topped up; a missing file
  is the only case that may seed, once.
- **Migration from the browser-only version** (`omp-quick-phrases` plus
  `omp-quick-phrases-seeded`) runs at the first server fetch: local phrases move
  to the file, and the defaults are seeded only when *both* legacy keys are
  absent. The legacy keys are cleared **after** the PUT succeeds, so a server
  crash between read and write leaves the phrases in the browser to be offered
  again. `lib/quick-phrases.test.mjs` guards those three cases.
- `hooks/useQuickPhrases.ts` is the module store (`useSyncExternalStore`,
  pattern of `useDisplaySettings`): the settings dialog and the composer are
  separate subtrees, so a store replaces a prop chain without a reload.
  `loadQuickPhrases()` is single-flight, so composer and dialog mounted at the
  same time produce one GET, not two. A failed request sets `error` and leaves
  the last seen list standing — nothing is cleared and nothing sticks in the
  loading state.
- **Typing is debounced in `components/QuickPhrasesConfig.tsx` (400 ms), not in
  the store.** `setQuickPhrases(next, false)` updates every subscriber at once
  and skips the PUT; the timer writes once. It also fires on `onBlur` and on
  unmount. Delete and Add persist immediately — a delete that waits for a
  debounce window looks to the user like the row came back.
- **A phrase without a non-empty `text` is dropped** on read and on write —
  a button that inserts nothing is a silent malfunction. An empty `label` is
  legal and falls back to the text, shortened by `quickPhraseCaption`.
- The composer row sits above the input (`ChatInput`, before the `Main input`
  anchor) and reuses `insertTextAtCursor`. Wrapping is deliberately off — the
  row scrolls horizontally (`overflowX: "auto"`), so twenty phrases stay one
  click deep instead of costing three rows of transcript height.
- The button label is user content and is therefore never translated; only the
  settings section's own strings go through i18n.

### The projects dashboard measures in the background
- `GET /api/projects` does **not** measure folder sizes. It shipped the last
  known value and left the measurement to a background run
  (`lib/projects-sizes.ts`), because the measurement used to run inside the
  request: one measurement of the 18 roots of a real registry takes **20,5 s**
  (measured 2026-10-22 on the dev host, the details in
  `lib/project-size.ts`), and the board showed nothing at all for those
  seconds.
- **The run re-reads the registry immediately before it writes.** It read the
  file once to learn *what* to measure and once more to learn what the file
  *now* says; `applySizeMeasurements` then touches `sizeBytes` and
  `sizeMeasuredAt` and nothing else. Without the second read the run wrote
  back a snapshot that was twenty seconds old and silently overwrote whatever
  the user had changed in the meantime — a changed priority, a todo counter,
  a status. That was data loss, and `app/api/projects/size-race.test.mjs` was
  written to reproduce it (it was red against the old code).
- **One run per registry, not per request.** The lock lives on
  `globalThis.__ompProjectSizeRuns` and is keyed by the *registry path* — the
  path is the unit of contention, because two admin accounts share one global
  registry file. A module-level `Map` would be empty again after the dev
  server's hot reload, and a second run would start while the first was still
  measuring. The lock is released in a `finally`.
- **The expensive thing is the number of tree entries, not the number of
  bytes.** Measured over 15 folders on 2026-10-22: the byte count explains
  the duration of a `du -sb` with r2 = 0,334, the inode count with r2 = 0,919
  (`tmp`: 20,82 GB and 0,52 s at 27.518 entries; `omp-web`: 2,41 GB and
  4,47 s at 131.766). `du` stats the entries, it does not read the contents.
  On top of that 11 of the 18 roots of a real registry lie inside other
  roots, so the workspace tree is walked nine times — nine passes over
  487.348 entries. The comment in `lib/project-size.ts` holds the
  measurement; do not believe an older version of it ("a 2.4 GB folder takes
  visibly longer to measure than a 40 MB one" — measured and wrong).
- **A folder with an unreadable subdirectory keeps the number `du` computed,
  as a lower bound.** `du` exits 1 and still prints the total of what it
  could read; `execFile` throws that stdout away with the error. The number
  is kept now, and it is a *lower bound* — the registry says so
  (`sizeIsLowerBound`) and the card shows a "≥". A number that looks exact
  and is not is worse than no number.
- **The sizes overlap.** A parent's size contains its children's bytes, so
  the sum of the sizes on the cards is counted twice. That is the existing
  semantics and it stays; `docs/spec.md` says so for the reader.
- **The TTL has to be longer than the measurement.** `SIZE_TTL_MS` was 30 s
  against a measurement that takes 6,9 s to 20,5 s, so every request found
  the previous result expired and started a new `du` swarm. It is five
  minutes now; the number, the measurement and the duty-cycle calculation
  are in the comment above the constant, and `lib/projects-schema.test.mjs`
  asserts the same value. The run is **request-triggered**, not on a timer:
  a closed dashboard costs nothing, and a TTL cannot create load on its own.
- **The poll window is derived from the measurement, it is not a second
  number.** The worst case of a measurement is `ceil(projects / MAX_PARALLEL)
  * SIZE_TIMEOUT_MS`, because the pool rounds are serial, and the poll has to
  outlast it: `sizePollLimitFor(projectCount)` in
  `lib/project-size-poll.ts`. Two fixed numbers next to each other is how
  this broke — a 120 s window against a 150 s worst case at 40 projects.
  `lib/project-size-poll.test.mjs` derives the worst case from the constants
  and checks the relation.
- **After the poll ends, the size stands, and the card shows its age.** A
  slower poll would trigger measurement runs again — the same `du` load in
  another cadence (one run per TTL = 6,8 % of the filesystem, for as long as
  the tab is open). So the card says how old the number is once it is older
  than the TTL.
- **A failed measurement is an answer, not a promise.** `isSizeMeasurementStale`
  decides on the timestamp, not on the value: a folder that could not be
  measured has a fresh timestamp and `sizeBytes: null`. The card draws that
  apart from "not measured yet" (no timestamp at all) — one is "no size", the
  other is a placeholder. With the 30 s budget, 16 of the 18 folders of the
  measured registry have a number and 2 have none (two roots that do not
  exist on the disk); the "seven without a size" was the state of the *old*
  10 s budget, not of this one.
- **Three states of a size, and the card names all three.** *Measured*
  (`sizeBytes` is a number, `sizeMeasuredAt` set); *measured but incomplete*
  (`sizeIsLowerBound: true` — `du` could not read part of the tree, so the
  number is a lower bound and the card shows a "≥"); *not measurable*
  (`sizeBytes: null` with a timestamp — the attempt happened and produced
  nothing). A fourth state is the placeholder for a measurement that has not
  run yet (no timestamp at all).
- **The guard is shared.** `requireProjectsIdentity` in
  `lib/projects-guards.ts` is the only place that checks the account *and*
  the derived registry path; `app/api/projects/route.ts` and
  `app/api/projects/sizes/route.ts` both call it. A copy in a route is a
  second thing to get out of date.
- **The poll is its own endpoint.** `GET /api/projects/sizes` reads one small
  JSON file; `GET /api/projects` starts a git process per project. 30 polls
  over 18 projects would be 540 git invocations. The rule of the poll itself
  (2 s interval, 60 polls at most, ends when the server says `pending:
  false`) is in `lib/project-size-poll.ts`, not in the component, so it can be
  tested without a DOM.

### Animations
- **`motion` is the only animation source.** The old `.omp-*` classes and their
  `@keyframes` are gone from `app/globals.css`. Do not add a new keyframe for a
  one-off: build it from `components/motion/`.
- The primitives are `Shimmer` (loading wash), `Skeleton` (loading placeholder,
  reserves its box when animations are off), `Reveal` (panel entrance),
  `Pressable` (tap feedback, `tint` for the accent flash), and `Enter` /
  `ModalBackdrop` / `ModalPanel` / `Spin`. Shared timings live in
  `components/motion/animations.ts` — import from there instead of writing your
  own duration.
- **All of them forward their ref and the rest of the motion props.** That is
  deliberate: several popovers measure their own box to decide which way to
  open, and a primitive that cannot hand back a ref gets reimplemented inline,
  which is how the duplicated `session-info-pop` keyframes appeared in the
  first place. If a primitive does not fit a callsite, widen the primitive.
- **The mode lives in `localStorage` as `omp-animations`**, not in
  `/api/settings`. That route projects a schema out of the pinned
  `@oh-my-pi/pi-coding-agent`, so a new path there means patching a foreign
  package for a value the server never reads. It is a surface preference, the
  same line as `omp-sound-enabled` and `omp-theme`.
  `components/motion/animation-mode.ts` holds the rules (no React, so they are
  testable) and `AnimationProvider.tsx` the React binding, mounted in
  `app/page.tsx`, `app/login/page.tsx` and `app/recover/page.tsx`.
- `MotionConfig reducedMotion="always"` stops what motion owns; the
  `html[data-omp-animations="off"]` block at the end of `globals.css` stops the
  rest — the login CSS module, the panel-width transitions, every inline
  `transition:` string. A millisecond, not zero, so a `transitionend` listener
  still fires.
- `hooks/useTheme.ts` checks the same attribute before running the view
  transition. Without it a theme change would sweep while everything else
  stands still.
- **Never set `will-change` by hand and never write a colour literal.** Motion
  manages `will-change`; pinning it on a permanently animated element holds a
  compositing layer for the life of the page. Colour literals break imported
  themes, because `applyOmpPalette` rewrites the variables at runtime.

### The gradient border on the chat input
- **The ring is a band around the bar, and it never eats the content's
  padding.** The containing block of an absolutely positioned element is the
  **padding box** of its positioned ancestor, not the border box, and the bar
  carries a one pixel border — so the bar's padding box starts one pixel
  inside the bar's border box. `inset: -O` puts the layer's border box at
  `1 - O`, `padding: P` puts its padding box at `1 - O + P`, and the band that
  is left over between them is the ring. With `O = P = W + 1` the band runs
  from `1 - (W + 1)` to `1`: it covers the bar's border and reaches no pixel
  into the padding, at any width. The offsets are written down by
  `gradientBorderRingGeometry()` in
  `components/motion/gradient-border-settings.ts` and held down by
  `components/motion/gradient-border-settings.test.mjs`; the stylesheet only
  reads the two variables it writes.
- **The ring replaces the amber border, it does not sit next to it.** While an
  agent works the bar's border colour becomes transparent and the ring takes
  its place; the border's width stays one pixel, so the bar does not move.
  Two signals on the same edge compete visibly, and the ring covers the
  border anyway. The amber border is still there when the effect is off.
- **The animated state is separate from `isStreaming`.** `isStreaming` is the
  busy state of the whole surface and is true while a shell command runs; the
  ring is about an agent working, so `ChatInput` gets its own
  `isAgentRunning` flag, which `ChatWindow` fills from `useAgentSession`'s
  `agentRunning`.
- **The surface preference lives in `localStorage` under
  `omp-gradient-border`**, not in `/api/settings` — the same line as
  `omp-sound-enabled` and `omp-theme`, for the same reason. The rules are in
  `components/motion/gradient-border-settings.ts` without React, the binding
  is `components/motion/GradientBorder.tsx`, and the panel is the group in the
  Animations section of the settings.
- **The halo has to lie outside the ring.** The ring ends `W` pixels beyond
  the bar's border box, so the halo's spread follows from the ring's width
  (`gradientBorderGlowSpread()`); a halo inside the ring is not a halo but a
  smear.

### Comments that state a number need a test that checks that number
- **A comment naming a figure, a duration or a measurement requires a test that
  asserts the same figure.** Otherwise the next reader is worse off than the
  author: the comment reads as evidence, and it is only a recollection. Three in
  this repo asserted the opposite of what was measured, and each one caused a
  later change to be built on it.
  - `app/login/login.module.css` explained that the idle loop moved a different
    axis than `Reveal`, so the two would not collide. Measured in Chromium: the
    inline `transform: translateY(-7.8px)` was overwritten by keyframes on
    `transform`, and the translate component was `0` in every sample of the
    entrance.
  - `app/api/web-access/route.ts` claimed an authorization that was not
    performed. A comment asserting a *vulnerable* state is read as a safety
    guarantee by the next person.
  - `normalizeAccountEntry` claimed trustworthiness that did not exist.
- **Prefer writing the measurement into the test rather than only into the
  comment.** A comment cannot fail; a test can, and it is the only one of the
  two that notices when the behaviour moves away from the claim.
- Record where the number came from and when it was taken. "Measured in
  Chromium, all 40 ms across the 240 ms entrance" tells the next reader whether
  the claim is worth keeping; a bare number does not.

### Test fixtures come from the writer, not from memory
- **A fixture that reproduces a file must be produced by the function that writes
  it**, or the test asserts a shape no writer ever emits and passes forever.
  `lib/session-reader.test.mjs` wrote `type: "session"` into line 1 while every
  real writer puts a `title` record there, so `readSessionHeader()` — which
  reads exactly one line and accepts only `type === "session"` — returned
  `null` for every session that actually exists, with a green suite throughout.
  Measured 2026-10-12 across 400 real session files: first record is `title` in
  400 of 400.
- The same applies to any on-disk format: hand-writing the bytes tests your
  memory of the format, not the parser.
- If calling the real writer is impractical, fix the fixture and **comment the
  deviation in the test**, saying which writer it stands in for and why.

### Exported session HTML
- `/api/sessions/[id]/export` delegates to omp's export helper, then patches recursive tree helpers in the generated HTML to iterative versions so very deep linear sessions do not overflow the browser call stack.

### HTTP proxying
Bun's `fetch` reads `HTTP_PROXY` / `HTTPS_PROXY` **once at process start** and
never proxies loopback — which is what local providers need. It ignores
`NO_PROXY`. `lib/http-dispatcher.ts` is therefore a no-op under Bun; its undici
`EnvHttpProxyAgent` path only exists for a dev server run on Node, because Bun
resolves `undici` to its own shim where `setGlobalDispatcher` does not affect
`fetch` and `install` does not exist.

## omp Session File Format

Location: `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"title","v":1,"title":"...","source":"auto","updatedAt":"..."}
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"model":"anthropic/claude-sonnet-5","role":"default","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"mode_change","id":"<8hex>","parentId":"<8hex>","mode":"vibe","data":{"previousTools":["read","bash","edit"]}}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

**The first line is a `title` record, not the `session` record.** Measured
2026-10-12 across 400 real files under `~/.omp/agent/sessions/`: `title` in 400
of 400. A reader that parses only line 1 and checks for `type === "session"`
therefore finds nothing in any file that exists. Use
`readSessionRecord()` in `lib/session-reader.ts`, which scans the leading lines
for the `session` record; `readSessionHeader()` is the one-line variant and
returns `null` for every real session.

`model_change` carries a `provider/modelId` string plus the **role** it came
from; `SessionContext.models` is a role → selector record, and `models.default`
is what the UI shows as the session's model.

`mode_change` is how a session records the mode it is in — `vibe` with
`data.previousTools` on entry, `none` on exit (`plan` and `goal` use the same
record). Nothing else in the file says "this session is in vibe mode", so a
reader that skips the entry restores the wrong toolset. The entry is also the
only place the pre-vibe tool names survive a restart.

Read it **through the branch**, not by scanning the file from the end:
`SessionManager.buildSessionContext()` reports `mode`/`modeData` from the last
`mode_change` on the path to the active leaf, which is the only answer that
survives `navigate_tree` — a sibling branch can hold a later entry than the
branch the session is actually on. The browser does not need to write the exit
either: the registry's own exit (`#persistModeExit`, inside `killAll`) appends
the worker tombstones and the `none` atomically, and its zero-record path skips
the write when the branch already ends in `none`.

Vibe workers add their own records beside it: `{"type":"custom",
"customType":"vibe-session-lifecycle"}`, written by the SDK's registry, one per
spawn / turn / tombstone. `VibeSessionRegistry.rehydrate` reads them to decide
which worker sessions can be resumed and which died with the mode, so a
browser-started session and a TUI session resume the same way. Do not strip
`custom` entries as noise when rewriting a file.

---

## CSS Variables (`app/globals.css`)

Both themes come from omp's own theme files — `titanium` (omp's default dark
theme) and `light` — so the browser and the TUI read as one product.

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --accent-hover --user-bg --assistant-bg --tool-bg --bg-subtle
--success --danger --warning
--font-mono
```

`--font-mono` is a system stack on purpose: a local-first tool must not fetch a
font from a CDN at build or at runtime.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **omp-web** (2786 symbols, 7305 relationships, 233 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/omp-web/context` | Codebase overview, check index freshness |
| `gitnexus://repo/omp-web/clusters` | All functional areas |
| `gitnexus://repo/omp-web/processes` | All execution flows |
| `gitnexus://repo/omp-web/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
