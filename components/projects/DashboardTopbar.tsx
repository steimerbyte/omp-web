"use client";

import { Pressable } from "@/components/motion/Pressable";
import { useI18n } from "@/hooks/useI18n";

/**
 * The dashboard header: title, counts, and the create button.
 *
 * Counts are derived from the list the parent already holds. Asking the server
 * again for "9 projects" would be a second answer that could disagree with
 * the cards on screen.
 */
export function DashboardTopbar({
  projectCount,
  chatCount,
  onNewProject,
  canCreate,
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
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {t("projects.subtitle", { count: projectCount, chats: chatCount })}
        </span>
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