# Release Checklist

This repo publishes one artifact: a **GitHub Release** in
`steimerbyte/omp-web`.

There is no npm package. The `publish-npm.yml` workflow inherited from the
fork is disabled, and `OMP_WEB_*` releases are installed from a checkout or a
release tarball. Do not re-enable it without deciding to publish to the
registry again — the package name `omp-web` belongs to the upstream line.

There is also no upstream remote. Pulling upstream changes in is a deliberate
operation: re-add the remote, fetch, and reconcile by hand. See the Provenance
section in the README.

## Before tagging

From a clean checkout of the branch you are releasing:

```bash
git status --porcelain            # must be empty
bun install --frozen-lockfile     # scripts/deploy-local.sh does NOT run this
bun run typecheck
bunx eslint components/ app/ lib/
bun test
bun run build
```

The `bun install` line is not ceremony. `scripts/deploy-local.sh` contains no
`bun install` (grep returns nothing), and its rsync excludes `node_modules/` —
so the script builds against whatever install the dev checkout already has.
`next.config.ts` keeps every `@oh-my-pi/*` request as a runtime import
(`OMP_SDK_REQUEST = /^@oh-my-pi\//`, plus `serverExternalPackages`), which means
a stale install does not fail the build: it builds green and boots the old SDK
under the new code. A green verify build therefore says nothing about the
dependencies. Install in the dev checkout before you run the script.

`package.json` and the tag must agree *in the source*. The release workflow
does not check this, and a mismatch ships a release whose tarball reports the
wrong version.

The checkout you release from is `/home/pi/workspace/omp-web-dev`, **not** the
live one. `/home/pi/omp-web` is an rsync target: `scripts/deploy-local.sh`
copies the tree from the dev source (node_modules excluded, `.git` untouched).
Its git store is therefore not a description of what runs there — `HEAD` is
`bbeaf3f`, eight commits after `v0.21.0` (`git describe`:
`v0.21.0-8-gbbeaf3f`), and its `package.json` still says `0.21.0` with
`## v0.21.0` on top of the CHANGELOG, because the bump happens at release time.
The deployed commit `8441c7e` is not in that store at all.

38 of the 39 modified files and all 13 untracked ones are the release. The
52nd entry is `scripts/register-minimax-mcp.ts` — a tracked file whose live copy
was hand-edited into a variant that exists in no commit (its content hashes
differ from both `8441c7e:` and `bbeaf3f:`). It reads the MINIMAX key from a
file instead of the environment, its mtime 00:22:28 is after the rsync
(00:19:32) and after the build (00:22:08), and a fresh deploy would discard it:
keep it and re-apply after each deploy, or move the variant into the dev source
before the next one.

That makes the usual recovery reflexes destructive. `git checkout .`,
`git checkout -- <file>` and `git clean -fd` in the live directory would revert
the 39 modified files to `bbeaf3f` and delete the 13 untracked ones — while
`.next` keeps serving `8441c7e`, so the checkout and the running server
disagree and nothing tells you. `git pull -f` looks like the same trap and is
not: the live checkout is detached (`HEAD detached at bbeaf3f`, no upstream),
so a pull exits with "You are not currently on a branch" and leaves the tree
alone — the detached state is why it cannot silently do it. Recovery is a fresh
deploy from the dev checkout, not a git command. And when you want to know what
is running, read `package.json` on disk — a commit is not what serves requests.

Update `CHANGELOG.md` with what changed, grouped by kind. Say plainly what was
*not* verified — a release note that claims more than was tested is worse than
one that admits the gap.

## Tagging

```bash
git tag -a v0.9.0 -m "v0.9.0"
git push fork v0.9.0
```

`gh release create` creates the tag itself when it does not exist yet, and it
does so through the GitHub API. A tag created through the API does not
produce a `push` event, so `publish-desktop.yml` — which triggers on
`on: push: tags: "v*"` — never starts. The order is therefore part of the
procedure: **push the tag first, then create the release.** Reversed, the
desktop workflow does not run and the release ends up without artifacts.

In this fork the workflows had to be enabled once before any of them could
run: Settings -> Actions -> General -> "Enable Actions". That is a browser
step with no API endpoint — the `actions/permissions` endpoints only describe
the *action policy*, not the fork's opt-in. **It has been done**: the v0.22.0
tag push started `publish-desktop.yml` (run `41366152324`), so tag-triggered
workflows run now. A pushed `v*` tag is still the only trigger that produces a
release artifact.

Pushing a `v*` tag starts one workflow:

- `publish-desktop.yml` builds macOS (universal) and Windows bundles and uploads
  them to the release. It needs `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` configured; without them the signing step
  fails and no desktop artifact is produced. The web release is unaffected.
- **v0.22.0 is the measured case, and it has two independent blockers.** Run
  `41366152324` is the repo's only `publish-desktop` run, `completed/failure`,
  with no assets on the release.
  1. **Windows, a build-stage fault unrelated to signing.** The job failed at
     step "Build and stage the server payload" with
     `EPERM: operation not permitted, scandir 'C:/Users/runneradmin/Cookies'`,
     which webpack reports as an error, ending in
     `[stage-desktop] next build failed`. The Rust setup and upload steps were
     skipped.
  2. **macOS, the signing key.** The job passed the server staging and failed at
     "Build bundles and publish GitHub release" with `failed to decode secret
     key: incorrect updater private key password: Missing comment in secret
     key`. `gh api .../actions/secrets` reports `total_count=0`, so the command
     needs a configured secret with a comment in the key.
  So adding the key alone leaves Windows red: the desktop pipeline has never
  produced an artifact, and the two repairs are separate.

`update-omp.yml` is not triggered by the tag push. It runs on a schedule
(`cron: "17 * * * *"`, hourly), on `workflow_dispatch`, and on closed pull
requests. It does not only check the pinned omp version — it opens a pull
request: the job "Open omp dependency PR" uses
`peter-evans/create-pull-request@v7` to create a branch `automation/omp-<version>`
and open a PR against `main`. The merge is done by hand; the workflow does not
push to `main` itself.

## Writing release notes

Pass the release section of the changelog, not the whole file:

```bash
awk '/^## v0.22.0/{f=1} f && /^## v/ && !/^## v0.22.0/{exit} f' \
  CHANGELOG.md > /tmp/notes.md
gh release create v0.22.0 --title "v0.22.0" --notes-file /tmp/notes.md
```

`--notes-file CHANGELOG.md` was the procedure and it fails once the changelog
grows: v0.22.0 answered **HTTP 422 "body is too long (maximum is 125000
characters)"**, because the file is 166487 bytes. The extracted section for
that release was 38256 bytes, comfortably inside the limit. Keep the full file
for the local CHANGELOG; the release body gets the section, from `## vX.Y.Z`
to the line before the next `## v`.

The notes go on the release page. Keep them honest about what a user has to
configure — an admin deploying this for the first time needs to know that
account creation needs `OMP_WEB_HOME_ROOT` set, and that finding out through a
raw `EACCES` naming the server's own path is a bad first impression.

## Verifying a release

After tagging, check that the thing actually works, not that the workflow went
green:

```bash
gh release view v0.9.0                    # assets present
git ls-remote --tags fork v0.9.0          # tag points where you expect
gh run list --workflow publish-desktop.yml   # did the workflow run at all
```

An empty asset list does not by itself tell you why. Read `gh run list` next to
it: `gh run list --workflow publish-desktop.yml` is what separates the two
causes. Empty output means the workflow never ran, so the assets are missing
for a **trigger** reason (API-created tag, or Actions not enabled). A run that
exists but produced no assets is a **build or signing** problem, and which one
is in the job log. v0.22.0 hit both: run `41366152324` is the repo's only
`publish-desktop` run and it is `completed/failure`; Windows failed at "Build
and stage the server payload" with
`EPERM: operation not permitted, scandir 'C:/Users/runneradmin/Cookies'`, macOS
passed that staging and failed at "Build bundles and publish GitHub release"
because the updater secret is unset (`gh api .../actions/secrets` says
`total_count=0`). The older releases (v0.9.0, v0.10.0, v0.11.0, v0.12.0) were
the other case: no run at all. A release can exist, carry the right notes and
point at the right tag and still have zero assets.

Do not use `workflow_dispatch` on `publish-desktop.yml` as a way to backfill a
release that is already published without assets. The workflow overwrites the
release it runs against: it sets the release name to `omp-desktop v<version>`
and replaces the body with a one-line summary, so the notes written via
`gh release create --notes-file` are lost. Fix the trigger instead — push the
tag, and make sure the workflows are enabled in the fork (they are, since
v0.22.0). Then fix the two blockers that run exposed: the Windows payload stage
cannot scan `C:/Users/runneradmin/Cookies`, and the updater signing secret does
not exist; the desktop pipeline has not produced an artifact yet, so its first
success is still to come.

Then install it the way a user would — clone, `bun install`, `bun run build`,
start it — and exercise the multi-account path with two real accounts. A
release that has not been signed into is not a verified release.
