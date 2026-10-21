"use client";

import { Pressable } from "@/components/motion/Pressable";
import { Skeleton } from "@/components/motion/Skeleton";
import { useI18n } from "@/hooks/useI18n";
import styles from "./PriorityFilterBar.module.css";
import {
  DEFAULT_PRIORITIES,
  PRIORITY_IDS,
  type PriorityDef,
  type PriorityColorValue,
} from "@/lib/projects-schema";

/**
 * The width a count occupies, in pixels.
 *
 * A count is one or two digits, and "0" is narrower than "18". Left to itself
 * each chip would be as wide as its own number, so the strip would re-flow
 * every time a count changed — filtering by a category, or the numbers
 * arriving, would make the chips slide sideways under the reader's finger.
 *
 * It does NOT decide the bar's height any more. That is the strip's job (see
 * the `loading` prop); this only keeps the widths still.
 */
const COUNT_SLOT = 16;

/**
 * Category chips plus a search field.
 *
 * Filtering is client-side over the already-loaded list: the whole dashboard is
 * one `GET`, and filtering a list of folders in memory cannot get out of sync
 * with what the server said. A server-side filter would only add a second
 * request and a second way for the two answers to disagree.
 */
export function PriorityFilterBar({
  priorities,
  activeId,
  onActiveChange,
  query,
  onQueryChange,
  counts,
  loading = false,
}: {
  priorities: readonly PriorityDef[];
  /** `null` = the "All" chip. */
  activeId: string | null;
  onActiveChange: (id: string | null) => void;
  query: string;
  onQueryChange: (value: string) => void;
  counts: ReadonlyMap<string, number>;
  /**
   * The registry has not answered yet.
   *
   * While loading, every category is rendered: the project counts are not known
   * yet, so there is nothing to leave out. Once the counts are in, a category
   * with no projects is not rendered at all.
   *
   * That difference used to move the bar, and the bar used to move everything
   * under it. It no longer does, and not because the missing chips keep a slot:
   * they do not. The bar is `flex-wrap: nowrap` and the chips sit in a strip
   * that scrolls sideways when they do not fit, so the bar is exactly one line
   * tall whatever the counts say, and nothing below it moves. Measured
   * 2026-10-21 at 390x844, 320x800, 768x1024 and 1440x900 with one, three and
   * five categories in use: the bar's height, the search field's position and
   * the first card's position identical in all twelve combinations, and the
   * bar 38px where the wrapping version took 114px.
   */
  loading?: boolean;
}) {
  const { t } = useI18n();
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        /* `nowrap`, not `wrap`. The bar is one line whatever the data says,
           which is the whole property: the chips cannot take a second row, so
           there is nothing to reserve and nothing to jump. When the categories
           do not fit they scroll sideways inside the strip instead.

           Measured 2026-10-21, the wrapping version: the chips went from one
           row to two when the categories arrived and the first card moved down
           with them — 38px at 390x844 and 38px at 768x1024, where the chat
           column is narrower and the chips wrap sooner. */
        flexWrap: "nowrap",
      }}
    >
      <div className={styles.strip} style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Chip active={activeId === null} onClick={() => onActiveChange(null)}>
          {t("projects.filter.all")} <Count loading={loading} value={total} />
        </Chip>

        {PRIORITY_IDS.map((id) => {
          const priority = priorities.find((entry) => entry.id === id);
          const count = counts.get(id) ?? 0;
          /* A category with no projects is not rendered at all. That used to
             change the row count — the defect this strip removes — and it no
             longer can, because the strip is one line and scrolls. Reserving a
             slot for it instead would trade the jump for a permanent gap. */
          if (count === 0 && !loading) return null;
          const def = priority ?? DEFAULT_PRIORITIES.find((entry) => entry.id === id);
          return (
            <Chip
              key={id}
              active={activeId === id}
              onClick={() => onActiveChange(id)}
              colorValue={def?.colorValue as PriorityColorValue | undefined}
            >
              {def?.name ?? id} <Count loading={loading} value={count} />
            </Chip>
          );
        })}
      </div>

      <input
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder={t("projects.search")}
        aria-label={t("projects.search")}
        style={{
          marginLeft: "auto",
          flexShrink: 0,
          minWidth: 190,
          padding: "6px 10px",
          fontSize: 12,
          color: "var(--text)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 7,
          outline: "none",
          fontFamily: "inherit",
        }}
      />
    </div>
  );
}

/**
 * The number inside a chip, or a placeholder of the same size.
 *
 * One fixed slot, always, so a chip is the same width whether it holds "0" or
 * "18" and whether the number is there or still loading. Without it the strip
 * would re-flow whenever a count changed.
 *
 * The bar's height does not depend on this: the strip is one line and scrolls
 * (see the `loading` prop). This only keeps the widths still.
 */
function Count({ loading, value }: { loading: boolean; value: number }) {
  return (
    <span
      style={{
        opacity: 0.7,
        display: "inline-block",
        width: COUNT_SLOT,
        textAlign: "right",
      }}
    >
      {loading ? <Skeleton width={COUNT_SLOT} height={11} /> : value}
    </span>
  );
}

function Chip({
  active,
  onClick,
  children,
  colorValue,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  colorValue?: PriorityColorValue;
}) {
  return (
    <Pressable
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        /* The strip scrolls, so a chip is never squeezed to fit. */
        flexShrink: 0,
        whiteSpace: "nowrap",
        padding: "5px 11px",
        fontSize: 12,
        borderRadius: 999,
        cursor: "pointer",
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
        background: active ? "var(--bg-hover)" : "var(--bg)",
        color: active ? "var(--text)" : "var(--text-muted)",
        fontFamily: "inherit",
      }}
    >
      {/* The dot is the theme variable, never a literal — `applyOmpPalette`
          rewrites these at runtime. */}
      {colorValue ? (
        <span
          aria-hidden="true"
          style={{ width: 6, height: 6, borderRadius: "50%", background: colorValue, flexShrink: 0 }}
        />
      ) : null}
      {children}
    </Pressable>
  );
}