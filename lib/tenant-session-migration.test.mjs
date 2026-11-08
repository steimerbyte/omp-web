import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { migrateAllSessionArchives, migrateSessionArchive } from "./tenant-session-migration.ts";

/**
 * Die Migration des Bestands.
 *
 * Was hier behauptet wird, sind die drei Zusagen aus
 * `docs/plans/tenant-isolation.md` §10: der Bestand zieht **um** statt kopiert
 * zu werden, ein zweiter Lauf tut nichts mehr, und ein vorhandenes Ziel wird
 * nie ueberschrieben. Dazu die vierte, die den ganzen Vorgang traegt: ein Admin
 * wandert nicht.
 */

const SAMUEL = { username: "samuel", isAdmin: false };
const HANNAH = { username: "hannah", isAdmin: false };
const ADMIN = { username: "pi", isAdmin: true };

/**
 * Ein Prozess-Archiv mit je einem Bucket fuer die genannten Konten.
 *
 * Die Buckets werden **vom SDK** geschrieben, nicht von Hand nachgebaut: nur so
 * traegt der `cwd` im Header dieselbe Form, die `isSessionOwnedBy` spaeter
 * prueft, und der Test kann nicht an einer Fixture bestehen, die es auf der
 * Platte so nicht gibt.
 */
async function seedProcessArchive(t, identities) {
  const root = mkdtempSync(join(tmpdir(), "omp-web-migration-"));
  const bucketOf = new Map();
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

  for (const identity of identities) {
    const home = join(root, identity.username);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const manager = SessionManager.create(home, SessionManager.getDefaultSessionDir(home));
    manager.appendMessage({ role: "user", content: `hallo von ${identity.username}` });
    await manager.ensureOnDisk();
    // Der Bucket-Name ist die cwd-Kodierung des SDK relativ zum Home des
    // Prozesses — unter einem Scratch-Home-Root also nicht `-<name>`. Er wird
    // deshalb gemessen, nicht geraten.
    bucketOf.set(identity.username, manager.getSessionDir());
  }
  return { root, bucketOf };
}

test("das Bucket eines Kontos zieht um und die Bytes bleiben dieselben", async (t) => {
  const { root, bucketOf } = await seedProcessArchive(t, [SAMUEL]);
  const before = bucketOf.get("samuel");
  const bucketName = before.slice(before.lastIndexOf("/") + 1);

  const result = migrateSessionArchive(SAMUEL);

  assert.ok(!("ok" in result), `migration must succeed: ${JSON.stringify(result)}`);
  assert.equal(result.buckets.length, 1, "one bucket belongs to samuel");
  const bucket = result.buckets[0];
  assert.equal(bucket.moved, true);
  assert.equal(bucket.skipReason, undefined);
  assert.equal(bucket.digestMatch, true, "before and after must hash identically");
  assert.equal(bucket.sessions, 1);
  assert.ok(existsSync(bucket.to), "the bucket is at its new place");
  assert.ok(!existsSync(before), "and no longer at the old one — moved, not copied");
  assert.equal(bucket.to, join(root, "samuel", ".omp", "agent", "sessions", bucketName));
});

test("ein zweiter Lauf tut nichts mehr und meldet keinen Bucket", async (t) => {
  await seedProcessArchive(t, [SAMUEL]);

  const first = migrateSessionArchive(SAMUEL);
  assert.ok(!("ok" in first) && first.buckets.length === 1);
  const second = migrateSessionArchive(SAMUEL);

  assert.ok(!("ok" in second));
  assert.deepEqual(second.buckets, [], "an idempotent second run finds nothing left to move");
});

test("ein vorhandenes Ziel wird nie überschrieben", async (t) => {
  const { root, bucketOf } = await seedProcessArchive(t, [SAMUEL]);
  const source = bucketOf.get("samuel");
  // Ein Ziel, das schon etwas enthaelt: der Bestand im Quell-Bucket darf es
  // nicht ersetzen und nicht mit ihm verschmelzen.
  const target = join(root, "samuel", ".omp", "agent", "sessions", source.slice(source.lastIndexOf("/") + 1));
  mkdirSync(target, { recursive: true, mode: 0o700 });
  writeFileSync(join(target, "vorhanden.jsonl"), "{\"type\":\"session\"}\n");

  const result = migrateSessionArchive(SAMUEL);

  assert.ok(!("ok" in result));
  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0].moved, false);
  assert.match(result.buckets[0].skipReason, /target already exists/);
  assert.ok(existsSync(source), "the source stays where it was");
  assert.equal(readFileSync(join(target, "vorhanden.jsonl"), "utf8"), "{\"type\":\"session\"}\n");
});

test("die Sessions eines Admins wandern nicht", async (t) => {
  const { root } = await seedProcessArchive(t, [ADMIN]);
  const adminBucket = join(root, "process-agent", "sessions");

  const result = migrateSessionArchive(ADMIN);

  assert.ok("ok" in result, "an admin is refused, not silently migrated");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "admin-identity");
  assert.ok(result.remediation.includes("non-admin"));
  assert.ok(existsSync(adminBucket), "the admin archive is untouched");
});

test("ein fremdes Bucket bleibt stehen — halb umziehen wäre schlimmer als nicht", async (t) => {
  const { root, bucketOf } = await seedProcessArchive(t, [SAMUEL, HANNAH]);
  const hannahBucket = bucketOf.get("hannah");
  const hannahName = hannahBucket.slice(hannahBucket.lastIndexOf("/") + 1);

  const result = migrateSessionArchive(SAMUEL);

  assert.ok(!("ok" in result));
  // Nur samuels eigenes Bucket ist im Ergebnis; hannahs bleibt unberuehrt.
  assert.deepEqual(result.buckets.map((b) => b.bucket), [bucketOf.get("samuel").slice(bucketOf.get("samuel").lastIndexOf("/") + 1)]);
  assert.ok(existsSync(hannahBucket), "a sibling's bucket is not touched");
  assert.ok(!existsSync(join(root, "samuel", ".omp", "agent", "sessions", hannahName)));
});

test("dry run hasht, verschiebt aber nicht", async (t) => {
  const { bucketOf } = await seedProcessArchive(t, [SAMUEL]);
  const source = bucketOf.get("samuel");

  const result = migrateSessionArchive(SAMUEL, { dryRun: true });

  assert.ok(!("ok" in result));
  assert.equal(result.buckets[0].moved, false);
  assert.equal(result.buckets[0].skipReason, "dry run");
  assert.equal(result.buckets[0].before.length, 1, "the hashes are still measured");
  assert.equal(result.buckets[0].after.length, 0);
  assert.ok(existsSync(source), "nothing moved");
});

test("die Manifeste liegen neben dem Archiv und tragen die Hashes", async (t) => {
  await seedProcessArchive(t, [SAMUEL]);

  const result = migrateSessionArchive(SAMUEL);

  assert.ok(!("ok" in result));
  assert.ok(result.manifests.before, "a before-manifest is written");
  assert.ok(result.manifests.after, "an after-manifest is written");
  const before = JSON.parse(readFileSync(result.manifests.before, "utf8"));
  const after = JSON.parse(readFileSync(result.manifests.after, "utf8"));
  assert.equal(before.label.includes("before"), true);
  assert.equal(before.buckets[0].before[0].sha256.length, 64);
  assert.equal(after.buckets[0].digestMatch, true);
  // Manifeste sind selbst keine Weltdatei.
  assert.equal(statSync(result.manifests.before).mode & 0o777, 0o600);
});

test("das migrierte Bucket ist danach 0700, seine Dateien 0600", async (t) => {
  await seedProcessArchive(t, [SAMUEL]);

  const result = migrateSessionArchive(SAMUEL);

  assert.ok(!("ok" in result));
  const bucket = result.buckets[0];
  assert.equal(statSync(bucket.to).mode & 0o777, 0o700, "the bucket is private");
  const sessionFile = statSync(join(bucket.to, bucket.after[0].path));
  assert.equal(sessionFile.mode & 0o777, 0o600, "the transcript is private");
});

test("mehrere Konten in einem Lauf, jedes mit eigenem Ergebnis", async (t) => {
  const { root } = await seedProcessArchive(t, [SAMUEL, HANNAH]);

  const { results } = migrateAllSessionArchives([SAMUEL, HANNAH, ADMIN]);

  assert.equal(results.length, 3);
  const byName = new Map(
    results.map((r) => ["ok" in r ? r.reason : r.identity, r]),
  );
  assert.ok(!("ok" in byName.get("samuel")));
  assert.ok(!("ok" in byName.get("hannah")));
  assert.ok("ok" in byName.get("admin-identity"));
  for (const name of ["samuel", "hannah"]) {
    assert.equal(
      statSync(join(root, name, ".omp", "agent", "sessions")).mode & 0o777,
      0o700,
      `${name}'s archive root is private`,
    );
  }
});
