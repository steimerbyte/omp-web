import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { rescheduleScheduler } from "@/lib/scheduler";
import { getOmpRuntime } from "@/lib/omp-runtime";
import { getRequestIdentity, requireIdentity, type WebIdentity } from "@/lib/request-identity";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  buildNewsletterPrompt,
  MAX_NEWSLETTER_NAME_LENGTH,
  newsletterSchedule,
  normalizeTopics,
  type Newsletter,
} from "@/lib/newsletter";
import {
  getNewsletterPath,
  isNewsletterPathAllowed,
  readNewsletterFile,
  writeNewsletterFile,
} from "@/lib/newsletter-store";
import {
  createTask,
  deleteTask,
  listTasks,
  type ScheduledTaskInput,
} from "@/lib/scheduled-tasks-store";
import { scheduledTaskErrorResponse } from "@/lib/scheduled-tasks-http";

export const dynamic = "force-dynamic";

/**
 * GET/POST /api/newsletters — die Newsletter des angemeldeten Kontos.
 *
 * Dieselbe Form wie `app/api/scheduled-tasks/route.ts`, weil ein Newsletter
 * nichts anderes ist als ein Datensatz neben einer geplanten Aufgabe: die
 * Aufgabe forscht, der Datensatz traegt Topics und Ausgaben. Deshalb liegen
 * hier auch erst der Plan und dann die Ausgaben — ein Newsletter ohne Aufgabe
 * wuerde nie eine Ausgabe bekommen.
 *
 * Der `schedule`-Block wird beim Lesen aus `getTask` verbunden und nicht im
 * Newsletter gespeichert: zwei Kopien von Cron und `lastRunAt` waeren zwei
 * Wahrheiten, und die Aufgabe ist die, die tatsaechlich laeuft.
 */

/**
 * Die Identitaet, oder `null` — und `null` ist hier schon abgelehnt.
 *
 * Die zweite Schicht: der abgeleitete Pfad wird gegen die Konto-Home geprueft,
 * **bevor** ein Verzeichnis entsteht.
 */
function identityFor(req: Request): WebIdentity | null {
  const identity = getRequestIdentity(req.headers);
  if (identity === null) return null;
  return isNewsletterPathAllowed(identity, getNewsletterPath(identity)) ? identity : null;
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
  const tasks = new Map(listTasks(identity).map((task) => [task.id, task]));
  return NextResponse.json({
    newsletters: readNewsletterFile(identity).newsletters.map((newsletter) => ({
      ...newsletter,
      schedule: newsletterSchedule(tasks.get(newsletter.taskId) ?? null, nowMs),
    })),
  });
}

/**
 * POST /api/newsletters — einen Newsletter anlegen.
 *
 * Die Reihenfolge ist die Zusage dieser Route: **erst** die Aufgabe, **dann**
 * der Datensatz. Scheitert das Schreiben des Datensatzes, wird die eben
 * angelegte Aufgabe wieder geloescht — sonst bliebe ein Zeitplan zurueck, der
 * bei jedem Lauf an einer unbekannten Kennung scheitert, und der Nutzer saehe
 * eine Aufgabe, die er nie bestellt hat.
 *
 * Die Kennung des Newsletters vergibt der Server: sie steht im Prompt der
 * Aufgabe, und eine Kennung aus dem Request hiesse, dass ein Client den Prompt
 * einer fremden Aufgabe schreiben kann.
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

  // Die Grenzen des Newsletters vor der Aufgabe: ein Name, den die Datei
  // spaeter beim Normalisieren verwerfen wuerde, ist kein Name.
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > MAX_NEWSLETTER_NAME_LENGTH) {
    return NextResponse.json(
      {
        error: `The name must not be empty and at most ${MAX_NEWSLETTER_NAME_LENGTH} characters`,
        field: "name",
      },
      { status: 400 },
    );
  }
  const topics = normalizeTopics(raw.topics);
  if (topics.length === 0) {
    return NextResponse.json(
      {
        error: "At least one topic is required — a newsletter without topics has nothing to research",
        field: "topics",
      },
      { status: 400 },
    );
  }
  const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
  const modelId = typeof raw.modelId === "string" ? raw.modelId.trim() : "";
  const id = randomUUID();
  const prompt = buildNewsletterPrompt({ id, name, topics });

  const input: ScheduledTaskInput = {
    name,
    cron: typeof raw.cron === "string" ? raw.cron : "",
    prompt,
    provider,
    modelId,
    ...(raw.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: raw.thinkingLevel as ScheduledTaskInput["thinkingLevel"] }),
  };

  try {
    const { modelRegistry } = await getOmpRuntime();
    const task = createTask(identity, input, (candidate, model) => modelRegistry.find(candidate, model) !== undefined);
    try {
      const now = new Date().toISOString();
      const record: Newsletter = {
        id,
        name,
        topics,
        provider: task.provider,
        modelId: task.modelId,
        taskId: task.id,
        createdAt: now,
        updatedAt: now,
        issues: [],
      };
      const stored = writeNewsletterFile(
        identity,
        [...readNewsletterFile(identity).newsletters, record],
      ).find((entry) => entry.id === id);
      if (!stored) throw new Error("the new newsletter did not survive normalization");
      // Ohne diesen Aufruf wartet der eine Timer bis zum naechsten Weckruf —
      // dieselbe Begruendung wie in `app/api/scheduled-tasks/route.ts`.
      rescheduleScheduler();
      return NextResponse.json(
        { newsletter: { ...stored, schedule: newsletterSchedule(task, Date.now()) } },
        { status: 201 },
      );
    } catch (error) {
      // Der Rueckwaertsgang. Scheitert auch er, bleibt eine Aufgabe ohne
      // Datensatz stehen; das ist der kleinere Schaden und wird protokolliert.
      try {
        deleteTask(identity, task.id);
      } catch (rollbackError) {
        console.error("[newsletters] the orphaned scheduled task could not be removed:", rollbackError);
      }
      throw error;
    }
  } catch (error) {
    return scheduledTaskErrorResponse(error);
  }
}
