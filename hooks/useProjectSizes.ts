"use client";

import { useCallback, useEffect, useRef } from "react";
import { startSizePoller, type SizePoller } from "@/lib/project-size-poll";
import type { ProjectSizeEntry, ProjectSizesResponse } from "@/lib/projects-schema";

/**
 * The React binding for the size polling.
 *
 * The rule itself lives in `lib/project-size-poll.ts` — the interval, the
 * limit, the end condition. This hook only does the two things that are
 * React's business: it starts the poll when the dashboard has something to
 * show, and it stops it when the dashboard goes away.
 *
 * ### Why the poll starts only after the first GET
 *
 * The sizes are applied to cards that the initial `GET /api/projects` has
 * already delivered. A poll that arrives before that would find no cards to
 * write to, and the sizes it brought would be lost — the later GET would
 * then show the *older* sizes from the registry, and the poll would already
 * have stopped because the server said `pending: false`. So the poll waits
 * for `enabled`.
 *
 * ### Why the cleanup matters
 *
 * The poll owns a timer. A timer that outlives its component keeps hitting
 * the server after the user left the dashboard, and in a tab that was closed
 * without unmounting it keeps the tab's memory alive. `stop()` clears the
 * timer, and the effect's cleanup calls it.
 */
export function useProjectSizes({
  onSizes,
  onError,
  enabled = true,
  projectCount = 0,
}: {
  /** The sizes that arrived. They replace the sizes on the cards. */
  onSizes: (sizes: ProjectSizeEntry[]) => void;
  /**
   * A poll failed.
   *
   * Not optional in practice: a poll that fails silently leaves the cards on
   * "Measuring..." for two minutes, and the user never learns why. The poll
   * continues after the error — the next request may work — but the state
   * has to be visible in between.
   */
  onError?: (error: unknown) => void;
  /** Start the poll only when the board is there. */
  enabled?: boolean;
  /** How many projects the registry holds. */
  projectCount?: number;
}): () => void {
  const pollerRef = useRef<SizePoller | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const poller = startSizePoller({
      fetchSizes: async () => {
        const response = await fetch("/api/projects/sizes", { cache: "no-store" });
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as Partial<ProjectSizesResponse>;
        // The shape is checked here, at the boundary. A payload that is not
        // the answer this endpoint promises must not reach the cards as
        // `undefined` — the poller catches the error and asks again.
        if (!Array.isArray(body.sizes) || typeof body.pending !== "boolean") {
          throw new Error("unexpected answer from /api/projects/sizes");
        }
        return { sizes: body.sizes, pending: body.pending };
      },
      onSizes,
      onError,
      // The window of the poll is derived from the number of projects: it has
      // to outlast the measurement it waits for, and the worst case of that
      // measurement grows with the number of projects.
      projectCount,
    });
    pollerRef.current = poller;

    return () => {
      poller.stop();
      pollerRef.current = null;
    };
  }, [enabled, onSizes, onError, projectCount]);

  // A stable handle: the caller puts it in a dependency list or hands it to
  // a button, and a new function identity on every render would restart the
  // poll.
  return useCallback(() => {
    pollerRef.current?.restart();
  }, []);
}
