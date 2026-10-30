// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

export class AgentCommandError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly accepted?: boolean,
  ) {
    super(message);
    this.name = "AgentCommandError";
  }
}

export function isPromptRejectedError(error: unknown): error is AgentCommandError {
  return error instanceof AgentCommandError
    && error.code === "prompt_rejected"
    && error.accepted === false;
}

// The declarations below are the client half of upstream's runtime-session
// identity work (PR #134): a request may be addressed by a live runtime handle
// while the session's persisted id is only resolved later. Nothing in omp-web
// uses them yet — `sendAgentCommand` still addresses sessions by id — so they
// are carried as the precondition for that port, not as active behaviour.
export interface SessionIdentity {
  sessionId: string;
  runtimeId: string | null;
}

export interface RuntimeSessionBinding {
  current: string | null;
  onIdentity?: (identity: SessionIdentity, request: SessionIdentity) => boolean | void;
}

/** Accept a response only while its request still owns the selected identity. */
export function canApplySessionIdentity(current: SessionIdentity, identity: SessionIdentity, request: SessionIdentity): boolean {
  return (current.sessionId === identity.sessionId && current.runtimeId === identity.runtimeId)
    || (current.runtimeId === request.runtimeId
      && (current.sessionId === request.sessionId || current.sessionId === identity.sessionId));
}

/**
 * Wait this long for a command's HTTP answer, unless the caller says otherwise.
 *
 * `null` — the default — waits as long as the server takes. That is right for
 * `prompt`: the route answers immediately and the turn itself streams over SSE,
 * so a limit here would only ever cut a running turn.
 *
 * A caller that is waiting on the server's own work passes a limit. `set_model`
 * is that case: the SDK re-renders the archive and rebuilds the system prompt
 * inside the request, and a cold session is started inside it (see
 * `app/api/agent/[id]/route.ts`). Without a limit a hung POST keeps the
 * composer's model control disabled for as long as the server takes.
 */
export const AGENT_COMMAND_TIMEOUT_MS: number | null = null;

export class AgentCommandTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`No answer within ${Math.round(timeoutMs / 1000)} s`);
    this.name = "AgentCommandTimeoutError";
  }
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
  options: { timeoutMs?: number | null } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs === undefined ? AGENT_COMMAND_TIMEOUT_MS : options.timeoutMs;
  const controller = new AbortController();
  let timedOut = false;
  // Ohne Timeout gibt es keinen Timer, und `clearTimeout(null)` nimmt der
  // DOM-Typ nicht an — deshalb `undefined` statt `null` fuer den Leerwert.
  const timer = timeoutMs === null
    ? undefined
    : setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

  try {
    const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
      ...(timer ? { signal: controller.signal } : {}),
    });
    const body = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      data?: T;
      error?: string;
      code?: string;
      accepted?: boolean;
    };
    if (!res.ok || body.error) {
      throw new AgentCommandError(
        body.error ?? `HTTP ${res.status}`,
        res.status,
        body.code,
        body.accepted,
      );
    }
    return body.data as T;
  } catch (error) {
    // Der Abbruch kommt als `AbortError` aus `fetch` und ist von einem Abbruch
    // durch den Aufrufer nicht zu unterscheiden — die Ursache kennt nur diese
    // Funktion, deshalb wird der Timeout hier zu einem eigenen Fehler.
    if (timedOut && timeoutMs !== null) throw new AgentCommandTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
