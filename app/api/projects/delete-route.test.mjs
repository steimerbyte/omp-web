import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const route = await jiti.import("./[...root]/route.ts");
const { getProjectsPath, writeProjectsFile } = await jiti.import("@/lib/projects-store.ts");
const { allowFileRoot } = await jiti.import("@/lib/file-access.ts");

/**
 * `DELETE /api/projects/[...root]` — the delete *order*, which is the whole point.
 *
 * Two properties are load-bearing and neither is visible from a response alone,
 * so both are checked against the filesystem:
 *
 * 1. A protected folder is refused **before anything is deleted**. Not "the
 *    folder survives" — *nothing* happens, including the chats. A handler
 *    that deleted the sessions first and then checked would leave a user with
 *    a half-dismantled folder and no way back.
 * 2. The sessions go first and completely, because `DELETE /api/sessions/[id]`
 *    rewrites sibling headers (cascade re-parent) into files the folder
 *    deletion would then destroy.
 */

const TENANT = { host: "localhost", "x-omp-user": "alice" };
const alice = { username: "alice", isAdmin: false };

function withHome(fn) {
  const previous = process.env.OMP_WEB_HOME_ROOT;
  const root = mkdtempSync(join(tmpdir(), "omp-web-projects-del-"));
  process.env.OMP_WEB_HOME_ROOT = root;
  const restore = () => {
    if (previous === undefined) delete process.env.OMP_WEB_HOME_ROOT;
    else process.env.OMP_WEB_HOME_ROOT = previous;
  };
  const result = fn(root);
  if (result && typeof result.then === "function") {
    return result.then(
      (value) => { restore(); rmSync(root, { recursive: true, force: true }); return value; },
      (error) => { restore(); rmSync(root, { recursive: true, force: true }); throw error; },
    );
  }
  restore();
  rmSync(root, { recursive: true, force: true });
  return result;
}

function deleteRequest(root, { headers = TENANT } = {}) {
  const encoded = root.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return {
    request: new Request(`http://localhost/api/projects/${encoded}`, {
      method: "DELETE",
      headers: { ...headers },
    }),
    params: Promise.resolve({ root: root.split("/").filter(Boolean) }),
  };
}

const storedProject = (root) => ({
  root,
  priority: "parked",
  openTodos: 0,
  status: "yellow",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastTouchedAt: "2026-01-01T00:00:00.000Z",
});

// ------------------------------------------------- protected paths delete nothing --

test("a protected folder is refused and the registry entry survives", () => withHome(async () => {
  writeProjectsFile(alice, { schemaVersion: 1, projects: [storedProject("/etc")], priorities: [] });

  const { request, params } = deleteRequest("/etc");
  const response = await route.DELETE(request, { params });

  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.code, "protected", "the client can distinguish this from a write failure");

  const onDisk = JSON.parse(readFileSync(getProjectsPath(alice), "utf8"));
  assert.equal(onDisk.projects.length, 1, "a refused delete changes nothing");
}));

test("a home child is refused before any write", () => withHome(async (root) => {
  // The live-Compose case from the design conversation.
  const stacks = join(root, "docker", "stacks");
  mkdirSync(stacks, { recursive: true });
  writeProjectsFile(alice, { schemaVersion: 1, projects: [storedProject(stacks)], priorities: [] });

  const { request, params } = deleteRequest(stacks);
  const response = await route.DELETE(request, { params });

  assert.equal(response.status, 403);
  const onDisk = JSON.parse(readFileSync(getProjectsPath(alice), "utf8"));
  assert.equal(onDisk.projects.length, 1, "the registry is untouched");
}));

test("traversal cannot reach a protected folder through the URL", () => withHome(async () => {
  writeProjectsFile(alice, { schemaVersion: 1, projects: [], priorities: [] });

  // `<home>/workspace/../../etc` normalizes to `/home/etc` — outside this
  // home, so not depth-1 — but the point of the case is that the *normalized*
  // path is what gets judged, never the raw string.
  const { request, params } = deleteRequest("/etc/../etc");
  const response = await route.DELETE(request, { params });
  // Resolves to `/etc`, which is protected.
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.code, "protected");
}));

// ------------------------------------------------------------------- guards --

test("DELETE without an identity is 403", () => withHome(async () => {
  const { request, params } = deleteRequest("/tmp/whatever", {
    headers: { host: "localhost" },
  });
  const response = await route.DELETE(request, { params });
  assert.equal(response.status, 403);
}));

test("DELETE with only an admin header is 403", () => withHome(async () => {
  const { request, params } = deleteRequest("/tmp/whatever", {
    headers: { host: "localhost", "x-omp-admin": "1" },
  });
  const response = await route.DELETE(request, { params });
  assert.equal(response.status, 403);
}));

test("a cross-origin DELETE is refused", () => withHome(async () => {
  const { request, params } = deleteRequest("/tmp/whatever", {
    headers: { ...TENANT, origin: "http://evil.example", "sec-fetch-site": "cross-site" },
  });
  const response = await route.DELETE(request, { params });
  assert.equal(response.status, 403);
}));

// -------------------------------------------------------------- the ordering --

test("the protection check runs before the write-allowlist and before the session scan", async () => {
  // Read as source rather than executed: the claim is about *order*, and a
  // handler that checked after deleting would still pass every response
  // assertion above. This pins that `isProtectedProjectRoot` is consulted
  // before `isWritePathAllowed` and before `deleteSession` is reachable.
  const source = readFileSync(new URL("./[...root]/route.ts", import.meta.url), "utf8");

  const protection = source.indexOf("isProtectedProjectRoot(root");
  const writeGuard = source.indexOf("isWritePathAllowed(root");
  const sessionDelete = source.indexOf("await deleteSession(");
  const folderDelete = source.indexOf("await deleteFileActions(");
  const registryWrite = source.lastIndexOf("writeProjectsFile(");

  assert.ok(protection > 0, "the protection check must exist");
  assert.ok(protection < writeGuard, "protection is decided before the write allowlist");
  assert.ok(protection < sessionDelete, "protection is decided before any chat is deleted");
  assert.ok(sessionDelete < folderDelete, "chats are deleted before the folder");
  assert.ok(folderDelete < registryWrite, "the folder goes before the registry entry");
});

test("a session delete failure aborts before the folder is touched", async () => {
  // The failure path is the one that protects the folder: if re-parenting
  // fails for the third chat, the first two are gone and the folder must
  // still be there, with the failure stated rather than hidden.
  const source = readFileSync(new URL("./[...root]/route.ts", import.meta.url), "utf8");

  const loop = source.indexOf("for (const session of inside)");
  const failureCheck = source.indexOf("if (!response.ok)");
  const folderDelete = source.indexOf("await deleteFileActions(");

  assert.ok(loop > 0, "the sessions are deleted in a loop");
  assert.ok(failureCheck > loop, "the failure is checked inside the loop");
  assert.ok(
    failureCheck < folderDelete,
    "a failure returns before the folder deletion is ever reached",
  );
  assert.match(
    source,
    /session-delete-failed/,
    "the response names the partial state instead of implying success",
  );
});

test("a realistic multi-segment root is deleted as the absolute path it is", () =>
  withHome(async (home) => {
    // The case the catch-all exists for: a project root is `/home/pi/workspace/omp-web`,
    // not one segment. Here the temp home stands in for `/home/pi`, and the
    // folder name carries a space and a literal `%` — both legal on a real disk
    // and both a way to get the reconstruction wrong: a space is fine, a `%`
    // makes a second `decodeURIComponent` throw and turn a valid delete into 500.
    // `getUserHome()` is per identity: the account's home is
    // `<OMP_WEB_HOME_ROOT>/<username>`, which is what the temp root holds.
    // A username of its own, because the writable-roots cache is keyed by
    // identity and the cases above already populated `alice`'s — a shared key
    // would hand this test the *previous* test's temp root and 403 for a
    // reason that has nothing to do with the path.
    const bob = { username: "bob", isAdmin: false };
    const project = join(home, bob.username, "workspace", "omp-web (100%)");
    mkdirSync(join(project, "src"), { recursive: true });
    // The write allowlist is per identity and never contains a temp home by
    // accident, so the test has to grant it — the same grant the real flow
    // gets from a session whose cwd is the project.
    allowFileRoot(home, bob);
    writeProjectsFile(bob, { schemaVersion: 1, projects: [storedProject(project)], priorities: [] });

    const { request, params } = deleteRequest(project, {
      headers: { host: "localhost", "x-omp-user": "bob" },
    });
    const response = await route.DELETE(request, { params });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(
      body.root,
      project,
      "the root is the absolute path, with its leading slash and every segment intact",
    );
    assert.equal(
      existsSync(project),
      false,
      "the folder itself is gone, not just its registry entry",
    );

    const onDisk = JSON.parse(readFileSync(getProjectsPath(bob), "utf8"));
    assert.equal(onDisk.projects.length, 0, "the registry entry went with it");
  }));

test("the segments arrive already decoded and are not decoded a second time", () => {
  // Next percent-decodes catch-all params before the handler sees them. A
  // second `decodeURIComponent` would throw `URIError` on a segment containing
  // a bare `%`, which lands in the catch block and answers 500 for a folder
  // that exists. `filePathFromSegments` joins the segments verbatim.
  const source = readFileSync(new URL("./[...root]/route.ts", import.meta.url), "utf8");
  const reassembly = source.slice(source.indexOf("await params"), source.indexOf("isProtectedProjectRoot"));
  assert.doesNotMatch(
    reassembly,
    /decodeURIComponent/,
    "the segments must not be decoded again inside the handler",
  );
});

test("the client encodes segment by segment so the slashes survive", () => {
  // The one encoding mistake that makes the whole route unreachable:
  // `encodeURIComponent` on the *whole* path turns `/home/pi/x` into a single
  // segment `%2Fhome%2Fpi%2Fx`, and the catch-all then yields one segment with
  // no separators left.
  const source = readFileSync(
    new URL("../../../components/ProjectsDashboard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /\/api\/projects\/\$\{encoded\}/,
    "the URL is built from the encoded segments",
  );
  assert.doesNotMatch(
    source,
    /encodeURIComponent\(target\.root\)/,
    "encoding must not be applied to the whole path at once",
  );
});

test("sessions in subdirectories of the project are included", async () => {
  // A chat that ran in `project/src` would otherwise survive as a record
  // pointing at a folder that no longer exists.
  const source = readFileSync(new URL("./[...root]/route.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /session\.cwd\.startsWith\(`\$\{root\}\/`\)/,
    "sessions below the root must be part of the delete",
  );
});