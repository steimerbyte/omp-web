import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";

/**
 * The two layout defects this file holds in place.
 *
 * ### What could not be tested here, and why this file exists anyway
 *
 * Neither defect is a logic error and neither is visible to jsdom, which has
 * no layout engine: it has no bidi resolution, so it cannot see that a path
 * was painted in the wrong order, and no line boxes, so it cannot see a grid
 * that changes shape between two renders. A test that asserted the *rendered
 * geometry* would have to be a browser test, and this repo runs `bun test` in
 * jsdom — see `AGENTS.md`.
 *
 * What jsdom does have is the rendered DOM, and both defects are decided
 * there. Both fixes are "the element says the wrong thing in the DOM", so the
 * DOM is the right place to pin them:
 *
 *  - **D1, the reversed path.** `ProjectCard` renders the path into a
 *    `direction: rtl` box so that the truncation happens at the START and the
 *    informative end of the path stays visible. That same directive reorders
 *    the glyphs: measured in Chromium on 2026-10-21, the leading "/" was
 *    painted at the END, and every card read
 *    "home/steimmerbyte/workspace/omp-web/". The fix wraps the path in
 *    `<bdi dir="ltr">`. The assertions below hold both halves of that
 *    contract: the box stays RTL (otherwise the truncation silently moves to
 *    the end and the path loses the part that identifies it), and the path
 *    text sits in its own LTR isolate (otherwise the glyph order flips back).
 *
 *  - **D2, the grid that jumped.** The skeleton asked for a fixed
 *    `repeat(3, minmax(0, 1fr))` and the real grid for the auto-fill below,
 *    so a thirty-second wait ended in the board rearranging itself. Measured:
 *    three 106px placeholder columns at 390x844, then one 342px card column;
 *    three 369px placeholder columns at 1440x900, then four 274px ones. The
 *    fix is one shared rule, and the assertion is that the two components
 *    still produce the SAME `grid-template-columns` string — which is the
 *    thing that had drifted apart.
 *
 * ### Why mounting is worth it here
 *
 * A source-text test (`assert.match(cardSource, /bdi/)`) would pass even if
 * the `<bdi>` were somewhere else entirely, and it would not notice the day
 * someone reintroduces a second grid rule three lines away. Mounting the
 * component and reading what it actually produced does notice.
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

const PRIORITIES = [{ id: "now", name: "Sofort", colorValue: "var(--danger)" }];
const PRIORITIES_ALL = [
  { id: "now", name: "Sofort", colorValue: "var(--danger)" },
  { id: "important", name: "Wichtig", colorValue: "var(--warning)" },
  { id: "later", name: "Nice to have", colorValue: "var(--accent)" },
  { id: "done", name: "Erledigt", colorValue: "var(--success)" },
  { id: "parked", name: "Unwichtig", colorValue: "var(--text-dim)" },
];

/**
 * The one number both grids must agree on, read from the component rather than
 * written here — so this test cannot pass against a value the code no longer
 * uses, and cannot fail because someone edited this constant.
 */
let PROJECT_CARD_HEIGHT = null;

/**
 * The DOM the components mount into.
 *
 * `Enter`, `Reveal` and `Shimmer` are motion components, and motion decides
 * once — at module scope — whether it can use the browser animation API, by
 * reading `window`, `HTMLElement` and `matchMedia`. So the globals have to be
 * in place *before* the first `jiti.import` of a component, not merely before
 * the render. `AppShell.projects-view.test.mjs` hits the same ordering rule.
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

/** The card's path line: the box that decides the truncation and the order. */
function pathLine(container) {
  for (const el of container.querySelectorAll("div")) {
    if (el.getAttribute("title")?.startsWith("/")) return el;
  }
  return null;
}

/** Every grid in the tree, in document order. */
function grids(container) {
  return Array.from(container.querySelectorAll("div")).filter(
    (el) => (el.getAttribute("style") ?? "").includes("grid-template-columns"),
  );
}

/** The first rendered card. */
function realCards(container) {
  return container.querySelector(".omp-project-card");
}

test("the card's path keeps its glyph order inside the RTL truncation box", async () => {
  const jiti = await loader();
  const { ProjectCard } = await jiti.import("./ProjectCard.tsx");

  const { root, container } = await mount(
    React.createElement(ProjectCard, {
      project: PROJECT,
      priorityColor: "var(--danger)",
      priorityName: "Sofort",
      onTodosChange() {},
      onOpen() {},
      onDelete() {},
    }),
  );

  const path = pathLine(container);
  assert.ok(path, "the card no longer renders the path line");

  // Half one: the box stays RTL. Dropping this is the tempting "fix" that
  // silently moves the truncation to the end of the path, so it is pinned.
  assert.match(
    path.getAttribute("style") ?? "",
    /direction:\s*rtl/,
    "the path box is no longer RTL, so the truncation moved to the path's end",
  );
  assert.match(path.getAttribute("style") ?? "", /text-overflow:\s*ellipsis/);
  assert.equal(path.getAttribute("title"), PROJECT.root, "the full path left the title attribute");

  // Half two: the path itself is isolated as LTR. This is what stops the
  // leading "/" from being painted at the end of the string.
  const bdi = path.querySelector("bdi");
  assert.ok(
    bdi,
    "the path is no longer in a <bdi>: direction:rtl will reorder its glyphs again",
  );
  assert.equal(
    bdi.getAttribute("dir"),
    "ltr",
    "the isolate is not left-to-right, so the path is still painted reversed",
  );
  assert.equal(
    bdi.textContent,
    PROJECT.root,
    "the path text is not the root any more — the DOM order IS the painted order",
  );

  // And the path carries no invisible control character. A LEFT-TO-RIGHT MARK
  // (U+200E) would render the same and copy out into anything the user
  // selects from the card; this asserts that alternative did not creep in.
  assert.ok(
    !/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(path.textContent ?? ""),
    "the path carries a bidi control character, which copies into the clipboard",
  );

  await act(async () => root.unmount());
});

test("the skeleton and the real grid lay their cards out identically", async () => {
  const jiti = await loader();
  const cardModule = await jiti.import("./ProjectCard.tsx");
  PROJECT_CARD_HEIGHT = cardModule.PROJECT_CARD_HEIGHT;
  assert.equal(
    typeof PROJECT_CARD_HEIGHT,
    "number",
    "ProjectCard no longer exports PROJECT_CARD_HEIGHT; the skeleton is back to guessing",
  );
  const { ProjectGrid, ProjectGridSkeleton } = await jiti.import("./ProjectGrid.tsx");

  const skeleton = await mount(React.createElement(ProjectGridSkeleton, {}));
  const skeletonGrids = grids(skeleton.container);
  assert.equal(skeletonGrids.length, 2, "the skeleton should render one grid per group");
  await act(async () => skeleton.root.unmount());

  const real = await mount(
    React.createElement(ProjectGrid, {
      projects: [PROJECT],
      priorities: PRIORITIES,
      onTodosChange() {},
      onOpen() {},
      onDelete() {},
    }),
  );
  const realGrids = grids(real.container);
  assert.equal(realGrids.length, 1, "the real grid should render one grid for the one group");
  // read while still mounted: unmounting empties the container
  const cardStyle = realCards(real.container)?.getAttribute("style") ?? "";
  await act(async () => real.root.unmount());

  // The whole defect in one assertion: the two strings had drifted apart, and
  // a thirty-second load ended with the board rearranging itself.
  assert.equal(
    skeletonGrids[0].getAttribute("style"),
    realGrids[0].getAttribute("style"),
    "the skeleton and the real grid disagree about grid-template-columns",
  );

  const template = realGrids[0].getAttribute("style") ?? "";
  assert.match(template, /auto-fill/, "the card grid must size its columns from the viewport");
  assert.doesNotMatch(
    template,
    /repeat\(\d/,
    "a fixed column count is back: the grid can no longer follow the viewport",
  );

  // The placeholder has to reserve the height of a card, or every row under
  // the first moves when the cards arrive. The number is not a copy of a
  // comment: the card itself declares it as a floor (`PROJECT_CARD_HEIGHT`)
  // and the skeleton imports that same constant, so this checks that both
  // sides still carry it. The browser proof that the two are really the same
  // height is the measured first-card position, not this assertion — jsdom
  // has no layout.
  const placeholder = skeletonGrids[0].firstElementChild;
  const placeholderStyle = placeholder?.getAttribute("style") ?? "";
  assert.match(
    placeholderStyle,
    new RegExp(`height:\\s*${PROJECT_CARD_HEIGHT}px`),
    "the card placeholder no longer reserves the height of a real card",
  );
  assert.match(
    cardStyle,
    new RegExp(`min-height:\\s*${PROJECT_CARD_HEIGHT}px`),
    "the card no longer declares the height the placeholder reserves",
  );
  assert.match(cardStyle, /min-width:\s*0/, "the card under test is not a project card");
});
test("the header says nothing countable until the registry answers", async () => {
  const jiti = await loader();
  const { DashboardTopbar } = await jiti.import("./DashboardTopbar.tsx");

  const loading = await mount(
    React.createElement(DashboardTopbar, {
      projectCount: 0,
      chatCount: 0,
      canCreate: false,
      loading: true,
      onNewProject() {},
    }),
  );
  const loadingText = loading.container.textContent ?? "";
  await act(async () => loading.root.unmount());

  const loaded = await mount(
    React.createElement(DashboardTopbar, {
      projectCount: 18,
      chatCount: 153,
      canCreate: false,
      loading: false,
      onNewProject() {},
    }),
  );
  const loadedText = loaded.container.textContent ?? "";
  await act(async () => loaded.root.unmount());

  // "0 projects · 0 chats" is not a placeholder, it is a claim about an
  // empty board, and `GET /api/projects` can take 30 seconds to contradict it.
  assert.doesNotMatch(
    loadingText,
    /0 projects|0 chats/,
    "the loading header still states a count of zero",
  );
  assert.match(
    loadedText,
    /18 projects/,
    "the loaded header no longer states the real count",
  );
});

test("the chip strip cannot wrap, so the bar cannot change height", async () => {
  const jiti = await loader();
  const { PriorityFilterBar } = await jiti.import("./PriorityFilterBar.tsx");

  const props = {
    activeId: null,
    onActiveChange() {},
    query: "",
    onQueryChange() {},
  };

  const loading = await mount(
    React.createElement(PriorityFilterBar, {
      ...props,
      priorities: [],
      counts: new Map(),
      loading: true,
    }),
  );
  const loadingChips = loading.container.querySelectorAll("button");
  // the strip is the element the chips sit in, one level below the bar
  const loadingStrip = loadingChips[0]?.parentElement;
  // read while still mounted: unmounting empties the container
  const barStyle = loading.container.querySelector("div")?.getAttribute("style") ?? "";
  await act(async () => loading.root.unmount());

  // One account uses a single category; the other four are empty.
  const loaded = await mount(
    React.createElement(PriorityFilterBar, {
      ...props,
      priorities: PRIORITIES_ALL,
      counts: new Map([["now", 18]]),
      loading: false,
    }),
  );
  const loadedChips = loaded.container.querySelectorAll("button");
  await act(async () => loaded.root.unmount());

  // The property that removes the jump is the bar's `flex-wrap: nowrap`: one
  // line, whatever the categories are called and however many of them there
  // are. A wrapping bar is what made the chips grow into a second row and drag
  // the first card 38px down with them.
  assert.match(
    barStyle,
    /flex-wrap:\s*nowrap/,
    "the chip bar can wrap again, so its height depends on the data again",
  );

  // The chips live in their own element rather than being direct children of
  // the bar; that element is the strip the stylesheet turns into the scroller.
  // This asserts the structure and not a class name on purpose: jsdom resolves
  // no stylesheet, so a class-name assertion would only be checking a string.
  assert.notEqual(loadingStrip, null, "the chips have no strip of their own");
  assert.notEqual(
    loadingStrip?.parentElement,
    null,
    "the strip is detached from the bar",
  );
  // Deliberately no assertion on a class name here: jsdom resolves no
  // stylesheet, so that would only be checking a string. The property that
  // removes the jump — the bar cannot wrap — is asserted above, and that the
  // strip scrolls for it is proved in the browser, not here.

  // And an empty category really is dropped rather than reserved: the strip
  // absorbs the difference, so there is no permanent gap for a chip nobody uses.
  assert.equal(
    loadedChips.length,
    2,
    "the loaded bar renders chips that hold no project, reserving space for them",
  );
  assert.ok(loadingChips.length >= 1, "the loading bar rendered no chips at all");
});
