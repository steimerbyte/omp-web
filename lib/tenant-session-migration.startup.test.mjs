import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { runTenantArchiveMigrationAtStartup } from "./tenant-session-migration.ts";

/**
 * Die Migration **beim Start**.
 *
 * `tenant-session-migration.test.mjs` prueft, was die Migration tut; diese Datei
 * prueft, dass sie ueberhaupt laeuft, einmal laeuft und im schlimmsten Fall
 * schweigt statt zu werfen. Der Unterschied ist der Fehler, den sie behebt: das
 * Modul war fertig und wurde von niemandem aufgerufen, und `CHANGELOG.md` sagte
 * dem Betreiber trotzdem eine Migration zu.
 */

const store = createRequire(import.meta.url)("../bin/web-auth-store.js");
const PASSWORD = "a-long-enough-password";
/** Haelt scrypt billig: hier wird die Kontenliste gelesen, nicht geprueft. */
const PARAMS = { cost: 16, keyLength: 32 };

const SAMUEL = { username: "samuel", isAdmin: false };
const OPERATOR = { username: "pi", isAdmin: true };

/**
 * Ein Scratch-Home samt Kontendatei — und optional je einem Bucket pro Konto,
 * geschrieben **vom SDK**, damit der `cwd` im Header die Form hat, die die
 * Migration prueft.
 */
async function seed(t, identities, { buckets = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "omp-web-migration-startup-"));
  const previous = {
    homeRoot: process.env.OMP_WEB_HOME_ROOT,
    accountsFile: process.env.OMP_WEB_ACCOUNTS_FILE,
    mode: process.env.OMP_WEB_TENANT_ARCHIVE_MIGRATION,
    agentDir: getAgentDir(),
  };
  const accountsFile = join(root, "omp-web-accounts.json");
  process.env.OMP_WEB_HOME_ROOT = root;
  process.env.OMP_WEB_ACCOUNTS_FILE = accountsFile;
  delete process.env.OMP_WEB_TENANT_ARCHIVE_MIGRATION;
  setAgentDir(join(root, "process-agent"));
  t.after(() => {
    const restore = (name, value) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("OMP_WEB_HOME_ROOT", previous.homeRoot);
    restore("OMP_WEB_ACCOUNTS_FILE", previous.accountsFile);
    restore("OMP_WEB_TENANT_ARCHIVE_MIGRATION", previous.mode);
    setAgentDir(previous.agentDir);
    rmSync(root, { recursive: true, force: true });
  });

  if (identities.length > 0) {
    const users = identities.map((identity) => ({
      username: identity.username,
      password: store.createDigest(PASSWORD, PARAMS),
      enabled: true,
      isAdmin: identity.isAdmin,
    }));
    writeFileSync(accountsFile, `${JSON.stringify({ version: 1, users, updatedAt: new Date().toISOString() })}\n`, {
      mode: 0o600,
    });
  }

  const bucketOf = new Map();
  if (!buckets) return { root, accountsFile, bucketOf };
  for (const identity of identities) {
    const home = join(root, identity.username);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const manager = SessionManager.create(home, SessionManager.getDefaultSessionDir(home));
    manager.appendMessage({ role: "user", content: `hallo von ${identity.username}` });
    await manager.ensureOnDisk();
    bucketOf.set(identity.username, manager.getSessionDir());
  }
  return { root, accountsFile, bucketOf };
}

/** Die Ausgabe eines Laufs, abgefangen und in Zeilen zerlegt. */
function captureOutput(t) {
  const lines = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args) => { lines.push(args.join(" ")); };
  console.error = (...args) => { lines.push(`ERROR ${args.map(String).join(" ")}`); };
  t.after(() => {
    console.log = realLog;
    console.error = realError;
  });
  return lines;
}

/** Der Prozess-Guard, auf "noch nicht gelaufen" gesetzt und danach zurueck. */
function resetGuard(t) {
  const previous = globalThis.__ompWebTenantArchiveMigrationStarted;
  delete globalThis.__ompWebTenantArchiveMigrationStarted;
  t.after(() => {
    if (previous === undefined) delete globalThis.__ompWebTenantArchiveMigrationStarted;
    else globalThis.__ompWebTenantArchiveMigrationStarted = previous;
  });
}

/** Ein Startlauf wie ihn `instrumentation.ts` macht, mit abgefangener Ausgabe. */
async function runStartup(t) {
  resetGuard(t);
  const lines = captureOutput(t);
  return { result: runTenantArchiveMigrationAtStartup(), lines };
}

test("beim Start zieht der Bestand um und protokolliert Bucket und Summe", async (t) => {
  const { root, bucketOf } = await seed(t, [SAMUEL, OPERATOR]);
  const bucketName = bucketOf.get("samuel").slice(bucketOf.get("samuel").lastIndexOf("/") + 1);
  const operatorBucket = bucketOf.get("pi");

  const { result, lines } = await runStartup(t);

  assert.equal(result.moved, 1);
  assert.equal(result.files, 1);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.buckets, [bucketName]);
  assert.deepEqual(lines, [
    `[archive-migration] ${bucketName} -> samuel (1 file)`,
    "[archive-migration] moved 1 buckets, 1 files, skipped 0",
  ]);

  const moved = join(root, "samuel", ".omp", "agent", "sessions", bucketName);
  assert.ok(!existsSync(bucketOf.get("samuel")), "die Quelle ist weg — verschoben, nicht kopiert");
  assert.equal(statSync(moved).mode & 0o777, 0o700, "der Bucket ist privat");
  const transcript = readdirSync(moved).find((name) => name.endsWith(".jsonl"));
  assert.ok(transcript, "das Transcript liegt im Bucket");
  assert.equal(statSync(join(moved, transcript)).mode & 0o777, 0o600, "das Transcript ist privat");
  assert.ok(existsSync(operatorBucket), "das Bucket eines Admins bleibt liegen");
});

test("ein zweiter Start bewegt nichts und sagt das in einer Zeile", async (t) => {
  await seed(t, [SAMUEL]);

  const first = await runStartup(t);
  assert.equal(first.result.moved, 1);

  const second = await runStartup(t);
  assert.equal(second.result.moved, 0);
  assert.equal(second.result.files, 0);
  assert.deepEqual(second.lines, ["[archive-migration] moved 0 buckets, 0 files, skipped 0"]);
});

test("eine frische Installation ist ein No-op in der Lautstaerke der Summe", async (t) => {
  const { root } = await seed(t, []);

  const { result, lines } = await runStartup(t);

  assert.deepEqual(lines, ["[archive-migration] moved 0 buckets, 0 files, skipped 0"]);
  assert.equal(result.moved, 0);
  // Ein Lauf ohne Befund legt nichts an — sonst waere jeder Start ein
  // Schreibzugriff auf ein Konto, das es nicht gibt.
  assert.ok(!existsSync(join(root, "process-agent", "sessions")), "kein Prozess-Archiv angelegt");
  assert.ok(!existsSync(join(root, "samuel")), "kein Konto-Verzeichnis angelegt");
});

test("ein Konto ohne Altbestand bekommt kein Manifest-Verzeichnis", async (t) => {
  const { root } = await seed(t, [SAMUEL], { buckets: false });

  const { result, lines } = await runStartup(t);

  // Dieselbe Ruhe wie eine frische Installation: nichts zu migrieren heisst,
  // auch nichts zu protokollieren ausser der Summe — und nichts anzulegen.
  assert.deepEqual(lines, ["[archive-migration] moved 0 buckets, 0 files, skipped 0"]);
  assert.equal(result.moved, 0);
  assert.ok(!existsSync(join(root, "samuel", ".omp", "agent", "migration")), "kein Manifest ohne Bucket");
});

test("dry run bewegt nichts und nennt das Bucket, das es bewegen wuerde", async (t) => {
  const { bucketOf } = await seed(t, [SAMUEL]);
  process.env.OMP_WEB_TENANT_ARCHIVE_MIGRATION = "dry-run";
  const source = bucketOf.get("samuel");
  const bucketName = source.slice(source.lastIndexOf("/") + 1);

  const { result, lines } = await runStartup(t);

  assert.equal(result.dryRun, true);
  assert.equal(result.moved, 0);
  assert.deepEqual(result.buckets, [bucketName]);
  assert.deepEqual(lines, [
    `[archive-migration] would move ${bucketName} -> samuel (1 file)`,
    "[archive-migration] moved 0 buckets, 0 files, skipped 1 (dry run, nothing was moved)",
  ]);
  assert.ok(existsSync(source), "die Quelle liegt unveraendert da");
});

test("ein Bucket mit vorhandenem Ziel wird mit Grund gemeldet, nicht still uebersprungen", async (t) => {
  const { root, bucketOf } = await seed(t, [SAMUEL]);
  const source = bucketOf.get("samuel");
  const bucketName = source.slice(source.lastIndexOf("/") + 1);
  // Der Fall, der im Betrieb vorkommt: das Ziel existiert schon (ein zweiter
  // Rechner, eine halb gelaufene Migration). Die Migration ueberschreibt es
  // nicht — aber die Summe allein sagte nicht, welches Bucket liegen blieb.
  mkdirSync(join(root, "samuel", ".omp", "agent", "sessions", bucketName), { recursive: true, mode: 0o700 });

  const { result, lines } = await runStartup(t);

  assert.equal(result.moved, 0);
  assert.equal(result.skipped, 1);
  assert.match(lines[0], new RegExp(`^\\[archive-migration\\] skipped ${bucketName} -> samuel: target already exists`));
  assert.equal(lines[1], "[archive-migration] moved 0 buckets, 0 files, skipped 1");
  assert.ok(existsSync(source), "die Quelle bleibt liegen");
});

test("ein Fehler beim Lauf wird zu einer Zeile, nicht zu einem Wurf", async (t) => {
  await seed(t, [SAMUEL]);
  // Eine unlesbare Kontendatei ist der billigste echte Fehler an dieser Stelle.
  writeFileSync(process.env.OMP_WEB_ACCOUNTS_FILE, "{ kaputt", { mode: 0o600 });

  const { result, lines } = await runStartup(t);

  assert.equal(result, null);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ERROR \[archive-migration\] /);
  assert.match(lines[0], /could not be read/);
});

test("derselbe Prozess fragt nicht zweimal", async (t) => {
  await seed(t, [SAMUEL]);
  resetGuard(t);
  const lines = captureOutput(t);

  const first = runTenantArchiveMigrationAtStartup();
  assert.equal(first.moved, 1);
  assert.equal(runTenantArchiveMigrationAtStartup(), null, "ein zweiter Aufruf im selben Prozess tut nichts");
  assert.equal(lines.length, 2, "der zweite Aufruf schreibt nicht einmal eine Summenzeile");
});
