/**
 * Per-run budget for one agent session.
 *
 * The SDK's CostGate only refuses a request when `session.maxCost` is set, and
 * omp-web never sets it (the `CreateAgentSessionOptions` in `rpc-manager.ts`
 * carry neither `costGate` nor `deadline`), so an accepted prompt had no bound
 * on its tool loop. This is the application-level bound: it counts the
 * session's own model requests, adds a wall-clock ceiling for a model that
 * streams forever without starting another request, and lets the wrapper end
 * the run through the same abort path the browser's `abort` command uses.
 * The wrapper keeps one instance per prompt run and one per goal lifetime, so
 * a goal's continuation chain cannot reset the bound.
 */

export type RunBudgetLimits = {
  /** Model requests allowed in one run. The next request frame ends the run. */
  maxRequests: number;
  /** Wall-clock ceiling for one run, armed when the run starts. */
  maxWallClockMs: number;
};

/**
 * A long legitimate agentic turn is a few dozen model requests; 400 leaves an
 * order of magnitude of headroom while a looping model passes it within
 * minutes. 45 minutes is 4.5x the 10-minute idle window in `rpc-manager.ts`,
 * so normal work never reaches it, but a run that streams or tool-calls
 * without pause ends. Both dimensions are per run, not per account.
 */
export const DEFAULT_RUN_BUDGET_LIMITS: RunBudgetLimits = {
  maxRequests: 400,
  maxWallClockMs: 45 * 60 * 1000,
};

export type RunBudgetExhaustion = "requests" | "wall-clock";

export class SessionRunBudget {
  readonly limits: RunBudgetLimits;
  #onExhausted: (reason: RunBudgetExhaustion) => void;
  #requests = 0;
  /** 0 while no run is active; monotonically increasing so old tokens stay stale. */
  #runToken = 0;
  #lastToken = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    onExhausted: (reason: RunBudgetExhaustion) => void,
    limits: RunBudgetLimits = DEFAULT_RUN_BUDGET_LIMITS,
  ) {
    this.#onExhausted = onExhausted;
    this.limits = limits;
  }

  get active(): boolean {
    return this.#runToken !== 0;
  }

  get requests(): number {
    return this.#requests;
  }

  /**
   * Start a fresh run and return the token {@link end} needs. A run that is
   * still active is discarded: callers only call this where the SDK starts a
   * new prompt run, never for a steer or follow-up inside one.
   */
  begin(): number {
    this.end();
    this.#lastToken += 1;
    this.#runToken = this.#lastToken;
    this.#requests = 0;
    this.#timer = setTimeout(() => this.#exhaust("wall-clock"), this.limits.maxWallClockMs);
    // A budget timer must not keep an otherwise idle process alive.
    this.#timer.unref?.();
    return this.#runToken;
  }

  /** Count one model request; exactly `maxRequests` of them are allowed. */
  noteRequest(): void {
    if (!this.active) return;
    this.#requests += 1;
    if (this.#requests > this.limits.maxRequests) this.#exhaust("requests");
  }

  /** End the run `token` was issued for; a stale token is ignored. */
  end(token?: number): void {
    if (token !== undefined && token !== this.#runToken) return;
    this.#runToken = 0;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #exhaust(reason: RunBudgetExhaustion): void {
    // A timer that fired in the same tick as `end()`, or a second frame after
    // the counter already ended the run, must not abort twice.
    if (!this.active) return;
    this.end();
    this.#onExhausted(reason);
  }
}
