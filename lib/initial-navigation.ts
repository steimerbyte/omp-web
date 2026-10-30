export interface InitialNavigation {
  requestedCwd: string | null;
  sessionId: string | null;
  /**
   * `?view=projects` — which view the URL asks for on first paint.
   *
   * `projects`, `calendar` and `scheduled` are meaningful; every other value
   * falls back to `chat`,
   * because an unknown view name in a URL must not be able to select one. The
   * dashboard is a real URL rather than component state so a reload, a
   * bookmark and a shared link all land on the same view.
   */
  requestedView: "chat" | "projects" | "calendar" | "scheduled";
}

export function getInitialNavigation(searchParams: Pick<URLSearchParams, "get">): InitialNavigation {
  const requestedCwd = searchParams.get("cwd")?.trim() || null;
  const view = searchParams.get("view")?.trim();

  return {
    requestedCwd,
    sessionId: requestedCwd ? null : searchParams.get("session"),
    // `calendar` ist die dritte Ansicht. Sie wird ausdruecklich genannt und
    // nicht aus dem Rest abgeleitet: ein unbekannter Name darf keine
    // Ansicht waehlen.
    requestedView:
      view === "projects" ? "projects"
        : view === "calendar" ? "calendar"
          : view === "scheduled" ? "scheduled"
            : "chat",
  };
}
