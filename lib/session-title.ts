import { generateSessionTitle as generateOmpSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { buildReplanTitleContext } from "@oh-my-pi/pi-coding-agent/session/messages";
import { isLowSignalTitleInput } from "@oh-my-pi/pi-coding-agent/tiny/text";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionLike } from "./omp-types";

const MAX_TITLE_LENGTH = 80;

/**
 * A full 15 749 B compaction summary produced `null` and `"<chat>"`; its first
 * 2000 characters produced a title in ~200 ms (measured 2026-11-12).
 */
export const MAX_TITLE_SOURCE_LENGTH = 2000;

export interface GeneratedSessionTitle {
  title: string;
}

/** Plain text of a session message, ignoring images and tool blocks. */
function messageText(message: AgentMessage): string {
  const content = (message as { content: unknown }).content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: string }).type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** First user turn on the session's current branch. */
export function findFirstUserMessage(messages: readonly AgentMessage[]): string | undefined {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = messageText(message);
    if (text) return text;
  }
  return undefined;
}

/**
 * Text to base a session title on: the first operator turn that carries signal
 * (a turn attributed to `agent` is not the operator's), else the compaction
 * summary, else the raw first user turn so omp can decline it.
 *
 * omp's generator refuses greetings and other low-signal openers, and its own
 * caller retries on the next message; omp-web has no such loop, so it looks
 * ahead itself instead of handing omp a source that can only yield `null`.
 */
export function findFirstTitleSource(messages: readonly AgentMessage[]): string | undefined {
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (message.attribution === "agent") continue;
    const text = messageText(message);
    if (text && !isLowSignalTitleInput(text)) return text.slice(0, MAX_TITLE_SOURCE_LENGTH);
  }
  const summary = (messages as ReadonlyArray<{ role?: string; summary?: unknown }>)
    .find((m) => m.role === "compactionSummary" && typeof m.summary === "string")
    ?.summary as string | undefined;
  if (summary?.trim()) return summary.slice(0, MAX_TITLE_SOURCE_LENGTH);
  const userText = findFirstUserMessage(messages);
  return userText?.slice(0, MAX_TITLE_SOURCE_LENGTH);
}

export function truncateTitle(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  const characters = Array.from(trimmed);
  return characters.length > MAX_TITLE_LENGTH
    ? characters.slice(0, MAX_TITLE_LENGTH).join("").trim()
    : trimmed;
}

/**
 * Eine pictographische Sequenz: Grundzeichen mit optionalem Variantenselektor
 * und Hautton, ZWJ-Verbund (👨‍👩‍👧, 🏳️‍🌈), Tag-Sequenz (Schottland-Flagge),
 * Regional-Indicator-Paar (🇩🇪) oder Keycap (1️⃣). Laenger als ein Codepunkt,
 * damit ein Verbund als **ein** Emoji zaehlt und nicht in Einzelteile zerfaellt.
 */
const EMOJI_SEQUENCE =
  /(?:\p{Extended_Pictographic}[\uFE0E\uFE0F]?(?:\p{Emoji_Modifier})?[\u{E0020}-\u{E007F}]*(?:\u200D\p{Extended_Pictographic}[\uFE0E\uFE0F]?(?:\p{Emoji_Modifier})?)*|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3)/gu;

/** Der Titel ohne jedes Emoji; der Rest bleibt unveraendert. */
export function stripEmoji(text: string): string {
  return text.replace(EMOJI_SEQUENCE, "");
}

/** Das erste Emoji im Text als ganze Sequenz, oder `null`. */
export function firstEmoji(text: string): string | null {
  return text.match(EMOJI_SEQUENCE)?.[0] ?? null;
}

/**
 * Schluesselwoerter fuer den Fall, dass das Modell selbst keins geschrieben
 * hat. Die Reihenfolge ist die Prioritaet: "Deploy-Fix" ist ein Deploy.
 * Die sechs Themen unten wurden am 2026-11-18 an echten 💬-Titeln gemessen
 * (6 von 10 Emoji-Titeln auf agent-pc), nicht ausgedacht.
 */
export const TITLE_EMOJI_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(deploy|deployment|ship|release|rollout|ausroll|veröffentlich)\b/i, "🚀"],
  [/\b(bug|fix|fehler|behebe|repair|hotfix)\b/i, "🐛"],
  [/\b(test|tests|testing|spec|pytest|vitest|jest)\b/i, "✅"],
  [/\b(doc|docs|readme|doku|dokumentation|documentation)\b/i, "📘"],
  [/\b(calendar|kalender|termin|appointment|schedule|zeitplan)\b/i, "📅"],
  [/\b(newsletter|research|recherche|study|studie)\b/i, "🔎"],
  [/\b(audio|sound|musik|music|voice|sprache)\b/i, "🎧"],
  [/\b(search|suche|suchen|query|find|grep)\b/i, "🔍"],
  [/\b(review|prüfung|pruefung|audit|check)\b/i, "👀"],
  [/\b(plan|planung|design|architektur|architecture|konzept)\b/i, "📐"],
  [/\b(disk|festplatte|speicherplatz|storage)\b/i, "💽"],
  [/\b(sync|synchronisier|synchronize|abgleich|livesync)\b/i, "🔄"],
  [/\b(skill|skills|plugin|plugins|extension|extensions|imagegen|tool|tools)\b/i, "🧩"],
  [/\b(android|apk|adb|oneplus)\b/i, "📱"],
  [/\b(refactor|refactoring|cleanup|aufräumen|aufraeumen|rewrite)\b/i, "🧹"],
  [/\b(docker|k8s|kubernetes|container|pod|helm)\b/i, "📦"],
  [/\b(database|datenbank|sql|postgres|sqlite|migration)\b/i, "🗄️"],
  [/\b(ui|ux|frontend|front-end|css|layout)\b/i, "🎨"],
  [/\b(api|server|backend|endpoint|route)\b/i, "🔌"],
  [/\b(security|sicherheit|auth|login|anmeldung|oauth|token)\b/i, "🔐"],
  [/\b(money|billing|invoice|rechnung|zahlung|preis|kosten)\b/i, "💰"],
  [/\b(mail|email|e-mail|inbox|postfach)\b/i, "📧"],
  [/\b(config|configs|konfiguration|einstellungen|settings|context|model|models|llm)\b/i, "⚙️"],
  [/\b(chat|chats|conversation|unterhaltung|dialog|gespräch|gespraech|plaudern|reden|messaging)\b/i, "💬"],
];

/**
 * Kein Schluesselwort getroffen: eine neutrale Nadel, nicht die Sprechblase.
 * Gemessen 2026-11-18: 6 der 10 Emoji-Titel auf agent-pc trugen 💬, weil
 * nichts passte — die Blase las sich als "keine Ahnung" und ist fuer alles
 * ausser einem echten Gespraech das falsche Signal.
 */
const TITLE_EMOJI_FALLBACK = "📌";

/**
 * Emoji, die keine Themenwahl sind: ein Modell, das 💬 vor jedes Thema setzt,
 * hat nichts gewaehlt. Sie zaehlen wie "kein Emoji", damit die Tabelle greift.
 * Der Variantenselektor faellt beim Vergleich weg (🗨️ = 🗨).
 */
const GENERIC_TITLE_EMOJI: Record<string, true> = { "💬": true, "🗨": true, "🗣": true };

/** Das Emoji fuer einen Titel: das eigene des Modells, sonst eins aus der Tabelle. */
export function titleEmoji(text: string): string {
  const own = firstEmoji(text);
  if (own && !GENERIC_TITLE_EMOJI[own.replace(/\uFE0F/g, "")]) return own;
  const plain = stripEmoji(text);
  for (const [pattern, emoji] of TITLE_EMOJI_RULES) {
    if (pattern.test(plain)) return emoji;
  }
  return TITLE_EMOJI_FALLBACK;
}

/**
 * Ein erzeugter Titel, mit genau einem Emoji vorn — das Modell schreibt oft
 * keins, manchmal zwei. Der Text dahinter bleibt woertlich; gekuerzt wird er
 * erst nach dem Emoji, und die 80 Zeichen zaehlen Emoji und Leerzeichen mit.
 */
export function withSingleEmoji(title: string): string {
  const emoji = titleEmoji(title);
  const plain = stripEmoji(title).replace(/\s+/g, " ").trim();
  return truncateTitle(`${emoji} ${plain}`);
}

const SENTINEL_TITLE = /^(none|null|undefined)$/i;

/** A model answer that could be written as a session name: no markup, no sentinel, some letter or digit. */
export function isUsableSessionTitle(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.includes("<") || trimmed.includes(">")) return false;
  if (SENTINEL_TITLE.test(trimmed)) return false;
  return /[\p{L}\p{N}]/u.test(trimmed);
}

/** Retry source for a declined title: the SDK's replan envelope, or `undefined` when it adds nothing. */
export function replanTitleSource(messages: AgentMessage[], firstSource: string): string | undefined {
  const context = buildReplanTitleContext(messages);
  return context && context !== firstSource ? context : undefined;
}

/**
 * System prompt for the title model. The SDK appends its `<title>` marker
 * instruction to every custom prompt (`title-generator.ts:319`), so this only
 * states the task and the emoji rule. Without it the model wrote no emoji at
 * all — 81 of 91 auto titles on the production host on 2026-11-18 — and every
 * emoji on disk came from the keyword table. The emoji list stays short on
 * purpose: a long palette invites the model to echo it instead of choosing.
 */
export const TITLE_SYSTEM_PROMPT = `You name coding-agent sessions. Write a 3-6 word title for the task in the next message, starting with exactly one emoji that fits that specific subject.

Pick the emoji from what the session is about — the build or code, a bug, a deploy, docs, data, a design, hardware, security, media, a schedule, research — not a default. A speech bubble 💬 is wrong unless the session is literally about chat, conversation or messaging. Vary the emoji across topics, and pick the closest one rather than declining when nothing fits perfectly.

Rules:
- Name the user's goal as a short imperative phrase built from the user's own key words (the feature, component, or error they name). Avoid vague filler like "logic", "issues", "functionality".
- \`[Image #N, WxH]\` marks an image you cannot see. Never mention it or guess what it shows; title the task the surrounding words name.
- Answer \`<title/>\` for greetings, acknowledgements, gibberish, or requests too vague to name without context you cannot see ("help", "fix this", "what's wrong?").
- A \`<chat>\` block summarizes a longer session: its first \`<user>\` turn is the opening request, followed by recent turns (often the assistant's working notes). Title the goal the session is working on, using the opening request unless later turns clearly moved to a new task; never title the current micro-step, and ignore file names and symbols unless they are the subject.
- No quotes, trailing punctuation, or explanations.

Examples:
- "the retry queue drops jobs when redis restarts, can u look" → \`<title>🐛 Fix retry queue dropping jobs</title>\`
- "can we get rid of the npm run build warning about peer deps" → \`<title>🔨 Remove peer dependency build warning</title>\`
- "deploy the billing service and watch the rollout" → \`<title>🚀 Deploy billing service and watch rollout</title>\``;

/**
 * Name a session using omp's own title generator.
 *
 * omp titles sessions with the `tiny` → `commit` → `smol` role chain (or the
 * configured local tiny model), so a title generated from the browser costs the
 * same as one generated in the TUI and never burns the session's primary model.
 * Returns `null` when omp declines to title — greetings and other low-signal
 * first messages are declined on purpose, and the browser's automatic attempt
 * is one-shot — and when the answer is unusable (see `isUsableSessionTitle`):
 * the two are reported the same way, because both mean "no title yet".
 * A declined source is retried once with `buildReplanTitleContext(messages)`.
 * Every accepted title carries exactly one leading emoji, chosen by
 * `withSingleEmoji` — user renames never go through here.
 *
 * `fallbackSource` covers the opening prompt of a brand-new session: omp
 * persists a user message on `message_end`, so the context is still empty right
 * after the prompt is sent, and the wrapper passes that prompt here. The
 * context's own first message always wins, so a reopened session is titled from
 * its real first turn and never from a later prompt. The manual button passes
 * no fallback at all.
 */
export async function generateSessionTitle(
  session: AgentSessionLike,
  fallbackSource?: string,
): Promise<GeneratedSessionTitle | null> {
  const context = session.sessionManager.buildSessionContext();
  const fallback = fallbackSource?.trim();
  const firstMessage = findFirstTitleSource(context.messages)
    ?? (fallback ? fallback.slice(0, MAX_TITLE_SOURCE_LENGTH) : undefined);
  if (!firstMessage) {
    throw new Error("The session has no user messages to name");
  }

  let title = await generateOmpSessionTitle(
    firstMessage,
    session.modelRegistry as never,
    session.settings,
    session.sessionId,
    session.model as never,
    undefined,
    TITLE_SYSTEM_PROMPT,
  );
  if (!title) {
    // omp's own retry waits for the next user message, which the browser cannot
    // rely on, so a declined opener gets one second chance with the `<chat>` envelope
    // AgentSession feeds its title model after a replan (not hand-rolled text).
    // Measured 2026-11-12 (prod host): 18 of the last 19 such sessions recovered.
    const replan = replanTitleSource(context.messages, firstMessage);
    if (replan) {
      title = await generateOmpSessionTitle(
        replan,
        session.modelRegistry as never,
        session.settings,
        session.sessionId,
        session.model as never,
        undefined,
        TITLE_SYSTEM_PROMPT,
      );
    }
  }
  if (!title) return null;

  const cleaned = truncateTitle(title);
  // omp's parser counts a markup answer as a success, so its fallback model
  // never gets a turn: a garbage answer must stay a decline, not a 500.
  // Measured 2026-11-12: the tiny→commit→smol chain (buds-gateway/qwen3.8-27b)
  // answered `<chat>` for 5 of 109 real sessions, URL-first openers among them.
  if (!isUsableSessionTitle(cleaned)) return null;
  return { title: withSingleEmoji(cleaned) };
}
