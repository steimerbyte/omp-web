import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { createJiti } from "jiti";

/**
 * `/api/file-actions/[...path]` against the protected-tree rule.
 *
 * ### The incident this file exists for
 *
 * On 2026-10-20 a single `DELETE /api/file-actions/…` removed 130 chats from
 * `~/.omp`. Every guard the handler had passed: the caller had an identity, and
 * `isWritePathAllowed` said yes — because 129 sessions had `cwd = ~/.omp`, which
 * makes that directory an ordinary writable root. A chat that once ran somewhere
 * was the only thing standing between a recursive delete and the agent's own
 * state.
 *
 * So the tests below do not assert a status code. They set the scenario up on a
 * real filesystem, fire the request, and then **read the directory back** —
 * because "the guard exists" and "the chats survived" are different claims, and
 * only one of them is the property that was lost.
 *
 * Every path here is under a temp directory this file creates and removes.
 * Nothing in this file points at a real home, a real project or a real agent
 * directory; a test that aimed at live data is what turned a guard question
 * into an incident.
 *
 * ### Both identities, and the negative list
 *
 * The admin case is the incident's identity: `getUserHome()` returns `/` for an
 * admin, so every home-derived comparison in the protection rule is made
 * against a tree with nothing to do with the folder. A non-admin gets the same
 * rule with a real home, and both must be refused — the `.omp`-segment rule has
 * no identity argument at all, which is the point.
 *
 * And the last group deletes ordinary project directories. A suite that only
 * ever asserts refusals passes just as happily against a route that refuses
 * everything, which is how `write-access.identity.test.mjs` ended up
 * documenting a "you only tested rejections" gap.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-file-actions-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const route = await jiti.import("./[...path]/route.ts");
const { allowFileRoot } = await jiti.import("@/lib/file-access.ts");

const ORIGIN = "http://localhost:30141";

test.after(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

let userCounter = 0;

/**
 * A scratch account whose whole tree is this test's to use.
 *
 * The username is fresh on every call on purpose: the writable-root cache is
 * keyed by `username + isAdmin` and lives five seconds, so two cases sharing a
 * name would hand each other the previous case's temp root and 403 for a reason
 * that has nothing to do with what is under test.
 */
function withAccount(fn) {
  userCounter += 1;
  const username = `actor${userCounter}`;
  const home = join(HOME_ROOT, username);
  const identity = { username, isAdmin: false };
  mkdirSync(home, { recursive: true });
  allowFileRoot(home, identity);
  return fn({ username, home, identity, headers: { host: "localhost:30141", "x-omp-user": username } });
}

/** The same, for the identity the incident actually used. */
function withAdmin(fn) {
  userCounter += 1;
  const username = `root${userCounter}`;
  const home = join(HOME_ROOT, username);
  const identity = { username, isAdmin: true };
  mkdirSync(home, { recursive: true });
  allowFileRoot(home, identity);
  return fn({
    username,
    home,
    identity,
    headers: { host: "localhost:30141", "x-omp-user": username, "x-omp-admin": "1" },
  });
}

/** The body once: a failed `assert.equal(..., await response.text())` eats it. */
async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
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

/**
 * The incident's fixture: a project folder that happens to contain an agent
 * directory, with a transcript standing in for the chats that used to live
 * there. Returns the paths plus an assertion that reads the directory back.
 */
function seedAgentDir(home) {
  const project = join(home, "workspace", "proj");
  const agentDir = join(project, ".omp");
  const sessions = join(agentDir, "agent", "sessions");
  mkdirSync(sessions, { recursive: true });
  const transcript = join(sessions, "chat-0001.jsonl");
  writeFileSync(transcript, '{"header":{"id":"chat-0001"}}\n');
  return {
    project,
    agentDir,
    transcript,
    assertIntact() {
      assert.equal(existsSync(agentDir), true, "the agent directory must still exist");
      assert.equal(existsSync(transcript), true, "the transcript must still exist");
      assert.match(readFileSync(transcript, "utf8"), /chat-0001/);
    },
  };
}

// --------------------------------------------------- DELETE: protected target --

test("an admin cannot delete the agent directory through file-actions, and it survives", async () => {
  await withAdmin(async ({ home, headers }) => {
    const seed = seedAgentDir(home);

    const response = await deleteRequest(seed.agentDir, headers);

    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.code, "protected", "the client tells this apart from a write failure");
    assert.equal(typeof body.reason, "string", "the refusal names the rule that spoke");
    assert.equal(body.reason, "omp-runtime");

    // The part that matters. Not "the request was refused" — "the chats are
    // still on disk", checked against the filesystem after the response.
    seed.assertIntact();
  });
});

test("a non-admin cannot delete the agent directory either, and it survives", async () => {
  await withAccount(async ({ home, headers }) => {
    const seed = seedAgentDir(home);

    const response = await deleteRequest(seed.agentDir, headers);

    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "protected");
    seed.assertIntact();
  });
});

test("a single transcript file inside the agent directory is refused too", async () => {
  await withAdmin(async ({ home, headers }) => {
    const seed = seedAgentDir(home);

    const response = await deleteRequest(seed.transcript, headers);

    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "protected");
    seed.assertIntact();
  });
});

// ------------------------------------------------------- DELETE: negative list --

test("an ordinary project directory is still deletable, for a non-admin", async () => {
  await withAccount(async ({ home, headers }) => {
    const doomed = join(home, "workspace", "proj", "build-output");
    mkdirSync(doomed, { recursive: true });
    writeFileSync(join(doomed, "bundle.js"), "//x\n");

    const response = await deleteRequest(doomed, headers);

    const body = await readJson(response);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(existsSync(doomed), false, "a project folder must remain deletable");
    assert.equal(existsSync(join(home, "workspace", "proj")), true, "and only that folder");
  });
});

test("an ordinary project directory is still deletable, for an admin", async () => {
  await withAdmin(async ({ home, headers }) => {
    const doomed = join(home, "workspace", "proj", "dist");
    mkdirSync(doomed, { recursive: true });

    const response = await deleteRequest(doomed, headers);

    const body = await readJson(response);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(existsSync(doomed), false);
  });
});

test("a file inside a project directory is still deletable", async () => {
  await withAccount(async ({ home, headers }) => {
    const scratch = join(home, "workspace", "proj", "src");
    mkdirSync(scratch, { recursive: true });
    const file = join(scratch, "notes.txt");
    writeFileSync(file, "todo\n");

    const response = await deleteRequest(file, headers);

    const body = await readJson(response);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(existsSync(file), false);
  });
});

// ------------------------------------------------- transfers: source protected --

for (const type of ["move", "copy"]) {
  test(`a ${type} out of the agent directory is refused and the source survives`, async () => {
    await withAdmin(async ({ home, headers }) => {
      const seed = seedAgentDir(home);
      const destination = join(home, "workspace", "elsewhere");
      mkdirSync(destination, { recursive: true });

      const response = await postRequest(seed.agentDir, type, headers, { destination });
      const body = await readJson(response);

      assert.equal(response.status, 403, JSON.stringify(body));
      assert.equal(body.code, "protected");
      seed.assertIntact();
      assert.equal(existsSync(join(destination, ".omp")), false, "nothing was copied out");
    });
  });
}

test("a rename inside the agent directory is refused and nothing moves", async () => {
  await withAdmin(async ({ home, headers }) => {
    const seed = seedAgentDir(home);

    const response = await postRequest(seed.agentDir, "rename", headers, { name: "renamed" });
    const body = await readJson(response);

    assert.equal(response.status, 403, JSON.stringify(body));
    assert.equal(body.code, "protected");
    seed.assertIntact();
    assert.equal(existsSync(join(seed.project, "renamed")), false);
  });
});

// ------------------------------------------------ transfers: target protected --

test("a copy *into* the agent directory is refused and nothing lands", async () => {
  await withAdmin(async ({ home, headers }) => {
    const seed = seedAgentDir(home);
    const destination = join(seed.agentDir, "agent", "skills");
    mkdirSync(destination, { recursive: true });
    const payload = join(home, "workspace", "payload");
    mkdirSync(payload, { recursive: true });
    writeFileSync(join(payload, "data.txt"), "x\n");

    const response = await postRequest(payload, "copy", headers, { destination });
    const body = await readJson(response);

    assert.equal(response.status, 403, JSON.stringify(body));
    assert.equal(body.code, "protected");
    assert.equal(existsSync(join(destination, "payload")), false);
    seed.assertIntact();
  });
});

test("a move *into* the agent directory is refused and the source survives", async () => {
  await withAdmin(async ({ home, headers }) => {
    const seed = seedAgentDir(home);
    const destination = join(seed.agentDir, "agent", "plugins");
    mkdirSync(destination, { recursive: true });
    const payload = join(home, "workspace", "payload");
    mkdirSync(payload, { recursive: true });

    const response = await postRequest(payload, "move", headers, { destination });
    const body = await readJson(response);

    assert.equal(response.status, 403, JSON.stringify(body));
    assert.equal(body.code, "protected");
    assert.equal(existsSync(payload), true, "a refused move removes nothing");
  });
});

// ------------------------------------------------------------ mkdir and wiring --

test("mkdir inside the agent directory is refused and creates nothing", async () => {
  await withAdmin(async ({ home, headers }) => {
    const seed = seedAgentDir(home);

    const response = await postRequest(seed.agentDir, "mkdir", headers, { name: "extensions" });
    const body = await readJson(response);

    assert.equal(response.status, 403, JSON.stringify(body));
    assert.equal(body.code, "protected");
    assert.equal(existsSync(join(seed.agentDir, "extensions")), false);
    seed.assertIntact();
  });
});

test("mkdir in an ordinary project directory still works", async () => {
  await withAccount(async ({ home, headers }) => {
    const project = join(home, "workspace", "proj");
    mkdirSync(project, { recursive: true });

    const response = await postRequest(project, "mkdir", headers, { name: "src" });
    const body = await readJson(response);

    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(existsSync(join(project, "src")), true);
  });
});

test("a move between two ordinary project directories still works", async () => {
  await withAccount(async ({ home, headers }) => {
    const from = join(home, "workspace", "proj");
    const to = join(home, "workspace", "archive");
    mkdirSync(from, { recursive: true });
    mkdirSync(to, { recursive: true });
    writeFileSync(join(from, "notes.txt"), "keep\n");

    const response = await postRequest(join(from, "notes.txt"), "move", headers, { destination: to });
    const body = await readJson(response);

    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(existsSync(join(from, "notes.txt")), false);
    assert.equal(existsSync(join(to, "notes.txt")), true);
  });
});

/**
 * Wiring, not behaviour: every destructive call in this route is behind a
 * `protectedRefusal`, and the guard order the other tests depend on is intact.
 *
 * A count rather than a "somewhere before" search, because a check placed after
 * the `rmSync` it guards satisfies a positional search and protects nothing —
 * which is the shape the 2026-10-20 gap had in the dashboard route before it.
 */
test("every destructive call in the route is behind a protectedRefusal", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./[...path]/route.ts", import.meta.url), "utf8");

  const destructive = [...source.matchAll(/fs\.(rmSync|unlinkSync|renameSync)\s*\(/g)];
  assert.ok(destructive.length >= 4, `expected the delete, rename and move calls, found ${destructive.length}`);

  const guardSites = [...source.matchAll(/protectedRefusal\s*\(/g)].map((match) => match.index);
  assert.ok(guardSites.length >= 4, `expected a guard per handler, found ${guardSites.length}`);

  for (const call of destructive) {
    const before = source.slice(0, call.index);
    assert.ok(
      guardSites.some((site) => site < call.index),
      `a destructive call has no protection check before it: ${source.slice(call.index, call.index + 40)}`,
    );
    // The write guard stays first: a caller without write access gets the
    // permission error rather than an answer about which trees exist.
    const lastWriteGuard = before.lastIndexOf("isWritePathAllowed(");
    const lastTransferGuard = before.lastIndexOf("authorizeTransfer(");
    const lastProtection = guardSites.filter((site) => site < call.index).pop();
    assert.ok(
      lastProtection > lastWriteGuard && lastProtection > lastTransferGuard,
      "the protection check must come after the write guard, not instead of it",
    );
  }
});