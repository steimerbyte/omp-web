"use client";

import { Skeleton } from "@/components/motion/Skeleton";
import { useI18n } from "@/hooks/useI18n";
import { PROJECT_CARD_HEIGHT, ProjectCard } from "./ProjectCard";
import { PRIORITY_IDS, type PriorityColorValue, type PriorityDef, type ProjectView } from "@/lib/projects-schema";

/**
 * The card grid, in ONE place.
 *
 * The real grid and the loading skeleton both lay their cards out with this
 * string. It was two rules until 2026-10-21: the skeleton asked for a fixed
 * `repeat(3, minmax(0, 1fr))` while the real grid asked for the auto-fill
 * below, so the two could not agree about the column count. Measured at
 * 390x844: three 106px placeholder columns, then one 342px card column. At
 * 1440x900: three 369px placeholder columns, then four 274px ones. Thirty
 * seconds of the endpoint measuring folder sizes, and then the board jumped.
 *
 * `auto-fill` rather than `auto-fit` on purpose: `auto-fit` collapses the
 * empty tracks, so a group with two cards in a four-column grid would stretch
 * those two across the whole width and the cards would change size with the
 * number of projects in their group.
 */
const CARD_GRID_TEMPLATE = "repeat(auto-fill, minmax(258px, 1fr))";

/**
 * The gap between two cards, and between a group header and its cards.
 *
 * Both grids, for the same reason as `CARD_GRID_TEMPLATE`: two numbers that
 * can drift apart are two numbers that will.
 */
const CARD_GRID_GAP = 12;
const GROUP_GAP = 11;
const GROUP_HEADER_HEIGHT = 19.5;

/**
 * The height of one card.
 *
 * Not declared here. It is `PROJECT_CARD_HEIGHT` from `ProjectCard.tsx`, the
 * card that actually has that height, so the placeholder reserves the box the
 * card declares rather than a number copied out of a comment — and
 * `components/projects/ProjectCard.path-order.test.mjs` holds the two to
 * the same value.
 */
const CARD_HEIGHT = PROJECT_CARD_HEIGHT;

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
          <section key={id} style={{ display: "flex", flexDirection: "column", gap: GROUP_GAP }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                minHeight: GROUP_HEADER_HEIGHT,
              }}
            >
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
                gridTemplateColumns: CARD_GRID_TEMPLATE,
                gap: CARD_GRID_GAP,
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
 * Blocks rather than a spinner, because the answer's shape is known: a grid of
 * cards, one group per priority. Every dimension here comes from the same
 * constants the real grid uses — the column rule, the gap, the group header
 * height and the card height — so the placeholder stands where the cards
 * will stand.
 *
 * ### What that costs, honestly
 *
 * What it does NOT know is how many groups there will be: `priorities` is
 * empty until the same response that brings the projects arrives. The board
 * therefore shows `rows` groups while loading and up to five afterwards, and
 * the content below the first group grows. The *first* group is the part that
 * does not move — its header, its grid and its first card land on the same
 * pixels — and that is what a user staring at a thirty-second wait is looking
 * at. Anything past the first group moves because the answer was longer than
 * the placeholder, not because the two disagreed about a rule.
 *
 * The endpoint needs up to 30 seconds (`lib/project-size.ts` measures folder
 * sizes synchronously), so this state is not a blink. It is the board.
 */
export function ProjectGridSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} style={{ display: "flex", flexDirection: "column", gap: GROUP_GAP }}>
          <Skeleton width={140} height={GROUP_HEADER_HEIGHT} />
          <div
            style={{
              display: "grid",
              // the real grid's rule, not a column count of its own
              gridTemplateColumns: CARD_GRID_TEMPLATE,
              gap: CARD_GRID_GAP,
            }}
          >
            {/* `minmax(258px, 1fr)` decides how many of these fit; the number
                is only "enough to fill the widest board", because a grid track
                beyond the last card stays empty either way. */}
            {Array.from({ length: 4 }, (_, column) => (
              <Skeleton key={column} height={CARD_HEIGHT} radius={10} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
