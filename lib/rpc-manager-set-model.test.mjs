import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

// Stand-in for the SDK's ModelRegistry. `find` mirrors the real (provider, modelId)
// signature and fails the same way the SDK does when it is handed a single pre-joined
// "provider/modelId" selector — the regression that made the model picker unusable.
function createRegistry({ models, appearAfterRefresh = false }) {
  const findCalls = [];
  let refreshes = 0;
  let visible = appearAfterRefresh ? [] : models;

  return {
    findCalls,
    refreshCount: () => refreshes,
    registry: {
      find(...args) {
        findCalls.push(args);
        const [provider, modelId] = args;
        if (typeof modelId !== "string") {
          throw new TypeError("undefined is not an object (evaluating 'modelId.trim')");
        }
        const wantProvider = provider.trim().toLowerCase();
        const wantModel = modelId.trim().toLowerCase();
        return visible.find(
          (model) => model.provider.toLowerCase() === wantProvider && model.id.toLowerCase() === wantModel,
        );
      },
      getAll: () => models,
      getAvailable: () => visible,
      async refresh() {
        refreshes += 1;
        visible = models;
      },
    },
  };
}

function createWrapper(modelRegistry) {
  const setModelCalls = [];
  const inner = {
    sessionId: "test-session",
    modelRegistry,
    async setModel(model, role) {
      setModelCalls.push([model, role]);
    },
  };
  const eventBus = { on: () => () => {}, off: () => {}, emit: () => {} };
  return { wrapper: new AgentSessionWrapper(inner, eventBus), setModelCalls };
}

test("set_model looks the model up with (provider, modelId), not a joined selector", async () => {
  const { registry, findCalls } = createRegistry({ models: [{ provider: "openai", id: "gpt-5" }] });
  const { wrapper, setModelCalls } = createWrapper(registry);

  const result = await wrapper.send({ type: "set_model", provider: "openai", modelId: "gpt-5" });

  assert.deepEqual(findCalls, [["openai", "gpt-5"]]);
  assert.deepEqual(result, { id: "gpt-5", provider: "openai", leafId: null });
  assert.deepEqual(setModelCalls, [[{ provider: "openai", id: "gpt-5" }, undefined]]);
});

test("set_model retries with both arguments after an offline refresh", async () => {
  const { registry, findCalls, refreshCount } = createRegistry({
    models: [{ provider: "litellm", id: "claude-opus-5" }],
    appearAfterRefresh: true,
  });
  const { wrapper } = createWrapper(registry);

  const result = await wrapper.send({ type: "set_model", provider: "litellm", modelId: "claude-opus-5" });

  assert.equal(refreshCount(), 1);
  assert.deepEqual(findCalls, [
    ["litellm", "claude-opus-5"],
    ["litellm", "claude-opus-5"],
  ]);
  assert.deepEqual(result, { id: "claude-opus-5", provider: "litellm", leafId: null });
});

test("set_model reports an unknown model instead of surfacing an SDK TypeError", async () => {
  const { registry } = createRegistry({ models: [{ provider: "openai", id: "gpt-5" }] });
  const { wrapper } = createWrapper(registry);

  await assert.rejects(
    wrapper.send({ type: "set_model", provider: "openai", modelId: "does-not-exist" }),
    /Model not found: openai\/does-not-exist/,
  );
});

test("set_model passes the role through when one is given", async () => {
  const { registry } = createRegistry({ models: [{ provider: "openai", id: "gpt-5" }] });
  const { wrapper, setModelCalls } = createWrapper(registry);

  const result = await wrapper.send({ type: "set_model", provider: "openai", modelId: "gpt-5", role: "plan" });

  assert.deepEqual(result, { id: "gpt-5", provider: "openai", role: "plan", leafId: null });
  assert.deepEqual(setModelCalls, [[{ provider: "openai", id: "gpt-5" }, "plan"]]);
});

test("set_model answers with the state the client needs instead of a reload", async () => {
  // Ohne diese drei Werte muesste der Client nach jedem Wechsel
  // `GET /api/sessions/<id>` rufen und das ganze Transkript neu rendern — die
  // Ursache „sehr langsam" (Scan-Befund 2). Sie stehen im Speicher, also koennen
  // sie nicht hinter der asynchronen Journal-Spuelung zurueckbleiben.
  const { registry } = createRegistry({ models: [{ provider: "openai", id: "gpt-5" }] });
  const { wrapper } = createWrapper(registry);
  wrapper.inner.agent = { state: { thinkingLevel: "high" } };
  wrapper.inner.configuredThinkingLevel = () => "high";
  wrapper.inner.sessionManager = { getLeafId: () => "leaf-42" };

  const result = await wrapper.send({ type: "set_model", provider: "openai", modelId: "gpt-5" });

  assert.equal(result.thinkingLevel, "high", "der nachgezogene Thinking-Level");
  assert.equal(result.configuredThinkingLevel, "high");
  assert.equal(result.leafId, "leaf-42", "der Leaf nach dem model_change-Eintrag");
});
