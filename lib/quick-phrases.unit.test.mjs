import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * Was eine Phrase ist, an der einen Grenze, die in der Praxis vorkommt: Text,
 * der nur aus Leerzeichen besteht.
 *
 * Der Knopf setzt seinen `text` in den Composer. `"   "` ist kein Inhalt,
 * sondern ein Klick ohne Wirkung; `"  hallo  "` ist Inhalt mit den Leerzeichen,
 * die der Nutzer getippt hat. Nur die erste Form faellt weg, und die
 * Entscheidung steht in `normalizeQuickPhrases`, weil Lesen, Schreiben und die
 * HTTP-Route dieselbe Funktion benutzen.
 */

const { normalizeQuickPhrases } = await import("./quick-phrases.ts");
const { readQuickPhrasesFile, writeQuickPhrasesFile } = await import("./quick-phrases-store.ts");

test("a whitespace-only text is no phrase, on read and on write", () => {
  const dropped = [
    { label: "", text: "   " },
    { label: "leer", text: "\t\n" },
    { label: "noch leer", text: "" },
  ];

  // Lesen: die HTTP-Antwort, die Datei, der Spiegel gehen alle hier durch.
  assert.deepEqual(normalizeQuickPhrases(dropped), []);

  // Schreiben: was hier durchfaellt, landet nicht in der Datei.
  const root = mkdtempSync(join(tmpdir(), "omp-web-quick-phrases-"));
  const previous = process.env.OMP_WEB_HOME_ROOT;
  process.env.OMP_WEB_HOME_ROOT = root;
  try {
    const identity = { username: "alice", isAdmin: false };
    assert.deepEqual(writeQuickPhrasesFile(identity, dropped), []);
    const stored = JSON.parse(readFileSync(join(root, "alice", ".omp", "agent", "omp-web-quick-phrases.json"), "utf8"));
    assert.deepEqual(stored.phrases, []);
    assert.deepEqual(readQuickPhrasesFile(identity).phrases, []);
  } finally {
    if (previous === undefined) delete process.env.OMP_WEB_HOME_ROOT;
    else process.env.OMP_WEB_HOME_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("surrounding spaces the user typed survive unchanged", () => {
  // Nicht getrimmt speichern: der Text wird woertlich eingefuegt, und ein
  // Nutzer, der ein Leerzeichen vor ein Wort setzt, meint es.
  const phrases = [
    { label: "", text: "  hallo  " },
    { label: "Tab", text: "\tzweizeilig\n" },
  ];
  assert.deepEqual(normalizeQuickPhrases(phrases), phrases);
});
