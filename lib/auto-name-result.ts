/**
 * What `POST /api/sessions/[id]/auto-name` actually decided. `skipped` is not
 * an error: omp declines to name greetings and other low-signal openers by
 * design, and the button reports that as a neutral outcome.
 */
export type AutoNameResult =
  | { kind: "success"; title: string }
  | { kind: "skipped" }
  | { kind: "error"; message: string };

export function interpretAutoNameResponse(ok: boolean, status: number, body: unknown): AutoNameResult {
  const isRecord = typeof body === "object" && body !== null;
  const error = isRecord && "error" in body && typeof body.error === "string" ? body.error : "";
  if (!ok || error) return { kind: "error", message: error || `HTTP ${status}` };
  if (isRecord && "skipped" in body && body.skipped === true) return { kind: "skipped" };
  const title = isRecord && "title" in body && typeof body.title === "string" ? body.title.trim() : "";
  if (title) return { kind: "success", title };
  return { kind: "error", message: `HTTP ${status}` };
}
