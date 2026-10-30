import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const loadSessionSource = source.slice(
  source.indexOf("const loadSession = useCallback"),
  source.indexOf("const loadContext = useCallback"),
);
// Der ganze Wechselpfad: Buchen, Abarbeiten, die beiden Handler. Er beginnt
// bei `requestModelSwitch`, weil dort die Optimistik und die Warteschlange
// leben.
const switchSource = source.slice(
  source.indexOf("const requestModelSwitch = useCallback"),
  source.indexOf("const clearModelSwitchError = useCallback"),
);

test("existing-session model changes are optimistic and serialized", () => {
  // Die Serialisierung liegt jetzt in `lib/model-switch-queue.ts` (eine
  // Anfrage, letzter Klick gewinnt) und wird dort sowie in
  // `hooks/model-switch.test.mjs` an den echten Anfragen gemessen. Was hier
  // bleibt, ist die Zusicherung ueber die Reihenfolge im Handler: die
  // Optimistik steht, bevor die Anfrage abgeht.
  const optimisticIndex = switchSource.indexOf("setCurrentModelOverride({ provider: target.provider");
  const requestIndex = switchSource.indexOf("drainModelSwitchRef.current", optimisticIndex);

  assert.ok(optimisticIndex >= 0, "die Optimistik steht im Buchungspfad");
  assert.ok(requestIndex > optimisticIndex, "sie steht vor der Anfrage");
  assert.match(switchSource, /setModelSwitching\(true\)/);
  assert.match(switchSource, /acceptModelSwitch\(modelSwitchQueueRef\.current, target\)/);
});

test("session reloads cannot clear an in-flight optimistic model", () => {
  assert.match(
    loadSessionSource,
    /setCurrentModelOverride\(\(current\) => modelSwitchQueueRef\.current\.inFlight \? current : null\)/,
  );
});

test("a completed model switch reconciles from the answer and never reloads the session", () => {
  // Der frueher hier gepinnte `await loadSession(sid)` war der zweite
  // Roundtrip ueber das ganze Transkript — die Ursache „sehr langsam". Der
  // Ersatz steht in der Antwort des Servers (`modelSwitchState()`).
  assert.doesNotMatch(switchSource, /await loadSession\(sid\)/, "der Wechsel laedt die Session nicht neu");
  assert.match(switchSource, /result\.thinkingLevel/);
  assert.match(switchSource, /result\.leafId/);
  assert.match(switchSource, /sendAgentCommand<ModelSwitchResult>\(sid, commandForTarget\(current\), \{\s*timeoutMs: MODEL_SWITCH_TIMEOUT_MS,/);
  assert.match(switchSource, /Failed to switch model:/);
  assert.match(switchSource, /toModelSwitchFailure\(error\)/);
});
