import { createReadStream, existsSync } from "fs";
import { StringDecoder } from "string_decoder";
import { readArchivedIds } from "./session-archive";
import { listAllSessions } from "./session-reader";
import type { WebIdentity } from "./request-identity";

/**
 * Die Volltextsuche ueber Session-Transkripte.
 *
 * ### Warum das ein eigener Leser ist und kein zweiter Session-Scanner
 *
 * Der **Bestand** ist nicht die Aufgabe dieser Datei: welche Sessions es gibt,
 * wem sie gehoeren und welche archiviert sind, beantwortet `listAllSessions`
 * (`lib/session-reader.ts`) mit genau der Regel, die auch `GET /api/sessions`
 * benutzt. Hier wird nur der Inhalt der Dateien gelesen, die jene Funktion
 * bereits fuer sichtbar erklaert hat. Ein eigener Verzeichnis-Scan waere eine
 * zweite Fassung der Besitzgrenze — und die eine, die irgendwann auseinander
 * laeuft.
 *
 * ### Warum die Datei zeilenweise gelesen wird
 *
 * Ein Transkript kann hunderte Megabyte haben. `readFile` wuerde es komplett
 * in den Speicher ziehen, um eine Zeile darin zu finden. Der Leser arbeitet
 * deshalb als Strom: Chunks rein, Zeilen heraus, und sobald die Grenzen
 * ({@link MAX_SESSION_SEARCH_BYTES}, {@link MAX_SESSION_SEARCH_MS}) erreicht
 * sind, wird der Strom abgebrochen. Gelesen wird jedes Byte hoechstens einmal.
 *
 * ### Was als Treffer zaehlt
 *
 * Nur `type: "message"` mit Rolle `user` oder `assistant`, und darin nur die
 * Textteile — keine Tool-Aufrufe, keine Tool-Ergebnisse, keine Bash-Ausgaben,
 * kein Denken. Ein Kompaktierungs-`summary` zaehlt mit: nach einer
 * Kompaktierung ist er das, was vom alten Verlauf im Transkript steht.
 */

/** Treffer: eine Session und die erste Fundstelle in ihr. */
export interface SessionContentMatch {
  sessionId: string;
  title: string;
  cwd: string;
  projectRoot?: string;
  /** Zahl der passenden Nachrichten in dieser Session (bei 99 gekappt). */
  hits: number;
  /** Die erste Fundstelle mit Kontext, einzeilig. */
  snippet: string;
  /** Zeitstempel der letzten passenden Nachricht. */
  lastMatchedAt?: string;
}

export interface SessionSearchResult {
  matches: SessionContentMatch[];
  /** `true`, wenn eine der Grenzen die Suche vorzeitig beendet hat. */
  truncated: boolean;
  /** Zahl der tatsaechlich geoeffneten Session-Dateien. */
  scanned: number;
}

export interface SessionSearchOptions {
  /** Fuer den Test: kleineres Byte-Budget als {@link MAX_SESSION_SEARCH_BYTES}. */
  maxBytes?: number;
  /** Fuer den Test: kleineres Zeitbudget als {@link MAX_SESSION_SEARCH_MS}. */
  maxMs?: number;
  /** Fuer den Test: Uhr in Epoch-ms. */
  now?: () => number;
}

/** Hoechstzahl zurueckgegebener Treffer. */
export const MAX_SESSION_SEARCH_MATCHES = 25;

/**
 * Hoechstzahl Sessions, die ueberhaupt gelesen werden, bis ein Treffer faellt.
 *
 * Die Anzeige braucht nur {@link MAX_SESSION_SEARCH_MATCHES}; diese Grenze
 * begrenzt den Leseaufwand, wenn fast jede Session das Wort enthaelt.
 */
export const MAX_SESSION_SEARCH_SESSIONS = 40;

/** Hoechstzahl Bytes, die eine Suche zusammen liest. */
export const MAX_SESSION_SEARCH_BYTES = 64 * 1024 * 1024;

/** Hoechstdauer einer Suche in Millisekunden. */
export const MAX_SESSION_SEARCH_MS = 2000;

/**
 * Hoechstzahl gezaehlter Treffer pro Session.
 *
 * Die Zahl wird fuer die Anzeige nicht gebraucht; sie begrenzt nur, wie weit
 * eine einzelne Datei gelesen wird, wenn ein haeufiges Wort sie durchzieht.
 * 99 ist mehr, als jede Anzeige zeigt, und macht die Grenze sichtbar.
 */
export const MAX_SESSION_SEARCH_HITS_PER_SESSION = 99;

/** Die kuerzeste Suche, die noch sinnvoll ist. */
export const MIN_SESSION_SEARCH_QUERY_LENGTH = 2;

/** Die laengste Suche, die die Route annimmt. */
export const MAX_SESSION_SEARCH_QUERY_LENGTH = 100;

/** Zeichen Kontext links und rechts der Fundstelle im Ausschnitt. */
const SNIPPET_CONTEXT_CHARS = 80;

/**
 * Die Textteile einer Nachricht — `content` als String oder als Array aus
 * `{type:"text"}`-Teilen. Alles andere (Bilder, Denken, Tool-Aufrufe) faellt
 * weg, weil es kein durchsuchbarer Satz ist.
 */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const block = part as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * Der Ausschnitt um die erste Fundstelle: eine Zeile, mit begrenztem Kontext.
 *
 * Zuerst werden alle Leerraumfolgen zusammengezogen — ein Ausschnitt, der
 * mitten in einer Codeblock-Einrueckung beginnt, ist im Suchergebnis nicht zu
 * lesen. Geschnitten wird danach, damit die Grenze in Zeichen und nicht in
 * Zeilen gilt.
 */
function snippetAround(text: string, term: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const index = flat.toLowerCase().indexOf(term);
  const start = Math.max(0, index - SNIPPET_CONTEXT_CHARS);
  const end = Math.min(flat.length, index + term.length + SNIPPET_CONTEXT_CHARS);
  return flat.slice(start, end);
}

/**
 * Eine Zeile des Transkripts, wenn sie den Suchbegriff enthaelt.
 *
 * `term` ist bereits getrimmt und kleingeschrieben. Ein unlesbares JSON ist
 * keine Zeile dieses Formats — eine abgebrochene letzte Zeile soll die Suche
 * nicht scheitern lassen.
 */
function matchTranscriptLine(line: string, term: string): { snippet: string; timestamp?: string } | null {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof record !== "object" || record === null) return null;
  const raw = record as Record<string, unknown>;
  const timestamp = typeof raw.timestamp === "string" && raw.timestamp !== "" ? raw.timestamp : undefined;

  // Nach einer Kompaktierung ist der `summary` das, was vom alten Verlauf noch
  // im Transkript steht — er zaehlt deshalb als Fundstelle.
  if (raw.type === "compaction") {
    const summary = typeof raw.summary === "string" ? raw.summary : "";
    if (!summary || !summary.toLowerCase().includes(term)) return null;
    return { snippet: snippetAround(summary, term), ...(timestamp ? { timestamp } : {}) };
  }

  if (raw.type !== "message") return null;
  const message = raw.message;
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;
  if (messageRecord.role !== "user" && messageRecord.role !== "assistant") return null;

  const text = messageText(messageRecord.content);
  if (!text || !text.toLowerCase().includes(term)) return null;
  return { snippet: snippetAround(text, term), ...(timestamp ? { timestamp } : {}) };
}

/** Was ein einzelnes Transkript ergibt. */
interface FileScan {
  hits: number;
  snippet?: string;
  lastMatchedAt?: string;
  bytes: number;
  /** Eine Grenze hat den Leser abgebrochen; das Ergebnis ist unvollstaendig. */
  aborted: boolean;
}

/**
 * Eine Session-Datei lesen, bis der Begriff gefunden oder eine Grenze erreicht
 * ist. Hoechstens ein Durchlauf, Zeile fuer Zeile.
 */
async function scanSessionFile(
  path: string,
  term: string,
  limits: { bytesLeft: number; deadline: number; now: () => number },
): Promise<FileScan> {
  const stream = createReadStream(path);
  const decoder = new StringDecoder("utf8");
  let carry = "";
  let hits = 0;
  let snippet: string | undefined;
  let lastMatchedAt: string | undefined;
  let bytes = 0;
  let aborted = false;

  const consume = (line: string) => {
    if (!line.trim()) return;
    const found = matchTranscriptLine(line, term);
    if (!found) return;
    hits += 1;
    if (snippet === undefined) snippet = found.snippet;
    if (found.timestamp !== undefined) lastMatchedAt = found.timestamp;
  };

  try {
    for await (const chunk of stream) {
      bytes += (chunk as Buffer).length;
      carry += decoder.write(chunk as Buffer);
      let newline = carry.indexOf("\n");
      while (newline !== -1) {
        consume(carry.slice(0, newline));
        carry = carry.slice(newline + 1);
        if (hits >= MAX_SESSION_SEARCH_HITS_PER_SESSION) break;
        newline = carry.indexOf("\n");
      }
      if (hits >= MAX_SESSION_SEARCH_HITS_PER_SESSION) break;
      if (bytes > limits.bytesLeft) {
        aborted = true;
        break;
      }
      if (limits.now() >= limits.deadline) {
        aborted = true;
        break;
      }
    }
    if (!aborted) {
      carry += decoder.end();
      if (carry.trim()) consume(carry);
    }
  } finally {
    stream.destroy();
  }

  return { hits, snippet, lastMatchedAt, bytes, aborted };
}

/**
 * Alle Sessions durchsuchen, die das Konto sehen darf — neueste zuerst.
 *
 * Die Grenzen sind der Vertrag: 25 Treffer, 40 Sessions mit Treffern,
 * {@link MAX_SESSION_SEARCH_BYTES} und {@link MAX_SESSION_SEARCH_MS}. Wird eine
 * erreicht, sagt `truncated` das, und die Antwort enthaelt, was bis dahin
 * gefunden war. Eine abgebrochene Datei traegt **nichts** bei: eine halbe
 * Trefferzahl waere eine Zahl, die sich bei jedem zweiten Aufruf aendert.
 *
 * `query` kommt aus der Route und ist dort auf Laenge geprueft; dieser Leser
 * trimmt nur noch und vergleicht ohne Schreibung.
 */
export async function searchSessions(
  identity: WebIdentity,
  query: string,
  options: SessionSearchOptions = {},
): Promise<SessionSearchResult> {
  const term = query.trim().toLowerCase();
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? MAX_SESSION_SEARCH_BYTES;
  const deadline = now() + (options.maxMs ?? MAX_SESSION_SEARCH_MS);

  const archived = readArchivedIds();
  const ordered = (await listAllSessions({ identity }))
    .filter((session) => !archived.has(session.id))
    .sort((left, right) => right.modified.localeCompare(left.modified) || left.id.localeCompare(right.id));

  const matches: SessionContentMatch[] = [];
  let scanned = 0;
  let bytes = 0;
  let truncated = false;

  for (const session of ordered) {
    // Die Pruefung steht **vor** der Session: sie greift nur, wenn es noch
    // etwas zu lesen gaebe — sonst waere ein vollstaendiger Lauf als
    // abgeschnitten gemeldet.
    if (matches.length >= MAX_SESSION_SEARCH_SESSIONS || bytes >= maxBytes || now() >= deadline) {
      truncated = true;
      break;
    }
    if (!session.path || session.transient || !existsSync(session.path)) continue;

    scanned += 1;
    const outcome = await scanSessionFile(session.path, term, {
      bytesLeft: maxBytes - bytes,
      deadline,
      now,
    });
    bytes += outcome.bytes;
    if (outcome.aborted) {
      truncated = true;
      break;
    }
    if (outcome.hits === 0) continue;

    matches.push({
      sessionId: session.id,
      title: session.name || session.firstMessage || session.id,
      cwd: session.cwd,
      ...(session.projectRoot ? { projectRoot: session.projectRoot } : {}),
      hits: outcome.hits,
      snippet: outcome.snippet ?? "",
      ...(outcome.lastMatchedAt ? { lastMatchedAt: outcome.lastMatchedAt } : {}),
    });
  }

  // Die Anzeige bekommt die neuesten 25; alles darueber hiesse "abgeschnitten".
  if (matches.length > MAX_SESSION_SEARCH_MATCHES) truncated = true;
  return { matches: matches.slice(0, MAX_SESSION_SEARCH_MATCHES), truncated, scanned };
}
