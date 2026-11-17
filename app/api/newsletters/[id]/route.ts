import { NextResponse } from "next/server";
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
  getTask,
  updateTask,
  type ScheduledTaskInput,
  type ScheduledTaskPatch,
} from "@/lib/scheduled-tasks-store";
import { scheduledTaskErrorResponse } from "@/lib/scheduled-tasks-http";
import { assertUsableCwd } from "@/lib/scheduled-settings";

export const dynamic = "force-dynamic";

/**
 * PATCH/DELETE /api/newsletters/[id] — einen Newsletter aendern oder loeschen.
 *
 * ### Warum 404 und nicht 403 bei einem fremden Newsletter
 *
 * Die Newsletter liegen pro Konto in getrennten Dateien. Eine fremde Kennung
 * ist in dieser Datei gar nicht vorhanden — dieselbe Antwort, dieselbe
 * Begruendung wie in `app/api/scheduled-tasks/[id]/route.ts`.
 *
 * ### Warum der Patch die Aufgabe mitzieht
 *
 * Name, Topics und Modell stehen zweimal: im Datensatz und in der Aufgabe
 * (der Name als Aufgabenname, die Topics im Prompt, das Modell als Modellwahl
 * des Laufs). Diese Route ist die eine Stelle, an der beide zusammen
 * geschrieben werden; wer nur den Datensatz aendert, laesst die Aufgabe weiter
 * die alten Themen recherchieren.
 */

function identityFor(req: Request): WebIdentity | null {
  const identity = getRequestIdentity(req.headers);
  if (identity === null) return null;
  return isNewsletterPathAllowed(identity, getNewsletterPath(identity)) ? identity : null;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
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

  const { id } = await params;
  const { newsletters } = readNewsletterFile(identity);
  const existing = newsletters.find((newsletter) => newsletter.id === id);
  if (!existing) {
    return NextResponse.json({ error: "Newsletter not found" }, { status: 404 });
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

  const name = raw.name === undefined
    ? existing.name
    : typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > MAX_NEWSLETTER_NAME_LENGTH) {
    return NextResponse.json(
      {
        error: `The name must not be empty and at most ${MAX_NEWSLETTER_NAME_LENGTH} characters`,
        field: "name",
      },
      { status: 400 },
    );
  }
  const topics = raw.topics === undefined ? existing.topics : normalizeTopics(raw.topics);
  if (topics.length === 0) {
    return NextResponse.json(
      {
        error: "At least one topic is required — a newsletter without topics has nothing to research",
        field: "topics",
      },
      { status: 400 },
    );
  }
  const provider = raw.provider === undefined
    ? existing.provider
    : typeof raw.provider === "string" ? raw.provider.trim() : "";
  const modelId = raw.modelId === undefined
    ? existing.modelId
    : typeof raw.modelId === "string" ? raw.modelId.trim() : "";
  const prompt = buildNewsletterPrompt({ id, name, topics });

  try {
    // `cwd` geht durch dieselbe Pruefung wie beim Anlegen. `null` bedeutet
    // "wieder Voreinstellung" und muss als Loeschung ankommen — deshalb wird
    // es hier *nicht* zu `undefined` gemacht.
    const cwd = raw.cwd === undefined ? undefined : assertUsableCwd(raw.cwd, identity);
    const { modelRegistry } = await getOmpRuntime();
    const isKnownModel = (candidate: string, model: string) =>
      modelRegistry.find(candidate, model) !== undefined;

    // Erst die Aufgabe: der Prompt traegt die Topics, und ein Name, den die
    // Aufgabe ablehnt, darf nicht als Datensatz stehen bleiben.
    let task = getTask(identity, existing.taskId);
    if (task !== null) {
      task = updateTask(identity, task.id, {
        name,
        prompt,
        ...(raw.provider === undefined ? {} : { provider }),
        ...(raw.modelId === undefined ? {} : { modelId }),
        ...(raw.cron === undefined ? {} : { cron: raw.cron as string }),
        ...(raw.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: raw.thinkingLevel as ScheduledTaskPatch["thinkingLevel"] }),
        ...(raw.cwd === undefined ? {} : { cwd }),
        ...(raw.enabled === undefined ? {} : { enabled: raw.enabled as boolean }),
      }, isKnownModel);
    }

    let taskId = existing.taskId;
    if (task === null) {
      // Die Aufgabe ist weg — sie wurde ausserhalb geloescht. Ein Cron ist
      // jetzt Pflicht und steht nicht im Datensatz, weil er in der Aufgabe
      // steht: eine geratene Uhrzeit waere ein Zeitplan, den niemand bestellt
      // hat.
      const cron = typeof raw.cron === "string" ? raw.cron : "";
      if (cron.trim() === "") {
        return NextResponse.json(
          {
            error:
              "The scheduled task of this newsletter no longer exists — send 'cron' with this update " +
              "to recreate it",
            field: "cron",
          },
          { status: 400 },
        );
      }
      const input: ScheduledTaskInput = {
        name,
        cron,
        prompt,
        provider,
        modelId,
        ...(raw.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: raw.thinkingLevel as ScheduledTaskInput["thinkingLevel"] }),
        ...(cwd ? { cwd } : {}),
        ...(raw.enabled === undefined ? {} : { enabled: raw.enabled as boolean }),
      };
      task = createTask(identity, input, isKnownModel);
      taskId = task.id;
    }

    const next: Newsletter = {
      ...existing,
      name,
      topics,
      provider: task.provider,
      modelId: task.modelId,
      taskId,
      updatedAt: new Date().toISOString(),
    };
    try {
      const stored = writeNewsletterFile(
        identity,
        newsletters.map((newsletter) => (newsletter.id === id ? next : newsletter)),
      ).find((newsletter) => newsletter.id === id);
      if (!stored) throw new Error("the updated newsletter did not survive normalization");
      rescheduleScheduler();
      return NextResponse.json({ newsletter: { ...stored, schedule: newsletterSchedule(task, Date.now()) } });
    } catch (error) {
      // Nur eine eben erst erschaffene Aufgabe wird zurueckgenommen; eine, die
      // es schon gab, ist der aeltere Zustand und bleibt.
      if (taskId !== existing.taskId) {
        try {
          deleteTask(identity, taskId);
        } catch (rollbackError) {
          console.error("[newsletters] the orphaned scheduled task could not be removed:", rollbackError);
        }
      }
      throw error;
    }
  } catch (error) {
    return scheduledTaskErrorResponse(error);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const denied = requireIdentity(req);
  if (denied) return denied;
  const identity = identityFor(req);
  if (identity === null) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const { id } = await params;
  const { newsletters } = readNewsletterFile(identity);
  const existing = newsletters.find((newsletter) => newsletter.id === id);
  if (!existing) {
    return NextResponse.json({ error: "Newsletter not found" }, { status: 404 });
  }

  try {
    // Die Aufgabe zuerst: ein Datensatz ohne Aufgabe zeigt einen Newsletter,
    // der nie wieder etwas liefert. Die Aufgabe ohne Datensatz (der Fall, wenn
    // das Schreiben unten scheitert) ist der kleinere Schaden — sie laeuft in
    // eine unbekannte Kennung und vermerkt einen Fehler.
    deleteTask(identity, existing.taskId);
    writeNewsletterFile(identity, newsletters.filter((newsletter) => newsletter.id !== id));
  } catch (error) {
    return scheduledTaskErrorResponse(error);
  }
  rescheduleScheduler();
  return NextResponse.json({ ok: true });
}
