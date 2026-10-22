"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Reveal } from "@/components/motion/Reveal";
import { useI18n } from "@/hooks/useI18n";
import { useProjectSizes } from "@/hooks/useProjectSizes";
import { ConfirmDialog } from "./projects/ConfirmDialog";
import { DashboardTopbar } from "./projects/DashboardTopbar";
import { NewProjectDialog } from "./projects/NewProjectDialog";
import { PriorityFilterBar } from "./projects/PriorityFilterBar";
import { ProjectGrid, ProjectGridSkeleton } from "./projects/ProjectGrid";
import { encodeFilePathForApi } from "@/lib/file-paths";
import type { PriorityDef, PriorityId, ProjectSizeEntry, ProjectView } from "@/lib/projects-schema";

/**
 * The projects dashboard.
 *
 * ### The only place that fetches
 *
 * `ProjectGrid`, `ProjectCard` and both dialogs are server-deaf: they take
 * finished props and render. That is what keeps the delete state coherent — a
 * card cannot show a folder the grid has already dropped, because they read the
 * same array.
 *
 * ### Delete
 *
 * The confirm dialog is a convenience. The protection is server-side in
 * `DELETE /api/projects/[...root]`: a protected folder comes back with
 * `code: "protected"` and nothing was deleted. A failure anywhere in that route
 * leaves the folder and its chats untouched, and the message says so rather
 * than pretending the folder is gone.
 *
 * The card is removed only *after* the server confirmed it. Optimistic removal
 * would be the one wrong move here: the user would see the project gone while
 * the folder, and everything in it, was still there.
 */
export function ProjectsDashboard({
  onOpenProject,
  isAdmin,
}: {
  /** Hand a folder to the shell — the sidebar treats it like any other cwd. */
  onOpenProject: (root: string) => void;
  isAdmin: boolean;
}) {
  const { t } = useI18n();

  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [priorities, setPriorities] = useState<PriorityDef[]>([]);
  const [home, setHome] = useState<string>("");
  const [error, setError] = useState(false);
  const [activePriority, setActivePriority] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ProjectView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/projects", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return (await response.json()) as {
          projects: ProjectView[];
          priorities: PriorityDef[];
          home: string;
        };
      })
      .then((data) => {
        if (cancelled) return;
        setProjects(data.projects);
        setPriorities(data.priorities);
        setHome(data.home);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Put the sizes the poll brought onto the cards.
   *
   * Only the two size fields are written. The priority, the counter, the
   * status and the name stay exactly as they were, and a project whose sizes
   * did not change keeps its object identity — so React does not redraw its
   * card at all. That is what keeps the cursor where the user put it: the
   * board is not re-fetched, and a card that has nothing to do with the sizes
   * is not touched.
   */
  const applySizes = useCallback((sizes: ProjectSizeEntry[]) => {
    setProjects((current) => {
      if (current === null) return current;
      const byRoot = new Map(sizes.map((size) => [size.root, size]));
      let changed = false;
      const next = current.map((project) => {
        const size = byRoot.get(project.root);
        if (size === undefined) return project;
        const sizeBytes = size.sizeBytes;
        const sizeMeasuredAt = size.sizeMeasuredAt ?? undefined;
        if (
          (project.sizeBytes ?? null) === sizeBytes &&
          (project.sizeMeasuredAt ?? null) === (size.sizeMeasuredAt ?? null)
        ) {
          return project;
        }
        changed = true;
        return { ...project, sizeBytes, sizeMeasuredAt };
      });
      return changed ? next : current;
    });
  }, []);

  // The poll starts once the board is there: the sizes have cards to land on
  // from the first poll on. It ends by itself when the server says the
  // answer is final, and the hook's cleanup stops it when the dashboard goes
  // away. The project count goes with it: the poll window has to outlast the
  // measurement, and the worst case of that measurement grows with the number
  // of projects (`lib/project-size-poll.ts`).
  const restartSizePolling = useProjectSizes(
    applySizes,
    projects !== null,
    projects?.length ?? 0,
  );

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const project of projects ?? []) {
      map.set(project.priority, (map.get(project.priority) ?? 0) + 1);
    }
    return map;
  }, [projects]);

  const visible = useMemo(() => {
    if (!projects) return [];
    const needle = query.trim().toLowerCase();
    return projects.filter((project) => {
      if (activePriority !== null && project.priority !== activePriority) return false;
      if (needle === "") return true;
      return project.name.toLowerCase().includes(needle) || project.root.toLowerCase().includes(needle);
    });
  }, [projects, activePriority, query]);

  const chatCount = useMemo(
    () => (projects ?? []).reduce((sum, project) => sum + project.chatCount, 0),
    [projects],
  );

  /**
   * Persist one counter change.
   *
   * Optimistic, because a counter that lags a click reads as a broken control.
   * A failed save is left to the next reload rather than patched here: guessing
   * a value to roll back to would be a second, wrong answer.
   */
  const handleTodosChange = useCallback((root: string, openTodos: number) => {
    setProjects((current) =>
      current === null
        ? current
        : current.map((project) => (project.root === root ? { ...project, openTodos } : project)),
    );
    void fetch("/api/projects", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projects: [{ root, openTodos }] }),
    }).catch(() => setError(true));
  }, []);

  const confirmDelete = useCallback(async () => {
    if (pendingDelete === null) return;
    const target = pendingDelete;
    setDeleting(true);
    setNotice(null);
    try {
      const encoded = encodeFilePathForApi(target.root);
      // The chat count travels with the request. `DELETE /api/projects/…`
      // refuses a folder with many chats until the caller repeats the number it
      // showed the user, and a boolean "confirmed" could not tell "the user saw
      // 3" from "the folder holds 130" — which is the 2026-10-20 incident in
      // one line. Below the threshold this header is simply ignored.
      const headers: Record<string, string> = {};
      if (target.chatCount > 0) headers["x-omp-delete-confirm"] = String(target.chatCount);
      const response = await fetch(`/api/projects/${encoded}`, { method: "DELETE", headers });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { code?: string };
        // `protected` and a failed chat deletion both mean the folder is still
        // there. Say that, and keep the card.
        setNotice(
          body.code === "protected" ? t("projects.delete.protected") : t("projects.delete.failed"),
        );
        setDeleting(false);
        return;
      }
      setProjects((current) =>
        current === null ? current : current.filter((project) => project.root !== target.root),
      );
      setPendingDelete(null);
      setDeleting(false);
    } catch {
      setNotice(t("projects.delete.failed"));
      setDeleting(false);
    }
  }, [pendingDelete, t]);

  const createProject = useCallback(
    async (input: { name: string; priority: PriorityId; initGit: boolean }) => {
      setCreating(true);
      setNotice(null);
      try {
        const response = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!response.ok) {
          setNotice(t("projects.create.failed"));
          setCreating(false);
          return;
        }
        setShowNew(false);
        setCreating(false);
        // Re-read the board rather than patching one card in: the new project
        // has attributes only a fresh GET knows.
        const refreshed = await fetch("/api/projects", { cache: "no-store" }).then((res) =>
          res.ok ? res.json() : null,
        );
        if (refreshed) {
          setProjects(refreshed.projects);
          setPriorities(refreshed.priorities);
        }
        // The new folder owes a measurement, and a poll cycle that has
        // already ended would leave its card waiting for a number that never
        // comes. The restart asks the sizes endpoint, which starts the
        // measurement.
        restartSizePolling();
      } catch {
        setNotice(t("projects.create.failed"));
        setCreating(false);
      }
    },
    [t, restartSizePolling],
  );

  return (
    <div
      // Stable hook for "which view is mounted" assertions — a view test that
      // greps for visible text cannot tell this apart from the sidebar's own
      // "Search projects & sessions" filter.
      data-projects-dashboard=""
      style={{ height: "100%", overflowY: "auto", display: "flex", flexDirection: "column" }}
    >
      <DashboardTopbar
        projectCount={projects?.length ?? 0}
        chatCount={chatCount}
        canCreate={isAdmin}
        loading={projects === null}
        onNewProject={() => setShowNew(true)}
      />

      <div style={{ padding: "0 24px 10px" }}>
        {notice ? (
          <Reveal
            role="alert"
            style={{
              fontSize: 12,
              color: "var(--danger)",
              background: "var(--bg-panel)",
              border: "1px solid var(--danger)",
              borderRadius: 7,
              padding: "7px 11px",
              marginBottom: 10,
            }}
          >
            {notice}
          </Reveal>
        ) : null}

        {error ? (
          <Reveal role="alert" style={{ fontSize: 12, color: "var(--danger)", padding: "7px 0" }}>
            {t("projects.error")}
          </Reveal>
        ) : null}

        <PriorityFilterBar
          priorities={priorities}
          activeId={activePriority}
          onActiveChange={setActivePriority}
          query={query}
          onQueryChange={setQuery}
          counts={counts}
          loading={projects === null}
        />
      </div>

      <div style={{ padding: "4px 24px 28px", flex: 1 }}>
        {projects === null && !error ? (
          <ProjectGridSkeleton />
        ) : (
          <ProjectGrid
            projects={visible}
            priorities={priorities}
            onTodosChange={handleTodosChange}
            onOpen={(project) => onOpenProject(project.root)}
            onDelete={(project) => {
              setNotice(null);
              setPendingDelete(project);
            }}
          />
        )}
      </div>

      {pendingDelete ? (
        <ConfirmDialog
          project={pendingDelete}
          busy={deleting}
          onConfirm={confirmDelete}
          onCancel={() => {
            if (!deleting) setPendingDelete(null);
          }}
        />
      ) : null}

      {showNew ? (
        <NewProjectDialog
          home={home}
          priorities={priorities}
          busy={creating}
          onSubmit={createProject}
          onCancel={() => {
            if (!creating) setShowNew(false);
          }}
        />
      ) : null}
    </div>
  );
}