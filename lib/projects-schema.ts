/**
 * The shape of the projects dashboard registry, and the validation of it.
 *
 * This module deliberately has no `fs` and no `fetch`, so the browser bundle
 * and the route share one validation. Same rule, same reason, as
 * `lib/quick-phrases.ts`: a second copy of the rules is a second answer.
 *
 * It lives outside `~/.omp/agent/config.yml` on purpose. That file is omp
 * configuration and omp reads it; a dashboard registry is a tool's own state.
 * The `omp-web-` prefix says so at directory-listing distance.
 *
 * ### Why a project is a folder, not a git repository
 *
 * `resolveProject()` (`lib/worktree.ts:102-108`) derives a project from
 * `git rev-parse --git-common-dir`, so all worktrees of a repo share one
 * `projectRoot` and a non-git directory becomes its own project. That is the
 * right model for *where a session belongs*. It cannot express "delete this
 * project deletes this folder", because a git repository spans several folders
 * and `removeWorktree` refuses the main checkout outright. So the folder is the
 * identity here, git is only an attribute of it.
 */

/**
 * The five categories, in the order they sort in. Fixed order: the order *is*
 * the sort, and a category list that can be freely reordered would make
 * "where does this go?" a question on every single card.
 *
 * Freely renameable, not freely creatable. A freely creatable list raises the
 * classification question again the moment it is used ("is 'Kunde Meier' a
 * priority or a status?"), and the dashboard stops being a statement about
 * what matters.
 */
export const PRIORITY_IDS = ["now", "important", "later", "done", "parked"] as const;

export type PriorityId = (typeof PRIORITY_IDS)[number];

/**
 * The traffic light. Kept deliberately independent of `PriorityId`:
 * priority answers *how important*, status answers *how is it going*. They are
 * two axes, and both on one card is only readable because they are drawn
 * apart — a 3px rail on the left, a dot on the status line.
 */
export type ProjectStatus = "green" | "yellow" | "red";

/**
 * A colour as the *value* of a CSS custom property, e.g. `"var(--danger)"`.
 *
 * Named `PriorityColorValue`, not `...Token`, because these are not token
 * names but ready-made CSS values. A "token" is `--danger`; this is the value
 * written into `--status-color`.
 *
 * Nothing outside this union may reach a card. `applyOmpPalette` rewrites the
 * custom properties at runtime, so a literal hex would survive every theme
 * change and break every imported theme with it.
 */
export type PriorityColorValue =
  | "var(--danger)"
  | "var(--warning)"
  | "var(--accent)"
  | "var(--success)"
  | "var(--text-dim)";

/** One category. `name` is per account, `colorValue` is constrained to the theme. */
export interface PriorityDef {
  id: PriorityId;
  name: string;
  colorValue: PriorityColorValue;
}

/**
 * One folder, as the dashboard stores it.
 *
 * The split between stored and derived fields is the point of this interface:
 * a field that can be recomputed must not be stored, because a stored one goes
 * stale and a stale one is worse than a missing one. `chatCount`, `branch`,
 * `lastSessionAt` and `name` are therefore computed per request and live in
 * `ProjectView`, not here.
 */
export interface ProjectMeta {
  /** Absolute path — the primary key. */
  root: string;
  priority: PriorityId;
  /**
   * A counter, not a list. Deliberately settable to 0 without deleting
   * anything: the number is a note to self, and "0" is a decision.
   */
  openTodos: number;
  status: ProjectStatus;
  /** ISO timestamp. */
  createdAt: string;
  /**
   * When this folder was last touched *on purpose*.
   *
   * Kept apart from the derived `lastSessionAt` because `session.modified`
   * moves as soon as a chat runs in the folder — a project you work in daily
   * with no chat for months would read "3 months ago". The card shows the
   * later of the two.
   */
  lastTouchedAt: string;
  /** Adopted from the existing session list rather than created deliberately. */
  adopted?: boolean;
  /** Folder size in bytes. `null` = not measurable right now (see `lib/project-size.ts`). */
  sizeBytes?: number | null;
  /** ISO timestamp of the last successful measurement, for the TTL. */
  sizeMeasuredAt?: string;
}

/** The on-disk file. One per account, one object. */
export interface ProjectsFile {
  schemaVersion: 1;
  projects: ProjectMeta[];
  priorities: PriorityDef[];
}

/**
 * What the route hands to the dashboard: stored metadata plus everything
 * derivable from the session list, joined.
 */
export interface ProjectView extends ProjectMeta {
  /** `basename(root)` — the card's title. */
  name: string;
  chatCount: number;
  /** `max(session.modified)` over the project's sessions, or `null`. */
  lastSessionAt: string | null;
  isGit: boolean;
  branch: string | null;
  /** The later of `lastTouchedAt` and `lastSessionAt`. */
  lastActivityAt: string;
}

export const PROJECTS_SCHEMA_VERSION = 1 as const;

/** How long a measured size is trusted before it is measured again. */
export const SIZE_TTL_MS = 30_000;

/**
 * The defaults, in sort order. These are the `en` strings — there is no `de`
 * bundle, and the per-account `priorities` array is what a user actually
 * renames.
 */
export const DEFAULT_PRIORITIES: readonly PriorityDef[] = [
  { id: "now", name: "Sofort", colorValue: "var(--danger)" },
  { id: "important", name: "Wichtig", colorValue: "var(--warning)" },
  { id: "later", name: "Nice to have", colorValue: "var(--accent)" },
  { id: "done", name: "Erledigt", colorValue: "var(--success)" },
  { id: "parked", name: "Unwichtig", colorValue: "var(--text-dim)" },
];

/** Static membership tables. `Record`, because nothing is ever inserted at runtime. */
const PRIORITY_IDS_BY_VALUE: Record<string, true> = {
  now: true,
  important: true,
  later: true,
  done: true,
  parked: true,
};

const COLOR_VALUES_BY_VALUE: Record<string, true> = {
  "var(--danger)": true,
  "var(--warning)": true,
  "var(--accent)": true,
  "var(--success)": true,
  "var(--text-dim)": true,
};

const STATUSES_BY_VALUE: Record<string, true> = {
  green: true,
  yellow: true,
  red: true,
};

/** `true` for one of the five fixed ids. */
export function isPriorityId(value: unknown): value is PriorityId {
  return typeof value === "string" && PRIORITY_IDS_BY_VALUE[value] === true;
}

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === "string" && STATUSES_BY_VALUE[value] === true;
}

/**
 * A colour value from the theme, or nothing.
 *
 * This is the gate that keeps a hex literal out of the registry. A persisted
 * `#ff0000` would survive `applyOmpPalette` and then render as a colour that
 * belongs to no theme — so the value is not sanitized on the way in, it is
 * refused.
 */
export function isPriorityColorValue(value: unknown): value is PriorityColorValue {
  return typeof value === "string" && COLOR_VALUES_BY_VALUE[value] === true;
}

/** A non-negative integer. Rejects `NaN`, `-1`, `1.5` and `"3"`. */
export function isTodoCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** An ISO-ish timestamp the store will accept: parseable by `Date`. */
export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  return Number.isFinite(Date.parse(value));
}

/**
 * Keep a path usable as a registry key: absolute, normalized, no traversal.
 *
 * The normalization matters more than it looks. `<home>/workspace/../Documents`
 * and `<home>/Documents` are the same folder, and a registry holding both
 * would show two cards for one folder — and the second one is the protected
 * one. Normalizing at the boundary means every later comparison sees one
 * spelling.
 */
export function normalizeProjectRoot(root: string): string | null {
  if (typeof root !== "string" || root.trim() === "") return null;
  const trimmed = root.trim();
  if (!trimmed.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(trimmed)) return null;
  const unified = trimmed.replace(/\\/g, "/");
  // Collapse `.`/`..` textually. The path is normalized here rather than
  // realpath-resolved on purpose: a registry entry for a folder that does not
  // exist yet must still have a stable key, and realpath would throw.
  const isAbsolute = unified.startsWith("/");
  const segments: string[] = [];
  for (const segment of unified.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join("/");
  return isAbsolute ? `/${joined}` : joined;
}

/** The card title for a root. Never empty: a `/` root falls back to the full path. */
export function projectDisplayName(root: string): string {
  const normalized = normalizeProjectRoot(root) ?? root;
  const segments = normalized.split("/").filter((segment) => segment !== "");
  return segments.length > 0 ? segments[segments.length - 1] : normalized;
}

/**
 * One project as the store will keep it, or `null` if it is not one.
 *
 * Returns `null` rather than a repaired object. A stored field that was
 * quietly defaulted on the way in is a field the user believes they set.
 */
export function normalizeProjectMeta(value: unknown, now = new Date()): ProjectMeta | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;

  const root = normalizeProjectRoot(raw.root as string);
  if (root === null) return null;

  const createdAt = isIsoTimestamp(raw.createdAt) ? raw.createdAt : now.toISOString();
  const lastTouchedAt = isIsoTimestamp(raw.lastTouchedAt) ? raw.lastTouchedAt : createdAt;

  const sizeBytes =
    typeof raw.sizeBytes === "number" && Number.isFinite(raw.sizeBytes) && raw.sizeBytes >= 0
      ? Math.floor(raw.sizeBytes)
      : null;

  return {
    root,
    priority: isPriorityId(raw.priority) ? raw.priority : "parked",
    openTodos: isTodoCount(raw.openTodos) ? raw.openTodos : 0,
    status: isProjectStatus(raw.status) ? raw.status : "yellow",
    createdAt,
    lastTouchedAt,
    adopted: raw.adopted === true ? true : undefined,
    sizeBytes,
    sizeMeasuredAt: isIsoTimestamp(raw.sizeMeasuredAt) ? raw.sizeMeasuredAt : undefined,
  };
}

/**
 * One category as the store will keep it, or `null`.
 *
 * A category with an unknown `id` is refused rather than dropped-and-renamed:
 * the five ids are the sort order, so inventing one would mean inventing a
 * place in it.
 */
export function normalizePriorityDef(value: unknown, fallbackId?: PriorityId): PriorityDef | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const id = isPriorityId(raw.id) ? raw.id : fallbackId;
  if (id === undefined) return null;
  const fallback = DEFAULT_PRIORITIES.find((entry) => entry.id === id);
  const name = typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : fallback?.name ?? id;
  const colorValue = isPriorityColorValue(raw.colorValue) ? raw.colorValue : fallback?.colorValue ?? "var(--text-dim)";
  return { id, name, colorValue };
}

/**
 * The stored file as the store will keep it.
 *
 * `unknownInput` is whatever came off disk. A corrupt file yields the
 * defaults with `exists: true` — never the defaults *as if nothing had been
 * there*. Seeding over unreadable state would overwrite work the user cannot
 * see and therefore cannot defend; the empty list is what gets shown, and the
 * store does not pretend the file is missing.
 */
export function normalizeProjectsFile(input: unknown): ProjectsFile {
  const source = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};

  const rawProjects = Array.isArray(source.projects) ? source.projects : [];
  const seen = new Set<string>();
  const projects: ProjectMeta[] = [];
  for (const entry of rawProjects) {
    const project = normalizeProjectMeta(entry);
    // Two entries for one folder would show two cards for one folder, and
    // `last one wins` would make which one wins depend on array order.
    if (project === null || seen.has(project.root)) continue;
    seen.add(project.root);
    projects.push(project);
  }

  const rawPriorities = Array.isArray(source.priorities) ? source.priorities : [];
  const priorities: PriorityDef[] = [];
  const claimed = new Set<string>();
  for (const entry of rawPriorities) {
    const priority = normalizePriorityDef(entry);
    if (priority === null || claimed.has(priority.id)) continue;
    claimed.add(priority.id);
    priorities.push(priority);
  }
  // Every id is present, always. A missing category would have no row to sort
  // into and no name to show on its cards. The default is used verbatim rather
  // than routed back through `normalizePriorityDef`, which has no object to
  // read and would reject every one of them.
  for (const fallback of DEFAULT_PRIORITIES) {
    if (claimed.has(fallback.id)) continue;
    claimed.add(fallback.id);
    priorities.push({ ...fallback });
  }
  priorities.sort((a, b) => PRIORITY_IDS.indexOf(a.id) - PRIORITY_IDS.indexOf(b.id));

  return { schemaVersion: PROJECTS_SCHEMA_VERSION, projects, priorities };
}

/** Sort a list of views by category order, then by activity (newest first). */
export function sortProjectViews<T extends Pick<ProjectView, "priority" | "lastActivityAt">>(
  views: readonly T[],
): T[] {
  return [...views].sort((a, b) => {
    const byPriority = PRIORITY_IDS.indexOf(a.priority) - PRIORITY_IDS.indexOf(b.priority);
    if (byPriority !== 0) return byPriority;
    return b.lastActivityAt.localeCompare(a.lastActivityAt);
  });
}

/**
 * The fields a client is allowed to change.
 *
 * `root`, `createdAt`, `adopted`, `sizeBytes` and `sizeMeasuredAt` are
 * deliberately absent. `root` is the key: a client that could write it could
 * attach its metadata to somebody else's folder, and the delete path trusts
 * this registry to name what it may remove.
 */
export interface ProjectMetaPatch {
  root: string;
  priority: PriorityId;
  openTodos: number;
  status: ProjectStatus;
  lastTouchedAt: string;
}

export interface PriorityDefPatch {
  id: PriorityId;
  name: string;
}

/**
 * Take a client body and merge it into the stored state.
 *
 * This is a merge and not a replace, and the reason is `root`: the client
 * sends what it believes, and the server keeps everything it owns. A `PUT`
 * that replaced the array would let a request delete projects by omission and
 * rewrite a `root` by inclusion.
 */
export function mergeProjectPatches(
  stored: readonly ProjectMeta[],
  body: unknown,
): { ok: true; patches: ProjectMetaPatch[] } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || !("projects" in body)) {
    return { ok: false, error: "body must be an object with a projects array" };
  }
  const rawProjects = (body as Record<string, unknown>).projects;
  if (!Array.isArray(rawProjects)) {
    return { ok: false, error: "projects must be an array" };
  }

  const known = new Map(stored.map((project) => [project.root, project]));
  const seen = new Set<string>();
  const patches: ProjectMetaPatch[] = [];

  for (const entry of rawProjects) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, error: "each project must be an object" };
    }
    const raw = entry as Record<string, unknown>;
    const root = normalizeProjectRoot(raw.root as string);
    if (root === null) return { ok: false, error: "each project needs an absolute root" };
    if (seen.has(root)) return { ok: false, error: `duplicate project root: ${root}` };
    seen.add(root);

    // Unknown roots are ignored rather than inserted. Inserting one would let
    // a client write into the registry a folder that was never added through
    // the create route, and therefore never allowlisted.
    const existing = known.get(root);
    if (!existing) continue;

    patches.push({
      root,
      priority: isPriorityId(raw.priority) ? raw.priority : existing.priority,
      openTodos: isTodoCount(raw.openTodos) ? raw.openTodos : existing.openTodos,
      status: isProjectStatus(raw.status) ? raw.status : existing.status,
      lastTouchedAt: isIsoTimestamp(raw.lastTouchedAt) ? raw.lastTouchedAt : existing.lastTouchedAt,
    });
  }

  return { ok: true, patches };
}

/**
 * Take a client body and merge it into the stored categories.
 *
 * Same merge, same reason: `id` and `colorValue` are the store's. A client may
 * rename a category — that is the whole feature — but not repaint one or
 * reorder the list.
 */
export function mergePriorityPatches(
  stored: readonly PriorityDef[],
  body: unknown,
): PriorityDef[] {
  const raw =
    typeof body === "object" && body !== null && "priorities" in body
      ? (body as Record<string, unknown>).priorities
      : undefined;
  const byId = new Map<string, unknown>();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const id = (entry as Record<string, unknown>).id;
      if (!isPriorityId(id)) continue;
      byId.set(id, entry);
    }
  }

  return stored.map((priority) => {
    const entry = byId.get(priority.id) as Record<string, unknown> | undefined;
    if (!entry) return priority;
    const name = entry.name;
    return {
      ...priority,
      name: typeof name === "string" && name.trim() !== "" ? name.trim() : priority.name,
    };
  });
}

/** Apply patches to the stored projects, returning what should be written. */
export function applyProjectPatches(
  stored: readonly ProjectMeta[],
  patches: readonly ProjectMetaPatch[],
): ProjectMeta[] {
  const byRoot = new Map(patches.map((patch) => [patch.root, patch]));
  return stored.map((project) => {
    const patch = byRoot.get(project.root);
    if (!patch) return project;
    return {
      ...project,
      priority: patch.priority,
      openTodos: patch.openTodos,
      status: patch.status,
      lastTouchedAt: patch.lastTouchedAt,
    };
  });
}

/** Persisted measurements, written by the route, never by a client. */
export function applySizeMeasurements(
  projects: readonly ProjectMeta[],
  measurements: ReadonlyMap<string, number | null>,
  measuredAt: string,
): ProjectMeta[] {
  return projects.map((project) => {
    if (!measurements.has(project.root)) return project;
    const sizeBytes = measurements.get(project.root) ?? null;
    return { ...project, sizeBytes, sizeMeasuredAt: measuredAt };
  });
}

/** `true` when a measurement is older than the TTL and should be retaken. */
export function isSizeMeasurementStale(
  project: Pick<ProjectMeta, "sizeBytes" | "sizeMeasuredAt">,
  now = Date.now(),
  ttl = SIZE_TTL_MS,
): boolean {
  if (project.sizeBytes === null || project.sizeBytes === undefined) return true;
  if (!isIsoTimestamp(project.sizeMeasuredAt)) return true;
  return now - Date.parse(project.sizeMeasuredAt) >= ttl;
}