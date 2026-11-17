"use client";

import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import styles from "./SearchableSelect.module.css";
import { computePopupPlacement, preferredPopupHeight } from "@/lib/popup-placement";
import { Enter } from "./motion/Enter";
import { Pressable } from "./motion/Pressable";

export interface SearchableSelectOption {
  value: string;
  label: string;
  description?: string;
  searchText?: string;
  disabled?: boolean;
}

interface SearchableSelectProps {
  value: string;
  options: readonly SearchableSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  noResultsLabel?: string;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
}

const POPOVER_GAP_PX = 5;
const POPOVER_MAX_HEIGHT_PX = 296;
/** Height of the search row above the option list. */
const POPOVER_CHROME_PX = 46;
/** Schmalster Popover: das Suchfeld braucht Platz fuer ein paar Zeichen. */
const POPOVER_MIN_WIDTH_PX = 240;
const POPOVER_EDGE_PX = 8;

/**
 * Der naechste Vorfahr, der seine Kinder abschneidet, mit seinem Sichtfenster
 * in Viewport-Koordinaten.
 *
 * Beide Aufrufer stellen das Feld in einen scrollenden Bereich
 * (`SettingsConfig` `.scrollContent`, `ModelsConfig`-Liste). Ein absolut
 * positioniertes Popover wird dort abgeschnitten, sobald der Ausloeser nah am
 * Rand dieses Bereichs steht — die Platzierung am *Viewport* misst dann den
 * falschen Platz. Ein Portal waere hier keine Loesung: es verlaesst den
 * modalen Dialog (Radix schliesst bei Klick daneben, `pointer-events` am Body
 * steht auf `none`).
 */
function clipRectFor(element: HTMLElement | null): { top: number; bottom: number; left: number; right: number } | null {
  for (let node = element?.parentElement ?? null; node && node !== document.body; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) {
      return node.getBoundingClientRect();
    }
  }
  return null;
}

interface PopoverPlacement {
  side: "above" | "below";
  maxHeight: number;
  /** Breite und Abstand zum rechten Rand des Ausloesers (rechtsbuendig). */
  width: number;
  right: number;
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
}

export function SearchableSelect({
  value,
  options,
  onChange,
  disabled = false,
  placeholder = "Select…",
  searchPlaceholder = "Search options…",
  noResultsLabel = "No matching options",
  ariaLabel,
  className,
  style,
}: SearchableSelectProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listboxId = useId();
  const selected = options.find((option) => option.value === value);
  const [placement, setPlacement] = useState<PopoverPlacement>({
    side: "below",
    maxHeight: POPOVER_MAX_HEIGHT_PX,
    width: POPOVER_MIN_WIDTH_PX,
    right: 0,
  });
  const filtered = useMemo(() => {
    const needle = normalize(query.trim());
    if (!needle) return options;
    return options.filter((option) => normalize(`${option.label} ${option.value} ${option.searchText ?? ""}`).includes(needle));
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const selectedIndex = filtered.findIndex((option) => option.value === value && !option.disabled);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : Math.max(0, filtered.findIndex((option) => !option.disabled)));
  }, [filtered, open, value]);

  useEffect(() => {
    if (activeIndex >= filtered.length || filtered[activeIndex]?.disabled) {
      setActiveIndex(Math.max(0, filtered.findIndex((option) => !option.disabled)));
    }
  }, [activeIndex, filtered]);

  // Arrow keys must be able to walk past the visible slice, otherwise the last
  // options of a long list can only be reached by scrolling with the mouse.
  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  // The trigger can sit near the bottom of a scrollable settings panel, where
  // a list opening downwards runs past the dialog and the viewport. Gemessen
  // wird deshalb am Ausloeser und *innerhalb* des abschneidenden Vorfahren,
  // nicht am Viewport; neu bei Fenster- und Ansichtswechsel sowie bei jedem
  // Scroll (auch in inneren Bereichen).
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const root = rootRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      const viewportWidth = window.visualViewport?.width || window.innerWidth || document.documentElement?.clientWidth || 1024;
      const viewportHeight = window.visualViewport?.height || window.innerHeight || document.documentElement?.clientHeight || 768;
      const clip = clipRectFor(root);
      const visibleTop = Math.max(0, clip?.top ?? 0);
      const visibleBottom = Math.min(viewportHeight, clip?.bottom ?? viewportHeight);
      const visibleLeft = Math.max(0, clip?.left ?? 0);
      const visibleRight = Math.min(viewportWidth, clip?.right ?? viewportWidth);
      const visibleHeight = Math.max(0, visibleBottom - visibleTop);
      const visibleWidth = Math.max(0, visibleRight - visibleLeft);
      const { side, maxHeight } = computePopupPlacement(
        rect.top - visibleTop,
        rect.bottom - visibleTop,
        visibleHeight,
        preferredPopupHeight(visibleHeight, 0.6, POPOVER_MAX_HEIGHT_PX),
        // Innerhalb eines abschneidenden Bereichs zaehlt nur dessen Platz:
        // die Mindesthoehe der gemeinsamen Rechnung wuerde den Rand sonst
        // ueberlaufen und genau wieder abgeschnitten.
        { gap: POPOVER_GAP_PX, prefer: "below", minHeight: clip ? 0 : 160 },
      );
      // Rechtsbuendig am Feld; weicht nach links aus, wenn der Bereich dort
      // endet. `right` ist der Abstand zum rechten Rand des Ausloesers.
      const width = Math.min(Math.max(rect.width, POPOVER_MIN_WIDTH_PX), Math.max(0, visibleWidth - POPOVER_EDGE_PX * 2));
      const right = Math.max(0, rect.right - (visibleRight - POPOVER_EDGE_PX));
      setPlacement((current) => (
        current.side === side && current.maxHeight === maxHeight && current.width === width && current.right === right
          ? current
          : { side, maxHeight, width, right }
      ));
    };
    measure();
    const observer = rootRef.current ? new ResizeObserver(measure) : null;
    if (rootRef.current && observer) observer.observe(rootRef.current);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
    };
  }, [open]);

  const choose = (option: SearchableSelectOption) => {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
  };

  const moveActive = (direction: 1 | -1) => {
    if (!filtered.length) return;
    let next = activeIndex;
    for (let count = 0; count < filtered.length; count += 1) {
      next = (next + direction + filtered.length) % filtered.length;
      if (!filtered[next].disabled) {
        setActiveIndex(next);
        return;
      }
    }
  };

  const handleListKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = filtered[activeIndex];
      if (option) choose(option);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className={`${styles.root}${className ? ` ${className}` : ""}`} style={style}>
      <Pressable
        tint
        type="button"
        className={styles.trigger}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className={selected ? styles.value : styles.placeholder}>{selected?.label ?? (value || placeholder)}</span>
        <svg className={styles.chevron} viewBox="0 0 12 12" aria-hidden="true">
          <path d="m3 4.5 3 3 3-3" />
        </svg>
      </Pressable>

      {open && (
        <Enter
          direction={placement.side === "above" ? "down" : "up"}
          className={styles.popover}
          style={{
            right: placement.right,
            width: placement.width,
            maxHeight: placement.maxHeight,
            ...(placement.side === "above"
              ? { bottom: `calc(100% + ${POPOVER_GAP_PX}px)` }
              : { top: `calc(100% + ${POPOVER_GAP_PX}px)` }),
          }}
        >
          <div className={styles.searchWrap}>
            <svg className={styles.searchIcon} viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="7" cy="7" r="4.25" />
              <path d="m10.2 10.2 3.1 3.1" />
            </svg>
            <input
              ref={inputRef}
              className={styles.search}
              value={query}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              role="combobox"
              aria-expanded="true"
              aria-controls={listboxId}
              aria-activedescendant={filtered[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleListKeys}
            />
          </div>
          <div
            id={listboxId}
            className={styles.options}
            role="listbox"
            aria-label={ariaLabel}
            style={{ maxHeight: Math.max(0, placement.maxHeight - POPOVER_CHROME_PX) }}
          >
            {filtered.length ? filtered.map((option, index) => (
              <Pressable
                ref={(node) => { optionRefs.current[index] = node; }}
                id={`${listboxId}-${index}`}
                type="button"
                role="option"
                aria-selected={option.value === value}
                key={option.value}
                className={styles.option}
                data-active={index === activeIndex}
                data-selected={option.value === value}
                disabled={option.disabled}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(option)}
              >
                <span className={styles.optionCopy}>
                  <span className={styles.optionLabel}>{option.label}</span>
                  {option.description && <span className={styles.optionDescription}>{option.description}</span>}
                </span>
                {option.value === value && (
                  <svg className={styles.check} viewBox="0 0 12 12" aria-hidden="true">
                    <path d="m2.3 6.2 2.2 2.2 5.2-5.2" />
                  </svg>
                )}
              </Pressable>
            )) : <div className={styles.empty}>{noResultsLabel}</div>}
          </div>
        </Enter>
      )}
    </div>
  );
}
