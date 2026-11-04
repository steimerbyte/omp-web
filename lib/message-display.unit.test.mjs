import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./message-display.ts");
}

/**
 * `countToolCallBlocks` zaehlt nur, was ein Werkzeugaufruf ist — die Zahl steht
 * als Abzeichen an der eingeklappten Prozess-Zeile. Ein Textblock oder ein
 * Denkblock darf sie nicht erhoehen, sonst zeigt das Abzeichen eine Zahl, die
 * zu keinem sichtbaren Aufruf gehoert.
 */
test("counts only tool call blocks", async () => {
  const { countToolCallBlocks } = await loadSubject();

  const blocks = [
    { type: "text", text: "Ich schaue nach." },
    { type: "toolCall", id: "t1", name: "read" },
    { type: "thinking", thinking: "…" },
    { type: "image", data: "AAAA", mimeType: "image/png" },
    { type: "toolCall", id: "t2", name: "bash" },
  ];

  assert.equal(countToolCallBlocks(blocks), 2);
  assert.equal(countToolCallBlocks([]), 0);
  assert.equal(countToolCallBlocks([{ type: "text", text: "nur Text" }]), 0);
});
