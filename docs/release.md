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
bun run typecheck
bunx eslint components/ app/ lib/
bun test
bun run build
```

`package.json` and the tag must agree. The release workflow does not check
this, and a mismatch ships a release whose tarball reports the wrong version.

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

In this fork the workflows also have to be enabled once before any of them can
run: Settings -> Actions -> General -> "Enable Actions". This is a browser
step; there is no API endpoint for it, and the `actions/permissions` endpoints
only describe the *action policy*, not the fork's opt-in. Without this opt-in
no workflow starts at all — including `ci.yml`, which triggers on pushes to
`main` and on pull requests. As of this writing the fork has no workflow runs
in its entire history, has no repository secrets configured, and a pushed `v*`
tag is the only trigger that exists.

Pushing a `v*` tag starts one workflow:

- `publish-desktop.yml` builds macOS (universal) and Windows bundles and uploads
  them to the release. It needs `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` configured; without them the job fails
  and no desktop artifact is produced. The web release is unaffected.

`update-omp.yml` is not triggered by the tag push. It runs on a schedule
(`cron: "17 * * * *"`, hourly), on `workflow_dispatch`, and on closed pull
requests. It does not only check the pinned omp version — it opens a pull
request: the job "Open omp dependency PR" uses
`peter-evans/create-pull-request@v7` to create a branch `automation/omp-<version>`
and open a PR against `main`. The merge is done by hand; the workflow does not
push to `main` itself.

## Writing release notes

`gh release create v0.9.0 --title "v0.9.0" --notes-file CHANGELOG.md`

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

An empty asset list is not an edge case, it is the normal outcome of a
workflow that never ran. Read it as "the workflow did not run", not as "there
is nothing to publish yet". A release can exist, carry the right notes and
point at the right tag, and still have zero assets. That is the case for all
four releases published so far — v0.9.0, v0.10.0, v0.11.0 and v0.12.0 all
have zero assets, and the fork has zero workflow runs in its entire history,
so no workflow ran for any of them. For v0.12.0 the trigger is known in
addition: the tag was created through the GitHub API rather than by
`git push`, which would have prevented the workflow from starting even with
execution enabled. `gh run list --workflow publish-desktop.yml` is the check
that tells the two apart: empty output means the workflow never ran, so the
missing assets are a trigger problem, not a build problem.

Do not use `workflow_dispatch` on `publish-desktop.yml` as a way to backfill a
release that is already published without assets. The workflow overwrites the
release it runs against: it sets the release name to `omp-desktop v<version>`
and replaces the body with a one-line summary, so the notes written via
`gh release create --notes-file` are lost. Fix the trigger instead — push the
tag, and make sure the workflows are enabled in the fork.

Then install it the way a user would — clone, `bun install`, `bun run build`,
start it — and exercise the multi-account path with two real accounts. A
release that has not been signed into is not a verified release.
