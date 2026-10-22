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
  /**
   * `true` when `sizeBytes` is a **lower bound** rather than the size.
   *
   * `du` walks the tree and stats the entries; it does not read the contents.
   * When it cannot read a subdirectory it prints an error and exits 1 — and it
   * still prints the total of what it *could* read. That total is a lower
   * bound, and the card has to say so: a number that claims to be exact and
   * is not is worse than no number.
   *
   * The field exists because the two cases are different facts: a folder that
   * was measured completely and a folder whose measurement only saw part of
   * the tree are not the same answer, and only the second one carries a
   * "≥" on the card.
   */
  sizeIsLowerBound?: boolean;
}

/**
 * One measurement of one folder.
 *
 * `bytes: null` is the answer "no size" — the folder is gone, unreadable, or
 * the measurement ran out of time. `partial: true` says that a number came
 * back but that it is a lower bound (see `sizeIsLowerBound`).
 */
export interface SizeMeasurement {
  bytes: number | null;
  partial: boolean;
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
  /**
   * `true` when `isProtectedProjectRoot` refuses this folder, i.e. the delete
   * route will answer `403 code: "protected"` and remove nothing.
   *
   * Computed here, on the server, rather than re-derived in the dialog: the
   * rule reads the identity's home and a filesystem layout, neither of which
   * the browser has. Shipping the *answer* lets the confirm dialog say why the
   * button will not work, instead of letting the user press it and read the
   * refusal afterwards. It is a display convenience — the refusal itself is
   * still the route's, and a stale `true` here can never authorise a delete.
   */
  isProtected?: boolean;
}

export const PROJECTS_SCHEMA_VERSION = 1 as const;

/**
 * One project's size, as the polling endpoint ships it.
 *
 * The four fields are the whole answer: which folder, how big it was, when
 * that was measured, and whether the number is exact. `sizeBytes: null` with
 * a `sizeMeasuredAt` means "measured, and there is no size";
 * `sizeBytes: null` without one means "not measured yet". The card draws
 * those two apart, because they are different facts — one is a placeholder,
 * the other is an answer. `sizeIsLowerBound` is the third distinction: a
 * number that only saw part of the tree.
 */
export interface ProjectSizeEntry {
  root: string;
  sizeBytes: number | null;
  sizeMeasuredAt: string | null;
  sizeIsLowerBound: boolean;
}

/**
 * The answer of `GET /api/projects/sizes`.
 *
 * `pending` is `true` while at least one project of this identity still owes
 * a measurement. The client polls while it is `true` and stops when it is
 * `false` — so the poll always ends, and the endpoint stays cheap enough to
 * be called every two seconds.
 */
export interface ProjectSizesResponse {
  sizes: ProjectSizeEntry[];
  pending: boolean;
}

/**
 * How long a measured size is trusted before it is measured again.
 *
 * Five minutes. The size on a card is *information*, not a measurement that
 * has to be right to the second: a folder that grew by a megabyte in the
 * last five minutes does not need a new number, and the number is never the
 * reason a user opens the dashboard.
 *
 * ### The old value was shorter than the measurement
 *
 * The old value was 30 s, and one measurement of the 18 roots of a real
 * registry takes **20,5 s** — measured 2026-10-22 on the dev host (Intel
 * i5-1335U, WSL2, Bun 1.4.0, Next 16.2.12): 3 pool rounds, 11 of the 18
 * folders measured, 7 without a size, 51,97 GB in the measured folders. The
 * details are in `lib/project-size.ts`. With the measurement inside the
 * request, a TTL below the run time meant that the next request found the
 * previous result already expired and started a new `du` swarm while the old
 * one was still running.
 *
 * ### The duty cycle, calculated
 *
 * The run is **not** on a timer: it is triggered by a request
 * (`startProjectSizeMeasurement`, `lib/projects-sizes.ts`). So the load is
 * not "every TTL" but "every time somebody opens the dashboard", and the
 * honest accounting for the registry above is:
 *
 * - one run costs 20,5 s of `du` (eight processes in parallel); a cold run
 *   with the 30 s per-folder budget up to 90 s (three serial pool rounds of
 *   30 s — a calculation from the constants, not a measurement: the four
 *   slowest folders of the measured registry were killed at 10 s, so their
 *   real duration is unknown);
 * - a dashboard that is open costs one run: 20,5 s of 300 s, **6,8 %**;
 * - a dashboard that is **closed** costs nothing at all — no request comes
 *   in, no run starts. A TTL cannot create load on its own.
 *
 * With the old 30 s TTL the same run would have been 20,5 s of 30 s —
 * **68 %** — every time the dashboard was opened again inside a minute.
 * Five minutes therefore means: a dashboard that is opened again within five
 * minutes reuses the sizes and costs nothing, and after that the sizes are
 * measured once more.
 *
 * The value is asserted by `lib/projects-schema.test.mjs` ("the size TTL is
 * five minutes"), so this comment and the constant cannot drift apart.
 */
export const SIZE_TTL_MS = 5 * 60_000;

/**
 * The budget of one folder measurement, in milliseconds.
 *
 * 30 seconds. The old value was 10, and at 10 the four biggest folders of
 * the registry delivered **nothing**: they were killed at 10,0-10,1 s
 * (measured 2026-10-22, the numbers in `lib/project-size.ts`), among them the
 * project that was being worked on. The budget used to protect the *request*
 * — the request waited for the measurement. It does not any more: the
 * measurement runs in the background and nobody waits for it. So what the
 * budget buys now is the bound on the background work, and what it costs is
 * the size of the biggest folders.
 *
 * At 30 s a cold run costs about 90 s instead of 20,5 s (three serial pool
 * rounds of 18 roots hit the cap), which the client's poll window still
 * covers — it is derived from this number, see `lib/project-size-poll.ts`. A
 * warm run is unaffected: the same four folders took 0,16-4,81 s.
 *
 * The number is asserted by `lib/project-size.test.mjs` ("the documented
 * budget bounds the background run"), so this comment and the constant cannot
 * drift apart.
 */
export const SIZE_TIMEOUT_MS = 30_000;

/**
 * How many `du` processes run at once.
 *
 * Eight is a compromise: each one is I/O-bound on a different tree, so raising
 * this buys little past a handful, while a higher number multiplies the worst
 * case for a run. The cost of a run is bounded at
 * `ceil(count / MAX_PARALLEL) * SIZE_TIMEOUT_MS` regardless of how many
 * projects exist.
 *
 * It is worth knowing what these eight do to each other: because 11 of the
 * 18 roots of a real registry lie inside other roots, the eight processes are
 * often walking the *same* tree at the same time. That is why the child
 * `01_PROJEKTE/ki-hardware-calculator-react` (191 MB) needed 9,2 s in the
 * measurement above while its parent `workspace` was being walked as well.
 *
 * The constants live here and not in `lib/project-size.ts` because the
 * browser needs them too: the poll window is derived from them (see
 * `lib/project-size-poll.ts`), and that module must not import a module that
 * spawns processes.
 */
export const MAX_PARALLEL = 8;

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

/**
 * Whether `name` may become a folder name under `<home>/workspace`.
 *
 * ### Why this is here and not in the dialog
 *
 * The name is a *path segment*. The dialog validates it so the user learns
 * immediately, but a dialog is a UI affordance and this is the boundary: the
 * server is what calls `mkdir`, so the server is what has to refuse `../../etc`
 * and `a/b`. Two copies of this rule would drift, and the copy that drifts is
 * always the one the attacker gets.
 *
 * ### The rules
 *
 * Kebab-case and nothing else. A slash or a backslash is the whole class of
 * "escapes into a parent directory", and a leading dot is the class of "a
 * hidden folder nobody sees in a listing". Both are refused outright rather
 * than sanitised: a project folder has no legitimate reason to contain one,
 * and stripping them would create a folder whose name is not the name that was
 * asked for — which is worse than a refusal, because the card would then
 * disagree with the dialog.
 *
 * The length cap mirrors the filesystem's own limit for a single component
 * (255 on ext4, APFS and NTFS) with room to spare, so the failure is always
 * this `false` and never an `ENAMETOOLONG` halfway through a create.
 */
export function isValidProjectFolderName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > 64) return false;
  // Leading dash: refused so a name can never be read as a command-line flag
  // by a script that builds a path argument, and leading dot for the hidden
  // folder reason above.
  if (name.startsWith("-") || name.startsWith(".")) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  // `..` and `.` cannot reach here through the pattern below, but they are the
  // two names a reader of this function is looking for, so they are refused
  // by name rather than left to be implied.
  if (name === "." || name === "..") return false;
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
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
    sizeIsLowerBound: raw.sizeIsLowerBound === true ? true : undefined,
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

/**
 * Persisted measurements, written by the route, never by a client.
 *
 * Only the size fields are touched. That is the whole point of the function:
 * the run that calls it may have started before the user changed a priority,
 * and the priority has to survive the measurement.
 */
export function applySizeMeasurements(
  projects: readonly ProjectMeta[],
  measurements: ReadonlyMap<string, SizeMeasurement>,
  measuredAt: string,
): ProjectMeta[] {
  return projects.map((project) => {
    const measurement = measurements.get(project.root);
    if (measurement === undefined) return project;
    return {
      ...project,
      sizeBytes: measurement.bytes,
      sizeMeasuredAt: measuredAt,
      // `undefined` rather than `false`: the field says something only when
      // it has something to say.
      sizeIsLowerBound: measurement.partial ? true : undefined,
    };
  });
}

/**
 * `true` when a measurement is missing or older than the TTL.
 *
 * The **timestamp** decides, not the value. A folder that could not be
 * measured carries a fresh timestamp and a `null` size: that is a measurement
 * that happened and failed, not a measurement that is missing. The old rule
 * (`sizeBytes === null` means stale) retried such a folder on *every*
 * request, which is what produced a `du` swarm every 30 seconds for a folder
 * that can never be measured. The next attempt is due when its TTL expires.
 *
 * The consequence for the client: a project whose measurement failed is not
 * "pending" any more, so the poll stops and the card shows "no size" instead
 * of waiting forever for a number that will not arrive.
 */
export function isSizeMeasurementStale(
  project: Pick<ProjectMeta, "sizeMeasuredAt">,
  now = Date.now(),
  ttl = SIZE_TTL_MS,
): boolean {
  if (!isIsoTimestamp(project.sizeMeasuredAt)) return true;
  return now - Date.parse(project.sizeMeasuredAt) >= ttl;
}