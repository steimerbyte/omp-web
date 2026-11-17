import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SubagentPanel.tsx", import.meta.url), "utf8");
const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const chatSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const stylesSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("renders live and completed subagent groups with their counts", () => {
  assert.match(source, /className="subagent-panel"/);
  assert.match(source, /const running = groupSubagentRows\(subagents\.filter\(isSubagentActive\)\)/);
  assert.match(source, /const finished = groupSubagentRows\(subagents\.filter\(\(subagent\) => !isSubagentActive\(subagent\)\)\)/);
  assert.match(source, /t\("subagents\.history"\)/);
});

test("one entry point above the composer instead of a column and a phone pill", () => {
  // The desktop column and the phone count pill are gone, both in the shell
  // and in the stylesheet. The entry point belongs to the chat's composer row.
  assert.doesNotMatch(shellSource, /SubagentPanel|SubagentMobileToggle|subagent-column/);
  assert.doesNotMatch(stylesSource, /subagent-column|subagent-mobile-toggle|subagent-mobile-sheet/);
  assert.doesNotMatch(source, /export function SubagentMobileToggle/);
  assert.match(chatSource, /import \{ SubagentAgentButton \} from "\.\/SubagentPanel"/);
  // Same row as the Vibe bar, right-aligned by the flexible placeholder.
  assert.match(chatSource, /<GoalBar[\s\S]*?<VibeBar vibe=\{vibeStatus\} t=\{t\} \/>[\s\S]*?<SubagentAgentButton/);
  assert.match(source, /export function SubagentAgentButton/);
  // Only while work is running: finished rows alone show nothing.
  // Sichtbar nur waehrend Arbeit — ein offener Dialog haelt den Knopf am Leben.
  assert.match(source, /if \(!sessionId \|\| \(!active && !open\)\) return null/);
});

test("the mock is a 40px robot button with a dialog", () => {
  assert.match(source, /width: 40,/);
  assert.match(source, /height: 40,/);
  assert.match(source, /borderRadius: 10,/);
  assert.match(source, /border: `1px solid \$\{active \? "var\(--accent\)" : "var\(--border\)"\}`/);
  assert.match(source, /background: "var\(--bg-hover\)"/);
  assert.match(source, /aria-haspopup="dialog"/);
  assert.match(source, /aria-label=\{t\("subagents\.open", \{ count \}\)\}/);
  // The robot head is drawn here: no icon dependency.
  assert.match(source, /<rect x="4" y="7" width="16" height="12" rx="3\.5" \/>/);
  assert.match(source, /<circle cx="9" cy="12\.5" r="1\.1" fill="currentColor" stroke="none" \/>/);
  assert.match(source, /<circle cx="15" cy="12\.5" r="1\.1" fill="currentColor" stroke="none" \/>/);
  // Centered dialog with the numeric layer and the agreed size.
  assert.match(source, /<DialogContent\n\s+bare\n\s+layer=\{120\}/);
  assert.match(source, /width: "min\(780px, 92vw\)"/);
  assert.match(source, /height: "min\(72dvh, 640px\)"/);
  assert.match(source, /<SubagentPanel sessionId=\{sessionId\} cwd=\{cwd\} subagents=\{subagents\} collapsible=\{false\} \/>/);
  assert.match(source, /aria-label=\{t\("i18n\.close"\)\}/);
});

test("the pulse stands still when animations are off", () => {
  assert.match(source, /const mode = useAnimationMode\(\)/);
  assert.match(source, /animate=\{active && mode !== "off" \? \{ opacity: \[0\.25, 1, 0\.25\] \} : \{ opacity: 0 \}\}/);
  assert.match(source, /PULSE_TRANSITION/);
});

test("vibe workers are named honestly because they are not snapshots", () => {
  // They exist as sessions behind the `vibe_*` tools, so the dialog states how
  // many run and does not invent a row for them.
  assert.match(source, /vibeWorkers = 0 \}/);
  assert.match(source, /\{vibeWorkers > 0 \? \(/);
  assert.match(source, /t\("subagents\.vibeWorkers", \{ count: vibeWorkers \}\)/);
});

test("loads a selected subagent transcript after it finishes", () => {
  assert.match(source, /type: "get_subagent_messages"/);
  assert.match(source, /subagentId: subagent\.id/);
  assert.match(source, /active \? setInterval/);
  assert.match(source, /subagents\.transcriptUnavailable/);
});
