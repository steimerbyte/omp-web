import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  MAX_PRESENT_EXCERPT_CHARS,
  MAX_PRESENT_ITEMS,
  MAX_PRESENT_SNIFFABLE_BYTES,
  PRESENT_EXCERPT_READ_BYTES,
  PRESENT_SNIFF_BYTES,
  classifyPresentKind,
  hasPresentExcerpt,
  shouldSniffPresentKind,
  type PresentItem,
  type PresentKind,
} from "./present-files";

/** What the model is allowed to hand in per item. */
export interface PresentItemInput {
  path: string;
  caption?: string;
  /** Open this card's preview immediately — for the one file that matters. */
  open?: boolean;
}

/**
 * Trim, normalize separators, drop entries without a path, de-duplicate, cap.
 *
 * The backslash fold matters: Windows models routinely emit `a\b\c.png`, which
 * is one filename on their side and three path segments on this one.
 */
export function normalizePresentItems(
  raw: unknown,
  max: number = MAX_PRESENT_ITEMS,
): PresentItemInput[] {
  if (!Array.isArray(raw)) return [];

  const out: PresentItemInput[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    if (!("path" in entry) || typeof entry.path !== "string") continue;

    const trimmed = entry.path.trim();
    if (!trimmed) continue;
    const normalized = trimmed.replace(/\\/g, "/");
    if (seen.has(normalized)) continue;

    seen.add(normalized);
    out.push({
      path: normalized,
      caption: "caption" in entry && typeof entry.caption === "string" ? entry.caption : undefined,
      open: "open" in entry && entry.open === true,
    });
    if (out.length >= max) break;
  }
  return out;
}

/** Read the head of a file, or `null` when it cannot be read at all. */
async function readHead(abs: string, bytes: number): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(abs, "r");
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    // Unreadable content is not an error: the card still has a name and a
    // download button, which is what the user came for.
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Does this head look like text?
 *
 * A NUL byte or a high share of control characters is what separates a source
 * file from a binary that merely has no extension. UTF-8 text never contains
 * either, so one is enough to decide.
 */
export function headLooksLikeText(head: Buffer): boolean {
  if (head.length === 0) return false;
  const sample = head.subarray(0, Math.min(head.length, PRESENT_SNIFF_BYTES));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    // Control characters other than tab, newline, carriage return, form feed.
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) suspicious += 1;
  }
  return suspicious / sample.length < 0.05;
}

/** Decode a UTF-8 head, dropping anything after an incomplete sequence. */
export function decodePresentHead(head: Buffer): string {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const decoded = decoder.decode(head).replace(/�+$/, "").replace(/\u0000+$/, "");
  return decoded;
}

/** Tracks the excerpt budget across one call. */
export interface ExcerptBudget {
  left: number;
}

/** Attach a text excerpt if the kind and the budget allow it. */
export async function attachPresentExcerpt(
  item: PresentItem,
  budget: ExcerptBudget,
): Promise<void> {
  if (!hasPresentExcerpt(item.kind) && item.kind !== "binary") return;
  if (item.size === undefined || item.size === 0) return;
  if (item.size > MAX_PRESENT_SNIFFABLE_BYTES || budget.left <= 0) return;

  const head = await readHead(item.abs, PRESENT_EXCERPT_READ_BYTES);
  if (!head || head.length === 0) return;

  if (shouldSniffPresentKind(item.kind)) {
    if (!headLooksLikeText(head)) return;
    // The extension said nothing and the content says text: upgrade the card
    // so the preview opens in the text viewer instead of the binary path.
    item.kind = "text";
  }

  const text = decodePresentHead(head);
  if (!text) return;

  const cap = Math.min(MAX_PRESENT_EXCERPT_CHARS, budget.left);
  const clipped = text.length > cap;
  item.excerpt = clipped ? text.slice(0, cap) : text;
  item.excerptTruncated = clipped || item.size > head.length;
  budget.left -= item.excerpt.length;
}

/**
 * stat + classify + optional sniff + optional excerpt, for one path.
 *
 * Never throws: a path that does not exist produces a `missing` card rather
 * than an error, because "that file is not there" is information the user wants
 * to see next to the files that did arrive.
 */
export async function probePresentItem(
  raw: PresentItemInput,
  cwd: string,
  budget: ExcerptBudget,
): Promise<PresentItem> {
  const resolved = raw.path.startsWith("/") ? raw.path : `${cwd.replace(/\/+$/, "")}/${raw.path}`;
  const abs = resolved.replace(/\/+/g, "/");
  const name = basename(abs) || raw.path;

  const base: PresentItem = { path: raw.path, abs, name, kind: "missing", caption: raw.caption };

  let stats;
  try {
    stats = await stat(abs);
  } catch {
    return base;
  }

  if (stats.isDirectory()) {
    return { ...base, kind: "dir", mtime: stats.mtimeMs };
  }
  if (!stats.isFile()) return base;

  const item: PresentItem = {
    ...base,
    kind: classifyPresentKind(name) as PresentKind,
    size: stats.size,
    mtime: stats.mtimeMs,
  };
  await attachPresentExcerpt(item, budget);
  return item;
}