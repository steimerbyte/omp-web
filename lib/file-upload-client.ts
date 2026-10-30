import { buildFileAtMentionsText } from "./file-fuzzy";
import { encodeFilePathForApi } from "./file-paths";

/**
 * Der Client-Teil des Dateianhaengs im Composer.
 *
 * Der Upload selbst ist vorhanden: `POST /api/files/[...path]?type=upload`
 * schreibt multipart in das Verzeichnis aus dem URL-Pfad und prueft es gegen
 * Read- **und** Schreib-Allowlist (`getUploadDirectory`, doppeltes `realpath`).
 * Hier steht nur, was der Composer davon braucht: die URL, die Strategie und
 * die Uebersetzung der Antwort in Chip oder Meldung.
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
 * 8 MB je Datei, clientseitig geprueft.
 *
 * Die Route erlaubt 25 MB, aber der Next-Proxy klont den Body bei
 * `proxyClientMaxBodySize` (32 MB) und **schneidet** oberhalb davon ab, statt
 * abzulehnen — ein groesserer Upload endet deshalb nicht in einer 413 der
 * Route, sondern in einem abgeschnittenen Multipart-Body. Unter dieser Grenze
 * bleibt der Fehlerfall eine erklaerte Meldung; die Servergrenze bleibt die
 * zweite, nicht die erste Verteidigung.
 */
export const MAX_CHAT_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Dieselbe Grenze als Text, damit Meldung und Pruefung nicht getrennt altern. */
export const MAX_CHAT_UPLOAD_LABEL = "8 MB";

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
 * Ein Request je Datei: so bleibt die Groessengrenze eine Grenze pro Datei,
 * und ein Fehlschlag trifft nicht die anderen Anhaenge. Der Dateiname kommt
 * aus der Antwort der Route, nicht aus einer Vermutung des Clients.
 */
export async function uploadFileToCwd(cwd: string, file: File): Promise<UploadOutcome> {
  // Vor dem Request, nicht danach: die Proxy-Grenze (s.o.) macht aus einem zu
  // grossen Body einen abgeschnittenen, und der Fehler waere dann nicht mehr
  // erklaerbar.
  if (file.size > MAX_CHAT_UPLOAD_BYTES) {
    return { ok: false, kind: "tooLarge", error: `Files must be ${MAX_CHAT_UPLOAD_LABEL} or smaller` };
  }

  const form = new FormData();
  form.append("files", file, file.name);

  let response: Response;
  try {
    response = await fetch(
      `/api/files/${encodeFilePathForApi(cwd)}?type=upload&conflict=skip`,
      { method: "POST", body: form },
    );
  } catch (error) {
    return { ok: false, kind: "failed", error: error instanceof Error ? error.message : String(error) };
  }

  const body = await response.json().catch(() => null) as
    | { uploaded?: string[]; skipped?: string[]; errors?: Array<{ name: string; error: string }>; error?: string }
    | null;

  if (!response.ok) {
    const kind = response.status === 413
      ? "tooLarge"
      : response.status === 400 || response.status === 403 || response.status === 404 || response.status === 409
        ? "forbidden"
        : "failed";
    return { ok: false, kind, error: body?.error ?? `HTTP ${response.status}` };
  }

  if (body?.errors?.length) {
    return { ok: false, kind: "failed", error: body.errors[0]?.error ?? "The file could not be written" };
  }
  if (body?.skipped?.includes(file.name)) {
    return { ok: false, kind: "conflict", name: file.name, error: "A file with that name already exists" };
  }
  if (!body?.uploaded?.includes(file.name)) {
    return { ok: false, kind: "failed", error: "The server reported no uploaded file" };
  }

  return { ok: true, file: { name: file.name, size: file.size, path: file.name } };
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

/** Groesse fuer den Chip: „820 B", „12 kB", „3,4 MB" ohne Nachkommastellen zu viel. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kilobytes = bytes / 1024;
    return `${kilobytes < 10 ? kilobytes.toFixed(1) : Math.round(kilobytes)} kB`;
  }
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
}
