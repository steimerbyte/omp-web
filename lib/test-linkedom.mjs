import test from "node:test";

/**
 * linkedom shares `HTMLElement`/`Element` between every `parseHTML` window of a
 * process, and `bun test` runs all files in one process — so a prototype stub
 * installed by one test file is visible to every file that runs after it.
 *
 * Measured 2026-11-02: `FileExplorer.*` leaves a 600px
 * `getBoundingClientRect`/`clientHeight` behind, and `CalendarView` then
 * measured a chip as 600px tall — the calendar rendered "2 weitere" instead of
 * its chips in the full suite while the file passed alone.
 *
 * Call right after the window exists, before this file patches anything: the
 * snapshot then holds what the file inherited, and the returned `restore` puts
 * exactly that back.
 */
export function captureLinkedomPrototypes(win) {
  const snapshot = [win.HTMLElement.prototype, win.Element.prototype].map((proto) => ({
    proto,
    own: new Map(
      Object.getOwnPropertyNames(proto).map((name) => [name, Object.getOwnPropertyDescriptor(proto, name)]),
    ),
  }));
  return () => {
    for (const { proto, own } of snapshot) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (own.has(name)) continue;
        // Non-configurable properties belong to someone else; deleting throws.
        if (Object.getOwnPropertyDescriptor(proto, name)?.configurable) delete proto[name];
      }
      for (const [name, descriptor] of own) {
        if (Object.getOwnPropertyDescriptor(proto, name)?.configurable === false) continue;
        Object.defineProperty(proto, name, descriptor);
      }
    }
  };
}

/** `captureLinkedomPrototypes` for a window created at module load. */
export function restoreLinkedomPrototypesOnExit(win) {
  const restore = captureLinkedomPrototypes(win);
  test.after(restore);
}
