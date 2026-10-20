import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isProtectedProjectRoot, protectedRootReason } = await jiti.import("./projects-delete.ts");

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
    [`${HOME}/.omp`, "home-child"],
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