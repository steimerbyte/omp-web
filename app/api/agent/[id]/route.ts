import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession } from "@/lib/rpc-manager";
import { switchColdSessionModel } from "@/lib/cold-model-switch";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getRequestIdentity } from "@/lib/request-identity";
import { requireSessionAccess } from "@/app/api/sessions/session-guard";
import {
  MAX_AGENT_REQUEST_BODY_BYTES,
  RequestBodyTooLargeError,
  oversizedRequestBody,
  readJsonBodyWithinLimit,
} from "@/lib/request-body";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const { id } = await params;

  // Die Berechtigung steht **vor** dem Lesen des Bodys, nicht danach. Zwei
  // Argumente dafuer:
  //
  // 1. Erst der Guard, dann der Body: der 30-MB-Deckel zaehlt jetzt die Bytes,
  //    die wirklich ankommen (auch bei `Transfer-Encoding: chunked`), und das
  //    ist Lese- und Pufferaufwand. Ein Aufrufer ohne Zugriff auf die Session
  //    soll ihn nicht ausloesen koennen — sonst waere jede fremde Session-Id
  //    ein kostenloser 30-MB-Puffer.
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

  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    // Der Deckel greift auf den gelesenen Bytes, nicht auf `content-length`:
    // ein chunked Request hat den Header nicht, und ein gefaelschter waere
    // wertlos. Ein ueberbudgetierter Prompt bekommt weiterhin die
    // `prompt_rejected`-Form, die der Client schon kennt.
    const body = await readJsonBodyWithinLimit(req, MAX_AGENT_REQUEST_BODY_BYTES) as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;

    // Der Aufrufer, nicht der Erzeuger der Session: dieselbe laufende Session
    // kann von jedem Konto angesprochen werden, dem `requireSessionAccess`
    // Zugriff gibt. Die Identitaet wird deshalb bei **jedem** Dispatch an
    // `send` gebunden — operative Slash-Kommandos muessen dem Aufrufer folgen,
    // nicht dem Konto, das die Session gestartet hat. Sie kommt ausschliesslich
    // aus den Proxy-Headern, nie aus dem Body.
    const identity = getRequestIdentity(req.headers);

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (existing?.isAlive()) {
      const result = await existing.send(body, identity);
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

    const { session } = await startRpcSession(id, filePath, undefined, {
      // Die Identitaet des anfragenden Kontos wandert in die Sitzung: die
      // Kalender-Werkzeuge laufen im Serverprozess und koennen dort keinen
      // Request mehr vorfinden, aus dem sie das Konto laessten. Der Guard
      // `requireSessionAccess` hat oben bereits geprueft, dass dieses Konto
      // auf die Session zugreifen darf.
      identity: identity ?? undefined,
      owner: identity?.username,
    });
    const result = await session.send(body, identity);
    promptAccepted = body.type === "prompt";

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json(oversizedRequestBody(error), { status: 413 });
    }
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
    // `running` = "this session still owes work", not "a wrapper exists"; the browser keeps its SSE stream open while true.
    return NextResponse.json({ running: session.isRunning(), state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
