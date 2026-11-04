import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The pure helpers of the models panel.
 *
 * They own the two rules a hand-edited `models.json` makes easy to break:
 * a compat flag can be explicitly `false` (and that is a value, not "unset"),
 * and a blank header draft must never be serialized as a header with an empty
 * name.
 */

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { setCompatBool, updateHeaderRow, serializeHeaderRows } = await jiti.import("./models-config-helpers.ts");

test("setCompatBool keeps a false override and preserves sibling keys", () => {
  assert.deepEqual(setCompatBool({ compat: { supportsStore: true } }, "supportsDeveloperRole", false), {
    compat: { supportsStore: true, supportsDeveloperRole: false },
  });
  assert.deepEqual(setCompatBool({}, "supportsDeveloperRole", true), {
    compat: { supportsDeveloperRole: true },
  });
  assert.deepEqual(setCompatBool({ compat: { supportsDeveloperRole: false } }, "supportsDeveloperRole", false), {
    compat: { supportsDeveloperRole: false },
  });
});

test("updateHeaderRow edits by row id without reordering", () => {
  const rows = [
    { id: 10, name: "X-First", value: "one" },
    { id: 11, name: "X-Second", value: "two" },
  ];
  const updated = updateHeaderRow(rows, 11, { value: "two-edited" });
  assert.deepEqual(updated, [
    { id: 10, name: "X-First", value: "one" },
    { id: 11, name: "X-Second", value: "two-edited" },
  ]);
  assert.deepEqual(updateHeaderRow(rows, 99, { name: "ghost" }), rows);
});

test("serializeHeaderRows drops unnamed drafts and returns undefined when empty", () => {
  assert.deepEqual(serializeHeaderRows([
    { id: 1, name: "X-Kept", value: "kept" },
    { id: 2, name: "  ", value: "draft" },
  ]), { "X-Kept": "kept" });
  assert.equal(serializeHeaderRows([]), undefined);
  assert.equal(serializeHeaderRows([{ id: 3, name: "", value: "" }]), undefined);
});

test("serializeHeaderRows keeps insertion order and duplicates cannot appear", () => {
  assert.deepEqual(serializeHeaderRows([
    { id: 1, name: "Z-Last", value: "1" },
    { id: 2, name: "A-First", value: "2" },
    { id: 1, name: "Z-Last", value: "3" },
  ]), { "Z-Last": "3", "A-First": "2" });
});
