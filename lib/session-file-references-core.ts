import type { AgentMessage, SessionEntry } from "./types";

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionId(sessionId: string | null): sessionId is string {
  return !!sessionId && SESSION_ID_RE.test(sessionId);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function isPathChar(ch: string): boolean {
  return /[A-Za-z0-9._~+%@/\\:-]/.test(ch);
}

function hasReferenceBoundaryAfter(text: string, index: number): boolean {
  if (index >= text.length) return true;
  const ch = text[index];
  if (ch === ":") return /\d/.test(text[index + 1] ?? "");
  return !isPathChar(ch);
}

function containsExactPathReference(text: string, filePath: string): boolean {
  const target = normalizeSlashes(filePath);
  const targets = target.startsWith("/") ? [target, `file://${target}`] : [target];
  const haystacks = new Set([normalizeSlashes(text), normalizeSlashes(safeDecode(text))]);

  for (const haystack of haystacks) {
    for (const t of targets) {
      let index = haystack.indexOf(t);
      while (index !== -1) {
        const before = index === 0 ? "" : haystack[index - 1];
        const afterIndex = index + t.length;
        if ((index === 0 || !isPathChar(before)) && hasReferenceBoundaryAfter(haystack, afterIndex)) {
          return true;
        }
        index = haystack.indexOf(t, index + 1);
      }
    }
  }

  return false;
}

/**
 * Pfadfelder eines **Werkzeugaufrufs**. Nur diese Felder gelten als Referenz.
 *
 * ### Die Regel, und warum sie so eng ist
 *
 * Freischalten darf nur, was ein Werkzeug **als Pfad angefordert** hat: der
 * `path` von `read`/`edit`/`write`, der `cwd` von `bash`, der `source` von
 * `ssh_scp`. Das ist die Beobachtung hinter dem Durchlass — der Agent hat an
 * dieser Datei gearbeitet, also darf der Mandant sie ansehen.
 *
 * Ein Fließtext-Erwähnen ist keine Referenz. Die alte Fassung sammelte per
 * `collectStrings` **jeden** String des Eintrags rekursiv und machte einen
 * Substring-Test: Message-Text, `thinking`, Tool-Argumente *und* Tool-Ausgabe.
 * Damit war der Durchlass keine Referenz, sondern eine Volltextsuche über die
 * Session. Zwei Folgen, beide belegt an echtem Bestand:
 *
 * 1. **Fließtext.** Ein Agent, der „schau mal `/etc/passwd`" schreibt, hat den
 *    Pfad genannt. Das ist eine Absichtserklaerung im Chat, kein Zugriff.
 * 2. **Tool-Ausgabe.** Liest ein Agent *irgendeine* Datei — ein Log, eine
 *    Fehlermeldung, ein `grep`-Treffer — und steht in ihr `/etc/shadow`, so ist
 *    danach **jeder** Pfad aus dieser Datei sessionreferenziert. Ein einziger
 *    gelesener Log macht die Allowlist dieses Mandanten Wirkungslos; die
 *    Werkzeugausgabe ist der beste Weg dorthin, weil sie per Definition fremde
 *    Inhalte transportiert.
 *
 * Der Katalog ist deshalb eine Liste benannter Felder mit **keinem
 * Default**: ein Werkzeug, das nicht in der Liste steht, traegt nichts bei. Eine
 * Werkzeug-Erweiterung aus dem Plugin-Markt bekommt ihre Freischaltung also erst
 * mit einem Eintrag hier — sichtbar, mit Absicht, im Diff.
 *
 * Die Felderamen sind am echten Bestand abgeglichen (1644 Session-Dateien,
 * 116451 `toolCall`-Bloecke), nicht geraten. Die Bloecke schreiben `name` und
 * `arguments`; `lib/types.ts` beschreibt noch die aeltere Form `toolName` und
 * `input`. Beide werden gelesen, sonst haengt die Referenz an der Form statt an
 * der Sache.
 */
const TOOL_CALL_PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  read: ["path"],
  edit: ["path"],
  write: ["path"],
  grep: ["path"],
  glob: ["path"],
  find: ["path"],
  bash: ["cwd"],
  eval: ["path"],
  inspect_image: ["path"],
  ssh_read: ["path"],
  ssh_write: ["path"],
  ssh_edit: ["path"],
  ssh_scp: ["source", "destination"],
};

/**
 * Pfadfelder eines **Werkzeugergebnisses**, also Felder, die die Laufzeit selbst
 * schreibt und nicht der Agent: `details.resolvedPath` von `write` ist das
 * aufgeloeste Ziel, `details.path` von `edit` der bestaetigte Pfad. Sie decken
 * den Fall ab, in dem der Aufruf relativ war und erst das Ergebnis absolut ist.
 *
 * `displayContent`, `output`, `oldText`, `newText`, `files` und `diff` stehen
 * hier bewusst nicht: das sind Inhalte, die ein Agent gelesen hat, und der
 * ganze Sinn dieser Verengung ist, Inhalte nicht als Referenz zu zaehlen.
 */
const TOOL_RESULT_PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  read: ["resolvedPath", "mediaPath"],
  write: ["resolvedPath"],
  edit: ["path"],
  grep: ["scopePath", "searchPath"],
  glob: ["scopePath"],
  find: ["scopePath"],
  ssh_read: ["path"],
  ssh_write: ["path"],
  ssh_scp: ["source", "destination"],
  inspect_image: ["imagePath"],
  run_experiment: ["runDirectory", "benchmarkLogPath", "fullOutputPath"],
};

function recordOf(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Die benannten Felder eines Objekts, sofern sie Strings sind. */
function pathFieldsOf(fields: readonly string[] | undefined, source: unknown): string[] {
  const record = recordOf(source);
  if (!record || !fields) return [];
  const values: string[] = [];
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) values.push(value);
  }
  return values;
}

/** Alle strukturierten Pfadfelder einer Nachricht, sonst nichts. */
function structuredPathValues(message: AgentMessage): string[] {
  const values: string[] = [];
  if (message.role === "bashExecution") {
    if (message.fullOutputPath) values.push(message.fullOutputPath);
    return values;
  }
  if (message.role === "toolResult") {
    return message.toolName
      ? pathFieldsOf(TOOL_RESULT_PATH_FIELDS[message.toolName], message.details)
      : values;
  }
  if (message.role !== "assistant") return values;
  for (const block of message.content) {
    const record = recordOf(block);
    if (!record || record.type !== "toolCall") continue;
    const toolName = typeof record.toolName === "string"
      ? record.toolName
      : typeof record.name === "string" ? record.name : null;
    if (!toolName) continue;
    values.push(...pathFieldsOf(TOOL_CALL_PATH_FIELDS[toolName], record.input ?? record.arguments));
  }
  return values;
}

export function isFilePathReferencedByEntries(filePath: string, entries: SessionEntry[]): boolean {
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    for (const candidate of structuredPathValues(entry.message)) {
      if (containsExactPathReference(candidate, filePath)) return true;
    }
  }
  return false;
}

export function isBashOutputPathReferencedByEntries(filePath: string, entries: SessionEntry[]): boolean {
  return entries.some((entry) => (
    entry.type === "message"
    && entry.message.role === "bashExecution"
    && entry.message.fullOutputPath === filePath
  ));
}
