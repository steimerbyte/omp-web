import { findConfigFile } from "@oh-my-pi/pi-coding-agent/config";
import { resolvePromptInput } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { getProjectTrustStatus } from "./project-trust";
import { isAdminIdentity, type WebIdentity } from "./request-identity";

/**
 * `SYSTEM.md` / `APPEND_SYSTEM.md` resolution for omp-web sessions.
 *
 * The `omp` CLI resolves both files before it creates a session — project-local
 * first (`.omp/`, `.claude/`, `.codex/`, `.gemini/`), then user-level
 * (`~/.omp/agent/`, …) — and hands the text to `createAgentSession` as
 * `customSystemPrompt` / `appendSystemPrompt`. omp-web builds its own session
 * options in `lib/rpc-manager.ts`, so a browser session used to silently drop
 * every prompt file the same user gets in the terminal (issue #28).
 *
 * The lookup itself is omp's own `findConfigFile`, not a re-implementation, so
 * the config roots and their precedence cannot drift from the CLI's. Two things
 * differ, both forced by serving many projects from one process:
 *
 * - The CLI resolves against `getProjectDir()`, i.e. the directory `omp` was
 *   started in. Here every lookup is bound to the session's own cwd.
 * - Project-local prompt files come from whatever repository the browser
 *   opened, so `lib/project-trust.ts` is in scope: they are data folded into the
 *   system prompt, but a project the user has not trusted must not write the
 *   instructions either (`untrusted`: no prompt file from inside it).
 * - User-level prompt files come from the *process* config roots
 *   (`~/.omp/agent`, `~/.claude`, …). For a tenant those roots belong to the
 *   operator, so only the operator's own sessions read them — the same rule as
 *   `AGENTS.md` and `RULES.md` (`lib/load-policy.ts`). `findConfigFile` has no
 *   agent-directory parameter, so a tenant gets no user-level prompt file at all
 *   rather than a guess at their own root.
 */

export interface ResolvedSessionSystemPrompts {
  /** `SYSTEM.md` text, rendered through omp's custom system prompt template. */
  systemPrompt: string | undefined;
  /** `APPEND_SYSTEM.md` text, appended to the rendered system prompt. */
  appendPrompt: string | undefined;
}

/**
 * First match for `fileName`, project-level before user-level.
 *
 * `findConfigFile` orders user directories ahead of project ones, so the CLI
 * asks twice to invert that; mirror it rather than reordering the result.
 */
function discoverPromptFile(
  fileName: string,
  cwd: string,
  allowed: { project: boolean; user: boolean },
): string | undefined {
  // `user: true` on its own still scans the project roots (`getConfigDirs`
  // defaults `project` to true), so the user half has to switch the project half
  // off — otherwise an untrusted project's file came back through it.
  return (
    (allowed.project ? findConfigFile(fileName, { user: false, cwd }) : undefined) ??
    (allowed.user ? findConfigFile(fileName, { user: true, project: false, cwd }) : undefined)
  );
}

/**
 * Resolve the prompt files a session started in `cwd` for `identity` should carry.
 *
 * Both fields are `undefined` when no file exists, which keeps the session on
 * omp's default prompt.
 */
export async function resolveSessionSystemPrompts(
  cwd: string,
  identity: WebIdentity | null,
): Promise<ResolvedSessionSystemPrompts> {
  const trust = getProjectTrustStatus(cwd, getAgentDir());
  const allowed = {
    project: !(trust.requiresTrust && !trust.trusted),
    user: identity === null || isAdminIdentity(identity),
  };
  const [systemPrompt, appendPrompt] = await Promise.all([
    resolvePromptInput(discoverPromptFile("SYSTEM.md", cwd, allowed), "system prompt"),
    resolvePromptInput(discoverPromptFile("APPEND_SYSTEM.md", cwd, allowed), "append system prompt"),
  ]);
  return { systemPrompt, appendPrompt };
}
