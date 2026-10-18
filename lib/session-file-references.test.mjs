import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./session-file-references-core.ts");
}

const CONFIG = "/home/me/.codex/config.toml";

function assistantEntry(content) {
  return {
    type: "message",
    id: "entry-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "assistant", content },
  };
}

/**
 * Pfade, die ein Werkzeug **angefordert** hat, sind Referenzen.
 *
 * Das ist die Beobachtung, aus der der Durchlass entstanden ist: der Agent hat
 * die Datei bearbeitet, also darf der Mandant sie ansehen. Der Test prueft beide
 * Blockformen, weil der Bestand die eine und `lib/types.ts` die andere beschreibt.
 */
test("erkennt den path eines read-Aufrufs als Referenz", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const entries = [
    assistantEntry([{ type: "toolCall", name: "read", arguments: { path: CONFIG, limit: 100 } }]),
    assistantEntry([{ type: "toolCall", toolName: "read", input: { path: CONFIG } }]),
  ];

  assert.equal(isFilePathReferencedByEntries(CONFIG, [entries[0]]), true);
  assert.equal(isFilePathReferencedByEntries(CONFIG, [entries[1]]), true);
});

test("erkennt die Pfadfelder der uebrigen Datei-Werkzeuge", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const call = (name, args) => [assistantEntry([{ type: "toolCall", name, arguments: args }])];

  for (const [tool, args] of [
    ["write", { path: CONFIG, content: "x" }],
    ["edit", { path: CONFIG, old_string: "a", new_string: "b" }],
    ["grep", { path: CONFIG, pattern: "x" }],
    ["glob", { path: CONFIG }],
    ["find", { path: CONFIG }],
    ["bash", { command: "cat x", cwd: CONFIG }],
    ["ssh_scp", { source: CONFIG, destination: "/tmp/x" }],
  ]) {
    assert.equal(isFilePathReferencedByEntries(CONFIG, call(tool, args)), true, tool);
  }
});

/**
 * Die Regression, um die es hier geht.
 *
 * Die alte Fassung sammelte jeden String des Eintrags und machte einen
 * Substring-Test. Damit war ein blosses Nennen im Chat genug — und, schlimmer,
 * genuegte eine *fremde* Datei, die der Agent gelesen hat: steht in ihrer
 * Ausgabe `/etc/passwd`, gilt der Pfad danach als referenziert. Ein gelesenes
 * Log macht die Allowlist des Mandanten wirkungslos.
 */
test("ein Fliesstext-Erwähnen ist keine Referenz", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const entries = [
    assistantEntry([{ type: "text", text: `See [${CONFIG}:12](${CONFIG}:12)` }]),
    assistantEntry([{ type: "thinking", thinking: `Vielleicht ${CONFIG}?` }]),
    {
      type: "message",
      id: "entry-2",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: `gib mir ${CONFIG}` },
    },
  ];

  for (const entry of entries) {
    assert.equal(isFilePathReferencedByEntries(CONFIG, [entry]), false);
  }
});

test("Werkzeugausgabe ist keine Referenz", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const entries = [
    {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        // `displayContent` ist der Inhalt der gelesenen Datei. Steht darin ein
        // Pfad, hat der Agent ihn gelesen, nicht angefordert.
        details: { displayContent: `gefunden: ${CONFIG}`, resolvedPath: undefined },
        content: [{ type: "text", text: CONFIG }],
      },
    },
    assistantEntry([{ type: "text", text: `im Log stand ${CONFIG}` }]),
  ];

  for (const entry of entries) {
    assert.equal(isFilePathReferencedByEntries(CONFIG, [entry]), false);
  }
});

/** Der aufgeloeste Pfad im Ergebnis ist Laufzeit-Metadatum, kein Fliesstext. */
test("erkennt aufgeloeste Pfadfelder im Werkzeugergebnis", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const result = (toolName, details) => [{
    type: "message",
    id: "entry-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "toolResult", toolCallId: "call-1", toolName, details },
  }];

  assert.equal(isFilePathReferencedByEntries(CONFIG, result("write", { resolvedPath: CONFIG })), true);
  assert.equal(isFilePathReferencedByEntries(CONFIG, result("read", { resolvedPath: CONFIG })), true);
  assert.equal(isFilePathReferencedByEntries(CONFIG, result("edit", { path: CONFIG, diff: "x" })), true);
  assert.equal(isFilePathReferencedByEntries(CONFIG, result("grep", { scopePath: CONFIG })), true);
  // `cwd` im grep-Ergebnis ist das Arbeitsverzeichnis des Prozesses, nicht der
  // vom Werkzeug angeforderte Pfad.
  assert.equal(isFilePathReferencedByEntries(CONFIG, result("grep", { cwd: CONFIG })), false);
});

test("fullOutputPath einer Bash-Ausfuehrung ist eine Referenz", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const entries = [{
    type: "message",
    id: "entry-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "bashExecution",
      command: "cat /etc/passwd",
      output: CONFIG,
      fullOutputPath: CONFIG,
    },
  }];

  assert.equal(isFilePathReferencedByEntries(CONFIG, entries), true);
  assert.equal(isFilePathReferencedByEntries(CONFIG, [{
    ...entries[0],
    message: { ...entries[0].message, fullOutputPath: undefined },
  }]), false);
});

test("does not authorize sibling files by prefix match", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const entries = [
    assistantEntry([{ type: "toolCall", name: "read", arguments: { path: `${CONFIG}.bak` } }]),
  ];

  assert.equal(isFilePathReferencedByEntries(CONFIG, entries), false);
});

test("authorizes full output only from a bash execution message", async () => {
  const { isBashOutputPathReferencedByEntries } = await loadSubject();
  const outputPath = "/tmp/pi-bash-ab12.log";
  const bashEntry = {
    type: "message",
    id: "entry-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "bashExecution",
      command: "printf test",
      output: "test",
      fullOutputPath: outputPath,
    },
  };
  const assistantEntryWithMention = {
    type: "message",
    id: "entry-2",
    parentId: "entry-1",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `mentioned ${outputPath}` }],
    },
  };

  assert.equal(isBashOutputPathReferencedByEntries(outputPath, [bashEntry]), true);
  assert.equal(isBashOutputPathReferencedByEntries(outputPath, [assistantEntryWithMention]), false);
  assert.equal(isBashOutputPathReferencedByEntries("/tmp/pi-bash-other.log", [bashEntry]), false);
});

test("validates session ids before resolving session paths", async () => {
  const { isValidSessionId } = await loadSubject();

  assert.equal(isValidSessionId("not-a-session-id"), false);
  assert.equal(isValidSessionId("../../sessions/foo"), false);
  assert.equal(isValidSessionId("550e8400-e29b-41d4-a716-446655440000"), true);
});

/**
 * Der Feldkatalog gegen **echten** Bestand, nicht gegen hier erfundene Bloecke.
 *
 * Der Katalog in `session-file-references-core.ts` ist eine Liste benannter
 * Felder. Eine Liste von Feldern, die ich mir ausgedacht habe, ist kein Beleg —
 * sie ist nur eine Behauptung mit Syntax. Dieser Test liest die Sessions dieses
 * Rechners und prueft in beide Richtungen:
 *
 * - jeder absolute `path`/`cwd`/`source` eines echten `toolCall` wird gefunden,
 * - und ein Pfad, der dort nur im Fliesstext vorkommt, wird **nicht** gefunden.
 *
 * Ohne Session-Bestand (frischer CI-Container) wird der Test uebersprungen, nicht
 * behauptet.
 */
// Grosszuegiges Zeitlimit: der Test liest Dateien von Platte, und `bun test`
// startet die Dateien parallel. Ohne Limit ist er der langsamste Test der Suite
// und faellt unter Last in den 5-s-Timeout, obwohl die Pruefung stimmt.
test("erkennt die Pfadfelder echter Session-Eintraege", { timeout: 120_000 }, async (t) => {
  const sessionsRoot = join(homedir(), ".omp", "agent", "sessions");
  if (!existsSync(sessionsRoot)) {
    t.skip(`kein Session-Bestand unter ${sessionsRoot}`);
    return;
  }
  const files = readdirSync(sessionsRoot, { recursive: true })
    .filter((name) => typeof name === "string" && name.endsWith(".jsonl"))
    .map((name) => join(sessionsRoot, name));
  if (files.length === 0) {
    t.skip("keine Session-Dateien gefunden");
    return;
  }

  const { isFilePathReferencedByEntries } = await loadSubject();
  // Der Vertrag, gegen den der Bestand geprueft wird: dieses Werkzeug pflegt
  // dieses Feld. `bash` liest bewusst nur `cwd` — es hat historisch auch
  // `path`-Aufrufe mit Zeilenbereich im Bestand (`.../file.js:14-20`), und die
  // sollen keine Referenz sein.
  const catalog = {
    read: ["path"],
    edit: ["path"],
    write: ["path"],
    glob: ["path"],
    find: ["path"],
    grep: ["path"],
    eval: ["path"],
    inspect_image: ["path"],
    ssh_read: ["path"],
    ssh_write: ["path"],
    ssh_edit: ["path"],
    bash: ["cwd"],
    ssh_scp: ["source", "destination"],
  };
  let checkedCalls = 0;
  let checkedProse = 0;
  let seenFiles = 0;

  for (const file of files.slice(0, 400)) {
    let entries;
    try {
      entries = readFileSync(file, "utf-8")
        .split("\n")
        .filter((line) => line.trim().startsWith("{"))
        .map((line) => JSON.parse(line));
    } catch {
      continue;
    }
    const messages = entries.filter((entry) => entry?.type === "message");
    if (messages.length === 0) continue;
    seenFiles++;

    for (const message of messages) {
      const content = message.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type !== "toolCall") continue;
        const tool = block.name ?? block.toolName;
        const fields = catalog[tool];
        if (!fields) continue;
        const args = block.arguments ?? block.input;
        if (!args || typeof args !== "object") continue;
        const candidate = fields
          .map((field) => args[field])
          .find((value) => typeof value === "string" && value.startsWith("/") && !value.includes(":"));
        if (!candidate) continue;
        checkedCalls++;
        assert.equal(
          isFilePathReferencedByEntries(candidate, [message]),
          true,
          `echter Werkzeugpfad nicht erkannt: ${candidate} (${tool}.${fields[0]})`,
        );
      }
      // Textbloecke: ein absoluter Pfad darf hier nichts freischalten.
      for (const block of content) {
        const text = block?.type === "text" ? block.text
          : block?.type === "thinking" ? block.thinking
          : undefined;
        if (typeof text !== "string") continue;
        const candidate = text.match(/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/)?.[0];
        if (!candidate) continue;
        checkedProse++;
        // Nur der Textblock als eigene Nachricht: sonst misst der Test die
        // Werkzeugfelder derselben Nachricht mit (ein `glob`-Ergebnis kann
        // denselben Pfad in `details.scopePath` fuehren).
        const textOnly = {
          type: "message",
          id: "prose-only",
          parentId: null,
          timestamp: message.timestamp ?? "2026-01-01T00:00:00.000Z",
          message: { role: "assistant", content: [block] },
        };
        assert.equal(
          isFilePathReferencedByEntries(candidate, [textOnly]),
          false,
          `Fliesstext-Erwaehnung wurde als Referenz gewertet: ${candidate}`,
        );
      }
    }
  }

  assert.ok(seenFiles > 0, "keine Session-Datei mit Nachrichten gelesen");
  assert.ok(checkedCalls > 20, `zu wenige echte Werkzeugpfade geprueft: ${checkedCalls}`);
  assert.ok(checkedProse > 5, `zu wenige Fliesstext-Erwaehnungen geprueft: ${checkedProse}`);
});