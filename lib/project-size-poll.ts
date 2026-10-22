import { MAX_PARALLEL, SIZE_TIMEOUT_MS, type ProjectSizeEntry, type ProjectSizesResponse } from "./projects-schema";

/**
 * The polling of the folder sizes, as a piece of logic instead of a piece of
 * component.
 *
 * ### Why this is not inside `ProjectsDashboard`
 *
 * The dashboard is a React component with a dozen moving parts; a test that
 * mounts it has to mount all of them. The polling *rule* — every two seconds,
 * until the server says the answer is final — is a rule about time and about
 * a flag, and it can be stated without a DOM. So it lives here, and
 * `hooks/useProjectSizes.ts` binds it to React.
 *
 * ### The window is derived, not guessed
 *
 * The poll has to outlast the measurement it is waiting for. The worst case
 * of a measurement is `ceil(projects / MAX_PARALLEL) * SIZE_TIMEOUT_MS`,
 * because the pool rounds are **serial** — eight folders at a time, and the
 * next round only starts when the last one of the previous is done. So the
 * window has to be a function of the project count, and it is:
 * `sizePollLimitFor(projectCount)`.
 *
 * The alternative — a fixed number of polls next to the budget, hoping the two
 * match — is exactly the coupling that broke: with 60 polls of 2 s the window
 * was 120 s, and the worst case of 40 projects was 5 rounds of 30 s = 150 s.
 * The client gave up while the measurement was still running and the card
 * kept the old value. `lib/project-size-poll.test.mjs` holds the relation
 * itself now, not two numbers side by side.
 *
 * ### The rule
 *
 * - The first poll happens immediately: a measurement that finished between
 *   the initial `GET /api/projects` and the first poll should not wait for
 *   the next interval.
 * - Then every `SIZE_POLL_INTERVAL_MS`.
 * - The poll ends when the server answers `pending: false` — the sizes are
 *   final, and polling further would be asking a question whose answer
 *   cannot change.
 * - And it ends after the derived limit, whatever the server says. A poll
 *   that never ends is a timer that outlives the tab, and a user who leaves
 *   the dashboard open all day would keep the server busy for nothing. After
 *   the limit the cards show what they have.
 *
 * ### After the poll ends, the value stands
 *
 * The poll does **not** continue in a slower rhythm, and that is a decision:
 * a slow poll would trigger server-side measurement runs again, and the whole
 * point of moving the measurement into the background was to stop reading the
 * disk continuously. A run costs 6,9 s to 20,5 s of eight parallel `du`
 * processes; a poll every minute would mean one run per TTL (5 min) for as
 * long as the tab is open — 6,8 % of the filesystem, forever, for a number
 * that nobody is looking at. The old code measured on *every* request, so
 * this is still far below that, but "far below" is not a reason to keep
 * reading.
 *
 * So the size on the card is the size of the last measurement, and the card
 * says how old that measurement is once it is older than the TTL
 * (`components/projects/ProjectCard.tsx`). A fresh number needs the next
 * dashboard, not a timer.
 */

/** The gap between two polls. */
export const SIZE_POLL_INTERVAL_MS = 2_000;

/**
 * The reserve on top of the worst case, in polls.
 *
 * Fifteen polls are 30 seconds. They cover what the worst case does not: the
 * run starts when the first poll reaches the server, the request itself
 * takes a moment, and the write of the result comes after the walk.
 */
export const SIZE_POLL_RESERVE_POLLS = 15;

/**
 * The worst case of one measurement run for `projectCount` projects.
 *
 * The pool rounds are serial, so the rounds add up: eight folders at a time,
 * each of them with the budget of `SIZE_TIMEOUT_MS`.
 */
export function measurementWorstCaseMs(projectCount: number): number {
  const rounds = Math.ceil(Math.max(0, projectCount) / MAX_PARALLEL);
  return rounds * SIZE_TIMEOUT_MS;
}

/**
 * How many polls a registry of `projectCount` projects needs.
 *
 * The window of the poll has to cover the worst case of the measurement it
 * is waiting for, plus the reserve. Derived from the constants of the
 * measurement (`MAX_PARALLEL`, `SIZE_TIMEOUT_MS`), so the two cannot drift
 * apart: change the budget and the window follows.
 *
 * For the 18 projects of the measured registry that is 3 rounds of 30 s =
 * 90 s, so 45 polls plus the reserve of 15 = **60 polls** — the number the
 * design named, and the outcome of the derivation rather than its input.
 */
export function sizePollLimitFor(projectCount: number): number {
  return (
    Math.ceil(measurementWorstCaseMs(projectCount) / SIZE_POLL_INTERVAL_MS) +
    SIZE_POLL_RESERVE_POLLS
  );
}

export interface SizePollerOptions {
  /** Ask the server for the current sizes. */
  fetchSizes: () => Promise<ProjectSizesResponse>;
  /** The sizes that arrived. They replace the sizes on the cards. */
  onSizes: (sizes: ProjectSizeEntry[]) => void;
  /** A failed request. The poll continues; the next one may work. */
  onError?: (error: unknown) => void;
  /**
   * How many projects the registry holds. The poll window is derived from it
   * together with the measurement constants — see `sizePollLimitFor`.
   */
  projectCount: number;
  intervalMs?: number;
  /** Injectable, so a test can drive the clock. */
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface SizePoller {
  /** End the polling. The timer is cleared; no poll survives it. */
  stop(): void;
  /**
   * Start polling again after the poll had ended.
   *
   * Used when a project was created: the new folder owes a measurement, and
   * a poll cycle that already ended would leave the card waiting forever.
   */
  restart(): void;
}

export function startSizePoller({
  fetchSizes,
  onSizes,
  onError,
  projectCount,
  intervalMs = SIZE_POLL_INTERVAL_MS,
  setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer = (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
}: SizePollerOptions): SizePoller {
  const maxPolls = sizePollLimitFor(projectCount);
  let polls = 0;
  let stopped = false;
  let inFlight = false;
  let timer: unknown = null;

  const clearTimerIfSet = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  const poll = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    polls += 1;

    let keepGoing: boolean;
    try {
      const result = await fetchSizes();
      // A poll that was stopped while it was in flight may not write
      // anything any more — that is what `stop()` means.
      if (stopped) return;
      onSizes(result.sizes);
      // `pending: false` is the server's answer that the sizes are final.
      // The limit is the other end: a poll that never ends is a timer that
      // outlives the tab.
      keepGoing = result.pending && polls < maxPolls;
    } catch (error) {
      if (stopped) return;
      onError?.(error);
      keepGoing = polls < maxPolls;
    } finally {
      inFlight = false;
    }

    if (!keepGoing) {
      stopped = true;
      return;
    }
    timer = setTimer(() => {
      timer = null;
      void poll();
    }, intervalMs);
  };

  void poll();

  return {
    stop() {
      stopped = true;
      clearTimerIfSet();
    },
    restart() {
      // Only a poll cycle that has *ended* is restarted. A running cycle
      // needs no restart: it asks again in at most `intervalMs` and sees the
      // new project by itself. That also means a restart can never race with
      // a poll in flight — an ended cycle has no poll in flight.
      if (!stopped) return;
      stopped = false;
      polls = 0;
      void poll();
    },
  };
}
