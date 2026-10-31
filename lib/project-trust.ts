import { existsSync, mkdirSync, readFileSync, realpathSync } from "fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import type { ProjectTrustStatus } from "./api-types";

/**
 * Project trust for omp-web.
 *
 * The `omp` CLI executes a repository's `.omp/extensions`, `.omp/hooks`,
 * `.omp/tools` and `.mcp.json` because the user deliberately ran it inside that
 * repository. omp-web reaches the same code from a browser tab: merely opening
 * a project in the sidebar would otherwise run repository-controlled code on
 * the machine hosting the server.
 *
 * omp has no trust store of its own, so omp-web keeps one and gates the
 * *code-bearing* project resources behind it. Trust decisions live next to the
 * agent config so they survive restarts and are shared by every omp-web
 * instance pointed at the same agent directory.
 */

const TRUST_FILE = "omp-web-trusted-projects.json";

/**
 * Project-relative directories whose contents omp imports and executes.
 *
 * Skills, rules and prompts are intentionally absent: they are data folded into
 * the system prompt, not modules the loader imports.
 */
const CODE_BEARING_PROJECT_DIRS = [
  ".omp/extensions", ".omp/hooks", ".omp/tools",
  ".pi/extensions", ".pi/hooks", ".pi/tools",
  ".claude/extensions", ".claude/hooks", ".claude/tools",
  ".agents/extensions", ".agents/hooks", ".agents/tools",
] as const;

/**
 * Project-relative directories omp scans for project-scoped skills.
 *
 * Kept apart from {@link CODE_BEARING_PROJECT_DIRS} because nothing here is
 * imported or executed: a skill is text folded into the system prompt. It still
 * has to raise the trust dialog, or a repository whose only payload is a
 * `SKILL.md` would inject instructions into the agent with no decision made at
 * all (measured: `.agents/skills/evil` loaded into an untrusted session).
 */
const PROJECT_SKILL_DIRS = [
  ".omp/skills", ".agent/skills", ".agents/skills",
  ".claude/skills", ".codex/skills", ".github/skills", ".opencode/skills",
] as const;

/** Project-relative files that declare MCP servers, i.e. processes omp spawns. */
const MCP_MANIFEST_FILES = [
  ".mcp.json",
  ".omp/.mcp.json", ".omp/mcp.json",
  ".claude/.mcp.json", ".claude/mcp.json",
  ".cursor/mcp.json",
] as const;

/**
 * Project-relative settings files whose *keys* make omp load something.
 *
 * `.omp/config.yml` carries `extensions`, and omp honours that list from the
 * merged project layer: measured, a project whose `.omp/config.yml` named
 * `extensions: [/tmp/outside-evil2/ext.ts]` ran that module while
 * `hasTrustRequiringProjectResources` reported `false` and no decision was ever
 * asked for (`LOAD-LEVEL-SCAN.md` §3(i)). The file is a code-bearing resource
 * exactly like `.omp/extensions` — it just arrives as a key instead of a
 * directory. omp's settings loader reads `<cwd>/.omp/config.yml`,
 * `<cwd>/.omp/settings.json` and `<cwd>/.claude/settings.json` for a project
 * layer (`config/settings.ts`, `#syncFileWatchers`), so all three raise the
 * dialog.
 */
const PROJECT_SETTINGS_FILES = [
  ".omp/config.yml", ".omp/settings.json", ".claude/settings.json",
] as const;

function trustFilePath(agentDir: string): string {
  return join(agentDir, TRUST_FILE);
}

function canonicalProjectKey(cwd: string): string {
  const resolved = resolve(cwd);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function readTrustedProjects(agentDir: string): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(trustFilePath(agentDir), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
    );
  } catch {
    return {};
  }
}

function writeTrustedProjects(agentDir: string, trusted: Record<string, boolean>): void {
  mkdirSync(agentDir, { recursive: true });
  writePrivateFileAtomicSync(trustFilePath(agentDir), `${JSON.stringify(trusted, null, 2)}\n`);
}

/**
 * Whether `cwd` ships resources omp would import and execute on session start,
 * or a settings file whose keys would make it import them.
 */
export function hasTrustRequiringProjectResources(cwd: string): boolean {
  if (!cwd) return false;
  for (const dir of [...CODE_BEARING_PROJECT_DIRS, ...PROJECT_SKILL_DIRS]) {
    if (existsSync(join(cwd, dir))) return true;
  }
  for (const file of [...MCP_MANIFEST_FILES, ...PROJECT_SETTINGS_FILES]) {
    if (existsSync(join(cwd, file))) return true;
  }
  return false;
}

export function getProjectTrustStatus(cwd: string, agentDir: string): ProjectTrustStatus {
  const requiresTrust = Boolean(cwd) && hasTrustRequiringProjectResources(cwd);
  if (!requiresTrust) return { requiresTrust: false, trusted: true };

  return {
    requiresTrust: true,
    trusted: readTrustedProjects(agentDir)[canonicalProjectKey(cwd)] === true,
  };
}

export function trustProject(cwd: string, agentDir: string): ProjectTrustStatus {
  const status = getProjectTrustStatus(cwd, agentDir);
  if (!status.requiresTrust) return status;

  const trusted = readTrustedProjects(agentDir);
  trusted[canonicalProjectKey(cwd)] = true;
  writeTrustedProjects(agentDir, trusted);
  return { requiresTrust: true, trusted: true };
}

/** True when `candidate` lives inside `root` (or is `root` itself). */
export function isInsideProject(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../");
}

/**
 * Source metadata omp attaches to a discovered skill, narrowed to the two
 * fields this gate decides on.
 */
export interface DiscoveredSkillSource {
  provider: string;
  level: "user" | "project" | "native";
}

/** Shape shared by omp's discovered skills (`Skill._source`). */
export interface DiscoveredSkillFile {
  filePath: string;
  _source?: DiscoveredSkillSource;
}

/**
 * Skills to keep for a project the user has not trusted, or `undefined` when
 * the normal load path applies (nothing to gate, or the project is trusted).
 *
 * Skills are the one prompt-only surface that still has to follow trust. They
 * are not executed, so they cannot be dropped by filtering modules — but the
 * model reads them, and a repository the user merely opened must not be able to
 * write into the agent's instructions on its own. Measured before this gate:
 * an untrusted checkout carrying `.agents/skills/evil/SKILL.md` had that skill
 * in the session while its `.omp/extensions` stayed dormant.
 *
 * Three rules decide what survives, in this order:
 *
 * 1. A project-level entry goes, whichever provider found it (`native`,
 *    `agents`, `claude`, `codex`, `github`, `opencode`, plugin packages, …).
 *    `_source.level` is the loader's own answer, so this covers the entire
 *    project scan — including `.omp/skills`, which walks up to the repo root.
 * 2. Anything living under the project root goes, because a custom-directory
 *    entry is labelled `level: "user"` however it was configured, and a
 *    project's `.omp/config.yml` can point `skills.customDirectories` at itself.
 *    That is a real bypass, measured, not a hypothetical: `customDirectories:
 *    [<cwd>/evil-custom]` in the project layer yielded `custom:user` from the
 *    project tree. The path test catches it; the level alone does not.
 * 3. Everything else stays: `~/.omp/agent/skills`, `~/.agents/skills`,
 *    `~/.claude/skills`, managed skills, and custom directories the *user*
 *    configured outside the project are not attacker-controlled, and an
 *    untrusted project is meant to be a narrowed session, not a crippled one.
 */
export function trustedProjectSkills<T extends DiscoveredSkillFile>(
  cwd: string,
  agentDir: string,
  skills: readonly T[],
): T[] | undefined {
  const status = getProjectTrustStatus(cwd, agentDir);
  if (!status.requiresTrust || status.trusted) return undefined;

  return skills.filter(
    (skill) => skill._source?.level !== "project" && !isInsideProject(skill.filePath, cwd),
  );
}

/** Shape shared by omp's discovered custom-tool entries. */
export interface DiscoveredToolPath {
  path: string;
  source?: { level: "user" | "project" };
}

export interface UntrustedProjectSessionOptions<TTool extends DiscoveredToolPath> {
  /** Extension modules to load, with project-local ones removed. */
  preloadedExtensionPaths: string[];
  /** Custom tool modules to load, with project-local ones removed. */
  preloadedCustomToolPaths: TTool[];
  /** MCP servers are processes omp spawns from project manifests — off entirely. */
  enableMCP: false;
}

export interface DiscoveredProjectCode<TTool extends DiscoveredToolPath> {
  extensionPaths: readonly string[];
  customToolPaths: readonly TTool[];
}

/**
 * Session options that keep an untrusted project's code dormant.
 *
 * Returns `undefined` when the project has nothing that requires trust, or when
 * the user already trusted it — both leave omp on its normal load path so
 * omp-web sessions behave exactly like `omp` in a terminal.
 *
 * The caller supplies the discovered paths (omp's own `discoverSessionExtensionPaths`
 * / `discoverCustomToolPaths` results) so user-level extensions keep working.
 *
 * ### Why this is a positive allowlist, not "everything outside the project"
 *
 * A project's `.omp/config.yml` can name a path that lies *outside* the project
 * root, so "not under the project" lets it through: measured, a config with
 * `extensions: [/tmp/outside-evil2/ext.ts]` ran that module
 * (`LOAD-LEVEL-SCAN.md` §3(i)). What survives instead is code from the roots omp
 * itself scans for this account — the agent directory and the process home
 * (`<agentDir>/extensions`, `<agentDir>/tools`, `~/.agents/…`, `~/.claude/…`,
 * `~/.omp/plugins`) — and nothing else. The consequence is deliberate: an
 * operator who configured an extension at `/opt/foo.ts` does not get it inside a
 * project they have not trusted, and gets it back the moment they trust it.
 */
export function untrustedProjectSessionOptions<TTool extends DiscoveredToolPath>(
  cwd: string,
  agentDir: string,
  discovered: DiscoveredProjectCode<TTool>,
): UntrustedProjectSessionOptions<TTool> | undefined {
  const status = getProjectTrustStatus(cwd, agentDir);
  if (!status.requiresTrust || status.trusted) return undefined;

  const roots = [agentDir, homedir()];

  return {
    preloadedExtensionPaths: discovered.extensionPaths.filter(
      (path) => !isInsideProject(path, cwd) && roots.some((root) => isInsideProject(path, root)),
    ),
    preloadedCustomToolPaths: discovered.customToolPaths.filter(
      (tool) =>
        tool.source?.level !== "project" &&
        !isInsideProject(tool.path, cwd) &&
        roots.some((root) => isInsideProject(tool.path, root)),
    ),
    enableMCP: false,
  };
}
