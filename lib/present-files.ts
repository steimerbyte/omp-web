import { getFileExt } from "./file-types";

/**
 * The card kinds a presented file can have.
 *
 * `missing` and `dir` are not content kinds — they are outcomes, and they get
 * a card too so the user sees *why* nothing appeared instead of a card list
 * that silently shrank.
 */
export type PresentKind =
  | "image"
  | "video"
  | "audio"
  | "text"
  | "markdown"
  | "html"
  | "pdf"
  | "binary"
  | "dir"
  | "missing";

/** One card's worth of data. Rendered by `components/PresentFiles.tsx`. */
export interface PresentItem {
  /** Path as it came back from the tool call, workspace-relative or absolute. */
  path: string;
  /** Linear absolute path — what the file routes are addressed with. */
  abs: string;
  /** Basename, for the card heading. */
  name: string;
  kind: PresentKind;
  /** Byte size, absent when the path could not be stat'ed. */
  size?: number;
  /** mtime in ms, absent when the path could not be stat'ed. */
  mtime?: number;
  /** Short label the caller attached to this one file. */
  caption?: string;
  /** Text head, only for the textual kinds and only within the excerpt budget. */
  excerpt?: string;
  /** True when `excerpt` is shorter than the file's head. */
  excerptTruncated?: boolean;

}

/**
 * The `details` payload of a `present_files` tool result.
 *
 * This shape is deliberately the same one `pi-web-ui` produces for its own
 * `present_files` (verified against a real session entry), so a transcript
 * that crosses between the two applications keeps its cards.
 */
export interface PresentFilesDetails {
  title?: string;
  note?: string;
  items: PresentItem[];
}

/** One record of an untrusted `details` payload, as far as it can be trusted. */
function isPresentItemRecord(value: unknown): value is Record<string, unknown> & { abs: string; name: string; kind: string } {
  if (typeof value !== "object" || value === null) return false;
  if (!("abs" in value) || !("name" in value) || !("kind" in value)) return false;
  return typeof value.abs === "string" && typeof value.name === "string" && typeof value.kind === "string";
}

/**
 * Recognize the payload without trusting it.
 *
 * `details` travels through the session file and the SSE stream, so it is
 * untrusted input — a hand-edited transcript or an older tool version must not
 * be able to make the renderer read properties off `undefined`. Every field the
 * card touches is therefore checked here, and the narrowing is done with `in`
 * rather than an assertion, so the type follows from the check instead of from
 * a claim.
 */
export function isPresentFilesDetails(value: unknown): value is PresentFilesDetails {
  if (typeof value !== "object" || value === null) return false;
  if (!("items" in value)) return false;
  const { items } = value;
  if (!Array.isArray(items)) return false;
  if (!items.every(isPresentItemRecord)) return false;
  if ("title" in value && value.title !== undefined && typeof value.title !== "string") return false;
  if ("note" in value && value.note !== undefined && typeof value.note !== "string") return false;
  return true;
}

/**
 * Recover the card payload from a tool result's `details`, in either shape.
 *
 * A first-class call carries the plain `{items:[…]}` payload. A call routed
 * through the `xd://` bridge — `write xd://present_files`, which is how a
 * `loadMode: "discoverable"` tool is reachable — arrives on a `write` toolCall
 * with that same payload buried under `xdev.inner`. Every transcript recorded
 * while the tool was discoverable holds the wrapped shape, so the card has to
 * keep rendering for them.
 *
 * Returns `null` when neither shape holds; `details` is untrusted input here
 * for the same reason it is in {@link isPresentFilesDetails}.
 */
export function unwrapPresentFilesDetails(value: unknown): PresentFilesDetails | null {
  if (isPresentFilesDetails(value)) return value;
  if (typeof value !== "object" || value === null || !("xdev" in value)) return null;
  const { xdev } = value;
  if (typeof xdev !== "object" || xdev === null || !("inner" in xdev)) return null;
  const { inner } = xdev;
  return isPresentFilesDetails(inner) ? inner : null;
}

/** `kind` of an untrusted record, or `binary` when it is not one we know. */
function presentKindOrBinary(kind: string): PresentKind {
  const known: Record<string, true> = {
    image: true, video: true, audio: true, text: true, markdown: true,
    html: true, pdf: true, binary: true, dir: true, missing: true,
  };
  return known[kind] ? (kind as PresentKind) : "binary";
}

/**
 * Turn an untrusted `details` value into cards, dropping entries that are not
 * usable rather than rendering half a card. Used by the chat renderer, which
 * reads persisted transcripts written by whichever version ran at the time.
 */
export function presentItemsFromDetails(details: PresentFilesDetails): PresentItem[] {
  return details.items.map((item) => ({
    path: item.path,
    abs: item.abs,
    name: item.name,
    kind: presentKindOrBinary(item.kind),
    size: typeof item.size === "number" ? item.size : undefined,
    mtime: typeof item.mtime === "number" ? item.mtime : undefined,
    caption: typeof item.caption === "string" ? item.caption : undefined,
    excerpt: typeof item.excerpt === "string" ? item.excerpt : undefined,
    excerptTruncated: item.excerptTruncated === true,
  }));
}

const MARKDOWN_EXTS: Record<string, true> = {
  md: true,
  markdown: true,
  mdx: true,
};

const HTML_EXTS: Record<string, true> = {
  html: true,
  htm: true,
  xhtml: true,
};

const VIDEO_EXTS: Record<string, true> = {
  mp4: true,
  webm: true,
  mov: true,
  m4v: true,
  mkv: true,
  ogv: true,
};

const AUDIO_EXTS: Record<string, true> = {
  mp3: true,
  wav: true,
  ogg: true,
  oga: true,
  m4a: true,
  flac: true,
  aac: true,
  opus: true,
  weba: true,
};

const TEXT_EXTS: Record<string, true> = {
  txt: true,
  log: true,
  json: true,
  jsonl: true,
  yaml: true,
  yml: true,
  toml: true,
  ini: true,
  cfg: true,
  conf: true,
  csv: true,
  tsv: true,
  ts: true,
  tsx: true,
  js: true,
  jsx: true,
  mjs: true,
  cjs: true,
  py: true,
  rb: true,
  go: true,
  rs: true,
  java: true,
  kt: true,
  c: true,
  h: true,
  cc: true,
  cpp: true,
  hpp: true,
  cs: true,
  php: true,
  sh: true,
  bash: true,
  zsh: true,
  sql: true,
  xml: true,
  css: true,
  scss: true,
  less: true,
  env: true,
  gitignore: true,
  dockerfile: true,
  makefile: true,
  diff: true,
  patch: true,
  tex: true,
  rst: true,
};

/**
 * Classify by extension. Never touches the filesystem — the caller stats first
 * and only reaches here for something that exists.
 *
 * Unknown extensions fall through to `binary`, which is the safe answer: the
 * card then offers download only, and `present_files` sniffs the first few KB
 * to upgrade it to `text` when the content turns out to be readable.
 */
export function classifyPresentKind(name: string): PresentKind {
  const ext = getFileExt(name);

  if (MARKDOWN_EXTS[ext]) return "markdown";
  if (HTML_EXTS[ext]) return "html";
  if (ext === "pdf") return "pdf";
  if (VIDEO_EXTS[ext]) return "video";
  if (AUDIO_EXTS[ext]) return "audio";
  if (TEXT_EXTS[ext]) return "text";

  return IMAGE_EXT_NAMES.has(ext) ? "image" : "binary";
}

/** Image extensions, listed separately so `classifyPresentKind` stays flat. */
const IMAGE_EXT_NAMES = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg", "tif", "tiff", "heic", "heif",
]);

/** Kinds whose file head is worth reading for a card excerpt. */
export function hasPresentExcerpt(kind: PresentKind): boolean {
  return kind === "text" || kind === "markdown" || kind === "html";
}

/** Kinds worth sniffing to find out whether `binary` is really text. */
export function shouldSniffPresentKind(kind: PresentKind): boolean {
  return kind === "binary";
}

/** Human-readable size, shared by the tool text and the card. */
export function formatPresentBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** Entry cap. Beyond this it stops being "here is something for you". */
export const MAX_PRESENT_ITEMS = 12;
/** Characters of excerpt per item. */
export const MAX_PRESENT_EXCERPT_CHARS = 1200;
/** Characters of excerpt across one call — `details` rides along in every snapshot. */
export const MAX_PRESENT_EXCERPT_TOTAL_CHARS = 6000;
/** Bytes of the file head an excerpt is read from (3 bytes per CJK glyph). */
export const PRESENT_EXCERPT_READ_BYTES = 8192;
/** Bytes sniffed to decide whether an unknown extension is text. */
export const PRESENT_SNIFF_BYTES = 4096;
/** Above this, no content is read — an excerpt of a 200 MB log says nothing. */
export const MAX_PRESENT_SNIFFABLE_BYTES = 4 * 1024 * 1024;