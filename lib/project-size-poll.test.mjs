import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SIZE_POLL_INTERVAL_MS, SIZE_POLL_MAX_POLLS, startSizePoller } = await jiti.import(
  "./project-size-poll.ts",
);

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

test("the poll interval is two seconds and the limit is sixty polls", () => {
  // Both numbers are in the comment of `lib/project-size-poll.ts`, so both
  // are asserted here: a comment cannot fail, a test can.
  assert.equal(SIZE_POLL_INTERVAL_MS, 2_000);
  assert.equal(SIZE_POLL_MAX_POLLS, 60);
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
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await flush();
  await clock.advance(SIZE_POLL_INTERVAL_MS * (SIZE_POLL_MAX_POLLS + 2));

  assert.equal(asked.length, SIZE_POLL_MAX_POLLS, "the poll gives up after the limit");
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
