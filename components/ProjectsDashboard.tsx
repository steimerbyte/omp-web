"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Reveal } from "@/components/motion/Reveal";
import { useI18n } from "@/hooks/useI18n";
import { ConfirmDialog } from "./projects/ConfirmDialog";
import { DashboardTopbar } from "./projects/DashboardTopbar";
import { NewProjectDialog } from "./projects/NewProjectDialog";
import { PriorityFilterBar } from "./projects/PriorityFilterBar";
import { ProjectGrid, ProjectGridSkeleton } from "./projects/ProjectGrid";
import type { PriorityDef, PriorityId, ProjectView } from "@/lib/projects-schema";

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
 * `DELETE /api/projects/[root]`: a protected folder comes back with
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
      const encoded = target.root.split("/").filter(Boolean).map(encodeURIComponent).join("/");
      const response = await fetch(`/api/projects/${encoded}`, { method: "DELETE" });
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
        // has a size only a fresh GET knows, and a value that arrives on a
        // later request is exactly the deferred answer this design rejected.
        const refreshed = await fetch("/api/projects", { cache: "no-store" }).then((res) =>
          res.ok ? res.json() : null,
        );
        if (refreshed) {
          setProjects(refreshed.projects);
          setPriorities(refreshed.priorities);
        }
      } catch {
        setNotice(t("projects.create.failed"));
        setCreating(false);
      }
    },
    [t],
  );

  return (
    <div style={{ height: "100%", overflowY: "auto", display: "flex", flexDirection: "column" }}>
      <DashboardTopbar
        projectCount={projects?.length ?? 0}
        chatCount={chatCount}
        canCreate={isAdmin}
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