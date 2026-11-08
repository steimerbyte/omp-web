import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import {
  prepareTenantSessionDir,
  tenantSessionDirForCwd,
  tenantSessionsRoot,
  processSessionsRoot,
  tightenTenantSessionTree,
} from "./tenant-sessions.ts";

/**
 * Wo ein Konto seine Sessions ablegt.
 *
 * Die Behauptungen gelten dem Verhalten, nicht der Form: das Prozess-Archiv des
 * Admins bleibt, wo es ist; ein Nicht-Admin bekommt ein eigenes; die beiden
 * Pfade liegen verschiedene Eltern entlang; und was angelegt wird, ist `0700`.
 */

const TENANT = { username: "samuel", isAdmin: false };
const ADMIN = { username: "pi", isAdmin: true };

function withHomeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "omp-web-tenant-sessions-"));
  const previousRoot = process.env.OMP_WEB_HOME_ROOT;
  const previousAgentDir = getAgentDir();
  process.env.OMP_WEB_HOME_ROOT = root;
  setAgentDir(join(root, "process-agent"));
  t.after(() => {
    if (previousRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
    else process.env.OMP_WEB_HOME_ROOT = previousRoot;
    setAgentDir(previousAgentDir);
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("ein Mandant bekommt sein Archiv unter seinem eigenen Agent-Verzeichnis", (t) => {
  const root = withHomeRoot(t);

  assert.equal(
    tenantSessionsRoot(TENANT),
    join(root, "samuel", ".omp", "agent", "sessions"),
    "the archive has to live inside the tenant's own agent directory",
  );
});

test("der Admin bleibt beim Prozess-Archiv — dort ist sein Bestand", (t) => {
  withHomeRoot(t);

  assert.equal(tenantSessionsRoot(ADMIN), null, "an admin has no separate tenant root");
  assert.equal(tenantSessionsRoot(null), null, "the internal start path has no tenant root either");
  assert.equal(processSessionsRoot(), join(getAgentDir(), "sessions"));
});

test("zwei Konten bekommen zwei Archive, keines ist ein Praefix des anderen", (t) => {
  withHomeRoot(t);

  const samuel = tenantSessionsRoot({ username: "samuel", isAdmin: false });
  const sam = tenantSessionsRoot({ username: "sam", isAdmin: false });

  assert.notEqual(samuel, sam);
  assert.ok(!samuel.startsWith(`${sam}/`), `${samuel} must not sit under ${sam}`);
  assert.ok(!sam.startsWith(`${samuel}/`), `${sam} must not sit under ${samuel}`);
});

test("der Bucket-Name kommt vom SDK, nicht aus einer zweiten Encoding-Regel", async (t) => {
  const root = withHomeRoot(t);
  const cwd = join(root, "samuel", "projekt");

  const dir = tenantSessionDirForCwd(TENANT, cwd);

  assert.ok(dir, "a tenant session dir must resolve");
  assert.equal(
    dir,
    (await import("@oh-my-pi/pi-coding-agent")).SessionManager.getDefaultSessionDir(
      cwd,
      join(root, "samuel", ".omp", "agent"),
    ),
    "the bucket must be the SDK's own cwd encoding",
  );
  assert.ok(dir.startsWith(join(root, "samuel", ".omp", "agent", "sessions") + "/"));
});

test("das angelegte Bucket-Verzeichnis ist 0700, auch wenn es vorher 0755 war", (t) => {
  const root = withHomeRoot(t);
  const cwd = join(root, "samuel");

  const dir = prepareTenantSessionDir(TENANT, cwd);
  assert.equal(statSync(dir).mode & 0o777, 0o700, "a fresh bucket is private");

  // Ein Bucket, den das SDK vorher mit der umask angelegt hat, muss nachgezogen
  // werden — `mkdir` mit `mode` wirkt nur beim Anlegen.
  chmodSync(dir, 0o755);
  prepareTenantSessionDir(TENANT, cwd);
  assert.equal(statSync(dir).mode & 0o777, 0o700, "an existing 0755 bucket is tightened");
});

test("fuer Admin und für den konto-losen Start bleibt der Pfad undefined", (t) => {
  withHomeRoot(t);

  assert.equal(prepareTenantSessionDir(ADMIN, "/tmp/whatever"), null);
  assert.equal(prepareTenantSessionDir(null, "/tmp/whatever"), null);
});

test("tighten setzt Dateien auf 0600 und Verzeichnisse auf 0700", (t) => {
  const root = withHomeRoot(t);
  const dir = prepareTenantSessionDir(TENANT, join(root, "samuel"));
  const nested = join(dir, "artefakte");
  mkdirSync(nested, { recursive: true });
  const file = join(dir, "session.jsonl");
  const nestedFile = join(nested, "draft.txt");
  writeFileSync(file, "{}\n");
  writeFileSync(nestedFile, "x");
  chmodSync(file, 0o644);
  chmodSync(nestedFile, 0o644);
  chmodSync(nested, 0o755);

  const changed = tightenTenantSessionTree(dir);

  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(nestedFile).mode & 0o777, 0o600);
  assert.equal(statSync(nested).mode & 0o777, 0o700);
  assert.equal(changed.files, 2);
  assert.equal(changed.dirs, 1);
});

test("tighten ist idempotent und verträgt einen fehlenden Baum", (t) => {
  const root = withHomeRoot(t);
  const dir = prepareTenantSessionDir(TENANT, join(root, "samuel"));
  writeFileSync(join(dir, "a.jsonl"), "{}\n");

  const first = tightenTenantSessionTree(dir);
  const second = tightenTenantSessionTree(dir);

  assert.deepEqual(second, first, "a second pass reports the same tree");
  assert.deepEqual(tightenTenantSessionTree(join(root, "does-not-exist")), { dirs: 0, files: 0 });
});
