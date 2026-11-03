import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./request-body.ts");
}

/** A stream that counts how often it was actually read and cancelled. */
function countedStream(chunks) {
  const state = { reads: 0, cancelled: 0, index: 0 };
  const stream = new ReadableStream({
    pull(controller) {
      if (state.index >= chunks.length) {
        controller.close();
        return;
      }
      state.reads += 1;
      controller.enqueue(new Uint8Array(chunks[state.index++]));
    },
    cancel() {
      state.cancelled += 1;
    },
  });
  return { stream, state };
}

test("accepts a body under the limit", async () => {
  const { readJsonBodyWithinLimit } = await loadSubject();
  const request = new Request("http://localhost/api/agent/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "prompt", text: "hallo" }),
  });

  assert.deepEqual(await readJsonBodyWithinLimit(request, 1024), { type: "prompt", text: "hallo" });
});

test("rejects a declared oversized body without reading the stream", async () => {
  const { readJsonBodyWithinLimit, RequestBodyTooLargeError } = await loadSubject();
  const { stream } = countedStream([new TextEncoder().encode("{}")]);
  const request = new Request("http://localhost/api/agent/x", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "62914589" },
    body: stream,
    duplex: "half",
  });

  await assert.rejects(() => readJsonBodyWithinLimit(request, 1024), (error) => {
    assert.ok(error instanceof RequestBodyTooLargeError);
    // Der deklarierte Wert beweist den Header-Zweig: haette der Reader den
    // Stream gezaehlt, stuende hier 1 (die Fixture liefert genau ein Byte).
    assert.equal(error.bytes, 62914589);
    return true;
  });
});

test("stops a chunked body at the limit instead of buffering it", async () => {
  const { readJsonBodyWithinLimit, RequestBodyTooLargeError } = await loadSubject();
  // 6 + 6 bytes against a 10-byte limit: the second read already has the
  // overrun in hand and must abort there, not read the third chunk.
  const { stream, state } = countedStream([[1, 1, 1, 1, 1, 1], [1, 1, 1, 1, 1, 1], [1, 1]]);
  const request = new Request("http://localhost/api/agent/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    duplex: "half",
  });
  assert.equal(request.headers.get("content-length"), null, "Fixture ist nicht chunked");

  await assert.rejects(() => readJsonBodyWithinLimit(request, 10), RequestBodyTooLargeError);
  assert.equal(state.reads, 2, "nach dem Ueberschreiten wurde weitergelesen");
  assert.equal(state.cancelled, 1, "der abgebrochene Stream wurde nicht gecancelt");
});

test("accepts a chunked body without Content-Length", async () => {
  const { readJsonBodyWithinLimit } = await loadSubject();
  const body = new TextEncoder().encode(JSON.stringify({ type: "get_state" }));
  const { stream } = countedStream([body.slice(0, 4), body.slice(4)]);
  const request = new Request("http://localhost/api/agent/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    duplex: "half",
  });

  assert.deepEqual(await readJsonBodyWithinLimit(request, 1024), { type: "get_state" });
});

test("ignores a malformed Content-Length and parses the body", async () => {
  const { readJsonBodyWithinLimit, declaredContentLength } = await loadSubject();
  const { stream } = countedStream([new TextEncoder().encode('{"ok":true}')]);
  const request = new Request("http://localhost/api/agent/x", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "12abc" },
    body: stream,
    duplex: "half",
  });

  assert.equal(declaredContentLength(request), null);
  assert.deepEqual(await readJsonBodyWithinLimit(request, 1024), { ok: true });
});

test("still bounds the bytes when Content-Length is malformed", async () => {
  const { readJsonBodyWithinLimit, RequestBodyTooLargeError } = await loadSubject();
  const { stream } = countedStream([[1, 1, 1, 1, 1, 1], [1, 1, 1, 1, 1, 1]]);
  const request = new Request("http://localhost/api/agent/x", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "0x10" },
    body: stream,
    duplex: "half",
  });

  await assert.rejects(() => readJsonBodyWithinLimit(request, 10), RequestBodyTooLargeError);
});

test("declaredContentLength accepts plain integers and rejects everything else", async () => {
  const { declaredContentLength } = await loadSubject();
  const withHeader = (value) => new Request("http://localhost/", { headers: value === undefined ? {} : { "content-length": value } });

  assert.equal(declaredContentLength(withHeader(undefined)), null);
  assert.equal(declaredContentLength(withHeader("")), null);
  assert.equal(declaredContentLength(withHeader("12abc")), null);
  assert.equal(declaredContentLength(withHeader("-1")), null);
  assert.equal(declaredContentLength(withHeader("1024")), 1024);
});
