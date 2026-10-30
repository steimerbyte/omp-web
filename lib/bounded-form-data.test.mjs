import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./bounded-form-data.ts");
}

function multipartBody(boundary, value) {
  return `--${boundary}\r\nContent-Disposition: form-data; name="value"\r\n\r\n${value}\r\n--${boundary}--\r\n`;
}

test("rejects a declared oversized request before reading its body", async () => {
  const { parseFormDataWithinLimit, RequestBodyTooLargeError } = await loadSubject();
  const request = new Request("http://localhost/upload", {
    method: "POST",
    headers: { "content-length": "99", "content-type": "multipart/form-data; boundary=test" },
    body: multipartBody("test", "small"),
  });

  await assert.rejects(() => parseFormDataWithinLimit(request, 10), RequestBodyTooLargeError);
});

test("stops a chunked request once its body exceeds the limit", async () => {
  const { parseFormDataWithinLimit, RequestBodyTooLargeError } = await loadSubject();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("1234"));
      controller.enqueue(new TextEncoder().encode("5678"));
      controller.close();
    },
  });
  const request = new Request("http://localhost/upload", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=test" },
    body: stream,
    duplex: "half",
  });

  await assert.rejects(() => parseFormDataWithinLimit(request, 6), RequestBodyTooLargeError);
});

test("parses multipart data inside the request limit", async () => {
  const { parseFormDataWithinLimit } = await loadSubject();
  const boundary = "test";
  const body = multipartBody(boundary, "small");
  const request = new Request("http://localhost/upload", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
  });

  const formData = await parseFormDataWithinLimit(request, body.length + 1);
  assert.equal(formData.get("value"), "small");
});

test("reports a body that ends short of its declared length as truncated", async () => {
  const { parseFormDataWithinLimit, RequestBodyTruncatedError } = await loadSubject();
  const boundary = "test";
  const body = multipartBody(boundary, "small");
  const request = new Request("http://localhost/upload", {
    method: "POST",
    headers: {
      "content-length": String(body.length + 4096),
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  // The shape the transport produces: a complete-looking stream that stops
  // early, with a Content-Length that still states the full size. Parsed
  // without the length check this is a `TypeError` from `formData()` — the
  // route's outer catch turned that into a 500.
  const error = await parseFormDataWithinLimit(request, 1024 * 1024).then(
    () => null,
    (failure) => failure,
  );
  assert.ok(error instanceof RequestBodyTruncatedError, `expected a truncation error, got ${error}`);
  assert.equal(error.received, body.length);
  assert.equal(error.declared, body.length + 4096);
});

test("keeps an honest oversize reported as too large, not as truncated", async () => {
  const { parseFormDataWithinLimit, RequestBodyTooLargeError } = await loadSubject();
  const boundary = "test";
  const body = multipartBody(boundary, "0123456789");
  const request = new Request("http://localhost/upload", {
    method: "POST",
    headers: {
      // Declared *and* delivered: the size bound has to win here, or the new
      // check would relabel every oversized upload as a transport failure.
      "content-length": String(body.length),
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  await assert.rejects(() => parseFormDataWithinLimit(request, 10), RequestBodyTooLargeError);
});
