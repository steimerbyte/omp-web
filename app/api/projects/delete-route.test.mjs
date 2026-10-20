import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const { getAgentDir, setAgentDir } = await jiti.import("@oh-my-pi/pi-utils");
const { invalidateSessionListCache } = await jiti.import("@/lib/session-reader.ts");

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

/** The same request as `deleteRequest`, as a GET — the preview call. */
function getRequest(root, { headers = TENANT } = {}) {
  const encoded = root.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return {
    request: new Request(`http://localhost/api/projects/${encoded}`, {
      method: "GET",
      headers: { ...headers },
    }),
    params: Promise.resolve({ root: root.split("/").filter(Boolean) }),
  };
}

/**
 * A fresh non-admin identity per call.
 *
 * The writable-roots cache is keyed by identity and has a five-second TTL, so
 * tests that share a username would hand each other the previous test's temp
 * root and 403 for a reason that has nothing to do with the case under test.
 */
let bobCounter = 0;
function bobIdentity() {
  bobCounter += 1;
  return { username: `bob${bobCounter}`, isAdmin: false };
}
function bobHeaders(identity = bobIdentity()) {
  return { host: "localhost", "x-omp-user": identity.username };
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
  // assertion above. This pins that the protection check is consulted
  // before `isWritePathAllowed` and before `deleteSession` is reachable.
  //
  // The check is `protectedRootReason(...)` and not `isProtectedProjectRoot(...)`
  // any more: the reason is what the route needs, because it reports *which*
  // rule refused. `protectedRootReason` returns `null` for a deletable folder
  // and a reason string otherwise, so it subsumes the boolean — pinning the
  // boolean here would have let a future refactor keep the boolean call and drop
  // the reason the response now carries.
  const source = readFileSync(new URL("./[...root]/route.ts", import.meta.url), "utf8");

  const protection = source.indexOf("protectedRootReason(root");
  const writeGuard = source.indexOf("isWritePathAllowed(root");
  const sessionDelete = source.indexOf("await deleteSession(");
  const folderDelete = source.indexOf("await deleteFileActions(");
  const registryWrite = source.lastIndexOf("writeProjectsFile(");
  const preview = source.indexOf("await buildPreview(");

  assert.ok(protection > 0, "the protection check must exist");
  assert.ok(protection < writeGuard, "protection is decided before the write allowlist");
  assert.ok(protection < sessionDelete, "protection is decided before any chat is deleted");
  // The count is taken after the guards, so a refusal costs nothing: a
  // protected folder must not even be walked.
  assert.ok(protection < preview, "protection is decided before the folder is counted");
  assert.ok(preview < sessionDelete, "the count happens before any chat is deleted");
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
    /sessionsInside\(sessions, root\)/,
    "sessions below the root must be part of the delete",
  );
});

// ---------------------------------------------------------------- the incident --

/**
 * The 2026-10-20 loss, reproduced.
 *
 * A `DELETE /api/projects/home/steimerbyte/.omp` ran against the dev server and
 * destroyed 130 chats. These cases assert the two things that were true
 * afterwards and should never have been reached: the response is a refusal, and
 * the chat files are still on disk afterwards. Asserting the status code alone
 * would pass for a handler that deleted the sessions and *then* reported 403 —
 * which is exactly the ordering this route is supposed to prevent, so the
 * filesystem is the witness, not the response.
 */

/**
 * A real session store in a temp directory, with `count` real session files
 * whose cwd is `cwd`.
 *
 * Built by writing the records the real writer produces — a `title` line then a
 * `session` line, per AGENTS.md's measurement of 400 of 400 real files — so the
 * route's own session reader finds them. A stubbed session list would prove the
 * route calls `deleteSession`; it would not prove the files survive, which is
 * the claim under test.
 */
function withRealSessions(cwd, count, fn) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-incident-agent-"));
  // The *resolved* agent dir, not the env var. `setAgentDir()` rebuilds a
  // module-level resolver inside `@oh-my-pi/pi-utils`; putting the old value
  // back into `process.env` does not undo that. This file passed alone and
  // failed in the full suite with "Unknown user", because a later route read a
  // projects path under a temp directory that had already been removed — the
  // resolver was still aimed at this fixture after its cleanup ran.
  const previousAgentDir = getAgentDir();
  const previous = process.env.PI_CODING_AGENT_DIR;
  setAgentDir(agentDir);
  const cleanup = () => {
    setAgentDir(previousAgentDir);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    rmSync(agentDir, { recursive: true, force: true });
  };

  let payload;
  try {
    const sessionsDir = join(agentDir, "sessions", cwd.replace(/\//g, "-"));
    mkdirSync(sessionsDir, { recursive: true });
    const ids = [];
    for (let index = 0; index < count; index += 1) {
      const id = `incident-session-${index}`;
      ids.push(id);
      // The filename carries a timestamp prefix because the real writer does:
      // the session id is read back out of the file *name*
      // (`sessionIdFromSessionPath`), so `incident-0.jsonl` finds no id. Both
      // the file name and the records come from the real format — measured
      // against real session files, not against memory of it.
      writeFileSync(
        join(sessionsDir, `2026-01-01T00-00-00_${id}.jsonl`),
        `${JSON.stringify({ type: "title", v: 1, title: `chat ${index}`, source: "auto" })}\n` +
          `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`,
      );
    }
    // The session list is cached per process; a stale cache would make the
    // route see zero sessions and pass for the wrong reason.
    invalidateSessionListCache();
    // The *real* paths, reported back rather than re-derived by the caller:
    // the first version of this helper had the caller guess
    // `<target>/agent/sessions`, which is a different folder from the one the
    // temp agent dir produced, and the assertions then passed on a directory
    // that held nothing.
    const files = ids.map((id) => join(sessionsDir, `2026-01-01T00-00-00_${id}.jsonl`));
    payload = { agentDir, sessionsDir, ids, files };
  } catch (error) {
    cleanup();
    throw error;
  }

  // The cleanup must wait for the callback. `try { return fn(...) } finally
  // { cleanup() }` deletes the fixture before the first assertion inside `fn`
  // runs — the suite then reports "0 sessions" against a store that no longer
  // exists, which is exactly what happened before this was written down here.
  return Promise.resolve(fn(payload)).then(
    (value) => {
      cleanup();
      return value;
    },
    (error) => {
      cleanup();
      throw error;
    },
  );
}

test("deleting the omp agent directory is refused and every chat file survives", () =>
  withHome(async (homeRoot) => {
    // An admin identity, because that is who the incident belonged to:
    // `getUserHome()` returns `/` for an admin, which is what let the path
    // through the depth rule in the first place. The identity lives in the
    // headers below (`x-omp-admin: 1`); it needs no local binding.
    // The runtime tree, inside the temp home root so the test writes nothing
    // outside its own temp directory. It is a `.omp` segment, which is what the
    // rule matches on.
    const agentDir = join(homeRoot, "steimerbyte", ".omp");
    mkdirSync(agentDir, { recursive: true });

    await withRealSessions(agentDir, 3, async ({ files }) => {
      assert.ok(files.every((file) => existsSync(file)), "the fixture really has chats on disk");

      const { request, params } = deleteRequest(agentDir, {
        headers: { host: "localhost", "x-omp-user": "steimerbyte", "x-omp-admin": "1" },
      });
      const response = await route.DELETE(request, { params });

      assert.equal(response.status, 403);
      const body = await response.json();
      assert.equal(body.code, "protected");
      // The reason is what tells the UI this is the installation's own state
      // rather than "pick another folder".
      assert.equal(body.reason, "omp-runtime");

      for (const file of files) {
        assert.equal(
          existsSync(file),
          true,
          `${file} must still exist — the incident deleted these and nothing can bring them back`,
        );
      }
      assert.equal(existsSync(agentDir), true, "the agent directory itself survives");
    });
  }));

test("deleting a directory above the agent directory is refused as well", () =>
  withHome(async (homeRoot) => {
    // The *parent* case: not the runtime tree itself, but the account home that
    // contains it. Before the fix this answered `false`, because the admin's
    // home is `/` and no rule joined the two.
    const accountHome = join(homeRoot, "steimerbyte");
    mkdirSync(accountHome, { recursive: true });

    await withRealSessions(accountHome, 2, async ({ ids, files }) => {
      const { request, params } = deleteRequest(accountHome, {
        headers: { host: "localhost", "x-omp-user": "steimerbyte", "x-omp-admin": "1" },
      });
      const response = await route.DELETE(request, { params });

      assert.equal(response.status, 403);
      const body = await response.json();
      assert.equal(body.code, "protected");
      assert.equal(body.reason, "account-home");
      assert.equal(existsSync(accountHome), true, "the account home survives");
      for (const file of files) {
        assert.equal(existsSync(file), true, "its chats survive with it");
      }
      assert.equal(ids.length, 2);
    });
  }));

// ---------------------------------------------------------- counting and confirmation --

test("the preview reports what a delete would remove, before anything is removed", () =>
  withHome(async (homeRoot) => {
    const bob = bobIdentity();
    const project = join(homeRoot, bob.username, "workspace", "counted");
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "README.md"), "x");
    writeFileSync(join(project, "src", "index.ts"), "y");
    allowFileRoot(homeRoot, bob);

    await withRealSessions(project, 2, async () => {
      const { request, params } = getRequest(project, { headers: bobHeaders(bob) });
      const response = await route.GET(request, { params });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.sessionCount, 2, "the count is the number of chats that would go");
      assert.equal(body.entryCount, 3, "three entries: two files and the src directory");
      assert.equal(body.entriesTruncated, false);
      assert.equal(
        body.requiresConfirmation,
        false,
        "two chats is under the threshold of ten, so the ordinary case needs no dialog",
      );

      assert.equal(existsSync(project), true, "a preview removes nothing");
    });
  }));

test("a delete over the chat threshold is refused until the count is confirmed", () =>
  withHome(async (homeRoot) => {
    const bob = bobIdentity();
    const project = join(homeRoot, bob.username, "workspace", "many-chats");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "file.txt"), "x");
    allowFileRoot(homeRoot, bob);

    // Twelve chats, above the threshold of ten, with real files on disk.
    await withRealSessions(project, 12, async ({ files }) => {

      // (a) No confirmation at all: refused, and nothing is gone.
      const unconfirmed = deleteRequest(project, { headers: bobHeaders(bob) });
      const firstResponse = await route.DELETE(unconfirmed.request, { params: unconfirmed.params });
      assert.equal(firstResponse.status, 409);
      const firstBody = await firstResponse.json();
      assert.equal(firstBody.code, "confirmation-required");
      assert.equal(firstBody.sessionCount, 12, "the response states the number the user must confirm");
      for (const file of files) {
        assert.equal(existsSync(file), true, "a refused delete must not remove a single chat");
      }
      assert.equal(existsSync(project), true, "and must not remove the folder");

      // (b) A confirmation that names the wrong number: still refused. This is
      // the case a boolean `confirm: true` cannot catch — the user saw "3" and
      // the folder holds 12.
      const wrong = deleteRequest(project, {
        headers: { ...bobHeaders(bob), "x-omp-delete-confirm": "3" },
      });
      const wrongResponse = await route.DELETE(wrong.request, { params: wrong.params });
      assert.equal(wrongResponse.status, 409);
      const wrongBody = await wrongResponse.json();
      assert.equal(wrongBody.code, "confirmation-stale");
      assert.match(wrongBody.error, /confirmed 3, now 12/);
      for (const file of files) {
        assert.equal(existsSync(file), true, "a stale confirmation removes nothing either");
      }

      // (c) The number that is actually true: the delete proceeds.
      const right = deleteRequest(project, {
        headers: { ...bobHeaders(bob), "x-omp-delete-confirm": "12" },
      });
      const rightResponse = await route.DELETE(right.request, { params: right.params });
      assert.equal(rightResponse.status, 200);
      const rightBody = await rightResponse.json();
      assert.equal(rightBody.sessionsDeleted, 12);
      assert.equal(existsSync(project), false, "a confirmed delete really does delete");
    });
  }));

test("a delete under the chat threshold needs no confirmation", () =>
  withHome(async (homeRoot) => {
    const bob = bobIdentity();
    const project = join(homeRoot, bob.username, "workspace", "quiet");
    mkdirSync(project, { recursive: true });
    allowFileRoot(homeRoot, bob);

    // Three chats, below the threshold: the ordinary case must not have grown
    // a dialog, or the rule would be unusable rather than protective.
    await withRealSessions(project, 3, async ({ ids }) => {
      const { request, params } = deleteRequest(project, { headers: bobHeaders(bob) });
      const response = await route.DELETE(request, { params });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).sessionsDeleted, 3);
      assert.equal(existsSync(project), false);
      assert.equal(ids.length, 3);
    });
  }));