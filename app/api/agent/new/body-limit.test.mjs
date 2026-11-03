import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `/api/agent/new` nimmt denselben Prompt-Body wie `/api/agent/[id]` und hatte
 * gar keinen Deckel: `req.json()` las, was ankam. Der gemeinsame Reader aus
 * `lib/request-body.ts` wird hier verdrahtet geprueft — die Byte-Grenze selbst
 * deckt `lib/request-body.test.mjs` ab.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
});

const newRoute = await jiti.import("./route.ts");
const { MAX_AGENT_REQUEST_BODY_BYTES } = await jiti.import("@/lib/request-body");

const HEADERS = { host: "localhost", "content-type": "application/json" };

test("rejects a declared oversized body with 413 before looking at cwd", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"type":"get_state"}'));
      controller.close();
    },
  });
  const request = new Request("http://localhost/api/agent/new", {
    method: "POST",
    headers: { ...HEADERS, "content-length": String(MAX_AGENT_REQUEST_BODY_BYTES + 1) },
    body,
    duplex: "half",
  });

  const response = await newRoute.POST(request);

  assert.equal(response.status, 413, `erwartet 413, bekam ${response.status}`);
  const payload = await response.json();
  assert.equal(payload.code, "prompt_rejected");
  assert.equal(payload.accepted, false);
});

test("lets a body under the cap through to the route's own validation", async () => {
  const request = new Request("http://localhost/api/agent/new", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ type: "get_state" }),
  });

  const response = await newRoute.POST(request);

  assert.equal(response.status, 400, `erwartet 400 (cwd fehlt), bekam ${response.status}`);
  assert.equal((await response.json()).error, "cwd is required");
});
