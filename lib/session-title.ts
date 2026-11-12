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
 * Name a session using omp's own title generator.
 *
 * omp titles sessions with the `tiny` → `commit` → `smol` role chain (or the
 * configured local tiny model), so a title generated from the browser costs the
 * same as one generated in the TUI and never burns the session's primary model.
 * Returns `null` when omp declines to title — greetings and other low-signal
 * first messages are deliberately left unnamed until the next real turn — and
 * when the answer is unusable (see `isUsableSessionTitle`): the two are
 * reported the same way, because both mean "no title yet".
 * A declined source is retried once with `buildReplanTitleContext(messages)`.
 */
export async function generateSessionTitle(
  session: AgentSessionLike,
): Promise<GeneratedSessionTitle | null> {
  const context = session.sessionManager.buildSessionContext();
  const firstMessage = findFirstTitleSource(context.messages);
  if (!firstMessage) {
    throw new Error("The session has no user messages to name");
  }

  let title = await generateOmpSessionTitle(
    firstMessage,
    session.modelRegistry as never,
    session.settings,
    session.sessionId,
    session.model as never,
  );
  if (!title) {
    // omp's own retry waits for the next user message; a web session sends none,
    // so a declined opener gets one second chance with the `<chat>` envelope
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
  return { title: cleaned };
}
