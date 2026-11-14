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

/**
 * omp reicht den Prompt eines abgebrochenen Turns als Steering-Nachricht erneut
 * ein; in den Sitzungsdateien auf agent-pc steht der Text dann zweimal, die
 * zweite Zeile mit `steering: true`. Nur genau dieses Echo faellt weg — ein
 * echter Steering-Prompt mit eigenem Text bleibt eine Nachricht.
 */
test("a steering echo of the previous prompt is no second message", async () => {
  const { isSteeringEcho, lastUserMessage } = await loadSubject();

  const prompt = { role: "user", content: "Bitte immer praesent", timestamp: 1 };
  const aborted = { role: "assistant", content: [], stopReason: "aborted", timestamp: 2 };
  const echo = { role: "user", content: "Bitte immer praesent", steering: true, timestamp: 3 };

  assert.equal(isSteeringEcho(prompt, echo), true);
  // Der abgebrochene Turn liegt dazwischen, die letzte User-Zeile bleibt der Prompt.
  assert.equal(lastUserMessage([prompt, aborted, echo]).content, "Bitte immer praesent");

  // Anderer Text, fehlendes Flag oder eine andere Rolle: echte Nachricht.
  assert.equal(isSteeringEcho(prompt, { ...echo, content: "und jetzt anders" }), false);
  assert.equal(isSteeringEcho(prompt, { ...prompt, steering: false }), false);
  assert.equal(isSteeringEcho(undefined, echo), false);
  assert.equal(isSteeringEcho({ role: "assistant", content: "x" }, echo), false);
  // Blockinhalt zaehlt wie Text.
  assert.equal(
    isSteeringEcho({ role: "user", content: [{ type: "text", text: " gleich " }] }, { role: "user", content: "gleich", steering: true }),
    true,
  );
});
