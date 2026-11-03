import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RUN_BUDGET_LIMITS, SessionRunBudget } from "./session-run-budget.ts";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test("the request cap allows exactly maxRequests frames and ends the run on the next", () => {
  const reasons = [];
  const budget = new SessionRunBudget((reason) => reasons.push(reason), {
    maxRequests: 3,
    maxWallClockMs: 60_000,
  });

  budget.begin();
  budget.noteRequest();
  budget.noteRequest();
  budget.noteRequest();
  assert.deepEqual(reasons, [], "the cap's own requests are still allowed");
  assert.equal(budget.requests, 3);
  assert.equal(budget.active, true);

  budget.noteRequest();
  assert.deepEqual(reasons, ["requests"]);
  assert.equal(budget.active, false);
  assert.equal(budget.requests, 4);
});

test("an ended run ignores stale tokens and later frames", () => {
  const reasons = [];
  const budget = new SessionRunBudget((reason) => reasons.push(reason), {
    maxRequests: 1,
    maxWallClockMs: 60_000,
  });

  const stale = budget.begin();
  const current = budget.begin();
  budget.end(stale);
  assert.equal(budget.active, true, "a stale token must not end the new run");
  budget.end(current);
  assert.equal(budget.active, false);

  budget.noteRequest();
  assert.deepEqual(reasons, [], "frames outside a run are not budgeted");
});

test("frames from an ended run do not count against the next one", () => {
  const reasons = [];
  const budget = new SessionRunBudget((reason) => reasons.push(reason), {
    maxRequests: 2,
    maxWallClockMs: 60_000,
  });

  budget.begin();
  budget.noteRequest();
  budget.noteRequest();
  budget.end();

  budget.begin();
  budget.noteRequest();
  budget.noteRequest();
  assert.deepEqual(reasons, []);
  budget.noteRequest();
  assert.deepEqual(reasons, ["requests"]);
});

test("the wall-clock ceiling ends a run that never starts another request", async () => {
  const reasons = [];
  const budget = new SessionRunBudget((reason) => reasons.push(reason), {
    maxRequests: 1000,
    maxWallClockMs: 5,
  });

  budget.begin();
  await tick(25);
  assert.deepEqual(reasons, ["wall-clock"]);
  assert.equal(budget.active, false);
});

test("ending a run cancels its wall-clock timer, so a finished run cannot abort later", async () => {
  const reasons = [];
  const budget = new SessionRunBudget((reason) => reasons.push(reason), {
    maxRequests: 1000,
    maxWallClockMs: 5,
  });

  const run = budget.begin();
  budget.end(run);
  await tick(25);
  assert.deepEqual(reasons, []);
});

test("the production defaults are generous enough for a long legitimate run", () => {
  // A runaway loop is the target, not a long task: several dozen requests and
  // tens of minutes of work must stay far below the shipped limits.
  assert.ok(DEFAULT_RUN_BUDGET_LIMITS.maxRequests >= 100);
  assert.ok(DEFAULT_RUN_BUDGET_LIMITS.maxWallClockMs >= 10 * 60 * 1000);
});
