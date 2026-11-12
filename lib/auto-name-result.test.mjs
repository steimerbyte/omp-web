import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { interpretAutoNameResponse } = await jiti.import("./auto-name-result.ts");

test("a deliberate skip is not an error", () => {
  assert.deepEqual(interpretAutoNameResponse(true, 200, { title: null, skipped: true }), { kind: "skipped" });
});

test("a non-empty title is a success", () => {
  assert.deepEqual(interpretAutoNameResponse(true, 200, { title: " X " }), { kind: "success", title: "X" });
});

test("an error body carries its message", () => {
  assert.deepEqual(interpretAutoNameResponse(false, 500, { error: "boom" }), { kind: "error", message: "boom" });
});

test("a 200 without a title and without a skip is an error", () => {
  assert.deepEqual(interpretAutoNameResponse(true, 200, { title: null }), { kind: "error", message: "HTTP 200" });
});

test("a status without an error message reports the status", () => {
  assert.deepEqual(interpretAutoNameResponse(false, 429, {}), { kind: "error", message: "HTTP 429" });
});
