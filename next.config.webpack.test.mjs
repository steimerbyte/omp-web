// next.config.ts: die headers()-Regeln prueft die bestehende Datei; der
// webpack-Zweig (Instrumentation-Ausschluss fuer Client/Edge, SDK-externals fuer
// den Server) wurde nie ausgefuehrt.
import assert from "node:assert/strict";
import test from "node:test";

const config = (await import("./next.config.ts")).default;

test("Client- und Edge-Bundles bekommen kein http-dispatcher-Modul", () => {
  for (const ctx of [{ isServer: false, nextRuntime: "nodejs" }, { isServer: true, nextRuntime: "edge" }]) {
    const input = { resolve: { alias: {} }, externals: undefined };
    const result = config.webpack(input, ctx);
    assert.equal(result, input);
    assert.equal(result.resolve.alias["@/lib/http-dispatcher"], false);
  }
});

test("der Server-Bundle laesst @oh-my-pi ein Runtime-import sein und behaelt eigene externals", () => {
  const input = { resolve: { alias: {} }, externals: ["schon-da"] };
  const result = config.webpack(input, { isServer: true, nextRuntime: "nodejs" });
  assert.equal(typeof result.externals[0], "function");
  assert.equal(result.externals[1], "schon-da");

  const calls = [];
  const callback = (...args) => calls.push(args);
  result.externals[0]({ request: "@oh-my-pi/pi-ai" }, callback);
  result.externals[0]({ request: "@oh-my-pi/pi-coding-agent/mcp/manager" }, callback);
  result.externals[0]({ request: "react" }, callback);
  result.externals[0]({}, callback);

  assert.deepEqual(calls[0], [undefined, "import @oh-my-pi/pi-ai"]);
  assert.deepEqual(calls[1], [undefined, "import @oh-my-pi/pi-coding-agent/mcp/manager"]);
  // Kein Treffer: der Callback wird ohne Argumente gerufen, damit webpack
  // selbst aufloest.
  assert.equal(calls[2].length, 0);
  assert.equal(calls[3].length, 0);
});

test("ohne vorhandene externals bleibt nur die SDK-Regel", () => {
  const input = { resolve: { alias: {} }, externals: undefined };
  const result = config.webpack(input, { isServer: true, nextRuntime: "nodejs" });
  assert.equal(result.externals.length, 1);
  assert.equal(typeof result.externals[0], "function");
});
