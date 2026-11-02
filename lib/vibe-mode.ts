import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import type { VibeOwnerScope, VibeParentSession } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import type { VibeCommandResult, VibeStatusInfo } from "./omp-types";

export type { VibeCommandResult, VibeStatusInfo } from "./omp-types";

const COMMAND_ACTIONS: Record<string, "on" | "off" | "status"> = {
  on: "on",
  start: "on",
  enter: "on",
  off: "off",
  exit: "off",
  stop: "off",
  status: "status",
};

/** What `VibeModeController` needs from a session; `AgentSessionLike` satisfies it. */
export interface VibeModeSession {
  isStreaming: boolean;
  sessionManager: {
    appendModeChange(mode: string, data?: Record<string, unknown>): string;
    getEntries(): readonly unknown[];
    getSessionId(): string;
    getSessionFile(): string | null | undefined;
    /** Branch-resolved mode; absent on narrowed/older managers, then the ledger is read. */
    buildSessionContext?(): { mode?: string; modeData?: Record<string, unknown> };
  };
  settings: unknown;
  asyncJobManager?: unknown;
  getAgentId?(): string | null;
  getActiveModelString?(): string | undefined;
  getEnabledToolNames(): string[];
  hasBuiltInTool?(name: string): boolean;
  activateVibeTools(base: string[]): Promise<void>;
  deactivateVibeTools(next: string[]): Promise<void>;
  getVibeModeState?(): { enabled: boolean } | undefined;
  setVibeModeState?(state: { enabled: boolean } | undefined): void;
  sendVibeModeContext?(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void>;
  runModeExitTeardown?(teardown: () => Promise<void>): Promise<void>;
  abort(): Promise<void>;
}

/** The registry surface the controller drives; narrowed so tests can pass a stub. */
type VibeRegistry = Pick<
  VibeSessionRegistry,
  "ownerScope" | "activateScope" | "listIds" | "rehydrate" | "killAll"
>;

export interface VibeModeControllerOptions {
  onStatus?: (status: VibeStatusInfo | null) => void;
  /** Why the mode may not start here (plan mode, goal mode); the wrapper knows. */
  conflicts?: () => string | undefined;
  /** Tests pass a stub so nothing touches the process-global worker registry. */
  registry?: VibeRegistry;
}

/** Split `/vibe [on|off|status] [task]`; free text starts the mode with a task. */
export function parseVibeCommand(args: string): { action: "toggle" | "on" | "off" | "status"; prompt?: string } {
  const trimmed = args.trim();
  if (!trimmed) return { action: "toggle" };
  const first = /^(\S+)/.exec(trimmed)?.[1].toLowerCase() ?? trimmed;
  // hasOwnProperty: a task word like "constructor" must not read the prototype as a command.
  if (!Object.prototype.hasOwnProperty.call(COMMAND_ACTIONS, first)) return { action: "on", prompt: trimmed };
  return { action: COMMAND_ACTIONS[first] };
}

/** Tool names as they were before vibe mode; all-or-nothing — a partly invalid record means "snapshot the live set". */
function persistedToolNames(data: unknown): string[] | undefined {
  const names = (data as { previousTools?: unknown } | undefined)?.previousTools;
  if (!Array.isArray(names) || !names.every((name) => typeof name === "string")) return undefined;
  return names;
}

/**
 * The half of omp's vibe mode that does not belong to the TUI.
 *
 * omp exposes `/vibe` only as an `InteractiveMode` method, so the browser used
 * to forward it to the model as text. This drives the same `AgentSession` and
 * the same SDK worker registry the TUI drives, so workers and the mode survive
 * moving between the two.
 */
export class VibeModeController {
  #session: VibeModeSession;
  #options: VibeModeControllerOptions;
  /** Tool set to restore on exit; also marks "we entered the mode". */
  #previousTools: string[] | undefined;
  #scope: VibeOwnerScope | undefined;
  /** Entry in flight; a concurrent `/vibe` joins it instead of re-snapshotting the reduced toolset. */
  #entry: Promise<void> | undefined;
  #pending = false;
  #restorePromise: Promise<void> | undefined;

  constructor(session: VibeModeSession, options: VibeModeControllerOptions = {}) {
    this.#session = session;
    this.#options = options;
  }

  getStatus(): VibeStatusInfo | null {
    if (!this.#enabled()) return null;
    let workers = 0;
    try {
      workers = this.#registry().listIds(this.#parent() as never).length;
    } catch {
      // An unreadable roster is a display problem, not a reason to hide the mode.
      workers = 0;
    }
    return { enabled: true, workers };
  }

  /**
   * True while an entry is in flight. A tool-set change must be refused on
   * `getStatus()?.enabled || isPending()`: the SDK applies tool mutations FIFO,
   * so one that passes the enabled gate mid-entry lands after the activation.
   */
  isPending(): boolean {
    return this.#pending;
  }

  /** Re-attach to a mode persisted by an earlier run of this session. */
  restore(): Promise<void> {
    // Memoize success only: a failed restore must be retryable by the next command.
    this.#restorePromise ??= this.#restore().catch((error: unknown) => {
      this.#restorePromise = undefined;
      throw error;
    });
    return this.#restorePromise;
  }

  /** Dispatch `/vibe [on|off|status] [task]`. */
  async handleCommand(args: string): Promise<VibeCommandResult> {
    // A mode persisted by an earlier run is restored at attach; act on the
    // settled state, not a half-restored one.
    await this.restore().catch(() => {});

    // A command typed during a slow entry must judge the settled state: an
    // `/vibe off` that reads "not enabled" mid-entry would leave the user in.
    await this.#entry?.catch(() => {});

    const { action, prompt } = parseVibeCommand(args);
    // Conflicts gate entry only: whoever is inside the mode must always get out.
    if (action === "off") return await this.#exit();
    if (action === "status") return this.#report();
    if (action === "toggle" && this.#enabled()) return await this.#exit();
    const conflict = this.#options.conflicts?.();
    if (conflict) return this.#fail(conflict);
    return await this.#enter(prompt);
  }

  async #restore(): Promise<void> {
    if (this.#enabled()) return;
    const context = this.#modeContext();
    if (context.mode !== "vibe") return;
    await this.#registry().rehydrate(this.#parent());
    await this.#enter(undefined, { previousTools: persistedToolNames(context.modeData), persist: false });
  }

  /**
   * The mode at the active branch leaf. The ledger is flat, and `navigate_tree`
   * can leave a branch the flat scan would resurrect, so the manager's own
   * branch-resolved context wins where it exists.
   */
  #modeContext(): { mode?: string; modeData?: unknown } {
    const manager = this.#session.sessionManager;
    if (manager.buildSessionContext) {
      const context = manager.buildSessionContext();
      return { mode: context.mode, modeData: context.modeData };
    }
    const mode = this.#latestModeChange();
    return { mode: mode?.mode, modeData: mode?.data };
  }

  async #enter(prompt?: string, options?: { previousTools?: string[]; persist?: boolean }): Promise<VibeCommandResult> {
    if (this.#entry) {
      // Joining a live entry (the TUI keeps `#vibeModeEntry` for the same reason).
      await this.#entry;
    } else if (!this.#enabled()) {
      const live = this.#session.getEnabledToolNames();
      // An empty snapshot (persisted or live) is never meaningful: exiting into
      // a tool-less session cannot be undone, so a persisted `[]` counts as unset.
      const previousTools = options?.previousTools?.length ? options.previousTools : live;
      if (previousTools.length === 0) return this.#fail("Enable tools before entering vibe mode.");
      // Without a mode state there is nothing to hold the flag: refuse before
      // the toolset shrinks, or the session is stuck read-only and shows no mode.
      if (!this.#session.setVibeModeState) return this.#fail("This session cannot enter vibe mode.");
      this.#pending = true;
      const entry = this.#activate(previousTools, options);
      this.#entry = entry;
      try {
        await entry;
      } finally {
        this.#pending = false;
        if (this.#entry === entry) this.#entry = undefined;
      }
    }
    return { message: "Vibe mode enabled. Toolset is read + vibe tools.", prompt, status: this.getStatus() };
  }

  async #activate(previousTools: string[], options?: { persist?: boolean }): Promise<void> {
    const base = ["read"];
    if (this.#session.hasBuiltInTool?.("todo")) base.push("todo");

    const registry = this.#registry();
    const scope = registry.ownerScope(this.#parent());
    registry.activateScope(scope);
    await this.#session.activateVibeTools(base);
    this.#previousTools = previousTools;
    this.#scope = scope;
    this.#session.setVibeModeState?.({ enabled: true });
    if (options?.persist !== false) {
      this.#session.sessionManager.appendModeChange("vibe", { previousTools });
    }
    if (this.#session.isStreaming) await this.#session.sendVibeModeContext?.({ deliverAs: "steer" });
    this.#notify();
  }

  async #exit(): Promise<VibeCommandResult> {
    if (!this.#enabled()) return { message: "Vibe mode is not enabled.", status: null };

    const parent = this.#parent();
    const registry = this.#registry();
    const scope = this.#scope ?? registry.ownerScope(parent);
    const previousTools = this.#previousTools;
    let killed = 0;
    // Suppress the queued-message drain while aborting: a queued steer would
    // otherwise restart on the still-live vibe toolset (same reason as the TUI).
    const teardown = async () => {
      if (this.#session.isStreaming) await this.#session.abort();
      killed = await registry.killAll(parent, scope);
      await this.#session.deactivateVibeTools(previousTools ?? []);
      this.#session.setVibeModeState?.(undefined);
    };
    if (this.#session.runModeExitTeardown) await this.#session.runModeExitTeardown(teardown);
    else await teardown();

    this.#previousTools = undefined;
    this.#scope = undefined;
    // No "none" here: killAll owns that write (atomically with the tombstones,
    // and its zero-record path already leaves the ledger on "none").
    this.#notify();
    return {
      message:
        killed > 0
          ? `Vibe mode disabled. Killed ${killed} worker session${killed === 1 ? "" : "s"}.`
          : "Vibe mode disabled.",
      status: this.getStatus(),
    };
  }

  #report(prompt?: string): VibeCommandResult {
    const status = this.getStatus();
    if (!status) return { message: "Vibe mode is not enabled.", prompt, status };
    return {
      message: `Vibe mode enabled. ${status.workers} worker session${status.workers === 1 ? "" : "s"} active.`,
      prompt,
      status,
    };
  }

  #fail(error: string): VibeCommandResult {
    return { error, status: this.getStatus() };
  }

  #enabled(): boolean {
    return this.#session.getVibeModeState?.()?.enabled === true;
  }

  #registry(): VibeRegistry {
    return this.#options.registry ?? VibeSessionRegistry.global();
  }

  #parent(): VibeParentSession {
    return {
      getAgentId: () => this.#session.getAgentId?.() ?? null,
      getSessionId: () => this.#session.sessionManager.getSessionId(),
      getSessionFile: () => this.#session.sessionManager.getSessionFile() ?? null,
      // The browser exposes the full SessionManager; this structural view is narrower.
      sessionManager: this.#session.sessionManager as unknown as VibeParentSession["sessionManager"],
      asyncJobManager: this.#session.asyncJobManager as VibeParentSession["asyncJobManager"],
      settings: this.#session.settings as VibeParentSession["settings"],
      getActiveModelString: () => this.#session.getActiveModelString?.(),
    };
  }

  #latestModeChange(): { mode?: string; data?: unknown } | undefined {
    const entries = this.#session.sessionManager.getEntries() as Array<{
      type?: string;
      mode?: string;
      data?: unknown;
    }>;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index]?.type === "mode_change") return entries[index];
    }
    return undefined;
  }

  #notify(): void {
    this.#options.onStatus?.(this.getStatus());
  }
}
