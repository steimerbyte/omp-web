import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { createJiti } from "jiti";

/**
 * The work budget on `/api/file-actions/[...path]`, as opposed to the
 * permission rules `protected.test.mjs` pins.
 *
 * A copy of 20 021 entries held the Bun event loop for 1023 ms and a delete for
 * 825 ms, because both walked the tree with synchronous fs calls and neither
 * was bounded. The tests below assert three things about the replacement:
 *
 * 1. An ordinary tree still copies and deletes, still through the route.
 * 2. An over-limit tree is refused *before the first mutation* — read back from
 *    the filesystem, not from the status code. "The limit exists" and "nothing
 *    was written" are different claims.
 * 3. The tree walking is asynchronous, so the walk cannot block the loop for
 *    the length of the tree. That property is awkward to measure reliably in a
 *    unit test, so it is asserted on the code shape: no synchronous tree
 *    primitive remains in the module, and the pre-check runs before the copy or
 *    the delete call in the route.
 *
 * Every path is under a temp home this file creates and removes.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-file-actions-limits-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const route = await jiti.import("./[...path]/route.ts");
const { allowFileRoot } = await jiti.import("@/lib/file-access.ts");
const tree = await jiti.import("@/lib/file-actions-tree.ts");

const ORIGIN = "http://localhost:30141";

test.after(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

let userCounter = 0;

/** A scratch account whose whole tree is this test's to use. */
function withAccount(fn) {
  userCounter += 1;
  const username = `limiter${userCounter}`;
  const home = join(HOME_ROOT, username);
  const identity = { username, isAdmin: false };
  mkdirSync(home, { recursive: true });
  allowFileRoot(home, identity);
  return fn({ home, headers: { host: "localhost:30141", "x-omp-user": username } });
}

function segmentsFor(absolute) {
  return absolute.split("/").filter(Boolean);
}

function deleteRequest(absolute, headers) {
  const segments = segmentsFor(absolute);
  return route.DELETE(
    new NextRequest(`${ORIGIN}/api/file-actions/${segments.map(encodeURIComponent).join("/")}`, {
      method: "DELETE",
      headers,
    }),
    { params: Promise.resolve({ path: segments }) },
  );
}

function postRequest(absolute, type, headers, body) {
  const segments = segmentsFor(absolute);
  return route.POST(
    new NextRequest(
      `${ORIGIN}/api/file-actions/${segments.map(encodeURIComponent).join("/")}?type=${type}`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      },
    ),
    { params: Promise.resolve({ path: segments }) },
  );
}

/** A small project folder: nested directories, files, and one symlink. */
function seedProject(home) {
  const project = join(home, "workspace", "proj");
  mkdirSync(join(project, "src", "nested"), { recursive: true });
  writeFileSync(join(project, "README.md"), "# proj\n");
  writeFileSync(join(project, "src", "index.ts"), "export const x = 1;\n");
  writeFileSync(join(project, "src", "nested", "deep.txt"), "deep\n");
  symlinkSync("README.md", join(project, "link-to-readme"));
  return project;
}

// ------------------------------------------------------------ ordinary trees --

test("a small tree copies and the copy deletes", async () => {
  await withAccount(async ({ home, headers }) => {
    const project = seedProject(home);
    const destination = join(home, "workspace", "out");
    mkdirSync(destination, { recursive: true });

    const response = await postRequest(project, "copy", headers, { destination });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));

    const copied = join(destination, "proj");
    assert.equal(body.path, copied);
    assert.equal(readFileSync(join(copied, "README.md"), "utf8"), "# proj\n");
    assert.equal(readFileSync(join(copied, "src", "nested", "deep.txt"), "utf8"), "deep\n");
    assert.equal(lstatSync(join(copied, "link-to-readme")).isSymbolicLink(), true, "a symlink is copied as a link");
    assert.equal(readFileSync(join(project, "README.md"), "utf8"), "# proj\n", "the source is untouched");

    const removed = await deleteRequest(copied, headers);
    assert.equal(removed.status, 200, JSON.stringify(await removed.json()));
    assert.equal(existsSync(copied), false, "the copy is gone");
    assert.equal(existsSync(join(project, "src", "index.ts")), true, "the source still exists");
  });
});

// ------------------------------------------------------- over the depth budget --

test("an over-nested tree is refused before the copy writes anything", async () => {
  await withAccount(async ({ home, headers }) => {
    const source = join(home, "workspace", "deep");
    let dir = source;
    mkdirSync(dir, { recursive: true });
    // One level deeper than the documented limit, and cheap to build.
    for (let level = 0; level <= tree.MAX_TREE_DEPTH; level += 1) {
      dir = join(dir, "d");
      mkdirSync(dir);
    }
    writeFileSync(join(dir, "leaf.txt"), "leaf\n");
    const destination = join(home, "workspace", "out");
    mkdirSync(destination, { recursive: true });

    const response = await postRequest(source, "copy", headers, { destination });

    assert.equal(response.status, 422);
    const body = await response.json();
    assert.match(body.error, new RegExp(String(tree.MAX_TREE_DEPTH)));
    assert.match(body.error, /nesting/);
    // Not "refused": "nothing was written".
    assert.equal(existsSync(join(destination, "deep")), false, "no partial destination");
    assert.equal(readFileSync(join(dir, "leaf.txt"), "utf8"), "leaf\n");
  });
});

test("an over-nested tree is refused before the delete removes anything", async () => {
  await withAccount(async ({ home, headers }) => {
    const source = join(home, "workspace", "deep");
    let dir = source;
    mkdirSync(dir, { recursive: true });
    for (let level = 0; level <= tree.MAX_TREE_DEPTH; level += 1) {
      dir = join(dir, "d");
      mkdirSync(dir);
    }
    const leaf = join(dir, "leaf.txt");
    writeFileSync(leaf, "leaf\n");

    const response = await deleteRequest(source, headers);

    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /nesting/);
    assert.equal(readFileSync(leaf, "utf8"), "leaf\n", "the folder must be as it was");
  });
});

// -------------------------------------------------- unit tests on the budget --

test("the named limits are the ones the route uses", () => {
  assert.equal(tree.TREE_LIMITS.maxEntries, tree.MAX_TREE_ENTRIES);
  assert.equal(tree.TREE_LIMITS.maxDepth, tree.MAX_TREE_DEPTH);
  assert.equal(tree.TREE_LIMITS.maxBytes, tree.MAX_TREE_BYTES);
  assert.equal(tree.TREE_LIMITS.maxMillis, tree.MAX_TREE_MILLIS);
  assert.ok(tree.MAX_TREE_ENTRIES >= 1_000, "a cap below a normal project would break the feature");
  assert.ok(tree.MAX_TREE_BYTES > 0);
});

test("the entry cap is checked before any copy starts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-tree-entries-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (let index = 0; index < 5; index += 1) writeFileSync(join(root, `f${index}.txt`), "x");

  const limits = { ...tree.TREE_LIMITS, maxEntries: 2 };
  await assert.rejects(
    tree.inspectTree(root, "copy", tree.treeDeadline(limits), limits),
    (error) => error instanceof tree.TreeRefusal
      && error.status === 422
      && error.message.includes("2"),
  );
});

test("the entry cap applies to a copy but not to a delete", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-tree-delete-entries-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (let index = 0; index < 3; index += 1) writeFileSync(join(root, `f${index}.txt`), "x");

  const limits = { ...tree.TREE_LIMITS, maxEntries: 2 };
  await assert.rejects(
    tree.inspectTree(root, "copy", tree.treeDeadline(limits), limits),
    (error) => error instanceof tree.TreeRefusal && error.message.includes("2"),
  );
  // A delete is bounded by the deadline and depth, not by the entry count: a
  // folder the old code deleted must stay deletable.
  await tree.inspectTree(root, "delete", tree.treeDeadline(limits), limits);
});

test("the byte cap is checked before any copy starts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-tree-bytes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "big.bin"), Buffer.alloc(64));

  const limits = { ...tree.TREE_LIMITS, maxBytes: 32 };
  await assert.rejects(
    tree.inspectTree(root, "copy", tree.treeDeadline(limits), limits),
    (error) => error instanceof tree.TreeRefusal && error.status === 413,
  );
});

test("a single file over the byte cap is refused too", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-tree-file-bytes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "big.bin");
  writeFileSync(file, Buffer.alloc(64));

  const limits = { ...tree.TREE_LIMITS, maxBytes: 32 };
  await assert.rejects(
    tree.inspectTree(file, "copy", tree.treeDeadline(limits), limits),
    (error) => error instanceof tree.TreeRefusal && error.status === 413,
  );
});

test("the time budget stops the walk", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-tree-time-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "f.txt"), "x");

  await assert.rejects(
    tree.inspectTree(root, "copy", performance.now() - 1),
    (error) => error instanceof tree.TreeRefusal && error.message.includes("longer than"),
  );
});

test("a FIFO is refused for a copy and allowed for a delete", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-tree-fifo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fifo = join(root, "pipe");
  try {
    execFileSync("mkfifo", [fifo]);
  } catch {
    t.skip("mkfifo unavailable on this host");
    return;
  }

  await assert.rejects(
    tree.inspectTree(root, "copy", tree.treeDeadline()),
    (error) => error instanceof tree.TreeRefusal && /FIFO, socket or device/.test(error.message),
  );
  await tree.inspectTree(root, "delete", tree.treeDeadline());
});

test("copyTree refuses a FIFO that appeared after the walk", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-tree-race-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fifo = join(root, "pipe");
  try {
    execFileSync("mkfifo", [fifo]);
  } catch {
    t.skip("mkfifo unavailable on this host");
    return;
  }

  await assert.rejects(
    tree.copyTree(root, join(root, "..", `${root.split("/").pop()}-copy`), tree.treeDeadline()),
    (error) => error instanceof tree.TreeRefusal && /FIFO, socket or device/.test(error.message),
  );
});

// --------------------------------------------------------------- async wiring --

test("the tree walk uses asynchronous fs primitives and runs the cap first", async () => {
  const moduleSource = readFileSync(new URL("../../../lib/file-actions-tree.ts", import.meta.url), "utf8");
  for (const syncCall of ["readdirSync", "copyFileSync", "rmSync", "unlinkSync", "lstatSync"]) {
    assert.doesNotMatch(
      moduleSource,
      new RegExp(`\\b${syncCall}\\s*\\(`),
      `${syncCall} would block the event loop for the whole tree`,
    );
  }

  const routeSource = readFileSync(new URL("./[...path]/route.ts", import.meta.url), "utf8");
  const inspectAt = routeSource.indexOf("await inspectTree(source, \"copy\"");
  const copyAt = routeSource.indexOf("await copyTree(source, destination");
  assert.ok(inspectAt > 0 && copyAt > inspectAt, "the copy must be pre-checked before it starts");

  const deleteInspectAt = routeSource.indexOf("await inspectTree(resolved, \"delete\"");
  const removeAt = routeSource.indexOf("await fs.promises.rm(resolved");
  assert.ok(deleteInspectAt > 0 && removeAt > deleteInspectAt, "the delete must be pre-checked before it removes");
});

// ------------------------------------------------------- DELETE: resolved object --

test("a symlink is deleted as a link and its target survives", async () => {
  await withAccount(async ({ home, headers }) => {
    const project = seedProject(home);
    const link = join(project, "link-to-readme");
    assert.equal(lstatSync(link).isSymbolicLink(), true, "precondition: the fixture entry is a link");

    const response = await deleteRequest(link, headers);

    assert.equal(response.status, 200);
    assert.equal(existsSync(link), false, "the link is gone");
    assert.equal(readFileSync(join(project, "README.md"), "utf8"), "# proj\n", "the target is untouched");
  });
});

test("a delete through a symlinked directory removes the resolved folder", async () => {
  await withAccount(async ({ home, headers }) => {
    const real = join(home, "workspace", "real");
    mkdirSync(join(real, "child"), { recursive: true });
    writeFileSync(join(real, "child", "file.txt"), "x\n");
    const alias = join(home, "workspace", "alias");
    symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");

    const response = await deleteRequest(join(alias, "child"), headers);

    assert.equal(response.status, 200);
    assert.equal(existsSync(join(real, "child")), false, "the resolved folder is what was removed");
    assert.equal(lstatSync(alias).isSymbolicLink(), true, "the alias link itself survives");
    assert.equal(existsSync(real), true, "only the addressed child is removed");
  });
});
