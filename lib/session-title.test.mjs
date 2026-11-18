import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  findFirstUserMessage,
  findFirstTitleSource,
  firstEmoji,
  isUsableSessionTitle,
  MAX_TITLE_SOURCE_LENGTH,
  replanTitleSource,
  stripEmoji,
  titleEmoji,
  TITLE_EMOJI_RULES,
  TITLE_SYSTEM_PROMPT,
  truncateTitle,
  withSingleEmoji,
} = await jiti.import("./session-title.ts");

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

test("stripEmoji entfernt Familien, Flaggen, Hauttoene und Keycaps", () => {
  assert.equal(stripEmoji("👨‍👩‍👧 Family deploy"), " Family deploy");
  assert.equal(stripEmoji("🏳️‍🌈 Flagge"), " Flagge");
  assert.equal(stripEmoji("🇩🇪 Reise"), " Reise");
  assert.equal(stripEmoji("👍🏽 super"), " super");
  assert.equal(stripEmoji("1️⃣ erster Punkt"), " erster Punkt");
  assert.equal(stripEmoji("Kein Emoji"), "Kein Emoji");

  assert.equal(firstEmoji("👨‍👩‍👧 Family"), "👨‍👩‍👧");
  assert.equal(firstEmoji("🏳️‍🌈 Flagge"), "🏳️‍🌈");
  assert.equal(firstEmoji("🇩🇪 Reise"), "🇩🇪");
  assert.equal(firstEmoji("Kein Emoji"), null);
});

test("withSingleEmoji laesst genau eins stehen und den Text woertlich", () => {
  assert.equal(withSingleEmoji("Deploy the release"), "🚀 Deploy the release");
  assert.equal(withSingleEmoji("🐛 Fix the login"), "🐛 Fix the login");
  assert.equal(withSingleEmoji("🐛 Fix the login 🚀"), "🐛 Fix the login");
  assert.equal(withSingleEmoji("🇩🇪 Reise nach Berlin"), "🇩🇪 Reise nach Berlin");
  assert.equal(withSingleEmoji("👨‍👩‍👧 Familientag"), "👨‍👩‍👧 Familientag");
});

test("ein generisches Chat-Emoji verliert gegen das Schluesselwort", () => {
  assert.equal(titleEmoji("💬 Docker container neu bauen"), "📦");
  assert.equal(titleEmoji("🗨️ Database migration fuer Postgres"), "🗄️");
  assert.equal(titleEmoji("🗣 Kalender fuer naechste Woche"), "📅");
  assert.equal(withSingleEmoji("💬 Deploy the release"), "🚀 Deploy the release");
});

test("ein eigenes, nicht generisches Emoji des Modells gewinnt", () => {
  assert.equal(titleEmoji("🦀 Fix the borrow checker"), "🦀");
  assert.equal(titleEmoji("🔨 Docker container neu bauen"), "🔨", "das Modell meint einen Build, nicht das Paket");
});

test("💬 bleibt fuer echte Gespraechsthemen", () => {
  assert.equal(titleEmoji("Reden wir ueber nichts Bestimmtes"), "💬");
  assert.equal(titleEmoji("Chat with the assistant about the roadmap"), "💬");
  assert.equal(withSingleEmoji("💬 Reden wir ueber nichts Bestimmtes"), "💬 Reden wir ueber nichts Bestimmtes");
});

test("ohne Treffer bleibt die neutrale Nadel, nicht die Sprechblase", () => {
  assert.equal(titleEmoji("Adjust the payload"), "📌");
  assert.equal(withSingleEmoji("Adjust the payload"), "📌 Adjust the payload");
});

test("die sechs gemessenen 💬-Titel ergeben sechs verschiedene Emoji", () => {
  // Gemessen auf agent-pc am 2026-11-18: 6 der 10 Emoji-Titel waren 💬.
  const measured = [
    "💬 Run Losungen skill with imagegen",
    "💬 Nightly system maintenance and disk analysis",
    "💬 Sync obsidian-livesync upstream changes",
    "💬 Set birthday dinner appointment",
    "💬 Update DeepSeek context to 300k",
    "💬 Mod OnePlus Health APK for W301GB watch",
  ];
  const emoji = measured.map(withSingleEmoji).map(firstEmoji);
  assert.deepEqual(emoji, ["🧩", "💽", "🔄", "📅", "⚙️", "📱"]);
  assert.equal(new Set(emoji).size, measured.length, "die Varianz ist der Punkt");
});

test("eine neue Regel verdeckt keine alte", () => {
  assert.equal(titleEmoji("Fix the sync bug"), "🐛", "bug steht vor sync");
  assert.equal(titleEmoji("Deploy the config"), "🚀", "deploy steht vor config");
});

test("der Prompt verlangt ein Themen-Emoji und nennt 💬 den Fehlgriff", () => {
  assert.match(TITLE_SYSTEM_PROMPT, /exactly one emoji that fits that specific subject/);
  assert.match(TITLE_SYSTEM_PROMPT, /💬 is wrong unless the session is literally about chat/);
  assert.match(TITLE_SYSTEM_PROMPT, /<title\/>/);
});

test("titleEmoji nimmt ein Schluesselwort, wenn das Modell keins schrieb", () => {
  assert.equal(titleEmoji("Docker container neu bauen"), "📦");
  assert.equal(titleEmoji("Database migration fuer Postgres"), "🗄️");
  assert.equal(titleEmoji("Reden wir ueber nichts Bestimmtes"), "💬");
  assert.ok(TITLE_EMOJI_RULES.length >= 15, "die Tabelle deckt die haeufigen Themen ab");
  assert.equal(titleEmoji("Deploy-Fix nach dem Rollout"), "🚀", "Reihenfolge ist Prioritaet");
});

test("das Emoji zaehlt gegen die 80-Zeichen-Grenze", () => {
  const title = withSingleEmoji(
    "Fix the extremely long running SSE reconnect problem in the sidebar that never ends",
  );
  assert.ok(Array.from(title).length <= 80, `${Array.from(title).length} Zeichen`);
  assert.equal(title.startsWith("🐛 Fix the extremely long"), true);

  const exact = withSingleEmoji("x".repeat(90));
  assert.equal(Array.from(exact).length, 80);
  assert.equal(Array.from(exact).slice(2).join(""), "x".repeat(78), "das Emoji und sein Leerzeichen zaehlen mit");
});

test("ein Titel aus nur Emoji bleibt eine Ablehnung", () => {
  assert.equal(isUsableSessionTitle("🚀"), false);
  assert.equal(isUsableSessionTitle("🐛🚀"), false);
});

test("die Rename-Route des Nutzers fasst den Emoji-Helfer nicht an", () => {
  const source = readFileSync(
    new URL("../app/api/sessions/[id]/route.ts", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes("withSingleEmoji"), false);
  assert.equal(source.includes("session-title"), false);
  assert.match(source, /setSessionName\(name\.trim\(\), "user"\)/);
});
