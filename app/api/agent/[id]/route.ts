import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession } from "@/lib/rpc-manager";
import { switchColdSessionModel } from "@/lib/cold-model-switch";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getRequestIdentity } from "@/lib/request-identity";
import { requireSessionAccess } from "@/app/api/sessions/session-guard";

/**
 * Request-body ceiling this route accepts, matching
 * `experimental.proxyClientMaxBodySize` in `next.config.ts`. Kept slightly
 * under the Next limit so the handler answers with a reason instead of the
 * proxy dropping the connection.
 */
const MAX_REQUEST_BODY_BYTES = 30 * 1024 * 1024;

/** Trusted Content-Length, or null when absent or not a plain integer. */
function declaredBodyLength(req: Request): number | null {
  const header = req.headers.get("content-length");
  if (!header || !/^\d+$/.test(header)) return null;
  const length = Number(header);
  return Number.isSafeInteger(length) ? length : null;
}

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const { id } = await params;

  // Die Berechtigung steht **vor** `hasJsonContentType` und der Body-Grenze,
  // nicht danach. Zwei Argumente dagegen, und beide tragen nicht:
  //
  // 1. Die beiden spaeteren Pruefungen lesen den Body nicht. Die
  //    Groessenpruefung liest nur `content-length` aus den Headern, und
  //    `hasJsonContentType` liest `content-type`. "Die Route verarbeitet einen
  //    fremden Body" trifft also nicht zu — es entsteht kein Lese- oder
  //    Pufferaufwand, den ein Angreifer gegen einen Mandanten ausnutzen
  //    koennte. Der 30-MB-Deckel bleibt ueber `proxy.ts` ohnehin eine
  //    transportermassige Grenze, unabhaengig von der Reihenfolge hier.
  // 2. Umgekehrt liefern 415 und 413 einem Aufrufer ohne Berechtigung Antworten
  //    ueber eine Ressource, die ihm nicht gehoert. Sie sind Fehler *ueber*
  //    seinen Body, verkleidet als Fehler *ueber die Session*. Die
  //    Berechtigungsfrage ist die einzige, deren Antwort nichts ueber den
  //    Aufrufer hinaus preisgeben darf, also ist sie die erste.
  //
  // Der Origin-Check bleibt davor: der beantwortet "darf dieser Request die API
  // ueberhaupt ansprechen", und das ist eine Eigenschaft des Requests selbst,
  // nicht der Ressource.
  const denied = await requireSessionAccess(req, id);
  if (denied) return denied;

  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  // `proxy.ts` matches this route and refuses oversized bodies at the Next
  // limit, which reaches the client as a bare 413 with no explanation. This
  // guard runs first, so an over-budget prompt gets the same `prompt_rejected`
  // shape the client already knows how to react to — with a reason it can
  // show. It only reads Content-Length; chunked requests still fall through to
  // the proxy, and `validateAgentImages` re-checks the decoded sizes either way.
  const declaredLength = declaredBodyLength(req);
  if (declaredLength !== null && declaredLength > MAX_REQUEST_BODY_BYTES) {
    return NextResponse.json({
      error: `Request body is too large (${Math.round(declaredLength / (1024 * 1024))}MB); attach fewer or smaller images`,
      code: "prompt_rejected",
      accepted: false,
    }, { status: 413 });
  }

  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (existing?.isAlive()) {
      const result = await existing.send(body);
      promptAccepted = body.type === "prompt";
      return NextResponse.json({ success: true, data: result });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({
        error: "Session not found",
        ...(body.type === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 404 });
    }

    // Ein Modellwechsel braucht keine laufende Session. Den sonst folgenden
    // `startRpcSession` (Extensions, Tools, System-Prompt, `createAgentSession`)
    // zahlt der Nutzer als Wartezeit auf einen Klick, der nur einen Eintrag im
    // Journal aendert — siehe `lib/cold-model-switch.ts`. Der Eintrag ist
    // dieselbe Zeile, die `setModel` schreibt, und die SDK stellt das Modell
    // beim naechsten Start daraus wieder her.
    if (body.type === "set_model" || body.type === "set_role_model") {
      const switched = body.type === "set_model"
        ? await switchColdSessionModel(filePath, {
          kind: "model",
          provider: String(body.provider ?? ""),
          modelId: String(body.modelId ?? ""),
        })
        : await switchColdSessionModel(filePath, { kind: "role", role: String(body.role ?? "") });
      return NextResponse.json({ success: true, data: switched });
    }

    const identity = getRequestIdentity(req.headers);
    const { session } = await startRpcSession(id, filePath, undefined, {
      // Die Identitaet des anfragenden Kontos wandert in die Sitzung: die
      // Kalender-Werkzeuge laufen im Serverprozess und koennen dort keinen
      // Request mehr vorfinden, aus dem sie das Konto laessten. Der Guard
      // `requireSessionAccess` hat oben bereits geprueft, dass dieses Konto
      // auf die Session zugreifen darf.
      identity: identity ?? undefined,
      owner: identity?.username,
    });
    const result = await session.send(body);
    promptAccepted = body.type === "prompt";

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Gleiche Regel wie POST, gleiche Begruendung: vor `getRpcSession`. Ein Guard
  // hinter dem `getRpcSession` waere nutzlos — das Aufhaengen der fremden
  // Session haette den Schaden schon getan.
  const denied = await requireSessionAccess(req, id);
  if (denied) return denied;

  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
