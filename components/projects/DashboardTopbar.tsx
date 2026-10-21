"use client";

import { Pressable } from "@/components/motion/Pressable";
import { Skeleton } from "@/components/motion/Skeleton";
import { useI18n } from "@/hooks/useI18n";

/**
 * The dashboard header: title, counts, and the create button.
 *
 * Counts are derived from the list the parent already holds. Asking the server
 * again for "9 projects" would be a second answer that could disagree with the
 * cards on screen.
 *
 * ### The counts are not shown before they are known
 *
 * `GET /api/projects` measures folder sizes synchronously and can take up to
 * 30 seconds (`lib/project-size.ts`). Until it answers, `projectCount` is not
 * a count of zero — it is no count at all, and the line used to say
 * "0 projects · 0 chats" for the whole wait. That reads as "this board is
 * empty", which is a different statement from "this board is still loading".
 *
 * So `loading` replaces the line with a bar of the same height (13px, the
 * measured height of the text it stands in for). The header does not change
 * size between the two states, so nothing below it moves when the numbers
 * arrive.
 */
export function DashboardTopbar({
  projectCount,
  chatCount,
  onNewProject,
  canCreate,
  loading = false,
}: {
  projectCount: number;
  chatCount: number;
  onNewProject: () => void;
  /**
   * False for a tenant. Creating a project widens the allow-list, which is an
   * operator decision (`AGENTS.md`: `allowFileRoot` is admin-gated), so the
   * button is not offered to an account that cannot use it.
   */
  canCreate: boolean;
  /** The registry has not answered yet. */
  loading?: boolean;
}) {
  const { t } = useI18n();

  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "20px 24px 12px",
      }}
    >
      <div>
        <h1 style={{ margin: 0, fontSize: 19, fontWeight: 650, color: "var(--text)" }}>
          {t("projects.title")}
        </h1>
        {loading ? (
          // Wrapped in an inline-flex span on purpose: a bare block-level
          // placeholder collapses the line box and the header loses 8px, so
          // everything below it would move up and then back down. Measured:
          // the text gives 81.5px, a block child 73.5px, this wrapper 81.5px.
          <span style={{ fontSize: 12, display: "inline-flex", alignItems: "center" }}>
            <Skeleton width={124} height={13} />
          </span>
        ) : (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {t("projects.subtitle", { count: projectCount, chats: chatCount })}
          </span>
        )}
      </div>

      <div style={{ flex: 1 }} />

      {canCreate ? (
        <Pressable
          onClick={onNewProject}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            padding: "7px 13px",
            fontSize: 12,
            fontWeight: 550,
            borderRadius: 8,
            cursor: "pointer",
            border: "1px solid var(--accent)",
            background: "var(--accent)",
            color: "var(--bg)",
            fontFamily: "inherit",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          {t("projects.new")}
        </Pressable>
      ) : null}
    </header>
  );
}