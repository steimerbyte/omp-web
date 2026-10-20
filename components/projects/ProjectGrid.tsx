"use client";

import { Skeleton } from "@/components/motion/Skeleton";
import { useI18n } from "@/hooks/useI18n";
import { ProjectCard } from "./ProjectCard";
import { PRIORITY_IDS, type PriorityColorValue, type PriorityDef, type ProjectView } from "@/lib/projects-schema";

/**
 * The card grid, grouped by category.
 *
 * Server-deaf: it receives finished `ProjectView` objects and renders them. It
 * fetches nothing and owns no data, which is what lets the whole dashboard
 * reload from one place and keeps every card a pure function of its props.
 *
 * The grouping follows `PRIORITY_IDS`, not the order the array happens to
 * arrive in — the order *is* the taxonomy, and a server that returned them
 * shuffled must not reshuffle the user's screen.
 *
 * ### Why there is no second, sidebar-shaped list here
 *
 * An earlier draft exported a `ProjectListRow` for a "by urgency" list in the
 * session sidebar. It was never rendered anywhere, and it is gone rather than
 * wired up: the sidebar has its own project list built from the session list,
 * not from this registry, so a second entry point would need the projects
 * again — a second `GET /api/projects`, a second load state, and a second
 * answer to "which projects exist" that could disagree with the dashboard's.
 * The categories are visible as the dashboard's own sections instead.
 */
export function ProjectGrid({
  projects,
  priorities,
  onTodosChange,
  onOpen,
  onDelete,
}: {
  projects: readonly ProjectView[];
  priorities: readonly PriorityDef[];
  onTodosChange: (root: string, openTodos: number) => void;
  onOpen: (project: ProjectView) => void;
  onDelete: (project: ProjectView) => void;
}) {
  const { t } = useI18n();

  if (projects.length === 0) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: "60px 24px",
          color: "var(--text-muted)",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 15, color: "var(--text)" }}>{t("projects.empty")}</div>
        <div style={{ fontSize: 13 }}>{t("projects.emptyHint")}</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
      {PRIORITY_IDS.map((id) => {
        const group = projects.filter((project) => project.priority === id);
        if (group.length === 0) return null;
        const priority = priorities.find((entry) => entry.id === id);

        return (
          <section key={id} style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span
                aria-hidden="true"
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: priority?.colorValue ?? "var(--text-dim)",
                  flexShrink: 0,
                }}
              />
              <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                {priority?.name ?? id}
              </h2>
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                {group.length === 1 ? "1" : group.length}
              </span>
              <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(258px, 1fr))",
                gap: 12,
              }}
            >
              {group.map((project) => (
                <ProjectCard
                  key={project.root}
                  project={project}
                  priorityColor={(priority?.colorValue ?? "var(--text-dim)") as PriorityColorValue}
                  priorityName={priority?.name ?? id}
                  onTodosChange={onTodosChange}
                  onOpen={onOpen}
                  onDelete={onDelete}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/**
 * The loading placeholder.
 *
 * `Skeleton` blocks rather than a spinner because the shape of the answer is
 * known — a grid of cards — and the layout should not jump when the real cards
 * arrive.
 */
export function ProjectGridSkeleton({ rows = 2, columns = 3 }: { rows?: number; columns?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} style={{ display: "flex", flexDirection: "column", gap: 11 }}>
          <Skeleton width={140} height={13} />
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              gap: 12,
            }}
          >
            {Array.from({ length: columns }, (_, column) => (
              <Skeleton key={column} height={172} radius={10} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
