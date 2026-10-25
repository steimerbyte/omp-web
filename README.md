<p align="center">
  <img src="./docs/hero.png" alt="omp-web — Browser workspace for omp" width="100%">
</p>

<p align="center">
  <a href="https://github.com/steimerbyte/omp-web/releases"><img src="https://img.shields.io/github/v/release/steimerbyte/omp-web?style=flat&colorA=222222&colorB=58A6FF" alt="Release"></a>
  <a href="https://github.com/steimerbyte/omp-web/blob/main/LICENSE"><img src="https://img.shields.io/github/license/steimerbyte/omp-web?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
</p>

# omp-web — this fork

This is a fork of [ddallabenetta/omp-web](https://github.com/ddallabenetta/omp-web),
which is itself a fork of [agegr/pi-web](https://github.com/agegr/pi-web). Upstream
gives you the browser workspace for omp: session browsing, real-time chat, model
roles, provider configuration, skill management and project file preview.

**This repository is the delta on top of that.** Everything upstream already does
is documented in the [upstream README](https://github.com/ddallabenetta/omp-web/blob/main/README.md)
and is not repeated here. What follows is only what this fork adds, why, and how
to use it.

The fork point is commit `0acce624` (2026-09-10); everything after it is the
work described here. Releases are cut from this repository only.

## What this fork adds

- **[A projects dashboard](#the-projects-dashboard)** — a second view: the account's
  project folders as cards, grouped by category, with size, chat count, open todos
  and last activity. Creating a project creates the folder; deleting it is guarded
  server-side.
- **[Folder sizes measured in the background](#the-sizes-are-measured-in-the-background)**
  — the size measurement left the request, so the board answers immediately
  instead of standing blank while the measurement runs.
- **[A rotating gradient border](#the-gradient-border)** — an optional ring around
  the chat input that turns while an agent is working.
- **[Real accounts](#real-accounts)** — per-account homes, configs, sessions,
  terminals and file access, with an admin role.
- **[A terminal in the browser](#the-terminal)** — a PTY-backed shell, sandboxed in
  a user namespace.
- **[A file explorer you can work in](#the-file-explorer)** — the tree became a
  tab of its own, in its own window, with write operations behind a guard.
- **[Editing files in the browser](#editing-files-in-the-browser)** — an Edit mode
  with `Ctrl+S`, atomic writes and conflict detection, plus a lazily loaded
  Diff tab.
- **[A motion system](#motion)** — `motion` as the single animation source, a
  global Full/Reduced/Off switch, and loading states that are not blank text.
- **[Quick phrases](#quick-phrases)** — saved texts, one click deep in the composer.
- **[A login page](#the-login-page)** — cookie sessions instead of the browser's
  native Basic-Auth dialog.
- **[Layout fixes](#layout-fixes)** — four defects that cost real usability, each
  with the measurement that found it.

## The projects dashboard

A second view next to the chat, reachable from the sidebar: the account's project
folders as cards, grouped by category, with a search field over the category strip.

Each card carries the folder path, the size, the chat count, the open todo
counter and the last activity; a project that is a git repository also shows its
branch. Creating a project creates the folder — the folder *is* the project, not
a label for one — and deleting it removes the folder with everything in it.

**The registry is per account**: `omp-web-projects.json` in the account's own agent
directory. The server writes it, atomically and with mode `0600`; the browser only
sends patches. A corrupt file is read as an empty but existing registry and is not
overwritten, because a seed over a damaged state would destroy work the user cannot
even see.

**Deleting is the sharp edge of the feature, so it is guarded server-side.** The
omp runtime directories, an ancestor of the home and any account's home directory
are refused, by resolved path and for every identity — the rule does not depend on
what the caller's home happens to be. The reason comes back with the answer, so
the UI can say "this is the running installation's own state" instead of "pick a
different folder". A folder with ten or more chats needs a confirmation that
repeats the chat count, and a count that no longer matches is refused as stale
rather than silently accepted.

### The sizes are measured in the background

`GET /api/projects` used to run `du -sb` per project inside the request, and the
board was empty for those seconds. The route now answers at once with the last
known size, the measurement runs behind it, and the client picks the new number up
from `GET /api/projects/sizes` — a cheap endpoint that reads one small JSON file
instead of starting a git process per project.

In production, against agent-pc, with five projects, the same endpoint answered
in **2073,3 ms** on a cold run before the change — the measurement ran inside the
request — and answers with a **median of 2,95 ms** now. The measurement is the
same work either way; it just no longer sits in the request path, and the sizes
are in the payload either way. A deliberately forced stale cold run on the new
build was **not** taken — the sizes were only 54 s old at first access — so what
the numbers show is the request without a measurement step, not a cold run
measured end to end. The full numbers, the measurement environment and what was
*not* verified are in [docs/spec.md](./docs/spec.md).

**The background run re-reads the registry immediately before it writes**, and
applies only the size fields — `sizeBytes`, `sizeMeasuredAt` and
`sizeIsLowerBound`. Without that second read it would write back a snapshot
taken up to twenty seconds earlier and silently overwrite whatever the user had
changed in the meantime — a priority, a todo counter, a status.

A folder that `du` could only read partly keeps the number `du` computed, as a
lower bound: the card shows a "≥", because a number that looks exact and is not
is worse than no number. The sizes also overlap — a parent's size contains its
children's bytes — so the sum on the cards is counted twice.

### The API

| Route | What it does |
| --- | --- |
| `GET /api/projects` | the registry, the derived project views and the categories |
| `PUT /api/projects` | patch the registry: rename a category, set a priority or a todo counter |
| `POST /api/projects` | create a project, which means creating its folder |
| `GET /api/projects/sizes` | the cheap poll: the last known sizes and a `pending` flag |
| `GET /api/projects/[...root]` | preview one project: chat count, entry count, whether a confirmation is required |
| `DELETE /api/projects/[...root]` | delete one project, behind the guards above |

## Real accounts

Upstream has a single credential that locks the whole interface. This fork has
real accounts: an admin creates them, each gets its own home directory, its own
`models.yml` and `config.yml`, its own terminal sessions, and its own view of
which sessions and shells exist.

File access is a per-account root set rather than one process-wide allowlist, and
an admin can read `/etc` but not write to it. Admins are `omp`, `pi` and
`steimerbyte` by default, overridable through `OMP_WEB_ADMINS` — the exemption is
deliberate and covers writes: a compromised admin password is host compromise,
not just a stolen tenant.

A foreign session or terminal answers **404, not 403**, so a probe learns nothing
about whether the id exists. A tenant's config starts empty on purpose, because
copying the operator's `models.yml` would hand his API key to the first tenant.

**One setting decides whether account creation works at all.** Creating an account
makes a directory for it, and the default parent is `/home`. An unprivileged
service account cannot write there. Set `OMP_WEB_HOME_ROOT` to somewhere the
service can write:

```bash
mkdir -p /home/pi/accounts && chown pi:pi /home/pi/accounts
# in the service unit:
Environment=OMP_WEB_HOME_ROOT=/home/pi/accounts
```

Stated plainly, because it is easy to read the above as more than it is: none of
this is containment. Every boundary is an assignment decided from data the service
process can write, so it stops an account from seeing another's work by accident
and through the routes that exist — not against someone who edits the underlying
files. Full threat model, including what this deliberately does *not* protect
against: [docs/authentication.md](./docs/authentication.md).

## The terminal

A PTY-backed shell in a browser tab, with input, resize and a stream. Each
terminal opens as a tab beside the file view, and the top-bar button lists the
running ones.

**Tenant shells run in a user namespace.** `lib/sandbox.ts` builds a `bubblewrap`
argv whose only bind is the account's own home, so a foreign home answers `No such
file or directory` rather than `Permission denied` — it does not exist inside
rather than merely being unreadable — `/etc/shadow` stays unreadable, and `uid=0`
inside the namespace is not the host's root. Where `bwrap` or user namespaces are
unavailable the shell opens unconfined and says so: `sandboxed` is `false` in
`GET /api/terminal`. The key is always present, never absent, so a client does not
have to tell "not isolated" from "unknown".

## The file explorer

The tree became a tab in its own right: a permanent first tab you cannot close,
files open beside it, and a button that hands the tree back. The window portals
out of the sidebar so it is a real overlay instead of a panel clipped to half the
screen on a phone.

Write operations — create, rename, move, copy, delete, upload — go through a
guard that was not there before. A route that writes and does not call it is a
hole: the write boundary is checked against the account, not just the path, and it
refuses the filesystem root even for an admin.

## Editing files in the browser

The file viewer has an **Edit** mode next to Source, Preview and Diff: open a
file, change it, save with `Ctrl+S` — no round trip to the terminal.

The write goes through `PUT /api/files/[...path]`, and it is written so that a
half-finished save cannot destroy the file:

- **Atomic writes** — temp file plus rename, so a crash mid-write leaves the
  original intact.
- **Conflict detection** — the client sends the mtime it opened the file with. A
  `409` on a stale mtime surfaces a "Reload from disk" banner instead of
  overwriting whatever changed in the meantime.
- **A realpath symlink guard before the write**, so a symlink cannot redirect
  the `PUT` outside the allowed roots.
- **A 256 KB size cap**, the same limit the read preview uses.
- **The editor refuses to offer a file it cannot write back losslessly.**

The **Diff** tab renders the working tree's changes, and it is loaded lazily:
`@pierre/diffs` and its two Shiki themes are the largest dependencies in the app
and are only ever needed once someone opens that tab, so they live in their own
chunk that the cold start never requests.

## The login page

Cookie sessions on top of Basic Auth, a proper login page, and a recovery flow.
A browser without a valid session cookie gets a `302` to `/login` and the styled
form — the native Basic-Auth dialog is gone, because `WWW-Authenticate` is
withheld from any request carrying Fetch Metadata, which every browser sends and
no CLI does.

Scripting clients are unaffected: an unauthenticated `/api/*` request is still
refused with `401`, and the challenge header still goes to callers without Fetch
Metadata, so `curl --anyauth` and the Go/Java/Rust stacks keep working unchanged.

The password is stored as a `scrypt` hash in `~/.omp/agent/omp-web-auth.json`
(mode `0600`) — never in plaintext, and never recoverable from the file. Session
cookies are additionally bound to the server process: the signing key is salted
with a random value generated at each cold start, so a cookie stops verifying
after a restart even though the credential itself did not change.

## The gradient border

A ring around the composer bar whose colours turn while an agent is working, and
which is gone the moment the agent stops. It is a new look, so it is **off by
default**. The user switches it on in **Settings → Animations**.

The defaults are a **6 px** ring, a **2.4 s** turn, the **Omphie** palette
(amber, green, blue, violet) and a glow at **0.25** with a **4 px** blur. The
panel offers four colour pickers, five presets, sliders for the width, the
rotation speed and the glow, and two ways of turning the gradient.

**A colour that vanishes on white is a colour that is not there.** The first
palette was measured against the two surfaces the bar stands on, and its green
reaches **1.34:1** against white — invisible as a line. A second palette,
**Omphie Light**, carries the same hues with depth: the four colours reach
3.19:1 at the weakest against white and keep 3.11:1 against the dark surface. The
glow was pulled back to 0.25 and its blur to 4 px for the same reason: at the
earlier values the halo, not the ring, was what the eye saw.

The ring is a band, not a frame. It lies outside the bar, covers the one pixel
border the bar has, and reaches **no pixel into the padding** the text lives in,
at any width. Getting that right took the geometry apart: the containing block of
an absolutely positioned layer is the **padding box** of its positioned ancestor,
not the border box, so the offsets have to be the width plus the border on both
sides. The formula lives in `components/motion/gradient-border-settings.ts` and a
test holds it down.

The rotation runs **only while an agent is working** — a running shell command
does not light it up, because the busy state of the surface and the state of the
agent are not the same thing.

## Motion

`motion` is the single animation source. Every moving surface runs through
`components/motion/` — the primitives are `Shimmer` (loading wash), `Skeleton`
(loading placeholder), `Reveal` (panel entrance), `Pressable` (tap feedback) and
`Enter` / `ModalBackdrop` / `ModalPanel` / `Spin`. The hand-written keyframes
that used to drive the panels and the loading states are gone, and a primitive
that does not fit a callsite gets widened rather than reimplemented inline.

**Settings → Animations** holds a global switch: Full, Reduced or Off. It is
stored as `omp-animations` in `localStorage`, deliberately not as an `/api/settings`
key — that route projects a schema out of the pinned
`@oh-my-pi/pi-coding-agent`, so a new path there would mean patching a foreign
package for a value the server never reads. Off stands still regardless of the OS
setting; Reduced defers to `prefers-reduced-motion`.

Loading states are no longer blank text or nothing at all: a session that is still
loading shows three skeleton lines, the file explorer shows ten skeleton rows, the
terminal's "connecting…" chip runs as a shimmer, and the models, skills and
plugins panels render skeletons instead of leaving the whole area empty.

## Quick phrases

Saved texts are one click deep in the composer. Each configured phrase renders as
a button row above the input field; one click inserts its text **at the cursor
position**, keeping the text to the left and right of the caret untouched. The
full text is the button's tooltip, so a short caption can carry a long or
multi-line insertion.

The list lives on the server, one file per account
(`omp-web-quick-phrases.json`), written atomically with mode `0600`. A
`localStorage` list followed the browser, not the account: a second browser, a
private window or a different workstation showed a different set, and changing
machine lost it silently. Existing phrases migrate on the first server fetch.

Typing writes once, not once per letter: the settings section debounces 400 ms
and additionally writes on field blur and on dialog close. Delete and Add bypass
the timer — a delete that waits for a debounce window looks to the user like the
row came back.

## Layout fixes

Four defects that cost real usability, each found by measuring rather than by
looking.

**The settings window cut off part of its own content, with no scrollbar to show
for it.** `.window` is `display: grid` with `grid-template-columns` but no
`grid-template-rows`, so its single row was an implicit `auto` row — sized by its
content — while the box was bounded by `height`. The row grew past the box and
`overflow: hidden` cut it away. Measured on a production build, with the Models
section open: at 390x844 **141px** were cut off and **28** buttons lay below the
bottom edge; at 1440x900, **53px** and **7** buttons. `document.elementFromPoint`
on the centre of one of those buttons returned the backdrop, not the button. The
rule `grid-template-rows: minmax(0, 1fr)` bounds the row to the window, and
`.content` scrolls internally.

**Every project card drew its path backwards.** The path sits in a
`direction: rtl` box, which is what makes the truncation happen at the *start* so
the informative end stays on screen. That same directive reorders the glyphs:
measured in Chromium, the leading `/` was painted at the **end** of the string, so
every card read `home/steimmerbyte/workspace/omp-web/` instead of
`/home/steimmerbyte/workspace/omp-web`. The path is now wrapped in
`<bdi dir="ltr">`, which isolates it as left-to-right while the box around it
stays RTL.

**The board rearranged itself after a thirty-second wait.** The skeleton and the
real grid asked for different column rules — the skeleton for a fixed
`repeat(3, minmax(0, 1fr))`, the real grid for
`repeat(auto-fill, minmax(258px, 1fr))` — so the columns could not agree. Both
grids now take one shared rule, and the card's own height is a constant the
skeleton imports rather than a number copied out of a comment.

**The file explorer's separator line no longer crosses the tree on a phone.** The
section was content-sized, so its height depended on the tree and the tree's own
height measurement depended on the section — a feedback loop that settled at the
minimum, and the `border-bottom` landed in the middle of a row. The section now
takes the space it has, and the line is gone.

The measurements, the viewports and the tests that hold each fix are in
[docs/spec.md](./docs/spec.md).

## Documentation

| Document | What it holds |
| --- | --- |
| [docs/spec.md](./docs/spec.md) | The projects feature as a contract: the API, the view, the layout invariants with their measurements, the production verification, and the open points. |
| [docs/authentication.md](./docs/authentication.md) | Accounts, sessions, the per-account boundaries and the recovery threat model — including what they do *not* protect against. |
| [docs/known-findings.md](./docs/known-findings.md) | Defects that were found and deliberately **not** fixed, each with the condition under which it changes. |
| [docs/inventory-api.md](./docs/inventory-api.md) | Every API route: what it does, whose identity it needs, what it reads and what it writes. |
| [docs/inventory-auth.md](./docs/inventory-auth.md) | The auth and identity surface, route by route. |
| [docs/inventory-tools.md](./docs/inventory-tools.md) | File operations, the terminal and the sandbox. |
| [docs/inventory-ui.md](./docs/inventory-ui.md) | The user interface, element by element. |
| [docs/project-trust.md](./docs/project-trust.md) | Which of a project's resources need an explicit trust decision. |
| [docs/worktrees.md](./docs/worktrees.md) | The Git worktree switcher. |
| [docs/docker.md](./docs/docker.md) | The container: volume layout, UID/GID matching, reverse proxy. |
| [docs/calendar.md](./docs/calendar.md) | The calendar as delivered: the German conventions, the agent tools, the API and the per-account boundary. |
| [docs/i18n.md](./docs/i18n.md) | Translations and adding languages or UI text. |
| [docs/release.md](./docs/release.md) | The release checklist. |
| [CHANGELOG.md](./CHANGELOG.md) | What changed, with the measurements, per release. |

## Development

```bash
bun install
bun run dev
```

The local dev server runs at [http://127.0.0.1:30141](http://127.0.0.1:30141).

Common checks:

```bash
bun run typecheck
bun run lint
bun test
```

Avoid running `bun run build` during local development. It writes to `.next/` and
can interfere with the dev server; leave builds for release work.

Everything runs on **Bun**: `@oh-my-pi/pi-*` is published as TypeScript sources and
imports `bun:sqlite`, so the server half cannot load under Node at all.
`scripts/run-next.mjs` exists because of that — it keeps the Bun runtime by
construction instead of relying on a shebang that Bun may hand to Node.

The Docker image installs `bubblewrap`, because it is the one host where every
terminal would otherwise take the `bwrap-missing` branch.

## Upstream and license

This fork descends from [ddallabenetta/omp-web](https://github.com/ddallabenetta/omp-web),
which descends from [agegr/pi-web](https://github.com/agegr/pi-web). The upstream
remote has been removed, so there is no merge path and no automatic tracking;
pulling upstream changes in is a deliberate operation — re-add the remote, fetch,
and reconcile by hand.

Everything upstream does — session browsing, model roles, worktrees, provider and
skill configuration, the theme mapping — is documented in the
[upstream README](https://github.com/ddallabenetta/omp-web/blob/main/README.md).

The MIT license is unchanged. See [LICENSE](./LICENSE).

Releases are cut from this repository only. The npm publish workflow that came
with the fork is disabled here — this distribution is installed from a checkout
or a release tarball, not from the registry.
