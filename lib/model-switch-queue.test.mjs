import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Die Warteschlange des Modellwechsels.
 *
 * ### Was hier gemessen wird und warum genau das
 *
 * Der gemeldete Fehler war kein langsamer Wechsel, sondern ein Klick, der
 * verschwand: `if (modelSwitchPendingRef.current) return` in
 * `hooks/useAgentSession.ts` warf jeden zweiten Klick weg, und der Ausloeser im
 * Composer war waehrend der Anfrage `disabled`. Zwei Messungen halten das fest:
 * der zweite Klick wird **gebucht** (nicht verworfen), und der **letzte**
 * gewinnt — nicht der erste, nicht beide.
 *
 * Die Zusicherung „genau eine Anfrage gleichzeitig" ist der Grund, warum das
 * ueberhaupt ein eigener Baustein ist: die SDK dokumentiert `setModel` nicht als
 * nebenlaeufig sicher, `appendModelChange` schreibt in denselben Journal-Knoten.
 */

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  acceptModelSwitch,
  settleModelSwitch,
  createModelSwitchQueue,
  modelTargetKey,
  commandForTarget,
  toModelSwitchFailure,
  describeModelSwitchFailure,
} = await jiti.import("./model-switch-queue.ts");
const { AgentCommandTimeoutError } = await jiti.import("./agent-client.ts");

const qwen = { kind: "model", provider: "buds-gateway", modelId: "qwen3.8-27b" };
const deepseek = { kind: "model", provider: "buds-gateway", modelId: "deepseek-v4.1-flash-1017" };
const minimax = { kind: "model", provider: "minimax-code", modelId: "MiniMax-M2.5-highspeed" };
const smol = { kind: "role", role: "smol" };

test("ein einzelner Klick geht sofort hinaus", () => {
  const accepted = acceptModelSwitch(createModelSwitchQueue(), qwen);
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.state.inFlight, qwen);
  assert.equal(accepted.state.queued, null);
});

test("ein Klick waehrend einer laufenden Anfrage wird gebucht, nicht verworfen", () => {
  let state = createModelSwitchQueue();
  state = acceptModelSwitch(state, qwen).state;

  const second = acceptModelSwitch(state, minimax);
  assert.equal(second.ok, true, "der zweite Klick wird angenommen");
  assert.deepEqual(second.state.inFlight, qwen, "die laufende Anfrage bleibt unangetastet");
  assert.deepEqual(second.state.queued, minimax, "der zweite Klick steht in der Warteschlange");
});

test("der letzte Klick gewinnt — drei Klicks, zwei Anfragen", () => {
  let state = createModelSwitchQueue();
  state = acceptModelSwitch(state, qwen).state;
  state = acceptModelSwitch(state, minimax).state;
  state = acceptModelSwitch(state, deepseek).state;

  assert.deepEqual(state.inFlight, qwen, "erst das erste Ziel");
  assert.deepEqual(state.queued, deepseek, "dann das LETZTE, nicht das zweite");

  const afterFirst = settleModelSwitch(state);
  assert.deepEqual(afterFirst.next, deepseek, "die naechste Anfrage ist der letzte Klick");
  assert.deepEqual(afterFirst.state.inFlight, deepseek);
  assert.equal(afterFirst.state.queued, null);

  const afterSecond = settleModelSwitch(afterFirst.state);
  assert.equal(afterSecond.next, null, "danach ist nichts mehr offen");
  assert.equal(afterSecond.state.inFlight, null);
});

test("derselbe Klick zweimal erzeugt keine zweite Anfrage", () => {
  let state = createModelSwitchQueue();
  state = acceptModelSwitch(state, qwen).state;

  const again = acceptModelSwitch(state, qwen);
  assert.equal(again.ok, false, "dasselbe Ziel, das ohnehin laeuft");
  assert.deepEqual(again.state.inFlight, qwen);
  assert.equal(again.state.queued, null);

  const queued = acceptModelSwitch(state, minimax).state;
  const duplicateQueued = acceptModelSwitch(queued, minimax);
  assert.equal(duplicateQueued.ok, false, "dasselbe Ziel, das schon gebucht ist");
  assert.deepEqual(duplicateQueued.state.queued, minimax);
});

test("eine Rolle und ein Modell sind verschiedene Ziele", () => {
  assert.notEqual(modelTargetKey(smol), modelTargetKey(qwen));
  assert.equal(modelTargetKey(smol), "role:smol");
  assert.equal(modelTargetKey(qwen), "model:buds-gateway/qwen3.8-27b");

  let state = acceptModelSwitch(createModelSwitchQueue(), smol).state;
  const next = acceptModelSwitch(state, qwen);
  assert.equal(next.ok, true, "ein Modellklick waehrend eines Rollenwechsels wird gebucht");
  assert.deepEqual(next.state.queued, qwen);
});

test("die Kommandos nennen Ziel und Rolle so, wie der Server sie liest", () => {
  assert.deepEqual(commandForTarget(qwen), {
    type: "set_model",
    provider: "buds-gateway",
    modelId: "qwen3.8-27b",
  });
  assert.deepEqual(commandForTarget(smol), { type: "set_role_model", role: "smol" });
});

test("ein Timeout wird als Timeout gemeldet, eine Absage mit ihrem Grund", () => {
  const timeout = toModelSwitchFailure(new AgentCommandTimeoutError(20_000));
  assert.equal(timeout.timeout, true);
  assert.match(
    describeModelSwitchFailure(timeout, (key) => key),
    /^chat\.modelSwitchTimeout$/,
    "ohne Serverantwort haengt kein 'AbortError' an der Meldung",
  );

  const rejected = toModelSwitchFailure(new Error("No API key for buds-gateway/qwen3.8-27b"));
  assert.equal(rejected.timeout, false);
  assert.equal(
    describeModelSwitchFailure(rejected, (key) => key),
    "chat.modelSwitchFailed No API key for buds-gateway/qwen3.8-27b",
    "der Grund des Servers bleibt sichtbar — ohne ihn ist die Meldung nicht zu beheben",
  );
});
