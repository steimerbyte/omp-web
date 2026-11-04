import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { describeModelRole, listModelRoles } from "./model-roles.ts";

/**
 * The role projection is the browser's only view of `modelRoles`. Its contract:
 * every built-in role carries a human description, and a configured selector is
 * resolved against the models the registry actually offers.
 */

const MODEL = {
  provider: "fake-provider",
  id: "fake-model",
  name: "Fake Model",
  api: "openai-completions",
};

test("built-in roles have a description and unknown roles do not", () => {
  assert.equal(describeModelRole("default"), "Model used for ordinary turns.");
  assert.match(describeModelRole("smol"), /subagent/);
  assert.equal(describeModelRole("not-a-role"), undefined);
  assert.equal(describeModelRole(""), undefined);
});

test("a configured selector resolves to a provider/model reference", () => {
  const settings = Settings.isolated({});
  settings.setModelRole("default", "fake-provider/fake-model:high");

  const role = listModelRoles(settings, [MODEL]).find((entry) => entry.role === "default");

  assert.ok(role, "the default role is always listed");
  assert.equal(role.selector, "fake-provider/fake-model:high");
  assert.equal(role.builtin, true);
  assert.equal(role.hidden, false);
  assert.deepEqual(role.resolved, {
    provider: "fake-provider",
    modelId: "fake-model",
    name: "Fake Model",
    thinkingLevel: "high",
  });
});

test("a model without a display name yields a reference without that field", () => {
  const settings = Settings.isolated({});
  settings.setModelRole("smol", "fake-provider/fake-model");

  const role = listModelRoles(settings, [{ provider: "fake-provider", id: "fake-model", api: "openai-completions" }])
    .find((entry) => entry.role === "smol");

  assert.deepEqual(role.resolved, { provider: "fake-provider", modelId: "fake-model" });
  assert.equal(role.selector, "fake-provider/fake-model");
});

test("a selector that matches no offered model produces no resolved reference", () => {
  const settings = Settings.isolated({});
  settings.setModelRole("slow", "missing-provider/missing-model");

  const role = listModelRoles(settings, [MODEL]).find((entry) => entry.role === "slow");

  assert.equal(role.selector, "missing-provider/missing-model");
  assert.equal("resolved" in role, false);
});
