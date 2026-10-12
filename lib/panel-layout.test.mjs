import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  CHAT_PANEL_ID,
  FILE_PANEL_ID,
  SIDEBAR_PANEL_ID,
  getChatMinWidth,
  getDefaultPanelLayout,
  normalizePanelLayout,
  parsePanelLayout,
} = await jiti.import("./panel-layout.ts");

test("reserves chat width only where the file panel shares the row", () => {
  assert.equal(getChatMinWidth(true), 420);
  assert.equal(getChatMinWidth(false), 320);
});

test("a panel with nothing remembered opens at the size it declares", () => {
  const opened = normalizePanelLayout({ [SIDEBAR_PANEL_ID]: 0, [FILE_PANEL_ID]: 0 }, null, 1366);
  assert.equal(opened[SIDEBAR_PANEL_ID], 19.03);
  assert.equal(opened[FILE_PANEL_ID], 42);
});

test("the starting layout shares out 100 percent and keeps the sidebar's pixels", () => {
  const closed = getDefaultPanelLayout(1440, false);
  const sum = Object.values(closed).reduce((total, size) => total + size, 0);
  assert.equal(Math.round(sum * 100) / 100, 100);
  assert.equal(Math.round((closed[SIDEBAR_PANEL_ID] / 100) * 1440), 260);
  assert.equal(closed[FILE_PANEL_ID], 0);

  const open = getDefaultPanelLayout(1440, true);
  assert.equal(open[FILE_PANEL_ID], 42);
  assert.equal(Math.round((open[SIDEBAR_PANEL_ID] / 100) * 1440), 260);
  assert.equal(Math.round(Object.values(open).reduce((t, size) => t + size, 0)), 100);

  // Without a viewport the nominal width stands in, and it must still add up:
  // the library rescales the whole row when the shares do not.
  const nominal = getDefaultPanelLayout(0, false);
  assert.equal(Math.round(Object.values(nominal).reduce((t, size) => t + size, 0)), 100);
});

test("remembers a collapsed panel at the size it last had", () => {
  const previous = { [SIDEBAR_PANEL_ID]: 19.03, [CHAT_PANEL_ID]: 48.97, [FILE_PANEL_ID]: 32 };
  assert.deepEqual(
    normalizePanelLayout({ ...previous, [FILE_PANEL_ID]: 0 }, previous, 1366),
    previous,
  );
  assert.deepEqual(
    normalizePanelLayout({ [FILE_PANEL_ID]: 0 }, null, 1366),
    { [SIDEBAR_PANEL_ID]: 19.03, [CHAT_PANEL_ID]: 42, [FILE_PANEL_ID]: 42 },
  );
});

test("rejects a persisted layout that is not three usable percentages", () => {
  const valid = { [SIDEBAR_PANEL_ID]: 19.03, [CHAT_PANEL_ID]: 48.97, [FILE_PANEL_ID]: 32 };
  assert.deepEqual(parsePanelLayout(JSON.stringify(valid)), valid);
  assert.equal(parsePanelLayout(null), null);
  assert.equal(parsePanelLayout("not json"), null);
  assert.equal(parsePanelLayout(JSON.stringify([19.03, 48.97, 32])), null);
  assert.equal(
    parsePanelLayout(JSON.stringify({ ...valid, [FILE_PANEL_ID]: 0 })),
    null,
    "a closed panel must be remembered at its last real size, not at 0",
  );
  assert.equal(
    parsePanelLayout(JSON.stringify({ ...valid, [SIDEBAR_PANEL_ID]: 260 })),
    null,
    "a pixel width read as a percentage would blow the layout up",
  );
});