import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  SIZE_POLL_INTERVAL_MS,
  measurementWaves,
  measurementWorstCaseMs,
  sizePollLimitFor,
  startSizePoller,
} = await jiti.import("./project-size-poll.ts");
// The budget of the measurement, read from the module that owns it. The
// coupling test below derives the worst case from these two numbers, so it
// holds whatever they are — it does not compare two constants side by side.
const { MAX_PARALLEL, SIZE_TIMEOUT_MS } = await jiti.import("./projects-schema.ts");

/**
 * The polling of the folder sizes.
 *
 * The rule is tested here and not in the React component: the interval, the
 * limit and the end condition are a rule about time and about a flag, and
 * they can be stated without a DOM. The clock is the test's own — the poller
 * takes its timer functions as arguments, so no test has to wait two real
 * seconds for anything.
 */

/** Let the pending microtasks and the poll's own awaits run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A clock the test drives.
 *
 * `advance` runs the timers that are due, in order, and waits for the poll
 * to finish its round after each of them — a poll that schedules the next
 * timer only after its request came back.
 */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();

  return {
    setTimer(callback, delayMs) {
      const id = nextId++;
      timers.set(id, { callback, at: now + delayMs });
      return id;
    },
    clearTimer(handle) {
      timers.delete(handle);
    },
    get pendingTimers() {
      return timers.size;
    },
    get now() {
      return now;
    },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.at > target) continue;
          if (due === null || timer.at < due.timer.at) due = { id, timer };
        }
        if (due === null) break;
        timers.delete(due.id);
        now = due.timer.at;
        due.timer.callback();
        await flush();
      }
      now = target;
    },
  };
}

test("the poll interval is two seconds", () => {
  // The number is in the comment of `lib/project-size-poll.ts`, so it is
  // asserted here: a comment cannot fail, a test can.
  assert.equal(SIZE_POLL_INTERVAL_MS, 2_000);
});

/**
 * The coupling: the poll window has to outlast the measurement it waits for.
 *
 * This test does not compare two fixed numbers. It *derives* the worst case
 * of a measurement from the constants of the measurement — the pool rounds
 * are serial, and each round is bounded by the per-folder budget — and then
 * checks that the window the poller uses covers it. Change the budget and the
 * window follows; change the window and this test fails.
 *
 * **The span, not the count.** The first poll fires at t = 0, so L polls
 * cover (L − 1) intervals. A window that counted the polls was two seconds
 * short at every wave boundary — and a wave boundary is where the run needs
 * one more round than the window was computed for.
 */
test("the poll window covers the worst case of a measurement", () => {
  for (const projectCount of [1, 8, 9, 16, 17, 18, 24, 25, 26, 32, 33, 40, 50, 100]) {
    const rounds = Math.ceil(projectCount / MAX_PARALLEL);
    const worstCase = rounds * SIZE_TIMEOUT_MS;
    const span = (sizePollLimitFor(projectCount) - 1) * SIZE_POLL_INTERVAL_MS;

    assert.equal(
      measurementWorstCaseMs(projectCount),
      worstCase,
      `the worst case of ${projectCount} projects is ${rounds} serial rounds`,
    );
    assert.ok(
      span >= worstCase,
      `the poll span of ${span} ms does not cover the ${worstCase} ms of ${projectCount} projects`,
    );
  }
});

/**
 * The wave boundary: the count jumps at 9, 17, 25, 33, … projects, and the
 * window computed for the count *below* the jump still has to carry the count
 * above it — the number of projects can grow while the measurement runs, and
 * then the run needs one more round.
 */
test("the poll window carries the next wave of projects", () => {
  for (const projectCount of [8, 16, 24, 32, 40, 49]) {
    const waves = measurementWaves(projectCount);
    const nextWaveStart = waves * MAX_PARALLEL + 1;
    const span = (sizePollLimitFor(projectCount) - 1) * SIZE_POLL_INTERVAL_MS;

    assert.equal(
      measurementWaves(nextWaveStart),
      waves + 1,
      `${nextWaveStart} projects need one more round than ${projectCount}`,
    );
    assert.ok(
      span >= measurementWorstCaseMs(nextWaveStart),
      `the window of ${projectCount} projects (${span} ms) does not carry ${nextWaveStart} projects (${measurementWorstCaseMs(nextWaveStart)} ms)`,
    );
  }
});

test("the 18 projects of the measured registry get 62 polls", () => {
  // Three serial rounds of 30 s, plus one wave of reserve (the count can
  // grow while the run is in flight) and one interval for the request and
  // the write: 122 s of span, which is 61 intervals plus the first poll.
  //
  // The design named 60 polls, and those 60 polls spanned 118 s — two
  // seconds short of the 120 s that a fourth wave (25 projects) needs.
  assert.equal(sizePollLimitFor(18), 62);
  assert.equal((sizePollLimitFor(18) - 1) * SIZE_POLL_INTERVAL_MS, 122_000);
});

test("the first poll happens at once and then every two seconds", async () => {
  const clock = fakeClock();
  const asked = [];

  startSizePoller({
    fetchSizes: async () => {
      asked.push(clock.now);
      return { sizes: [], pending: true };
    },
    onSizes: () => {},
    projectCount: 18,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await flush();
  assert.equal(asked.length, 1, "the first poll does not wait for an interval");

  await clock.advance(SIZE_POLL_INTERVAL_MS);
  assert.equal(asked.length, 2);
  await clock.advance(SIZE_POLL_INTERVAL_MS);
  assert.equal(asked.length, 3);
});

test("the poll ends when the server says the answer is final", async () => {
  const clock = fakeClock();
  const asked = [];
  let pending = true;

  startSizePoller({
    fetchSizes: async () => {
      asked.push(clock.now);
      return { sizes: [{ root: "/tmp/a", sizeBytes: 1, sizeMeasuredAt: null }], pending };
    },
    onSizes: () => {},
    projectCount: 18,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await flush();
  await clock.advance(SIZE_POLL_INTERVAL_MS);
  assert.equal(asked.length, 2);

  pending = false;
  await clock.advance(SIZE_POLL_INTERVAL_MS);
  assert.equal(asked.length, 3, "the last poll was the one that learned the answer is final");

  // Nothing more: the timer is gone, so the dashboard stops asking.
  await clock.advance(SIZE_POLL_INTERVAL_MS * 10);
  assert.equal(asked.length, 3, "the poll ended with the answer");
  assert.equal(clock.pendingTimers, 0, "and left no timer behind");
});

test("the poll is bounded, whatever the server says", async () => {
  const clock = fakeClock();
  const asked = [];

  startSizePoller({
    fetchSizes: async () => {
      asked.push(clock.now);
      return { sizes: [], pending: true };
    },
    onSizes: () => {},
    projectCount: 18,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await flush();
  const limit = sizePollLimitFor(18);
  await clock.advance(SIZE_POLL_INTERVAL_MS * (limit + 2));

  assert.equal(asked.length, limit, "the poll gives up after the limit");
  assert.equal(clock.pendingTimers, 0, "and leaves no timer behind");
});

test("a failed request is reported and the poll continues", async () => {
  const clock = fakeClock();
  const asked = [];
  const errors = [];

  startSizePoller({
    fetchSizes: async () => {
      asked.push(clock.now);
      if (asked.length === 1) throw new Error("network");
      return { sizes: [], pending: true };
    },
    onSizes: () => {},
    onError: (error) => errors.push(error),
    projectCount: 18,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await flush();
  assert.equal(errors.length, 1, "the failure was reported");
  assert.equal(asked.length, 1);

  await clock.advance(SIZE_POLL_INTERVAL_MS);
  assert.equal(asked.length, 2, "the next poll was tried anyway");
});

test("the sizes that arrive are handed on", async () => {
  const clock = fakeClock();
  const received = [];

  startSizePoller({
    fetchSizes: async () => ({
      sizes: [{ root: "/tmp/a", sizeBytes: 4711, sizeMeasuredAt: "2026-10-22T12:00:00.000Z" }],
      pending: false,
    }),
    onSizes: (sizes) => received.push(sizes),
    projectCount: 18,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await flush();
  assert.equal(received.length, 1);
  assert.equal(received[0][0].root, "/tmp/a");
  assert.equal(received[0][0].sizeBytes, 4711);
});

test("stop() ends the poll and clears the timer", async () => {
  const clock = fakeClock();
  const asked = [];

  const poller = startSizePoller({
    fetchSizes: async () => {
      asked.push(clock.now);
      return { sizes: [], pending: true };
    },
    onSizes: () => {},
    projectCount: 18,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await flush();
  assert.equal(asked.length, 1);

  poller.stop();
  assert.equal(clock.pendingTimers, 0, "no timer survives the stop");

  await clock.advance(SIZE_POLL_INTERVAL_MS * 10);
  assert.equal(asked.length, 1, "no poll survives the stop");
});
