import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { spoolUploadBody, UploadBodyTooLargeError } from "./upload-stream.ts";

function streamOf(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });
}

function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), "omp-web-upload-stream-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("spools the body chunk by chunk into a sibling temp file", async (t) => {
  const directory = scratch(t);
  const result = await spoolUploadBody(
    streamOf([[1, 2, 3], [4, 5], [6]]),
    directory,
    "report.bin",
    100,
  );

  assert.equal(result.bytes, 6);
  assert.equal(dirname(result.tempPath), directory);
  assert.match(basename(result.tempPath), /^\.report\.bin\.[0-9a-f-]+\.upload$/);
  assert.deepEqual([...readFileSync(result.tempPath)], [1, 2, 3, 4, 5, 6]);
});

test("accepts a body that is exactly the limit", async (t) => {
  const directory = scratch(t);
  const result = await spoolUploadBody(streamOf([[1], [2], [3], [4]]), directory, "exact.bin", 4);
  assert.equal(result.bytes, 4);
});

test("refuses one byte over the limit, cancels the reader and unlinks the temp file", async (t) => {
  const directory = scratch(t);
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(64).fill(1));
      controller.enqueue(new Uint8Array(64).fill(2));
      controller.enqueue(new Uint8Array(64).fill(3));
      // Ueber dem Limit bleibt die Quelle offen: der Client wuerde weiter
      // senden, und genau dieser Rest soll nicht mehr gelesen werden.
    },
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(() => spoolUploadBody(stream, directory, "big.bin", 128), UploadBodyTooLargeError);
  assert.equal(cancelled, true, "the rest of the body is not downloaded");
  assert.deepEqual(readdirSync(directory), [], "no target, no temp file");
});

test("an absent body is zero bytes, not an error", async (t) => {
  const directory = scratch(t);
  const result = await spoolUploadBody(null, directory, "empty.txt", 0);
  assert.equal(result.bytes, 0);
  assert.equal(readFileSync(result.tempPath).length, 0);
});
