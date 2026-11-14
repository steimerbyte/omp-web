import type { AgentMessage, AssistantContentBlock, AssistantMessage, ThinkingContent, ToolCallContent } from "./types";

export interface DisplayOptions {
  isStreaming?: boolean;
  /** omp's `hideThinkingBlock` setting: drop thinking blocks entirely. */
  hideThinking?: boolean;
  /** Surface switch for custom messages the harness marked `display: false`. */
  showHiddenMessages?: boolean;
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === "";
}

/** True for blocks the transcript must not render at all. */
export function isHiddenAssistantBlock(block: AssistantContentBlock, options: DisplayOptions = {}): boolean {
  if (options.hideThinking && block.type === "thinking") return true;
  return isEmptyThinkingBlock(block, options);
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => !isHiddenAssistantBlock(block, options));
}

export function getAssistantErrorMessage(
  message: AssistantMessage,
  options: DisplayOptions = {},
): string | null {
  if (options.isStreaming || message.stopReason !== "error") return null;
  return message.errorMessage?.trim() || "Unknown provider error";
}

function isFinalAnswerBlock(block: AssistantContentBlock): boolean {
  return block.type === "text" || block.type === "image";
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = blocks.findLastIndex((block) => !isFinalAnswerBlock(block));
  if (lastProcessIndex === -1) {
    return { answerBlocks: blocks, processBlocks: [] };
  }
  return {
    answerBlocks: blocks.slice(lastProcessIndex + 1),
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
  };
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter((block): block is ToolCallContent => block.type === "toolCall").length;
}

/** Klartext einer User-Nachricht, ohne Bilder und ohne Reihenfolge-Rauschen. */
export function userMessageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => (
      Boolean(block) && typeof block === "object"
      && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string"
    ))
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** Die letzte User-Nachricht der Liste, auch wenn ein abgebrochener Turn dazwischen liegt. */
export function lastUserMessage(messages: readonly AgentMessage[]): AgentMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") return messages[i];
  }
  return undefined;
}

/**
 * omp reicht den Prompt eines abgebrochenen Turns als Steering-Nachricht erneut
 * ein: im Transkript steht derselbe Text zweimal hintereinander, die zweite
 * Zeile traegt `steering: true` (so in den Sitzungsdateien auf agent-pc
 * gemessen). Fuer den Operator sieht das aus, als haette das System seine
 * Nachricht ein zweites Mal geschickt.
 */
export function isSteeringEcho(previousUser: AgentMessage | undefined, next: AgentMessage): boolean {
  if (next.role !== "user") return false;
  if ((next as { steering?: unknown }).steering !== true) return false;
  if (!previousUser || previousUser === next) return false;
  return userMessageText(previousUser) === userMessageText(next);
}
