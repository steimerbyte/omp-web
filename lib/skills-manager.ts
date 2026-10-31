import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { cfgSkillsCustomDirectories } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import type { ResourceDiagnostic, UserSkill, UserSkillResponse, UserSkillsResponse } from "./api-types";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { getSettingsForIdentity } from "./omp-runtime";
import { isPathWithinRoots } from "./path-security";
import { getUserHome, isAdminIdentity, type WebIdentity } from "./request-identity";
import { ensureTenantAgentDir } from "./tenant-config";

/**
 * The caller's own skill store: `<agent dir>/skills/<name>/SKILL.md`.
 *
 * ### Why this module exists instead of reusing `/api/files`
 *
 * `PUT /api/files` works for every path below the identity's writable roots,
 * but `POST`/`DELETE /api/file-actions` refuse every `.omp` segment outright
 * (`protectedRootReason` → `omp-runtime`). That refusal is deliberate: on
 * 2026-10-20 a delete on `~/.omp` removed 130 chats, and the guard has no
 * identity argument that could talk its way past it. Loosening it for the
 * generic file API would restore that hole for everyone.
 *
 * The manager therefore owns one narrow path: it accepts a *name* (never a
 * path), validates it against the managed-skill name rule, derives exactly
 * `<agent dir>/skills/<name>`, and refuses everything else. The check runs
 * here, once, and the routes never join a caller-supplied path.
 *
 * ### Why the tenant gets a `customDirectories` entry
 *
 * omp's `loadSkills()` scans the *process* agent dir for `native:user`; the
 * `agentDir` passed to `createAgentSession` does not move that root. What does
 * move is `skills.customDirectories` from the *effective Settings instance*,
 * and `lib/rpc-manager.ts` now resolves settings per identity. Registering the
 * tenant's folder there is what makes the folder visible to their sessions;
 * the directory itself is where the manager writes.
 */

/** The managed-skill rule from the SDK, not the loader's laxer "no slash" test. */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const MAX_SKILL_DESCRIPTION_CHARS = 1024;

/** Anything larger is not a skill file; the editor refuses it rather than truncating. */
export const MAX_SKILL_FILE_BYTES = 256 * 1024;

export class SkillManagerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function isValidSkillName(name: unknown): name is string {
  return typeof name === "string" && SKILL_NAME_RE.test(name);
}

/** `<agent dir>/skills`, created on first use. */
export function resolveSkillsDirectory(identity: WebIdentity): string {
  const directory = join(ensureTenantAgentDir(identity), "skills");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/**
 * The one path a skill name may address.
 *
 * The name allow-list already excludes `/`, `\`, `..` and absolute paths; the
 * root check is the second, independent answer ("is this still mine?") because
 * `resolveSkillsDirectory` derives the path, it does not accept it.
 */
export function resolveSkillDirectory(identity: WebIdentity, name: string): string {
  if (!isValidSkillName(name)) {
    throw new SkillManagerError(
      "Skill names use lowercase letters, digits and hyphens (1-64 chars, starting with a letter or digit)",
      400,
    );
  }
  const root = resolveSkillsDirectory(identity);
  const directory = join(root, name);
  if (!isPathWithinRoots(directory, new Set([getUserHome(identity)]))) {
    throw new SkillManagerError("Skill directory is outside the account home", 400);
  }
  return directory;
}

/**
 * Make the tenant's skill folder discoverable by their own sessions.
 *
 * Idempotent: a folder already listed is left untouched, other entries in
 * `skills.customDirectories` are preserved, and the admin needs no entry at
 * all (the process agent dir is the native user root). The settings instance is
 * the per-identity one from `getSettingsForIdentity`, so the write lands in
 * that account's `config.yml`, never the operator's.
 */
export async function ensureTenantSkillsRegistration(identity: WebIdentity): Promise<string> {
  const directory = resolveSkillsDirectory(identity);
  if (isAdminIdentity(identity)) return directory;

  const settings = await getSettingsForIdentity(identity, undefined);
  // Global layer only. `cfgSkillsCustomDirectories.get()` merges the *project*
  // layer of the process cwd, and writing that merged list back would bake an
  // operator project's `customDirectories` into the tenant's `config.yml` —
  // persisted, and read back as a user-level entry that the project-trust
  // filter must keep.
  const skillsLayer = settings.getGlobalSettings().skills as { customDirectories?: unknown } | undefined;
  const current = Array.isArray(skillsLayer?.customDirectories)
    ? skillsLayer.customDirectories.filter((entry): entry is string => typeof entry === "string")
    : [];
  const wanted = resolve(directory);
  if (!current.some((entry) => resolve(entry) === wanted)) {
    cfgSkillsCustomDirectories.set(settings, [...current, directory]);
    await settings.flush();
  }
  return directory;
}

function skillFilePath(directory: string): string {
  return join(directory, "SKILL.md");
}

function readSkillEntry(identity: WebIdentity, name: string, directory: string): UserSkill {
  const filePath = skillFilePath(directory);
  const diagnostics: ResourceDiagnostic[] = [];
  const source: UserSkill["source"] = isAdminIdentity(identity) ? "native:user" : "custom:user";
  let description = "";
  let mtimeMs: number | null = null;
  let hasSkillFile = false;

  try {
    const entry = lstatSync(filePath);
    if (entry.isSymbolicLink()) {
      diagnostics.push({
        type: "error",
        message: "SKILL.md is a symbolic link; the manager edits only regular files.",
        path: filePath,
      });
    } else if (!entry.isFile()) {
      diagnostics.push({
        type: "error",
        message: "SKILL.md is not a regular file.",
        path: filePath,
      });
    } else {
      hasSkillFile = true;
      mtimeMs = entry.mtimeMs;
      if (entry.size > MAX_SKILL_FILE_BYTES) {
        diagnostics.push({
          type: "error",
          message: `SKILL.md is larger than ${MAX_SKILL_FILE_BYTES} bytes; it cannot be edited here.`,
          path: filePath,
        });
      } else {
        const { frontmatter } = parseFrontmatter(readFileSync(filePath, "utf8"));
        const declaredName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
        const declaredDescription =
          typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
        description = declaredDescription;
        if (!declaredDescription) {
          diagnostics.push({
            type: "error",
            message: "Missing frontmatter description; omp skips this skill silently without one.",
            path: filePath,
          });
        } else if (declaredDescription.length > MAX_SKILL_DESCRIPTION_CHARS) {
          diagnostics.push({
            type: "error",
            message: `The description is longer than ${MAX_SKILL_DESCRIPTION_CHARS} characters.`,
            path: filePath,
          });
        }
        if (declaredName && !isValidSkillName(declaredName)) {
          diagnostics.push({
            type: "error",
            message: `Frontmatter name "${declaredName}" is not a valid skill name.`,
            path: filePath,
          });
        } else if (declaredName && declaredName !== name) {
          diagnostics.push({
            type: "warning",
            message: `Frontmatter name "${declaredName}" differs from the folder name "${name}".`,
            path: filePath,
          });
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostics.push({
        type: "error",
        message: `SKILL.md cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        path: filePath,
      });
    } else {
      diagnostics.push({
        type: "warning",
        message: "This folder has no SKILL.md yet.",
        path: directory,
      });
    }
  }

  return {
    name,
    description,
    filePath,
    mtimeMs,
    hasSkillFile,
    source,
    diagnostics,
  };
}

/**
 * All real skill folders in the caller's store, sorted by name.
 *
 * Symlinked folders and files are skipped with a store-level diagnostic rather
 * than followed: the loader does follow them, but this manager cannot write
 * through one without risking the target, and a list that offers an edit the
 * server will refuse is worse than a named omission.
 */
export function listUserSkills(identity: WebIdentity): UserSkillsResponse {
  const directory = resolveSkillsDirectory(identity);
  const diagnostics: ResourceDiagnostic[] = [];
  const skills: UserSkill[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const skillDir = join(directory, entry.name);
    if (!isValidSkillName(entry.name)) {
      diagnostics.push({
        type: "warning",
        message: `Folder "${entry.name}" is not a valid skill name and is not managed here.`,
        path: skillDir,
      });
      continue;
    }
    if (entry.isSymbolicLink()) {
      diagnostics.push({
        type: "warning",
        message: `"${entry.name}" is a symbolic link; the manager only edits real folders.`,
        path: skillDir,
      });
      continue;
    }
    if (!entry.isDirectory()) continue;
    const filePath = skillFilePath(skillDir);
    try {
      if (lstatSync(filePath).isSymbolicLink()) {
        diagnostics.push({
          type: "warning",
          message: `"${entry.name}/SKILL.md" is a symbolic link; the manager only edits real files.`,
          path: filePath,
        });
        continue;
      }
    } catch {
      // No SKILL.md yet is the ordinary half-created state; the entry below
      // reports it as a warning with `hasSkillFile: false`.
    }
    skills.push(readSkillEntry(identity, entry.name, skillDir));
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { directory, skills, diagnostics };
}

/** One skill, or `null` when the folder does not exist. */
export function readUserSkill(identity: WebIdentity, name: string): UserSkillResponse | null {
  const directory = resolveSkillDirectory(identity, name);
  let entry;
  try {
    entry = lstatSync(directory);
  } catch {
    return null;
  }
  if (entry.isSymbolicLink()) {
    throw new SkillManagerError("Skill folder is a symbolic link and cannot be edited here", 400);
  }
  if (!entry.isDirectory()) {
    throw new SkillManagerError("Skill path is not a folder", 400);
  }

  const skill = readSkillEntry(identity, name, directory);
  const filePath = skillFilePath(directory);
  const blocking = skill.diagnostics.find((diagnostic) => diagnostic.type === "error");
  if (!skill.hasSkillFile) {
    // Missing SKILL.md is the ordinary half-created state, but a symlinked or
    // otherwise unreadable one must not be presented as "create it here".
    if (blocking) throw new SkillManagerError(blocking.message, 400);
    return { skill, content: "" };
  }
  if (blocking && /symbolic link|not a regular file|larger than/i.test(blocking.message)) {
    throw new SkillManagerError(blocking.message, /larger than/i.test(blocking.message) ? 413 : 400);
  }
  try {
    return { skill, content: readFileSync(filePath, "utf8") };
  } catch (error) {
    throw new SkillManagerError(
      `SKILL.md cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }
}

/**
 * Validate a markdown body exactly as the manager will store it.
 *
 * The `description` rule is the one that matters: omp's native/custom scanners
 * use `requireDescription: true` and drop a skill without one **silently**.
 * `name` must be present and match the folder, so the skill cannot appear under
 * one name and be edited under another.
 */
export function validateSkillMarkdown(name: string, content: string): { description: string } {
  if (Buffer.byteLength(content, "utf8") > MAX_SKILL_FILE_BYTES) {
    throw new SkillManagerError(`SKILL.md is larger than ${MAX_SKILL_FILE_BYTES} bytes`, 413);
  }
  const { frontmatter } = parseFrontmatter(content);
  const declaredName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";

  if (!declaredName) {
    throw new SkillManagerError("Frontmatter needs a `name` that matches the folder", 400);
  }
  if (!isValidSkillName(declaredName)) {
    throw new SkillManagerError(
      "Skill names use lowercase letters, digits and hyphens (1-64 chars, starting with a letter or digit)",
      400,
    );
  }
  if (declaredName !== name) {
    throw new SkillManagerError(`Frontmatter name "${declaredName}" must match the folder "${name}"`, 400);
  }
  if (!description) {
    throw new SkillManagerError(
      "A `description` is required: without one omp skips the skill silently",
      400,
    );
  }
  if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
    throw new SkillManagerError(
      `The description is longer than ${MAX_SKILL_DESCRIPTION_CHARS} characters`,
      400,
    );
  }
  return { description };
}

export function buildSkillSkeleton(name: string, description: string): string {
  return [
    "---",
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    "## When to Use",
    "",
    "Describe the situation that should trigger this skill.",
    "",
    "## Procedure",
    "",
    "1. Replace this step with the first concrete action.",
    "",
    "## Pitfalls",
    "",
    "| Symptom | Cause | Fix |",
    "| --- | --- | --- |",
    "",
    "## Verification",
    "",
    "- [ ] Replace this with a check that proves the job worked.",
    "",
  ].join("\n");
}

function assertRealDirectory(directory: string): void {
  let entry;
  try {
    entry = lstatSync(directory);
  } catch {
    throw new SkillManagerError("Skill not found", 404);
  }
  if (entry.isSymbolicLink()) {
    throw new SkillManagerError("Skill folder is a symbolic link and cannot be modified here", 400);
  }
  if (!entry.isDirectory()) {
    throw new SkillManagerError("Skill path is not a folder", 400);
  }
}

/** Create `<skills>/<name>/SKILL.md`; an existing folder is never overwritten. */
export function createUserSkill(
  identity: WebIdentity,
  name: string,
  description: string,
): UserSkill {
  const directory = resolveSkillDirectory(identity, name);
  const trimmedDescription = description.trim();
  if (!isValidSkillName(name)) {
    throw new SkillManagerError(
      "Skill names use lowercase letters, digits and hyphens (1-64 chars, starting with a letter or digit)",
      400,
    );
  }
  if (!trimmedDescription) {
    throw new SkillManagerError("A description is required", 400);
  }
  if (trimmedDescription.length > MAX_SKILL_DESCRIPTION_CHARS) {
    throw new SkillManagerError(
      `The description is longer than ${MAX_SKILL_DESCRIPTION_CHARS} characters`,
      400,
    );
  }

  if (existsSync(directory)) {
    throw new SkillManagerError(`Skill "${name}" already exists`, 409);
  }
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new SkillManagerError(`Skill "${name}" already exists`, 409);
    }
    throw error;
  }
  try {
    writePrivateFileAtomicSync(skillFilePath(directory), buildSkillSkeleton(name, trimmedDescription));
  } catch (error) {
    // A folder without SKILL.md is invisible to the loader and would look like
    // a dangling skill in the manager. Roll it back rather than leave it.
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  }
  return readSkillEntry(identity, name, directory);
}

/** Rewrite SKILL.md atomically after validating the body. */
export function writeUserSkill(
  identity: WebIdentity,
  name: string,
  content: string,
  expectedMtimeMs: number | null,
): UserSkill {
  const directory = resolveSkillDirectory(identity, name);
  assertRealDirectory(directory);
  const filePath = skillFilePath(directory);

  let stat = null;
  try {
    stat = lstatSync(filePath);
  } catch {
    stat = null;
  }
  if (stat?.isSymbolicLink()) {
    throw new SkillManagerError("SKILL.md is a symbolic link and cannot be written here", 400);
  }
  if (stat && !stat.isFile()) {
    throw new SkillManagerError("SKILL.md is not a regular file", 400);
  }
  if (stat && stat.size > MAX_SKILL_FILE_BYTES) {
    throw new SkillManagerError(`SKILL.md is larger than ${MAX_SKILL_FILE_BYTES} bytes`, 413);
  }
  if (stat && expectedMtimeMs !== null && Math.abs(stat.mtimeMs - expectedMtimeMs) > 0.5) {
    throw new SkillManagerError("SKILL.md changed on disk since you opened it; reload before saving", 409);
  }

  validateSkillMarkdown(name, content);
  writePrivateFileAtomicSync(filePath, content);
  return readSkillEntry(identity, name, directory);
}

/** Remove exactly `<skills>/<name>`, never a parent and never a link target. */
export function deleteUserSkill(identity: WebIdentity, name: string): string {
  const directory = resolveSkillDirectory(identity, name);
  assertRealDirectory(directory);

  const root = realpathSync(resolveSkillsDirectory(identity));
  const real = realpathSync(directory);
  if (dirname(real) !== root) {
    throw new SkillManagerError("Skill folder resolves outside the skills directory", 400);
  }
  rmSync(directory, { recursive: true });
  return directory;
}
