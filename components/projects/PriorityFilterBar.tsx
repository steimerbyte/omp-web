"use client";

import { Pressable } from "@/components/motion/Pressable";
import { useI18n } from "@/hooks/useI18n";
import { PRIORITY_IDS, type PriorityDef, type PriorityColorValue } from "@/lib/projects-schema";

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
}: {
  priorities: readonly PriorityDef[];
  /** `null` = the "All" chip. */
  activeId: string | null;
  onActiveChange: (id: string | null) => void;
  query: string;
  onQueryChange: (value: string) => void;
  counts: ReadonlyMap<string, number>;
}) {
  const { t } = useI18n();
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <Chip active={activeId === null} onClick={() => onActiveChange(null)}>
        {t("projects.filter.all")} <span style={{ opacity: 0.7 }}>{total}</span>
      </Chip>

      {PRIORITY_IDS.map((id) => {
        const priority = priorities.find((entry) => entry.id === id);
        const count = counts.get(id) ?? 0;
        if (count === 0) return null;
        return (
          <Chip
            key={id}
            active={activeId === id}
            onClick={() => onActiveChange(id)}
            colorValue={priority?.colorValue as PriorityColorValue | undefined}
          >
            {priority?.name ?? id} <span style={{ opacity: 0.7 }}>{count}</span>
          </Chip>
        );
      })}

      <input
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder={t("projects.search")}
        aria-label={t("projects.search")}
        style={{
          marginLeft: "auto",
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