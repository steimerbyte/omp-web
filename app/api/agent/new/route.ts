import { NextResponse } from "next/server";
import { parseConfiguredThinkingLevel as parseOmpThinkingLevel, type ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { allowFileRoot, getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getRequestIdentity } from "@/lib/request-identity";
import { isWritePathAllowed } from "@/lib/write-access";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { startRpcSession, TenantBoundaryError, tenantBoundaryHttpStatus } from "@/lib/rpc-manager";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  MAX_AGENT_REQUEST_BODY_BYTES,
  RequestBodyTooLargeError,
  oversizedRequestBody,
  readJsonBodyWithinLimit,
} from "@/lib/request-body";
// omp owns the selector grammar (including abbreviations like "med"); reuse its
// parser so the browser and the CLI accept exactly the same values.
function parseThinkingLevel(value: unknown): ConfiguredThinkingLevel | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "string" ? parseOmpThinkingLevel(value) : undefined;
  if (parsed === undefined) throw new Error(`Invalid thinking level: ${String(value)}`);
  return parsed;
}
// POST /api/agent/new  body: { cwd: string; type: string; message?: string; ... }
// Spawns a brand-new pi session. Most calls immediately send the first command;
// type:"ensure_session" only creates the runtime so clients can query commands.
// Returns pi's real session id plus the model/thinking state selected at startup.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let commandType: string | undefined;
  let promptAccepted = false;
  try {
    // Same bounded read as `/api/agent/[id]`: a new session accepts the same
    // prompt body, so it needs the same ceiling instead of buffering whatever
    // arrives (chunked requests included).
    const body = await readJsonBodyWithinLimit(req, MAX_AGENT_REQUEST_BODY_BYTES) as { cwd?: string; [key: string]: unknown };
    const { cwd, ...command } = body;
    commandType = typeof command.type === "string" ? command.type : undefined;

    if (!cwd || typeof cwd !== "string") {
      return NextResponse.json({
        error: "cwd is required",
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 400 });
    }
    if (!existsSync(cwd)) {
      return NextResponse.json({
        error: `Directory does not exist: ${cwd}`,
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 400 });
    }
    // The cwd comes from the request body, so the caller picks it. The decision
    // is made from the identity only, resolved once here from the header that
    // `proxy.ts` set after checking credentials. A missing identity is a
    // refusal, never a fallback to the service's own account.
    const identity = getRequestIdentity(req.headers);
    if (!identity) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const allowedRoots = await getAllowedFileRoots(identity);
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // Starting a session makes the agent *write* into the cwd: it creates
    // session files, writes history, runs tools. Being allowed to read a
    // directory is therefore not enough to be allowed to work in one, so the
    // cwd has to clear the write boundary too.
    if (!(await isWritePathAllowed(cwd, { mustExist: true }, identity))) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // Use a one-time key so startRpcSession's lock doesn't conflict with real session ids
    const { provider, modelId, toolNames, thinkingLevel, ...promptCommand } = command as { provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: unknown; [key: string]: unknown };
    if ((provider && !modelId) || (!provider && modelId)) {
      throw new Error("provider and modelId must be provided together");
    }
    const explicitThinkingLevel = parseThinkingLevel(thinkingLevel);

    // Must be unique per request: startRpcSession coalesces concurrent callers
    // that share a key onto one session. Date.now() (ms resolution) collides for
    // requests in the same millisecond, merging two new sessions into one.
    const tempKey = `__new__${randomUUID()}`;
    const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, {
      ...(toolNames ? { toolNames } : {}),
      ...(provider && modelId ? { initialModel: { provider, modelId } } : {}),
      ...(explicitThinkingLevel ? { thinkingLevel: explicitThinkingLevel } : {}),
      // Die Identitaet wandert mit in die Sitzung: die Kalender-Werkzeuge
      // brauchen sie, weil sie im Serverprozess laufen und dort keinen Request
      // mehr vorfinden, aus dem sie das Konto lesen koennten. Ohne diese
      // Bindung wuerde der Agent den Kalender des *globalen* Verzeichnisses
      // benutzen — also den des Betreibers, nicht den des angemeldeten Kontos.
      identity,
      // Ohne `owner` ist eine frisch gestartete Session fuer den Filter
      // unsichtbar (`setSessionOwner(realSessionId, options.owner ?? "")`), und
      // der Event-Stream antwortet 404, bevor die Datei existiert. Die
      // Sitzung gehoert dem Konto, das sie geoeffnet hat.
      owner: identity.username,
    });

    // Keep the files-route allowed-roots cache (see app/api/files/[...path]/route.ts)
    // in sync so the new cwd is immediately readable via /api/files. Without this,
    // a file request under a brand-new cwd would 403 for up to the cache TTL.
    // Scoped to this identity: an un-scoped grant would add the cwd to a
    // process-wide bucket that every other account reads too.
    allowFileRoot(cwd, identity);
    invalidateSessionListCache();

    const state = await session.send({ type: "get_state" }) as {
      model?: { id: string; provider: string };
      thinkingLevel?: string;
      configuredThinkingLevel?: string;
    };

    if (promptCommand.type === "ensure_session") {
      return NextResponse.json({
        success: true,
        sessionId: realSessionId,
        data: null,
        model: state.model
          ? { provider: state.model.provider, modelId: state.model.id }
          : null,
        thinkingLevel: state.thinkingLevel,
        configuredThinkingLevel: state.configuredThinkingLevel,
      });
    }

    const result = await session.send(promptCommand);
    promptAccepted = promptCommand.type === "prompt";

    return NextResponse.json({
      success: true,
      sessionId: realSessionId,
      data: result,
      model: state.model
        ? { provider: state.model.provider, modelId: state.model.id }
        : null,
      thinkingLevel: state.thinkingLevel,
      configuredThinkingLevel: state.configuredThinkingLevel,
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json(oversizedRequestBody(error), { status: 413 });
    }
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      // Eine Grenze, die einen Request abweist, nennt Grund und Abhilfe. Ohne
      // diese drei Felder muesste der Aufrufer den Grund aus einem String
      // raten — und ein Betreiber mit kaputtem userns erfuehre nie, was fehlt
      // (`docs/plans/tenant-isolation.md` §11 A5).
      ...(error instanceof TenantBoundaryError
        ? { reason: error.reason, detail: error.detail, remediation: error.remediation }
        : {}),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, {
      // Eine fehlende Grenze ist ein Zustand des Hosts, kein Serverfehler: 503
      // statt 500, wie im Terminal-Pfad. Der Koerper bleibt unveraendert.
      status: error instanceof TenantBoundaryError
        ? tenantBoundaryHttpStatus(error.reason)
        : 500,
    });
  }
}
