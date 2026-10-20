# Changelog

All notable changes to this distribution. Versions are independent of the
upstream line — see the Provenance section in the README.

## v0.11.0

### Sign-in

**The native Basic-Auth dialog is gone.** A browser without a valid session
cookie now gets a `302` to `/login` and the styled form, and nothing else.
Two things caused the dialog and both are removed from `proxy.ts`:

- The inline NGINX-style page that `unauthorizedPage()` returned as the
  non-navigation fallback is deleted. Nothing referenced it outside the branch
  that answered with it.
- `WWW-Authenticate` can no longer reach a browser. It is withheld from any
  request carrying Fetch Metadata — `Sec-Fetch-Mode` or `Sec-Fetch-Site`, which
  every browser sends on any request and no CLI sends — so a header that
  cannot arrive in a browser cannot open a dialog, whatever a future engine
  does with a `401` on an XHR.

**What did not change, for scripting clients.** An unauthenticated `/api/*`
request is still refused with `401` and the same body:

```bash
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/whoami   # 401
curl -s http://127.0.0.1:8080/api/whoami | jq -r .error                 # Authentication required
curl -u omp:'…' http://127.0.0.1:8080/api/whoami                          # 200
```

The challenge header itself is still sent to callers without Fetch Metadata, so
`curl --anyauth` and the Go/Java/Rust stacks keep working unchanged. Two
behaviours are worth knowing when a script reads a *page* URL rather than an
API one:

- `curl -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/` now answers
  `302`, not `401` — bare curl sends no fetch metadata and is read as a
  navigation. Use `-L` to follow it, or point the check at an `/api/*` route.
- `unavailable` still answers `503` and still answers `503` on `/api/*`, and a
  rejected request still refuses the same paths as before. Only the *form* of
  the refusal moved.

### Animations

- **The login scanline ran once and then went quiet for good.** Reported as
  "the animation on the login card is broken". It was not broken — it was a
  mis-timed loop, and the two read the same to the person looking at it.
  Measured in Chromium against production (card 470×410, the band's pixels
  compared against the parked state, both themes):

  | animTime | before | after |
  | --- | --- | --- |
  | 0 – 2400 ms | travelling, peak deviation 396 (light) / 366 (dark) | travelling, 3 runs of 2100 ms each |
  | 2400 – 3200 ms | — | rest, 1100 ms |
  | 3200 – 5600 ms | **nothing to see**, deviation 0 | travelling |
  | 5600 – 6400 ms | — | rest |
  | 6400 – 8800 ms | **nothing to see**, deviation 0 | travelling |
  | 8800 – 9600 ms | — | rest |
  | after | finished, `fill: both`, still forever | finished, still |

  The old cycle was 2.4 s travel against 4.8 s rest at
  `iteration-count: 1`, so 4.8 s of a 7.2 s cycle — two thirds — showed
  nothing, and after the single run nothing ever again. The rest was not calm:
  the parked band measures 15 (light) and 10 (dark) against 255 against bare
  panel, so a viewer got a card that stood still and read it as a failure. The
  cycle is now 3.2 s at 75 % travel and 25 % rest — the same ratio
  `@keyframes omp-shimmer-wash` uses — and runs three times, so 20 of the 20
  sampled frames in the first two seconds after page load are moving, in both
  themes.

  What did not change, and was checked rather than assumed: the card still
  stands still. The band is on `::after`, which carries `pointer-events: none`
  and changes no box, so the bounding box is **one** value over 591 sampled
  frames across 9.8 s — `425.72,250,482.56,400`, identical while the band is
  in motion — and all 15 `locator.click()` calls across the cycle pass in
  69–78 ms. It is also still finite: `iteration-count: 3`, never `infinite`,
  because the card standing still at the end was the point of the original
  change. The reported break was not in production either: the CSS module
  hashes served there (`login_scanline__BO0D1`, `login_login-scanline__CMDUD`)
  are identical to the local build's, and the runtime behaviour matched frame
  for frame.

**`motion` is now the single animation source.** The `.omp-*` classes and their
eighteen `@keyframes` are gone from `app/globals.css`; every moving surface now
runs through `components/motion/`. The duplicated `session-info-pop` keyframes
that lived in an inline `<style>` block inside `AppShell` are gone with them.

- **A global switch: Settings → Animations.** Full, Reduced or Off. It is stored
  as `omp-animations` in `localStorage`, deliberately not as a `/api/settings`
  key — that route projects a schema out of the pinned
  `@oh-my-pi/pi-coding-agent`, so a new path there would mean patching a
  foreign package for a value the server never reads. Off stands still
  regardless of the OS setting; Reduced defers to `prefers-reduced-motion`.
  Changing it takes effect without a reload, and `hooks/useTheme.ts` reads the
  same attribute so a theme change does not wipe while everything else stands
  still.
- **Loading states are no longer blank text or nothing at all.**
  - A session that is still loading shows three skeleton lines instead of a
    bare "Loading session" string.
  - The file explorer shows ten skeleton rows instead of "Loading files…", and
    the gear that appears while a directory opens now turns. It was rendered
    without any animation before, on a path the user takes on every folder
    click.
  - The terminal's "connecting…" chip runs as a shimmer, and the status dot in
    the terminal menu pulses while a session is running instead of standing
    still. Its colour is now `var(--success)` rather than a hard-coded hex, so
    an imported theme applies to it.
  - The models, skills and plugins detail panels render skeletons instead of
    leaving the whole area empty.
  - While the agent writes a message, a three-dot shimmer runs under it. That
  separates "the agent is thinking" from "the agent is writing" — previously
  only the first was visible.
- **The press feedback lost a distinction that no longer exists.**
  `.omp-press-scale` was needed because a CSS keyframe overwrote `transform`
  outright and clobbered an element's own rotation. Motion composes transforms,
  so it is now the same `whileTap` as the plain variant.
- SMIL `<animateTransform>` on the subagent spinner is replaced by motion.
  SMIL and motion on the same node fight each other.
- **The shimmer is on every surface now, for loading and for pop-up.** Two
  things had to be fixed for that to be true, and neither showed up in the code
  review:
  - The loading placeholder set `background` as a shorthand, which overwrote
    `background-image` — the gradient itself — so the shimmer rendered as a
    flat block. It is `backgroundColor` now.
  - The wash ran at 26 % accent and was invisible against the panel colour in
    both themes. It runs at 46 % with a light core, and it follows the active
    theme either way.
  - A panel that pops up now plays a one-shot wash on the way in. Rising and
    un-blurring alone says "it appeared"; the sweep says "it arrived". The
    endless variant belongs to loading surfaces only — on a finished panel it
    would never stop.
  - The plugins list, the access and account panels, and the two top-bar
    panels (system prompt and language) showed plain text or rendered as bare
    elements with no entrance at all. They shimmer now.
  - **The endless wash now ends.** It circles once, runs out, and only then
    begins again — on the login page and on every panel, since they share the
    one rule. The cause was not the looping but `background-repeat`, which the
    rule never set and which therefore defaulted to `repeat`. The band is a tile
    twice the element's width whose gradient is transparent over its outer 10 %
    at each end, which paints [20, 180] of each tile and leaves a clear gap of
    40 percentage points before the next tile's paint begins. The element's own
    window is 100 points wide, and a 100-point window cannot fit inside a
    40-point gap — so the neighbouring tile always closed in behind the band
    and refilled what it vacated, and the old travel had no empty moment
    anywhere in it. Travelling further could not have helped. The darkest point
    of that run was 0.19 against the band's 0.46, at 150 % of the way through,
    and that is a dim position rather than a cleared one.
    `background-repeat: no-repeat` is the condition for the run's endpoints
    being empty at all, and therefore for a rest existing between two runs: the
    run is now 190 % → -90 %, measured peak 0.0000 at both ends against 0.4600
    at the midpoint. The fade is the gradient's own transparent tail, measured
    decaying 0.38 → 0.27 → 0.16 → 0.05 → 0 across the last quarter of the run, so
    it needs no second `opacity` claim on the same pixels. The last quarter of
    the 1.6 s cycle is a rest: at 0.4 s it reads as a deliberate beat between
    passes, where a shorter one would be integrated back into continuous motion
    and a longer one would read as finished. Only the band rests — the surface
    underneath is the skeleton, the badge or the label, so a loading panel is
    never an empty one. `SHIMMER_DURATION` still rules the timing: the 75 % is a
    share of the cycle, not a second duration.

**Not verified in this release.** Stated plainly, because a release note that
claims more than was tested is worse than one that admits the gap:

- The sandbox was exercised on one host, on Linux, with `bubblewrap` present
  and unprivileged user namespaces enabled. The `userns-disabled` and
  Windows branches are covered by type and by the refusal contract, not by a
  run.
- The Docker image was built and `command -v bwrap` was confirmed inside it.
  The container was not started against a real multi-account setup.
- A working directory outside the account's home is now refused. If a
  deployment relied on opening a terminal in such a directory — an
  `~/omp-cwd-*` grant, for instance — that terminal will now be refused with a
  remediation instead of opening. Bind it deliberately rather than expecting it
  to keep working.
- The animation switch itself has **not** been exercised through a browser. The
  mode mapping, the fallback on an invalid stored value and the storage/DOM
  round trip are covered by `components/motion/motion.test.mjs`; the rendered
  motion is not. Verify it on a real session before relying on it.

### Terminal

**Tenant shells run in a user namespace.** `lib/sandbox.ts` builds a
`bubblewrap` argv whose only bind is the account's own home, and
`lib/terminal-manager.ts` replaces the shell command with it. Measured: a
foreign home answers `No such file or directory` rather than `Permission
denied`, `/etc/shadow` stays unreadable, and `uid=0` inside the namespace is
not host root. The OS-user-per-account route was measured and is unavailable
on the target host — no root, no sudo, `setpriv` answers `setresuid failed` —
and the namespace has the property that route would have broken: an
unprivileged namespace maps the fake uid back onto the service account, so the
service can still read and clean up after a tenant.

- `sandboxed` is now part of `GET /api/terminal` and `GET /api/terminal/<id>`.
  Without `bubblewrap` or with user namespaces disabled the shell still opens,
  unconfined, and the flag is `false` — the key is always present, never
  absent, so a client does not have to tell "not isolated" from "unknown".
- A working directory outside the account's home is refused as
  `cwd-outside-home` with a remediation, rather than passed through to fail
  later as `[Process exited with code 1]` in the SSE stream. A username that
  would escape its path segment is refused as `bad-username` instead of
  borrowing the unrelated `no-home` reason.
- Bind sources that the host does not have are skipped. `bwrap` aborts on a
  missing `--ro-bind` source rather than ignoring it, so a host without
  `/lib64` previously lost the terminal entirely.
- The Docker image installs `bubblewrap`. It is the one host where every
  terminal otherwise took the `bwrap-missing` branch.

### Quick phrases

**Saved texts are one click deep in the composer.** A phrase carries a button
label and, separately, the text to insert. Each configured phrase renders as a
button row above the input field; one click inserts its text **at the cursor
position**, keeping the text to the left and right of the caret untouched. The
full text is the button's tooltip, so a short caption can carry a long or
multi-line insertion.

- Managed in Settings → Quick phrases. The list is the button order; there is
  no separate sorting, grouping or shortcut layer, by design.
- **The list is stored on the server, one file per account.**
  `app/api/quick-phrases/route.ts` (GET/PUT) follows the `models-config` route:
  `requireIdentity`, `403` in both handlers, `415` without a JSON content type.
  The file is `omp-web-quick-phrases.json` inside
  `resolveTenantAgentDir(identity)` — the same directory the trust store uses —
  written with `writePrivateFileAtomicSync` (`0o600`, temp file plus rename).
  The path is checked with `isPathWithinRoots` **before** the directory is
  created, so a refused request leaves nothing behind in a foreign home.
  A `localStorage` list followed the browser, not the account: a second browser,
  a private window or a different workstation showed a different set, and
  changing machine lost it silently. The agent never reads these phrases, so
  they still do **not** go through `/api/settings` — that endpoint projects a
  schema owned by a pinned package, and extending it would mean patching
  `node_modules`.
- **Existing phrases migrate without loss.** At the first server fetch, if no
  file exists yet, the phrases from `omp-quick-phrases` move to the file. The
  defaults are seeded only when *both* legacy keys are absent — the same rule
  the old seed used, and for the same reason: overwriting a list the user
  wrote, at the moment of the first read, before they ever see it, is the worst
  thing a seed can do. The legacy keys are cleared after the `PUT` succeeds, so
  a server that goes down in between leaves the phrases in the browser to be
  offered again.
- A phrase without a non-empty `text` is dropped on read and on write: a button
  that inserts nothing is a silent malfunction. An empty label is allowed and
  falls back to the text, shortened to one line.
- The row does not wrap. On a 390 px screen with twenty phrases it stays a
  single 18 px-tall line that scrolls horizontally (measured: `scrollWidth`
  1540 vs `clientWidth` 330), so every phrase remains one click deep instead of
  costing three rows of transcript height.
- **Typing writes once, not once per letter.** The settings section debounces
  400 ms and additionally writes on field blur and on dialog close, so closing
  without touching anything else still persists. Delete and Add bypass the
  timer: a delete that waits for a debounce window looks to the user like the
  row came back.
- A failing server does not clear or freeze the view. The last list the user
  saw stays on screen and the settings section says what went wrong; a failed
  request is retried on the next load. The first fetch is single-flight, so
  composer and dialog mounted together cause one request, not two.
- The button label is user content and is never translated; only the settings
  section's own strings are.
- Seven defaults are seeded on the first fetch when there is nothing to
  migrate: `Research`, `Compare`, `Verify`, `Explain`, `Review`, `Tests`,
  `Fix`. The first three reach outward — they research a topic or compare
  options instead of talking about the code in the window, which is why they
  work with an empty input field. **Seen once, never again:** the existence of
  the file is what decides, not the list contents. Delete all seven and they
  stay gone, on every tab, every browser and across reloads. A file that exists
  but is empty is a decision, and an unreadable file counts as existing too —
  neither is topped up.

### Accounts

- Uploads in the file explorer land in the directory the user is looking at,
  not in the project root. `cwd` was passed down the upload chain where the
  current browse position was meant.
- Account creation checks `OMP_WEB_HOME_ROOT` before it creates anything, so a
  failure names the variable to set instead of surfacing a raw `EACCES` from
  `mkdir`. An existing, writable root is accepted even when its parent is
  read-only, and a root writable through group ownership is no longer
  refused.

### Interface

**The download button in the file explorer is always there.** It was rendered
only while the row was hovered and positioned absolutely over it, so a
download was reachable by pointer but not discoverable, and the overlay could
cover the file name it belonged to. Every file row now renders the anchor in
the normal flow with `flexShrink: 0`, and the row text gives way with an
ellipsis instead. The remaining hover-only buttons (image preview, mention)
derive their right offset from the same row-action constants, so they keep
their place without a second hardcoded inset, and the dead archive-specific
branch is gone.

### Projects

**A project view instead of a folder browser.** A new top-level view lists the
projects an account works on, with size, priority and todo progress, and can
create, rename and delete them. The registry is a JSON file per account in the
agent directory, following the existing `omp-web-quick-phrases.json` pattern and
the same atomic private write, so one account never sees another's list.
`GET`/`PUT /api/projects` reads and writes it, `DELETE /api/projects/[root]`
removes one entry.

- Deleting a project **checks the protection rule before the first write** and
  then hands session and folder removal to the existing handlers rather than
  reimplementing their cascade. Re-implementing it would duplicate
  `requireSessionAccess` and its deliberate 404-on-foreign-session answer, and
  the identity headers have to travel with the delegated request or the handler
  sees an anonymous one.

### Sign-in

The login field no longer arrives pre-filled with `omp`. The value was a
hardcoded state initial value, so the form suggested one account name to
everyone and a user had to clear it before typing their own.

## v0.9.0

The first release of the independent distribution. 98 files, +13,793/−352,
43 commits. Everything below exists only here.

### Security

**A client-supplied header granted full admin access.** `proxy.ts` set the
identity headers on a path that only ran when an identity already existed, so
on an unlocked server — the default, and the state of the machine this was
found on — the client-supplied `x-omp-admin: 1` survived into the route and
`owner-guard.ts` let it through without an ownership check. A forged header
plus an arbitrary username gave arbitrary write via another account's shell.
Found by execution, not by reading: `curl -H 'x-omp-user: root' -H 'x-omp-admin: 1'`
listed `/etc` with status 200.

**A refusal that had two causes.** The write boundary that keeps an admin from
writing `/etc` was verified by mutation, not by watching refusals. Such a file
is refused for two independent reasons — the root filter and the fact that it
sits in no project — so a test that only checks the refusal sees neither. The
coverage asserts the filtered *set* instead.

**Account names are validated before any directory is created**, so `../etc`
never becomes a path segment.

### Accounts

- Real per-account access replacing the single credential: an admin creates
  accounts, each gets its own home, `models.yml`, `config.yml`, sessions, and
  terminals.
- File access is a per-account root set rather than one process-wide allowlist.
  `/` and `OMP_WEB_ALLOWED_ROOTS` are added in the admin branch only.
- Admins can read `/etc` but not write to it — the write boundary is
  deliberately narrower than the read one.
- A foreign session or terminal answers `404`, not `403`, so a probe learns
  nothing about whether the id exists. The `agent/running` snapshot and its SSE
  stream filter too; they publish the ids the rest of the API addresses things
  by.
- A new account's config starts empty on purpose. Copying the operator's
  `models.yml` would hand his API key to the first tenant.
- `OMP_WEB_HOME_ROOT` documented. It is the one variable account creation
  needs, and it was in no documentation at all — the default `/home` is not
  writable by a service account, and the mkdir has no permission check, so
  account creation failed with a raw system error naming the server's path.

### Files

- The explorer tree became a permanent first tab: never closable, files open
  beside it, a button hands the tree back. Previously the tree was a fixed
  column and a preview rendered as a layer underneath it.
- The window portal-renders out of the sidebar. The sidebar sets `overflow-x:
  hidden` on the explore container, and `position: fixed` does not escape a
  clipping ancestor — on a phone the panel was cut in half down the middle.
  `DirectoryPicker` and `FileContextMenu` had always portalled for this reason;
  the explorer was the one overlay that did not.
- Write operations behind a guard: create, rename, move, copy, delete, upload.
- Context menu on tree rows, with a reusable target-folder dialog.
- Image preview with zoom and grid/list modes.

### Terminal

- PTY-backed shell in a browser tab, session-scoped, with input, resize, and a
  stream. On mobile the layout switches to a 90vh overlay.

### Interface

- Live CPU and RAM badge with a sparkline popover, reporting the container's
  actual limits rather than what the host kernel advertises.
- Cookie sessions on top of Basic Auth, a login page with a looping entrance
  animation, and a recovery flow.
- Opening a new tab scrolls it into view. The strip could already scroll;
  nothing asked it to, so on a narrow window the tab you just opened hung past
  the edge and looked clipped.

### Fixes

- A refocused dialog could sit in the background with no focus, taking no
  keypresses: the focus effect ran once against a panel that was not mounted.
- The context menu rendered 84px off.
- Long session titles in a tab appeared mid-component, as if truncated.
- CPU percent read from `os.cpus()` counted idle as busy and pinned at 100%.

### Documentation

- `AGENTS.md` now carries the per-account rules, the owner filter, and the
  statement that none of it is containment. The architecture diagram described
  `/api/sessions` with no ownership condition, which reads as "the tree is
  everyone's" — and it is, one tree owned by the service account.
- `docs/authentication.md` gained a section on where account homes live.

### Provenance

The upstream remote has been removed. There is no merge path and no automatic
tracking; pulling upstream changes in is now a deliberate operation. The npm
publish workflow inherited from the fork is disabled. Releases are GitHub
releases only, installed from a checkout or a release tarball.

### Internal

- `components/motion/animation-mode.ts` holds the animation-mode rules without
  React or JSX, so they can be tested directly instead of inferred from
  component source. `AnimationProvider.tsx` is only the React binding.
- Every primitive in `components/motion/` forwards its ref and the remaining
  motion props. Several popovers measure their own box to decide which way to
  open; a primitive that cannot hand back a ref gets reimplemented inline, and
  that is how the duplicated `session-info-pop` keyframes ended up in
  `AppShell` in the first place.
- `AGENTS.md` gained an "Animations" section recording the same decision, so
  the next animation does not go back to a keyframe or to `/api/settings`.
