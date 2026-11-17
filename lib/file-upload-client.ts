import { buildFileAtMentionsText } from "./file-fuzzy";
import { encodeFilePathForApi } from "./file-paths";

/**
 * Der Client-Teil des Dateianhaengs im Composer.
 *
 * Ein Upload besteht aus zwei Requests: `POST /api/files/[...path]?type=upload-ticket`
 * (durch den Proxy, mit Identitaet) prueft Zielverzeichnis, Schreib-Allowlist
 * und Konflikt und gibt ein Einmal-Ticket zurueck; `PUT /upload/<token>`
 * schickt die Bytes. Der zweite Request liegt bewusst ausserhalb des
 * Proxy-Matchers, weil der Proxy jeden Body in den Speicher klont und oberhalb
 * von `proxyClientMaxBodySize` abschneidet statt abzulehnen — festgehalten in
 * `lib/file-upload.ts` (`MAX_UPLOAD_FILE_BYTES`).
 *
 * ### Warum `conflict=skip` und nicht `overwrite` oder `error`
 *
 * `overwrite` ersetzt eine vorhandene Datei kommentarlos — eine
 * Datenverlust-Entscheidung, die der Nutzer nie getroffen hat. `error`
 * antwortet mit 409 und einem Konfliktdialog, den der Datei-Explorer schon
 * hat, den der Composer aber nicht nachbauen soll. `skip` laesst die alte
 * Datei unangetastet, meldet den Namen in `skipped` und der Composer sagt es.
 * Die erlaubten Strategien der Route sind nur `error|overwrite|skip`
 * (`lib/file-upload.ts`); ein Suffix vergibt sie nicht, und der Client raet
 * keinen.
 */

/**
 * 10 GB je Datei, clientseitig geprueft.
 *
 * Dieselbe Zahl wie `MAX_UPLOAD_FILE_BYTES` in `lib/file-upload.ts`, und aus
 * demselben Grund vor dem Request: ein zu grosser Body soll eine erklaerte
 * Meldung ergeben, bevor ein Byte unterwegs ist. Die Servergrenze bleibt die
 * zweite, nicht die erste Verteidigung — die Route lehnt dieselbe Groesse mit
 * 413 ab, das Ticket wird fuer mehr gar nicht erst ausgestellt.
 */
export const MAX_CHAT_UPLOAD_BYTES = 10 * 1024 ** 3;

/** Dieselbe Grenze als Text, damit Meldung und Pruefung nicht getrennt altern. */
export const MAX_CHAT_UPLOAD_LABEL = "10 GB";

export interface UploadedFile {
  /** Der Name auf der Platte (die Route vergibt bei `skip` keinen neuen). */
  name: string;
  /** Groesse in Bytes, wie der Client sie gesendet hat. */
  size: number;
  /** Pfad relativ zum `cwd` — genau die Form, die `@`-Erwaehnungen benutzen. */
  path: string;
}

export type UploadOutcome =
  | { ok: true; file: UploadedFile }
  | { ok: false; kind: "tooLarge" | "conflict" | "forbidden" | "failed"; error: string; name?: string };

/**
 * Eine Datei in den Arbeitsordner der Sitzung legen.
 *
 * Zwei Requests je Datei: ein Ticket, dann die Bytes. Der Fehlschlag eines
 * Uploads trifft die anderen Anhaenge nicht. Der Dateiname in der Antwort ist
 * der des Tickets — der Client raet keinen.
 */
export async function uploadFileToCwd(cwd: string, file: File): Promise<UploadOutcome> {
  // Vor dem Request, nicht danach: die Meldung soll ohne Uebertragung kommen.
  if (file.size > MAX_CHAT_UPLOAD_BYTES) {
    return { ok: false, kind: "tooLarge", error: `Files must be ${MAX_CHAT_UPLOAD_LABEL} or smaller` };
  }

  let response: Response;
  try {
    response = await fetch(
      `/api/files/${encodeFilePathForApi(cwd)}?type=upload-ticket&conflict=skip`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size }),
      },
    );
  } catch (error) {
    return { ok: false, kind: "failed", error: error instanceof Error ? error.message : String(error) };
  }

  type UploadReply = {
    token?: string;
    uploaded?: string[];
    skipped?: string[];
    errors?: Array<{ name: string; error: string }>;
    error?: string;
  };
  const mint = await jsonOrNull(response) as UploadReply | null;

  if (!response.ok) {
    return { ok: false, kind: failureKind(response.status), error: mint?.error ?? `HTTP ${response.status}` };
  }
  if (mint?.skipped?.includes(file.name)) {
    return { ok: false, kind: "conflict", name: file.name, error: "A file with that name already exists" };
  }
  if (typeof mint?.token !== "string") {
    return { ok: false, kind: "failed", error: mint?.errors?.[0]?.error ?? "The server sent no upload ticket" };
  }

  let uploaded: Response;
  try {
    // `body: file` uebertraegt den Blob, statt ihn im Speicher zu kopieren —
    // und genau dafuer ist die Route ein Streaming-PUT.
    uploaded = await fetch(`/upload/${encodeURIComponent(mint.token)}`, {
      method: "PUT",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
  } catch (error) {
    return { ok: false, kind: "failed", error: error instanceof Error ? error.message : String(error) };
  }

  const body = await jsonOrNull(uploaded) as UploadReply | null;

  if (!uploaded.ok) {
    return { ok: false, kind: failureKind(uploaded.status), error: body?.error ?? `HTTP ${uploaded.status}` };
  }
  if (body?.errors?.length) {
    return { ok: false, kind: "failed", error: body.errors[0]?.error ?? "The file could not be written" };
  }
  if (!body?.uploaded?.includes(file.name)) {
    return { ok: false, kind: "failed", error: "The server reported no uploaded file" };
  }

  return { ok: true, file: { name: file.name, size: file.size, path: file.name } };
}

/** Ein leerer oder kaputter Body ist kein Grund, den ganzen Upload zu werfen. */
async function jsonOrNull(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Eine 4xx nennt einen Grund, den der Composer erklaeren kann; alles andere ist ein Fehler. */
function failureKind(status: number): "tooLarge" | "forbidden" | "failed" {
  if (status === 413) return "tooLarge";
  if (status === 400 || status === 403 || status === 404 || status === 409) return "forbidden";
  return "failed";
}

/** Die `@`-Erwaehnungen der Anhaenge, in der Syntax des Composer-Menues. */
export function uploadReferences(files: ReadonlyArray<{ path: string }>): string {
  return buildFileAtMentionsText(files.map((file) => file.path));
}

/**
 * Haengt die Erwaehnungen an die Nachricht, die das Modell sieht.
 *
 * Die SDK liest `@pfad`-Erwaehnungen aus dem Prompt und loest sie relativ zum
 * `cwd` auf (`extractFileMentions`); ein absoluter Pfad ginge auch, ein
 * relativer ist aber die Form, die der Composer ueberall erzeugt. Einen
 * Zeilenbereich (`@pfad:12-14`) darf man hier **nicht** anhaengen: die
 * Auto-Read-Aufloesung kennt den Suffix nicht und findet dann nichts.
 *
 * Ein Anhang, den der Entwurf schon erwaehnt, wird **nicht** ein zweites Mal
 * angehaengt. Sonst stand im Prompt `… Output nothing else. @sample.csv
 * @sample.csv` — gemessen, nicht vermutet.
 */
export function appendUploadReferences(message: string, files: ReadonlyArray<{ path: string }>): string {
  if (files.length === 0) return message;
  const missing = files.filter((file) => !messageMentionsFile(message, file.path));
  if (missing.length === 0) return message;
  const references = uploadReferences(missing).trimEnd();
  const trimmed = message.trimEnd();
  return trimmed ? `${trimmed} ${references}` : references;
}

/**
 * Dieselbe Form, die die SDK beim Senden liest: `@pfad`, `@"pfad"`, `@'pfad'`,
 * ein `@` nur an einer Wortgrenze, und das Stripping von Satzzeichen.
 *
 * Ein `message.includes("@sample.csv")` waere zu grob: es haelt
 * `@sample.csv.bak` fuer `sample.csv` und laesst den echten Anhang fallen.
 * Ein Vergleich nur gegen die unquotierte Form waere zu eng und haengte einen
 * zweiten Verweis an, sobald der Entwurf `@"zwei worte.csv"` schon enthaelt.
 * Verglichen wird deshalb der **Pfad nach dem Auspacken** aus der Erwaehnung,
 * exakt und in jeder der drei Formen.
 */
const FILE_MENTION_PATTERN = /@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/g;
const MENTION_BOUNDARY_PATTERN = /[\s([{<"'`]/;
const LEADING_MENTION_PUNCTUATION = /^[`"'([{<]+/;
const TRAILING_MENTION_PUNCTUATION = /[)\]}>.,;:!?"'`]+$/;

function messageMentionsFile(message: string, filePath: string): boolean {
  for (const match of message.matchAll(FILE_MENTION_PATTERN)) {
    const at = match.index ?? 0;
    if (at > 0 && !MENTION_BOUNDARY_PATTERN.test(message[at - 1])) continue;
    const path = (match[1] ?? match[2] ?? match[3] ?? "")
      .trim()
      .replace(LEADING_MENTION_PUNCTUATION, "")
      .replace(TRAILING_MENTION_PUNCTUATION, "")
      .trim();
    if (path === filePath) return true;
  }
  return false;
}

/** Groesse fuer den Chip: „820 B", „12 kB", „3,4 MB", „1,2 GB" ohne Nachkommastellen zu viel. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kilobytes = bytes / 1024;
    return `${kilobytes < 10 ? kilobytes.toFixed(1) : Math.round(kilobytes)} kB`;
  }
  const megabytes = bytes / (1024 * 1024);
  if (megabytes < 1024) {
    return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
  }
  const gigabytes = megabytes / 1024;
  return `${gigabytes < 10 ? gigabytes.toFixed(1) : Math.round(gigabytes)} GB`;
}
