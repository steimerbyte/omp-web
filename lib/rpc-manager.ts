import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import {
  applyResolvedSystemPromptInputs,
  createAgentSession,
  type CreateAgentSessionOptions,
  getAgentDir,
  initTheme,
  SessionManager,
  Theme,
} from "@oh-my-pi/pi-coding-agent";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import { BUILTIN_SLASH_COMMAND_DEFS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { executeAcpBuiltinSlashCommand, type AcpBuiltinSlashCommandResult } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { parseCommandArgs } from "@oh-my-pi/pi-coding-agent/utils/command-args";
import { parseNamedScopeArgs, parseSlashCommand, parseSubcommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse";
import { cfgEnabledModels } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { readPlanFile } from "@oh-my-pi/pi-coding-agent/plan-mode/plan-files";
import {
  readRpcSubagentTranscript,
  RpcSubagentRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui";
import { randomUUID } from "crypto";
import { existsSync, realpathSync, writeFileSync } from "fs";
import { resolve } from "path";
import { validateAgentImages } from "./image-attachments";
import { invalidateModelsCache } from "./models-cache";
import { resolveVisibleModels, selectInitialModelScope } from "./model-scope";
import { cacheSessionPath, invalidateSessionListCache } from "./session-reader";
import { prepareTenantSessionDir, tenantSessionsRoot, tightenTenantSessionTree } from "./tenant-sessions";
import {
  createTenantWorkerHost,
  startTenantWorker,
  tenantBoundaryPolicy,
  type TenantWorker,
  type TenantWorkerHost,
} from "./tenant-worker";
import { createWorkerBackedSession, tenantArchiveDir, type WorkerSessionBoundary } from "./tenant-worker-session";
import { resolveBunPath } from "../bin/runtime.js";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { dirname, join } from "node:path";
import { unsandboxedTenantWarning, tenantProviders } from "./tenant-worker-config";
import { fileURLToPath } from "node:url";
import { getUserHome } from "./request-identity";
import { isAdminIdentity, type WebIdentity } from "./request-identity";
import { resolveSessionLoads, sessionSettings } from "./load-policy";
import { loadSessionSkills } from "./skills-service";
import { readDefaultModelRole } from "./model-roles";
import { getOmpRuntime, getSettingsForIdentity } from "./omp-runtime";
import { PRESET_FULL } from "./tool-presets";
import { makePresentFilesTool } from "./present-files-tool";
import { makeCalendarTools } from "./calendar-tool";
import { makeSessionShellGuard } from "./session-shell-guard";
import { SessionRunBudget, type RunBudgetExhaustion, type RunBudgetLimits } from "./session-run-budget";
import { persistExplicitStartupPreferences } from "./startup-preferences";
import { ensureTenantSkillsRegistration } from "./skills-manager";
import type { SlashCommandInfo } from "./omp-types";
import type { AgentSessionLike, ExtensionUiContextLike, ToolInfo } from "./omp-types";
import { GoalModeController, parseGoalCommand } from "./goal-mode";
import { VibeModeController, type VibeModeSession } from "./vibe-mode";
import type {
  ExtensionAskDialogResult,
  ExtensionUiRequest,
  ExtensionUiResponse,
  ExtensionWidgetItem,
  SessionInfo,
  SessionMessageEntry,
  SubagentSnapshot,
} from "./types";
import { createHeadlessCustomUiTui, DEFAULT_CUSTOM_UI_COLUMNS } from "./custom-ui-terminal";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;

type PendingUiResponse = {
  resolve: (response: ExtensionUiResponse) => void;
  cancel: () => void;
};

type CustomUiComponent = {
  render: (width: number) => string[];
  handleInput?: (data: string) => void;
  dispose?: () => void;
  invalidate?: () => void;
};

type ActiveCustomUi = {
  component: CustomUiComponent;
  width: number;
  resolve: (value: unknown) => void;
  settled: boolean;
};

type ExtensionUiRequestBody = Record<string, unknown> & {
  method: ExtensionUiRequest["method"];
  timeout?: number;
  expiresAt?: number;
};

type ExtensionBindingOptions = {
  forceEmptySystemPrompt?: boolean;
};

const RUNNING_STATE_EVENT_TYPES = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "auto_compaction_start",
  "auto_compaction_end",
  "compaction_start",
  "compaction_end",
]);

const IDLE_RESET_EVENT_TYPES = new Set([
  "agent_end",
  "agent_settled",
  "auto_compaction_end",
  "compaction_end",
]);

const MAX_SUBAGENT_HISTORY = 128;

const HANDOFF_ALLOWED_COMMAND_TYPES: Record<string, true> = {
  abort: true,
  extension_ui_input: true,
  extension_ui_response: true,
  get_commands: true,
  get_last_assistant_text: true,
  get_session_stats: true,
  get_state: true,
  get_subagent_messages: true,
  get_subagents: true,
  get_tools: true,
};

type ForkBranchEntry = {
  id?: string;
  type?: string;
  message?: { role?: string };
};

export function resolveForkEntryId(
  entries: readonly ForkBranchEntry[],
  requestedEntryId?: unknown,
): string | undefined {
  if (typeof requestedEntryId === "string" && requestedEntryId.length > 0) return requestedEntryId;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "message" && entry.message?.role === "user" && entry.id) return entry.id;
  }
  return undefined;
}

export interface RpcSessionStartOptions {
  toolNames?: string[];
  initialModel?: { provider: string; modelId: string };
  thinkingLevel?: ConfiguredThinkingLevel;
  /**
   * Der angemeldete Benutzername, dem die Session gehoert.
   *
   * Kein Admin-Flag: die Session gehoert auch einem Admin seinem eigenen Namen,
   * nicht der Rolle. Die Admin-Ausnahme steht ausschliesslich im Filter.
   */
  owner?: string;
  /**
   * Die volle Identitaet des angemeldeten Kontos.
   *
   * ### Warum das noetig ist und `owner` nicht reicht
   *
   * `owner` ist ein *Name* — er beantwortet "wem gehoert die Session", und das
   * reicht fuer den Sichtbarkeitsfilter. Die Kalender-Werkzeuge brauchen mehr:
   * sie brauchen die vollstaendige Identitaet, weil der Kalender ueber
   * `resolveTenantAgentDir(identity)` abgeleitet wird — und der unterscheidet
   * zwischen "Admin, also globales Verzeichnis" und "Mieter, also eigenes
   * Verzeichnis". Der Name allein kann diese Unterscheidung nicht treffen.
   *
   * ### Warum die Identitaet mit der Session wandert und nicht mitgereist wird
   *
   * Das Werkzeug laeuft im Serverprozess und hat keinen Request, aus dem es
   * die Identitaet lesen koennte. Ohne diese Bindung wuerde ein Agent eines
   * Mandanten den Kalender des Betreibers lesen und schreiben — der Kalender
   * liegt pro Konto in einer eigenen Datei, und ohne Bindung gaelte fuer alle
   * dieselbe.
   */
  identity?: WebIdentity;
}

const CODING_TOOL_NAMES: Record<string, true> = Object.fromEntries(
  PRESET_FULL.map((name) => [name, true]),
);

// Extensions require a complete Theme, while the web UI applies its own styling.
class PlainTextTheme extends Theme {
  constructor() {
    super(
      { thinkingXhigh: "" } as ConstructorParameters<typeof Theme>[0],
      {} as ConstructorParameters<typeof Theme>[1],
      "truecolor",
      "unicode",
      {},
    );
  }

  override fg(...[, text]: Parameters<Theme["fg"]>): string { return text; }
  override bg(...[, text]: Parameters<Theme["bg"]>): string { return text; }
  override bold(text: string): string { return text; }
  override italic(text: string): string { return text; }
  override underline(text: string): string { return text; }
  override inverse(text: string): string { return text; }
  override strikethrough(text: string): string { return text; }
  override getFgAnsi(): string { return ""; }
  override getBgAnsi(): string { return ""; }
  override getThinkingBorderColor(): (text: string) => string {
    return (text) => text;
  }
  override getBashModeBorderColor(): (text: string) => string { return (text) => text; }
}

const PLAIN_TEXT_THEME = new PlainTextTheme();
const CUSTOM_UI_KEYBINDINGS = new TuiKeybindingsManager(TUI_KEYBINDINGS);

function withExtensionTools(session: AgentSessionLike, toolNames: string[]): string[] {
  if (toolNames.length === 0) return [];

  const extensionToolNames = session
    .getAllToolNames()
    .filter((name) => CODING_TOOL_NAMES[name] !== true);

  return [...new Set([...toolNames, ...extensionToolNames])];
}

/** Tool descriptors for the browser's tool picker. */
function listTools(session: AgentSessionLike): ToolInfo[] {
  return session.getAllToolNames().map((name) => ({
    name,
    description: session.getToolByName(name)?.description ?? "",
  }));
}

type AvailableCommandsSession = Parameters<typeof buildAvailableSlashCommands>[0];

function appendSlashCommand(
  commands: SlashCommandInfo[],
  seenNames: Set<string>,
  command: SlashCommandInfo,
): void {
  const name = command.name.trim();
  if (!name || seenNames.has(name)) return;
  seenNames.add(name);
  commands.push({ ...command, name });
}

/**
 * Browser-native builtins with no shared SDK handler; advertised with their
 * canonical registry metadata. `/goal` and `/vibe` are mode commands omp
 * implements as TUI-only handlers, so they never reach ACP discovery; omp-web
 * drives the same runtimes itself (lib/goal-mode.ts, lib/vibe-mode.ts) and
 * advertises them here.
 */
export const BROWSER_NATIVE_SLASH_COMMANDS = ["fork", "goal", "vibe"] as const;

/**
 * Registry metadata that does not describe the browser handler. omp 18.10 gave
 * /fork pane/window/tab subcommands that open the fork in a terminal
 * multiplexer; the browser fork ignores them, so it keeps its own description.
 */
const BROWSER_NATIVE_DESCRIPTIONS: Partial<Record<(typeof BROWSER_NATIVE_SLASH_COMMANDS)[number], string>> = {
  fork: "Create a new fork from a previous message",
};

/**
 * Slash subcommands that always write state the whole host shares, whatever
 * their arguments say.
 *
 * `/mcp enable|disable` have no `--scope` at all: they edit the project entry
 * when one exists and otherwise the user file, and the "disabled" list is
 * always written to the user file (`helpers/mcp.ts:427-461`). `/mcp reauth`
 * writes shared credentials (`helpers/mcp.ts:491`). The marketplace write
 * verbs edit `~/.omp/marketplaces.json`, `~/.omp/plugins` or the installed
 * registry (`helpers/marketplace-manager.ts:16-24`), and `/plugins
 * enable|disable` edits the `PluginManager` lockfile (`manager.ts:182/194`).
 */
const ALWAYS_OPERATOR_SCOPE_SLASH_VERBS: Readonly<Record<string, readonly string[]>> = {
  mcp: ["enable", "disable", "reauth"],
  marketplace: ["add", "remove", "rm", "update", "install", "uninstall", "upgrade"],
  plugins: ["enable", "disable"],
  plugin: ["enable", "disable"],
};

/**
 * Verbs whose target depends on `--scope`: both parsers default to `project`
 * (`helpers/mcp.ts:125`, `helpers/ssh.ts:78`, `helpers/parse.ts:96`) and only
 * `--scope user` leaves the session's own project.
 */
const SCOPE_DEPENDENT_SLASH_VERBS: Readonly<Record<string, readonly string[]>> = {
  mcp: ["add", "remove", "rm"],
  ssh: ["add", "remove", "rm"],
};

/**
 * Effective scope of an `/mcp`/`/ssh` mutation, decided with the same parsers
 * the builtins use.
 *
 * `add` runs `parseCommandArgs` (`utils/command-args.ts:2-42`); mcp's parser
 * stops options at `--` (`helpers/mcp.ts:136`), so a `--scope user` behind the
 * command separator is a command argument, not an option.
 * `remove` runs `parseNamedScopeArgs` (`helpers/parse.ts:93-108`), whose
 * default is `project` and whose syntax errors are refused here: an
 * unparseable scope is treated as `user`, the fail-closed direction.
 */
function slashMutationScope(verb: string, rest: string): "user" | "project" {
  if (verb !== "add") {
    const parsed = parseNamedScopeArgs(rest, "");
    return parsed.error || parsed.scope === "user" ? "user" : "project";
  }
  const tokens = parseCommandArgs(rest);
  const separator = tokens.indexOf("--");
  const options = separator === -1 ? tokens : tokens.slice(0, separator);
  const index = options.findIndex((token) => token === "--scope" || token.startsWith("--scope="));
  if (index === -1) return "project";
  // `--scope=user` and a missing value are syntax the builtin rejects without
  // writing; the gate refuses them instead of relying on that.
  return options[index] === "--scope" && options[index + 1] === "project" ? "project" : "user";
}

/** `"/mcp add --scope user …"` → `"/mcp add"` when that call writes operator-scope state. */
function operatorScopeSlashCommand(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const parsed = parseSlashCommand(text);
  if (!parsed) return null;
  const name = parsed.name.toLowerCase();
  const { verb, rest } = parseSubcommand(parsed.args);
  if (ALWAYS_OPERATOR_SCOPE_SLASH_VERBS[name]?.includes(verb)) return `/${name} ${verb}`;
  if (SCOPE_DEPENDENT_SLASH_VERBS[name]?.includes(verb) && slashMutationScope(verb, rest) === "user") {
    return `/${name} ${verb} --scope user`;
  }
  return null;
}

/**
 * Keep the browser palette aligned with omp's own command registry and
 * discovery pipeline. Shared text/ACP builtins and every discovered
 * extension/custom/MCP/file/skill command come from the SDK discovery;
 * browser-native /fork is added explicitly from the canonical builtin registry
 * because it has no shared SDK handler yet. /handoff gained one in omp 18, so
 * it now arrives through discovery like every other shared builtin.
 */
export async function getAvailableSlashCommands(session: AgentSessionLike): Promise<SlashCommandInfo[]> {
  const commands: SlashCommandInfo[] = [];
  const seenNames = new Set<string>();

  const discovered = await buildAvailableSlashCommands(session as unknown as AvailableCommandsSession);
  for (const command of discovered) {
    appendSlashCommand(commands, seenNames, command);
  }

  for (const name of BROWSER_NATIVE_SLASH_COMMANDS) {
    const builtin = BUILTIN_SLASH_COMMAND_DEFS.find((def) => def.name === name);
    if (!builtin) continue;
    const browserDescription = BROWSER_NATIVE_DESCRIPTIONS[name];
    const hint = builtin.inlineHint;
    // A browser-specific description means the registry's subcommands don't apply.
    const subcommands = browserDescription ? undefined : builtin.subcommands;
    appendSlashCommand(commands, seenNames, {
      name: builtin.name,
      aliases: builtin.aliases,
      description: browserDescription ?? builtin.description,
      source: "builtin",
      ...(hint ? { input: { hint } } : {}),
      ...(subcommands ? { subcommands } : {}),
    });
  }

  // Prompt templates are a separate SDK resource from custom commands and
  // file-based commands, so retain them explicitly in the browser contract.
  for (const template of session.promptTemplates) {
    appendSlashCommand(commands, seenNames, {
      name: template.name,
      description: template.description,
      source: "prompt",
      ...(template.source ? { path: template.source } : {}),
    });
  }

  return commands;
}

// ============================================================================
// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private pendingUiResponses = new Map<string, PendingUiResponse>();
  private pendingUiRequests = new Map<string, AgentEvent>();
  private activeCustomUis = new Map<string, ActiveCustomUi>();
  private extensionWidgets = new Map<string, ExtensionWidgetItem>();
  private promptRunning = false;
  // Set while the handoff RPC is in flight so state polls and the running-set
  // stay honest during the long oneshot generation + session transition.
  private handoffRunning = false;
  private extensionsBound = false;
  private extensionBindingPromise: Promise<void> | null = null;
  private extensionBindingError: unknown = null;
  private forceEmptySystemPrompt = false;
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private readonly subagents: RpcSubagentRegistry;
  // The SDK registry removes terminal entries after emitting their lifecycle frame.
  // Keep a bounded per-session copy so state requests can still expose history.
  private readonly subagentHistory = new Map<string, SubagentSnapshot>();
  private goalModeController: GoalModeController | null = null;
  private readonly vibeMode: VibeModeController;
  private readonly runBudget: SessionRunBudget;
  private readonly goalBudget: SessionRunBudget;
  /** Non-null while a budget abort is unwinding; later exhaustions ride it. */
  private budgetAbort: Promise<void> | null = null;
  private unsubscribeJobSettled: (() => void) | null = null;
  private _alive = true;
  // The identity this session was started for. `send` takes the caller's
  // identity per dispatch; this field is the fallback for internal dispatches
  // and the creation-time binding.
  private identity: WebIdentity | null = null;

  constructor(
    public readonly inner: AgentSessionLike,
    eventBus: ConstructorParameters<typeof RpcSubagentRegistry>[0],
    /** Test seam; production uses `DEFAULT_RUN_BUDGET_LIMITS`. */
    runBudgetLimits?: RunBudgetLimits,
  ) {
    this.subagents = new RpcSubagentRegistry(eventBus, (frame) => {
      const event = frame as unknown as AgentEvent;
      this.rememberSubagentFrame(event);
      this.emit(event);
      this.resetIdleTimer();
      notifyRunningChange();
    });
    this.subagents.setSubscriptionLevel("progress");
    // Constructed here, not as a field initializer: `inner` is a parameter
    // property and field initializers run before it is assigned.
    this.vibeMode = new VibeModeController(this.inner as unknown as VibeModeSession, {
      // Like goal mode: without a frame, another tab keeps a stale bar/picker.
      onStatus: (status) => {
        this.emit({ type: "vibe_status", status });
        notifyRunningChange();
      },
      conflicts: () => this.planOrGoalConflict(),
    });
    this.runBudget = new SessionRunBudget(
      (reason) => this.onRunBudgetExhausted("run", reason),
      runBudgetLimits,
    );
    // A second budget bounds the goal's whole lifetime, not one continuation:
    // every continuation begins a fresh run budget, so a goal loop could chain
    // them forever. It deliberately reuses DEFAULT_RUN_BUDGET_LIMITS (400
    // requests / 45 minutes): a goal that keeps making progress pauses after
    // the same budget and `/goal resume` re-arms it, so continuations are never
    // a way to reset the cap.
    this.goalBudget = new SessionRunBudget(
      (reason) => this.onRunBudgetExhausted("goal", reason),
      runBudgetLimits,
    );
    this.unsubscribeJobSettled = this.inner.asyncJobManager?.onJobSettled(() => {
      if (this.isAlive()) notifyRunningChange();
    }) ?? null;
  }

  /**
   * Bind the account that started this session (see `startRpcSession`).
   *
   * `send` prefers the caller's identity when it is given one; this is the
   * default for dispatches that carry no caller.
   */
  setIdentity(identity: WebIdentity | null): void {
    this.identity = identity;
  }

  private rememberSubagentSnapshot(snapshot: SubagentSnapshot): void {
    this.subagentHistory.set(snapshot.id, snapshot);
    if (this.subagentHistory.size <= MAX_SUBAGENT_HISTORY) return;
    const removable = [...this.subagentHistory.values()]
      .filter((entry) => entry.status !== "pending" && entry.status !== "running")
      .sort((left, right) => left.lastUpdate - right.lastUpdate);
    while (this.subagentHistory.size > MAX_SUBAGENT_HISTORY && removable.length > 0) {
      const oldest = removable.shift();
      if (oldest) this.subagentHistory.delete(oldest.id);
    }
  }

  private rememberSubagentFrame(event: AgentEvent): void {
    if (event.type === "subagent_progress") {
      const payload = event.payload as { progress?: { id?: string } } | undefined;
      const id = payload?.progress?.id;
      if (!id) return;
      const live = this.subagents.getSubagents().find((entry) => entry.id === id);
      if (live) this.rememberSubagentSnapshot(live as unknown as SubagentSnapshot);
      return;
    }
    if (event.type !== "subagent_lifecycle") return;
    const payload = event.payload as {
      id?: string;
      index?: number;
      agent?: string;
      agentSource?: "bundled" | "user" | "project";
      description?: string;
      status?: "started" | "completed" | "failed" | "aborted";
      sessionFile?: string;
      parentToolCallId?: string;
    } | undefined;
    if (!payload?.id || !payload.status) return;
    const live = this.subagents.getSubagents().find((entry) => entry.id === payload.id);
    if (payload.status === "started") {
      if (live) this.rememberSubagentSnapshot(live as unknown as SubagentSnapshot);
      return;
    }
    const previous = (live as unknown as SubagentSnapshot | undefined) ?? this.subagentHistory.get(payload.id);
    const terminalStatus: SubagentSnapshot["status"] = payload.status === "failed"
      ? "failed"
      : payload.status === "aborted"
        ? "aborted"
        : "completed";
    this.rememberSubagentSnapshot({
      id: payload.id,
      index: payload.index ?? previous?.index ?? 0,
      agent: payload.agent ?? previous?.agent ?? payload.id,
      agentSource: payload.agentSource ?? previous?.agentSource ?? "bundled",
      description: payload.description ?? previous?.description,
      status: terminalStatus,
      task: previous?.task,
      assignment: previous?.assignment,
      sessionFile: payload.sessionFile ?? previous?.sessionFile,
      lastUpdate: Date.now(),
      parentToolCallId: payload.parentToolCallId ?? previous?.parentToolCallId,
      progress: previous?.progress
        ? { ...previous.progress, status: terminalStatus }
        : undefined,
    });
  }

  private getSubagentSnapshots(): SubagentSnapshot[] {
    for (const live of this.subagents.getSubagents()) {
      const snapshot = live as unknown as SubagentSnapshot;
      this.rememberSubagentSnapshot(snapshot);
    }
    const snapshots = new Map(this.subagentHistory);
    for (const live of this.subagents.getSubagents()) {
      const snapshot = live as unknown as SubagentSnapshot;
      snapshots.set(snapshot.id, snapshot);
    }
    return [...snapshots.values()].sort((left, right) => {
      const leftActive = left.status === "pending" || left.status === "running";
      const rightActive = right.status === "pending" || right.status === "running";
      if (leftActive !== rightActive) return leftActive ? -1 : 1;
      if (leftActive) return left.index - right.index || left.id.localeCompare(right.id);
      return right.lastUpdate - left.lastUpdate || left.id.localeCompare(right.id);
    });
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  get cwd(): string {
    return this.inner.sessionManager.getCwd();
  }

  isAlive(): boolean {
    if (!this._alive) return false;
    // Eine Worker-Session kann sterben, waehrend dieser Wrapper weiterlebt: der
    // Prozess wird nach `idleMs` abgeraeumt oder abgeschossen, und das Objekt
    // hier merkt davon nichts. Ohne diese Abfrage meldete `isAlive()` fuer einen
    // toten Worker `true`, der Fast-Path in `app/api/agent/[id]/route.ts` haette
    // den Wrapper ausgeliefert, und der Request scheiterte an der geschlossenen
    // Pipe (`Client not started`) — und jeder weitere auch, dauerhaft, bis der
    // Server neu startet. Gemessen am 2026-11-09: drei Requests hintereinander
    // 500, bis zum Neustart.
    //
    // Eine In-Process-Session hat die Methode nicht; dann bleibt es bei `true`.
    if (this.inner.isAlive?.() === false) return false;
    return true;
  }

  isRunning(): boolean {
    // A background job (task or vibe worker) that outlives the turn still owes a
    // follow-up turn; reporting idle here closed the browser's SSE stream, so its
    // result never rendered. The job manager is per session, so no owner filter.
    const jobs = this.inner.asyncJobManager;
    return this._alive && (
      this.promptRunning
      || this.handoffRunning
      || this.inner.isStreaming
      || this.inner.isCompacting
      || this.inner.isBashRunning
      || this.subagents.getSubagents().length > 0
      || (jobs?.getRunningJobs().length ?? 0) > 0
      || jobs?.hasPendingDeliveries() === true
    );
  }
  bindToolUiContext(setter: (uiContext: ExtensionUiContextLike, hasUI: boolean) => void): void {
    setter(this.createExtensionUiContext(), true);
  }


  start(): void {
    this.syncPlanModeFromSession();
    void this.goalMode.restore().catch((error) => {
      console.error(
        "[omp-web] failed to restore goal mode:",
        error instanceof Error ? error.message : error,
      );
    });
    void this.vibeMode.restore().catch((error) => {
      console.error(
        "[omp-web] failed to restore vibe mode:",
        error instanceof Error ? error.message : error,
      );
    });
    // Der SDK-Event ist seit 18.14 eine Union ohne Index-Signatur; der Bus
    // reicht Frames dagegen als offene Records weiter (auch die synthetischen
    // Extension-UI-Frames). Der Spread uebernimmt Feld fuer Feld in ein
    // frisches Objekt — kein Cast, und die Felder bleiben unveraendert.
    this.unsubscribe = this.inner.subscribe((sdkEvent) => {
      const event: AgentEvent = { ...sdkEvent };
      if (event.type === "agent_end") {
        invalidateSessionListCache();
      }
      if (IDLE_RESET_EVENT_TYPES.has(event.type)) this.resetIdleTimer();
      this.emit(event);
      if (RUNNING_STATE_EVENT_TYPES.has(event.type)) notifyRunningChange();
      // One `turn_start` per model request: the agent loop pushes it directly
      // before streaming a response (`agent-loop.ts:1444`, event type at
      // `types.ts:1305`), once per iteration of the tool-call/steering loop.
      // Subagent runs are separate sessions and never reach this stream.
      // Counted after forwarding, so the browser sees the frame before the
      // budget's `prompt_error`.
      // shortcut: an in-turn provider re-sample does not emit a second
      // turn_start, so retries are undercounted; the wall clock still bounds it.
      if (event.type === "turn_start") {
        // Goal first: when one frame crosses both caps, the goal bound is the
        // one worth naming, and the abort handler reports only the first.
        this.goalBudget.noteRequest();
        this.runBudget.noteRequest();
      }
      if (event.type === "goal_updated") this.syncGoalBudget(event.state);
      void this.goalMode.handleSessionEvent(event).catch((error) => {
        console.error(
          "[omp-web] goal mode failed to handle a session event:",
          error instanceof Error ? error.message : error,
        );
      });
    });
    this.resetIdleTimer();
    notifyRunningChange();
  }

  setForceEmptySystemPrompt(force: boolean): void {
    this.forceEmptySystemPrompt = force;
    this.applyForcedEmptySystemPrompt();
  }

  beginExtensionBinding(options: ExtensionBindingOptions = {}): void {
    void this.ensureExtensionsBound(options).catch((err) => {
      console.error("[omp-web] failed to dispatch session_start to extensions:", err instanceof Error ? err.message : err);
    });
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForExtensionsBound();
  }

  private ensureExtensionsBound(options: ExtensionBindingOptions = {}): Promise<void> {
    if (options.forceEmptySystemPrompt) this.forceEmptySystemPrompt = true;
    if (this.extensionsBound) {
      this.applyForcedEmptySystemPrompt();
      return Promise.resolve();
    }
    if (this.extensionBindingPromise) return this.extensionBindingPromise;

    this.extensionBindingError = null;
    this.extensionBindingPromise = (async () => {
      if (!this._alive) return;
      // omp wires extensions the same way for every non-interactive host; reuse
      // its shared initializer so omp-web sessions expose exactly the action set
      // `omp --mode rpc` does, then layer our browser-backed UI context on top.
      await initializeExtensions(this.inner as never, {
        uiContext: this.createExtensionUiContext() as never,
        reportSendError: (action, error) => this.emit({
          type: "extension_error",
          extensionPath: action,
          event: "send",
          error: error.message,
        }),
        reportRuntimeError: (error) => this.emit({
          type: "extension_error",
          extensionPath: error.extensionPath,
          event: error.event,
          error: error.error,
        }),
        onShutdown: () => this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "notify",
          notifyType: "warning",
          message: "Extension requested shutdown, but shutdown is not supported in omp-web.",
        } as ExtensionUiRequest as AgentEvent),
      });
      this.extensionsBound = true;
      this.applyForcedEmptySystemPrompt();
      console.log(`[omp-web] session_start dispatched to extensions for session ${this.inner.sessionId}`);
    })().catch((err) => {
      this.extensionBindingError = err;
      throw err;
    });

    return this.extensionBindingPromise;
  }

  private async waitForExtensionsBound(): Promise<void> {
    try {
      if (this.extensionBindingPromise) await this.extensionBindingPromise;
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (this.extensionBindingError) {
      throw this.extensionBindingError instanceof Error
        ? this.extensionBindingError
        : new Error(String(this.extensionBindingError));
    }
  }

  private shouldWaitForExtensions(type: string): boolean {
    return type === "prompt"
      || type === "steer"
      || type === "follow_up"
      || type === "handoff"
      || type === "get_commands"
      || type === "execute_slash_command"
      || type === "goal"
      // Both modes snapshot and restore the active tool list, so they need the
      // extension tools in place before they can record it.
      || type === "vibe";
  }

  private async withFinalRunningNotification<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      this.resetIdleTimer();
      notifyRunningChange();
    }
  }

  private async shutdownAfterCommittedFork(newSessionId: string): Promise<void> {
    try {
      await this.shutdown();
    } catch (error) {
      // The forked session is already persisted. Cleanup failures must not
      // hide its id from the browser and strand the committed transition.
      console.error(
        `[omp-web] fork created session ${newSessionId}, but wrapper shutdown failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  private applyForcedEmptySystemPrompt(): void {
    if (this.forceEmptySystemPrompt && this.inner.agent.state) {
      this.inner.agent.state.systemPrompt = [];
    }
  }
  /**
   * Goal mode lives server-side so an active goal keeps working through the
   * continuation loop whether or not a browser tab is watching.
   */
  private get goalMode(): GoalModeController {
    if (!this.goalModeController) {
      this.goalModeController = new GoalModeController(this.inner, {
        isBusy: () => this.promptRunning
          || this.handoffRunning
          || this.inner.isStreaming
          || this.inner.isCompacting
          || this.inner.isBashRunning,
        runContinuation: (prompt) => this.runGoalContinuation(prompt),
        onStatusChange: (status) => this.emit({ type: "goal_status", status }),
      });
    }
    return this.goalModeController;
  }

  /**
   * Vibe mode is exclusive with the other two modes, as in omp's own command.
   */
  private planOrGoalConflict(): string | undefined {
    if (this.inner.getPlanModeState?.()?.enabled) return "Exit plan mode first.";
    // Match omp's own exclusivity: an active or paused goal blocks, a finished
    // one does not; a paused goal reports enabled:false but still owns the run.
    const goalState = this.inner.getGoalModeState?.();
    if (goalState?.goal && (goalState.enabled || goalState.goal.status === "paused")) {
      return "Exit goal mode first.";
    }
    return undefined;
  }

  /**
   * Send one goal continuation turn. It is a hidden custom message rather than
   * a prompt so it does not appear as something the operator typed, but the
   * browser must still see the session go busy, exactly as for a real prompt.
   */
  private async runGoalContinuation(prompt: string): Promise<void> {
    // A restored goal can reach its first continuation without a `goal_updated`
    // frame, so the lifetime budget is armed here as the fallback.
    if (!this.goalBudget.active) this.goalBudget.begin();
    // Each continuation is a new prompt run, so it gets a fresh run budget;
    // the goal budget above keeps accumulating across them.
    const run = this.runBudget.begin();
    this.promptRunning = true;
    notifyRunningChange();
    try {
      await this.inner.promptCustomMessage({
        customType: "goal-continuation",
        content: prompt,
        display: false,
        attribution: "user",
      });
    } catch (error) {
      this.emit({
        type: "prompt_error",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.runBudget.end(run);
      this.promptRunning = false;
      this.resetIdleTimer();
      this.emit({ type: "prompt_done" });
      notifyRunningChange();
    }
  }

  /**
   * Arm or end the goal-lifetime budget from the SDK's own goal state.
   *
   * Every `/goal set|resume` and the model's `goal` tool commit through a
   * `goal_updated` frame carrying `state` (`goals/runtime.ts:178`), and pause,
   * drop and complete flip `enabled` to false, so this one event covers entry
   * and exit for both paths.
   */
  private syncGoalBudget(state: unknown): void {
    const enabled = state !== null
      && typeof state === "object"
      && "enabled" in state
      && state.enabled === true;
    if (!enabled) {
      this.goalBudget.end();
      return;
    }
    if (!this.goalBudget.active) this.goalBudget.begin();
  }

  /**
   * A run or goal budget ran out. Say so once, then unwind through the same
   * path `case "abort"` uses: cancel a scheduled goal continuation and abort
   * the session, which pauses an active goal inside the SDK. `prompt_error` is
   * what the browser already renders as a visible notice
   * (`hooks/useAgentSession.ts:1278`); a session `notice` frame has no renderer
   * in this UI.
   */
  private onRunBudgetExhausted(scope: "run" | "goal", reason: RunBudgetExhaustion): void {
    // Both budgets can trip on the same request frame; the abort is already
    // on its way, so a second notice would only repeat it.
    if (this.budgetAbort) return;
    const limits = this.runBudget.limits;
    const limit = reason === "requests"
      ? `${limits.maxRequests} model requests`
      : `${Math.max(1, Math.round(limits.maxWallClockMs / 60000))} minutes`;
    const message = scope === "goal"
      ? `Goal paused after ${limit} for this goal. Send /goal resume to continue with a fresh budget.`
      : `Run stopped after ${limit}. Send a new message to continue.`;
    this.emit({ type: "prompt_error", errorMessage: message });
    this.goalMode.onAbort();
    this.budgetAbort = this.withFinalRunningNotification(() => this.inner.abort());
    void this.budgetAbort
      .catch((error) => {
        console.error(
          "[omp-web] failed to abort a session whose run budget ran out:",
          error instanceof Error ? error.message : error,
        );
      })
      .finally(() => {
        this.budgetAbort = null;
      });
  }

  private syncPlanModeFromSession(): void {
    let state = this.inner.getPlanModeState?.();
    if (!state) {
      const entries = this.inner.sessionManager.getEntries() as Array<{
        type?: string;
        mode?: string;
        data?: Record<string, unknown>;
      }>;
      let persistedMode: (typeof entries)[number] | undefined;
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index]?.type !== "mode_change") continue;
        persistedMode = entries[index];
        break;
      }
      const planFilePath = persistedMode?.data?.planFilePath;
      if (persistedMode?.mode === "plan" && typeof planFilePath === "string" && planFilePath.length > 0) {
        state = {
          enabled: true,
          planFilePath,
          workflow: persistedMode.data?.workflow === "sequential" ? "sequential" : "parallel",
          reentry: true,
        };
        this.inner.setPlanModeState?.(state);
      }
    }

    if (state?.enabled) {
      this.inner.setPlanProposalHandler?.((title) => this.handlePlanProposal(title));
    }
  }

  private async handlePlanProposal(title: string): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: unknown;
  }> {
    const state = this.inner.getPlanModeState?.();
    if (!state?.enabled || !this.inner.preparePlanForReview) {
      throw new Error("Plan mode is not active.");
    }

    const review = await this.inner.preparePlanForReview(title);
    const planFilePath = review.details?.planFilePath;
    const resolvedTitle = review.details?.title;
    if (!planFilePath || !resolvedTitle) {
      throw new Error("The proposed plan could not be resolved.");
    }

    const planContent = await readPlanFile(planFilePath, {
      cwd: this.cwd,
      localProtocolOptions: {
        getArtifactsDir: () => this.inner.sessionManager.getArtifactsDir(),
        getSessionId: () => this.inner.sessionManager.getSessionId(),
      },
    });
    if (!planContent?.trim()) {
      throw new Error(`Plan file not found at ${planFilePath}`);
    }

    const responseValue = await this.requestExtensionUi(
      { method: "plan_review", title: resolvedTitle, planFilePath, planContent },
      JSON.stringify({ action: "refine" }),
      (response) => "value" in response ? response.value : JSON.stringify({ action: "refine" }),
    );
    let choice: { action?: unknown; feedback?: unknown } = {};
    try {
      choice = JSON.parse(responseValue) as { action?: unknown; feedback?: unknown };
    } catch {
      // Treat malformed or stale browser responses as a request to keep planning.
    }

    const details = { planFilePath, title: resolvedTitle, planExists: true };
    if (choice.action === "approve") {
      this.inner.setPlanReferencePath?.(planFilePath);
      this.inner.setPlanProposalHandler?.(null);
      this.inner.setPlanModeState?.(undefined);
      this.inner.sessionManager.appendModeChange("none");
      return {
        content: [{
          type: "text",
          text: `Plan approved at ${planFilePath}. Plan mode exited; proceed with the implementation.`,
        }],
        details,
      };
    }

    if (state.planFilePath !== planFilePath) {
      this.inner.setPlanModeState?.({ ...state, planFilePath });
      this.inner.sessionManager.appendModeChange("plan", { planFilePath });
    }
    const feedback = typeof choice.feedback === "string" ? choice.feedback.trim() : "";
    return {
      content: [{
        type: "text",
        text: [
          "Plan refinement requested.",
          feedback ? `User feedback:\n${feedback}` : "",
          `Update the plan file, then write ${resolvedTitle} to xd://propose again when ready.`,
        ].filter(Boolean).join("\n\n"),
      }],
      details,
    };
  }


  private emit(event: AgentEvent): void {
    for (const l of this.listeners) l(event);
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.isRunning()) {
        this.resetIdleTimer();
        return;
      }
      void this.shutdown().catch((error) => {
        console.error("[pi-web] failed to shut down idle session:", error instanceof Error ? error.message : error);
      });
    }, 10 * 60 * 1000);
  }

  private persistBashOnlySession(): void {
    const manager = this.inner.sessionManager;
    const sessionFile = manager.getSessionFile();
    if (!sessionFile || existsSync(sessionFile)) return;

    const header = manager.getHeader();
    if (!header) return;

    const content = [header, ...manager.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
    // `mode: 0o600` ist hier **nicht** Deko. Ohne den Modus legt `O_CREAT` die
    // Datei mit der umask des Prozesses an — gemessen `0644`, also weltlesbar
    // im Mandanten-Home. Ein spaeteres `chmod` waere ein Rennen gegen den
    // naechsten Append des SDK; der Modus beim Anlegen schliesst das Fenster.
    // Gemessen 2026-11-08 an einer In-Process-Mandanten-Session unter
    // `OMP_WEB_ALLOW_UNSANDBOXED_TENANT=1`: Zeile 7 des Abnahme-Harness war die
    // einzige rote, weil dieser Pfad als einziger ohne Modus schrieb.
    writeFileSync(sessionFile, content, { encoding: "utf8", flag: "wx", mode: 0o600 });

    // omp normally delays the first flush until an assistant message exists.
    // A leading shell command has no assistant message, so mark this SDK
    // manager as flushed after writing its own generated entries.
    (manager as unknown as { flushed: boolean }).flushed = true;
    cacheSessionPath(this.inner.sessionId, sessionFile);
  }

  /**
   * Den Modus des Mandanten-Archivs nachziehen, falls diese Session eines ist.
   *
   * Nur fuer den Mandanten-Baum: das Prozess-Archiv des Admins bleibt
   * unveraendert, und `tenantSessionsRoot` gibt fuer ihn `null`.
   */
  private tightenTenantArchive(): void {
    const sessionFile = this.inner.sessionFile;
    if (!sessionFile) return;
    const tenantRoot = tenantSessionsRoot(this.identity);
    if (tenantRoot === null || !sessionFile.startsWith(`${tenantRoot}/`)) return;
    tightenTenantSessionTree(sessionFile.slice(0, sessionFile.lastIndexOf("/")));
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    for (const event of this.pendingUiRequests.values()) listener(event);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  /**
   * Dispatch one command.
   *
   * `callerIdentity` is the account that sent *this* request. A live wrapper can
   * be addressed from any route allowed to reach it, so the identity must be
   * bound per call — not only at session start — and as an argument rather than
   * a field on the wrapper: two callers can interleave here, and a field would
   * let the second call's identity decide the first call's slash gate. A
   * missing identity stays `null`, which the gate treats as non-admin.
   */
  async send(
    command: Record<string, unknown>,
    callerIdentity?: WebIdentity | null,
  ): Promise<unknown> {
    const identity = callerIdentity === undefined ? this.identity : callerIdentity;
    // Ein abgeraeumter oder abgeschossener Worker: diese Session kann den Befehl
    // nicht mehr ausfuehren.
    //
    // Gemessen am 2026-11-09: nach dem Reap (Ruhezeit `idleMs`) und nach
    // `kill -9` des Worker-Prozesses meldete der Wrapper weiter
    // `isAlive() === true`; der Fast-Path in `app/api/agent/[id]/route.ts`
    // lieferte ihn aus, und der Dispatch scheiterte dauerhaft an der
    // geschlossenen Pipe (`500 {"error":"Client not started"}`) — drei Requests
    // hintereinander, bis zum Serverneustart.
    //
    // Seit `isAlive()` den Worker fragt, kommt ein Dispatch auf einen **toten**
    // Wrapper hier an. Die Route startet die Session vorher ueber
    // `startRpcSession` neu (gemessen: derselbe Request antwortet wieder 200);
    // dieser Zweig deckt den Aufrufer ab, der einen Wrapper haelt, waehrend sein
    // Worker weggeraeumt wird. Er bekommt **einen** benannten Fehler mit Abhilfe
    // statt einer dauerhaft geschlossenen Pipe, und der naechste Request oeffnet
    // dieselbe Session-Id aus ihrem Archiv auf einem frischen Worker.
    //
    // Ein `TenantBoundaryError`, weil die Route daraus `reason`, `detail` und
    // `remediation` macht und 503 statt 500 antwortet: der Dienst ist da, dieser
    // eine Prozess nicht mehr, und ein erneuter Versuch gelingt.
    if (this.inner.isAlive?.() === false) {
      throw new TenantBoundaryError({
        reason: "tenant-worker-restarted",
        detail: `The worker hosting session ${this.inner.sessionId} was reaped for idleness or died before this command arrived; `
          + "the session is reopened from its archive, with the same id, on the next request.",
        remediation: "retry the request",
      });
    }
    this.resetIdleTimer();
    // Jeder Dispatch, der hier ankommt, ist Verkehr fuer den Worker dieses
    // Kontos. Ohne diesen Aufruf mass der Idle-Timer der Worker-Registry das
    // **Alter** des Prozesses statt seiner Ruhezeit: gemessen am 2026-11-09 mit
    // `OMP_WEB_TENANT_WORKER_IDLE_MS=10000` und einem `bash`-Aufruf alle ~6 s
    // war der Worker bei t≈19 s weg, obwohl er durchgehend benutzt wurde.
    // `send` meldet Verkehr an den Worker seines Kontos. `globalThis` direkt statt
    // `getTenantWorkerHost()`: der Getter legte fuer den ersten Admin-Request eine
    // Registry an, die nie einen Worker halten wird, und installierte drei
    // Prozess-Haken fuer einen Pfad, der keine Grenze braucht.
    if (identity) globalThis.__ompTenantWorkers?.touch(identity.username);
    const type = command.type as string;
    if (this.shouldWaitForExtensions(type)) await this.waitForExtensionsBound();
    if (this.handoffRunning && HANDOFF_ALLOWED_COMMAND_TYPES[type] !== true) {
      throw new Error("Cannot modify the session while a handoff is in progress");
    }
    if (type === "prompt" || type === "steer" || type === "follow_up") {
      this.syncPlanModeFromSession();
    }

    if (type === "prompt" || type === "steer" || type === "follow_up") {
      const imageError = validateAgentImages(command.images);
      if (imageError) throw new Error(imageError);
    }

    switch (type) {
      case "prompt": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot send a prompt while a shell command is running");
        }
        // A turn the operator asked for means the next continuation is wanted,
        // and supersedes one already scheduled.
        this.goalMode.onUserPrompt();
        // Fire and forget — events come via subscribe
        const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
        // A prompt with no run in flight starts one and gets a fresh budget; a
        // steering prompt joins the active run and shares its budget.
        const run = this.runBudget.active ? undefined : this.runBudget.begin();
        this.promptRunning = true;
        notifyRunningChange();
        this.inner.prompt(command.message as string, {
          ...(promptImages?.length ? { images: promptImages } : {}),
          ...(streamingBehavior ? { streamingBehavior } : {}),
          userInitiated: true,
        }).then(() => {
          if (run !== undefined) this.runBudget.end(run);
          this.promptRunning = false;
          this.resetIdleTimer();
          if (!streamingBehavior) this.emit({ type: "prompt_done" });
          notifyRunningChange();
        }).catch((error) => {
          if (run !== undefined) this.runBudget.end(run);
          this.promptRunning = false;
          this.resetIdleTimer();
          invalidateSessionListCache();
          this.emit({
            type: "prompt_error",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          if (!streamingBehavior) this.emit({ type: "prompt_done" });
          notifyRunningChange();
        });
        return null;
      }

      case "abort":
        this.runBudget.end();
        this.goalBudget.end();
        this.goalMode.onAbort();
        await this.withFinalRunningNotification(() => this.inner.abort());
        return null;

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        return {
          sessionId: this.inner.sessionId,
          sessionFile: this.inner.sessionFile ?? "",
          isStreaming: this.inner.isStreaming,
          isPromptRunning: this.promptRunning,
          isBashRunning: this.inner.isBashRunning,
          isCompacting: this.inner.isCompacting,
          isHandoffRunning: this.handoffRunning,
          autoCompactionEnabled: this.inner.autoCompactionEnabled,
          autoRetryEnabled: this.inner.autoRetryEnabled,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: this.inner.queuedMessageCount,
          queuedMessages: {
            steering: [...this.inner.getQueuedMessages().steering],
            followUp: [...this.inner.getQueuedMessages().followUp],
          },
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          systemPrompt: [this.inner.agent.state?.systemPrompt ?? ""].flat().join("\n"),
          thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
          configuredThinkingLevel: this.inner.configuredThinkingLevel() ?? "off",
          extensionWidgets: this.getExtensionWidgets(),
          subagents: this.getSubagentSnapshots(),
          goal: this.goalMode.getStatus(),
          vibe: this.vibeMode.getStatus(),
        };
      }
      case "get_subagents":
        return { subagents: this.getSubagentSnapshots() };

      case "get_subagent_messages": {
        const selector = command as {
          subagentId?: string;
          sessionFile?: string;
          fromByte?: number;
        };
        const transcriptFile = this.subagents.resolveSessionFile(selector);
        return readRpcSubagentTranscript(transcriptFile, selector.fromByte);
      }


      case "set_model": {
        const { provider, modelId, role } = command as { provider: string; modelId: string; role?: string };
        // modelRegistry.find() takes (provider, modelId) as two arguments — passing a
        // pre-joined "provider/modelId" selector leaves modelId undefined and throws
        // inside the SDK before we ever get a chance to report "model not found".
        let model = this.inner.modelRegistry.find(provider, modelId);
        if (!model) {
          await this.inner.modelRegistry.refresh("offline");
          model = this.inner.modelRegistry.find(provider, modelId);
        }
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        // omp records the role a model change came from, so the transcript and
        // the `/model` carousel agree on which role is currently driving.
        await this.inner.setModel(model, role);
        invalidateModelsCache();
        invalidateSessionListCache();
        return { id: model.id, provider: model.provider, ...(role ? { role } : {}), ...this.modelSwitchState() };
      }

      case "set_role_model": {
        const role = command.role as string;
        const model = this.inner.resolveRoleModel(role);
        if (!model) throw new Error(`No model configured for role "${role}"`);
        await this.inner.setModel(model, role);
        invalidateModelsCache();
        invalidateSessionListCache();
        return { id: model.id, provider: model.provider, role, ...this.modelSwitchState() };
      }

      case "fork": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot fork while a shell command is running");
        }
        const sessionManager = this.inner.sessionManager;
        const entryId = resolveForkEntryId(
          sessionManager.getBranch() as ForkBranchEntry[],
          command.entryId,
        );
        if (!entryId) throw new Error("No user message to fork from yet");
        const currentSessionFile = this.inner.sessionFile;

        if (!currentSessionFile) return { cancelled: true };

        const entry = sessionManager.getEntry(entryId);
        if (!entry) throw new Error("Invalid entry ID for forking");

        const sessionDir = sessionManager.getSessionDir();
        let newSessionFile: string;

        if (!entry.parentId) {
          // Fork before the first message: create an empty session linked to this one
          const newManager = SessionManager.create(sessionManager.getCwd(), sessionDir);
          await newManager.newSession({ parentSession: currentSessionFile });
          await newManager.ensureOnDisk();
          newSessionFile = newManager.getSessionFile() as string;
        } else {
          // Fork after some history: copy path up to (but not including) the fork point
          const sourceManager = await SessionManager.open(currentSessionFile, sessionDir);
          const forkedPath = sourceManager.createBranchedSession(entry.parentId);
          if (!forkedPath) throw new Error("Failed to create forked session");
          newSessionFile = forkedPath;
        }

        const newSessionId = (await SessionManager.open(newSessionFile, sessionDir)).getSessionId();
        cacheSessionPath(newSessionId, newSessionFile);
        invalidateSessionListCache();
        await this.shutdownAfterCommittedFork(newSessionId);
        return { cancelled: false, newSessionId };
      }

      case "handoff": {
        // omp 18 made handoff in-place: it summarizes the conversation into a
        // handoff document and commits that as this session's compaction entry
        // instead of minting a replacement session. It still rewrites history
        // behind a oneshot model call, so it must not run while a prompt is
        // streaming or any other work owns the session.
        if (this.handoffRunning || this.promptRunning || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning) {
          throw new Error("Cannot hand off while the session is busy");
        }
        const customInstructions = command.customInstructions as string | undefined;
        this.handoffRunning = true;
        notifyRunningChange();
        try {
          // No result means the handoff was cancelled; the session is untouched.
          const result = await this.inner.handoff(customInstructions);
          if (!result) return { cancelled: true };
          // The session id and file are unchanged, so only the cached listing
          // (modified time, token counts) has gone stale.
          invalidateSessionListCache();
          return { cancelled: false };
        } finally {
          this.handoffRunning = false;
          notifyRunningChange();
        }
      }

      case "navigate_tree": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot navigate while a shell command is running");
        }
        const result = await this.inner.navigateTree(command.targetId as string, {});
        return { cancelled: result.cancelled };
      }

      case "set_thinking_level": {
        const level = command.level as string;
        this.inner.setThinkingLevel(level);
        // setThinkingLevel clamps xhigh→high for models where supportsXhigh()===false.
        // If the model has DeepSeek thinking compat (reasoningEffortMap maps xhigh→max),
        // force the state back so the compat layer can use it correctly.
        if (level === "xhigh" && (this.inner.model as { compat?: { thinkingFormat?: string } } | null)?.compat?.thinkingFormat === "deepseek" && this.inner.agent?.state) {
          this.inner.agent.state.thinkingLevel = "xhigh";
        }
        invalidateSessionListCache();
        return null;
      }

      case "compact": {
        try {
          return await this.withFinalRunningNotification(() =>
            this.inner.compact(command.customInstructions as string | undefined)
          );
        } finally {
          invalidateSessionListCache();
        }
      }

      case "set_session_name": {
        const name = (command.name as string | undefined)?.trim();
        if (!name) throw new Error("Session name cannot be empty");
        await this.inner.sessionManager.setSessionName(name, "user");
        invalidateSessionListCache();
        return null;
      }

      case "get_session_stats": {
        return {
          ...this.inner.getSessionStats(),
          sessionName: this.inner.sessionManager.getSessionName(),
        };
      }

      case "get_last_assistant_text": {
        return { text: this.inner.getLastAssistantText() ?? "" };
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "clear_queue": {
        // Full clear only: omp has no single-item dequeue, and clear+requeue
        // races against the agent loop pulling messages mid-flight.
        const cleared = this.inner.clearQueue();
        const toText = (message: unknown): string =>
          typeof message === "string" ? message : String((message as { text?: string })?.text ?? "");
        return {
          steering: cleared.steering.map(toText),
          followUp: cleared.followUp.map(toText),
        };
      }

      case "steer": {
        const steerImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.steer(command.message as string, steerImages?.length ? steerImages : undefined);
        return null;
      }

      case "follow_up": {
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.followUp(command.message as string, followImages?.length ? followImages : undefined);
        return null;
      }

      case "get_tools": {
        const active = new Set<string>(this.inner.getActiveToolNames());
        return listTools(this.inner).map((t) => ({
          name: t.name,
          description: t.description,
          active: active.has(t.name),
        }));
      }

      case "get_commands": {
        return { commands: await getAvailableSlashCommands(this.inner) };
      }

      case "goal": {
        const goalArgs = (command.args as string | undefined) ?? "";
        // A goal started on the vibe toolset would run a second autonomous loop.
        const { sub, rest } = parseGoalCommand(goalArgs);
        const entersGoal = sub === "set" || sub === "resume" || (sub === undefined && rest.length > 0);
        if (entersGoal && this.vibeMode.getStatus()?.enabled) {
          return { error: "Exit vibe mode first.", status: this.goalMode.getStatus() };
        }
        return await this.goalMode.handleCommand(goalArgs);
      }

      case "vibe": {
        return await this.vibeMode.handleCommand((command.args as string | undefined) ?? "");
      }

      case "execute_slash_command": {
        // A tenant session may read the operator's MCP/SSH/plugin store but
        // not write it in user scope: the builtins resolve their paths from
        // process state (`getAgentDir()`), so only the caller's identity stands
        // between a tenant and the operator's files.
        const operatorCommand = isAdminIdentity(identity)
          ? null
          : operatorScopeSlashCommand(command.message);
        if (operatorCommand) {
          return {
            handled: true,
            output: [
              `Refused: ${operatorCommand} needs administrator access; it writes user-scope state shared by every account.`,
            ],
          };
        }
        const output: string[] = [];
        const result: AcpBuiltinSlashCommandResult = await executeAcpBuiltinSlashCommand(command.message as string, {
          session: this.inner as never,
          sessionManager: this.inner.sessionManager,
          settings: this.inner.settings,
          cwd: this.cwd,
          output: (text) => {
            output.push(text);
          },
          refreshCommands: () => {},
          reloadPlugins: async () => {
            await this.waitForExtensionsBound();
            this.extensionWidgets.clear();
            await this.inner.reload();
            await this.inner.refreshSkills?.();
            this.applyForcedEmptySystemPrompt();
            invalidateModelsCache();
          },
        });
        if (result === false) return { handled: false, output };
        return {
          handled: true,
          output,
          ...("prompt" in result ? { prompt: result.prompt } : {}),
        };
      }


      case "set_tools": {
        // A preset change would overwrite the reduced vibe toolset mid-mode; a
        // pending entry is worse, its FIFO tool mutation would land after it.
        if (this.vibeMode.getStatus()?.enabled || this.vibeMode.isPending()) {
          return { error: "Exit vibe mode before changing the tool preset." };
        }
        const toolNames = command.toolNames as string[];
        this.setForceEmptySystemPrompt(toolNames.length === 0);
        await this.inner.setActiveToolsByName(
          this.goalMode.reconcileToolNames(withExtensionTools(this.inner, toolNames)),
        );
        this.applyForcedEmptySystemPrompt();
        return null;
      }

      case "reload": {
        await this.waitForExtensionsBound();
        this.extensionWidgets.clear();
        await this.inner.reload();
        await this.inner.refreshSkills?.();
        this.applyForcedEmptySystemPrompt();
        invalidateModelsCache();
        return { success: true };
      }

      case "abort_compaction": {
        this.inner.abortCompaction();
        return null;
      }

      case "extension_ui_response": {
        this.resolveExtensionUiResponse(command as ExtensionUiResponse);
        return null;
      }

      case "extension_ui_input": {
        this.handleExtensionUiInput(command.id as string, command.data as string);
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      case "bash": {
        if (this.promptRunning || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning) {
          throw new Error("Cannot run a shell command while the session is busy");
        }
        const execution = this.inner.executeBash(
          command.command as string,
          undefined,
          { excludeFromContext: command.excludeFromContext as boolean | undefined },
        );
        notifyRunningChange();
        try {
          const result = await execution;
          this.persistBashOnlySession();
          // Nach dem Schreiben nachziehen, nicht nur beim Start: das SDK oeffnet
          // die `.jsonl` mit `O_CREAT` **ohne** Modus (session-storage.ts:316-321)
          // und erbt damit die umask des Prozesses. Der Aufruf beim Session-Start
          // lief, bevor diese Datei existierte, und konnte sie deshalb nicht
          // erfassen — gemessen 2026-11-08: die Datei einer In-Process-
          // Mandanten-Session war `0644`.
          this.tightenTenantArchive();
          return result;
        } finally {
          this.resetIdleTimer();
          invalidateSessionListCache();
          notifyRunningChange();
        }
      }

      case "abort_bash": {
        this.inner.abortBash();
        return null;
      }

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    this.runBudget.end();
    this.goalBudget.end();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.inner.isBashRunning) this.inner.abortBash();
    this.unsubscribe?.();
    this.goalModeController?.dispose();
    this.unsubscribeJobSettled?.();
    this.subagents.dispose();
    this.subagentHistory.clear();
    for (const pending of this.pendingUiResponses.values()) pending.cancel();
    for (const id of Array.from(this.activeCustomUis.keys())) this.closeCustomUi(id, undefined);
    this.pendingUiResponses.clear();
    this.pendingUiRequests.clear();
    try {
      void this.inner.dispose?.();
    } finally {
      try {
        this.onDestroyCallback?.();
      } finally {
        notifyRunningChange();
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (!this._alive) return;

    this.shutdownPromise = (async () => {
      try {
        try {
          await this.waitForExtensionsBound();
        } catch (error) {
          console.error(
            "[pi-web] extension binding failed before session shutdown:",
            error instanceof Error ? error.message : error,
          );
        }
        await this.inner.extensionRunner?.emit?.({ type: "session_shutdown", reason: "quit" });
      } finally {
        this.destroy();
      }
    })();
    return this.shutdownPromise;
  }

  private resolveExtensionUiResponse(response: ExtensionUiResponse): void {
    const pending = this.pendingUiResponses.get(response.id);
    if (!pending) return;
    pending.resolve(response);
  }

  /**
   * Was ein Modellwechsel im Client nachziehen muss, ohne die Session neu zu
   * laden.
   *
   * Der Wechsel selbst geht durch die SDK (`setModel`) und schreibt einen
   * `model_change`-Eintrag. Was der Browser davon braucht, sind drei Werte:
   * das Modell, das jetzt gilt, den Thinking-Level, den die SDK dabei neu
   * angewendet hat (`#reapplyThinkingLevel`), und den Leaf nach dem Eintrag.
   *
   * Der frueher folgende `GET /api/sessions/<id>` hat stattdessen das ganze
   * Transkript gelesen und neu gerendert — teuer und, bei einer gerade erst
   * gestarteten Session, auch falsch: die Route liest dann die Datei, und
   * `appendModelChange` spuelt asynchron. Diese drei Werte stehen im
   * Speicher und koennen nicht hinter der Spuelung zurueckbleiben.
   */
  private modelSwitchState(): {
    thinkingLevel?: string;
    configuredThinkingLevel?: string;
    leafId: string | null;
  } {
    // `agent` und `sessionManager` sind in Tests und bei einer noch nicht
    // vollstaendig aufgebauten Session nicht gesetzt. Ein fehlender Wert ist
    // hier kein Fehler: der Client laesst das Feld dann einfach stehen.
    const thinkingLevel = this.inner.agent?.state?.thinkingLevel;
    return {
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(typeof this.inner.configuredThinkingLevel === "function"
        ? { configuredThinkingLevel: this.inner.configuredThinkingLevel() }
        : {}),
      leafId: this.inner.sessionManager?.getLeafId?.() ?? null,
    };
  }

  private getExtensionWidgets(): ExtensionWidgetItem[] {
    return Array.from(this.extensionWidgets.values());
  }

  private getCustomUiWidth(options: unknown): number {
    if (!options || typeof options !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const overlayOptions = (options as { overlayOptions?: unknown }).overlayOptions;
    const resolved = typeof overlayOptions === "function" ? overlayOptions() : overlayOptions;
    if (!resolved || typeof resolved !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const width = (resolved as { width?: unknown }).width;
    return typeof width === "number" && Number.isFinite(width)
      ? Math.max(40, Math.min(140, Math.round(width)))
      : 92;
  }

  private emitCustomUiRender(id: string, custom: ActiveCustomUi): void {
    let lines: string[];
    try {
      lines = custom.component.render(custom.width);
    } catch (error) {
      lines = [`Extension custom UI render failed: ${error instanceof Error ? error.message : String(error)}`];
    }
    const event = {
      type: "extension_ui_request",
      id,
      method: "custom",
      lines,
    } as ExtensionUiRequest as AgentEvent;
    this.pendingUiRequests.set(id, event);
    this.emit(event);
  }

  private closeCustomUi(id: string, value: unknown): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || custom.settled) return;
    custom.settled = true;
    this.activeCustomUis.delete(id);
    this.pendingUiRequests.delete(id);
    try {
      custom.component.dispose?.();
    } catch {
      // Ignore dispose errors from extension UI components.
    }
    this.emit({
      type: "extension_ui_request",
      id,
      method: "custom",
      lines: [],
      closed: true,
    } as ExtensionUiRequest as AgentEvent);
    custom.resolve(value);
  }

  private handleExtensionUiInput(id: string, data: string): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || typeof data !== "string") return;
    try {
      custom.component.handleInput?.(data);
      if (this.activeCustomUis.has(id)) this.emitCustomUiRender(id, custom);
    } catch (error) {
      this.closeCustomUi(id, undefined);
      this.emit({
        type: "extension_error",
        extensionPath: `custom-ui:${id}`,
        event: "custom_ui_input",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requestExtensionCustomUi<T>(
    factory: unknown,
    options?: unknown,
  ): Promise<T> {
    if (typeof factory !== "function") return Promise.resolve(undefined as T);

    const id = randomUUID();
    const width = this.getCustomUiWidth(options);

    return new Promise<T>((resolve) => {
      let completed = false;
      const tui = createHeadlessCustomUiTui(
        () => {
          const custom = this.activeCustomUis.get(id);
          if (custom) this.emitCustomUiRender(id, custom);
        },
        width,
      );
      const finish = (value: T) => {
        if (completed) return;
        completed = true;
        resolve(value);
      };
      const done = (value: T) => {
        if (this.activeCustomUis.has(id)) {
          this.closeCustomUi(id, value);
        } else {
          finish(value);
        }
      };

      Promise.resolve()
        .then(() => factory(tui, PLAIN_TEXT_THEME, CUSTOM_UI_KEYBINDINGS, done))
        .then((component) => {
          if (completed) {
            try {
              (component as CustomUiComponent | undefined)?.dispose?.();
            } catch {
              // Ignore dispose errors from a component completed before mounting.
            }
            return;
          }
          if (!component || typeof component !== "object" || typeof (component as CustomUiComponent).render !== "function") {
            finish(undefined as T);
            return;
          }
          const custom: ActiveCustomUi = {
            component: component as CustomUiComponent,
            width,
            resolve: (value) => finish(value as T),
            settled: false,
          };
          this.activeCustomUis.set(id, custom);
          this.emitCustomUiRender(id, custom);
        })
        .catch((error) => {
          if (completed) return;
          this.emit({
            type: "extension_error",
            extensionPath: `custom-ui:${id}`,
            event: "custom_ui",
            error: error instanceof Error ? error.message : String(error),
          });
          finish(undefined as T);
        });
    });
  }

  private requestExtensionUi<T>(
    request: ExtensionUiRequestBody,
    defaultValue: T,
    parseResponse: (response: ExtensionUiResponse) => T,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.resolve(defaultValue);

    const id = randomUUID();
    const fullRequest = {
      type: "extension_ui_request",
      id,
      ...request,
      ...(timeout ? { timeout, expiresAt: Date.now() + timeout } : {}),
    };

    return new Promise((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        this.pendingUiRequests.delete(id);
        this.pendingUiResponses.delete(id);
      };
      const settle = (value: T) => {
        cleanup();
        resolve(value);
      };
      const onAbort = () => settle(defaultValue);

      if (timeout) timeoutId = setTimeout(() => settle(defaultValue), timeout);
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pendingUiRequests.set(id, fullRequest as AgentEvent);
      this.pendingUiResponses.set(id, {
        resolve: (response) => settle(parseResponse(response)),
        cancel: () => settle(defaultValue),
      });
      this.emit(fullRequest as AgentEvent);
    });
  }

  private createExtensionUiContext(): ExtensionUiContextLike {
    return {
      timeoutStartsOnPresentation: false,
      askDialog: (questions, opts) => this.requestExtensionUi(
        { method: "ask", questions, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => {
          if (!("value" in response)) return undefined;
          try {
            return JSON.parse(response.value) as ExtensionAskDialogResult;
          } catch {
            return undefined;
          }
        },
        opts?.timeout,
        opts?.signal,
      ),
      select: (title, options, opts) => this.requestExtensionUi(
        { method: "select", title, options, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      confirm: (title, message, opts) => this.requestExtensionUi(
        { method: "confirm", title, message, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        false,
        (response) => "confirmed" in response ? response.confirmed : false,
        opts?.timeout,
        opts?.signal,
      ),
      input: (title, placeholder, opts) => this.requestExtensionUi(
        { method: "input", title, ...(placeholder !== undefined ? { placeholder } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      editor: (title, prefill, opts) => this.requestExtensionUi(
        { method: "editor", title, ...(prefill !== undefined ? { prefill } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      notify: (message, type) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "notify",
          message,
          notifyType: type,
        } as ExtensionUiRequest as AgentEvent);
      },
      onTerminalInput: () => () => {},
      // Kein TUI-Statuszeilen-Bereich im Browser: Plugin-Status gehoert wie
      // `setFooter` nur in die TUI.
      setStatus: () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: (key, content, options) => {
        if (content !== undefined && !Array.isArray(content)) return;
        if (content === undefined) {
          this.extensionWidgets.delete(key);
        } else {
          this.extensionWidgets.set(key, {
            key,
            lines: content,
            placement: options?.placement ?? "aboveEditor",
          });
        }
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        } as ExtensionUiRequest as AgentEvent);
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setTitle",
          title,
        } as ExtensionUiRequest as AgentEvent);
      },
      custom: <T = unknown>(factory: unknown, options?: unknown) => this.requestExtensionCustomUi<T>(factory, options),
      pasteToEditor: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setEditorText: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() { return PLAIN_TEXT_THEME; },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is not supported in omp-web extension UI yet" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }
}

// ============================================================================
// Session registry
// ============================================================================

declare global {
  var __ompSessions: Map<string, AgentSessionWrapper> | undefined;
  var __ompSessionOwners: Map<string, string> | undefined;
  var __ompStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
  var __ompStartingSessionCwds: Map<string, number> | undefined;
  var __ompRunningListeners: Set<(ids: string[]) => void> | undefined;
  var __ompTenantWorkers: TenantWorkerHost | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__ompSessions) {
    globalThis.__ompSessions = new Map();
    const cleanup = () => globalThis.__ompSessions?.forEach((s) => s.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__ompSessions;
}

/**
 * Wer hat die laufende Session gestartet?
 *
 * Eine Neben-Map und kein Feld auf dem Wrapper: die Registry ist ein
 * `globalThis`-Objekt, das Tests direkt als `Map<string, AgentSessionWrapper>`
 * setzen, und ein Wrapper ist an mehreren Stellen von Hand gebaut. Ein
 * zusaetzliches Pflichtfeld auf dem Wrapper wuerde jeden dieser Aufbaustellen
 * eine Aenderung aufzwingen und die Registrierung beim Aufruf vergessen lassen
 * — ein fehlender Owner wuerde dann still durchfallen.
 *
 * Deshalb gilt hier: **kein Eintrag heisst nicht besitzbar.** Kein
 * `?? "pi"`, kein Fallback. Eine Session aus einer aelteren Sitzung, deren
 * Owner-Map es nicht ueberlebt hat, ist fuer niemanden sichtbar. Das ist
 * die Richtung, in der ein Fehler unauffaellig ist, und die ist hier die
 * sichere.
 */
function getOwnerMap(): Map<string, string> {
  if (!globalThis.__ompSessionOwners) globalThis.__ompSessionOwners = new Map();
  return globalThis.__ompSessionOwners;
}

function setSessionOwner(sessionId: string, owner: string): void {
  getOwnerMap().set(sessionId, owner);
}

function forgetSessionOwner(sessionId: string): void {
  getOwnerMap().delete(sessionId);
}

/** Besitzer einer Laufzeit-Session, oder `undefined` wenn keiner hinterlegt ist. */
export function getRpcSessionOwner(sessionId: string): string | undefined {
  return getOwnerMap().get(sessionId);
}

/**
 * Besitzt `identity` diese Laufzeit-Session?
 *
 * Ein Admin besitzt alles. Fuer alle anderen gilt Gleichheit: wer die Session
 * gestartet hat, ist der einzige, der sie sieht.
 *
 * `null` heisst hier bewusst NICHT "nicht angemeldet, also nichts sichtbar",
 * sondern "kein Mandantenkontext" — die CLI, der Running-Broadcaster und die
 * Prozess-Cleanup-Pfade kennen keinen Benutzer. Das entspricht der Regel, die
 * auch `listAllSessions` befolgt: der Default filtert nicht, die ROUTE filtert.
 *
 * Der Schutz liegt deshalb in der ROUTE und nicht hier: wer von proxy.ts keinen
 * Header bekommt, antwortet 403 und ruft diese Funktion nie auf. Eine Liste,
 * die ein nicht angemeldeter Client sieht, kann es damit nicht geben.
 */
export function isRpcSessionVisibleTo(sessionId: string, identity: WebIdentity | null): boolean {
  if (!identity) return true;
  if (isAdminIdentity(identity)) return true;
  return getOwnerMap().get(sessionId) === identity.username;
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__ompStartLocks) globalThis.__ompStartLocks = new Map();
  return globalThis.__ompStartLocks;
}

function normalizeRpcCwd(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  try {
    return realpathSync(resolvedCwd);
  } catch {
    return resolvedCwd;
  }
}

/**
 * The SDK registers every root in the process-global `AgentRegistry` under one
 * id (`options.agentId ?? parentTaskPrefix ?? MAIN_AGENT_ID`), and omp-web runs
 * many roots in one process — so each root gets its own key instead of all of
 * them claiming "Main" last-wins. The id must be `agent://`-safe: no `/` `?`
 * `#`, and no `:` (a URL parser reads that as a port).
 */
export function rootAgentId(sessionId: string): string {
  return `omp-web-${sessionId.replace(/[^A-Za-z0-9._-]/g, "-")}`;
}

function getStartingSessionCwds(): Map<string, number> {
  if (!globalThis.__ompStartingSessionCwds) globalThis.__ompStartingSessionCwds = new Map();
  return globalThis.__ompStartingSessionCwds;
}

function trackStartingSession(cwd: string): () => void {
  const startingCwds = getStartingSessionCwds();
  const key = normalizeRpcCwd(cwd);
  startingCwds.set(key, (startingCwds.get(key) ?? 0) + 1);
  return () => {
    const remaining = (startingCwds.get(key) ?? 1) - 1;
    if (remaining > 0) startingCwds.set(key, remaining);
    else startingCwds.delete(key);
  };
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

function runtimeMessageText(entry: SessionMessageEntry): string {
  if (entry.message.role === "bashExecution") return "";
  const content = entry.message.content;
  if (typeof content === "string") return content;
  return content
    .map((block) => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join(" ");
}

function runtimeMessageActivityMs(entry: SessionMessageEntry): number | undefined {
  if (entry.message.role !== "user" && entry.message.role !== "assistant") return undefined;
  if (typeof entry.message.timestamp === "number") return entry.message.timestamp;
  const timestamp = new Date(entry.timestamp).getTime();
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

/**
 * Die Grenze einer laufenden Session.
 *
 * Gefragt wird die Session selbst, nicht die Registry: der Worker-Pfad haengt
 * `boundary` an das Objekt (`lib/tenant-worker-session.ts`), der In-Process-Pfad
 * nicht. Damit gibt es genau eine Quelle, und ein Admin bekommt keine
 * Behauptung, die er nicht gemessen hat.
 *
 * `enforced: true` steht bei einem Worker nur, wenn beide Bedingungen gelten:
 * `boundary.enforced` aus dem Start **und** eine gemeldete PID. Die Zusage aus
 * §5/§8 des Plans ("keine Isolation behaupten, die nicht da ist") wird hier
 * durchgereicht, nicht neu behauptet.
 */
function boundaryForSession(session: AgentSessionWrapper): SessionInfo["boundary"] {
  const boundary = (session.inner as { boundary?: SessionInfo["boundary"] }).boundary;
  if (!boundary) {
    // Der In-Process-Pfad: der Admin und der ausdrueckliche Ausstieg. `enforced`
    // ist hier immer `false`, weil in diesem Prozess jede Grenze eine
    // Vereinbarung waere; eine PID gibt es nicht, weil es keinen eigenen
    // Prozess gibt.
    return { kind: "in-process", enforced: false };
  }
  // Ein Worker meldet `enforced: true` nur mit lebender PID — die Zusage aus
  // §5/§8 des Plans, hier nur durchgereicht und nicht neu behauptet.
  return boundary.kind === "tenant-worker"
    ? { kind: "tenant-worker", enforced: boundary.enforced === true && boundary.pid !== undefined, ...(boundary.pid !== undefined ? { pid: boundary.pid } : {}) }
    : { kind: "in-process", enforced: false };
}

/**
 * Return live sessions that should be visible in the session list. Pi delays
 * the first JSONL flush until an assistant message exists, so an accepted new
 * prompt must temporarily be described from its in-memory SessionManager.
 */
export function getRpcSessionInfos(identity: WebIdentity | null = null): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  for (const [sessionKey, session] of getRegistry()) {
    if (!session.isAlive()) continue;
    // Fremde Laufzeit-Sessions sind keine Frage der Liste, sondern gar nicht
    // erst vorhanden. Der Admin sieht alles.
    if (!isRpcSessionVisibleTo(sessionKey, identity)) continue;

    const manager = session.inner.sessionManager;
    const header = manager.getHeader();
    const entries = manager.getEntries() as unknown as Array<
      { type: string; timestamp: string } | SessionMessageEntry
    >;
    const messages = entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
    const firstUserMessage = messages.find((entry) => entry.message.role === "user");
    const sessionFile = manager.getSessionFile() ?? session.sessionFile;
    const persisted = Boolean(sessionFile && existsSync(sessionFile));

    // An ensure_session call creates an idle, empty runtime while the composer
    // loads commands. Do not leak it into history before a prompt is accepted.
    if (!persisted && (!session.isRunning() || !firstUserMessage)) continue;

    const created = header?.timestamp
      ?? entries[0]?.timestamp
      ?? new Date().toISOString();
    const headerTimestamp = new Date(created).getTime();
    let lastActivityMs = Number.isNaN(headerTimestamp) ? Date.now() : headerTimestamp;
    for (const message of messages) {
      const activityMs = runtimeMessageActivityMs(message);
      if (activityMs !== undefined) lastActivityMs = Math.max(lastActivityMs, activityMs);
    }

    const boundary = boundaryForSession(session);
    sessions.push({
      path: sessionFile ?? "",
      id: header?.id ?? session.sessionId,
      cwd: header?.cwd ?? session.cwd,
      name: manager.getSessionName(),
      created,
      modified: new Date(lastActivityMs).toISOString(),
      messageCount: messages.length,
      firstMessage: firstUserMessage ? runtimeMessageText(firstUserMessage) || "(no messages)" : "(no messages)",
      transient: !persisted,
      ...(boundary ? { boundary } : {}),
    });
  }
  return sessions;
}

export function hasBusyRpcSessionForCwd(cwd: string): boolean {
  const targetCwd = normalizeRpcCwd(cwd);
  if (getStartingSessionCwds().has(targetCwd)) return true;
  return Array.from(getRegistry().values()).some(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd && session.isRunning(),
  );
}

export async function destroyRpcSessionsForCwd(cwd: string): Promise<number> {
  const targetCwd = normalizeRpcCwd(cwd);
  const sessions = Array.from(getRegistry().values()).filter(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd,
  );
  await Promise.all(sessions.map((session) => session.shutdown()));
  return sessions.length;
}

/**
 * Jede laufende Session-Id des Prozesses, ohne Besitzfilter.
 *
 * Nur fuer Aufrufer, die selbst filtern: der Aenderungs-Broadcast und
 * Prozess-Cleanup. Eine Route nimmt {@link getRunningRpcSessionIds}, weil dort
 * die Identitaet des Anfragenden bekannt ist.
 */
export function getAllRunningRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

/**
 * Die laufenden Session-Ids, die `identity` sehen darf.
 *
 * Ohne Identitaet ist die Antwort "alles" — dieselbe Regel wie in
 * {@link isRpcSessionVisibleTo}. Die ROUTE gibt bei fehlendem Header 403 und
 * kommt hier nie ohne Identitaet an; wer filtern will, ruft mit Identitaet auf.
 */
export function getRunningRpcSessionIds(identity: WebIdentity | null = null): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    if (!isRpcSessionVisibleTo(sessionId, identity)) continue;
    if (session.isRunning()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

// ----------------------------------------------------------------------------
// Running-status broadcaster
//
// Pushes the current set of running session ids to subscribers whenever any
// session's running state may have changed. This lets the sidebar receive live
// updates over SSE instead of polling. Listeners live on globalThis so they
// survive Next.js hot-reload.
// ----------------------------------------------------------------------------

function getRunningListeners(): Set<(ids: string[]) => void> {
  if (!globalThis.__ompRunningListeners) globalThis.__ompRunningListeners = new Set();
  return globalThis.__ompRunningListeners;
}

/** Subscribe to running-session-id changes. Returns an unsubscribe function. */
export function subscribeRunningSessions(listener: (ids: string[]) => void): () => void {
  const listeners = getRunningListeners();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let lastRunningSnapshot = "";

/**
 * Recompute the running-session-id set and, if it changed since the last
 * notification, broadcast it to subscribers.
 *
 * Der Broadcast laeuft ueber die ungefilterte Menge: das ist die
 * Aenderungsmeldung des Prozesses, keine Antwort auf eine Anfrage. Jeder
 * Abonnent filtert selbst ueber `getRunningRpcSessionIds(identity)`, denn was
 * fuer den einen eine fremde Session ist, ist fuer den Admin seine eigene, und
 * das kann sich nicht in einem prozess-globalen Broadcast entscheiden lassen.
 * Der Listener bekommt deshalb alle Ids, und die Route filtert.
 */
export function notifyRunningChange(): void {
  const listeners = getRunningListeners();
  if (listeners.size === 0) {
    // A future subscriber receives its own initial snapshot. Clear this one so
    // its first state transition cannot match stale state from an old listener.
    lastRunningSnapshot = "";
    return;
  }
  const ids = getAllRunningRpcSessionIds();
  const snapshot = JSON.stringify([...ids].sort());
  if (snapshot === lastRunningSnapshot) return;
  lastRunningSnapshot = snapshot;
  for (const listener of listeners) {
    try { listener(ids); } catch { /* ignore listener errors */ }
  }
}

/**
 * Ein Mandanten-Request, der an der Grenze scheitert.
 *
 * Drei Felder, weil die Abnahmetabelle A5 genau danach fragt: `reason` (was
 * fehlt), `detail` (der gemessene Befund) und `remediation` (was zu tun ist).
 * Ein `Error` mit nur einer Nachricht zwingt die Route, den Grund aus einem
 * String zu raten — und damit landet er irgendwann nicht mehr im Fehlerkoerper.
 */
export class TenantBoundaryError extends Error {
  readonly reason: string;
  readonly detail: string;
  readonly remediation: string;

  constructor(failure: { reason: string; detail: string; remediation: string }) {
    super(`${failure.reason}: ${failure.detail}`);
    this.name = "TenantBoundaryError";
    this.reason = failure.reason;
    this.detail = failure.detail;
    this.remediation = failure.remediation;
  }
}

/**
 * Die HTTP-Antwort zu einer fehlenden Grenze.
 *
 * **Warum nicht 500.** Ein fehlendes `bwrap` ist kein Serverfehler, sondern ein
 * Zustand des Hosts: die Voraussetzung ist bekannt, benannt und behebbar. Eine
 * 500 sagt "der Server ist kaputt" und schickt den Betreiber in die Logs,
 * obwohl der Grund im Koerper steht und die Abhilfe ein `pacman -S bubblewrap`
 * ist. Dieselbe Ueberlegung gilt fuer den Terminal-Pfad, der fuer denselben
 * Zustand seit jeher **503** antwortet (`app/api/terminal/route.ts:97-104`) —
 * zwei Routen, die fuer dieselbe Ursache zwei verschiedene Statuscodes
 * schicken, waeren ein Widerspruch in der API.
 *
 * `503` heisst ausserdem genau das Richtige: der Dienst ist da, diese eine
 * Faehigkeit fehlt gerade, und ein spaeterer Versuch kann gelingen (sobald
 * jemand bwrap installiert hat). `500` behauptet das Gegenteil.
 *
 * Die vier Gruende sind **Voraussetzungen des Hosts**: etwas, das auf dieser
 * Maschine fehlt oder abgeschaltet ist, unabhaengig von diesem Request.
 * `boundary-unavailable` fasst dabei drei fehlende Dateien zusammen (Home,
 * SDK-CLI, Bun) — der Grund steht in `detail`, nicht im Status.
 *
 * **Nicht dabei**, und warum:
 * - `unsupported-platform`: Windows hat keine User-Namespaces und bekommt sie
 *   nicht durch einen erneuten Versuch. Ein `503` wuerde "probier es spaeter
 *   nochmal" sagen, was hier nie stimmt; das bleibt bei `500`.
 * - `tenant-worker-capacity`: eine Betriebsgrenze, kein Zustand des Hosts. Der
 *   Aufrufer kann sie nur durch Warten oder einen Administrationsschritt
 *   aufloesen — kein "voruebergehend weg" im Sinne von 503.
 * - `tenant-worker-spawn-failed`: der Plan ging auf, der Prozess starb
 *   trotzdem. Das ist der eine echte Defekt in dieser Familie, und ihn als
 *   voruebergehend zu deklarieren luede zu einem Wiederholungssturm ein.
 * - `boundary-not-enforced`: gestartet, aber die Probe fand keine eigene
 *   Mount-Namespace (ein Wrapper frueher im `PATH`). Auch das ist kein
 *   Zustand, der von selbst vorbeigeht — ein erneuter Versuch trifft denselben
 *   Wrapper. Deshalb faellt der Grund auf die Vorgabe 500 und nicht auf 503.
 */
const BOUNDARY_STATUS_BY_REASON: Record<string, number> = {
  "bwrap-missing": 503,
  "userns-disabled": 503,
  "boundary-unavailable": 503,
  "mask-unavailable": 503,
  // Der Prozess, der die Session fuehrte, ist weg — der naechste Request baut
  // dieselbe Session-Id auf einem frischen Worker neu auf. `503` ist hier die
  // einzige ehrliche Antwort: der Dienst laeuft, diese eine Faehigkeit fehlt
  // gerade, und ein Wiederholungsversuch gelingt (gemessen am 2026-11-09: der
  // Request nach dem `kill -9` lief durch, mit derselben Session-Id).
  "tenant-worker-restarted": 503,
};

/**
 * Der Statuscode fuer einen fehlgeschlagenen Worker-Start.
 *
 * Unbekannte Gruende fallen auf `500`: ein neuer Grund soll laut auffallen,
 * nicht stillschweigend als "kommt gleich wieder" durchgehen.
 */
export function tenantBoundaryHttpStatus(reason: string): number {
  return BOUNDARY_STATUS_BY_REASON[reason] ?? 500;
}

let unsandboxedTenantWarned = false;

/**
 * Die laute Zeile fuer den Betriebsausstieg — **einmal pro Serverstart**.
 *
 * Auf stderr, nicht in eine Datei: es gibt keine Startlogdatei
 * (`OMP_WEB_STARTUP_LOG` existiert nicht), und systemd faengt stderr des
 * Dienstes auf. `console.warn` geht nach stderr, `console.log` nach stdout —
 * deshalb steht hier `console.warn`.
 *
 * Einmal pro Prozess, nicht pro Anfrage: der Zustand ist beim Start
 * entschieden, und eine Zeile pro Request waere Rauschen, das die eine
 * wichtige Zeile verdeckt.
 */
export function logUnsandboxedTenantWarningOnce(env: NodeJS.ProcessEnv = process.env): void {
  if (unsandboxedTenantWarned) return;
  const warning = unsandboxedTenantWarning(env);
  if (warning === null) return;
  unsandboxedTenantWarned = true;
  console.warn(warning);
}

/** Nur fuer Tests: die Einmal-Sperre zuruecksetzen. */
export function __resetUnsandboxedTenantWarning(): void {
  unsandboxedTenantWarned = false;
}

/**
 * Der Worker eines Kontos, beschafft oder gestartet, und die Session darauf.
 *
 * Die Registry ist prozess-global (`globalThis`), wie die Session-Registry
 * selbst: eine zweite Instanz pro Modul-Laden wuerde bei jedem Reload einen
 * zweiten Worker fuer dasselbe Konto starten.
 */
function getTenantWorkerHost(): TenantWorkerHost {
  if (globalThis.__ompTenantWorkers) return globalThis.__ompTenantWorkers;
  globalThis.__ompTenantWorkers = createTenantWorkerHost({
    // Laeuft fuer dieses Konto gerade ein Turn? Ein arbeitender Worker wird
    // nicht abgeraeumt, auch wenn seine letzte Anfrage laenger als `idleMs`
    // her ist: ein `bun install` in einem Werkzeugaufruf braucht Minuten, und
    // ein Abbruch mitten im Lauf waere Datenverlust. Die Antwort kommt aus der
    // Session-Registry und nicht aus einem Zeitfenster hier.
    isBusy: (username) => {
      for (const session of getRegistry().values()) {
        if (getOwnerMap().get(session.sessionId) !== username) continue;
        if (session.isAlive() && session.isRunning()) return true;
      }
      return false;
    },
  });
  // Beim Beenden die Kinder mitnehmen. `die-with-parent` in der Namespace sorgt
  // dafuer, dass ein hart beendeter Server keine Waisen hinterlaesst; dieser
  // Haken ist der geordnete Weg fuer den Normalfall.
  const shutdown = () => {
    const host = globalThis.__ompTenantWorkers;
    if (!host) return;
    for (const entry of host.snapshot()) void host.release(entry.username);
  };
  process.once("exit", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return globalThis.__ompTenantWorkers;
}

interface WorkerSessionStart {
  identity: WebIdentity;
  cwd: string;
  sessionFile: string;
  sessionId: string;
  options: RpcSessionStartOptions;
}

async function startWorkerSessionForTenant(
  start: WorkerSessionStart,
): Promise<
  | { ok: true; session: AgentSessionLike & { boundary: WorkerSessionBoundary }; eventBus: ConstructorParameters<typeof AgentSessionWrapper>[1] }
  | { ok: false; reason: string; detail: string; remediation: string }
> {
  const { identity } = start;
  const host = getTenantWorkerHost();
  const bunPath = resolveBunPath();
  if (bunPath === null) {
    return {
      ok: false,
      reason: "boundary-unavailable",
      detail: "Bun was not found, so the tenant worker cannot be started.",
      remediation: "Install Bun (https://bun.sh) or set OMP_WEB_BUN to its absolute path.",
    };
  }
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  // Die Provider dieses Kontos, aus seinem eigenen `models.yml` — nicht der
  // Bestand des Betreibers. Ohne diese Zeile startete der Worker ohne jede
  // Zugangsdaten und das SDK brach mit "No default model selected" ab; genau
  // das war der gemessene Erstlauf (siehe docs/plans/tenant-isolation.md §13).
  const providers = tenantProviders(identity);
  const acquired = await host.acquire(identity, () => startTenantWorker(identity, {
    bunPath,
    repoRoot: repositoryRoot,
    providers,
  }));
  if ("ok" in acquired && acquired.ok === false) {
    return acquired;
  }
  const worker = acquired as TenantWorker;
  host.touch(identity.username);
  try {
    const session = await createWorkerBackedSession({
      worker,
      identity,
      sessionDir: tenantArchiveDir(identity) ?? join(getUserHome(identity), ".omp", "agent", "sessions"),
      hostCwd: start.cwd,
      // Eine bestehende Session wird geoeffnet, eine neue entsteht im Worker.
      ...(start.sessionFile ? { sessionFile: start.sessionFile } : {}),
    });
    // Ein Bus, der nichts abonniert: die Frames kommen aus dem Worker ueber
    // `client.onEvent`, und der Wrapper haengt sich mit `session.subscribe`
    // daran. Der Subagent-Bus bleibt damit leer — Subagenten laufen im Worker.
    //
    // `EventBus` des SDK und kein `node:events`-Emitter: der Wrapper gibt den
    // Bus an `RpcSubagentRegistry`, und dessen `dispose()` ruft die Rueckgabe
    // von `.on()` als Abmeldefunktion auf. Beim Emitter ist das der Emitter
    // selbst — gemessen am 2026-11-09 warf `wrapper.destroy()` damit
    // `TypeError: unsubscribe is not a function`, und zwar in genau dem Pfad,
    // der einen abgeraeumten Worker ersetzen soll: statt des Neustarts kam ein
    // 500 aus dem Aufraeumen.
    const eventBus = new EventBus() as unknown as ConstructorParameters<typeof AgentSessionWrapper>[1];
    return { ok: true, session, eventBus };
  } catch (error) {
    // Eine halb aufgebaute Session darf nicht im Registry landen: der Worker
    // bleibt, aber ohne Session. Der naechste Request baut neu auf.
    return {
      ok: false,
      reason: "tenant-worker-crashed",
      detail: `The worker for ${identity.username} is running but its session could not be attached: ${String(error)}`,
      remediation: "Retry the request; if it repeats, restart the service so the worker is respawned.",
    };
  }
}

/**
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), omp generates its own id.
 * New sessions resolve enabledModels before construction so the initial model,
 * thinking pin, and SDK scopedModels share one settings snapshot.
 * Pass options.toolNames to pre-configure active tools (empty = all disabled).
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string | undefined,
  options: RpcSessionStartOptions = {},
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const { toolNames, initialModel, thinkingLevel } = options;
  const registry = getRegistry();
  const locks = getLocks();

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };
  if (existing) {
    // Ein toter Wrapper bleibt sonst in der Registry stehen, und
    // `getRpcSession(id)` liefert ihn weiter aus: `GET /api/agent/<id>` und
    // `GET /api/sessions/<id>/state` antworten dann `{running:false}`, was
    // stimmt, aber `POST /api/agent/<id>` landet im Fast-Path und scheitert an
    // der geschlossenen Pipe. Gemessen am 2026-11-09: drei Requests
    // hintereinander 500 `Client not started`, dauerhaft.
    //
    // `destroy` ist idempotent (`if (!this._alive) return`) und schliesst den
    // Bus ab; die Session wird im naechsten Schritt aus ihrem Archiv neu
    // aufgebaut, mit derselben Id. Dass dieser Aufruf fuer eine Worker-Session
    // nicht wirft, haengt an dem `EventBus` aus `startWorkerSessionForTenant`:
    // mit einem `node:events`-Emitter warf `destroy` hier
    // `TypeError: unsubscribe is not a function` (gemessen am 2026-11-09), und
    // der Neustart endete in einem 500 aus dem Aufraeumen statt in einer
    // wiederhergestellten Session.
    existing.destroy();
    if (registry.get(sessionId) === existing) registry.delete(sessionId);
  }

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  const starting = (async () => {
    // Some extensions access the SDK's global theme even outside the terminal UI.
    await initTheme(false);
    // The agent directory stays the process directory, deliberately.
    //
    // omp's skill loader reads `getAgentDir()` from process state and ignores
    // the `agentDir` passed to `createAgentSession` (`discoverSkills(cwd,
    // _agentDir)` — the parameter is unused). Passing a tenant directory would
    // therefore not move the skills, but it *would* move credentials, memory
    // and the session-index database, and a tenant with an empty `agent.db`
    // and no `models.yml` cannot resolve a model. Measured in
    // `AGENTDIR-SCAN.md` §0/§5.
    //
    // What does move is the Settings instance: `skills.customDirectories` is
    // read from it, and the cache in `getSettingsForIdentity` is keyed by
    // agent directory. That is the one change that makes a tenant's skills
    // visible without splitting history from credentials.
    const identity = options.identity ?? null;

    // ==========================================================================
    // Die Grenze: ein Mandant bekommt einen Workerprozess, ein Admin nicht.
    //
    // Der Schnitt steht **vor** jedem SDK-Aufbau. Das ist der Punkt, an dem er
    // wirkt: `createAgentSession` legt den `bash` (eine native Bibliothek) und
    // die `read`/`write`-Werkzeuge in *diesen* Prozess. Ein Haken nach dem
    // Aufbau waere zu spaet — die `fs`-Aufrufe sind dann schon hier verankert.
    //
    // Was hier **nicht** passiert: ein stiller Rueckfall. `tenantBoundaryPolicy`
    // kennt genau zwei Wege in den Serverprozess (kein Mandant, oder der
    // Betreiber hat den Ausstieg gesetzt); alles andere geht in einen Worker,
    // und ein fehlgeschlagener Plan ist ein benannter Fehler mit `reason` und
    // `remediation`. Ein Mandant, der wegen eines kaputten Plans still im
    // Serverprozess landet, waere die schlimmste Variante: gruen im Test,
    // offen im Betrieb.
    // ==========================================================================
    const policy = tenantBoundaryPolicy(identity);
    if (policy.mode === "worker" && identity !== null) {
      const workerSession = await startWorkerSessionForTenant({
        identity,
        cwd: cwd ?? getUserHome(identity),
        sessionFile,
        sessionId,
        options,
      });
      if (!workerSession.ok) {
        // Der Wurf traegt die drei Felder der Abnahmetabelle A5: was fehlt,
        // warum, und was zu tun ist. Die Route macht daraus einen Fehlerkoerper.
        throw new TenantBoundaryError(workerSession);
      }
      const wrapper = new AgentSessionWrapper(workerSession.session, workerSession.eventBus);
      wrapper.setIdentity(identity);
      wrapper.start();
      const realSessionId = workerSession.session.sessionId;
      const realSessionFile = workerSession.session.sessionFile;
      // Der Schluessel, unter dem diese Session erreichbar ist.
      //
      // Fuer eine **bestehende** Session ist das die Id des Aufrufers, nicht die
      // Id, die der Worker gerade meldet. Gemessen am 2026-11-09: ein neu
      // angelegtes Mandanten-Archiv traegt in seiner Kopfzeile eine andere Id als
      // die, unter der der Wrapper laeuft — die Datei legt der Server an
      // (`SessionManager.open`, siehe `tenant-worker-session.ts`), und der Worker
      // uebernimmt beim Oeffnen die Kopfzeilen-Id. Nach einem Reap meldete der
      // frische Worker deshalb eine **andere** Id; wurde der Wrapper darunter
      // registriert, fand der naechste Request `/api/agent/<alte Id>` nichts mehr,
      // baute die Session ein zweites Mal auf und hinterliess bei jedem Request
      // einen weiteren Wrapper im Registry — ein Leck und doppelte Eintraege in
      // der Session-Liste. Unter der aufrufenden Id registriert bleibt dieselbe
      // Session unter derselben Id bedienbar.
      //
      // Eine **neue** Session (`sessionFile === ""`) hat noch keine Id, die der
      // Aufrufer kennen koennte: dort bleibt es bei der Id des Workers, die
      // `/api/agent/new` an den Client zurueckgibt.
      //
      // Genau **ein** Schluessel pro Session, und zwar die Id, unter der der
      // Aufrufer sie addressiert. Die vom Worker gemeldete Id wird bewusst nicht
      // zusaetzlich eingetragen — `getRpcSessionInfos` laeuft ueber die Registry,
      // und ein zweiter Schluessel auf denselben Wrapper haette dieselbe Session
      // zweimal in der Liste gezeigt.
      const handle = sessionFile === "" ? realSessionId : sessionId;
      if (realSessionFile) cacheSessionPath(handle, realSessionFile);
      wrapper.onDestroy(() => {
        if (registry.get(handle) === wrapper) registry.delete(handle);
        forgetSessionOwner(handle);
      });
      registry.set(handle, wrapper);
      setSessionOwner(handle, options.owner ?? "");
      return { session: wrapper, realSessionId: handle };
    }
    if (policy.mode === "in-process" && policy.reason === "opted-out") {
      // Einmal pro Serverstart, nicht pro Anfrage: die Warnung ist ein
      // Betriebszustand, kein Ereignis.
      logUnsandboxedTenantWarningOnce();
    }
    const agentDir = getAgentDir();
    if (identity) {
      // Idempotent registration; also creates the tenant's skills directory.
      // A broken/unwritable config must not stop the session from starting:
      // the user loses skill visibility, not the chat.
      try {
        await ensureTenantSkillsRegistration(identity);
      } catch { /* the session still runs; the manager reports the problem */ }
    }
    // Das Session-**Archiv** eines Mandanten liegt in seinem Agent-Verzeichnis
    // (`lib/tenant-sessions.ts`), auch wenn das Agent-Verzeichnis dieser Session
    // aus den oben genannten Gruenden das Prozessverzeichnis bleibt. Diese
    // beiden Pfade sind unabhaengig: der Agent-Ordner traegt `agent.db`,
    // `models.yml` und die Einstellungen, das Archiv nur die `.jsonl`-Journale.
    // Fuer einen Admin und fuer den internen Start ohne Konto ist der Ausdruck
    // `undefined` — genau das bisherige Verhalten.
    const sessionDir = cwd === undefined ? null : prepareTenantSessionDir(identity, cwd);
    const sessionManager = sessionFile
      ? await SessionManager.open(sessionFile, undefined)
      : (() => {
        if (!cwd) throw new Error("cwd is required for a new session");
        return SessionManager.create(cwd, sessionDir ?? undefined);
      })();
    const sessionCwd = sessionManager.getCwd();
    const finishStartingSession = trackStartingSession(sessionCwd);

    try {
      const runtime = await getOmpRuntime();
      const settings = await getSettingsForIdentity(identity, sessionCwd);

      // Determine which tools to pass based on requested toolNames.
      let toolsOption: string[] | undefined;
      if (toolNames !== undefined) {
        // toolNames === [] -> "all off" (an empty allow-list disables every tool).
        // Otherwise DO NOT pass a builtin-only allow-list: passing CODING_TOOL_NAMES
        // set allowedToolNames to coding builtins only, which filtered every
        // extension/package-provided tool (e.g. subagents, web access) out of the
        // tool registry — so they were unavailable in omp-web sessions even though the
        // `omp` CLI keeps them. Leaving the allow-list unset lets the SDK register all
        // tools (and activate extension tools); we narrow the ACTIVE set below.
        toolsOption = toolNames.length === 0 ? [] : undefined;
      }

      // One policy decides what this identity loads (`lib/load-policy.ts`): a
      // tenant does not inherit the operator's authoring store, and an untrusted
      // project ships nothing from inside it — code only from the roots omp
      // scans for this account. The returned options are the pre-built lists
      // `createAgentSession` accepts; anything the policy did not have to filter
      // stays absent so omp keeps its normal discovery path.
      const loads = await resolveSessionLoads(identity, sessionCwd, settings);

      // Skills are prompt text, not modules, so they cannot be dropped by
      // filtering paths — but an untrusted repository must not inject
      // instructions either. `trustedProjectSkills` keeps the non-project
      // sources; it returns the discovered list untouched for a trusted
      // project, and omp's own discovery path stays in charge there.
      // The same helper feeds `GET /api/skills`, so the panel and the session
      // cannot disagree about which skills exist. (Rule 1 of the load policy
      // does not apply to skills: the operator's installed skills stay, the
      // v0.20.0 decision.)
      const sessionSkills = loads.narrowed
        ? (await loadSessionSkills(sessionCwd, settings)).skills
        : undefined;

      // `SYSTEM.md` / `APPEND_SYSTEM.md`, resolved against this session's cwd the
      // way the CLI resolves them against its own (lib/session-system-prompt.ts),
      // and only from the roots this identity owns.
      const systemPrompts = loads.systemPrompts;

      const { modelRegistry } = runtime;
      const scope = await resolveVisibleModels(modelRegistry, cfgEnabledModels.get(settings), settings);
      const defaultRole = readDefaultModelRole(settings);
      const hasExistingMessages = sessionManager.buildSessionContext().messages.length > 0;
      const initial = hasExistingMessages
        ? { scopedModels: [...scope.scopedModels], model: undefined, thinkingLevel: undefined }
        : selectInitialModelScope(scope, {
          ...(initialModel ? { requestedModel: initialModel } : {}),
          ...(defaultRole ? { defaultModel: defaultRole } : {}),
          ...(thinkingLevel ? { thinkingLevel } : {}),
        });
      const sessionOptions: CreateAgentSessionOptions = {
        cwd: sessionCwd,
        // A unique registry key per root; see `rootAgentId`.
        agentId: rootAgentId(sessionId),
        agentDir,
        // Same instance unless a tenant needs the pins (`sessionSettings`); the
        // parent keeps the writes, so preferences still land in this account's
        // `config.yml` and the panel keeps editing the real store.
        settings: sessionSettings(identity, settings),
        sessionManager,
        modelRegistry,
        hasUI: true,
        ...(initial.model ? { model: initial.model } : {}),
        ...(initial.thinkingLevel ? { thinkingLevel: initial.thinkingLevel } : {}),
        ...(initial.scopedModels.length > 0 ? { scopedModels: initial.scopedModels } : {}),
        // `present_files` is a core capability of this UI, not an opt-in: the
        // card component is wired in `components/MessageView.tsx`, so a session
        // without the tool cannot show anything. Registered natively (same
        // `customTools` slot `pi-web-ui` uses for its own copy) instead of via a
        // discovered `.omp/extensions` file, so it cannot be dropped by project
        // trust gating or by a session started before the extension existed.
        //
        // `calendar_read` und `calendar_write` sind aus demselben Grund
        // nativ: der Kalender gehoert dem *Konto*, nicht dem Projekt. Eine
        // Datei unter `.omp/extensions` waere vom Projekt abhaengig — und
        // damit vom Vertrauen in dieses Projekt (`lib/project-trust.ts`),
        // waehrend der Kalender an der Identitaet haengt, die diese Sitzung
        // geoeffnet hat.
        customTools: [makePresentFilesTool(), ...makeCalendarTools({ identity: options.identity })],
        // Die zweite Schneide. Die eigentliche Grenze fuer ein Nicht-Admin-Konto
        // ist der Worker-Prozess (`lib/tenant-worker.ts`): was dort nicht
        // gebunden ist, existiert nicht. Dieser Haken bleibt trotzdem, weil er
        // nichts kostet und weil er der einzige ist, wenn der Betreiber
        // `OMP_WEB_ALLOW_UNSANDBOXED_TENANT=1` setzt. Das SDK sandboxt seinen
        // Shell nicht (§5 des Scans), aber ein `tool_call`-Haken darf blocken —
        // und `extensions` wird pro Sitzung gebunden, Subagenten erben die
        // Fabrik. Ohne Identitaet ist die Sitzung intern (kein Konto), dann
        // bleibt es beim bisherigen Verhalten.
        ...(options.identity ? { extensions: [makeSessionShellGuard(options.identity)] } : {}),
        // `restrictToolNames` drops `customTools` entirely unless this is set —
        // the SDK filters `options.customTools` to `[]` when a session is
        // restricted and this is not true (see `allowRestrictedCustomTools` in
        // sdk.ts). Without it the "all tools off" preset would un-register
        // `present_files` instead of merely deactivating it.
        ...(toolsOption !== undefined
          ? { toolNames: toolsOption, restrictToolNames: true, allowRestrictedCustomTools: true }
          : {}),
        // The load policy's pre-built lists, MCP switch and project gate
        // (`lib/load-policy.ts`). Keys it did not have to filter are absent, so
        // omp's own discovery stays in charge exactly as before.
        ...loads.options,
        // Project skills follow project trust (`lib/project-trust.ts`): a
        // repository the user merely opened must not write into the system
        // prompt. `undefined` keeps omp's own discovery path, so a trusted
        // project loads exactly what the CLI loads.
        ...(sessionSkills ? { skills: sessionSkills } : {}),
      };
      // omp's own applier, so a prompt file goes through the same templates the
      // CLI renders it with instead of overwriting the whole system prompt.
      applyResolvedSystemPromptInputs(sessionOptions, systemPrompts.systemPrompt, systemPrompts.appendPrompt);
      const { session: inner, eventBus, subagentEventBus, setToolUIContext } = await createAgentSession(sessionOptions);

      const persistedPreferences = await persistExplicitStartupPreferences(
        settings,
        {
          ...(initialModel ? { model: initialModel } : {}),
          ...(thinkingLevel ? { thinkingLevel } : {}),
        },
        {
          ...(inner.model
            ? { model: { provider: inner.model.provider, modelId: inner.model.id } }
            : {}),
          thinkingLevel: inner.thinkingLevel ?? "off",
          supportsThinking: Boolean(inner.model?.reasoning),
        },
      );
      if (persistedPreferences.modelDefaultChanged) invalidateModelsCache();

      // `loads.diagnostics` carries one `info` line per load the policy removed
      // entries from; the panel shows the same list through `/api/skills`, and
      // the server log records it here so a session that silently lost its rules
      // is visible in the deployment as well.
      for (const diagnostic of loads.diagnostics) console.warn(`[load-policy] ${diagnostic.message}`);

      const session = inner as unknown as AgentSessionLike;

      // A refresh (`refreshSkillsAndCommands`) re-discovers slash commands from
      // the process roots and knows nothing about a pre-built list
      // (`agent-session.ts:7122`), so the operator's commands came back the
      // moment a discovery setting changed (`LOAD-LEVEL-SCAN.md` §8a).
      // `subscribeCommandMetadataChanged` fires right after that reload and
      // `setSlashCommands` is public, so the same filter runs again: the list is
      // the filtered one for the life of the session, whichever setting change
      // triggered the reload.
      if (loads.filterCommands) {
        const filterCommands = loads.filterCommands;
        session.subscribeCommandMetadataChanged?.(() => {
          session.setSlashCommands?.(filterCommands(session.slashCommands ?? []));
        });
      }

      // If specific tool names were requested (non-empty), set the active tools to the
      // requested builtin coding tools PLUS all extension/package tools, so installed
      // extensions stay usable in omp-web just like in the `omp` CLI.
      if (toolNames && toolNames.length > 0) {
        await session.setActiveToolsByName(withExtensionTools(session, toolNames));
      }

      // Nested subagents emit their lifecycle/progress frames on the root-scoped
      // `subagentEventBus` (omp's own RPC mode subscribes it, rpc-mode.ts:1507);
      // a registry bound to the session-local `eventBus` never sees a grandchild.
      const wrapper = new AgentSessionWrapper(session, subagentEventBus ?? eventBus);
      wrapper.setIdentity(identity);
      wrapper.bindToolUiContext(
        setToolUIContext as unknown as (uiContext: ExtensionUiContextLike, hasUI: boolean) => void,
      );
      // When all tools are disabled, clear the system prompt entirely.
      // omp's buildSystemPrompt always produces a non-empty prompt even with no
      // tools; keep this forced after extension discovery and reloads as well.
      if (toolNames?.length === 0) {
        wrapper.setForceEmptySystemPrompt(true);
      }
      wrapper.start();

      const realSessionId = inner.sessionId as string;
      const realSessionFile = inner.sessionFile as string | undefined;
      if (realSessionFile) {
        cacheSessionPath(realSessionId, realSessionFile);
        // Das SDK legt die `.jsonl` mit `O_CREAT` und der umask des Prozesses
        // an — gemessen `0644`. Der Pfad allein ist die Grenze, der Modus ist
        // die zweite Haelfte, deshalb wird hier nachgezogen. Nur fuer den
        // Mandanten-Baum: das Prozess-Archiv des Admins bleibt unveraendert.
        const tenantRoot = tenantSessionsRoot(identity);
        if (tenantRoot !== null && realSessionFile.startsWith(`${tenantRoot}/`)) {
          tightenTenantSessionTree(realSessionFile.slice(0, realSessionFile.lastIndexOf("/")));
        }
      }

      wrapper.onDestroy(() => {
        registry.delete(realSessionId);
        forgetSessionOwner(realSessionId);
      });
      registry.set(realSessionId, wrapper);
      // Der Besitz wird genau hier vergeben, in derselben Zeile, in der die
      // Session sichtbar wird. Der Leerstring ist der Marker fuer "unbeansprucht":
      // er wird bewusst geschrieben statt eines `if (owner)`, damit eine Session,
      // die unter derselben Id neu registriert wird, keinen Besitzer aus ihrer
      // Vorgaengerin erbt. Ein unbeanspruchter Besitz passt zu keinem
      // Benutzernamen, also ist die Session fuer niemanden sichtbar — die
      // Fehlrichtung, in der ein vergessenes Argument nicht still durchfaellt.
      setSessionOwner(realSessionId, options.owner ?? "");
      wrapper.beginExtensionBinding({ forceEmptySystemPrompt: toolNames?.length === 0 });

      return { session: wrapper, realSessionId };
    } finally {
      finishStartingSession();
    }
  })().finally(() => {
    locks.delete(sessionId);
  });

  locks.set(sessionId, starting);
  return starting;
}
