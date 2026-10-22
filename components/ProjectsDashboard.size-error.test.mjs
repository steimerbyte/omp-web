import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";

/**
 * A poll that fails has to be visible.
 *
 * The sizes arrive on a poll, and the poll can fail: the endpoint answers
 * 500, or the network is gone. Before, the failure was swallowed — the poller
 * called `onError?.(error)` with no `onError` — and the board sat on
 * "Measuring..." for two minutes without saying why. The user could not tell
 * a running measurement from a broken one.
 *
 * The dashboard is mounted here, because the state that has to change lives
 * in it: the alert and the card. A test of the poller alone would only prove
 * that the poller *can* report an error.
 */

const PROJECT = {
  root: "/home/alice/workspace/omp-web",
  name: "omp-web",
  priority: "now",
  openTodos: 3,
  status: "green",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastTouchedAt: "2026-10-01T10:00:00.000Z",
  sizeBytes: null,
  chatCount: 7,
  lastSessionAt: "2026-10-01T10:00:00.000Z",
  isGit: true,
  branch: "main",
  lastActivityAt: "2026-10-01T10:00:00.000Z",
  isProtected: false,
};

/**
 * The DOM the components mount into.
 *
 * `Enter`, `Reveal` and `Shimmer` are motion components, and motion decides
 * once — at module scope — whether it can use the browser animation API. So
 * the globals have to be in place *before* the first `jiti.import` of a
 * component. Same ordering rule as `ProjectCard.path-order.test.mjs`.
 */
function installDom() {
  if (installDom.done) return installDom.document;
  const { window } = parseHTML(
    '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
  );
  const g = globalThis;
  const navigator = { languages: ["en-US"], language: "en-US", userAgent: "harness" };
  const windowProxy = new Proxy(window, {
    get(target, property) {
      if (property === "navigator") return navigator;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has(target, property) {
      return property === "navigator" || Reflect.has(target, property);
    },
  });
  g.window = windowProxy;
  g.document = window.document;
  g.navigator = navigator;
  g.location = new URL("http://localhost:30141/");
  g.HTMLElement = window.HTMLElement;
  g.Element = window.Element;
  g.Node = window.Node;
  g.Event = window.Event;
  g.KeyboardEvent = window.KeyboardEvent;
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  g.cancelAnimationFrame = (id) => clearTimeout(id);
  g.getComputedStyle = window.getComputedStyle ?? (() => ({}));

  installDom.done = true;
  installDom.document = window.document;
  return window.document;
}
installDom.done = false;
installDom.document = null;

/** The jiti loader the component tests use to import TSX. */
async function loader() {
  installDom();
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url, {
    jsx: { runtime: "automatic" },
    tsconfigPaths: true,
  });
}

/**
 * The dashboard with a `fetch` that answers the board and fails the sizes.
 *
 * @param sizesStatus the status the sizes endpoint answers with
 */
async function mountDashboard({ sizesStatus }) {
  const document = installDom();
  const jiti = await loader();
  const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
  const { ProjectsDashboard } = await jiti.import("./ProjectsDashboard.tsx");

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    if (url.startsWith("/api/projects/sizes")) {
      return new Response(JSON.stringify({ error: "boom" }), {
        status: sizesStatus,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("/api/projects")) {
      return new Response(
        JSON.stringify({
          projects: [PROJECT],
          priorities: [{ id: "now", name: "Sofort", colorValue: "var(--danger)" }],
          home: "/home/alice",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  };

  const container = document.getElementById("root");
  const root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    root.render(
      React.createElement(
        I18nProvider,
        null,
        React.createElement(ProjectsDashboard, { onOpenProject() {}, isAdmin: false }),
      ),
    );
  });
  // Let the board arrive, the poll start and the poll fail.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  const text = container.textContent ?? "";
  await act(async () => root.unmount());
  globalThis.fetch = previousFetch;
  return text;
}

test("a failing poll is named on the board and on the card", async () => {
  const text = await mountDashboard({ sizesStatus: 500 });

  assert.ok(
    !text.includes("Measuring..."),
    `the card still waits in silence: ${text}`,
  );
  assert.ok(
    text.includes("Size error"),
    `the card does not name the error: ${text}`,
  );
  assert.ok(
    text.includes("The folder sizes could not be loaded."),
    `the board does not report the failed poll: ${text}`,
  );
});
