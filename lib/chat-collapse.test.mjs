import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./chat-collapse.ts");
}

/**
 * Die Regel ist absichtlich eine reine Funktion: sie entscheidet ueber jede
 * Ausgabe im Transkript, auch waehrend eines Streams, und darf dafuer nichts
 * rendern. Die Grenzen stehen hier als Zahlen, damit eine Verschiebung der
 * Konstanten auffaellt.
 */
test("genau drei Ausgaben danach klappen zu — die neueste, zweite und dritte nicht", async () => {
  const { shouldCollapseOutput, COLLAPSE_AFTER_OUTPUTS } = await loadSubject();

  assert.equal(COLLAPSE_AFTER_OUTPUTS, 3);
  assert.equal(shouldCollapseOutput({ outputsAfter: 0 }), false);
  assert.equal(shouldCollapseOutput({ outputsAfter: 1 }), false);
  assert.equal(shouldCollapseOutput({ outputsAfter: 2 }), false);
  assert.equal(shouldCollapseOutput({ outputsAfter: 3 }), true);
  assert.equal(shouldCollapseOutput({ outputsAfter: 4 }), true);
});

test("fuenf Minuten Alter klappen zu, eine Millisekunde weniger nicht", async () => {
  const { shouldCollapseOutput, COLLAPSE_AFTER_MS } = await loadSubject();

  assert.equal(COLLAPSE_AFTER_MS, 5 * 60_000);
  assert.equal(shouldCollapseOutput({ outputsAfter: 1, ageMs: COLLAPSE_AFTER_MS - 1 }), false);
  assert.equal(shouldCollapseOutput({ outputsAfter: 1, ageMs: COLLAPSE_AFTER_MS }), true);
  assert.equal(shouldCollapseOutput({ outputsAfter: 1, ageMs: COLLAPSE_AFTER_MS + 1 }), true);
});

test("die neueste Ausgabe klappt nie allein wegen ihres Alters zu", async () => {
  const { shouldCollapseOutput, COLLAPSE_AFTER_MS } = await loadSubject();

  assert.equal(shouldCollapseOutput({ outputsAfter: 0, ageMs: COLLAPSE_AFTER_MS * 1000 }), false);
});

test("ein fehlender oder unbrauchbarer Zeitstempel gilt als frisch", async () => {
  const { shouldCollapseOutput } = await loadSubject();

  for (const ageMs of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.equal(shouldCollapseOutput({ outputsAfter: 1, ageMs }), false, `ageMs=${String(ageMs)}`);
  }
});

test("der streamende Text klappt nie zu, auch nicht mit drei Ausgaben danach", async () => {
  const { shouldCollapseOutput, COLLAPSE_AFTER_MS } = await loadSubject();

  assert.equal(shouldCollapseOutput({ outputsAfter: 9, ageMs: COLLAPSE_AFTER_MS * 10, isStreaming: true }), false);
});

test("ein Klick des Nutzers gewinnt in beide Richtungen", async () => {
  const { shouldCollapseOutput, COLLAPSE_AFTER_MS } = await loadSubject();

  // aufgeklappt bleibt aufgeklappt, selbst wenn die Regel zuklappen will
  assert.equal(shouldCollapseOutput({ outputsAfter: 9, ageMs: COLLAPSE_AFTER_MS * 10, hasUserOverride: true, userOverride: false }), false);
  // zugeklappt bleibt zugeklappt, selbst als neueste Ausgabe
  assert.equal(shouldCollapseOutput({ outputsAfter: 0, hasUserOverride: true, userOverride: true }), true);
  // ein Wunsch ohne Markierung ist keiner
  assert.equal(shouldCollapseOutput({ outputsAfter: 9, userOverride: false }), true);
});

test("im Live-Tail klappt eine aeltere Ausgabe zu, die neueste und der Stream nicht", async () => {
  // Der Live-Tail ist kein Sonderfall: es gilt dieselbe Regel wie oben.
  const { shouldCollapseOutput } = await loadSubject();

  assert.equal(shouldCollapseOutput({ outputsAfter: 3 }), true);
  assert.equal(shouldCollapseOutput({ outputsAfter: 2 }), false);
  assert.equal(shouldCollapseOutput({ outputsAfter: 0 }), false);
  assert.equal(shouldCollapseOutput({ outputsAfter: 0, isStreaming: true }), false);
});

test("nur Antworten, Befehle und sichtbare Custom-Nachrichten bekommen eine Zeile", async () => {
  const { isCollapsibleOutput } = await loadSubject();

  assert.equal(isCollapsibleOutput({ role: "assistant", content: [{ type: "text", text: "hallo" }] }), true);
  assert.equal(isCollapsibleOutput({ role: "bashExecution", command: "ls", output: "" }), true);
  assert.equal(isCollapsibleOutput({ role: "custom", customType: "compaction", content: "x", display: true }), true);
  assert.equal(isCollapsibleOutput({ role: "custom", customType: "ext", content: "x", display: false }), false);
  assert.equal(isCollapsibleOutput({ role: "user", content: "hallo" }), false);
  // MessageView rendert Werkzeug-Ergebnisse inline und liefert eigenstaendig
  // null — eine Karte darum waere eine leere Zeile.
  assert.equal(isCollapsibleOutput({ role: "toolResult", toolCallId: "1", content: [] }), false);
});

// Ein abgebrochener Lauf hinterlaesst in der Sitzungsdatei eine Assistant-
// Nachricht mit `content: []` und `stopReason: "aborted"`. `MessageView` liefert
// dafuer null, die Karte kam trotzdem: sie zeigt als Etikett eine Antwort und
// als Vorschau den Fehlertext — eine Systemzeile zwischen zwei User-Zeilen.
test("ein Turn ohne sichtbaren Inhalt bekommt keine Zeile", async () => {
  const { isCollapsibleOutput } = await loadSubject();

  assert.equal(isCollapsibleOutput({
    role: "assistant",
    content: [],
    stopReason: "aborted",
    errorMessage: "Request was aborted",
  }), false, "ein abgebrochener Turn ohne Inhalt ist keine Zeile");
  assert.equal(isCollapsibleOutput({ role: "assistant", content: [] }), false);
  // Ein echter Provider-Fehler bleibt sichtbar: er ist die einzige Information
  // des Turns.
  assert.equal(isCollapsibleOutput({
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "upstream 502",
  }), true, "der Fehlertext eines gescheiterten Turns bleibt");
});

const t = (key) => `[${key}]`;

test("die Zusammenfassung einer Antwort: Etikett, Werkzeugnamen, Klartext", async () => {
  const { summarizeCollapsedOutput } = await loadSubject();

  const summary = summarizeCollapsedOutput({
    role: "assistant",
    content: [
      { type: "text", text: "Zeile eins\n\nzeile   zwei" },
      { type: "toolCall", toolCallId: "1", toolName: "read", input: {} },
      { type: "toolCall", toolCallId: "2", toolName: "read", input: {} },
      { type: "toolCall", toolCallId: "3", toolName: "bash", input: {} },
    ],
  }, { t });

  assert.equal(summary.label, "[chat.collapsedAnswer]");
  assert.equal(summary.preview, "Zeile eins zeile zwei");
  assert.deepEqual(summary.toolNames, ["read", "bash"]);
});

test("eine reine Werkzeug-Nachricht heisst Werkzeugaufruf und zeigt ihre Werkzeuge", async () => {
  const { summarizeCollapsedOutput } = await loadSubject();

  const summary = summarizeCollapsedOutput({
    role: "assistant",
    content: [{ type: "toolCall", toolCallId: "1", toolName: "edit", input: {} }],
  }, { t });

  assert.equal(summary.label, "[chat.collapsedToolStep]");
  assert.equal(summary.preview, "edit");
});

test("die Vorschau ist einzeilig, gekuerzt und bleibt Klartext", async () => {
  const { summarizeCollapsedOutput, COLLAPSE_PREVIEW_CHARS } = await loadSubject();

  const long = "a".repeat(400);
  const cut = summarizeCollapsedOutput({ role: "assistant", content: [{ type: "text", text: long }] }, { t });
  assert.equal(cut.preview.length, COLLAPSE_PREVIEW_CHARS);
  assert.ok(cut.preview.endsWith("…"));
  assert.ok(long.startsWith(cut.preview.slice(0, -1)));

  const markdown = summarizeCollapsedOutput({ role: "assistant", content: [{ type: "text", text: "**fett**\n\n- `code`\n- <b>html</b>" }] }, { t });
  assert.equal(markdown.preview, "**fett** - `code` - <b>html</b>");
});

test("Befehl, Komprimierung und Hintergrund-Ergebnis bekommen ihr eigenes Etikett", async () => {
  const { summarizeCollapsedOutput } = await loadSubject();

  const bash = summarizeCollapsedOutput({ role: "bashExecution", command: "bun run typecheck", output: "x".repeat(30) }, { t });
  assert.equal(bash.label, "[chat.collapsedCommand]");
  assert.equal(bash.preview, "bun run typecheck");

  const compaction = summarizeCollapsedOutput({ role: "custom", customType: "compaction", content: "Der Verlauf", display: true }, { t });
  assert.equal(compaction.label, "[chat.collapsedCompaction]");
  assert.equal(compaction.preview, "Der Verlauf");

  const background = summarizeCollapsedOutput({ role: "custom", customType: "async-result", content: "", display: true }, { t });
  assert.equal(background.label, "[chat.collapsedBackgroundResult]");
  assert.equal(background.preview, "async-result");

  const other = summarizeCollapsedOutput({ role: "custom", customType: "skill", content: [{ type: "text", text: "Skill geladen" }], display: true }, { t });
  assert.equal(other.label, "[chat.collapsedMessage]");
  assert.equal(other.preview, "Skill geladen");
});

test("die Vorschau liest hoechstens den Anfang der Ausgabe", async () => {
  // Absichtliche Grenze, kein Fehler: der Text beginnt mit Leerraum, die
  // Zusammenfassung schaut nur in die ersten 400 Zeichen und findet dort
  // nichts Sichtbares. So kostet sie nie die Groesse der Ausgabe.
  const { summarizeCollapsedOutput } = await loadSubject();

  const summary = summarizeCollapsedOutput({ role: "assistant", content: [{ type: "text", text: `${" ".repeat(500)}spaet` }] }, { t });
  assert.equal(summary.label, "[chat.collapsedAnswer]");
  assert.equal(summary.preview, "");
});

test("die Uhr tickt und laesst sich anhalten", async () => {
  const { createOutputClock } = await loadSubject();

  const ticks = [];
  const stop = createOutputClock((now) => ticks.push(now), 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  stop();
  const count = ticks.length;
  assert.ok(count >= 1, "die Uhr hat nicht getickt");
  assert.ok(ticks.every((now) => Number.isFinite(now)));

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(ticks.length, count, "die Uhr lief nach stop() weiter");
});
