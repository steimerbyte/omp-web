import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";

/**
 * The three states of the size on a card.
 *
 * They are three different facts, and the card has to tell them apart:
 *
 *  - **not measured yet** — the measurement runs in the background and the
 *    number has not arrived. A placeholder ("Measuring...").
 *  - **measured, no size** — the measurement ran and produced nothing. The
 *    folder is gone, unreadable, or it ran out of time. "Size unavailable".
 *  - **measured, a lower bound** — `du` could not read part of the tree and
 *    printed the total of what it could read. The number is real and it is
 *    *not* the size of the folder, so it carries a "≥".
 *
 * And a fourth thing that is not a state of the measurement but a state of
 * the *display*: the poll ends when the server says the answer is final, so
 * the number on an open dashboard gets older. Once it is older than the TTL
 * the card says how old it is, because a number that is silently hours old
 * reads as the current state.
 *
 * The card is mounted here, not read as source text: these are decisions
 * about what the DOM says, and the DOM is where they are decided.
 */

const PROJECT = {
  root: "/home/alice/workspace/omp-web",
  name: "omp-web",
  priority: "now",
  openTodos: 3,
  status: "green",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastTouchedAt: "2026-10-01T10:00:00.000Z",
  sizeBytes: 1234,
  chatCount: 7,
  lastSessionAt: "2026-10-01T10:00:00.000Z",
  isGit: true,
  branch: "main",
  lastActivityAt: "2026-10-01T10:00:00.000Z",
  isProtected: false,
};

const PRIORITY_COLOR = "var(--danger)";

/**
 * The DOM the components mount into.
 *
 * `Enter`, `Reveal` and `Shimmer` are motion components, and motion decides
 * once — at module scope — whether it can use the browser animation API. So
 * the globals have to be in place *before* the first `jiti.import` of a
 * component, not merely before the render. Same ordering rule as
 * `ProjectCard.path-order.test.mjs`.
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

/** Mount a dashboard component inside the i18n provider. */
async function mount(element) {
  const document = installDom();
  const jiti = await loader();
  const { I18nProvider } = await jiti.import("../../hooks/useI18n.tsx");
  const container = document.getElementById("root");
  const root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, element));
  });
  return { root, container };
}

/** Mount one card and read the size metric off the DOM. */
async function renderSize(project) {
  const jiti = await loader();
  const { ProjectCard } = await jiti.import("./ProjectCard.tsx");
  const { root, container } = await mount(
    React.createElement(ProjectCard, {
      project,
      priorityColor: PRIORITY_COLOR,
      priorityName: "Sofort",
      onTodosChange() {},
      onOpen() {},
      onDelete() {},
    }),
  );

  const label = Array.from(container.querySelectorAll("span")).find((el) =>
    (el.textContent ?? "").startsWith("Size"),
  );
  assert.ok(label, "the card no longer renders a size metric");
  // The metric renders the label and the value as two spans; the value span
  // wraps the card's own span, and the tooltip sits on the inner one.
  const value = label.nextElementSibling;
  const rendered = {
    label: label.textContent ?? "",
    value: value?.textContent ?? "",
    title:
      value?.getAttribute("title") ?? value?.querySelector("[title]")?.getAttribute("title") ?? null,
  };
  await act(async () => root.unmount());
  return rendered;
}

test("a folder that was never measured shows the waiting state", async () => {
  const rendered = await renderSize({ ...PROJECT, sizeBytes: null, sizeMeasuredAt: undefined });
  assert.equal(rendered.value, "Measuring...");
  // There is no measurement yet, so there is no age to show: the label stays
  // the plain word.
  assert.equal(rendered.label, "Size");
});

test("a folder whose measurement failed shows that there is no size", async () => {
  const rendered = await renderSize({
    ...PROJECT,
    sizeBytes: null,
    sizeMeasuredAt: new Date().toISOString(),
  });
  assert.equal(rendered.value, "Size unavailable");
});

test("a partial measurement shows a lower bound, not an exact size", async () => {
  const rendered = await renderSize({
    ...PROJECT,
    sizeBytes: 1864862,
    sizeMeasuredAt: new Date().toISOString(),
    sizeIsLowerBound: true,
  });
  // The "≥" is the whole point: the number is what `du` could read, not the
  // size of the folder.
  assert.match(rendered.value, /^≥/, `expected a lower bound, got "${rendered.value}"`);
  assert.ok(
    rendered.title !== null,
    "a lower bound has to explain itself: the number is not the size",
  );
});

test("a complete measurement shows the plain size", async () => {
  const rendered = await renderSize({
    ...PROJECT,
    sizeBytes: 1864862,
    sizeMeasuredAt: new Date().toISOString(),
  });
  assert.ok(!rendered.value.startsWith("≥"), `expected a plain size, got "${rendered.value}"`);
  assert.equal(rendered.title, null, "there is nothing to explain about a complete measurement");
});

test("a fresh measurement carries no age, an expired one does", async () => {
  const fresh = await renderSize({
    ...PROJECT,
    sizeBytes: 1234,
    sizeMeasuredAt: new Date().toISOString(),
  });
  assert.equal(fresh.label, "Size", "a measurement inside the TTL needs no age");

  // The TTL is five minutes; the measurement below is two hours old.
  const expired = await renderSize({
    ...PROJECT,
    sizeBytes: 1234,
    sizeMeasuredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  });
  assert.match(expired.label, /^Size · /, `expected the age in the label, got "${expired.label}"`);
  assert.match(expired.label, /2 h ago/, `expected the age of the measurement, got "${expired.label}"`);
});
