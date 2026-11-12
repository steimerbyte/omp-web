import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { findFirstUserMessage, findFirstTitleSource, isUsableSessionTitle, MAX_TITLE_SOURCE_LENGTH, replanTitleSource, truncateTitle } = await jiti.import("./session-title.ts");

test("finds the first user message with usable text", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
    { role: "user", content: [{ type: "image", data: "…", mimeType: "image/png" }] },
    { role: "user", content: [{ type: "text", text: "  Fix the SSE reconnect  " }] },
    { role: "user", content: "later" },
  ];
  assert.equal(findFirstUserMessage(messages), "Fix the SSE reconnect");
});

test("accepts plain string content", () => {
  assert.equal(findFirstUserMessage([{ role: "user", content: "Ship the release" }]), "Ship the release");
});

test("returns undefined when no user turn carries text", () => {
  assert.equal(findFirstUserMessage([{ role: "assistant", content: [{ type: "text", text: "hi" }] }]), undefined);
});

test("collapses whitespace and caps the title length", () => {
  assert.equal(truncateTitle("  Improve   worktree\ngrouping "), "Improve worktree grouping");
  assert.equal(Array.from(truncateTitle("x".repeat(200))).length, 80);
});

test("falls back to the compaction summary after compaction removed all user messages", () => {
  const messages = [
    { role: "compactionSummary", summary: "  The session migrated worktrees and rebuilt the sidebar.  " },
  ];
  assert.equal(findFirstTitleSource(messages), "  The session migrated worktrees and rebuilt the sidebar.  ");
});

test("prefers a real user turn over the compaction summary", () => {
  const messages = [
    { role: "compactionSummary", summary: "stale summary" },
    { role: "user", content: "Fix the SSE reconnect" },
  ];
  assert.equal(findFirstTitleSource(messages), "Fix the SSE reconnect");
});

test("a low-signal opener falls through to the compaction summary", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "compactionSummary", summary: "Re-architect the NAS iSCSI target" },
  ];
  assert.equal(findFirstTitleSource(messages), "Re-architect the NAS iSCSI target");
});

test("a low-signal opener falls through to a later operator turn", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
    { role: "user", content: "Build the AIPerf benchmark report pipeline" },
  ];
  assert.equal(findFirstTitleSource(messages), "Build the AIPerf benchmark report pipeline");
});

test("an agent-attributed user turn is not a title source", () => {
  const messages = [
    { role: "user", content: "Summarize the last deployment", attribution: "agent" },
    { role: "user", content: "Fix the SSE reconnect" },
  ];
  assert.equal(findFirstTitleSource(messages), "Fix the SSE reconnect");
});

test("caps the title source at 2000 characters", () => {
  assert.equal(MAX_TITLE_SOURCE_LENGTH, 2000);
  const source = findFirstTitleSource([{ role: "compactionSummary", summary: "x".repeat(20_000) }]);
  assert.equal(source.length, MAX_TITLE_SOURCE_LENGTH);
});

test("a low-signal opener with no summary and no later turn still returns the opener", () => {
  assert.equal(findFirstTitleSource([{ role: "user", content: "hi" }]), "hi");
});

test("returns undefined when nothing can name the session", () => {
  assert.equal(findFirstTitleSource([{ role: "assistant", content: [{ type: "text", text: "hi" }] }]), undefined);
  assert.equal(findFirstTitleSource([{ role: "compactionSummary", summary: "" }]), undefined);
});

test("a declined opener is retried with the SDK's replan conversation context", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "Hello! How can I help?" },
  ];
  const source = replanTitleSource(messages, "hi");
  assert.equal(typeof source, "string");
  assert.match(source, /^<chat>[\s\S]*<user>\s*hi\s*<\/user>[\s\S]*<assistant>[\s\S]*<\/chat>$/);
});

test("no replan retry when only the compaction summary can name the session", () => {
  assert.equal(
    replanTitleSource([{ role: "compactionSummary", summary: "Deployment notes" }], "Deployment notes"),
    undefined,
  );
});

test("no replan retry when its context adds nothing over the first source", () => {
  const messages = [{ role: "user", content: "hi" }];
  const context = replanTitleSource(messages, "");
  assert.equal(typeof context, "string");
  assert.equal(replanTitleSource(messages, context), undefined);
});

test("rejects markup answers and sentinels, keeps real names", () => {
  assert.equal(isUsableSessionTitle("<chat>"), false);
  assert.equal(isUsableSessionTitle("<title/>"), false);
  assert.equal(isUsableSessionTitle("none"), false);
  assert.equal(isUsableSessionTitle("NONE"), false);
  assert.equal(isUsableSessionTitle("null"), false);
  assert.equal(isUsableSessionTitle("   "), false);
  assert.equal(isUsableSessionTitle("..."), false);
  assert.equal(isUsableSessionTitle("Fix the SSE reconnect"), true);
  assert.equal(isUsableSessionTitle("E-Mails aufräumen"), true);
  assert.equal(isUsableSessionTitle("2026"), true);
});
