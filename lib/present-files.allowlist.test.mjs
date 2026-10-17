import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * The allow-list behind a presented-file card.
 *
 * A card renders an absolute path and links to it. The tool that produced the
 * `details` payload is the agent, and the agent is not the account: a path it
 * reports is therefore an untrusted input, and the only thing standing between
 * it and a card that opens another tenant's file is `getAllowedFileRoots()`
 * plus `isExistingFilePathAllowed()`. This file pins that boundary as the
 * requesting account sees it — the roots one identity gets, the paths another
 * must not reach, and the two ways a path that looks inside a root can still
 * not be read: it does not exist, or it is a symlink out.
 *
 * It tests the existing guards, not a copy of them: `lib/file-access.ts`,
 * `lib/request-identity.ts` and `lib/path-security.ts` are the subject, and the
 * fixtures are real directories and a real symlink under a temp dir, because
 * both guards decide by resolving the filesystem.
 */

const ALICE = { username: "alice", isAdmin: false };
const BOB = { username: "bob", isAdmin: false };
const ADMIN = { username: "pi", isAdmin: true };

// Pin the account home root instead of inheriting it: the live service on this
// host sets `OMP_WEB_HOME_ROOT=/home/pi/accounts`, which moves every account
// home and makes the results depend on the machine the suite runs on. The tests
// below override it with a temp dir for the duration of a case and put this
// value back.
process.env.OMP_WEB_HOME_ROOT = "/home";

async function loadSubject() {
  const [fileAccess, requestIdentity, allowedRoots] = await Promise.all([
    import("./file-access.ts"),
    import("./request-identity.ts"),
    import("./allowed-roots.ts"),
  ]);
  return { ...fileAccess, ...requestIdentity, ...allowedRoots };
}

/**
 * A fresh temp dir that is also the account home root for the duration of the
 * callback, so `getUserHome()` hands out homes that exist on disk. The roots
 * cache is dropped on both sides: it is keyed by identity, not by env, so a
 * change of home root alone would otherwise leave the previous case's roots
 * cached for the next one.
 */
async function withHomeRoot(run) {
  const { clearAllowedRootsCache } = await loadSubject();
  const base = mkdtempSync(join(tmpdir(), "present-files-allowlist-"));
  const pinned = process.env.OMP_WEB_HOME_ROOT;
  process.env.OMP_WEB_HOME_ROOT = base;
  clearAllowedRootsCache();
  try {
    return await run(base);
  } finally {
    process.env.OMP_WEB_HOME_ROOT = pinned;
    clearAllowedRootsCache();
    rmSync(base, { recursive: true, force: true });
  }
}

/** An account home with one file in it. */
function homeWithFile(base, username, name = "notes.md") {
  const home = join(base, username);
  mkdirSync(home, { recursive: true });
  const file = join(home, name);
  writeFileSync(file, "tenant data");
  return { home, file };
}

test("a tenant reaches a file in his own home", async () => {
  const { getAllowedFileRoots, isExistingFilePathAllowed, getUserHome } = await loadSubject();

  await withHomeRoot(async (base) => {
    const { home, file } = homeWithFile(base, ALICE.username);
    const roots = await getAllowedFileRoots(ALICE);

    assert.equal(getUserHome(ALICE), home, "the account home is what the fixture was built under");
    assert.equal(
      isExistingFilePathAllowed(file, roots),
      true,
      "a card for a file in alice's own home must be readable by alice",
    );
  });
});

test("the same file is refused to another tenant", async () => {
  const { getAllowedFileRoots, isExistingFilePathAllowed } = await loadSubject();

  await withHomeRoot(async (base) => {
    const alice = homeWithFile(base, ALICE.username);
    const bob = homeWithFile(base, BOB.username);

    const asAlice = await getAllowedFileRoots(ALICE);
    const asBob = await getAllowedFileRoots(BOB);

    assert.equal(isExistingFilePathAllowed(alice.file, asAlice), true);
    assert.equal(
      isExistingFilePathAllowed(alice.file, asBob),
      false,
      "alice's file must not be readable through bob's root set",
    );
    // Not a lockout in the other direction either: each account still sees
    // itself, so a refusal above is a boundary and not a broken lookup.
    assert.equal(isExistingFilePathAllowed(bob.file, asBob), true);
  });
});

test("an admin is allowed across accounts and outside them", async () => {
  const { getAllowedFileRoots, isExistingFilePathAllowed, getUserHome } = await loadSubject();

  await withHomeRoot(async (base) => {
    const alice = homeWithFile(base, ALICE.username);
    const bob = homeWithFile(base, BOB.username);
    const loose = join(base, "loose");
    mkdirSync(loose);
    const looseFile = join(loose, "scratch.txt");
    writeFileSync(looseFile, "scratch");

    const asAdmin = await getAllowedFileRoots(ADMIN);

    assert.equal(getUserHome(ADMIN), "/", "the admin root of an account home is the filesystem root");
    assert.equal(isExistingFilePathAllowed(alice.file, asAdmin), true);
    assert.equal(isExistingFilePathAllowed(bob.file, asAdmin), true);
    assert.equal(
      isExistingFilePathAllowed(looseFile, asAdmin),
      true,
      "the admin root is not bounded by the account homes",
    );
  });
});

test("a path that does not exist is refused even inside an allowed root", async () => {
  const { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } =
    await loadSubject();

  await withHomeRoot(async (base) => {
    const { home } = homeWithFile(base, ALICE.username);
    const missing = join(home, "deleted.md");
    assert.equal(existsSync(missing), false);

    const roots = await getAllowedFileRoots(ALICE);

    // The two checks differ exactly here: the lexical one sees a path inside a
    // root it owns, the resolving one refuses. A card link that goes through
    // the resolving one cannot be pointed at a path that was removed, and
    // cannot be walked into either — the last segment of a traversal escape is
    // a path that is not there.
    assert.equal(isFilePathAllowed(missing, roots), true, "the path is lexically inside alice's home");
    assert.equal(
      isExistingFilePathAllowed(missing, roots),
      false,
      "a non-existent path inside an allowed root must not be presented as readable",
    );
  });
});

test("a symlink inside an allowed root is not a way out of it", async () => {
  const { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } =
    await loadSubject();

  await withHomeRoot(async (base) => {
    const { home } = homeWithFile(base, ALICE.username);
    const outside = join(base, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(home, "escape"), process.platform === "win32" ? "junction" : "dir");
    const viaLink = join(home, "escape", "secret.txt");
    assert.equal(existsSync(viaLink), true, "the escape target exists — only resolution stops it");

    const roots = await getAllowedFileRoots(ALICE);

    assert.equal(isFilePathAllowed(viaLink, roots), true, "the link itself lives in alice's home");
    assert.equal(
      isExistingFilePathAllowed(viaLink, roots),
      false,
      "a symlink inside the home must not turn into a read outside it",
    );
  });
});

test("an unauthenticated request gets no roots at all", async () => {
  const { getAllowedFileRoots, isExistingFilePathAllowed } = await loadSubject();

  await withHomeRoot(async (base) => {
    const { file } = homeWithFile(base, ALICE.username);

    const roots = await getAllowedFileRoots(null);

    assert.equal(roots.size, 0, "no identity, no roots — not even the session roots");
    assert.equal(isExistingFilePathAllowed(file, roots), false);
  });
});