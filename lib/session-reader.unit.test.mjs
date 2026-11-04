import assert from "node:assert/strict";
import test from "node:test";
import { getHistoricalContextUsage } from "./session-reader.ts";

/**
 * Eine gestoppte Session hat keinen Live-Tracker; die Kontextauslastung kommt
 * aus dem `contextSnapshot` der letzten erfolgreichen Antwort. Der Test setzt
 * die Laufzeit-Attrappe direkt auf den `globalThis`-Platz, den `getOmpRuntime`
 * selbst benutzt — kein Prozess, kein Modellaufruf.
 */

const MODEL = { provider: "fake-provider", id: "fake-model", contextWindow: 200_000, api: "openai-completions" };

function installRuntime(t) {
  const previous = globalThis.__ompRuntimePromise;
  globalThis.__ompRuntimePromise = Promise.resolve({
    modelRegistry: {
      find: (provider, modelId) => provider === MODEL.provider && modelId === MODEL.id ? MODEL : undefined,
    },
  });
  t.after(() => {
    if (previous === undefined) delete globalThis.__ompRuntimePromise;
    else globalThis.__ompRuntimePromise = previous;
  });
}

function entries({ snapshot = true, stopReason = "stop", usage, omitUsage = false } = {}) {
  return [
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "hello" },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        provider: MODEL.provider,
        model: MODEL.id,
        stopReason,
        content: [{ type: "text", text: "hi" }],
        ...(omitUsage ? {} : { usage: usage ?? { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 1010 } }),
        ...(snapshot ? { contextSnapshot: { promptTokens: 1234 } } : {}),
      },
    },
  ];
}

test("the recorded prompt-token snapshot anchors the usage", async (t) => {
  installRuntime(t);

  const usage = await getHistoricalContextUsage(entries());

  assert.ok(usage);
  // 1234 prompt tokens, no messages after the anchor.
  assert.equal(usage.tokens, 1234);
  assert.equal(usage.contextWindow, 200_000);
  assert.equal(usage.percent, (1234 / 200_000) * 100);
});

test("an assistant turn without a snapshot is not an anchor", async (t) => {
  installRuntime(t);

  // No contextSnapshot and no usable usage: there is nothing to anchor on.
  const usage = await getHistoricalContextUsage(entries({
    snapshot: false,
    omitUsage: true,
  }));

  assert.equal(usage, undefined);
});

test("aborted and errored turns are skipped, not counted", async (t) => {
  installRuntime(t);

  assert.equal(await getHistoricalContextUsage(entries({ stopReason: "aborted" })), undefined);
  assert.equal(await getHistoricalContextUsage(entries({ stopReason: "error" })), undefined);
});

test("an unresolvable model reports no usage instead of guessing", async (t) => {
  installRuntime(t);
  globalThis.__ompRuntimePromise = Promise.resolve({ modelRegistry: { find: () => undefined } });

  assert.equal(await getHistoricalContextUsage(entries()), undefined);
});

test("a session with no persisted model has no usage", async () => {
  // No model_change and no assistant message: `models.default` stays empty.
  const usage = await getHistoricalContextUsage([
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "hello" },
    },
  ]);

  assert.equal(usage, undefined);
});
