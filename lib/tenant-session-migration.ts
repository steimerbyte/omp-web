import { createHash } from "crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { join, relative } from "path";
import { isAdminIdentity, getUserHome, type WebIdentity } from "./request-identity";
import { readSessionRecord } from "./session-reader";
import { isPathWithinRoots } from "./path-security";
import {
  prepareTenantSessionDir,
  processSessionsRoot,
  tenantSessionsRoot,
  tightenTenantSessionTree,
} from "./tenant-sessions";

/**
 * Einmalige Migration der vorhandenen Session-Archive in die Mandantenordner.
 *
 * ### Ausgangslage
 *
 * Bis zu dieser Aenderung liegt das Archiv jedes Kontos im **Prozess**-Archiv
 * (`~/.omp/agent/sessions/<bucket>`), weil das SDK fuer alle Konten denselben
 * Agent-Ordner benutzt. `docs/plans/tenant-isolation.md` §9/§10 verlangt, dass
 * ein Nicht-Admin sein Archiv unter seinem eigenen Agent-Ordner bekommt. Der
 * Bestand muss also umziehen — und zwar **einmal**, nachvollziehbar und
 * wiederholbar, nicht "irgendwann beim ersten Request".
 *
 * ### Warum ein ganzes Bucket-Verzeichnis und nicht einzelne Dateien
 *
 * Das SDK legt zu jeder Session neben der `.jsonl` ein Verzeichnis gleichen
 * Namens mit den Artefakten an (gemessen am 2026-11-08 im Bucket
 * `-accounts-samuel`). Eine Datei-fuer-Datei-Migration wuerde die Artefakte
 * zuruecklassen und die Session danach halb funktionsfaehig machen. Ein Bucket
 * ist die Einheit, in der das SDK denkt; er ist es hier auch.
 *
 * ### Woran ein Bucket seinem Konto zugeordnet wird
 *
 * **Nicht** am Verzeichnisnamen. Der Name ist eine Kodierung des `cwd` relativ
 * zum Home des Dienstes (`-accounts-samuel`), und eine Praefix-Suche darin
 * haelt `-accounts-samuel2` fuer einen Treffer. Die Zuordnung kommt deshalb aus
 * dem Inhalt: der `session`-Record jeder `.jsonl` traegt den `cwd`, und das ist
 * dieselbe Grenze, die `isSessionOwnedBy` in `lib/session-reader.ts` schon
 * zieht. Ein Bucket zieht nur um, wenn **jede** Session darin im Home genau
 * dieses Kontos liegt; enthaelt er eine fremde, bleibt er stehen und wird mit
 * Grund gemeldet. Ein halb umgezogener Bucket waere schlimmer als keiner: die
 * Session waere danach fuer beide Konten unsichtbar oder fuer beide sichtbar.
 *
 * ### Was "idempotent" hier konkret heisst
 *
 * Ein zweiter Lauf findet an derselben Stelle nichts mehr, weil `renameSync`
 * die Quelle entfernt hat. Er meldet dann `buckets: []`. Ein **vorhandenes
 * Ziel** wird nie ueberschrieben und nie zusammengefuehrt: zwei Buckets
 * zusammenzulegen ist eine Entscheidung ueber zwei Session-Bestaende, kein
 * Migrationsschritt, und ein stilles Mergen waere der Weg, auf dem ein Konto
 * die Sessions eines anderen erbt.
 *
 * ### Die sha256-Liste
 *
 * Vor und nach dem Verschieben wird jede Datei gehasht. Der Vergleich ist die
 * eigentliche Zusage: nicht "der Rename hat nicht geworfen", sondern "die Bytes
 * sind dieselben, nur unter einem anderen Elternpfad". Die Listen landen als
 * JSON neben dem Archiv (`<agentDir>/migration/`), damit ein Betreiber den Lauf
 * nachpruefen kann, ohne ihn zu wiederholen.
 */

export interface FileDigest {
  /** Pfad relativ zur Bucket-Wurzel, damit sich vor/nach vergleichen laesst. */
  path: string;
  sha256: string;
  size: number;
}

export interface BucketMigration {
  /** Der Verzeichnisname des Buckets, z.B. `-accounts-samuel`. */
  bucket: string;
  from: string;
  to: string;
  /** Anzahl `.jsonl`-Dateien im Bucket. */
  sessions: number;
  /** Anzahl aller Dateien (Sessions plus Artefakte). */
  files: number;
  bytes: number;
  moved: boolean;
  /** Warum nicht umgezogen wurde. Nur gesetzt, wenn `moved === false`. */
  skipReason?: string;
  before: FileDigest[];
  after: FileDigest[];
  /** `true`, wenn `before` und `after` dieselbe Dateimenge mit denselben Hashes sind. */
  digestMatch: boolean;
}

export interface SessionArchiveMigration {
  identity: string;
  fromRoot: string;
  toRoot: string;
  buckets: BucketMigration[];
  /** Absolute Pfade der geschriebenen Manifeste (vorher/nachher). */
  manifests: { before: string | null; after: string | null };
  /** Konten, die nicht migriert werden duerfen, und warum. */
  refused?: string;
}

export type SessionArchiveMigrationResult =
  | SessionArchiveMigration
  | { ok: false; reason: "admin-identity" | "no-tenant-root"; detail: string; remediation: string };

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Alle regulaeren Dateien unter `root`, rekursiv, als Pfade relativ zu `root`. */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile()) out.push(relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

function digestTree(root: string): FileDigest[] {
  return listFiles(root).map((rel) => {
    const full = join(root, rel);
    let size = 0;
    try {
      size = statSync(full).size;
    } catch { /* zwischen Liste und stat verschwunden */ }
    return { path: rel, sha256: sha256File(full), size };
  });
}

/** Die `cwd`s aller Sessions eines Buckets. `null` heisst: keine lesbare Session. */
function bucketSessionCwds(bucketDir: string): string[] | null {
  let names: string[];
  try {
    names = readdirSync(bucketDir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  const cwds: string[] = [];
  for (const name of names) {
    const record = readSessionRecord(join(bucketDir, name));
    // Eine Session ohne lesbaren Header ist ein Befund, kein Grund zu raten:
    // ohne `cwd` laesst sich der Besitz nicht bestimmen.
    if (!record || typeof record.cwd !== "string" || record.cwd.length === 0) return null;
    cwds.push(record.cwd);
  }
  return cwds;
}

function writeManifest(dir: string, label: string, buckets: BucketMigration[]): string | null {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const file = join(dir, `${label}.json`);
    writeFileSync(file, `${JSON.stringify({ label, createdAt: new Date().toISOString(), buckets }, null, 2)}\n`, {
      mode: 0o600,
    });
    chmodSync(file, 0o600);
    return file;
  } catch {
    // Ein nicht schreibbares Manifest darf die Migration nicht verhindern: die
    // Hashes werden im Ergebnis mitgeliefert und sind damit auch ohne Datei
    // belegt.
    return null;
  }
}

/**
 * Das Archiv eines Kontos in dessen eigenen Agent-Ordner verschieben.
 *
 * `dryRun` sammelt die Hashes, verschiebt aber nichts — fuer einen Betreiber,
 * der vorher sehen will, was passieren wuerde.
 */
export function migrateSessionArchive(
  identity: WebIdentity,
  options: { dryRun?: boolean; manifestDir?: string } = {},
): SessionArchiveMigrationResult {
  if (isAdminIdentity(identity)) {
    return {
      ok: false,
      reason: "admin-identity",
      detail: "An admin's sessions live in the process agent directory by decision; there is nothing to migrate.",
      remediation: "Run the migration per non-admin account. Admin archives stay where they are (docs/plans/tenant-isolation.md §9).",
    };
  }
  const toRoot = tenantSessionsRoot(identity);
  if (toRoot === null) {
    return {
      ok: false,
      reason: "no-tenant-root",
      detail: `No tenant session root could be derived for ${identity.username}.`,
      remediation: "Check that OMP_WEB_HOME_ROOT and the account name resolve to a home directory.",
    };
  }

  const fromRoot = processSessionsRoot();
  const home = getUserHome(identity);
  const homes = new Set([home]);
  const buckets: BucketMigration[] = [];

  for (const name of existsSync(fromRoot) ? readdirSync(fromRoot) : []) {
    const from = join(fromRoot, name);
    try {
      if (!statSync(from).isDirectory()) continue;
    } catch {
      continue;
    }
    const cwds = bucketSessionCwds(from);
    // Buckets ohne `.jsonl` sind keine Session-Buckets (Artefakt-Reste,
    // Diagnose-Verzeichnisse) und gehen niemanden hier etwas an.
    if (cwds === null) continue;
    const owned = cwds.every((cwd) => isPathWithinRoots(cwd, homes));
    if (!owned) continue;

    const to = join(toRoot, name);
    const entry: BucketMigration = {
      bucket: name,
      from,
      to,
      sessions: cwds.length,
      files: 0,
      bytes: 0,
      moved: false,
      before: digestTree(from),
      after: [],
      digestMatch: false,
    };
    entry.files = entry.before.length;
    entry.bytes = entry.before.reduce((sum, file) => sum + file.size, 0);

    if (existsSync(to)) {
      // Nie ueberschreiben, nie mergen. Der Grund gehoert in das Ergebnis,
      // sonst sieht der Betreiber nur "nicht umgezogen".
      entry.skipReason = `target already exists: ${to}`;
      buckets.push(entry);
      continue;
    }
    if (options.dryRun) {
      entry.skipReason = "dry run";
      buckets.push(entry);
      continue;
    }

    mkdirSync(toRoot, { recursive: true, mode: 0o700 });
    try {
      renameSync(from, to);
    } catch (error) {
      entry.skipReason = `rename failed: ${String(error)}`;
      buckets.push(entry);
      continue;
    }
    entry.moved = true;
    // Der Bucket-Pfad muss vor dem ersten Schreibzugriff 0700 sein; `rename`
    // hat den Modus des Quellverzeichnisses mitgebracht.
    prepareTenantSessionDir(identity, cwds[0]);
    tightenTenantSessionTree(to);
    entry.after = digestTree(to);
    entry.digestMatch = sameDigests(entry.before, entry.after);
    buckets.push(entry);
  }

  const manifestDir = options.manifestDir ?? join(toRoot, "..", "migration");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const manifests = options.dryRun
    ? { before: null, after: null }
    : {
      before: writeManifest(manifestDir, `${stamp}-before`, buckets),
      after: writeManifest(manifestDir, `${stamp}-after`, buckets),
    };

  return {
    identity: identity.username,
    fromRoot,
    toRoot,
    buckets,
    manifests,
  };
}

/** Dieselbe Datei-Relation mit demselben Inhalt, in derselben Reihenfolge. */
function sameDigests(before: FileDigest[], after: FileDigest[]): boolean {
  if (before.length !== after.length) return false;
  for (let i = 0; i < before.length; i += 1) {
    if (before[i].path !== after[i].path) return false;
    if (before[i].sha256 !== after[i].sha256) return false;
    if (before[i].size !== after[i].size) return false;
  }
  return true;
}

/**
 * Die Migration fuer mehrere Konten, mit einem gemeinsamen Manifest-Paar.
 *
 * Getrennt von `migrateSessionArchive`, weil ein Betreiber ueblicherweise alle
 * Konten auf einmal umstellt und danach **eine** Liste sehen will. Ein Konto,
 * das abgelehnt wird (Admin) oder nichts zu migrieren hat, ist kein Fehler des
 * Laufs.
 */
export function migrateAllSessionArchives(
  identities: WebIdentity[],
  options: { dryRun?: boolean; manifestDir?: string } = {},
): { results: SessionArchiveMigrationResult[] } {
  return { results: identities.map((identity) => migrateSessionArchive(identity, options)) };
}
