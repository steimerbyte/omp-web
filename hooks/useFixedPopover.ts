"use client";

import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

export interface FixedPopoverPosition {
  top: number;
  left: number;
  width: number;
  /** Height left below the trigger; a taller popover scrolls instead of growing out of the viewport. */
  maxHeight: number;
}

/** `useLayoutEffect` misst vor dem Paint; auf dem Server gibt es beides nicht. */
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 2;

/**
 * Ort und Breite eines `position: fixed`-Popovers unter seinem Auslöser.
 *
 * Die Kopfleiste rollt waagerecht und schneidet ihre Kinder ab; ein absolut
 * positioniertes Menü darin ist nicht erreichbar. Gemessen wird deshalb am
 * Auslöser selbst (nicht am Elternteil), und das Ergebnis wird auf beiden
 * Achsen in den Viewport geklemmt. Neu gemessen wird bei Fenster- und
 * Ansichtswechsel sowie bei jedem Scroll — die Leiste rollt waagerecht unter
 * dem festen Menü weg. Ein Klick daneben und Escape bleiben Sache des
 * Aufrufers: das Popover bleibt im selben DOM-Teilbaum wie sein Auslöser.
 */
export function useFixedPopover(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  options: { width: number; align?: "left" | "right" },
): FixedPopoverPosition | null {
  const { width: preferredWidth, align = "left" } = options;
  const [position, setPosition] = useState<FixedPopoverPosition | null>(null);

  useIsoLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const measure = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const width = Math.max(0, Math.min(preferredWidth, window.innerWidth - VIEWPORT_MARGIN * 2));
      const top = rect.bottom + ANCHOR_GAP;
      const wantedLeft = align === "right" ? rect.right - width : rect.left;
      const left = Math.min(
        Math.max(wantedLeft, VIEWPORT_MARGIN),
        Math.max(VIEWPORT_MARGIN, window.innerWidth - VIEWPORT_MARGIN - width),
      );
      const maxHeight = Math.max(
        0,
        (window.visualViewport?.height ?? window.innerHeight) - top - VIEWPORT_MARGIN,
      );
      setPosition((current) => (
        current && current.top === top && current.left === left
          && current.width === width && current.maxHeight === maxHeight
          ? current
          : { top, left, width, maxHeight }
      ));
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
    };
  }, [anchorRef, align, open, preferredWidth]);

  return position;
}
