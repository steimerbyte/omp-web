"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Group,
  Panel,
  Separator,
  useGroupRef,
  usePanelRef,
  type Layout,
  type LayoutChangedMeta,
  type PanelImperativeHandle,
  type PanelSize,
} from "react-resizable-panels";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { SessionSidebar } from "./SessionSidebar";
import { SubagentPanel } from "./SubagentPanel";
import { ProjectsDashboard } from "./ProjectsDashboard";
import { CalendarView } from "./CalendarView";
import { ScheduledTasksView } from "./ScheduledTasksView";
import { ChatWindow } from "./ChatWindow";
import { FileViewer } from "./FileViewer";
import { TabBar, type Tab } from "./TabBar";
import { TerminalDropdown } from "./TerminalDropdown";
import { TerminalViewer } from "./TerminalViewer";
import { SystemStatsBadge } from "./SystemStatsBadge";
import { SettingsConfig } from "./SettingsConfig";
import { Reveal } from "./motion/Reveal";
import { Shimmer } from "./motion/Shimmer";
import { Pressable } from "./motion/Pressable";
import { ProjectTrustDialog } from "./ProjectTrustDialog";
import { OmpUpdateIndicator } from "./OmpUpdateIndicator";
import { BranchNavigator } from "./BranchNavigator";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useViewportHeight } from "@/hooks/useViewportHeight";
import { useAudio } from "@/hooks/useAudio";
import { copyText } from "@/lib/clipboard";
import { getFileName } from "@/lib/file-paths";
import { buildAtMentionText, buildFileAtMentionsText, buildFileLineMentionText } from "@/lib/file-fuzzy";
import {
  claimExtensionAttentionNotification,
  shouldShowBrowserNotification,
  showBrowserNotification,
} from "@/lib/browser-notifications";
import { getInitialNavigation } from "@/lib/initial-navigation";
import { clearLastOpen, getLastOpenSession, setLastOpenSession } from "@/lib/workspace-memory";
import {
  CHAT_PANEL_ID,
  FILE_PANEL_ID,
  getChatMinWidth,
  getDefaultPanelLayout,
  normalizePanelLayout,
  PANEL_LAYOUT_STORAGE_KEY,
  parsePanelLayout,
  RIGHT_PANEL_DEFAULT_PERCENT,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_PANEL_ID,
  type PanelLayout,
} from "@/lib/panel-layout";
import type { BlockingExtensionUiRequest, SessionInfo, SessionTreeNode, SubagentSnapshot } from "@/lib/types";
import type { ProjectTrustStatus } from "@/lib/api-types";
import type { ChatInputHandle } from "./ChatInput";
import type { SessionStatsInfo } from "@/lib/omp-types";

type SessionCopyField = "file" | "id";
type AutoNameStatus =
  | { kind: "idle" }
  | { kind: "naming" }
  | { kind: "success" }
  | { kind: "error"; message: string };

const TOP_BAR_ICON_BUTTON_SIZE = 36;
const LANGUAGE_MENU_WIDTH = 176;

/**
 * Breakpoint at which the file panel joins the split layout. Below it the panel
 * is a fixed overlay (app/globals.css, `@media (max-width: 959px)`) and must
 * not take room from the chat — the layout below reacts to it, the library must
 * not. Reads as "split" on the server and on the first client paint, then syncs
 * to the real viewport, exactly like `useIsMobile`.
 */
const SPLIT_PANEL_MEDIA_QUERY = "(min-width: 960px)";

function subscribeSplitPanel(cb: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(SPLIT_PANEL_MEDIA_QUERY);
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}

function getSplitPanelSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return window.matchMedia(SPLIT_PANEL_MEDIA_QUERY).matches;
}

function useIsSplitViewport(): boolean {
  return useSyncExternalStore(subscribeSplitPanel, getSplitPanelSnapshot, () => true);
}

/**
 * Arrow-key handling for a separator.
 *
 * The library steps in percent (5% per press, which is a 96px jump on a wide
 * screen). The shell has always moved in 12px, 32px with shift, so the arrow
 * keys are claimed here and converted back.
 *
 * The claim has to happen in the CAPTURE phase, and that is not a stylistic
 * choice. The library registers a *native* `addEventListener("keydown", Ot)`
 * directly on the separator element (react-resizable-panels.js:2160), while
 * React attaches its own listeners at the root. A native listener on the
 * target element therefore fires before React's bubble-phase `onKeyDown`, and
 * `Ot` bails out only on `defaultPrevented` — which is still `false` at that
 * point. `preventDefault` in a bubbling handler is therefore too late: the
 * library has already applied its own 5% step, and every arrow press moved the
 * separator twice. There is no prop that turns the keyboard handling off
 * without also killing mouse dragging (`disabled` is filtered out of the
 * pointer hit test, `bt`). Stopping propagation during capture is the only
 * lever: the event never descends to the separator element, so `Ot` never runs.
 *
 * Home, End, Enter and F6 deliberately fall through untouched — only `Ot`
 * answers them, and it answers them exactly.
 */
function separatorArrowKeys(
  panelRef: React.RefObject<PanelImperativeHandle | null>,
  panelRefs: React.RefObject<PanelImperativeHandle | null>[],
  growthDirection: 1 | -1,
) {
  const growKey = growthDirection === 1 ? "ArrowRight" : "ArrowLeft";
  const shrinkKey = growthDirection === 1 ? "ArrowLeft" : "ArrowRight";
  return {
    onKeyDownCapture: (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== growKey && event.key !== shrinkKey) return;
      const panel = panelRef.current;
      if (!panel) return;
      // `resize()` takes a percentage of the whole row, not of the two panels
      // this separator sits between — with the file panel open the difference
      // is the file panel's whole width.
      const groupWidth = panelRefs.reduce(
        (sum, ref) => sum + (ref.current?.getSize().inPixels ?? 0),
        0,
      );
      if (groupWidth <= 0) return;
      const size = panel.getSize();
      const step = (event.shiftKey ? 32 : 12) * growthDirection * (event.key === growKey ? 1 : -1);
      event.preventDefault();
      // The unit is the whole contract here. `resize()` runs its argument
      // through the same parser as `defaultSize`/`minSize`, and that parser
      // maps a bare `number` to PIXELS (sn() in the bundle: `case "number":
      // return [e, "px"]`), while a `"%"` string is a share of the axis. A
      // naked `18.9` is 18.9px — below `minSize` — and gets clamped away, so
      // the promised 12px step never happened at all. Only the string carries
      // the percent.
      panel.resize(`${((size.inPixels + step) / groupWidth) * 100}%`);
      // Without this the native `Ot` handler runs its own `we(t, ±5)` after us.
      event.stopPropagation();
    },
  };
}

/**
 * `useLayoutEffect` in the browser, `useEffect` on the server, where the real
 * one only warns. The starting layout has to be corrected against the measured
 * row before the first client paint — a corrected width that slides in over
 * 0.2s is a worse artifact than the wrong frame it replaces.
 */
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function AppShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [initialNavigation] = useState(() => getInitialNavigation(searchParams));
  // Which of the three views is showing. Seeded from `?view=` so a reload or a
  // shared link lands where the sender was, and kept in the URL below so it
  // survives the next reload too.
  const [activeView, setActiveView] = useState<"chat" | "projects" | "calendar" | "scheduled">(
    () => initialNavigation.requestedView,
  );
  // The sidebar's *automatic* first cwd adoption is what would break a
  // `?view=projects` reload, so it is switched off at the source rather than
  // detected afterwards.
  //
  // The distinction this makes is exactly "automatic restore" vs "user click",
  // and it is the only place in the shell where those two are separable
  // without guessing: `SessionSidebar`'s auto-select effect (getRecentProjects
  // → setSelectedCwd → onCwdChange) runs once, before any input, while every
  // later `onCwdChange` is a click, a `?cwd=` URL or a session restore. The
  // latter two already arm `suppressCwdBumpRef`; this covers the third.
  //
  // The dashboard is the one view that does not want a cwd adopted under it:
  // the sidebar's automatic adoption counts as "go to the work" and would
  // switch the view away from the dashboard, so with it suppressed the
  // dashboard opens no cwd and no session at all.
  const skipInitialProjectSelection =
    initialNavigation.requestedCwd !== null || activeView === "projects" || activeView === "calendar";
  // Whether this account may create projects. Creating one widens the file
  // allow-list, which `AGENTS.md` keeps admin-gated, so the button is hidden
  // for a tenant rather than shown and then refused. Asked the same way
  // `SettingsConfig` asks it — the role lives in a request header, which the
  // browser cannot read.
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/whoami", { cache: "no-store" });
        const data = (await response.json()) as { user?: { isAdmin?: boolean } | null };
        setIsAdmin(data.user?.isAdmin === true);
      } catch {
        setIsAdmin(false);
      }
    })();
  }, []);
  const { preference, toggleTheme } = useTheme();
  const themeLabelKey =
    preference === "light" ? "theme.light" : preference === "dark" ? "theme.dark" : "theme.auto";
  const { locale, setLocale, t: translate, supportedLocales } = useI18n();
  const isMobile = useIsMobile();
  useViewportHeight();
  // Audio ownership lives here (not in ChatWindow) so the completion tone can
  // also fire for tasks finishing in a non-active workspace whose ChatWindow
  // is not mounted. ChatWindow receives the audio callbacks as props.
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio, soundEnabledRef } = useAudio();
  const notifiedAttentionRequestIdsRef = useRef(new Set<string>());
  const handleBackgroundTaskDone = useCallback(() => {
    if (soundEnabledRef.current) playDoneSound();
  }, [playDoneSound, soundEnabledRef]);
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  // When user clicks +, we only store the cwd — no fake session id
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [initialCwdStatus, setInitialCwdStatus] = useState<"idle" | "validating" | "ready" | "error">(
    () => initialNavigation.requestedCwd ? "validating" : "idle",
  );
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [settingsConfigOpen, setSettingsConfigOpen] = useState(false);
  const [projectTrust, setProjectTrust] = useState<ProjectTrustStatus | null>(null);
  const [projectTrustDialogOpen, setProjectTrustDialogOpen] = useState(false);
  const [projectTrustBusy, setProjectTrustBusy] = useState(false);
  const [projectTrustError, setProjectTrustError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  // Ist das grosse Explorer-Fenster offen? Gemeldet von dem Explorer in der
  // Seitenleiste, nicht von diesem Baum: der Explorer ist eine Komponente in
  // `SessionSidebar` und haelt den Zustand des Fensters in sich. Solange das
  // Fenster offen ist, bekommen die beiden Resizer-Trennlinien die Klasse
  // `overlay-blocked-resizer` — unsichtbar und nicht bedienbar. Sie liegen
  // zwar jetzt unter dem Backdrop, aber eine Trennlinie, die man im
  // unscharfen Bild sieht, fordert zum Ziehen ein, und der Griff gehoert dann
  // nicht zu dem, was man sieht.
  const [explorerWindowOpen, setExplorerWindowOpen] = useState(false);
  // Stabil ueber die Renderings hinweg: der Melder haengt an diesem
  // Callback, nicht am Zustand. Sonst gaeue jeder neue Callback einen neuen
  // Effekt und damit in jedem Rendern eine weitere Meldung zurueck an die
  // Seite, die darauf ihren Zustand setzt.
  const handleExplorerPopupOpenChange = useCallback((open: boolean) => {
    setExplorerWindowOpen((prev) => (prev === open ? prev : open));
  }, []);
  const isSplitViewport = useIsSplitViewport();
  const groupRef = useGroupRef();
  const sidebarPanelRef = usePanelRef();
  const chatPanelRef = usePanelRef();
  const filePanelRef = usePanelRef();
  const sidebarPanelElementRef = useRef<HTMLDivElement | null>(null);
  const filePanelElementRef = useRef<HTMLDivElement | null>(null);
  // Last size each panel had while it was open, in percent of the group. A
  // collapsed panel reports 0, and 0 is not something worth remembering — see
  // `normalizePanelLayout`.
  const lastPanelSizeRef = useRef<PanelLayout>({});
  const [panelDragActive, setPanelDragActive] = useState(false);
  const groupElementRef = useRef<HTMLDivElement | null>(null);
  // Percentages, because that is what the library distributes (see
  // `getDefaultPanelLayout`). This first guess is computed for the NOMINAL
  // width on the server and on the client alike, and corrected against the
  // measured row before the first client paint (see the layout effect below).
  // It is a `useState`, not a `useMemo`: the library reads it exactly once,
  // when it first lays the row out.
  //
  // The width must NOT be `window.innerWidth` here, on either side. That
  // branch made the two renders disagree, because the percentages are
  // derived from the width: at a 1365px viewport the sidebar share is 19.05%
  // and the chat's is 80.95%, while the server — which has no `window` — fell
  // back to the nominal 1440px and rendered 18.06% / 81.94%. The library
  // distributes what it is handed, so React reported a hydration mismatch on
  // both panel divs and the sidebar/chat split visibly jumped once hydration
  // finished. `app-shell-split`'s `id` and `data-testid` are fixed strings and
  // matched all along; only the flex shares differed.
  //
  // A single value on both sides costs nothing: the layout effect below runs
  // before the first paint and replaces this guess with the real measured one,
  // so no user ever sees the nominal frame.
  const [startingPanelLayout] = useState(() => getDefaultPanelLayout(0, false));
  const [startingLayoutSettled, setStartingLayoutSettled] = useState(false);

  const handleSidebarPanelResize = useCallback((size: PanelSize) => {
    lastPanelSizeRef.current[SIDEBAR_PANEL_ID] = size.asPercentage;
  }, []);
  const handleFilePanelResize = useCallback((size: PanelSize) => {
    // `collapse()` is a resize like any other and reports 0. Storing that 0
    // means the reopen below reads 0 — `0 ?? 42` is 0, not 42 — and the panel
    // comes back at nothing at all. Measured on a 1600px row: dragged to
    // 700px, closed, reopened → 0px with the 0 stored, 700px without. The
    // guard belongs here rather than at the read: the reader cannot tell a
    // collapsed panel from a panel the user actually squeezed to zero, and
    // only the writer knows which one just happened.
    if (size.inPixels <= 0) return;
    lastPanelSizeRef.current[FILE_PANEL_ID] = size.asPercentage;
    filePanelElementRef.current?.style.setProperty(
      "--right-panel-width",
      `${Math.round(size.inPixels)}px`,
    );
  }, []);

  // Only direct user input is worth remembering. Layout commits the library
  // makes on its own — a constraint recompute, a window resize, the collapse
  // this component triggers — would otherwise overwrite the user's sizes with
  // whatever happened to be on screen when they last resized the window.
  const handleLayoutChanged = useCallback((layout: Layout, meta: LayoutChangedMeta) => {
    if (!meta.isUserInteraction) return;
    const normalized = normalizePanelLayout(layout, lastPanelSizeRef.current, window.innerWidth);
    lastPanelSizeRef.current = normalized;
    try {
      window.localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      // Resizing stays available when storage is unavailable.
    }
  }, []);

  const sidebarSeparatorKeys = useMemo(
    () => separatorArrowKeys(sidebarPanelRef, [sidebarPanelRef, chatPanelRef, filePanelRef], 1),
    [sidebarPanelRef, chatPanelRef, filePanelRef],
  );
  const fileSeparatorKeys = useMemo(
    () => separatorArrowKeys(filePanelRef, [sidebarPanelRef, chatPanelRef, filePanelRef], -1),
    [sidebarPanelRef, chatPanelRef, filePanelRef],
  );

  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
  }, []);

  // Die Breiten liegen unter `PANEL_LAYOUT_STORAGE_KEY` als Prozente, weil
  // `react-resizable-panels` selbst nichts speichert — die Bibliothek hat kein
  // `autoSaveId`, der Schreibende und Lesende ist der Effekt weiter unten. Die
  // Pixelwerte, die `useResizablePanel` unter eigenen Keys abgelegt hatte, sind
  // tote Last und muessen weg: niemand liest sie, und eine verwaiste
  // Pixelzahl ist genau die Sorte Zahl, die spaeter als plausibler Prozentwert
  // missverstanden wird.
  useEffect(() => {
    try {
      window.localStorage.removeItem("omp-sidebar-width");
      window.localStorage.removeItem("omp-right-panel-width");
    } catch {
      // Storage may be unavailable; the layout then simply is not remembered.
    }
  }, []);

  // The row now has a measured width: restore the remembered layout, or compute
  // the starting one against the real viewport. A layout effect, so the
  // corrected widths are in place before the browser paints anything — with the
  // ordinary `useEffect` the row would first show the nominal guess and then
  // slide to the right one.
  useIsoLayoutEffect(() => {
    let stored: PanelLayout | null = null;
    try {
      stored = parsePanelLayout(window.localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY));
    } catch {
      stored = null;
    }
    lastPanelSizeRef.current = stored ?? {};
    groupRef.current?.setLayout(
      stored ?? getDefaultPanelLayout(groupElementRef.current?.clientWidth ?? window.innerWidth, false),
    );
    setStartingLayoutSettled(true);
  }, [groupRef]);

  // Open and close by collapsing the panel rather than by unmounting it: the
  // file viewer and its terminals have to survive being closed.
  useEffect(() => {
    const panel = sidebarPanelRef.current;
    if (!panel) return;
    if (sidebarOpen) panel.expand();
    else panel.collapse();
  }, [sidebarPanelRef, sidebarOpen]);
  useEffect(() => {
    const panel = filePanelRef.current;
    if (!panel) return;
    if (!rightPanelOpen) {
      panel.collapse();
      return;
    }
    // `expand()` restores the size this session collapsed from. Right after a
    // page load the panel starts closed and there is nothing to restore — the
    // library would answer with the panel's 300px minimum. The remembered
    // percentage is applied directly instead, falling back to the size the
    // panel declares as its own default.
    //
    // Both `resize()` calls below carry the value as a `"%"` STRING on
    // purpose. `resize()` shares the unit parser with `defaultSize`
    // (`sn()` in react-resizable-panels), and a bare number there means
    // PIXELS: `resize(42)` asked for a 42px file panel, which is under
    // `RIGHT_PANEL_MIN_WIDTH` (300) and got clamped — so every remembered
    // width collapsed onto the minimum and the persistence did nothing at
    // all. The number alone is not the percentage it looks like.
    if (!panel.isCollapsed()) return;
    // Capped so the chat keeps its reserve. Without the cap a 1024px window
    // asks for 42% (430px) on top of a 260px sidebar and a 420px chat minimum,
    // and the library answers an over-full row rather than taking the
    // difference out of one of them — the sidebar would silently shrink. At
    // 1160px and up the cap is already above 42% and does nothing.
    const groupWidth = groupElementRef.current?.clientWidth ?? 0;
    if (groupWidth <= 0) {
      panel.resize(
        `${lastPanelSizeRef.current[FILE_PANEL_ID] ?? RIGHT_PANEL_DEFAULT_PERCENT}%`,
      );
      return;
    }
    const sidebarShare =
      ((sidebarPanelRef.current?.getSize().inPixels ?? 0) / groupWidth) * 100;
    const chatReserve = (getChatMinWidth(isSplitViewport) / groupWidth) * 100;
    panel.resize(
      `${Math.max(
        0,
        Math.min(
          lastPanelSizeRef.current[FILE_PANEL_ID] ?? RIGHT_PANEL_DEFAULT_PERCENT,
          100 - sidebarShare - chatReserve,
        ),
      )}%`,
    );
  }, [filePanelRef, groupElementRef, isSplitViewport, rightPanelOpen, sidebarPanelRef]);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const languageBtnRef = useRef<HTMLButtonElement>(null);

  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    branchLeafChangeFnRef.current = onLeafChange;
  }, []);

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId);
  }, []);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const systemBtnRef = useRef<HTMLButtonElement>(null);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
  }, []);

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  const [subagents, setSubagents] = useState<SubagentSnapshot[]>([]);
  const [autoNameStatus, setAutoNameStatus] = useState<AutoNameStatus>({ kind: "idle" });
  const autoNameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  activeSessionIdRef.current = selectedSession?.id ?? null;
  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setSessionStats(stats);
  }, []);
  const [copiedSessionField, setCopiedSessionField] = useState<SessionCopyField | null>(null);
  const sessionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopySessionField = useCallback((field: SessionCopyField, value: string) => {
    void copyText(value).then(() => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      setCopiedSessionField(field);
      sessionCopyTimerRef.current = setTimeout(() => setCopiedSessionField(null), 1400);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    };
  }, []);

  // Context usage — populated by ChatWindow, displayed in top bar
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const handleContextUsageChange = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
    setContextUsage(usage);
  }, []);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"branches" | "system" | "session" | "language" | null>(null);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const toggleTopPanel = useCallback((panel: "branches" | "system" | "session" | "language") => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel((cur) => cur === panel ? null : panel);
  }, [isMobile]);

  const openSessionStatsPanel = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel("session");
  }, [isMobile]);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) setActiveTopPanel(null);
    setSidebarOpen((open) => !open);
  }, [isMobile]);

  useEffect(() => {
    if (!activeTopPanel || !topBarRef.current) return;
    const update = () => {
      const topBarRect = topBarRef.current!.getBoundingClientRect();
      if (activeTopPanel === "language" && !isMobile && languageBtnRef.current) {
        const buttonRect = languageBtnRef.current.getBoundingClientRect();
        const width = Math.min(LANGUAGE_MENU_WIDTH, topBarRect.width);
        const left = Math.min(
          buttonRect.left - 1,
          Math.max(topBarRect.left, topBarRect.right - width),
        );
        setTopPanelPos({ top: topBarRect.bottom, left, width });
        return;
      }
      setTopPanelPos({ top: topBarRect.bottom, left: topBarRect.left, width: topBarRect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(topBarRef.current);
    if (languageBtnRef.current) ro.observe(languageBtnRef.current);
    return () => ro.disconnect();
  }, [activeTopPanel, isMobile]);

  // Right panel — file tabs only
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((relativePath: string, isDir: boolean) => {
    chatInputRef.current?.insertText(buildAtMentionText(relativePath, isDir));
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [isMobile]);

  const handleAtMentions = useCallback((relativePaths: string[]) => {
    const mentions = buildFileAtMentionsText(relativePaths);
    if (mentions) chatInputRef.current?.insertText(mentions);
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [isMobile]);

  const handleFileLineMention = useCallback((relativePath: string, startLine: number, endLine: number) => {
    chatInputRef.current?.insertText(buildFileLineMentionText(relativePath, startLine, endLine));
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [isMobile]);

  const initialSessionId = initialNavigation.sessionId;
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  useTheme({
    cwd: selectedSession?.cwd ?? newSessionCwd ?? activeCwd,
    syncWithOmp: true,
  });
  const activeProjectRootRef = useRef<string | null>(null);
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !initialSessionId);
  // Suppresses sessionKey bump in handleCwdChange during the initial URL restore
  const suppressCwdBumpRef = useRef(false);
  // Guards the async workspace restore so a slow response from an earlier
  // switch cannot resurrect a session into a project the user already left.
  const workspaceRestoreTokenRef = useRef(0);

  const invalidateWorkspaceRestore = useCallback(() => {
    workspaceRestoreTokenRef.current += 1;
  }, []);

  // Persist every active-session transition, including new and forked sessions
  // that bypass the sidebar selection handler. Transient sessions do not yet
  // carry projectRoot, so use the active project identity until hydration.
  useEffect(() => {
    if (!selectedSession) return;
    const projectKey = selectedSession.projectRoot
      ?? activeProjectRootRef.current
      ?? selectedSession.cwd;
    setLastOpenSession(projectKey, selectedSession.id);
  }, [selectedSession]);

  useEffect(() => {
    const requestedCwd = initialNavigation.requestedCwd;
    if (!requestedCwd) return;

    const controller = new AbortController();
    setInitialCwdStatus("validating");
    setInitialCwdError(null);

    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: requestedCwd }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
        if (!response.ok || !data.cwd) {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }

        // The sidebar will notify us when it adopts this cwd. Avoid remounting
        // the just-created empty chat during that initial synchronization.
        suppressCwdBumpRef.current = true;
        setNewSessionCwd(data.cwd);
        setInitialCwdStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInitialCwdError(error instanceof Error ? error.message : String(error));
        setInitialCwdStatus("error");
      });

    return () => controller.abort();
  }, [initialNavigation]);

  // Restore the workspace's last open session after switching to it. Called
  // from handleCwdChange once the outgoing context has been reset. The session
  // is looked up against the live list so a deleted or drifted session falls
  // back to the default welcome page instead of erroring.
  const restoreWorkspaceContext = useCallback((projectKey: string) => {
    const token = ++workspaceRestoreTokenRef.current;
    const lastOpenSessionId = getLastOpenSession(projectKey);
    if (!lastOpenSessionId) return;
    void fetch("/api/sessions")
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        if (token !== workspaceRestoreTokenRef.current) return; // stale switch
        const s = d?.sessions.find((x) => x.id === lastOpenSessionId);
        if (!s) {
          // The list loaded but the remembered session is gone — forget it.
          // When the list itself failed (d === null) keep the memory so a
          // later switch retries the restore.
          if (d) clearLastOpen(projectKey);
          return;
        }
        if ((s.projectRoot ?? s.cwd) !== projectKey) {
          // Defensive: the remembered session drifted out of this workspace.
          clearLastOpen(projectKey);
          return;
        }
        // Selecting the session must remount the chat with the session
        // present: useAgentSession loads content in a mount-only effect, so
        // the null-session welcome mount from the switch would never load
        // the restored session's messages.
        setSelectedSession(s);
        setSessionKey((k) => k + 1);
        if (new URLSearchParams(window.location.search).get("session") !== s.id) {
          router.replace(`?session=${encodeURIComponent(s.id)}`, { scroll: false });
        }
      })
      .catch(() => {
        // Network hiccup: keep the remembered session for a later retry.
      });
  }, [router]);

  const handleCwdChange = useCallback((cwd: string | null, projectRoot?: string | null) => {
    invalidateWorkspaceRestore();
    setActiveCwd(cwd);
    // Skip if cwd is null (initial mount).
    if (!cwd) return;
    const newProject = projectRoot ?? cwd;
    const currentProject = activeProjectRootRef.current
      ?? (selectedSession ? (selectedSession.projectRoot ?? selectedSession.cwd) : null);
    activeProjectRootRef.current = newProject;

    // Keep the project identity in sync during the initial URL restore without
    // remounting the just-created or restored chat.
    //
    // This guard is also what separates an *automatic* restore from a user
    // click, and that separation is load-bearing: everything below it — the
    // session reset, `router.replace("/")`, and the view switch — is "go to
    // the work". A restore triggered by the URL must not throw away the view
    // the URL asked for.
    if (suppressCwdBumpRef.current) {
      suppressCwdBumpRef.current = false;
      return;
    }
    // Picking a cwd is an explicit "go to the work", so it leaves the
    // dashboard. Reached only past the guard above, which is why a `?view=`
    // reload still lands on the dashboard: the automatic adoption is stopped
    // at the source (see `skipInitialProjectSelection` below), and the two
    // remaining automatic paths — `?cwd=` and `?session=` — both arm the guard.
    setActiveView("chat");
    // Worktrees of one repo share a project root. Moving the effective cwd
    // within the same project (e.g. switching worktree, or clicking a session
    // that lives in another worktree) must not close the open session.
    if (currentProject === newProject) {
      return;
    }
    // Close any session that belongs to a different project — it no longer
    // matches the selected project directory.
    setSelectedSession(null);
    setNewSessionCwd((prev) => {
      if (prev && prev !== cwd) return null;
      return prev;
    });
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    // File tabs are keyed by absolute path, so tabs opened in the previous
    // project would otherwise linger after switching to a different project.
    // Reached only past the same-project early return above, so worktrees of
    // one repo keep their open tabs. Mirror handleCloseFileTab and close the
    // now-empty right panel.
    setFileTabs([]);
    setActiveFileTabId(null);
    setRightPanelOpen(false);
    // Restore the workspace we switched to: its last open session, or keep
    // the default welcome page when none is remembered.
    restoreWorkspaceContext(newProject);
    router.replace("/", { scroll: false });
  }, [router, selectedSession, invalidateWorkspaceRestore, restoreWorkspaceContext]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    // Mark the target project before the cwd synchronization effect runs.
    // Otherwise selecting a session in another project looks like a manual
    // project switch and the just-selected session is cleared.
    activeProjectRootRef.current = session.projectRoot ?? session.cwd;
    invalidateWorkspaceRestore();
    // Clicking a session is "go to the work". A *restore* (`?session=` in the
    // URL) is not: the URL may also ask for the dashboard, and the restored
    // session then waits for the user to leave it — the dashboard and the
    // chat are two branches of one condition, not one above the other.
    if (!isRestore) setActiveView("chat");
    // Re-clicking the already-open session must not remount the chat and
    // re-run the full load/positioning cycle. Only skip when the effective
    // cwd context already matches — otherwise a pending cwd move still needs
    // the full re-select flow.
    if (!isRestore && selectedSession) {
      const sameProject =
        (selectedSession.projectRoot ?? selectedSession.cwd) ===
        (session.projectRoot ?? session.cwd);
      if (selectedSession.id === session.id && sameProject) {
        if (isMobile) setSidebarOpen(false);
        return;
      }
    }
    setNewSessionCwd(null);
    setSelectedSession(session);
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    setInitialSessionRestored(true);
    // On mobile, collapse the overlay drawer so the chat is revealed after pick.
    if (isMobile && !isRestore) setSidebarOpen(false);
    if (isRestore) {
      // Suppress the redundant sessionKey bump that would come from the
      // onCwdChange effect firing after setSelectedCwd in the sidebar
      suppressCwdBumpRef.current = true;
    }
    // Skip router.replace when restoring from URL — the param is already correct
    // and calling replace in production Next.js triggers a Suspense remount loop
    if (!isRestore) {
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [invalidateWorkspaceRestore, router, isMobile, selectedSession]);

  const handleNewSession = useCallback((_sessionId: string, cwd: string) => {
    invalidateWorkspaceRestore();
    // The `+` button and the keyboard shortcut are both "go to the work".
    setActiveView("chat");
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    if (isMobile) setSidebarOpen(false);
    router.replace("/", { scroll: false });
  }, [invalidateWorkspaceRestore, router, isMobile]);

  // Global keyboard shortcuts (handles Esc, Ctrl+Alt+N etc.)
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession(`kb-${Date.now()}`, cwd),
    activeCwd,
  });

  // Client-built transient SessionInfo (new session / fork) lacks the
  // server-computed projectRoot, which the same-project check in
  // handleCwdChange relies on. Hydrate it from the session list so switching
  // worktrees right after creating a session doesn't close the chat.
  const hydrateSelectedSession = useCallback((sessionId: string) => {
    void fetch("/api/sessions", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        const full = d?.sessions.find((s) => s.id === sessionId);
        if (!full) return;
        setSelectedSession((prev) => (
          prev?.id === sessionId
            ? { ...prev, ...full, transient: full.transient ?? false }
            : prev
        ));
      })
      .catch(() => {});
  }, []);

  // Called by ChatWindow when a new session gets its real id from omp
  const handleSessionCreated = useCallback((session: SessionInfo) => {
    invalidateWorkspaceRestore();
    setNewSessionCwd(null);
    setSelectedSession(session);
    setRefreshKey((k) => k + 1);
    hydrateSelectedSession(session.id);
    router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [invalidateWorkspaceRestore, router, hydrateSelectedSession]);

  /**
   * Eine Sitzung aus der Aufgabenansicht oeffnen.
   *
   * Es gibt keinen zweiten Weg, eine Sitzung anzusehen: der Lauf einer
   * geplanten Aufgabe ist eine ganz normale Sitzung und steht deshalb in
   * derselben Verlaufsliste. Die Kennung wird dort nachgeschlagen, weil
   * `handleSelectSession` ein `SessionInfo` erwartet und nicht nur eine
   * Kennung — und weil die Sitzung nach einem Neustart noch nicht im
   * Client-Zustand steht.
   *
   * Ist sie (noch) nicht in der Liste — etwa weil der Lauf gerade erst
   * gestartet ist —, wird die URL gesetzt: derselbe Weg, den ein geteilter
   * Link nimmt, und der einzige, der auch einen frischen Client bedient.
   */
  const handleOpenScheduledSession = useCallback((sessionId: string) => {
    void fetch("/api/sessions", { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((body) => {
        const target = body?.sessions.find((session) => session.id === sessionId);
        if (target) {
          handleSelectSession(target);
          return;
        }
        router.push(`/?session=${encodeURIComponent(sessionId)}`, { scroll: false });
      })
      .catch((error) => {
        console.error("Failed to open the session of the last run:", error);
      });
  }, [handleSelectSession, router]);

  const deliverSessionNotification = useCallback(({
    targetSession,
    title,
    body,
    tag,
  }: {
    targetSession: SessionInfo | null;
    title: string;
    body: string;
    tag?: string;
  }) => {
    if (!("Notification" in window)) return;

    const fire = () => {
      const sessionUrl = targetSession ? `/?session=${encodeURIComponent(targetSession.id)}` : "/";
      void showBrowserNotification({
        title,
        body,
        sessionUrl,
        tag,
        onClick: () => {
          window.focus();
          if (targetSession) handleSelectSession(targetSession);
        },
      });
    };

    if (Notification.permission === "granted") {
      fire();
    } else if (Notification.permission === "default") {
      void Notification.requestPermission().then((p) => { if (p === "granted") fire(); });
    }
  }, [handleSelectSession]);

  const handleAgentEnd = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
    if (selectedSession) hydrateSelectedSession(selectedSession.id);

    if (!shouldShowBrowserNotification()) return;
    const targetSession = selectedSession;
    deliverSessionNotification({
      targetSession,
      title: targetSession?.name ?? translate("i18n.sessionComplete"),
      body: translate("i18n.taskFinished"),
    });
  }, [deliverSessionNotification, hydrateSelectedSession, selectedSession, translate]);

  const handleAttentionNeeded = useCallback((request: BlockingExtensionUiRequest) => {
    if (!shouldShowBrowserNotification()) return;
    if (!claimExtensionAttentionNotification(request, notifiedAttentionRequestIdsRef.current)) return;

    deliverSessionNotification({
      targetSession: selectedSession,
      title: translate("i18n.attentionNeeded"),
      body: request.method === "custom"
        ? translate("i18n.extensionInputNeeded")
        : request.title,
      tag: `pi-extension-ui:${request.id}`,
    });
  }, [deliverSessionNotification, selectedSession, translate]);

  const handleAutoName = useCallback(async () => {
    const sessionId = selectedSession?.id;
    if (!sessionId || autoNameStatus.kind === "naming") return;
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setActiveTopPanel(null);
    setAutoNameStatus({ kind: "naming" });

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/auto-name`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { title?: string; error?: string };
      if (!response.ok || !body.title) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }

      const title = body.title.trim();
      setRefreshKey((key) => key + 1);
      if (activeSessionIdRef.current !== sessionId) return;
      setSelectedSession((current) => current?.id === sessionId ? { ...current, name: title } : current);
      setSessionStats((current) => current?.sessionId === sessionId ? { ...current, sessionName: title } : current);
      setAutoNameStatus({ kind: "success" });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 1800);
    } catch (error) {
      if (activeSessionIdRef.current !== sessionId) return;
      const message = error instanceof Error ? error.message : String(error);
      setAutoNameStatus({ kind: "error", message });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 5000);
    }
  }, [autoNameStatus.kind, selectedSession?.id]);

  useEffect(() => {
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: "idle" });
  }, [selectedSession?.id]);

  const handleExplorerRefresh = useCallback(() => {
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleSessionForked = useCallback((newSessionId: string) => {
    invalidateWorkspaceRestore();
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    setNewSessionCwd(null);
    setSelectedSession((prev) => ({
      ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
      transient: false,
    }));
    hydrateSelectedSession(newSessionId);
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [invalidateWorkspaceRestore, router, hydrateSelectedSession]);

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    invalidateWorkspaceRestore();
    setRefreshKey((k) => k + 1);
    if (selectedSession?.id === sessionId) {
      const cwd = selectedSession.cwd;
      setSelectedSession(null);
      setNewSessionCwd(cwd ?? null);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      setActiveTopPanel(null);
      router.replace("/", { scroll: false });
    }
  }, [invalidateWorkspaceRestore, selectedSession, router]);

  const handleOpenFile = useCallback((
    filePath: string,
    fileName: string,
    options?: { sourceSessionId?: string | null; modeHint?: "diff" | "edit" },
  ) => {
    const sourceSessionId = options?.sourceSessionId;
    const modeHint = options?.modeHint;
    const tabId = `file:${filePath}`;
    setFileTabs((prev) => {
      const existing = prev.find((t) => t.id === tabId);
      if (!existing) {
        return [...prev, {
          kind: "file",
          id: tabId,
          label: fileName,
          filePath,
          sourceSessionId,
          initialDisplayMode: modeHint,
        }];
      }
      if (existing.kind !== "file") return prev;
      const sourceUnchanged = !sourceSessionId || existing.sourceSessionId === sourceSessionId;
      const modeUnchanged = !modeHint || existing.initialDisplayMode === modeHint;
      if (sourceUnchanged && modeUnchanged) return prev;
      return prev.map((t) => {
        if (t.id !== tabId || t.kind !== "file") return t;
        const next: Tab = { ...t };
        if (sourceSessionId) next.sourceSessionId = sourceSessionId;
        if (modeHint) next.initialDisplayMode = modeHint;
        return next;
      });
    });
    setActiveFileTabId(tabId);
    setRightPanelOpen(true);
    // On mobile the file panel is full-screen; close the drawer so it shows.
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  const handleOpenLinkedFile = useCallback((filePath: string) => {
    handleOpenFile(filePath, getFileName(filePath), { sourceSessionId: selectedSession?.id ?? null });
  }, [handleOpenFile, selectedSession?.id]);

  const handleCloseFileTab = useCallback((tabId: string) => {
    setFileTabs((prev) => {
      const closing = prev.find((t) => t.id === tabId);
      if (closing?.kind === "terminal") {
        // Best-effort kill; the server cleans up regardless when the SSE
        // consumer disconnects.
        fetch(`/api/terminal/${encodeURIComponent(closing.terminalId)}`, { method: "DELETE" })
          .catch(() => undefined);
      }
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length === 0) setRightPanelOpen(false);
      return next;
    });
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      const remaining = fileTabs.filter((t) => t.id !== tabId);
      return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    });
  }, [fileTabs]);

  const handleOpenTerminalTab = useCallback((terminalId: string) => {
    setFileTabs((prev) => {
      const existing = prev.find((t) => t.kind === "terminal" && t.terminalId === terminalId);
      if (existing) return prev;
      const label = `Terminal ${terminalId.slice(0, 6)}`;
      const newTab: Tab = { kind: "terminal", id: `terminal:${terminalId}`, label, terminalId };
      return [...prev, newTab];
    });
    setActiveFileTabId(`terminal:${terminalId}`);
    setRightPanelOpen(true);
  }, []);

  const handleViewFullHistory = useCallback(() => {
    if (!selectedSession) return;
    window.open(
      `/api/sessions/${encodeURIComponent(selectedSession.id)}/export?inline=1`,
      "_blank",
      "noopener,noreferrer",
    );
  }, [selectedSession]);

  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const effectiveNewSessionCwd = newSessionCwd ?? (selectedSession === null && activeCwd ? activeCwd : null);
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  const showSubagentPanel = !isMobile && selectedSession !== null && subagents.length > 0;
  const projectTrustCwd = selectedSession?.cwd ?? effectiveNewSessionCwd;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;

  // The projects dashboard is a third view, and it is chosen — not derived.
  //
  // It must NOT be gated on `!showChat`. The sidebar adopts a cwd by itself on
  // first load (`SessionSidebar`: `getRecentProjects → setSelectedCwd` →
  // `onCwdChange`), so `showChat` is durably true in normal operation; gating
  // on it made this branch unreachable while the sidebar button (which reads
  // `activeView` directly) still showed the dashboard as pressed.
  //
  // The three states are an exclusive branch, not layers: while the dashboard
  // is up, the chat is not mounted at all. Switching to the dashboard unmounts
  // `ChatWindow`, switching back mounts it again.
  //
  // What survives that unmount is what lives outside the component: the text
  // in the composer stays in the module-level draft store
  // (`lib/draft-store.ts`, keyed by the session id) and is read back on the
  // next mount, and the transcript is reloaded from the server. What does not
  // survive is the state inside `ChatWindow`: the scroll position of the
  // message list is gone — the scroll container is a DOM node that the unmount
  // destroys, and the next mount starts at the bottom again — and with it the
  // lazily loaded older messages, which start over at the first page.
  //
  // Button and branch read the same source, `activeView`, so the pressed
  // state and the visible view cannot disagree.
  //
  // "Go to the work" is therefore explicit instead: `handleSelectSession`,
  // `handleNewSession` and `handleCwdChange` each switch the view themselves.
  const showProjects = activeView === "projects";
  const showCalendar = activeView === "calendar";
  const showScheduledTasks = activeView === "scheduled";

  // Keep the view in the URL. `replaceState` rather than a router navigation
  // so switching views never re-runs the server component tree — the
  // dashboard is a client view, and a route change here would remount the
  // whole shell and drop the loaded project list.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (activeView === "projects") url.searchParams.set("view", "projects");
    else if (activeView === "calendar") url.searchParams.set("view", "calendar");
    else if (activeView === "scheduled") url.searchParams.set("view", "scheduled");
    else url.searchParams.delete("view");
    window.history.replaceState(window.history.state, "", url.toString());
  }, [activeView]);

  useEffect(() => {
    setProjectTrust(null);
    setProjectTrustDialogOpen(false);
    setProjectTrustError(null);
    if (!projectTrustCwd) return;

    const controller = new AbortController();
    fetch(`/api/project-trust?cwd=${encodeURIComponent(projectTrustCwd)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json() as ProjectTrustStatus & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        setProjectTrust(data);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("Failed to load project trust:", error);
      });
    return () => controller.abort();
  }, [projectTrustCwd]);

  const handleTrustProject = useCallback(async () => {
    if (!projectTrustCwd || projectTrustBusy) return;
    setProjectTrustBusy(true);
    setProjectTrustError(null);
    try {
      const response = await fetch("/api/project-trust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectTrustCwd }),
      });
      const data = await response.json() as ProjectTrustStatus & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setProjectTrust(data);
      setProjectTrustDialogOpen(false);
      setModelsRefreshKey((key) => key + 1);
      setSessionKey((key) => key + 1);
    } catch (error) {
      setProjectTrustError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectTrustBusy(false);
    }
  }, [projectTrustBusy, projectTrustCwd]);

  const activeFileTab = fileTabs.find((t) => t.id === activeFileTabId) ?? null;
  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  const windowTitle = activeCwdName ? `${activeCwdName} - omp-web` : "omp-web";

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [windowTitle]);

  const sidebarContent = (
    <>
      <SessionSidebar
        selectedSessionId={selectedSession?.id ?? null}
        optimisticSession={selectedSession}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        initialSessionId={initialSessionId}
        skipInitialProjectSelection={skipInitialProjectSelection}
        onInitialRestoreDone={handleInitialRestoreDone}
        refreshKey={refreshKey}
        onSessionDeleted={handleSessionDeleted}
        selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? null}
        onCwdChange={handleCwdChange}
        onOpenFile={handleOpenFile}
        explorerRefreshKey={explorerRefreshKey}
        onExplorerRefresh={handleExplorerRefresh}
        onExplorerPopupOpenChange={handleExplorerPopupOpenChange}
        onAtMention={handleAtMention}
        onAtMentions={handleAtMentions}
        onShowProjectsDashboard={() => setActiveView("projects")}
        showProjectsDashboard={activeView === "projects"}
        onShowCalendar={() => setActiveView("calendar")}
        showCalendar={activeView === "calendar"}
        onShowScheduledTasks={() => setActiveView("scheduled")}
        showScheduledTasks={activeView === "scheduled"}
        onBackgroundTaskDone={handleBackgroundTaskDone}
      />
      <div style={{ padding: "0 8px", flexShrink: 0 }}>
        <OmpUpdateIndicator />
      </div>
      <div style={{ padding: "8px", flexShrink: 0 }}>
        <button
          onClick={() => setSettingsConfigOpen(true)}
          title={translate("common.settings")}
          style={{
            width: "100%", height: 34, display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            background: "none", border: "1px solid var(--border)", borderRadius: 9,
            color: "var(--text-muted)", cursor: "pointer", fontSize: 12,
            fontFamily: "var(--font-mono)", transition: "background 0.12s, color 0.12s, border-color 0.12s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.borderColor = "var(--text-dim)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.borderColor = "var(--border)"; }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.5 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.12.39.33.74.6 1 .3.28.69.42 1.1.4h.09v4h-.09A1.7 1.7 0 0 0 19.4 15Z" />
          </svg>
          {translate("common.settings")}
        </button>
      </div>
    </>
  );

  return (
    <>
<style>{`
      @media (max-width: 640px) {
        .sidebar-overlay-backdrop.sidebar-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(calc(-100% - env(safe-area-inset-left)));
          box-shadow: none;
        }
      }
    `}</style>
    <div style={{
      display: "flex",
      width: "100%",
      height: "var(--app-viewport-height, 100dvh)",
      paddingLeft: "env(safe-area-inset-left)",
      paddingRight: "env(safe-area-inset-right)",
      overflow: "hidden",
      background: "var(--bg)",
    }}>
      {/* Mobile overlay backdrop */}
      <div
        className={`sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "rgba(0,0,0,0.4)",
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />

      {/* The three-column split. `Group` is a plain flex row without a
          `position` of its own, so it introduces no stacking context and the
          layering rules the explorer window depends on are unchanged. */}
      <Group
        id="app-shell-split"
        groupRef={groupRef}
        elementRef={groupElementRef}
        defaultLayout={startingPanelLayout}
        orientation="horizontal"
        onLayoutChanged={handleLayoutChanged}
        className={`app-shell-split${panelDragActive ? " is-dragging" : ""}${startingLayoutSettled ? " is-ready" : ""}`}
        style={{ flex: 1, minWidth: 0 }}
      >
        {/* Left sidebar */}
        <Panel
          id={SIDEBAR_PANEL_ID}
          className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
          style={{
            background: "var(--bg-panel)",
            borderRight: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            paddingTop: "env(safe-area-inset-top)",
            paddingBottom: "env(safe-area-inset-bottom)",
            /* The library puts `overflow: auto` on this element; the sidebar
             * scrolls its own body and must not grow a second scrollbar. */
            overflow: "hidden",
            /* KEIN z-index hier. Die Seitenleiste trage auf dem Desktop keines,
             * und das ist Absicht, nicht Versehen: `position: relative` kommt aus
             * `.sidebar-container` (globals.css, `@media (min-width: 641px)`),
             * und `position` + `z-index` wuerden zusammen einen Stapelkontext
             * erzeugen. Alles, was im Explorer der Seitenleiste liegt — auch
             * `position: fixed` — bliebe darin gefangen, auch wenn es selbst
             * `z-index: 1300` traegt. Genau daran ist das grosse Explorer-Fenster
             * gescheitert: es steckt im Explorer der Seitenleiste, sein Backdrop
             * (1300) wurde gegen den Resizer (220) gerechnet und verlor, weil
             * beide nie in derselben Stapelebene lagen. Ohne `z-index` hat die
             * Seitenleiste auf dem Desktop keinen Stapelkontext, das Fenster
             * zaehlt wieder gegen die ganze Seite — und der Resizer liegt wieder
             * darunter. Auf dem Telefon traegt `.sidebar-container` das
             * `z-index: 200` im zugehoerigen Media-Query, weil es dort ueber
             * seinem eigenen Backdrop (199) liegen muss.
             *
             * Dass die Seitenleiste jetzt ein Panel der Bibliothek ist, aendert
             * daran nichts: der Panel-Wrapper traegt weder `position` noch
             * `z-index`, die Group auch nicht. */
          } as React.CSSProperties}
          panelRef={sidebarPanelRef}
          elementRef={sidebarPanelElementRef}
          onResize={handleSidebarPanelResize}
          collapsedSize={0}
          collapsible
          defaultSize={`${startingPanelLayout[SIDEBAR_PANEL_ID]}%`}
          minSize={SIDEBAR_MIN_WIDTH}
          maxSize={SIDEBAR_MAX_WIDTH}
        >
          {sidebarContent}
        </Panel>

      {/* Sidebar separator. `disabled` is what keeps the explorer window and
            the split layout in agreement: the library drops the tab index of a
            disabled separator, so while the window above it is open the handle
            is not merely hidden (`.overlay-blocked-resizer`) but also gone from
            the tab order and from the keyboard handling. */}
        {sidebarOpen && (
          <Separator
            aria-label={translate("layout.resizeSidebar")}
            className={`panel-resize-handle sidebar-resize-handle${explorerWindowOpen ? " overlay-blocked-resizer" : ""}`}
            data-resize-handle="sidebar"
            disabled={explorerWindowOpen}
            title={`${translate("layout.resizeSidebar")}: ${translate("layout.resizeHint")}`}
            onPointerDown={() => setPanelDragActive(true)}
            onPointerUp={() => setPanelDragActive(false)}
            onPointerCancel={() => setPanelDragActive(false)}
            onLostPointerCapture={() => setPanelDragActive(false)}
            onKeyDownCapture={sidebarSeparatorKeys.onKeyDownCapture}
            onKeyUp={() => setPanelDragActive(false)}
            onBlur={() => setPanelDragActive(false)}
          />
        )}

        {/* Center: chat */}
        <Panel
          id={CHAT_PANEL_ID}
          panelRef={chatPanelRef}
          style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}
          defaultSize={`${startingPanelLayout[CHAT_PANEL_ID]}%`}
          minSize={getChatMinWidth(isSplitViewport)}
        >
        {/* Die Kopfleiste des Chats ist eine Zeile, und auf 390px oder in einem
            schmalen Chatbereich (768px Viewport minus 260px Leiste) passen
            ihre Werkzeuge nicht mehr hinein: gemessen 656px bzw. 1015px
            Inhalt bei 390px bzw. 508px Breite. Statt Werkzeuge zu verstecken
            oder Text abzuschneiden, rollt die Zeile waagerecht — jedes Ziel
            bleibt erreichbar, nichts wird abgeschnitten. `overflowY: hidden`
            haelt den 36px hohen Streifen flach. */}
        <div ref={topBarRef} style={{ display: "flex", alignItems: "center", flexShrink: 0, overflowX: "auto", overflowY: "hidden", scrollbarWidth: "none", borderBottom: "1px solid var(--border)", height: "calc(36px + env(safe-area-inset-top))", paddingTop: "env(safe-area-inset-top)", background: "var(--bg-panel)" }}>
          <Pressable
             tint
             onClick={handleSidebarToggle}
             title={sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")}
             aria-label={sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
              background: "none", border: "none", borderRight: "1px solid var(--border)",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {sidebarOpen ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            )}
          </Pressable>
          <button
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
            }}
            title={translate(themeLabelKey)}
            aria-label={translate(themeLabelKey)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
              background: "none", border: "none", borderRight: "1px solid var(--border)",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {preference === "light" ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : preference === "dark" ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            )}
           </button>
           <button
             ref={languageBtnRef}
             type="button"
             onClick={() => toggleTopPanel("language")}
             title={translate("common.language")}
             aria-label={translate("common.language")}
             aria-haspopup="menu"
             aria-expanded={activeTopPanel === "language"}
             aria-pressed={activeTopPanel === "language"}
             style={{
               display: "flex", alignItems: "center", justifyContent: "center",
               width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
               background: activeTopPanel === "language" ? "var(--bg-selected)" : "none",
               border: "none", borderRight: "1px solid var(--border)",
               color: activeTopPanel === "language" ? "var(--text)" : "var(--text-muted)",
               cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
             }}
             onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
             onMouseLeave={(e) => {
               e.currentTarget.style.color = activeTopPanel === "language" ? "var(--text)" : "var(--text-muted)";
             }}
           >
             <svg
               width="16"
               height="16"
               viewBox="0 0 24 24"
               fill="none"
               stroke="currentColor"
               strokeWidth="1.8"
               strokeLinecap="round"
               strokeLinejoin="round"
               aria-hidden="true"
             >
               <path d="m5 8 6 6" />
               <path d="m4 14 6-6 2-3" />
               <path d="M2 5h12" />
               <path d="M7 2h1" />
               <path d="m22 22-5-10-5 10" />
               <path d="M14 18h6" />
             </svg>
           </button>
          {showChat && projectTrust?.requiresTrust && !projectTrust.trusted && (
            <button
              type="button"
              onClick={() => {
                setProjectTrustError(null);
                setProjectTrustDialogOpen(true);
              }}
              title={translate("trust.resourcesNotLoaded")}
              aria-label={translate("trust.resourcesNotLoaded")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                height: "100%",
                padding: isMobile ? "0 10px" : "0 12px",
                background: "none",
                border: "none",
                borderRight: "1px solid var(--border)",
                color: "#d97706",
                cursor: "pointer",
                flexShrink: 0,
                fontSize: 11,
                whiteSpace: "nowrap",
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
                <path d="M12 8v4" />
                <path d="M12 16h.01" />
              </svg>
              {!isMobile && <span>{translate("trust.resourcesNotLoaded")}</span>}
            </button>
          )}
          {showChat && (
            <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
              <button
                onClick={handleViewFullHistory}
                disabled={!selectedSession}
                 title={selectedSession ? translate("history.full") : translate("history.unsaved")}
                 aria-label={translate("history.full")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  height: "100%",
                  padding: "0 12px",
                  background: "none",
                  border: "none",
                  borderTop: "2px solid transparent",
                  borderRight: "1px solid var(--border)",
                  color: selectedSession ? "var(--text-muted)" : "var(--text-dim)",
                  cursor: selectedSession ? "pointer" : "not-allowed",
                  opacity: selectedSession ? 1 : 0.45,
                  flexShrink: 0,
                  fontSize: 11,
                  whiteSpace: "nowrap",
                  transition: "color 0.1s, background 0.1s, opacity 0.1s",
                }}
                onMouseEnter={(e) => {
                  if (!selectedSession) return;
                  e.currentTarget.style.color = "var(--text)";
                  e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = selectedSession ? "var(--text-muted)" : "var(--text-dim)";
                  e.currentTarget.style.background = "none";
                }}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{
                    color: selectedSession ? "var(--text-muted)" : "var(--text-dim)",
                    flexShrink: 0,
                  }}
                >
                  <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                  <path d="M3 3v5h5" />
                  <path d="M12 7v5l3 2" />
                </svg>
                 {!isMobile && <span>{translate("history.label")}</span>}
              </button>
              {(() => {
                // 上下文压缩后当前消息可能不再包含 user 消息，需同时参考会话文件的消息总数。
                const hasMessages = Boolean(
                  selectedSession
                  && ((sessionStats?.userMessages ?? 0) > 0 || selectedSession.messageCount > 0),
                );
                const disabled = !selectedSession || selectedSession.transient || !hasMessages || autoNameStatus.kind === "naming";
                const isSuccess = autoNameStatus.kind === "success";
                const isError = autoNameStatus.kind === "error";
                const label = autoNameStatus.kind === "naming"
                   ? translate("title.generating")
                    : isSuccess
                    ? translate("title.updated")
                    : isError
                      ? translate("title.failed")
                      : translate("title.generate");
                const title = !selectedSession || selectedSession.transient
                   ? translate("title.unsaved")
                   : !hasMessages
                     ? translate("title.noMessages")
                     : isError
                       ? autoNameStatus.message
                       : translate("title.generateSession");

                return (
                  <button
                    type="button"
                    onClick={() => void handleAutoName()}
                    disabled={disabled}
                    title={title}
                    aria-label={label}
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      height: "100%", padding: "0 12px",
                      background: "none", border: "none",
                      borderTop: "2px solid transparent",
                      borderRight: "1px solid var(--border)",
                      color: isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)",
                      cursor: disabled ? "not-allowed" : "pointer",
                      opacity: disabled && autoNameStatus.kind !== "naming" ? 0.45 : 1,
                      flexShrink: 0, fontSize: 11, whiteSpace: "nowrap",
                      transition: "color 0.1s, background 0.1s, opacity 0.1s",
                    }}
                    onMouseEnter={(e) => {
                      if (disabled) return;
                      e.currentTarget.style.color = isError ? "#dc2626" : "var(--text)";
                      e.currentTarget.style.background = "var(--bg-hover)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)";
                      e.currentTarget.style.background = "none";
                    }}
                  >
                    {autoNameStatus.kind === "naming" ? (
                      <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    ) : isSuccess ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="m15 4 5 5L7 22l-5-5Z" />
                        <path d="m14 5 5 5" />
                        <path d="M6 4V2M5 3H3M19 19v3M17.5 20.5h3" />
                      </svg>
                    )}
                    {!isMobile && <span>{label}</span>}
                  </button>
                );
              })()}
              <BranchNavigator
                tree={branchTree}
                activeLeafId={branchActiveLeafId}
                onLeafChange={handleBranchLeafChange}
                inline
                compact={isMobile}
                containerRef={topBarRef}
                open={activeTopPanel === "branches"}
                onToggle={() => toggleTopPanel("branches")}
                hasSession
              />
              <TerminalDropdown
                cwd={activeCwd}
                onOpenTerminal={handleOpenTerminalTab}
                disabled={isMobile}
              />
              <button
                ref={systemBtnRef}
                onClick={() => toggleTopPanel("system")}
                 title={translate("system.prompt")}
                 aria-label={translate("system.prompt")}
                aria-pressed={activeTopPanel === "system"}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  height: "100%", padding: "0 12px",
                  background: activeTopPanel === "system" ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderTop: activeTopPanel === "system" ? "2px solid var(--accent)" : "2px solid transparent",
                  borderRight: "1px solid var(--border)",
                  cursor: "pointer",
                  color: activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)",
                  fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)"; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: systemPrompt ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }}>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="8" y1="13" x2="16" y2="13" />
                  <line x1="8" y1="17" x2="13" y2="17" />
                </svg>
                 {!isMobile && <span>{translate("system.label")}</span>}
              </button>
            </div>
          )}
          <SystemStatsBadge />
          {/* Session stats — right-aligned in top bar */}
          {showChat && (sessionStats || contextUsage) && (() => {
             const tokens = sessionStats?.tokens;
            const c = sessionStats?.cost ?? 0;
            const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
            const costStr = c > 0 ? (c >= 0.01 ? `$${c.toFixed(2)}` : `<$0.01`) : null;

            let ctxColor = "var(--text-muted)";
            let ctxStr: string | null = null;
            if (contextUsage?.contextWindow) {
              const pct = contextUsage.percent;
              if (pct !== null && pct > 90) ctxColor = "#ef4444";
              else if (pct !== null && pct > 70) ctxColor = "rgba(234,179,8,0.95)";
              const used = contextUsage.tokens !== null ? fmt(contextUsage.tokens) : "?";
              ctxStr = pct !== null
                ? `${pct.toFixed(0)}% · ${used}/${fmt(contextUsage.contextWindow)}`
                : `? · ${used}/${fmt(contextUsage.contextWindow)}`;
            }

            const tooltipParts: string[] = [];
             if (tokens) {
               tooltipParts.push(`in: ${tokens.input.toLocaleString(locale)}`);
               tooltipParts.push(`out: ${tokens.output.toLocaleString(locale)}`);
               tooltipParts.push(`cache read: ${tokens.cacheRead.toLocaleString(locale)}`);
               tooltipParts.push(`cache write: ${tokens.cacheWrite.toLocaleString(locale)}`);
              if (c > 0) tooltipParts.push(`cost: $${c.toFixed(4)}`);
            }
            if (contextUsage?.contextWindow) {
              const pct = contextUsage.percent;
              tooltipParts.push(`context: ${contextUsage.tokens !== null ? contextUsage.tokens.toLocaleString(locale) : "?"} / ${contextUsage.contextWindow.toLocaleString(locale)} tokens (${pct !== null ? pct.toFixed(1) + "%" : "unknown"})`);
            }
            const tooltip = tooltipParts.join("  |  ");

            return (
              <button
                type="button"
                onClick={() => toggleTopPanel("session")}
               title={tooltip || translate("session.title")}
                 aria-label={translate("session.title")}
                aria-pressed={activeTopPanel === "session"}
                style={{
                  marginLeft: "auto",
                  display: "flex", alignItems: "center", gap: 10,
                  paddingLeft: 12,
                  paddingRight: rightPanelOpen ? 12 : 48,
                  height: "100%",
                  background: activeTopPanel === "session" ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderTop: activeTopPanel === "session" ? "2px solid var(--accent)" : "2px solid transparent",
                  fontSize: 11, color: "var(--text-muted)",
                  whiteSpace: "nowrap", cursor: "pointer",
                  fontVariantNumeric: "tabular-nums",
                  transition: "color 0.1s, background 0.1s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = activeTopPanel === "session" ? "var(--text)" : "var(--text-muted)"; }}
              >
                {isMobile && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                )}
                 {!isMobile && tokens && tokens.input > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
                    </svg>
                     {fmt(tokens.input)}
                  </span>
                )}
                 {!isMobile && tokens && tokens.output > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                    </svg>
                     {fmt(tokens.output)}
                  </span>
                )}
                 {!isMobile && tokens && tokens.cacheRead > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8.5 5a3.5 3.5 0 1 1-1-2.45" /><polyline points="6.5 1.5 8.5 2.5 7.5 4.5" />
                    </svg>
                     {fmt(tokens.cacheRead)}
                  </span>
                )}
                {!isMobile && costStr && (
                  <span style={{ display: "flex", alignItems: "center", color: "var(--text)", fontWeight: 500 }}>
                    {costStr}
                  </span>
                )}
                {ctxStr && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4, color: ctxColor }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
                    </svg>
                    {ctxStr}
                  </span>
                )}
              </button>
            );
          })()}
          {/* Top panel dropdown — shared, only one active at a time */}
          {activeTopPanel && topPanelPos && (
            <div style={{
              position: "fixed",
              top: topPanelPos.top,
              left: topPanelPos.left,
              width: topPanelPos.width,
              maxHeight: `calc(100dvh - ${topPanelPos.top}px)`,
              overflowY: "auto",
              zIndex: 500,
            }}>
              {activeTopPanel === "language" && (
                <Reveal
                  role="menu"
                  aria-label={translate("common.language")}
                  style={{
                    background: "var(--bg-panel)",
                    borderLeft: "1px solid var(--border)",
                    borderRight: "1px solid var(--border)",
                    borderBottom: "1px solid var(--border)",
                    overflow: "hidden",
                    padding: 4,
                  }}
                >
                  {supportedLocales.map((plugin) => (
                    <button
                      key={plugin.id}
                      type="button"
                      onClick={() => {
                        setLocale(plugin.id as typeof locale);
                        setActiveTopPanel(null);
                      }}
                      role="menuitemradio"
                      aria-checked={locale === plugin.id}
                      style={{
                        display: "flex", alignItems: "center",
                        width: "100%", height: 34, padding: "0 10px",
                        border: "none", borderRadius: 4,
                        background: locale === plugin.id ? "var(--bg-selected)" : "transparent",
                        color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 12,
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={(e) => {
                        if (locale !== plugin.id) e.currentTarget.style.background = "var(--bg-hover)";
                      }}
                      onMouseLeave={(e) => {
                        if (locale !== plugin.id) e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <span>{plugin.label}</span>
                    </button>
                  ))}
                </Reveal>
              )}
              {activeTopPanel === "system" && (
                <Reveal style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                }}>
                  {systemPrompt ? (
                    <div style={{
                      maxHeight: "min(600px, 75vh)",
                      overflowY: "auto",
                      padding: "12px 16px",
                      color: "var(--text-muted)",
                      fontSize: 12,
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      fontFamily: "var(--font-mono)",
                    }}>
                      {systemPrompt}
                    </div>
                  ) : systemPrompt === "" ? (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                       {translate("system.empty")}
                    </div>
                  ) : (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                       {translate("system.load")}
                    </div>
                  )}
                </Reveal>
              )}
              {activeTopPanel === "session" && (
                <Reveal style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                  boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
                  padding: "12px 16px",
                }}>
                  {sessionStats ? (() => {
                    const formatDuration = (ms: number) => {
                      if (ms <= 0) return "0s";
                      const totalSec = Math.floor(ms / 1000);
                      const h = Math.floor(totalSec / 3600);
                      const m = Math.floor((totalSec % 3600) / 60);
                      const s = totalSec % 60;
                      if (h > 0) return `${h}h ${m}m`;
                      if (m > 0) return `${m}m ${s}s`;
                      return `${s}s`;
                    };
                    const totalActiveMs = sessionStats.totalActiveMs ?? 0;
                    const sessionRows = [
                       ...(sessionStats.sessionName ? [{ label: translate("session.name"), value: sessionStats.sessionName, copyField: null }] : []),
                       { label: translate("session.file"), value: sessionStats.sessionFile ?? translate("session.inMemory"), copyField: "file" as const },
                       { label: translate("session.id"), value: sessionStats.sessionId, copyField: "id" as const },
                       ...(totalActiveMs > 0 ? [{ label: translate("session.totalActive"), value: formatDuration(totalActiveMs), copyField: null }] : []),
                    ];
                    const messageRows = [
                       [translate("session.user"), sessionStats.userMessages.toLocaleString(locale)],
                       [translate("session.assistant"), sessionStats.assistantMessages.toLocaleString(locale)],
                       [translate("session.toolCalls"), sessionStats.toolCalls.toLocaleString(locale)],
                       [translate("session.toolResults"), sessionStats.toolResults.toLocaleString(locale)],
                       [translate("session.total"), sessionStats.totalMessages.toLocaleString(locale)],
                    ];
                    const tokenRows = [
                       [translate("session.input"), sessionStats.tokens.input.toLocaleString(locale)],
                       [translate("session.output"), sessionStats.tokens.output.toLocaleString(locale)],
                       ...(sessionStats.tokens.cacheRead > 0 ? [[translate("session.cacheRead"), sessionStats.tokens.cacheRead.toLocaleString(locale)]] : []),
                       ...(sessionStats.tokens.cacheWrite > 0 ? [[translate("session.cacheWrite"), sessionStats.tokens.cacheWrite.toLocaleString(locale)]] : []),
                       [translate("session.total"), sessionStats.tokens.total.toLocaleString(locale)],
                    ];
                    const ctx = contextUsage ?? sessionStats.contextUsage;
                    const formatCompact = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
                    const extraTokenRows = [
                       ...(sessionStats.cost > 0 ? [[translate("session.cost"), `$${sessionStats.cost.toFixed(4)}`]] : []),
                       ...(ctx?.contextWindow ? [[translate("session.context"), `${ctx.tokens !== null ? formatCompact(ctx.tokens) : "?"} / ${formatCompact(ctx.contextWindow)}${ctx.percent !== null ? ` · ${ctx.percent.toFixed(1)}%` : ""}`]] : []),
                       // Cache hit rate = cache reads / (input + cache writes + cache reads) — the denominator covers all input-class tokens.
                       ...(sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite > 0 && sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite + sessionStats.tokens.input > 0
                         ? [[translate("session.cacheHitRate"), `${(sessionStats.tokens.cacheRead / (sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite + sessionStats.tokens.input) * 100).toFixed(1)}%`]]
                         : []),
                    ];
                    const section = (
                      title: string,
                      sectionRows: string[][],
                      valueAlign: "left" | "right" = "left",
                      compact = false,
                    ) => (
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{title}</div>
                          <div style={{
                            display: "grid",
                            gridTemplateColumns: compact ? "max-content max-content" : "auto minmax(0, 1fr)",
                            columnGap: compact ? 14 : 12,
                            rowGap: 4,
                            justifyContent: compact ? "start" : undefined,
                          }}>
                            {sectionRows.map(([label, value]) => (
                              <div key={`${title}:${label}`} style={{ display: "contents" }}>
                                <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
                                <div style={{
                                  color: "var(--text-muted)",
                                  minWidth: 0,
                                  overflowWrap: compact ? "normal" : "anywhere",
                                  textAlign: valueAlign,
                                  whiteSpace: valueAlign === "right" ? "nowrap" : "normal",
                                }}>{value}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    const copyButton = (field: SessionCopyField, value: string) => {
                      const copied = copiedSessionField === field;
                      return (
                        <button
                          type="button"
                           title={copied ? translate("session.copied") : translate(field === "file" ? "session.copyFile" : "session.copyId")}
                          onClick={() => handleCopySessionField(field, value)}
                          style={{
                            alignSelf: "start",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 22,
                            height: 22,
                            marginTop: -2,
                            color: copied ? "var(--accent)" : "var(--text-dim)",
                            background: "transparent",
                            border: "1px solid var(--border)",
                            borderRadius: 4,
                            cursor: "pointer",
                            flex: "0 0 auto",
                            transition: "color 0.12s, border-color 0.12s, background 0.12s",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color = "var(--accent)";
                            e.currentTarget.style.borderColor = "var(--accent)";
                            e.currentTarget.style.background = "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color = copied ? "var(--accent)" : "var(--text-dim)";
                            e.currentTarget.style.borderColor = "var(--border)";
                            e.currentTarget.style.background = "transparent";
                          }}
                        >
                          {copied ? (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          )}
                        </button>
                      );
                    };
                    const sessionInfoSection = (
                      <div style={{ minWidth: 0 }}>
                         <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{translate("session.infoSection")}</div>
                        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
                          {sessionRows.map((row) => (
                            <div key={`session-info:${row.label}`} style={{ display: "contents" }}>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                              <div style={{
                                color: "var(--text-muted)",
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                whiteSpace: "normal",
                              }}>{row.value}</div>
                              <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );

                    return (
                      <div style={{
                        display: "grid",
                        gridTemplateColumns: isMobile
                          ? "1fr"
                          : "minmax(360px, 1.7fr) minmax(140px, 0.55fr) minmax(190px, 0.75fr)",
                        gap: isMobile ? 16 : 24,
                        fontSize: 12,
                        lineHeight: 1.5,
                        fontFamily: "var(--font-mono)",
                      }}>
                        {sessionInfoSection}
                         {section(translate("session.messages"), messageRows)}
                         {section(translate("session.tokens"), [...tokenRows, ...extraTokenRows], "right", true)}
                      </div>
                    );
                  })() : (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                       {translate("session.load")}
                    </div>
                  )}
                </Reveal>
              )}
            </div>
          )}

        </div>

        {/* Chat content */}
        <div className="chat-content-layout">
          <div className="chat-session-column">
          {showProjects ? (
            <ProjectsDashboard
              isAdmin={isAdmin}
              onOpenProject={(root) => {
                setActiveView("chat");
                handleCwdChange(root);
              }}
            />
          ) : showCalendar ? (
            <CalendarView />
          ) : showScheduledTasks ? (
            <ScheduledTasksView onOpenSession={handleOpenScheduledSession} />
          ) : showChat ? (
            <ChatWindow
              key={sessionKey}
              session={selectedSession}
              newSessionCwd={effectiveNewSessionCwd}
              onAgentEnd={handleAgentEnd}
              onAttentionNeeded={handleAttentionNeeded}
              onSessionCreated={handleSessionCreated}
              onSessionForked={handleSessionForked}
              modelsRefreshKey={modelsRefreshKey}
              chatInputRef={chatInputRef}
              onBranchDataChange={handleBranchDataChange}
              onSystemPromptChange={handleSystemPromptChange}
              onSessionStatsChange={handleSessionStatsChange}
              onSessionStatsPanelOpen={openSessionStatsPanel}
              onContextUsageChange={handleContextUsageChange}
              onSubagentsChange={setSubagents}
              onOpenFile={handleOpenLinkedFile}
              soundEnabled={soundEnabled}
              onSoundToggle={onSoundToggle}
              playDoneSound={playDoneSound}
              unlockAudio={unlockAudio}
            />
          ) : initialCwdStatus === "validating" ? (
            <div
              role="status"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <Shimmer radius={6} style={{ padding: "6px 12px", fontSize: 14, color: "var(--text)" }}>
                 {translate("workspace.opening")}
               </Shimmer>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
            </div>
          ) : initialCwdStatus === "error" ? (
            <div
              role="alert"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: 14, color: "#dc2626" }}>{translate("workspace.unable")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
              <div style={{ maxWidth: 720, fontSize: 12 }}>{initialCwdError}</div>
            </div>
          ) : showPlaceholder ? (
            activeCwd ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 15 }}>
                 {translate("workspace.selectSession")}
              </div>
            ) : (
              <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                  <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
                </svg>
                <div>
                   <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{translate("workspace.getStarted")}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                     <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>{translate("workspace.selectProject")}<br />
                     <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>{translate("workspace.addModels")}
                  </div>
                </div>
              </div>
            )
          ) : null}
          </div>
          {showSubagentPanel && (
            <div className="subagent-column">
              <SubagentPanel
                sessionId={selectedSession?.id ?? null}
                cwd={selectedSession?.cwd ?? effectiveNewSessionCwd ?? undefined}
                subagents={subagents}
              />
            </div>
          )}
        </div>
        </Panel>

        {/* File panel separator. Below the split breakpoint the panel is a
            fixed overlay, so the handle is disabled rather than merely hidden:
            the library then neither moves the panel nor lets the keyboard
            reach it. */}
        {rightPanelOpen && (
          <Separator
            aria-label={translate("layout.resizeFilePanel")}
            className={`panel-resize-handle right-panel-resize-handle${explorerWindowOpen ? " overlay-blocked-resizer" : ""}`}
            data-resize-handle="right-panel"
            disabled={!isSplitViewport || explorerWindowOpen}
            title={`${translate("layout.resizeFilePanel")}: ${translate("layout.resizeHint")}`}
            onPointerDown={() => setPanelDragActive(true)}
            onPointerUp={() => setPanelDragActive(false)}
            onPointerCancel={() => setPanelDragActive(false)}
            onLostPointerCapture={() => setPanelDragActive(false)}
            onKeyDownCapture={fileSeparatorKeys.onKeyDownCapture}
            onKeyUp={() => setPanelDragActive(false)}
            onBlur={() => setPanelDragActive(false)}
          />
        )}

        {/* Right panel: file viewer — always mounted, width animated via CSS */}
        <Panel
          id={FILE_PANEL_ID}
          className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}`}
          style={{
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            borderLeft: "1px solid var(--border)",
            background: "var(--bg)",
          } as React.CSSProperties}
          panelRef={filePanelRef}
          elementRef={filePanelElementRef}
          onResize={handleFilePanelResize}
          collapsedSize={0}
          collapsible
          defaultSize={`${startingPanelLayout[FILE_PANEL_ID]}%`}
          minSize={RIGHT_PANEL_MIN_WIDTH}
          maxSize={RIGHT_PANEL_MAX_WIDTH}
          disabled={!isSplitViewport}
        >
        {/* Right panel tab bar */}
        <div style={{
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          height: "calc(36px + env(safe-area-inset-top))",
          paddingTop: "env(safe-area-inset-top)",
          background: "var(--bg-panel)",
          borderBottom: "1px solid var(--border)",
        }}>
          <div style={{ flex: 1, overflow: "hidden" }}>
            <TabBar
              tabs={fileTabs}
              activeTabId={activeFileTabId ?? ""}
              onSelectTab={setActiveFileTabId}
              onCloseTab={handleCloseFileTab}
            />
          </div>

        </div>

        {/* File content */}
        <div style={{ flex: 1, overflow: "hidden", paddingBottom: "env(safe-area-inset-bottom)" }}>
          {activeFileTab?.kind === "terminal" ? (
            <TerminalViewer terminalId={activeFileTab.terminalId} />
          ) : activeFileTab?.kind === "file" ? (
            <FileViewer
              filePath={activeFileTab.filePath}
              cwd={activeCwd ?? undefined}
              sourceSessionId={activeFileTab.sourceSessionId}
              gitRefreshKey={explorerRefreshKey}
              initialDisplayMode={activeFileTab.initialDisplayMode}
              onMentionLines={rightPanelOpen ? handleFileLineMention : undefined}
              onAtMention={handleAtMention}
              onOpenFile={(filePath) => handleOpenFile(
                filePath,
                getFileName(filePath),
                { sourceSessionId: activeFileTab.sourceSessionId },
              )}
            />
          ) : (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
               {translate("files.noneOpen")}
            </div>
          )}
        </div>
        </Panel>
      </Group>

      {/* Backdrop of the compact file panel. It sits outside the split group
          because it is not part of it: it is a fixed overlay, and the panel it
          dims is one for exactly as long as the group is below the split
          breakpoint. */}
      <div
        aria-hidden="true"
        className={`right-panel-overlay-backdrop${rightPanelOpen ? " is-open" : ""}`}
        onClick={() => setRightPanelOpen(false)}
      />
    </div>
    {/* File panel toggle — always visible at top-right */}
    <Pressable
      onClick={() => setRightPanelOpen((v) => !v)}
      tint
       aria-controls="file-panel"
       aria-expanded={rightPanelOpen}
       title={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
       aria-label={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
      style={{
        position: "fixed", top: "env(safe-area-inset-top)", right: "env(safe-area-inset-right)", zIndex: 300,
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 36, height: 36, padding: 0,
        background: "var(--bg-panel)", border: "none", borderLeft: "1px solid var(--border)", borderBottom: "1px solid var(--border)",
        color: rightPanelOpen ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer", transition: "color 0.12s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = rightPanelOpen ? "var(--text)" : "var(--text-muted)"; }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
      </svg>
    </Pressable>
    {settingsConfigOpen && (
      <SettingsConfig
        cwd={projectTrustCwd}
        sessionId={selectedSession?.id ?? null}
        onClose={() => setSettingsConfigOpen(false)}
        onModelsChanged={() => setModelsRefreshKey((key) => key + 1)}
        onReloaded={() => setSessionKey((key) => key + 1)}
      />
    )}
    {projectTrustDialogOpen && projectTrustCwd && (
      <ProjectTrustDialog
        cwd={projectTrustCwd}
        busy={projectTrustBusy}
        error={projectTrustError}
        onCancel={() => {
          if (!projectTrustBusy) setProjectTrustDialogOpen(false);
        }}
        onConfirm={() => void handleTrustProject()}
      />
    )}
    </>
  );
}
