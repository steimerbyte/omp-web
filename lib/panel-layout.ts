// Layout contract of the app shell's three-column split.
//
// `AppShell.tsx` hands these numbers to react-resizable-panels, which does the
// clamping, the drag and the bookkeeping. What used to live here as pixel maths
// — a maximum for the sidebar that subtracts the file panel's current width and
// a maximum for the file panel that subtracts the sidebar's — is gone: the
// middle Panel carries the reserve as its own `minSize`. The library will not
// let a neighbour be dragged past the point where the chat falls below that
// minimum, so the coupling is accounted for once, in the panel that owns it.

/**
 * Panel ids. They are also the keys of the persisted layout, so they have to
 * stay stable across releases — a renamed id silently resets everybody's
 * layout to the defaults.
 */
export const SIDEBAR_PANEL_ID = "session-sidebar";
export const CHAT_PANEL_ID = "chat";
export const FILE_PANEL_ID = "file-panel";

export const PANEL_LAYOUT_STORAGE_KEY = "omp-app-shell-panel-layout";

export const SIDEBAR_DEFAULT_WIDTH = 260;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;

// The file panel opens proportionally rather than at a fixed pixel width: 42%
// of the shell is what fits next to a 260px sidebar and a chat that still has
// room to work in. Its floors and ceilings stay in pixels, because those are
// about how much text a file view can usefully show.
export const RIGHT_PANEL_DEFAULT_PERCENT = 42;
export const RIGHT_PANEL_MIN_WIDTH = 300;
export const RIGHT_PANEL_MAX_WIDTH = 1200;

/**
 * Width the chat column keeps. This is what couples the two side panels: drag
 * the sidebar as far right as it goes and the library stops at exactly the
 * point where the chat would fall below this.
 */
export const COMPACT_CHAT_MIN_WIDTH = 320;
export const DESKTOP_CHAT_MIN_WIDTH = 420;

/** Layout as the library reports and persists it: panel id to percent of the group. */
export type PanelLayout = Record<string, number>;

/**
 * Reserve the chat column gets. Below the split breakpoint the file panel is
 * an overlay and takes no room from the chat, so the chat only has to survive
 * next to the sidebar.
 */
export function getChatMinWidth(filePanelIsSplit: boolean): number {
  return filePanelIsSplit ? DESKTOP_CHAT_MIN_WIDTH : COMPACT_CHAT_MIN_WIDTH;
}

/**
 * Size a panel opens at, as a percentage of the group. Only needed when a
 * panel is closed: a collapsed panel reports 0, and that 0 is not something we
 * want to remember.
 */
function getDefaultPanelPercent(panelId: string, viewportWidth: number): number {
  if (panelId !== SIDEBAR_PANEL_ID) return RIGHT_PANEL_DEFAULT_PERCENT;
  if (!(viewportWidth > 0)) return 0;
  return Math.round((SIDEBAR_DEFAULT_WIDTH / viewportWidth) * 10000) / 100;
}

/**
 * Turn a live layout into one worth remembering.
 *
 * The library stores a collapsed panel as 0. Keeping that 0 means the next
 * open lands on the panel's minimum — a 300px file panel where the user left
 * a 686px one — so a panel at 0 is written with the last size it actually had
 * and, failing that, with its default.
 */
export function normalizePanelLayout(
  layout: PanelLayout,
  previous: PanelLayout | null,
  viewportWidth: number,
): PanelLayout {
  const normalized: PanelLayout = {};
  for (const panelId of [SIDEBAR_PANEL_ID, CHAT_PANEL_ID, FILE_PANEL_ID]) {
    const size = layout[panelId];
    if (typeof size === "number" && Number.isFinite(size) && size > 0) {
      normalized[panelId] = Math.round(size * 100) / 100;
      continue;
    }
    const previousSize = previous?.[panelId];
    normalized[panelId] =
      typeof previousSize === "number" && Number.isFinite(previousSize) && previousSize > 0
        ? previousSize
        : getDefaultPanelPercent(panelId, viewportWidth);
  }
  return normalized;
}

/**
 * Read a persisted layout. Anything that is not a map of finite percentages
 * covering all three panels is rejected rather than repaired: a half-valid
 * layout is how a stored pixel width would come back as "26000 percent".
 */
export function parsePanelLayout(raw: string | null): PanelLayout | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const layout = parsed as PanelLayout;
  for (const panelId of [SIDEBAR_PANEL_ID, CHAT_PANEL_ID, FILE_PANEL_ID]) {
    const size = layout[panelId];
    if (typeof size !== "number" || !Number.isFinite(size) || size <= 0 || size > 100) return null;
  }
  return layout;
}