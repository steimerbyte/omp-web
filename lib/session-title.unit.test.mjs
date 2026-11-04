import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { generateSessionTitle, truncateTitle } from "./session-title.ts";

/**
 * The web auto-name path reuses omp's own title generator. Its decisions that
 * matter here: no user text means refuse, and "the generator declined" is a
 * `null` result rather than an error.
 */

function sessionWith(messages, { registry = { getAvailable: () => [] } } = {}) {
  return {
    sessionId: "session-1",
    model: undefined,
    settings: Settings.isolated({}),
    modelRegistry: registry,
    sessionManager: { buildSessionContext: () => ({ messages }) },
  };
}

test("a session without user text cannot be named", async () => {
  await assert.rejects(
    generateSessionTitle(sessionWith([{ role: "assistant", content: "hello" }])),
    /no user messages to name/,
  );
});

test("a title model that declines yields null instead of an invented name", async () => {
  const title = await generateSessionTitle(sessionWith([
    { role: "assistant", content: "ignored first turn" },
    { role: "user", content: [{ type: "text", text: "Add a deployment section to the README" }] },
  ]));

  assert.equal(title, null);
});

test("after a full compaction the summary is a valid title source", async () => {
  // No user turn survives the compaction, but the summary does.
  const title = await generateSessionTitle(sessionWith([
    { role: "compactionSummary", summary: "Deployment pipeline and release notes" },
  ]));

  assert.equal(title, null, "the generator still decides; the source is accepted");
});

test("an empty compaction summary is not a title source", async () => {
  await assert.rejects(
    generateSessionTitle(sessionWith([{ role: "compactionSummary", summary: "   " }])),
    /no user messages to name/,
  );
});

test("title truncation collapses whitespace and caps at 80 characters", () => {
  assert.equal(truncateTitle("  hello \n world  "), "hello world");
  const long = "x".repeat(100);
  assert.equal(truncateTitle(long).length, 80);
  // A trailing space left by the cut is trimmed as well.
  assert.equal(truncateTitle(`${"y".repeat(79)} tail`), "y".repeat(79));
  // Astral characters count as one character, not two UTF-16 units.
  assert.equal(Array.from(truncateTitle("🚀".repeat(90))).length, 80);
});
