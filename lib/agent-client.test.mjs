import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AGENT_COMMAND_TIMEOUT_MS, AgentCommandError, AgentCommandTimeoutError, isPromptRejectedError, sendAgentCommand } = await jiti.import("./agent-client.ts");

test("agent command HTTP rejections are distinguishable from transport failures", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => new Response(
    JSON.stringify({
      error: "Authentication failed",
      code: "prompt_rejected",
      accepted: false,
    }),
    { status: 500, headers: { "Content-Type": "application/json" } },
  );

  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => {
      assert.equal(error instanceof AgentCommandError, true);
      assert.equal(error.status, 500);
      assert.equal(error.message, "Authentication failed");
      assert.equal(error.code, "prompt_rejected");
      assert.equal(error.accepted, false);
      assert.equal(isPromptRejectedError(error), true);
      return true;
    },
  );

  const transportError = new TypeError("connection reset");
  globalThis.fetch = async () => {
    throw transportError;
  };

  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => {
      assert.equal(error, transportError);
      assert.equal(error instanceof AgentCommandError, false);
      assert.equal(isPromptRejectedError(error), false);
      return true;
    },
  );
});

test("only an explicit negative prompt acknowledgement is definitive", () => {
  assert.equal(
    isPromptRejectedError(new AgentCommandError("proxy failure", 502)),
    false,
  );
  assert.equal(
    isPromptRejectedError(new AgentCommandError("generic API failure", 500, "internal_error", false)),
    false,
  );
});

test("a command with no limit waits as long as the server takes", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let sawSignal = "kein fetch";
  globalThis.fetch = async (_url, init) => {
    sawSignal = init?.signal === undefined ? "ohne Signal" : "mit Signal";
    return new Response(JSON.stringify({ success: true, data: { ok: true } }), {
      headers: { "Content-Type": "application/json" },
    });
  };

  assert.deepEqual(await sendAgentCommand("s", { type: "prompt" }), { ok: true });
  assert.equal(sawSignal, "ohne Signal", "der Standard setzt keinen Abbruch — ein Prompt streamt lange");
  assert.equal(AGENT_COMMAND_TIMEOUT_MS, null, "der Standard ist 'kein Limit'");
});

test("a command with a limit aborts and reports the limit, not a bare AbortError", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  // Der Server antwortet nie: `fetch` bleibt stehen, bis das Signal kommt.
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      reject(new DOMException("The operation was aborted.", "AbortError"));
    });
  });

  const started = Date.now();
  await assert.rejects(
    sendAgentCommand("s", { type: "set_model" }, { timeoutMs: 60 }),
    (error) => {
      assert.equal(error instanceof AgentCommandTimeoutError, true);
      assert.equal(error.timeoutMs, 60);
      assert.equal(error instanceof AgentCommandError, false, "ein Timeout ist keine Serverabsage");
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 50, `der Abbruch kam nach ${elapsed} ms, also vor dem Limit`);
  assert.ok(elapsed < 3000, `der Abbruch kam nach ${elapsed} ms, also nicht erst nach dem Testende`);
});

