import { Type } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox";
import { defineTool } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import {
  formatPresentBytes,
  MAX_PRESENT_EXCERPT_TOTAL_CHARS,
  MAX_PRESENT_ITEMS,
  type PresentFilesDetails,
  type PresentItem,
} from "./present-files";
import {
  normalizePresentItems,
  probePresentItem,
  type ExcerptBudget,
} from "./present-files-probe";

/**
 * `present_files` — show files to the user as preview cards in the chat.
 *
 * The model produces something visual or user-facing — a screenshot, a chart, a
 * rendered PDF, a log tail, build output — and then only writes a path into the
 * text. The user has to open the sidebar and hunt for it. This tool turns the
 * path list into cards in the transcript, where the thing actually is.
 *
 * **What it does.** It reads. `stat` on every path, a content sniff for unknown
 * extensions, and a bounded excerpt for the textual kinds. That is the same
 * reach the `read` tool has, and no more: it opens no window, sends no
 * notification, and starts no process. Every system-level action a card offers
 * is something the user clicks, and each one goes through the file routes with
 * their own allow-list and identity check.
 *
 * **Where the data goes.** Structured card data travels in the tool result's
 * `details`, which omp-web persists with the transcript and streams to the
 * browser; the card in `components/PresentFiles.tsx` reads it from there. The
 * text block is the model's half of the answer: what was shown, what was not,
 * and a reminder not to paste the contents again.
 *
 * **Native, not an extension.** The definition is handed to the SDK through
 * `CreateAgentSessionOptions.customTools` in `lib/rpc-manager.ts`, so it exists
 * in every session instead of depending on a discovered `.omp/extensions`
 * file. The wiring follows `pi-web-ui`'s own `present_files` (same
 * `customTools` mechanism, same `defineTool` marker), which matters because a
 * `customTools` entry without that marker is treated as a `CustomTool` and
 * re-bridged with a *different* `execute` argument order.
 *
 * **The card shape is shared with `pi-web-ui`,** which has its own
 * `present_files` for its own UI. Same field names, verified against a real
 * session entry there, so a transcript that moves between the two applications
 * keeps its cards instead of degrading to text.
 */

/**
 * The model's half of the answer: which files are on screen now, which are not,
 * and a reminder that the contents are already reachable from the cards.
 */
export function buildPresentResultText(
  shown: PresentItem[],
  missing: PresentItem[],
  title: string | undefined,
): string {
  const lines: string[] = [];
  const heading = title ? ` (${title})` : "";
  lines.push(`Presented ${shown.length} file(s) to the user as preview cards${heading}:`);
  for (const item of shown) {
    const size = formatPresentBytes(item.size);
    const caption = item.caption ? ` — ${item.caption}` : "";
    lines.push(`${item.abs} (${item.kind}, ${size})${caption}`);
  }
  if (missing.length > 0) {
    lines.push(`Not shown (path missing or unreadable): ${missing.map((m) => m.path).join(", ")}`);
  }
  lines.push(
    "The user can preview or download these from the cards — do not paste their contents again.",
  );
  return lines.join("\n");
}

/**
 * The `present_files` tool definition, registered natively on every session.
 *
 * A factory rather than a constant so the definition is built once per session
 * (as `pi-web-ui` does) instead of a module-level object shared across
 * sessions that the SDK wraps per session anyway.
 */
export function makePresentFilesTool() {
  return defineTool({
    name: "present_files",
    label: "Present files",
    description:
      "Show files to the user as preview cards in the chat, so the user can actually see the result " +
      "instead of only reading a path. Images, video, audio and PDFs render inline; text, markdown " +
      "and HTML open in a preview dialog. Every card can be downloaded. " +
      "Call this after producing something visual or user-facing (screenshot, chart, recording, " +
      "report, log tail, build output). Do not call it for ordinary source edits the user did not " +
      "ask to see, and never call it twice for the same file in one turn.",
    // Read-only: it stats files and reads a bounded head, nothing more.
    approval: "read",
    // "essential" — this is a core capability of this UI, and the card in
    // `components/MessageView.tsx` reads its data straight out of `result.details`.
    // A "discoverable" tool is removed from the model's top-level schema and
    // mounted under `xd://` instead (`isMountableUnderXdev` → the active-set
    // partition in `session-tools.ts#applyActiveToolsByName`), so the only way to
    // reach it is `write xd://present_files` — which lands the payload as
    // `{xdev:{inner:{…}}}` on a `write` toolCall instead of a `present_files`
    // one, and the card never renders. Declaring "essential" keeps the call
    // first-class; `unwrapPresentFilesDetails` still accepts the wrapped
    // shape for transcripts recorded before this switch.
    loadMode: "essential",
    parameters: Type.Object({
      items: Type.Array(
        Type.Object({
          path: Type.String({
            description: "File path — workspace-relative like 'docs/chart.png', or absolute.",
          }),
          caption: Type.Optional(Type.String({
            description: "Optional short caption shown next to this file's name.",
          })),
        }),
        { description: `Files to show, 1-${MAX_PRESENT_ITEMS} entries.` },
      ),
      title: Type.Optional(Type.String({
        description: "Optional card title shown above the cards, e.g. 'Q3 revenue chart'.",
      })),
      note: Type.Optional(Type.String({
        description: "Optional one-line note above the cards: what changed, which one to look at first.",
      })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const items = normalizePresentItems(params.items);
      if (items.length === 0) {
        throw new Error("present_files needs at least one item with a path.");
      }

      const cwd = ctx.cwd;
      const budget: ExcerptBudget = { left: MAX_PRESENT_EXCERPT_TOTAL_CHARS };
      const probed: PresentItem[] = [];
      for (const item of items) {
        if (signal?.aborted) throw new Error("aborted");
        probed.push(await probePresentItem(item, cwd, budget));
      }

      const shown = probed.filter((item) => item.kind !== "missing");
      const missing = probed.filter((item) => item.kind === "missing");

      // Everything unreadable is not an error either — but then there is no
      // card, and the model has to know that, or it will assume the file is on
      // screen when it is not.
      if (shown.length === 0) {
        throw new Error(
          `None of these paths exist or are readable, nothing was shown: ${missing.map((m) => m.path).join(", ")}`,
        );
      }

      const details: PresentFilesDetails = { items: shown };
      if (params.title) details.title = params.title;
      if (params.note) details.note = params.note;

      return {
        content: [
          { type: "text" as const, text: buildPresentResultText(shown, missing, params.title) },
        ],
        details,
      };
    },
  });
}