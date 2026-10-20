import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  isProtectedProjectRoot,
  protectedRootReason,
  countTreeEntries,
  DELETE_CONFIRMATION_CHAT_THRESHOLD,
} = await jiti.import("./projects-delete.ts");

const HOME = "/home/tester";

/**
 * The folders the projects dashboard may never delete.
 *
 * ### Why the first block is the one that matters
 *
 * `lib/write-access.identity.test.mjs` exists because of a specific failure:
 * `/etc/passwd` is refused for *two* independent reasons, so a test that only
 * watched refusals stayed green while the one load-bearing check was deleted.
 * One refusal, two causes, no signal about which one is doing the work.
 *
 * That is exactly the trap here. Asserting "a normal project path is allowed"
 * passes for any implementation, including one that protects nothing. So the
 * blocked list below is asserted path by path, and each entry names the rule
 * that must catch it. If a rule is removed, a specific line in this file
 * fails — not a generic "some things are still refused" count.
 */
test("every path that must never be deleted is refused", () => {
  const blocked = [
    // The filesystem root, and the user home itself.
    ["/", "filesystem-root"],
    [HOME, "home"],
    // System trees, at the root and one level down.
    ["/etc", "system-path"],
    ["/etc/ssl", "system-path"],
    ["/usr", "system-path"],
    ["/usr/local", "system-path"],
    ["/var", "system-path"],
    ["/var/lib/docker", "system-path"],
    ["/bin", "system-path"],
    ["/lib", "system-path"],
    ["/boot", "system-path"],
    ["/dev", "system-path"],
    ["/proc", "system-path"],
    ["/sys", "system-path"],
    // The live Compose root from the design conversation, and its parent.
    [`${HOME}/docker`, "home-child"],
    // Depth 2, so the depth rule does not reach it — the explicit child list
    // does, and names it more precisely. That distinction is the reason the
    // two reasons are not the same string.
    [`${HOME}/docker/stacks`, "protected-home-child"],
    [`${HOME}/Documents/Archive`, "protected-home-child"],
    // Ordinary user data at depth 1.
    [`${HOME}/Documents`, "home-child"],
    [`${HOME}/Desktop`, "home-child"],
    [`${HOME}/Downloads`, "home-child"],
    [`${HOME}/.ssh`, "home-child"],
    // Changed from "home-child" to "omp-runtime" by the 2026-10-20 fix. The
    // path was already refused; the reason is now the accurate one, and the
    // test is the place that records the difference.
    [`${HOME}/.omp`, "omp-runtime"],
  ];

  for (const [path, reason] of blocked) {
    assert.equal(
      isProtectedProjectRoot(path, HOME),
      true,
      `${path} must be refused — deleting it is not the dashboard's decision`,
    );
    assert.equal(
      protectedRootReason(path, HOME),
      reason,
      `${path} must be refused for the "${reason}" reason`,
    );
  }
});

/**
 * The counterweight: the rule must not swallow real projects.
 *
 * A guard that refuses everything would pass the block above. These are the
 * folders the feature exists for.
 */
test("every real project folder is allowed", () => {
  const allowed = [
    // Note: `${HOME}/workspace` itself is NOT here. It sits at depth 1, and
    // depth 1 under the home is refused — deleting the folder that holds every
    // project is not one of the dashboard's decisions. Its children are.
    `${HOME}/workspace/omp-web`,
    `${HOME}/workspace/omp-web/src`,
    `${HOME}/workspace/ki-news-pipeline`,
    `${HOME}/workspace/some/deep/nested/project`,
    `${HOME}/projects/thing`,
    // A name that merely *starts* like a protected one must not match: the
    // comparison is per path segment, so `/etcetera` is not `/etc`.
    "/etcetera",
    "/usrshare",
    `${HOME}/workspace/docker-compose-set`,
    `${HOME}/workspace/Documents`,
  ];

  for (const path of allowed) {
    assert.equal(
      isProtectedProjectRoot(path, HOME),
      false,
      `${path} is a project and must be deletable`,
    );
    assert.equal(protectedRootReason(path, HOME), null);
  }
});

/**
 * The prefix trap. A `startsWith("/etc")` implementation protects `/etcetera`
 * and, on the other side, fails to explain itself: the block above would still
 * pass, so this line is the only thing pinning segment-boundary matching.
 */
test("protected names match on segment boundaries, not as string prefixes", () => {
  assert.equal(isProtectedProjectRoot("/etcetera", HOME), false);
  assert.equal(isProtectedProjectRoot("/etcetera/project", HOME), false);
  assert.equal(isProtectedProjectRoot("/usrshare/thing", HOME), false);
  // …and the real thing stays protected despite those neighbours.
  assert.equal(isProtectedProjectRoot("/etc/ssl", HOME), true);
  assert.equal(isProtectedProjectRoot("/usr/share", HOME), true);
});

test("traversal cannot be used to walk around the guard", () => {
  // Every one of these resolves to a protected folder. If the rule compared
  // the raw string instead of the resolved path, the traversal would smuggle
  // the request past it.
  const escapes = [
    `${HOME}/workspace/../Documents`,
    // Three levels up, because `/home/tester/workspace/../../etc` is
    // `/home/etc` — a different folder, and not one this guard covers.
    `${HOME}/workspace/../../../etc`,
    `${HOME}/workspace/../../../usr`,
    `${HOME}/workspace/../../..`,
    `${HOME}/Documents/../Documents/private`,
    `${HOME}/workspace/project/../..`,
  ];

  for (const path of escapes) {
    assert.equal(
      isProtectedProjectRoot(path, HOME),
      true,
      `${path} resolves into a protected folder and must be refused`,
    );
  }
});

test("traversal that lands on a real project stays allowed", () => {
  // The mirror image: normalization must not protect a folder by accident,
  // or the dashboard becomes useless for every project reached through a
  // relative path.
  assert.equal(isProtectedProjectRoot(`${HOME}/workspace/a/../b`, HOME), false);
  assert.equal(isProtectedProjectRoot(`${HOME}/x/../workspace/y`, HOME), false);
});

test("the boundary is depth, and it stops exactly where projects begin", () => {
  // Depth 1 under home: refused.
  assert.equal(isProtectedProjectRoot(`${HOME}/anything`, HOME), true);
  // Depth 2: a project.
  assert.equal(isProtectedProjectRoot(`${HOME}/workspace/proj`, HOME), false);
  // …and it stays a project however deep it goes.
  assert.equal(isProtectedProjectRoot(`${HOME}/workspace/a/b/c/d/e`, HOME), false);
});

test("a path outside the home is judged on the system rules, not the home rules", () => {
  // `/opt/data/project` is not under the home, so the depth rule must not
  // apply to it — but it is still below a system root.
  assert.equal(isProtectedProjectRoot("/opt/data/project", HOME), true);
  assert.equal(isProtectedProjectRoot("/srv/app", HOME), true);
});

test("an empty or whitespace path is refused, not passed through", () => {
  // `path.resolve("")` returns the cwd, which on a dev box is inside the
  // project tree and would compare as allowed. Refusing the degenerate input
  // is the safe answer and costs nothing.
  assert.equal(isProtectedProjectRoot("", HOME), true);
  assert.equal(isProtectedProjectRoot("   ", HOME), true);
});

test("a home with a trailing slash behaves like one without", () => {
  assert.equal(isProtectedProjectRoot(`${HOME}/Documents`, `${HOME}/`), true);
  assert.equal(isProtectedProjectRoot(`${HOME}/workspace/p`, `${HOME}/`), false);
});

test("the reason is specific enough to act on", () => {
  // "This may not be deleted" is not actionable on its own; the caller has to
  // be able to tell a wrong-choice folder from a never-a-project folder.
  assert.equal(protectedRootReason("/", HOME), "filesystem-root");
  assert.equal(protectedRootReason(HOME, HOME), "home");
  assert.equal(protectedRootReason("/etc", HOME), "system-path");
  assert.equal(protectedRootReason(`${HOME}/Documents`, HOME), "home-child");
  assert.equal(protectedRootReason(`${HOME}/workspace/proj`, HOME), null);
});

/**
 * The 2026-10-20 incident, as a test.
 *
 * 130 chats were destroyed because `DELETE /api/projects/home/steimerbyte/.omp`
 * was not refused. The mechanism was measured, not guessed: `getUserHome()`
 * returns `/` for an admin, so every home-derived rule in this file was
 * evaluated against the filesystem root and `/home/steimerbyte/.omp` sat at
 * depth 3 — outside the depth-1 rule that normally protects `~/.omp`.
 *
 * These cases are written against **every** home value a caller can hand in,
 * because the bug was precisely that the answer depended on that value. A test
 * that only checks the non-admin home would have stayed green through the
 * incident.
 */
test("the agent directory is refused for every identity, including an admin whose home is /", () => {
  // `ADMIN_HOME` is `getUserHome({isAdmin:true})` on this codebase — verified by
  // execution, not read from the source. It is the value that made the depth
  // rule miss.
  const ADMIN_HOME = "/";
  // The real runtime tree on this host, from `getAgentDir()` /
  // `getConfigRootDir()`. Written out so the test states what it protects
  // instead of asking the module under test where its own roots are.
  const AGENT_DIR = `${HOME}/.omp/agent`;
  const SESSIONS_DIR = `${AGENT_DIR}/sessions`;

  for (const home of [ADMIN_HOME, HOME, `${HOME}/`]) {
    for (const target of [
      `${HOME}/.omp`,
      AGENT_DIR,
      SESSIONS_DIR,
      `${HOME}/.omp/plugins`,
      `${HOME}/.omp/profiles/work/agent`,
    ]) {
      assert.equal(
        isProtectedProjectRoot(target, home),
        true,
        `${target} must be refused with home ${home} — this is the incident case`,
      );
      assert.equal(
        protectedRootReason(target, home),
        "omp-runtime",
        `${target} must be refused as the omp runtime, not as some other rule`,
      );
    }
  }
});

test("another account's agent directory is refused too", () => {
  // Not this identity's tree, and not the service account's either. The rule is
  // on the folder's name, so it does not need to know whose `.omp` this is.
  assert.equal(isProtectedProjectRoot("/home/someone-else/.omp", HOME), true);
  assert.equal(protectedRootReason("/home/someone-else/.omp", HOME), "omp-runtime");
  assert.equal(isProtectedProjectRoot("/home/someone-else/.omp/agent/sessions", HOME), true);
});

test("the agent directory stays protected when PI_CONFIG_DIR points elsewhere", () => {
  // Found by execution, not by reading: `getConfigDirName()` returns
  // `PI_CONFIG_DIR` when it is set, so a guard built on the resolved name
  // alone stops matching `~/.omp` the moment that variable is exported — and
  // `lib/session-system-prompt.test.mjs` exports it, which turned the whole
  // suite red before this case existed.
  //
  // The point is not that a custom-named runtime tree must be protected; it is
  // that a *standard* `~/.omp` must stay protected regardless of that variable.
  const previous = process.env.PI_CONFIG_DIR;
  process.env.PI_CONFIG_DIR = ".omp-absent-for-this-test";
  try {
    assert.equal(
      isProtectedProjectRoot(`${HOME}/.omp/agent/sessions`, HOME),
      true,
      "a custom PI_CONFIG_DIR must not unprotect the standard .omp tree",
    );
    assert.equal(protectedRootReason(`${HOME}/.omp`, HOME), "omp-runtime");
    // And the renamed tree is protected too, under the name it actually has.
    assert.equal(
      isProtectedProjectRoot(`${HOME}/.omp-absent-for-this-test/agent`, HOME),
      true,
      "the renamed runtime tree is protected under its resolved name",
    );
    // Still not swallowing ordinary projects.
    assert.equal(isProtectedProjectRoot(`${HOME}/workspace/.omp-notes`, HOME), false);
  } finally {
    if (previous === undefined) delete process.env.PI_CONFIG_DIR;
    else process.env.PI_CONFIG_DIR = previous;
  }
});

test("an account's home is refused, and so is its parent", () => {
  // `/home` is not this identity's home and not a system root, so before the
  // 2026-10-20 fix it passed: measured `isProtectedProjectRoot("/home",
  // "/home/tester") === false`. Deleting it would take every account with it.
  assert.equal(isProtectedProjectRoot("/home", HOME), true);
  assert.equal(protectedRootReason("/home", HOME), "home-ancestor");
  // Another account's home directory. Measured `false` before the fix.
  assert.equal(isProtectedProjectRoot("/home/bob", HOME), true);
  assert.equal(protectedRootReason("/home/bob", HOME), "account-home");
});

test("the new rules do not swallow real projects", () => {
  // The counterweight for the three rules above, and the reason they were
  // written as narrowly as they are: a project called `.omp-projects`, a folder
  // named `home` inside a workspace, and a project directly under an account's
  // home all have to stay deletable.
  assert.equal(isProtectedProjectRoot(`${HOME}/workspace/.omp-notes`, HOME), false);
  assert.equal(isProtectedProjectRoot(`${HOME}/workspace/home`, HOME), false);
  assert.equal(isProtectedProjectRoot(`${HOME}/workspace/omp-web`, HOME), false);
  // A real project directly under an account home is still depth 1 and was
  // already refused before this change — unchanged.
  assert.equal(isProtectedProjectRoot(`${HOME}/workspace`, HOME), true);
});

test("the count a preview reports is the count of things that would go", () => {
  // The second, independent layer. Measured on a real tree: three files across
  // two directories is 3 entries (the two files plus `nested/`), and the
  // folder itself is not one of them.
  const root = mkdtempSync(join(tmpdir(), "omp-web-count-"));
  try {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "a.txt"), "a");
    writeFileSync(join(root, "nested", "b.txt"), "b");

    assert.deepEqual(countTreeEntries(root), { entryCount: 3, entriesTruncated: false });

    // The cap is a floor, not a silent undercount: a caller that stops the walk
    // has to be able to tell the number is not the whole number.
    const capped = countTreeEntries(root, 2);
    assert.equal(capped.entriesTruncated, true);
    assert.equal(capped.entryCount, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the confirmation threshold is the number the comment claims", () => {
  // AGENTS.md: a comment that names a figure needs a test that asserts the
  // same figure. Without this the threshold could drift to 1 or 1000 and the
  // comment would keep reading as a measurement.
  assert.equal(DELETE_CONFIRMATION_CHAT_THRESHOLD, 10);
  // And the boundary is inclusive at the threshold, which is the direction that
  // errs toward asking rather than toward deleting.
  assert.equal(9 >= DELETE_CONFIRMATION_CHAT_THRESHOLD, false);
  assert.equal(10 >= DELETE_CONFIRMATION_CHAT_THRESHOLD, true);
});