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
  agent/[id]/route.ts             GET state | POST any command
  agent/[id]/events/route.ts      GET SSE stream
  agent/running/route.ts          GET currently-running session ids
  agent/running/events/route.ts   GET SSE stream of currently-running session ids
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
  tool-presets.ts      PRESET_NONE/DEFAULT/FULL + getPresetFromTools()
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
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
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
store in `~/.omp/agent/omp-web-trusted-projects.json` and, for an untrusted
project, filters project-local entries out of omp's discovered extension and
custom-tool paths and disables MCP. Skills and rules are data and always load.
See `docs/project-trust.md`.

### `SYSTEM.md` / `APPEND_SYSTEM.md` are resolved per session cwd
`omp` resolves both files before it creates a session and passes them as
`customSystemPrompt` / `appendSystemPrompt`. `startRpcSession()` builds its own
options, so `lib/session-system-prompt.ts` does the same for the browser: omp's
`findConfigFile` (never a hand-rolled lookup) project-first then user-level,
`resolvePromptInput` to read it, and omp's `applyResolvedSystemPromptInputs` to
set the fields — so the text goes through the same templates the CLI renders it
with. Every lookup is bound to the session's cwd, because the CLI's default
(`getProjectDir()`) is the server's own directory here, not the project's.
Project-local prompt files load for untrusted projects too: they are data, like
skills and rules (`docs/project-trust.md`).

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

### Compaction SSE events
Newer omp emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking POST — the button stays disabled until the response returns.

### Running state polling + reconciliation
- The sidebar polls `/api/agent/running` every 2.5 seconds while the tab is visible and pauses polling in background tabs. The session-list response remains the initial fallback.
- `useAgentSession` treats per-session SSE as primary for chat events and opens it before each prompt. `prompt_done` completes the current UI stage and notification immediately, but the idle SSE stays open for a 30-second grace window and is reused by the next prompt. `agent_start` cancels that close timer; `agent_settled` finishes extension-injected runs that have no wrapper-level `prompt_done` and starts a fresh grace window. Do not close on the first `agent_end`: retries, compaction, and extension-queued messages can continue the same logical prompt.
- While a run is active, `useAgentSession` periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed terminal events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

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
- `models.yml` and `config.yml` are per account under that account's agent directory. Skills stay globally readable as shared tooling, and writing them — global installs and updates included — is admin-only. Nothing is migrated: a new account starts empty on purpose, because copying the operator's `models.yml` would hand his API key to the first tenant.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable — but only for an admin. For any other account the candidate is checked against the account's own home with `isPathInUserHome()` and nothing is granted, because the allowlist lives in one process serving every operator: a grant made by one user would widen the filesystem for all of them, permanently.
- `allowFileRoot()` buckets grants per identity. A call without an identity lands in the unattributed bucket, which only admins can see.
- `/api/sessions` and `/api/terminal` filter by owner, and so do the `agent/running` snapshot and its event stream — the ids those two publish are what the rest of the API addresses things by, so leaving them unfiltered leaks through an open SSE channel. A foreign session or shell answers **404, not 403**: a 403 would confirm that the id exists, and the point of the filter is that another account's work is not merely unreadable but undiscoverable. Session ownership comes from the `cwd` in the session file, which means the sessions live in one shared tree owned by the account the service runs as — see the containment note below.
- `lib/sandbox.ts` is the one boundary here that the kernel enforces rather than this code: a tenant shell runs in a `bubblewrap` user namespace, and **exactly one `--bind`**, the tenant's own home, is the whole invariant. Everything else is either a read-only system directory or absent. Measured on the build host: a foreign home answers `No such file or directory` (not `Permission denied` — it is not mounted at all), `/etc/shadow` is `Permission denied`, `sudo -n true` reports that no new privileges flag is set, `su nobody` fails on the token, and `uid=0` in the namespace is not host root. Without root, sudo or `setpriv` the OS-user-per-account route is unavailable, which is why this exists.
- The sandbox refuses rather than guesses: a username that would escape its path segment is `bad-username`, a working directory outside the home is `cwd-outside-home`, and both come back with a remediation. Passing such a cwd through verbatim would only surface later as `[Process exited with code 1]` in the SSE stream. Missing `bwrap` or disabled user namespaces are **not** fatal — the shell opens unconfined, `sandboxed: false` in `GET /api/terminal` says so, and the key is never absent.
- None of the others are containment. Every one is an assignment decided from data the service process can write, so they stop an account from seeing another's work by accident and through the routes that exist, not against someone who edits the underlying files. `docs/authentication.md` says so in the place a reader of this file is pointed at.

### Plugins and skills
- `/api/plugins` drives omp's `PluginManager` (`~/.omp/plugins`): install, uninstall, enable/disable, plus `doctor()` output as diagnostics. omp has no in-place update, so "update" reinstalls the spec with `force`.
- `/api/skills` uses omp's own `loadSkills()`, so `.omp/skills`, `~/.omp/agent/skills`, `.claude/skills`, plugin skills and `.agents/skills` are listed exactly as a session sees them.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent claude-code`. The `skills` CLI has no `omp` agent, and its `pi` agent writes `~/.pi/agent/skills`, which omp does **not** read; the Claude layout is discovered by default.

### The calendar is per account, and the agent is bound to one
- The calendar lives in `omp-web-calendar.json` in the tenant's agent dir — the same shape as `omp-web-quick-phrases.json` and `omp-web-projects.json`. One file per account, `omp-web-` prefix, atomic write with `0o600` (`lib/calendar-store.ts`).
- **Time is local and zone-less.** `2026-03-14` for an all-day event, `2026-03-14T15:00` for a timed one. No `Z`, no offset. A calendar shows events in the reader's timezone, and a stored offset has to be converted at read time — that is exactly where a calendar starts showing the wrong time. No zone means nothing to convert.
- **`calendar_read` and `calendar_write` are native `customTools`**, registered next to `present_files` in `lib/rpc-manager.ts`. Native because the calendar belongs to the *account*, not the project: a `.omp/extensions` file would depend on project trust (`lib/project-trust.ts`), and the calendar depends on the identity that opened the session.
- **The identity travels with the session.** The tools run in the server process and find no request to read the account from, so `RpcSessionStartOptions.identity` carries it in and the factory closes over it. Without that binding every account would share one file, and a tenant's agent would read and write the operator's calendar.
- **The domain has no `fs` and no `fetch`** (`lib/calendar.ts`), so the browser and the server answer "what is a valid event" identically. The screen layout — where an event sits, how a move preserves the duration — is presentation and lives in `components/calendar/calendar-model.ts`.
- **The month grid is always six weeks.** The number of weeks a month covers varies with the weekday it starts on; a table that changes its height jumps while you page through it, and a calendar that jumps is unusable because you hit the wrong event.
- **The ISO week uses the Thursday, not the 1 January.** ISO 8601's first week is the one containing 4 January, and 1 January can belong to the last week of the previous year. `firstThursdayOfYear()` is the Thursday of the week containing 4 January — for 2026 that is 1 January, because 4 January is a Sunday.
- `docs/calendar.md` has the rest.

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
- **Passing `proxy.ts` is not being an admin.** The proxy answers three
  questions — host allow-list, cross-site, valid credentials — and releases
  *every* valid account. A tenant passes it exactly like the operator. Every
  route that changes something host-wide (`/api/web-access`, `/api/web-access/users`,
  global skill writes) calls `requireAdmin()` from `lib/request-identity.ts`,
  next to `isAdminIdentity`; that function is not copied into routes. A route
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
