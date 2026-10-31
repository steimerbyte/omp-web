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

Two kinds of thing: resources omp *executes*, and project skills, which omp
*folds into the system prompt*.

| Kind | Paths |
| --- | --- |
| Extensions | `.omp/extensions`, `.pi/extensions`, `.claude/extensions`, `.agents/extensions` |
| Hooks | the `hooks/` directory under each of those config roots |
| Custom tools | the `tools/` directory under each of those config roots |
| MCP servers | `.mcp.json`, `.omp/.mcp.json`, `.omp/mcp.json`, `.claude/.mcp.json`, `.claude/mcp.json`, `.cursor/mcp.json` |
| Project skills | `.omp/skills`, `.agent/skills`, `.agents/skills`, `.claude/skills`, `.codex/skills`, `.github/skills`, `.opencode/skills` |

Project skills are the one *prompt-only* entry on that list. They are not
executed, so they cannot be gated by dropping modules — but the model reads
them, and a repository the user merely opened must not be able to write into the
agent's instructions on its own. Measured before this gate: an untrusted
checkout carrying `.agents/skills/evil/SKILL.md` had that skill in the session
while its `.omp/extensions` stayed dormant.

Rules, prompts and `AGENTS.md` remain ungated. Gating them would be a boundary
in name only — a project carrying nothing but `.omp/APPEND_SYSTEM.md` or
`AGENTS.md` never requires trust in the first place — and `AGENTS.md` is what
makes an ordinary repository legible to the agent at all.

That explicitly includes a project's `SYSTEM.md` and `APPEND_SYSTEM.md`
(`lib/session-system-prompt.ts`): omp-web resolves them for a browser session
the way `omp` resolves them for a terminal one, trusted project or not.

A project with none of the above never sees a prompt: `requiresTrust` is false
and the session loads on omp's normal path.

## What the gate actually does

When a project needs trust and has not been trusted, omp-web still runs omp's
own discovery, then removes the project-local entries from the result before
handing it to `createAgentSession`:

- `preloadedExtensionPaths` — discovered extensions minus anything under the
  project root
- `preloadedCustomToolPaths` — discovered tools minus anything marked
  `level: "project"` or living under the project root
- `enableMCP: false` — MCP servers are processes omp would spawn from a
  project manifest
- `skills` — discovered skills minus every entry marked `level: "project"` and
  minus every entry whose file lives under the project root
  (`trustedProjectSkills`)

The last one needs both halves. The level catches every project scan the loader
runs, whichever provider found it. The path catches the case the level cannot:
a custom directory is labelled `custom:user` however it was configured, and a
project's own `.omp/config.yml` can point `skills.customDirectories` at itself —
measured, not hypothetical.

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

A session in an untrusted project keeps its filtered list across `/reload`:
handing `createAgentSession` a skill list sets `skillsReloadable: false`
(`sdk.ts`), so `refreshSkills()` rebuilds the prompt without rediscovering. New
user-level skills appear at the next session start, which is also where the
filter runs again.

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
