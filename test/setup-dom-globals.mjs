/**
 * Globals that linkedom does not provide, installed before any test module.
 *
 * React's `act` and Radix's focus handling and portals read these off the
 * global when their module is *evaluated*, not when it is called. Which test
 * file imports a component first is decided by the file name sort order, so a
 * file that mounts a component and a sibling that only imports it disagreed
 * about whether `MutationObserver` existed yet — and the loser failed with
 * "MutationObserver is not defined" for a reason unrelated to the code under
 * test.
 *
 * Bun loads this through `bunfig.toml` before the first test file, which
 * removes the race rather than documenting it.
 *
 * These are stubs: they record nothing and drive nothing. A test that asserts
 * on resize or intersection behaviour has to install its own, and the
 * component tests that do (`DialogFocus.test.mjs`) still do.
 */

// `bun test` runs this process with `NODE_ENV=production` unless told
// otherwise, and React resolves through the `default` export condition, so it
// then loads its production build — where `act` is not exported at all. Set it
// before React is imported anywhere. `bunfig.toml`'s `[test] env` does not
// override the value Bun itself injects, which is why it is set here as well.
process.env.NODE_ENV = "test";

/**
 * Give linkedom's events a writable `eventPhase`.
 *
 * Bun's `Event.prototype` defines `eventPhase` as an accessor with a getter
 * and **no setter**, so a plain assignment throws "Attempted to assign to
 * readonly property". linkedom's own `Event` uses a data property and assigns
 * fine — but only for events built from *its* class, and linkedom's
 * `CustomEvent` extends **Bun's** `GlobalEvent`, not linkedom's `Event`. The
 * chain is `CustomEvent -> CustomEvent -> GlobalEvent -> Object`, so an event
 * created by Radix reaches Bun's getter-only descriptor no matter which class
 * a test file installed.
 *
 * Radix dispatches such an event from `react-dismissable-layer`'s
 * `dispatchUpdate`. linkedom's `dispatchEvent` then writes `eventPhase`, that
 * throws, React swallows it, and the dialog never appears — the assertion
 * fails on "der Bestaetigungs-Knopf wurde nicht gerendert", a long way from
 * the cause.
 *
 * Running late is the point: the test files that export linkedom's classes do
 * it at their own module scope, which is *after* every preload. Bun exposes no
 * post-load hook, so this patches on first use — `patchEventPhase()` is called
 * by `testJiti()` before a component graph is built, which is the last moment
 * before the code that dispatches such an event is loaded.
 */
export function patchEventPhase() {
  // Deliberately *not* guarded by a single "already ran" flag. Each test file
  // installs linkedom's own event classes on `globalThis` at its module scope,
  // so the classes present at the first call are replaced by the time the next
  // file runs. A one-shot flag patched the first generation and left every
  // later one inheriting Bun's getter-only descriptor again. Patching is
  // itself idempotent — a class that already owns a writable `eventPhase` is
  // skipped — so it is safe to call on every use.
  for (const name of ["Event", "CustomEvent", "UIEvent", "MouseEvent", "KeyboardEvent", "PointerEvent", "FocusEvent", "InputEvent", "WheelEvent"]) {
    const ctor = globalThis[name];
    if (typeof ctor !== "function") continue;
    const proto = ctor.prototype;
    if (Object.prototype.hasOwnProperty.call(proto, "eventPhase")) continue;

    let inherited = proto;
    while (inherited && inherited !== Object.prototype
      && !Object.prototype.hasOwnProperty.call(inherited, "eventPhase")) {
      inherited = Object.getPrototypeOf(inherited);
    }
    if (!inherited || inherited === Object.prototype) continue;

    const own = new WeakMap();
    Object.defineProperty(proto, "eventPhase", {
      get() {
        return own.get(this) ?? 0;
      },
      set(value) {
        own.set(this, value);
      },
      configurable: true,
      enumerable: true,
    });
  }
}

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

// `takeRecords` is only meaningful on MutationObserver, and linkedom's absence
// of it is what made the earlier stub throw instead of returning nothing.
if (!("MutationObserver" in globalThis)) {
  globalThis.MutationObserver = NoopObserver;
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = NoopObserver;
}
if (!("IntersectionObserver" in globalThis)) {
  globalThis.IntersectionObserver = NoopObserver;
}

// linkedom runs no layout and no animation loop. React only needs these to
// exist for its scheduler; a macrotask is close enough for a test that then
// awaits explicitly.
if (!("requestAnimationFrame" in globalThis)) {
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 16);
  globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle);
}

// `act` only flushes synchronously when React knows it is in a test. Three
// test files set this and one did not; setting it here means no file's result
// depends on which files ran before it.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;