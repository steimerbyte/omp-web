import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `GET /api/models-config/catalog` proxies models.dev for the provider editor.
 *
 * The upstream is stubbed: the test cares that a failed or empty upstream is a
 * 502 (not an empty success the editor would show as "no models"), that the
 * result is cached, and that a second caller during the same fetch joins it.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const route = await jiti.import("./route.ts");

const realFetch = globalThis.fetch;
const ORIGIN = "http://localhost:30141";

function get(query = "") {
  return route.GET(new Request(`${ORIGIN}/api/models-config/catalog${query}`, { headers: { host: "localhost:30141" } }));
}

function resetCache() {
  delete globalThis.__ompModelsDevCatalogCache;
}

const UPSTREAM = {
  acme: {
    id: "acme",
    name: "Acme",
    models: {
      "acme-pro": { id: "acme-pro", name: "Acme Pro", attachment: false, reasoning: true, tool_call: true },
      "acme-lite": { id: "acme-lite", name: "Acme Lite", attachment: false, reasoning: false, tool_call: false },
    },
  },
};

test.after(() => {
  globalThis.fetch = realFetch;
  resetCache();
});

test("der Katalog wird geflattet, gefiltert und als models/recommendation geliefert", async () => {
  resetCache();
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    assert.match(String(url), /^https:\/\/models\.dev\/api\.json$/);
    return Response.json(UPSTREAM);
  };

  const response = await get("?q=acme&limit=1");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.source, "https://models.dev/api.json");
  assert.equal(body.models.length, 1, "limit wird nicht angewendet");
  assert.equal(body.models[0].providerId, "acme");
  assert.equal(typeof body.recommendation, "object");

  // Same cache entry: the second request must not fetch again.
  const second = await get("?q=acme");
  assert.equal(second.status, 200);
  assert.equal(calls, 1, "der Katalog wurde erneut geladen");

  // A request that bypasses the identity/host gate would still be cached; the
  // filter is per request, not baked into the cache.
  assert.equal((await second.json()).models.length, 2);
});

test("ein HTTP-Fehler des Upstreams ist 502 mit der Ursache", async () => {
  resetCache();
  globalThis.fetch = async () => new Response("nope", { status: 503 });
  const response = await get();
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /HTTP 503/);
});

test("ein leerer Katalog ist ein Fehler, keine leere Erfolgsliste", async () => {
  resetCache();
  globalThis.fetch = async () => Response.json({});
  const response = await get();
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /empty catalog/);
});

test("ein nicht-numerisches limit faellt auf den Default zurueck, ohne zu werfen", async () => {
  resetCache();
  globalThis.fetch = async () => Response.json(UPSTREAM);
  const response = await get("?limit=abc");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).models.length, 2);
});

test("ein Netzwerkfehler wird als 502 gemeldet", async () => {
  resetCache();
  globalThis.fetch = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  const response = await get();
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /ECONNREFUSED/);
});
