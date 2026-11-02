import assert from "node:assert/strict";
import test from "node:test";
import * as subagentGroups from "./subagent-groups.ts";

const { groupSubagentRows, isSubagentActive } = subagentGroups;

const row = (id, parentToolCallId, status = "running") => ({
  id,
  parentToolCallId,
  status,
  index: 0,
  agent: "task",
  agentSource: "bundled",
  lastUpdate: 0,
});

const BASE_ROWS = [
  row("root-1", "call_root"),
  row("g1", "call_child"),
  row("g2", "call_child"),
  row("f1", "call_child", "completed"),
  row("f2", "call_child", "failed"),
  row("g1", "call_child"), // the same id twice: two frames, two rows
  row("solo"),
  row("root-2", "call_root"),
];

/** Every batch's output positions are consecutive. */
function assertBatchesContiguous(output) {
  const positions = new Map();
  output.forEach((entry, index) => {
    if (!entry.parentToolCallId) return;
    const seen = positions.get(entry.parentToolCallId) ?? [];
    seen.push(index);
    positions.set(entry.parentToolCallId, seen);
  });
  for (const [key, indexes] of positions) {
    assert.equal(
      indexes.at(-1) - indexes[0] + 1,
      indexes.length,
      `batch ${key} is not contiguous: ${indexes.join(",")}`,
    );
  }
}

/** A batch keeps the relative order of its rows from the input. */
function assertStableBatchOrder(input, output) {
  const keys = new Set(input.map((entry) => entry.parentToolCallId).filter(Boolean));
  for (const key of keys) {
    assert.deepEqual(
      output.filter((entry) => entry.parentToolCallId === key).map((entry) => entry.id),
      input.filter((entry) => entry.parentToolCallId === key).map((entry) => entry.id),
    );
  }
}

test("grouping is a reorder-only permutation for any input order", () => {
  const permutations = [
    BASE_ROWS,
    [...BASE_ROWS].reverse(),
    BASE_ROWS.map((_, index) => BASE_ROWS[(index + 3) % BASE_ROWS.length]),
    BASE_ROWS.map((_, index) => BASE_ROWS[(index * 5) % BASE_ROWS.length]),
  ];

  for (const input of permutations) {
    const output = groupSubagentRows(input);
    assert.equal(output.length, input.length);
    assert.deepEqual(output.map((entry) => entry.id).sort(), input.map((entry) => entry.id).sort());
    assertBatchesContiguous(output);
    assertStableBatchOrder(input, output);
  }

  // Batch order follows first appearance; the solo row keeps its own group.
  assert.deepEqual(
    groupSubagentRows(BASE_ROWS).map((entry) => entry.id),
    ["root-1", "root-2", "g1", "g2", "f1", "f2", "g1", "solo"],
  );
});

test("finished rows survive grouping and stay in their batch", () => {
  const rows = [
    row("a", "batch", "completed"),
    row("b", "batch", "failed"),
    row("c", "batch", "aborted"),
    row("live", "batch", "running"),
  ];
  const output = groupSubagentRows(rows);

  // A status filter would shrink this to the single live row; the panel also
  // groups its finished slice, which such a filter would empty.
  assert.equal(output.length, rows.length);
  assert.deepEqual(
    output.filter((entry) => !isSubagentActive(entry)).map((entry) => entry.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(output.map((entry) => entry.id), ["a", "b", "c", "live"]);
});

test("a solo whose id equals a batch key is not merged into that batch", () => {
  const rows = [
    row("ghost"), // key `id:ghost`
    row("b1", "ghost"), // batch key `ghost`
    row("b2", "ghost"),
  ];
  const output = groupSubagentRows(rows);

  assert.equal(output.length, 3);
  assert.deepEqual(output.map((entry) => entry.id), ["ghost", "b1", "b2"]);
  assert.equal(output.filter((entry) => entry.parentToolCallId === undefined).length, 1);
  assert.equal(output.filter((entry) => entry.parentToolCallId === "ghost").length, 2);
});

test("keeps duplicate ids instead of merging frames", () => {
  const rows = [row("dup", "batch"), row("dup", "batch", "completed")];
  const output = groupSubagentRows(rows);

  assert.equal(output.length, 2);
  assert.deepEqual(output.map((entry) => entry.id), ["dup", "dup"]);
});

test("is idempotent for already-grouped input", () => {
  const once = groupSubagentRows(BASE_ROWS);
  assert.deepEqual(groupSubagentRows(once).map((entry) => entry.id), once.map((entry) => entry.id));
});

test("exports exactly the two presentation helpers", () => {
  assert.deepEqual(Object.keys(subagentGroups).sort(), ["groupSubagentRows", "isSubagentActive"]);
});
