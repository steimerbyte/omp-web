# Project trust in omp-web

## Why omp-web has a trust gate and `omp` does not

The `omp` CLI loads a repository's `.omp/extensions`, `.omp/hooks`, `.omp/tools`
and `.mcp.json` as a matter of course. That is safe by construction: you ran
`omp` inside that repository, which is itself the decision to execute it.

omp-web reaches the same code from a browser tab. Clicking a project in the
sidebar — or having a session for it restored on page load — would otherwise
import and run repository-controlled code on the machine hosting the server,
without anything that reads as consent. So omp-web keeps a trust store that omp
itself has no need for.

## What requires trust

Three kinds of thing: resources omp *executes*, project skills, which omp
*folds into the system prompt*, and project settings files, whose *keys* name
things omp imports.

| Kind | Paths |
| --- | --- |
| Extensions | `.omp/extensions`, `.pi/extensions`, `.claude/extensions`, `.agents/extensions` |
| Hooks | the `hooks/` directory under each of those config roots |
| Custom tools | the `tools/` directory under each of those config roots |
| MCP servers | `.mcp.json`, `.omp/.mcp.json`, `.omp/mcp.json`, `.claude/.mcp.json`, `.claude/mcp.json`, `.cursor/mcp.json` |
| Project skills | `.omp/skills`, `.agent/skills`, `.agents/skills`, `.claude/skills`, `.codex/skills`, `.github/skills`, `.opencode/skills` |
| Project settings | `.omp/config.yml`, `.omp/settings.json`, `.claude/settings.json` |

Project skills are the one *prompt-only* entry on that list. They are not
executed, so they cannot be gated by dropping modules — but the model reads
them, and a repository the user merely opened must not be able to write into the
agent's instructions on its own. Measured before this gate: an untrusted
checkout carrying `.agents/skills/evil/SKILL.md` had that skill in the session
while its `.omp/extensions` stayed dormant.

The settings files are the newest entry, and the one that makes the gate a
positive allowlist. `.omp/config.yml` carries `extensions`, and omp honours
that list from the merged project layer: a project whose file named
`extensions: [/tmp/outside-evil2/ext.ts]` ran that module while the project
required no trust at all, because the detector only looked for directories.
The file is code-bearing exactly like `.omp/extensions` — it just arrives as a
key instead of a directory. omp's settings loader reads all three files for a
project layer (`config/settings.ts`, `#syncFileWatchers`), so all three raise
the dialog (`hasTrustRequiringProjectResources` in `lib/project-trust.ts`).
The consequence is blunt and accepted: a repository that carries a
`.omp/config.yml` for a model or a thinking level now asks for trust once.

A project with none of the above never sees a prompt: `requiresTrust` is false
and the session loads on omp's normal path.

### Rules and prompts follow trust

Project rules, `AGENTS.md` and the other context files, prompt templates,
slash commands and a project's `SYSTEM.md` / `APPEND_SYSTEM.md` are dropped
with the rest of an untrusted project's content. They are not executed, but
they are instructions: a repository the user merely opened must not write the
agent's behaviour, which is the same reason skills follow trust.
`lib/session-system-prompt.ts` resolves a project's prompt files for a browser
session the way `omp` resolves them for a terminal one — but only when the
project is not untrusted.

That does not make an ordinary repository unusable. A project that ships
nothing from the table above never requires trust in the first place, so its
`AGENTS.md`, rules and prompts load exactly as they always did; `AGENTS.md` is
what makes a repository legible to the agent at all
(`lib/project-trust.test.mjs`, "rules and prompts alone still never require
trust").

## What the gate actually does

When a project needs trust and has not been trusted, omp-web still runs omp's
own discovery, then hands `createAgentSession` pre-built lists instead of the
discovered ones. The filter is `filterLoads` in `lib/load-policy.ts`, reached
through `resolveSessionLoads`; the code half stays
`untrustedProjectSessionOptions` in `lib/project-trust.ts`:

- **Everything from inside the project.** Rules, `AGENTS.md` and the other
  context files, prompt templates, slash commands, a project's
  `SYSTEM.md`/`APPEND_SYSTEM.md`, extensions, custom tools and skills — each
  list returns without the project's entries.
- `preloadedExtensionPaths` / `preloadedCustomToolPaths` — discovered code
  minus every path that is not under `getAgentDir()` or `os.homedir()`, and
  minus anything marked `level: "project"`.
- `enableMCP: false` — MCP servers are processes omp would spawn from a
  project manifest.
- `skills` — discovered skills minus every entry marked `level: "project"` and
  minus every entry whose file lives under the project root
  (`trustedProjectSkills`).

The skills filter needs both halves. The level catches every project scan the
loader runs, whichever provider found it. The path catches the case the level
cannot: a custom directory is labelled `custom:user` however it was configured,
and a project's own `.omp/config.yml` can point `skills.customDirectories` at
itself — measured, not hypothetical.

### The code filter is an allowlist, not an exclusion

"Not under the project root" was the old rule and it could not see a path a
project points at. Measured: `.omp/config.yml` with
`extensions: [/tmp/outside-evil2/ext.ts]` was discovered and ran, because
neither the detector nor the filter had a reason to look at that file. What
survives now is code from the roots omp itself scans for this account —
`<agentDir>/extensions`, `<agentDir>/tools`, `~/.agents/…`, `~/.claude/…`,
`~/.omp/plugins` — and nothing else. A path under the operator's own roots is
the operator's decision; a path merely outside the project is a number the
project chose.

The consequence is deliberate: an operator who configured an extension at
`/opt/foo.ts` does not get it inside a project they have not trusted, and gets
it back the moment they trust it. Installed tooling is not filtered by
identity either: a tenant loads the extensions and custom tools the operator
installed.

User-level skills in `~/.omp/agent/skills`, `~/.agents/skills`,
`~/.claude/skills` and any custom directory the *user* configured outside the
project are not attacker-controlled and keep loading. An untrusted project is a
*narrowed* session, not a crippled one — that holds for skills exactly as it
does for extensions.

### One truth about which skills exist

`GET /api/skills` and the session both call `loadSessionSkills()`
(`lib/skills-service.ts`), so the panel cannot advertise a skill the agent does
not have. When trust removes any, the response carries an `info` diagnostic
naming how many, and the panel already shows the banner from
`trust.skillsNotLoaded`.

The response also carries the load policy's diagnostics:
`loadSkillsWithInstallInfo` merges `resolveSessionLoads(...).diagnostics`, so
rules, context files, prompt templates and slash commands that were withheld
show up as one `info` line per load with a count — "3 rules not loaded: this
project is not trusted." At session start the same lines go to the server log
with a `[load-policy]` prefix, because a session that quietly runs without its
rules is a deployment fact, not a UI detail.

A session in an untrusted project keeps its filtered list across `/reload`:
handing `createAgentSession` a skill list sets `skillsReloadable: false`
(`sdk.ts:4927`), so `refreshSkills()` rebuilds the prompt without
rediscovering. Rules, context files and prompt templates are pinned the same
way — they arrive as pre-built lists in the session options. Slash commands are
the exception the SDK forces: a refresh re-discovers them from the process
roots (`refreshSkillsAndCommands`, `agent-session.ts:7122`), so
`startRpcSession` subscribes to `subscribeCommandMetadataChanged` and
re-applies the same filter with `setSlashCommands` — the list cannot widen
mid-session.

## What a tenant may load

Project trust is one of the two rules `lib/load-policy.ts` applies; the other
is the identity. omp's loaders take `getAgentDir()` and `os.homedir()` from
process state, so every session this server starts reads the *operator's* store
unless the caller decides otherwise. Before this policy a tenant session
carried the operator's `RULES.md`, `AGENTS.md`, `SYSTEM.md`,
`APPEND_SYSTEM.md`, prompt templates and slash commands — material that account
had never written (`lib/load-policy.test.mjs` compares each filtered list
against what omp discovered).

A tenant therefore does not inherit the operator's authoring store.
`AGENTS.md`, `RULES.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, custom prompt
templates and slash commands from the operator's agent directory or home do not
reach it, the `~/.agents` and `~/.claude` variants included. What the tenant
wrote in their own `$HOME/.omp/agent` keeps loading: `resolveSessionLoads`
reads rules and prompt templates through `resolveTenantAgentDir(identity)`,
and `filterLoads` treats anything under the tenant's home as theirs, not the
operator's. Context files are the exception: `discoverContextFiles()` ignores
its agent-directory argument, so a tenant's `AGENTS.md` is the project's, and
the operator's is what gets dropped.

What a tenant keeps is what a session needs to work: the provider catalog and
credentials (process-wide in `getOmpRuntime()`, untouched by this policy), the
skills the operator installed (the v0.20.0 decision — `loadSessionSkills` is
the same loader for both accounts), the operator's installed extensions and
custom tools, and a project's own rules, prompts, commands and `AGENTS.md` as
long as the project requires no trust.

MCP is off for a tenant, not only for an untrusted project. `enableMCP` is the
only lever omp has (`sdk.ts:783`), and an operator's MCP server is a process
with this host's rights; a per-account MCP manager does not exist, so there is
nothing finer to switch.

One asymmetry is a gap rather than a decision: a tenant has no slash commands
of their own. `discoverSlashCommands({ cwd })` takes no agent directory, so the
operator's are dropped and nothing replaces them — bundled commands remain, and
a project's own while it requires no trust.

### Memory and autolearn are pinned off

`sessionSettings` (`lib/load-policy.ts`) hands a tenant an in-memory
`Settings.overlay` with `memory.backend: "off"` and `autolearn.enabled: false`.
Both would otherwise reach the operator's files: a session reads
`getMemoryRoot(agentDir, cwd)` with the process agent directory
(`memoryAgentDir: agentDir`, `sdk.ts:4941`), and `autolearn` gates
`manage_skill`, whose `getManagedSkillsDir()` defaults to the process agent
directory (`autolearn/managed-skills.ts:25`) — a tenant's mint would land in
the operator's `managed-skills` store. The overlay is a view, not a write: the
account's own `config.yml` keeps its values, and an admin runs unchanged.

**Known gap:** tenant memory needs an SDK seam. `memoryAgentDir` is not a
session option a caller can point at the tenant's own root, so memory is off
rather than redirected.

### Writing a host-wide setting is an admin act

`isAdminOnlySetting` (`lib/settings-api.ts`) marks the settings whose effect is
the whole host's, not one screen's: `skills.*`, `commands.*`, `autolearn.*`,
`memory.*`, `extensions`, `disabledExtensions`, `enabledProviders`,
`disabledProviders`. `PATCH /api/settings` answers 403 through `requireAdmin`
for them, and `GET` marks the same fields `writable: false` so the panel
disables the control instead of offering a write the server refuses. Theme and
UI settings stay per-account and open. The list is prefixes, not an enum of
ids: a new `skills.*` key is admin-only by default instead of open until
someone remembers it.

## Where the decision is stored

`~/.omp/agent/omp-web-trusted-projects.json`, keyed by the project's real path
(symlinks resolved). It is written `0600` through the same atomic-replace helper
used for credentials. Deleting an entry revokes trust; deleting the file revokes
everything.

Trust is granted from the dialog omp-web shows when you open such a project, and
takes effect immediately: granting it invalidates the model cache and destroys
any running session for that working directory so the next one starts with the
project's resources loaded.

## Relationship to the CLI

The store is omp-web's own. Trusting a project in the browser does not change
what `omp` does in a terminal — the CLI already loads everything — and running
`omp` in a project does not mark it trusted for the browser.
