import { homedir } from "node:os";
import {
  discoverContextFiles,
  discoverPromptTemplates,
  discoverSessionExtensionPaths,
  discoverSlashCommands,
  getAgentDir,
} from "@oh-my-pi/pi-coding-agent";
import type { FileSlashCommand, Settings } from "@oh-my-pi/pi-coding-agent";
import { ruleCapability, type Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { PromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { discoverCustomToolPaths, type ToolPathWithSource } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import type { ResourceDiagnostic } from "./api-types";
import { getProjectTrustStatus, isInsideProject, untrustedProjectSessionOptions } from "./project-trust";
import { getUserHome, isAdminIdentity, type WebIdentity } from "./request-identity";
import { resolveTenantAgentDir } from "./tenant-config";
import { resolveSessionSystemPrompts, type ResolvedSessionSystemPrompts } from "./session-system-prompt";

/**
 * What one identity may load, in one function.
 *
 * omp's loaders take `getAgentDir()` and `os.homedir()` from process state, so
 * every session served by this process reads the *operator's* store unless the
 * caller decides otherwise: measured in `LOAD-LEVEL-SCAN.md` §3, a tenant
 * session carried the operator's `RULES.md`, `AGENTS.md`, `SYSTEM.md`,
 * `APPEND_SYSTEM.md`, prompt templates and slash commands. Nineteen loads, three
 * identity-scoped. The other sixteen are decided here.
 *
 * Two rules, no more:
 *
 * 1. **A tenant does not inherit the operator's authoring store.** What a
 *    session needs to work stays (the provider catalog is the runtime's, skills
 *    the operator installed are the v0.20.0 decision — `trustedProjectSkills`
 *    is not repeated here). What goes is the material another person wrote for
 *    *their* agent: `AGENTS.md`, `RULES.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`,
 *    custom prompts and slash commands out of the operator's agent directory and
 *    home. The operator's own sessions keep everything.
 * 2. **Project-supplied content follows project trust, with a positive
 *    allowlist.** For an untrusted project nothing may load from inside it — and
 *    for code (extensions, custom tools) only paths under the operator's roots
 *    survive, because a project's `.omp/config.yml` can name a path *outside*
 *    the project (`extensions: [/tmp/outside-evil2/ext.ts]` ran, measured in
 *    `LOAD-LEVEL-SCAN.md` §3(i)). An exclusion filter cannot see that.
 *
 * `undefined` means *no filter applies* — never an empty list. A caller that
 * receives `items` must hand it to omp as the pre-built list, exactly like
 * `trustedProjectSkills` (`lib/project-trust.ts`), or the session and the panel
 * disagree. Every non-empty removal produces one `info` diagnostic with the
 * count, so a silent drop is impossible.
 */

export type LoadLevel = "user" | "project" | "native";

/** The two facts about a discovered item this policy decides on. */
export interface LoadCandidate {
  /** Absolute file the loader read. Absent when the loader reports none. */
  path?: string;
  /** omp's own level (`_source.level`, `source.level`, or the loader's label). */
  level?: LoadLevel;
}

export interface LoadScope {
  /** `null` is the process owner: an install without accounts has one user. */
  identity: WebIdentity | null;
  cwd: string;
  /** What is being loaded, for the diagnostic ("rule", "custom prompt", …). */
  kind: string;
  /** Modules omp imports and executes; the untrusted branch then checks the roots. */
  code?: boolean;
}

export interface LoadDecision<T> {
  /** The items to load, or `undefined` when no rule applies to this list. */
  items: T[] | undefined;
  withheld: number;
  diagnostic?: ResourceDiagnostic;
}

/** The roots this policy decides against. */
interface LoadRoots {
  /** The process owner's agent directory and home. */
  operator: readonly string[];
  /** A tenant's own home, which outranks the process home when the two nest. */
  tenantHome?: string;
}

function loadRoots(identity: WebIdentity | null): LoadRoots {
  const tenant = identity !== null && !isAdminIdentity(identity);
  return {
    // `homedir()`, not `getUserHome()`: the foreign providers (`~/.agents`,
    // `~/.claude`, `~/.codex`) resolve from the process home, which is the
    // operator's however the request arrived.
    operator: [getAgentDir(), homedir()],
    ...(tenant ? { tenantHome: getUserHome(identity) } : {}),
  };
}

/** True when `candidate` was read out of the operator's store, not the tenant's own. */
function isOperatorStore(candidate: LoadCandidate, roots: LoadRoots): boolean {
  const path = candidate.path;
  if (path === undefined) {
    // No path to test: the loader's level is the only provenance left, and a
    // `user`-level item of a loader that takes no agent directory always comes
    // from the process roots. That is exactly the slash-command case
    // (`discoverSlashCommands({ cwd })` takes no agent directory).
    return candidate.level === "user";
  }
  if (roots.tenantHome !== undefined && isInsideProject(path, roots.tenantHome)) return false;
  return roots.operator.some((root) => isInsideProject(path, root));
}

/**
 * The items of `items` this identity may load, plus what it removed.
 *
 * `read` narrows an item to its path and level; the call sites are one line each
 * (`(rule) => ({ path: rule.path, level: rule._source?.level })`) and the policy
 * stays free of per-type knowledge.
 */
export function filterLoads<T>(
  items: readonly T[],
  scope: LoadScope,
  read: (item: T) => LoadCandidate,
): LoadDecision<T> {
  const roots = loadRoots(scope.identity);
  const tenant = scope.identity !== null && !isAdminIdentity(scope.identity);
  const trust = getProjectTrustStatus(scope.cwd, getAgentDir());
  // `requiresTrust && !trusted` and nothing else: a project that ships no
  // trust-requiring resource is on omp's normal path (`lib/project-trust.ts`),
  // which is what "untrusted" has always meant here.
  const narrowed = trust.requiresTrust && !trust.trusted;
  if (!tenant && !narrowed) return { items: undefined, withheld: 0 };

  let fromProject = 0;
  let fromOperator = 0;
  const kept = items.filter((item) => {
    const candidate = read(item);
    const insideProject =
      candidate.level === "project" ||
      (candidate.path !== undefined && isInsideProject(candidate.path, scope.cwd));
    if (narrowed && insideProject) {
      fromProject += 1;
      return false;
    }
    if (tenant && isOperatorStore(candidate, roots)) {
      fromOperator += 1;
      return false;
    }
    const codePath = candidate.path;
    if (narrowed && scope.code && (codePath === undefined || !roots.operator.some((root) => isInsideProject(codePath, root)))) {
      fromProject += 1;
      return false;
    }
    return true;
  });

  const withheld = fromProject + fromOperator;
  if (withheld === 0) return { items: kept, withheld: 0 };
  const reasons = [
    ...(fromProject > 0 ? ["this project is not trusted"] : []),
    ...(fromOperator > 0 ? ["this account does not inherit the operator's agent directory"] : []),
  ];
  return {
    items: kept,
    withheld,
    diagnostic: {
      type: "info",
      message: `${withheld} ${scope.kind}${withheld === 1 ? "" : "s"} not loaded: ${reasons.join("; ")}.`,
      path: scope.cwd,
    },
  };
}

/** Everything a session start hands to `createAgentSession` that a load decides. */
export interface SessionLoadOptions {
  rules?: Rule[];
  contextFiles?: Array<{ path: string; content: string }>;
  promptTemplates?: PromptTemplate[];
  slashCommands?: FileSlashCommand[];
  preloadedExtensionPaths?: string[];
  preloadedCustomToolPaths?: ToolPathWithSource[];
  /** Whether omp discovers and spawns MCP servers for this session. */
  enableMCP?: false;
}

export interface SessionLoads {
  options: SessionLoadOptions;
  systemPrompts: ResolvedSessionSystemPrompts;
  /** Whether this project is narrowed by trust; the caller filters skills by it. */
  narrowed: boolean;
  /**
   * Re-applies the command filter after a rediscovery.
   *
   * `AgentSession.refreshSkillsAndCommands()` always re-loads slash commands
   * from the process roots and knows nothing about a pre-built list
   * (`agent-session.ts:7122`), so the SDK puts the operator's commands back the
   * moment a discovery setting changes — measured in `LOAD-LEVEL-SCAN.md` §8a.
   * `subscribeCommandMetadataChanged` fires right after that reload and
   * `setSlashCommands()` is public, so the same filter runs again instead of
   * hoping the refresh does not happen.
   */
  filterCommands?: (commands: readonly FileSlashCommand[]) => FileSlashCommand[];
  diagnostics: ResourceDiagnostic[];
}

const commandCandidate = (command: FileSlashCommand): LoadCandidate => ({
  level: command._source?.level,
});

/**
 * Every load a session for `cwd` makes, filtered for `identity`.
 *
 * The one entry point for the session (`lib/rpc-manager.ts`) and the panel
 * (`GET /api/skills`, which merges `diagnostics`), so "what the panel lists" and
 * "what the agent loads" cannot drift apart.
 *
 * Skills are the sixth list and stay in `lib/skills-service.ts`: they are the one
 * place rule 1 does not apply (the v0.20.0 decision), so `loadSessionSkills()`
 * keeps owning discovery *and* the trust filter instead of being split in two.
 */
export async function resolveSessionLoads(
  identity: WebIdentity | null,
  cwd: string,
  settings: Settings,
): Promise<SessionLoads> {
  const agentDir = getAgentDir();
  // A tenant's own config roots. The SDK's loaders take an agent directory for
  // rules and prompt templates; the process one is the operator's.
  const ownerAgentDir = identity !== null && !isAdminIdentity(identity)
    ? resolveTenantAgentDir(identity)
    : agentDir;
  const scope = (kind: string, code = false): LoadScope => ({
    identity,
    cwd,
    kind,
    ...(code ? { code } : {}),
  });

  const [extensionPaths, customToolPaths, contextFiles, promptTemplates, slashCommands, rules] =
    await Promise.all([
      discoverSessionExtensionPaths({}, cwd, settings),
      discoverCustomToolPaths([], cwd),
      discoverContextFiles(cwd, ownerAgentDir),
      discoverPromptTemplates(cwd, ownerAgentDir),
      discoverSlashCommands({ cwd }),
      loadCapability<Rule>(ruleCapability.id, { cwd, agentDir: ownerAgentDir }),
    ]);

  const trust = getProjectTrustStatus(cwd, agentDir);
  const narrowed = trust.requiresTrust && !trust.trusted;
  const tenant = identity !== null && !isAdminIdentity(identity);
  const options: SessionLoadOptions = {};
  const diagnostics: ResourceDiagnostic[] = [];

  // Code paths: the project half is `lib/project-trust.ts` (positive allowlist,
  // unchanged shape), the identity half keeps the operator's installed tooling.
  const projectCode = untrustedProjectSessionOptions(cwd, agentDir, { extensionPaths, customToolPaths });
  if (projectCode) Object.assign(options, projectCode);

  const rulesDecision = filterLoads(rules.items, scope("rule"), (rule) => ({
    path: rule.path,
    level: rule._source.level,
  }));
  const contextDecision = filterLoads(contextFiles, scope("context file"), (file) => ({ path: file.path }));
  // `PromptTemplate` carries no path, only omp's own label; the loader already
  // ran against this identity's agent directory, so a `(user…)` template is the
  // *tenant's* own and only the project half has to be decided.
  const promptDecision = filterLoads(promptTemplates, scope("custom prompt"), (template) => ({
    ...(template.source.startsWith("(project") ? { level: "project" as const } : {}),
  }));
  const commandDecision = filterLoads(slashCommands, scope("slash command"), commandCandidate);

  if (rulesDecision.items) options.rules = rulesDecision.items;
  if (contextDecision.items) options.contextFiles = contextDecision.items;
  if (promptDecision.items) options.promptTemplates = promptDecision.items;
  if (commandDecision.items) options.slashCommands = commandDecision.items;

  // MCP cannot be filtered per server: `enableMCP` is the only lever
  // (`sdk.ts:783`), and an operator server is a process with this host's rights.
  // A tenant gets none until a per-account MCP manager exists; a narrowed
  // project gets none either (already in `untrustedProjectSessionOptions`).
  if (tenant || narrowed) options.enableMCP = false;

  for (const decision of [rulesDecision, contextDecision, promptDecision, commandDecision]) {
    if (decision.diagnostic) diagnostics.push(decision.diagnostic);
  }

  return {
    options,
    systemPrompts: await resolveSessionSystemPrompts(cwd, identity),
    narrowed,
    ...(commandDecision.items
      ? {
          filterCommands: (commands: readonly FileSlashCommand[]) =>
            filterLoads(commands, scope("slash command"), commandCandidate).items ?? [...commands],
        }
      : {}),
    diagnostics,
  };
}

/**
 * The `Settings` instance a session runs with.
 *
 * A tenant gets an in-memory overlay (`Settings.overlay`, the SDK's route for a
 * derived session: reads fall through live, writes stay local) that pins the two
 * switches which would otherwise reach another account's files:
 *
 * - `autolearn.enabled` gates `manage_skill`, and that tool writes into
 *   `getManagedSkillsDir()` **without an argument** — the process agent
 *   directory, i.e. the operator's store (measured: a tenant's mint created
 *   `…/proc-agent/managed-skills/<name>/SKILL.md`, `LOAD-LEVEL-SCAN.md` §3(ii)).
 *   The tenant's mint has nowhere of its own to land, so it fails.
 * - `memory.backend` makes the session read `getMemoryRoot(agentDir, cwd)` with
 *   the process agent directory (`sdk.ts:4940-4941`); `memoryAgentDir` is not a
 *   session option, so a tenant's memory cannot be pointed at their own root
 *   through any supported route. Memory stays off and the gap is documented
 *   rather than patched.
 *
 * Pinning also freezes the reload trigger for that session: `#applyParentChange`
 * skips an overridden path, so a later write to it never reaches the session.
 */
export function sessionSettings(identity: WebIdentity | null, settings: Settings): Settings {
  if (identity === null || isAdminIdentity(identity)) return settings;
  return settings.overlay({ autolearn: { enabled: false }, memory: { backend: "off" } });
}
