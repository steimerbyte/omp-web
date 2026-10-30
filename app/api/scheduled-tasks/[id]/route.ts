import { NextResponse } from "next/server";
import { nextRunAfter, parseSchedule } from "@/lib/schedule";
import { rescheduleScheduler } from "@/lib/scheduler";
import { getOmpRuntime } from "@/lib/omp-runtime";
import { requireIdentity, getRequestIdentity, type WebIdentity } from "@/lib/request-identity";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { scheduledTaskErrorResponse } from "@/lib/scheduled-tasks-http";
import { assertUsableCwd } from "@/lib/scheduled-settings";
import {
  deleteTask,
  getScheduledTasksPath,
  getTask,
  isScheduledTasksPathAllowed,
  type ScheduledTask,
  type ScheduledTaskPatch,
  updateTask,
} from "@/lib/scheduled-tasks-store";

export const dynamic = "force-dynamic";

/**
 * PATCH/DELETE /api/scheduled-tasks/[id] — eine Aufgabe aendern oder loeschen.
 *
 * ### Warum 404 und nicht 403 bei einer fremden Aufgabe
 *
 * Die Aufgaben liegen pro Konto in getrennten Dateien. Eine fremde Aufgabe ist
 * in dieser Datei gar nicht vorhanden — es gibt nichts, was 403 verbergen
 * koennte. Dieselbe Antwort, dieselbe Begruendung wie in
 * `app/api/calendar/[id]/route.ts`.
 *
 * ### Warum `PATCH` und nicht `PUT`
 *
 * Der Schalter in der Liste schickt nur `{ enabled: false }`. Ein `PUT` muesste
 * alle uebrigen Felder mitschicken, sonst waeren sie weg; `PATCH` heisst
 * "aendere dies, lass den Rest stehen".
 */

function identityFor(req: Request): WebIdentity | null {
  const identity = getRequestIdentity(req.headers);
  if (identity === null) return null;
  return isScheduledTasksPathAllowed(identity, getScheduledTasksPath(identity)) ? identity : null;
}

function withNextRun(task: ScheduledTask): ScheduledTask & { nextRun: number | null } {
  if (!task.enabled) return { ...task, nextRun: null };
  try {
    return { ...task, nextRun: nextRunAfter(parseSchedule(task.cron), Date.now()) };
  } catch {
    return { ...task, nextRun: null };
  }
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
  // Die Existenz wird vor dem Body geprueft: eine fremde Kennung soll 404 sein,
  // auch wenn der Body kaputt ist — sonst verraet der Statuscode, dass ein
  // kaputter Body anders behandelt wird als ein fremder.
  if (getTask(identity, id) === null) {
    return NextResponse.json({ error: "Scheduled task not found" }, { status: 404 });
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

  try {
    // Nur die Felder, die der Patch ueberhaupt kennt. Ein unbekanntes Feld
    // stillschweigend zu uebernehmen waere ein Feld, von dem der Nutzer glaubt,
    // es sei gespeichert.
    //
    // `cwd` geht durch dieselbe Pruefung wie beim Anlegen. `null` bedeutet
    // "wieder Voreinstellung" und muss als Loeschung ankommen — deshalb wird es
    // hier *nicht* zu `undefined` gemacht, anders als der Unterschied zwischen
    // "Feld fehlt" und "Feld ist null" verlangt.
    const cwd = raw.cwd === undefined ? undefined : assertUsableCwd(raw.cwd, identity);
    const patch: ScheduledTaskPatch = {
      ...(raw.name === undefined ? {} : { name: raw.name as string }),
      ...(raw.cron === undefined ? {} : { cron: raw.cron as string }),
      ...(raw.prompt === undefined ? {} : { prompt: raw.prompt as string }),
      ...(raw.provider === undefined ? {} : { provider: raw.provider as string }),
      ...(raw.modelId === undefined ? {} : { modelId: raw.modelId as string }),
      ...(raw.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: raw.thinkingLevel as ScheduledTaskPatch["thinkingLevel"] }),
      ...(raw.cwd === undefined ? {} : { cwd }),
      ...(raw.enabled === undefined ? {} : { enabled: raw.enabled as boolean }),
    };

    const { modelRegistry } = await getOmpRuntime();
    const updated = updateTask(
      identity,
      id,
      patch,
      (provider, modelId) => modelRegistry.find(provider, modelId) !== undefined,
    );
    if (updated === null) {
      return NextResponse.json({ error: "Scheduled task not found" }, { status: 404 });
    }
    // Ein geaenderter Cron verschiebt den naechsten Slot; ein deaktivierter
    // macht ihn gegenstandslos. Beides muss der eine Timer sofort wissen.
    rescheduleScheduler();
    return NextResponse.json({ task: withNextRun(updated) });
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
  let deleted: boolean;
  try {
    deleted = deleteTask(identity, id);
  } catch (error) {
    return scheduledTaskErrorResponse(error);
  }
  if (!deleted) {
    return NextResponse.json({ error: "Scheduled task not found" }, { status: 404 });
  }
  rescheduleScheduler();
  return NextResponse.json({ deleted: true });
}
