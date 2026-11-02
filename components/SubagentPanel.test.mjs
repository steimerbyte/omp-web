import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SubagentPanel.tsx", import.meta.url), "utf8");
const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const stylesSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("renders live and completed subagent groups beside the chat", () => {
  assert.match(source, /className="subagent-panel"/);
  assert.match(source, /const running = groupSubagentRows\(subagents\.filter\(isSubagentActive\)\)/);
  assert.match(source, /const finished = groupSubagentRows\(subagents\.filter\(\(subagent\) => !isSubagentActive\(subagent\)\)\)/);
  assert.match(source, /t\("subagents\.history"\)/);
});

test("uses a desktop sibling column instead of an absolute overlay", () => {
  assert.doesNotMatch(source, /position:\s*"absolute"/);
  assert.match(shellSource, /className="chat-content-layout"/);
  assert.match(shellSource, /className="subagent-column"/);
  assert.match(shellSource, /const hasSubagents = selectedSession !== null && subagents\.length > 0/);
  assert.match(shellSource, /const showSubagentPanel = hasSubagents && !isMobile/);
  // Still hidden below the breakpoint even though the column is not mounted
  // there: `useIsMobile` is false until hydration, so a phone would flash it.
  // Anchored to the media query on purpose — a greedy match from
  // `.subagent-column` would slide into later `.right-panel-container` rules
  // and keep passing after the guard itself was deleted.
  assert.match(stylesSource, /@media \(max-width: 640px\) \{[^}]*\.subagent-column\s*\{\s*display: none !important;/);
});

test("reaches a running delegation from a phone", () => {
  // Mobile delegation used to be invisible: the column was desktop-only, so a
  // running subagent had no surface at all on a phone. The chat column now
  // carries a count pill that opens the same panel as a bottom sheet.
  assert.match(shellSource, /isMobile && hasSubagents && \(/);
  assert.match(shellSource, /<SubagentMobileToggle/);
  assert.match(source, /export function SubagentMobileToggle/);
  assert.match(source, /aria-expanded=\{open\}/);
  // role=dialog, aria-labelledby, aria-hidden siblings, Escape, backdrop and
  // focus trap come from the dialog primitive; then the close must be named.
  assert.match(source, /<Dialog open=\{open\} onOpenChange=\{setOpen\}>/);
  assert.match(source, /aria-label=\{t\("i18n\.close"\)\}/);
  // One definition of "active": it lives in `lib/subagent-groups`, both the
  // panel and the pill import it, and this component keeps no second copy.
  assert.match(source, /import \{[^}]*isSubagentActive[^}]*\} from "@\/lib\/subagent-groups"/);
  assert.doesNotMatch(source, /function isSubagentActive/);
  // 44px is the repo's phone touch target, and 80px clears the 60px notice
  // cards the shelf pins at top 12 on the same layer 40.
  assert.match(stylesSource, /\.chat-session-column > \.subagent-mobile-toggle \{[\s\S]*?top: 80px;[\s\S]*?min-height: 44px;/);
  // The sheet cannot fold: a collapsed sheet would keep only its close button.
  assert.match(source, /<SubagentPanel sessionId=\{sessionId\} cwd=\{cwd\} subagents=\{subagents\} collapsible=\{false\} \/>/);
  assert.match(stylesSource, /\.subagent-mobile-sheet\s*\{/);
});

test("loads a selected subagent transcript after it finishes", () => {
  assert.match(source, /type: "get_subagent_messages"/);
  assert.match(source, /subagentId: subagent\.id/);
  assert.match(source, /active \? setInterval/);
  assert.match(source, /subagents\.transcriptUnavailable/);
});
