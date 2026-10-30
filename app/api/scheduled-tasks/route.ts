import { NextResponse } from "next/server";
import { nextRunAfter, parseSchedule } from "@/lib/schedule";
import { rescheduleScheduler } from "@/lib/scheduler";
import { getOmpRuntime } from "@/lib/omp-runtime";
import { requireIdentity, getRequestIdentity, type WebIdentity } from "@/lib/request-identity";
import {
  createTask,
  getScheduledTasksPath,
  isScheduledTasksPathAllowed,
  listTasks,
  type ScheduledTask,
  type ScheduledTaskInput,
} from "@/lib/scheduled-tasks-store";
import { scheduledTaskErrorResponse } from "@/lib/scheduled-tasks-http";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/**
 * GET/POST /api/scheduled-tasks — die geplanten Aufgaben des angemeldeten Kontos.
 *
 * Dieselbe Form wie `app/api/quick-phrases/route.ts` und
 * `app/api/calendar/route.ts`: eine Liste pro Konto, eine Datei pro Konto, und
 * die Identitaet kommt aus dem Header, den nur `proxy.ts` setzt.
 *
 * ### Warum der Identity-Guard aus `lib/request-identity.ts` kommt
 *
 * Der Kalender hat sich seine eigene Kopie gebaut und antwortet deshalb mit
 * 403, wo `requireIdentity` 401 sagt — zwei Antworten auf dieselbe Frage.
 * `AGENTS.md` nennt das ausdruecklich als Fehlerquelle ("a guard copied into a
 * route is a hole"); hier wird der gemeinsame Guard benutzt.
 */

/**
 * Die Identitaet, oder `null` — und `null` ist hier schon abgelehnt.
 *
 * Die zweite Schicht: der abgeleitete Pfad wird gegen die Konto-Home geprueft,
 * **bevor** ein Verzeichnis entsteht. `resolveTenantAgentDir` ist die
 * Herleitung, nicht die Abnahme.
 */
function identityFor(req: Request): WebIdentity | null {
  const identity = getRequestIdentity(req.headers);
  if (identity === null) return null;
  return isScheduledTasksPathAllowed(identity, getScheduledTasksPath(identity)) ? identity : null;
}

/**
 * "Ist dieses Modell-Paar bekannt?" — aus der lebenden Registrierung.
 *
 * Der Speicher kennt keine Modellliste; diese Route reicht die Antwort aus
 * `modelRegistry.find(provider, modelId)` hinein. Eine statische Liste hier
 * waere eine zweite, veraltende Kopie von `config.yml`.
 */
async function knownModelLookup(): Promise<(provider: string, modelId: string) => boolean> {
  const { modelRegistry } = await getOmpRuntime();
  return (provider, modelId) => modelRegistry.find(provider, modelId) !== undefined;
}

/**
 * Eine Aufgabe mit ihrem naechsten Lauf, wie die Liste sie zeigt.
 *
 * `nextRun` wird serverseitig gerechnet und nicht im Browser: die Zeitplaene
 * gelten in der Zone des *Servers*, und ein Browser in einer anderen Zone
 * wuerde eine andere Uhrzeit anzeigen als die, zu der der Lauf stattfindet.
 * `null` heisst "kein naechster Lauf" — entweder deaktiviert oder ein Plan,
 * der nie trifft (`0 0 31 2 *`).
 */
function withNextRun(task: ScheduledTask, nowMs: number): ScheduledTask & { nextRun: number | null } {
  if (!task.enabled) return { ...task, nextRun: null };
  try {
    return { ...task, nextRun: nextRunAfter(parseSchedule(task.cron), nowMs) };
  } catch {
    return { ...task, nextRun: null };
  }
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const denied = requireIdentity(req);
  if (denied) return denied;
  const identity = identityFor(req);
  if (identity === null) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const nowMs = Date.now();
  return NextResponse.json({
    tasks: listTasks(identity).map((task) => withNextRun(task, nowMs)),
  });
}

/**
 * POST /api/scheduled-tasks — eine Aufgabe anlegen.
 *
 * Die Kennung und die Zeitstempel vergibt der Server; die Kennung aus dem
 * Request zu nehmen hiesse, dass ein Client eine fremde Aufgabe ueberschreiben
 * kann. Der Cron wird durch `parseSchedule` geprueft (ein Fehler nennt Feld
 * und Token), das Modellpaar gegen die lebende Registrierung.
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const denied = requireIdentity(req);
  if (denied) return denied;
  const identity = identityFor(req);
  if (identity === null) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }
  const raw = body as Record<string, unknown>;

  const input: ScheduledTaskInput = {
    name: typeof raw.name === "string" ? raw.name : "",
    cron: typeof raw.cron === "string" ? raw.cron : "",
    prompt: typeof raw.prompt === "string" ? raw.prompt : "",
    provider: typeof raw.provider === "string" ? raw.provider : "",
    modelId: typeof raw.modelId === "string" ? raw.modelId : "",
    ...(raw.thinkingLevel === undefined ? {} : { thinkingLevel: raw.thinkingLevel as ScheduledTaskInput["thinkingLevel"] }),
    ...(raw.cwd === undefined ? {} : { cwd: raw.cwd as ScheduledTaskInput["cwd"] }),
    ...(raw.enabled === undefined ? {} : { enabled: raw.enabled as boolean }),
  };

  try {
    const isKnownModel = await knownModelLookup();
    const task = createTask(identity, input, isKnownModel);
    // Ohne diesen Aufruf wartet der eine Timer bis zum naechsten Weckruf —
    // eine neue Aufgabe mit einem weit entfernten Slot wuerde erst dann
    // bemerkt, und eine mit "* * * * *" bis zu einer Stunde spaeter.
    rescheduleScheduler();
    return NextResponse.json({ task: withNextRun(task, Date.now()) }, { status: 201 });
  } catch (error) {
    return scheduledTaskErrorResponse(error);
  }
}
