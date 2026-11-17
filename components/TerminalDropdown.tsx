"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Enter } from "./motion/Enter";
import { Pressable } from "./motion/Pressable";
import { Shimmer } from "./motion/Shimmer";
import { PULSE_TRANSITION, SPRING_PRESS } from "./motion/animations";
import { useAnimationMode } from "./motion/hooks";
import { useFixedPopover } from "@/hooks/useFixedPopover";

interface TerminalSummary {
  id: string;
  cwd: string;
  pid: number;
  status: "running" | "exited";
  shell: string;
  createdAt: number;
  /** Kommt aus der Route; `false` heisst "diese Shell laeuft unisoliert". */
  sandboxed: boolean;
}

// Breite des Menues: eine Zeile "Neues Terminal" plus gekuerzter Pfad passen
// in 280 px. Ein fester Wert haelt die Klemme im Viewport berechenbar.
const MENU_WIDTH = 280;

// Ein Zeichen der Terminal-Schrift (JetBrains Mono, 14 px im Viewer) ist
// 8,4 px breit — 0,6 em, im FitAddon-Panel gemessen. `script(1)` besitzt die
// PTY-Master-Seite, also bleibt die beim Spawn gesetzte Geometrie: breiter
// gespawnt heisst auf dem Telefon (390 px) umgebrochene Zeilen.
const TERMINAL_CELL_PX = 8.4;
// Dieselbe Messgrenze wie `isMeasuredTerminal` in `TerminalViewer.tsx`: darunter
// ist das Panel nicht gemessen, sondern FitAddons Kleinstwert.
const MIN_READY_COLS = 20;
// Obergrenze fuer den Spawn; die Route selbst erlaubt bis 500.
const MAX_SPAWN_COLS = 200;
// Das Vollbild-Overlay auf dem Telefon laesst je Seite 16 px Rand, die Leiste
// liefert keine eigene Breite.
const MOBILE_GUTTER_PX = 32;

/**
 * Spalten fuer die neue Shell: gemessene Panelbreite, sonst die
 * Viewport-Schaetzung (Telefon-Overlay: volle Breite minus 2×16 px).
 */
export function terminalSpawnCols(measuredPanelWidth: number | null, viewportWidth: number): number {
  const width = measuredPanelWidth !== null && measuredPanelWidth > 0
    ? measuredPanelWidth
    : Math.max(0, Math.min(viewportWidth, 1200) - MOBILE_GUTTER_PX);
  return Math.max(MIN_READY_COLS, Math.min(MAX_SPAWN_COLS, Math.floor(width / TERMINAL_CELL_PX)));
}

/**
 * Breite des Panels, in dem das neue Terminal landen wird — `null`, wenn es
 * gerade nicht messbar ist (Telefon, geschlossen: `display: none`).
 *
 * Bei geschlossenem Desktop-Panel ist der Container 0 px breit, sein erstes
 * Kind traegt aber die gemerkte Breite (`--right-panel-width` bzw. der
 * CSS-Standard `clamp(360px, 42vw, 640px)`), weil es unter `overflow: hidden`
 * weiter layoutet wird. Diese Breite ist die, in die das Panel beim Oeffnen
 * zurueckkehrt.
 */
function measureTerminalPanelWidth(): number | null {
  if (typeof document === "undefined") return null;
  const panel = document.querySelector<HTMLElement>(".right-panel-container");
  if (!panel) return null;
  if (panel.clientWidth > 0) return panel.clientWidth;
  const inner = panel.firstElementChild?.getBoundingClientRect().width ?? 0;
  return inner > 0 ? inner : null;
}

interface Props {
  cwd?: string | null;
  onOpenTerminal: (terminalId: string) => void;
}

export function TerminalDropdown({ cwd, onOpenTerminal }: Props) {
  // Both raw `motion.*` elements below (the row's whileTap and the status
  // dot's pulse) skip the mode check `Pressable` does, and `MotionConfig`
  // does not cover either: in node_modules/motion-dom/dist/cjs/index.js
  // `shouldReduceMotion` is evaluated at exactly two places — line ~3753,
  // when an `animate` target is resolved, and there only for
  // `positionalKeys` (x/y/scale/rotate), plus line ~8997 for layout
  // animations. A gesture runs through `AnimationState.startAnimation` →
  // `animateSingleValue` and never sees it, and `repeat: Infinity` is not a
  // layout animation, so the pulse keeps breathing on "Off".
  const mode = useAnimationMode();
  const [open, setOpen] = useState(false);
  const [terminals, setTerminals] = useState<TerminalSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const refreshPendingRef = useRef(false);

  const refresh = useCallback(async () => {
    // Polls must not stack: each one holds a slot of the six HTTP
    // connections the browser allows per host, and a queued request behind a
    // slow neighbour delays everything else (an idle POST included).
    if (refreshPendingRef.current) return;
    refreshPendingRef.current = true;
    try {
      const res = await fetch("/api/terminal");
      if (!res.ok) return;
      const data = await res.json() as { terminals: TerminalSummary[] };
      setTerminals(data.terminals);
    } catch {
      // Network blip; keep the cached list rather than showing an error.
    } finally {
      refreshPendingRef.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(refresh, 4000);
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleNew = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // Die Startgeometrie kommt aus dem Panel, in das die Shell kommt, nicht
      // aus einer Konstante: 390 px ergeben 42 Spalten, das 522-px-Panel 62.
      // `script(1)` besitzt die PTY, ein laufender Shell laesst sich aus diesem
      // Prozess nicht umbrechen — die Spawn-Breite gilt fuer die ganze Sitzung,
      // deshalb wird sie vorher gemessen statt geraten.
      const cols = terminalSpawnCols(measureTerminalPanelWidth(), window.innerWidth);
      const res = await fetch("/api/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: cwd ?? undefined, cols, rows: 30 }),
      });
      const data = await res.json().catch(() => ({})) as { terminal?: TerminalSummary; error?: string };
      if (!res.ok || !data.terminal) {
        setError(data.error ?? `Failed to spawn (${res.status})`);
        return;
      }
      onOpenTerminal(data.terminal.id);
      setOpen(false);
      void refresh();
    } finally {
      setBusy(false);
    }
  }, [cwd, onOpenTerminal, refresh]);

  const handleKill = useCallback(async (id: string) => {
    await fetch(`/api/terminal/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
    void refresh();
  }, [refresh]);

  const menuPos = useFixedPopover(triggerRef, open, { width: MENU_WIDTH });

  const runningCount = terminals.filter((terminal) => terminal.status === "running").length;

  return (
    <div ref={rootRef} style={{ position: "relative", display: "flex", height: "100%" }}>
      <Pressable
        ref={triggerRef}
        tint
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Terminal"
        aria-label="Terminal"
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: "100%",
          padding: "0 12px",
          background: open ? "var(--bg-selected)" : "none",
          border: "none",
          borderTop: open ? "2px solid var(--accent)" : "2px solid transparent",
          borderRight: "1px solid var(--border)",
          color: open ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer",
          fontSize: 11,
          whiteSpace: "nowrap",
          transition: "color var(--duration-hover) var(--ease-standard), background-color var(--duration-hover) var(--ease-standard)",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = open ? "var(--text)" : "var(--text-muted)"; }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
        <span>Terminal</span>
        {runningCount > 0 && (
          <span
            aria-label={`${runningCount} running`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: 16,
              height: 16,
              padding: "0 4px",
              borderRadius: 8,
              background: "var(--accent)",
              color: "var(--accent-fg, #fff)",
              fontSize: 10,
              fontWeight: 600,
            }}
          >
            {runningCount}
          </span>
        )}
      </Pressable>
      {open && menuPos && (
        <Enter direction="down" role="menu" style={{
            // Die Kopfleiste schneidet ihre Kinder ab; das Menue liegt deshalb
            // fest im Viewport, verankert am gemessenen Ausloeser. Ohne die
            // Messung waere es hinter dem 36-px-Streifen unsichtbar.
            position: "fixed",
            top: menuPos.top,
            left: menuPos.left,
            width: menuPos.width,
            maxHeight: menuPos.maxHeight,
            // Nur senkrecht rollen; waagerecht bleibt der Radius scharf.
            overflow: "hidden auto",
            marginTop: 0,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
            zIndex: 250,
          }}
        >
          <Pressable
            type="button"
            role="menuitem"
            onClick={() => void handleNew()}
            disabled={busy}
            aria-busy={busy || undefined}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "8px 12px",
              background: "transparent",
              border: "none",
              borderBottom: "1px solid var(--border)",
              color: busy ? "var(--text-dim)" : "var(--text)",
              cursor: busy ? "not-allowed" : "pointer",
              fontSize: 12,
              textAlign: "left",
            }}
          >
            <span style={{ fontSize: 14, lineHeight: 1, flexShrink: 0 }}>+</span>
            {/* The spawn is a server round trip that takes seconds — measured
                5.8s warm and 55s on a cold dev server — and until it answers
                there is no terminal id, no tab and no open panel. Dimming the
                row alone left the click looking like it had done nothing at
                all, which is what it looked like. The row now says what it is
                doing, in the same wash every other loading surface in the app
                uses. */}
            {busy ? (
              <Shimmer radius={4} style={{ flex: 1, padding: "1px 0", whiteSpace: "nowrap" }}>Starting…</Shimmer>
            ) : (
              // Eine Zeile pro Eintrag: der Name bleibt ganz, der Pfad daneben
              // gibt nach und kuerzt sich. Mit `flex: 1` am Namen bekam er nur
              // den Rest nach dem 160-px-Pfad und brach bei 280 px um.
              <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>New terminal</span>
            )}
            {cwd && (
              <span title={cwd} style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", flex: "0 1 auto", minWidth: 0, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {cwd}
              </span>
            )}
          </Pressable>
          {error && (
            <div style={{ padding: "8px 12px", color: "#f87171", fontSize: 11, background: "rgba(239,68,68,0.08)" }}>
              {error}
            </div>
          )}
          <div style={{ maxHeight: 320, overflow: "auto" }}>
            {terminals.length === 0 && (
              <div style={{ padding: "12px", color: "var(--text-dim)", fontSize: 11, textAlign: "center" }}>
                No terminals yet
              </div>
            )}
            {terminals.map((t) => (
              <motion.div
                key={t.id}
                role="menuitem"
                whileTap={mode === "off" ? undefined : t.status === "running"
                  ? { scale: 0.96, backgroundColor: "var(--accent-hover, var(--accent))" }
                  : undefined}
                transition={SPRING_PRESS}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 12px",
                  cursor: t.status === "running" ? "pointer" : "default",
                  opacity: t.status === "running" ? 1 : 0.55,
                  borderBottom: "1px solid var(--border)",
                }}
                onClick={() => {
                  if (t.status !== "running") return;
                  onOpenTerminal(t.id);
                  setOpen(false);
                }}
                onMouseEnter={(e) => {
                  if (t.status === "running") e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                <motion.span
                  aria-label={t.status}
                  animate={mode !== "off" && t.status === "running" ? { opacity: [1, 0.35, 1] } : undefined}
                  transition={PULSE_TRANSITION}
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: t.status === "running" ? "var(--success)" : "var(--text-dim)",
                    boxShadow: t.status === "running" ? "0 0 4px var(--success)" : "none",
                    flexShrink: 0,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* Der Pfad wird gekuerzt, ist aber der einzige Unterschied
                      zwischen zwei Terminals im selben Projekt: der volle Pfad
                      steht deshalb im Tooltip. */}
                  <div title={t.cwd} style={{ fontSize: 12, color: "var(--text)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.cwd}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                    {t.shell} · pid {t.pid}
                  </div>
                </div>
                <Pressable
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleKill(t.id);
                  }}
                  title="Kill terminal"
                  aria-label={`Kill terminal in ${t.cwd}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 22,
                    height: 22,
                    padding: 0,
                    background: "transparent",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 11,
                    flexShrink: 0,
                  }}
                >
                  ×
                </Pressable>
        </motion.div>
            ))}
          </div>
        </Enter>
      )}
    </div>
  );
}
