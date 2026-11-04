import assert from "node:assert/strict";
import test from "node:test";
import { downscaleImageFile, estimateWireBytes } from "./image-downscale.ts";

/**
 * Der Downscaler laeuft im Browser; hier steht die Plattform als Attrappe.
 *
 * Was zaehlt, ist die Entscheidungskette: zu klein -> unveraendert, sonst
 * skalieren und neu kodieren, und bei jedem Fehlschlag die Originaldatei
 * behalten statt das Bild zu verlieren.
 */

function imageFile(bytes, name = "photo.png") {
  return new File([new Uint8Array(bytes).fill(7)], name, { type: "image/png" });
}

function installPlatform(t, { width = 4000, height = 3000, canvas, bitmapError, noDocument = false } = {}) {
  const previous = {
    createImageBitmap: globalThis.createImageBitmap,
    document: globalThis.document,
  };
  const closed = [];
  globalThis.createImageBitmap = async (file) => {
    if (bitmapError) throw bitmapError;
    return { width, height, close: () => closed.push(file.name) };
  };
  if (noDocument) delete globalThis.document;
  else globalThis.document = { createElement: () => canvas };
  t.after(() => {
    if (previous.createImageBitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = previous.createImageBitmap;
    if (previous.document === undefined) delete globalThis.document;
    else globalThis.document = previous.document;
  });
  return { closed };
}

function fakeCanvas({ blobBytes = 600, blobType = "image/jpeg", withToBlob = true, withContext = true, dataUrl } = {}) {
  const calls = { sizes: [], qualities: [], drawn: [] };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => withContext ? { drawImage: (_bitmap, x, y, w, h) => calls.drawn.push([x, y, w, h]) } : null,
    toDataURL: () => dataUrl ?? `data:image/jpeg;base64,${Buffer.alloc(blobBytes, 3).toString("base64")}`,
  };
  if (withToBlob) {
    canvas.toBlob = (callback, mime, quality) => {
      calls.sizes.push([canvas.width, canvas.height]);
      calls.qualities.push(quality);
      callback(new Blob([new Uint8Array(blobBytes)], { type: blobType }));
    };
  }
  return { canvas, calls };
}

test("a file inside both budgets is returned untouched and not re-encoded", async (t) => {
  const { canvas, calls } = fakeCanvas();
  const platform = installPlatform(t, { width: 800, height: 600, canvas });
  const file = imageFile(500);

  const result = await downscaleImageFile(file, { maxLongestSide: 2048, maxBytes: 1024 });

  assert.equal(result, file);
  assert.deepEqual(calls.sizes, []);
  assert.equal(platform.closed.length, 1, "the probe bitmap is decoded once and closed");
});

test("an oversized photo is scaled into the box and renamed to JPEG", async (t) => {
  const { canvas, calls } = fakeCanvas({ blobBytes: 600 });
  installPlatform(t, { width: 4000, height: 3000, canvas });

  const result = await downscaleImageFile(imageFile(50_000, "holiday.PNG"), {
    maxLongestSide: 2000,
    maxBytes: 1000,
  });

  assert.equal(result.name, "holiday.jpg");
  assert.equal(result.type, "image/jpeg");
  assert.equal(result.size, 600);
  // fitWithin(4000, 3000, 2000) keeps the 4:3 ratio.
  assert.deepEqual(calls.sizes, [[2000, 1500]]);
  assert.deepEqual(calls.drawn, [[0, 0, 2000, 1500]]);
  assert.deepEqual(calls.qualities, [0.92]);
});

test("a webp canvas result is accepted and still saved as .jpg", async (t) => {
  const { canvas } = fakeCanvas({ blobBytes: 700, blobType: "image/webp" });
  installPlatform(t, { width: 3000, height: 1000, canvas });

  const result = await downscaleImageFile(imageFile(50_000, "scan.jpeg"), {
    maxLongestSide: 1200,
    maxBytes: 1000,
  });

  assert.equal(result.type, "image/webp");
  assert.equal(result.name, "scan.jpg");
  assert.equal(result.size, 700);
});

test("a PNG-producing canvas is refused so base64 does not grow", async (t) => {
  const { canvas } = fakeCanvas({ blobBytes: 300, blobType: "image/png" });
  installPlatform(t, { width: 4000, height: 4000, canvas });
  const file = imageFile(50_000);

  const result = await downscaleImageFile(file, { maxLongestSide: 1024, maxBytes: 1000 });

  assert.equal(result, file);
});

test("a canvas without toBlob falls back to the data-URL encoder", async (t) => {
  const bytes = 900;
  const dataUrl = `data:image/jpeg;base64,${Buffer.alloc(bytes, 5).toString("base64")}`;
  const { canvas } = fakeCanvas({ withToBlob: false, dataUrl });
  installPlatform(t, { width: 4000, height: 3000, canvas });

  const result = await downscaleImageFile(imageFile(50_000, "fallback.png"), {
    maxLongestSide: 1600,
    maxBytes: 1000,
  });

  assert.equal(result.name, "fallback.jpg");
  assert.equal(result.size, bytes);
});

test("an unparseable data URL keeps the original file", async (t) => {
  const { canvas } = fakeCanvas({ withToBlob: false, dataUrl: "not-a-data-url" });
  installPlatform(t, { width: 4000, height: 3000, canvas });
  const file = imageFile(50_000);

  assert.equal(await downscaleImageFile(file, { maxLongestSide: 1600, maxBytes: 1000 }), file);
});

test("a canvas without a 2d context keeps the original file", async (t) => {
  const { canvas } = fakeCanvas({ withContext: false });
  installPlatform(t, { width: 4000, height: 3000, canvas });
  const file = imageFile(50_000);

  assert.equal(await downscaleImageFile(file, { maxLongestSide: 1600, maxBytes: 1000 }), file);
});

test("an undecodable file is sent as-is instead of being rejected", async (t) => {
  const { canvas } = fakeCanvas();
  installPlatform(t, { width: 0, height: 0, canvas, bitmapError: new Error("unsupported") });
  const file = imageFile(50_000);

  assert.equal(await downscaleImageFile(file, { maxLongestSide: 100, maxBytes: 10 }), file);
});

test("when every scale and quality stays over budget the original survives", async (t) => {
  const { canvas, calls } = fakeCanvas({ blobBytes: 5000 });
  installPlatform(t, { width: 4000, height: 3000, canvas });
  const file = imageFile(50_000);

  const result = await downscaleImageFile(file, { maxLongestSide: 2000, maxBytes: 1000 });

  assert.equal(result, file);
  // 4 scale steps x 4 quality steps, each a real encode attempt.
  assert.equal(calls.qualities.length, 16);
  assert.deepEqual(calls.qualities.slice(0, 4), [0.92, 0.85, 0.75, 0.65]);
});

test("without a document the file is not re-encoded", async (t) => {
  const { canvas } = fakeCanvas();
  installPlatform(t, { width: 4000, height: 3000, canvas, noDocument: true });
  const file = imageFile(50_000);

  assert.equal(await downscaleImageFile(file, { maxLongestSide: 1000, maxBytes: 10 }), file);
});

test("estimateWireBytes counts the base64 expansion, not the string length", () => {
  const base64 = Buffer.alloc(300, 1).toString("base64");

  assert.equal(base64.length, 400);
  assert.equal(estimateWireBytes(base64), 400);
  assert.equal(estimateWireBytes(Buffer.alloc(1, 1).toString("base64")), 4);
  // Not valid base64: no bytes, so nothing to charge for.
  assert.equal(estimateWireBytes("not base64!"), 0);
});
