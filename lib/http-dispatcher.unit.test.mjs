import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { mock } from "bun:test";
import { configureHttpDispatcher } from "./http-dispatcher.ts";

/**
 * Achtung: `mock.module` gilt prozessweit und laesst sich nicht zuruecknehmen.
 * Deshalb laeuft dieser Test nur unter `--parallel` (eigener Worker pro Datei,
 * so wie `bun run test:unit` es faehrt); kein anderer Test importiert `undici`.
 *
 * Der Node-Zweig des Dispatchers: auf Bun laeuft er nur mit abgeschalteter
 * Laufzeit-Erkennung, und Bun's `undici`-Shim ignoriert die Fabrikoptionen.
 * Beides zusammen heisst: ohne eine Attrappe fuer `undici` sind
 * `createUndiciClient`, `createUndiciOriginDispatcher` und die beiden
 * Fabrik-Closures nicht erreichbar. Die Attrappe ist die einzige Stelle, an der
 * der Test die Modulgrenze ersetzt; `lib/http-dispatcher.ts` bleibt unberuehrt.
 */

const created = { clients: [], pools: [], agents: [], dispatcher: null, installs: 0 };
const previousBun = Object.getOwnPropertyDescriptor(process.versions, "bun");
const previousConfigured = globalThis.__ompWebHttpDispatcherConfigured;
const previousConfiguring = globalThis.__ompWebHttpDispatcherConfiguring;

class FakeClient extends EventEmitter {
  constructor(origin, options) {
    super();
    this.origin = origin;
    this.options = options;
    created.clients.push(this);
  }
}

class FakePool extends EventEmitter {
  constructor(origin, options) {
    super();
    this.origin = origin;
    this.options = options;
    created.pools.push(this);
  }
}

class FakeEnvHttpProxyAgent extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    created.agents.push(this);
  }
}

mock.module("undici", () => ({
  Client: FakeClient,
  Pool: FakePool,
  EnvHttpProxyAgent: FakeEnvHttpProxyAgent,
  setGlobalDispatcher: (dispatcher) => { created.dispatcher = dispatcher; },
  install: () => { created.installs += 1; },
}));

test.after(() => {
  if (previousBun) Object.defineProperty(process.versions, "bun", previousBun);
  if (previousConfigured === undefined) delete globalThis.__ompWebHttpDispatcherConfigured;
  else globalThis.__ompWebHttpDispatcherConfigured = previousConfigured;
  if (previousConfiguring === undefined) delete globalThis.__ompWebHttpDispatcherConfiguring;
  else globalThis.__ompWebHttpDispatcherConfiguring = previousConfiguring;
});

test("the Node path builds the proxy agent, its client factory and its origin factory", async () => {
  // Bun's runtime marker off: the module takes the undici path.
  delete process.versions.bun;
  delete globalThis.__ompWebHttpDispatcherConfigured;
  delete globalThis.__ompWebHttpDispatcherConfiguring;

  const first = configureHttpDispatcher(1_500);
  const second = configureHttpDispatcher(1_500);
  assert.equal(first, second, "concurrent calls share one configuration promise");
  await first;

  assert.equal(created.agents.length, 1);
  const agent = created.agents[0];
  // The idle timeout is applied to both headers and body.
  assert.equal(agent.options.bodyTimeout, 1_500);
  assert.equal(agent.options.headersTimeout, 1_500);
  assert.equal(agent.options.allowH2, false);
  assert.equal(created.dispatcher, agent, "the agent becomes the global dispatcher");
  assert.equal(created.installs, 1, "fetch is moved onto the same undici implementation");

  // `clientFactory` is the EnvHttpProxyAgent's direct-client hook.
  const direct = agent.options.clientFactory("http://direct.example", { connections: 4 });
  assert.ok(direct instanceof FakeClient);
  assert.equal(direct.origin, "http://direct.example");
  assert.equal(direct.listenerCount("error"), 1, "a terminating body cannot crash the process");

  // `factory` builds the per-origin pool and wires the client factory into it.
  const pool = agent.options.factory("http://pooled.example", { connections: 4 });
  assert.ok(pool instanceof FakePool);
  assert.equal(pool.origin, "http://pooled.example");
  assert.equal(pool.listenerCount("error"), 1);
  const pooledClient = pool.options.factory("http://pooled.example", { connections: 1 });
  assert.ok(pooledClient instanceof FakeClient);
  assert.equal(created.clients.length, 2);

  // The single-connection branch returns a bare client instead of a pool.
  const single = agent.options.factory("http://single.example", { connections: 1 });
  assert.ok(single instanceof FakeClient);
  assert.equal(single.origin, "http://single.example");
  assert.equal(created.pools.length, 1);

  // A configured dispatcher is never replaced.
  assert.equal(configureHttpDispatcher(1_500), undefined);
  assert.equal(created.agents.length, 1);
});
