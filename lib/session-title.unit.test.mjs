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

test("a fallback source names a session whose opener is not in the context yet", async () => {
  // omp persists the user message on `message_end`, so the wrapper passes the
  // prompt it just sent; the generator still decides (empty registry → null).
  const title = await generateSessionTitle(
    sessionWith([]),
    "Add a deployment section to the README",
  );

  assert.equal(title, null);
});

test("the context's first message wins over the fallback", async () => {
  let registryReads = 0;
  const registry = { getAvailable: () => { registryReads += 1; return []; } };
  // A low-signal fallback would be declined before the registry is touched; a
  // signal-carrying context message reaches the model lookup instead.
  const title = await generateSessionTitle(
    sessionWith([{ role: "user", content: "Add a deployment section to the README" }], { registry }),
    "hi",
  );

  assert.equal(title, null);
  assert.ok(registryReads >= 1, "the context source was fed, not the low-signal fallback");
});

test("a whitespace-only fallback is no source at all", async () => {
  await assert.rejects(
    generateSessionTitle(sessionWith([]), "   \n "),
    /no user messages to name/,
  );
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
