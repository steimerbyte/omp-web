import type { ProjectSizeEntry, ProjectSizesResponse } from "./projects-schema";

/**
 * The polling of the folder sizes, as a piece of logic instead of a piece of
 * component.
 *
 * ### Why this is not inside `ProjectsDashboard`
 *
 * The dashboard is a React component with a dozen moving parts; a test that
 * mounts it has to mount all of them. The polling *rule* — every two seconds,
 * until the server says the answer is final, at most sixty times — is a rule
 * about time and about a flag, and it can be stated without a DOM. So it
 * lives here, and `hooks/useProjectSizes.ts` binds it to React.
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
 * - And it ends after `SIZE_POLL_MAX_POLLS` polls, whatever the server says.
 *   A poll that never ends is a timer that outlives the tab, and a user who
 *   leaves the dashboard open all day would keep the server busy for nothing.
 *   After the limit the cards show what they have.
 *
 * ### Two seconds
 *
 * The measurement itself takes 20,5 s for the 18 roots of a real registry
 * (measured 2026-10-22 on the dev host, the details in
 * `lib/project-size.ts`), so the poll interval is not about freshness — it
 * is about not asking the server more often than a human can notice. Two
 * seconds means the number appears on the card within two seconds of the
 * measurement landing, and the endpoint it hits reads one small JSON file.
 */

/** The gap between two polls. */
export const SIZE_POLL_INTERVAL_MS = 2_000;

/**
 * How many polls at most, per polling cycle.
 *
 * Sixty polls at two seconds is two minutes — longer than the measurement
 * needs on the dev host (20,5 s for 18 folders, and about 60 s for a cold
 * run that hits the 30 s per-folder budget, measured 2026-10-22), and short
 * enough that a dashboard nobody looks at stops asking.
 */
export const SIZE_POLL_MAX_POLLS = 60;

export interface SizePollerOptions {
  /** Ask the server for the current sizes. */
  fetchSizes: () => Promise<ProjectSizesResponse>;
  /** The sizes that arrived. They replace the sizes on the cards. */
  onSizes: (sizes: ProjectSizeEntry[]) => void;
  /** A failed request. The poll continues; the next one may work. */
  onError?: (error: unknown) => void;
  intervalMs?: number;
  maxPolls?: number;
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

/** The handle a timer hands back. Named here, because the timer is injectable. */
type TimerHandle = Parameters<typeof clearTimeout>[0];

export function startSizePoller({
  fetchSizes,
  onSizes,
  onError,
  intervalMs = SIZE_POLL_INTERVAL_MS,
  maxPolls = SIZE_POLL_MAX_POLLS,
  setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer = (handle) => clearTimeout(handle as TimerHandle),
}: SizePollerOptions): SizePoller {
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
