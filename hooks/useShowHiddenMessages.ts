"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the transcript draws custom messages the harness marked
 * `display: false` (MCP mount notices, tool-roster notices, …).
 *
 * A pure surface preference with no server side, so it lives in `localStorage`
 * under `omp-show-hidden-messages` — the same line as `omp-animations` and
 * `omp-sound-enabled`. It deliberately does NOT go through `/api/settings`:
 * that route projects a schema out of the pinned `@oh-my-pi/pi-coding-agent`
 * package, so a new path there would mean patching a foreign dependency for a
 * value the server never reads.
 *
 * The default is "hidden": the flag is the harness's own signal that the
 * message is context, not conversation, and one collapsed box per notice was
 * the only thing the browser did with it.
 */

export const SHOW_HIDDEN_MESSAGES_STORAGE_KEY = "omp-show-hidden-messages";

const listeners = new Set<() => void>();
let state = false;
let loaded = false;

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): boolean {
  if (!loaded) {
    loaded = true;
    try {
      state = typeof window !== "undefined"
        && window.localStorage.getItem(SHOW_HIDDEN_MESSAGES_STORAGE_KEY) === "true";
    } catch {
      // Blocked storage or private mode. Hidden is the default, so a throw
      // here would only take the transcript down for a cosmetic switch.
    }
  }
  return state;
}

function getServerSnapshot(): boolean {
  return false;
}

export function setShowHiddenMessages(next: boolean): void {
  try {
    window.localStorage.setItem(SHOW_HIDDEN_MESSAGES_STORAGE_KEY, String(next));
  } catch {
    // The value still applies in this tab; it just will not survive a reload.
  }
  loaded = true;
  if (state === next) return;
  state = next;
  listeners.forEach((cb) => cb());
}

/** Read the switch. Every consumer re-renders when it changes. */
export function useShowHiddenMessages(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
