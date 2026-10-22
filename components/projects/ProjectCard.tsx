"use client";

import { Enter } from "@/components/motion/Enter";
import { Pressable } from "@/components/motion/Pressable";
import { useI18n } from "@/hooks/useI18n";
import type { TranslationParams } from "@/lib/i18n/types";
import { TodoStepper } from "./TodoStepper";
import { SIZE_TTL_MS, type PriorityColorValue, type ProjectView } from "@/lib/projects-schema";

/** The translator `useI18n()` hands out, for helpers that format outside JSX. */
type Translate = (key: string, params?: TranslationParams) => string;

/**
 * The height of one card, in pixels.
 *
 * It lives here rather than in `ProjectGrid` because the card is what has
 * this height: `ProjectGridSkeleton` imports it to reserve the same box, so
 * the placeholder and the card cannot drift apart by construction rather
 * than by agreement.
 *
 * `minHeight`, not `height`. Every row inside the card is `white-space:
 * nowrap`, so the natural height is the same at every viewport — measured
 * 2026-10-21 at 320x800, 390x844, 768x1024 and 1440x900: 191px, all four.
 * A floor reserves that box and still lets a card grow if its content ever
 * needs more, which a fixed height would clip.
 */
export const PROJECT_CARD_HEIGHT = 191;

/**
 * One project card.
 *
 * ### The status rail, and why it is a rail
 *
 * The status is drawn as a 3px bar on the left edge, not as a tinted card.
 * That is variant B of the prototype and it is deliberate: a 4-card row of
 * background tints reads as noise rather than as status, and the tint also
 * competes with the priority dot on the same card. A rail is legible at a
 * glance and leaves the card itself neutral.
 *
 * Priority and status stay two separate signals, on purpose. Priority sorts
 * the cards; status says how the work is going. Collapsing them into one
 * colour would mean a project could not be important *and* blocked.
 *
 * ### Colours
 *
 * `--status-color` and `--prio-color` are set from the `PriorityColorValue`
 * union, which contains only `var(--…)` references. No literal colour appears
 * here: `applyOmpPalette` rewrites those custom properties at runtime, so a
 * hard-coded hex would survive every theme switch and break every imported
 * theme with it.
 */
export function ProjectCard({
  project,
  priorityColor,
  priorityName,
  onTodosChange,
  onOpen,
  onDelete,
}: {
  project: ProjectView;
  priorityColor: PriorityColorValue;
  /**
   * The category name as the *registry* holds it (`priorities[].name`).
   *
   * Not an i18n lookup: a category is renamed per account, so the name is
   * account data. The i18n bundles carry only the first-run fallback that
   * `DEFAULT_PRIORITIES` writes, and the dashboard shows whichever the
   * account actually has.
   */
  priorityName: string;
  onTodosChange: (root: string, openTodos: number) => void;
  onOpen: (project: ProjectView) => void;
  onDelete: (project: ProjectView) => void;
}) {
  const { t } = useI18n();

  // Status → theme token. The status names a condition, not a colour, so the
  // mapping is explicit rather than an index into the priority union.
  const statusColor: PriorityColorValue =
    project.status === "red"
      ? "var(--danger)"
      : project.status === "yellow"
        ? "var(--warning)"
        : "var(--success)";

  const statusLabel =
    project.status === "red"
      ? t("projects.status.red")
      : project.status === "yellow"
        ? t("projects.status.yellow")
        : t("projects.status.green");

  const sizeAge = sizeAgeLabel(t, project.sizeMeasuredAt);
  const sizeLabel =
    sizeAge === null
      ? t("projects.metric.size")
      : t("projects.metric.sizeWithAge", { age: sizeAge });
  // The tooltip explains the "≥": the number is what `du` could read, not
  // necessarily the whole folder.
  const sizeTitle = project.sizeIsLowerBound ? t("projects.sizeLowerBound") : undefined;

  return (
    <Enter
      direction="up"
      style={
        {
          "--status-color": statusColor,
          "--prio-color": priorityColor,
          position: "relative",
          overflow: "hidden",
          borderRadius: 10,
          border: "1px solid var(--border)",
          background: "var(--bg)",
          padding: "14px 14px 12px 17px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          minWidth: 0,
          minHeight: PROJECT_CARD_HEIGHT,
        } as React.CSSProperties
      }
      className="omp-project-card"
    >
      {/* The status rail. Painted from the custom property, so it follows the
          theme exactly as the rest of the card does. */}
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          background: "var(--status-color)",
        }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <FolderIcon />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: 600,
              fontSize: 14,
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={project.name}
          >
            {project.name}
          </div>
        </div>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11,
            color: "var(--text-muted)",
            flexShrink: 0,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--prio-color)",
            }}
          />
          {priorityName}
        </span>
      </div>

      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--text-dim)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          direction: "rtl",
          textAlign: "left",
        }}
        title={project.root}
      >
        {/* `direction: rtl` above is what makes the *truncation* happen at the
            start, so the informative end of the path stays visible. It also
            flips the bidi order of the text inside — measured on 2026-10-21,
            the leading "/" was painted at the END of every card, and the path
            read "home/steimerbyte/workspace/omp-web/".

            The `<bdi>` puts the path back into its own left-to-right isolate,
            so the glyphs keep their order while the container still clips at
            the start. A LEFT-TO-RIGHT MARK (U+200E) prefix does the same, but
            that is an invisible character in the source that also ends up in
            anything copied out of the card. See
            `components/projects/ProjectCard.path-order.test.mjs` for what holds
            this in place. */}
        <bdi dir="ltr">{project.root}</bdi>
      </div>

      <div style={{ display: "flex", gap: 18, alignItems: "baseline" }}>
        <Metric label={t("projects.metric.todos")}>
          <TodoStepper
            value={project.openTodos}
            onChange={(next) => onTodosChange(project.root, Math.max(0, next))}
          />
        </Metric>
        <Metric label={sizeLabel}>
          <span
            style={{
              fontVariantNumeric: "tabular-nums",
              // The waiting state is a placeholder, not a value: it is dimmer
              // than the two states that carry information.
              color: project.sizeBytes === null || project.sizeBytes === undefined
                ? "var(--text-dim)"
                : "var(--text)",
            }}
            title={sizeTitle}
          >
            {/* Three different facts, three different answers. A folder that
                has not been measured *yet* is waiting for a number that will
                come (the measurement runs in the background,
                `lib/projects-sizes.ts`); a folder whose measurement *failed*
                has no size, and no number will ever come for it; a folder
                whose measurement only saw part of the tree has a number that
                is a lower bound, and the "≥" says so. The first two are both
                `sizeBytes === null`, so the timestamp is what tells them
                apart. */}
            {formatSize(project.sizeBytes) === null
              ? (project.sizeMeasuredAt ? t("projects.sizeUnknown") : t("projects.sizePending"))
              : project.sizeIsLowerBound
                ? t("projects.sizeAtLeast", { size: formatSize(project.sizeBytes) ?? "" })
                : formatSize(project.sizeBytes)}
          </span>
        </Metric>
        <Metric label={t("projects.metric.last")}>
          <span>{relativeTime(t, project.lastActivityAt)}</span>
        </Metric>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-muted)" }}>
        <span
          aria-hidden="true"
          style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--status-color)", flexShrink: 0 }}
        />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {/* The traffic light has no free-text note; the status itself is the
              message. A project with no git repo says so, because that is a
              fact about the folder rather than a state the user chose. */}
          {project.isGit ? statusLabel : t("projects.noRepo")}
        </span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 11,
          color: "var(--text-dim)",
          borderTop: "1px solid var(--border)",
          paddingTop: 9,
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0 }}>
          {project.branch ? (
            <>
              <BranchIcon />
              <span
                style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 130 }}
              >
                {project.branch}
              </span>
            </>
          ) : (
            <span>{t("projects.noRepo")}</span>
          )}
        </span>
        <span style={{ marginLeft: "auto", flexShrink: 0 }}>
          {project.chatCount === 1 ? t("projects.oneChat") : t("projects.chats", { n: project.chatCount })}
        </span>
        <CardAction
          label={t("projects.open")}
          onClick={() => onOpen(project)}
          icon={<OpenIcon />}
        />
        <CardAction
          label={t("projects.delete")}
          onClick={() => onDelete(project)}
          icon={<TrashIcon />}
          danger
        />
      </div>
    </Enter>
  );
}

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      {/* The label carries the age of the size measurement now and then. It
          must not wrap: a second line would push the card past
          `PROJECT_CARD_HEIGHT`, and that height is a constant the grid and
          the skeleton both reserve. */}
      <span
        style={{
          fontSize: 10,
          color: "var(--text-dim)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 12, color: "var(--text)", whiteSpace: "nowrap" }}>{children}</span>
    </div>
  );
}

function CardAction({
  label,
  onClick,
  icon,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <Pressable
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{
        width: 24,
        height: 24,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 6,
        border: "1px solid var(--border)",
        background: "var(--bg)",
        color: danger ? "var(--danger)" : "var(--text-muted)",
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      {icon}
    </Pressable>
  );
}

/**
 * Bytes as a short human string.
 *
 * `null` stays `null` and is rendered as the "unavailable" label by the caller:
 * an unmeasured folder must not render as `0 B`, which would claim the disk
 * was inspected and found empty.
 */
function formatSize(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * The age of the size measurement, or `null` while it is still fresh.
 *
 * The poll ends when the server says the answer is final
 * (`lib/project-size-poll.ts`), so the number on the card is the number of
 * the last measurement — and on a dashboard that stays open it gets older
 * without anything changing on the screen. A number that is silently hours
 * old reads as the current state, so the card says how old it is once it is
 * older than the TTL.
 */
function sizeAgeLabel(t: Translate, measuredAt: string | undefined): string | null {
  if (measuredAt === undefined) return null;
  if (Date.now() - Date.parse(measuredAt) < SIZE_TTL_MS) return null;
  return relativeTime(t, measuredAt);
}

/**
 * Coarse relative time. Deliberately not a date: the card answers "since
 * when", not "when".
 *
 * Formatted through `t()` rather than concatenated here — a hard-coded German
 * string would show up unchanged on a Chinese dashboard.
 */
function relativeTime(t: Translate, iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return t("projects.time.justNow");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("projects.time.minutes", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("projects.time.hours", { n: hours });
  const days = Math.round(hours / 24);
  if (days === 1) return t("projects.time.yesterday");
  if (days < 30) return t("projects.time.days", { n: days });
  const months = Math.round(days / 30);
  if (months < 12) return t("projects.time.months", { n: months });
  const years = Math.round(months / 12);
  return years === 1 ? t("projects.time.year") : t("projects.time.years", { n: years });
}

function FolderIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)", flexShrink: 0 }}>
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ flexShrink: 0 }}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12" />
    </svg>
  );
}

function OpenIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0 }}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6M10 14L21 3" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0 }}>
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
    </svg>
  );
}