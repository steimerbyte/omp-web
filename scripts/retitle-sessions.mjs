#!/usr/bin/env bun
/**
 * Session-Titel neu erzeugen: `bun scripts/retitle-sessions.mjs`.
 *
 * Warum es das gibt
 * ----------------
 * Der Titel-Prompt und die Emoji-Tabelle wurden am 2026-11-18 geaendert; auf
 * dem Produktionshost trugen 81 von 91 automatischen Titeln gar kein Emoji und
 * 6 der 10 Emoji-Titel die Sprechblase. Alte Titel bleiben alt, bis jemand sie
 * neu schreibt — dafuer ist dieses Skript da.
 *
 * Was es anfasst
 * --------------
 *   - `source: "auto"`-Titel und leere Legacy-Records (`title: ""`).
 *   - `source: "user"`-Titel nur mit `--include-user`.
 *   - Subagent-Dateien (Tiefe >= 3 unter dem Wurzelverzeichnis) nie.
 *   - Dateien, die in den letzten 30 Minuten geschrieben wurden, nie: eine
 *     laufende Session schreibt ihre eigene Datei, ein Titellauf darf sie nicht
 *     ueberholen. `--since-hours` verschiebt die Grenze.
 * Die Entscheidung selbst steht in `lib/retitle-selection.ts` und ist dort
 * getestet; dieses Skript liest nur ein.
 *
 * Wie es schreibt
 * ---------------
 * Durch omp's `SessionManager`/`setSessionName(..., "auto")` — nie durch
 * Handbearbeiten der JSONL. Vor dem ersten Schreibvorgang landet der alte
 * Zustand jeder ausgewaehlten Datei in einem Backup (JSONL); `--restore <datei>`
 * schreibt genau diese Titel-Slots zurueck (ueber den Speicher-Backend von omp,
 * inklusive Claim gegen einen laufenden Prozess).
 *
 * Aufruf:
 *   bun scripts/retitle-sessions.mjs                 # Dry-Run (Default)
 *   bun scripts/retitle-sessions.mjs --apply         # schreibt, mit Backup
 *   bun scripts/retitle-sessions.mjs --restore /tmp/omp-retitle-backup-<ts>.jsonl
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import { discoverAuthStorage, getAgentDir, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { generateSessionTitle as generateOmpSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import {
  findFirstTitleSource,
  firstEmoji,
  isUsableSessionTitle,
  replanTitleSource,
  TITLE_SYSTEM_PROMPT,
  truncateTitle,
  withSingleEmoji,
} from "../lib/session-title.ts";
import { decideRetitle, RETITLE_RECENT_MS } from "../lib/retitle-selection.ts";

const HEAD_BYTES = 64 * 1024;

function fail(message) {
  console.error(`retitle: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {
    dir: join(homedir(), ".omp/agent/sessions"),
    apply: false,
    limit: Number.POSITIVE_INFINITY,
    concurrency: 4,
    includeUser: false,
    onlyEmpty: false,
    sinceHours: RETITLE_RECENT_MS / 3_600_000,
    quiet: false,
    restore: undefined,
  };
  const value = (i, flag) => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) fail(`${flag} braucht einen Wert`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--dir":
        opts.dir = resolve(value(i, arg));
        i++;
        break;
      case "--dry-run":
        opts.apply = false;
        break;
      case "--apply":
        opts.apply = true;
        break;
      case "--limit": {
        const n = Number(value(i, arg));
        if (!Number.isInteger(n) || n < 0) fail("--limit braucht eine ganze Zahl >= 0");
        opts.limit = n;
        i++;
        break;
      }
      case "--concurrency": {
        const n = Number(value(i, arg));
        if (!Number.isInteger(n) || n < 1) fail("--concurrency braucht eine ganze Zahl >= 1");
        opts.concurrency = n;
        i++;
        break;
      }
      case "--since-hours": {
        const n = Number(value(i, arg));
        if (!Number.isFinite(n) || n < 0) fail("--since-hours braucht eine Zahl >= 0");
        opts.sinceHours = n;
        i++;
        break;
      }
      case "--include-user":
        opts.includeUser = true;
        break;
      case "--only-empty":
        opts.onlyEmpty = true;
        break;
      case "--quiet":
        opts.quiet = true;
        break;
      case "--restore":
        opts.restore = resolve(value(i, arg));
        i++;
        break;
      case "--help":
      case "-h":
        console.log(
          "bun scripts/retitle-sessions.mjs [--dir DIR] [--dry-run|--apply] [--limit N] [--concurrency N]\n" +
            "  [--include-user] [--only-empty] [--since-hours N] [--quiet] [--restore BACKUP.jsonl]",
        );
        process.exit(0);
        break;
      default:
        fail(`unbekannte Option ${arg}`);
    }
  }
  opts.recentMs = Math.round(opts.sinceHours * 3_600_000);
  if (opts.restore && opts.apply) fail("--restore schreibt zurueck; --apply ist dabei sinnlos");
  return opts;
}

/** Kopf der Datei: Titel-Slot plus so viele Zeilen, wie fuer die Session-ID noetig sind. */
function readHead(path) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const bytes = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytes).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function parseHead(text) {
  const lines = text.split("\n");
  let slot;
  let sessionId;
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!slot && record?.type === "title") slot = record;
    else if (!sessionId && record?.type === "session" && typeof record.id === "string") sessionId = record.id;
    if (slot && sessionId) break;
  }
  return { slot, sessionId };
}

function* walk(dir, root = dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path, root);
    else if (entry.name.endsWith(".jsonl")) yield path;
  }
}

function histogram(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

function printHistogram(label, values) {
  const total = values.length;
  console.log(`${label} (${total})`);
  for (const [emoji, count] of histogram(values)) {
    const share = total ? ((100 * count) / total).toFixed(2) : "0.00";
    console.log(`  ${emoji.padEnd(4)} ${String(count).padStart(5)}  ${share}%`);
  }
}

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

async function createTitleModel() {
  const agentDir = getAgentDir();
  const settings = await Settings.init({ agentDir });
  const authStorage = await discoverAuthStorage(agentDir);
  const registry = new ModelRegistry(authStorage);
  await registry.refresh("online-if-uncached");
  return { settings, registry };
}

/**
 * Genau der Weg von `generateSessionTitle` in `lib/session-title.ts`: erster
 * Versuch, bei Ablehnung ein Replan-Versuch, dann dieselbe Nachbearbeitung.
 */
async function titleFromSource(source, messages, sessionId, model, stats) {
  const generate = async (text) => {
    stats.modelCalls++;
    return generateOmpSessionTitle(
      text,
      model.registry,
      model.settings,
      sessionId,
      undefined,
      undefined,
      TITLE_SYSTEM_PROMPT,
    );
  };
  let raw = await generate(source);
  if (!raw) {
    const replan = replanTitleSource(messages, source);
    if (replan) raw = await generate(replan);
  }
  if (!raw) return null;
  const cleaned = truncateTitle(raw);
  if (!isUsableSessionTitle(cleaned)) return null;
  return withSingleEmoji(cleaned);
}

async function runRestore(file) {
  const rows = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const storage = new FileSessionStorage();
  let restored = 0;
  let failed = 0;
  for (const row of rows) {
    let slot;
    let sessionId;
    try {
      ({ slot, sessionId } = parseHead(readHead(row.path)));
    } catch (error) {
      failed++;
      console.error(`retitle: ${row.path}: nicht lesbar (${error instanceof Error ? error.message : error})`);
      continue;
    }
    if (!slot || !sessionId) {
      failed++;
      console.error(`retitle: ${row.path}: kein Titel-Slot, nicht angefasst`);
      continue;
    }
    const release = storage.claimSession(sessionId, row.path);
    if (!release) {
      failed++;
      console.error(`retitle: ${row.path}: von einem laufenden Prozess gehalten, uebersprungen`);
      continue;
    }
    try {
      await storage.updateSessionTitle(row.path, {
        title: typeof row.oldTitle === "string" ? row.oldTitle : "",
        source: row.oldSource === "user" || row.oldSource === "auto" ? row.oldSource : undefined,
        updatedAt: typeof row.oldUpdatedAt === "string" ? row.oldUpdatedAt : new Date().toISOString(),
      });
      restored++;
    } catch (error) {
      failed++;
      console.error(`retitle: ${row.path}: Restore fehlgeschlagen: ${error instanceof Error ? error.message : error}`);
    } finally {
      release();
    }
  }
  console.log(`restore: ${restored} zurueckgeschrieben, ${failed} fehlgeschlagen (${rows.length} Eintraege)`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  if (opts.restore) {
    await runRestore(opts.restore);
    return;
  }

  const nowMs = Date.now();
  const stats = { recent: 0, subagent: 0, user: 0, unknown: 0, already: 0, titled: 0, declined: 0, noSource: 0, failed: 0, unparseable: 0, modelCalls: 0 };
  const candidates = [];
  let scanned = 0;
  for (const path of walk(opts.dir)) {
    scanned++;
    const rel = relative(opts.dir, path);
    const depth = rel.split("/").length;
    if (depth >= 3) {
      stats.subagent++;
      continue;
    }
    const { slot } = parseHead(readHead(path));
    if (!slot || typeof slot.title !== "string") {
      stats.unparseable++;
      console.error(`retitle: ${rel}: erster Record ist kein Titel-Slot`);
      continue;
    }
    const mtimeMs = statSync(path).mtimeMs;
    const decision = decideRetitle(
      { depth, title: slot.title, source: slot.source, mtimeMs },
      { nowMs, recentMs: opts.recentMs, includeUser: opts.includeUser, onlyEmpty: opts.onlyEmpty },
    );
    if (decision !== "title") {
      const bucket =
        decision === "skip-recent" ? "recent"
        : decision === "skip-user" ? "user"
        : decision === "skip-unknown" ? "unknown"
        : decision === "skip-titled" ? "already"
        : "subagent";
      stats[bucket]++;
      if (!opts.quiet) console.log(`skip  ${decision.padEnd(13)} ${rel}`);
      continue;
    }
    candidates.push({ path, rel, oldTitle: slot.title, oldSource: slot.source, oldUpdatedAt: slot.updatedAt });
  }

  candidates.sort((a, b) => a.rel.localeCompare(b.rel));
  const selected = Number.isFinite(opts.limit) ? candidates.slice(0, opts.limit) : candidates;
  if (!opts.quiet) console.log(`\n${scanned} Dateien gescannt, ${candidates.length} Kandidaten, ${selected.length} ausgewaehlt`);
  if (!selected.length) {
    console.log("nichts zu tun");
    return;
  }

  // Backup vor dem ersten Modellaufruf oder Schreibvorgang, immer vollstaendig.
  let backupPath;
  if (opts.apply) {
    backupPath = join("/tmp", `omp-retitle-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
    const lines = selected.map((item) => JSON.stringify({
      path: item.path,
      oldTitle: item.oldTitle,
      oldSource: item.oldSource,
      oldUpdatedAt: item.oldUpdatedAt,
    }));
    writeFileSync(backupPath, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o600 });
    console.log(`backup: ${backupPath} (${lines.length} Zeilen)`);
  } else {
    console.log("dry-run: kein Schreibvorgang, kein Backup");
  }

  const model = await createTitleModel();
  const rows = [];
  const queue = [...selected];
  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      let manager;
      try {
        manager = await SessionManager.open(item.path, undefined, undefined, {
          suppressBreadcrumb: true,
          throwIfMissing: true,
        });
        const context = manager.buildSessionContext();
        const source = findFirstTitleSource(context.messages);
        if (!source) {
          stats.noSource++;
          rows.push({ rel: item.rel, before: item.oldTitle, after: item.oldTitle, changed: false });
          if (!opts.quiet) console.log(`skip  no-source     ${item.rel}`);
          continue;
        }
        const title = await titleFromSource(source, context.messages, manager.getSessionId(), model, stats);
        if (!title) {
          stats.declined++;
          rows.push({ rel: item.rel, before: item.oldTitle, after: item.oldTitle, changed: false });
          if (!opts.quiet) console.log(`skip  declined      ${item.rel}`);
          continue;
        }
        if (opts.apply) {
          if (!(await manager.setSessionName(title, "auto"))) {
            stats.failed++;
            rows.push({ rel: item.rel, before: item.oldTitle, after: item.oldTitle, changed: false });
            console.error(`retitle: ${item.rel}: setSessionName hat abgelehnt`);
            continue;
          }
        }
        stats.titled++;
        rows.push({ rel: item.rel, before: item.oldTitle, after: title, changed: true });
        if (!opts.quiet) console.log(`title ${item.oldTitle || "(leer)"} -> ${title}`);
      } catch (error) {
        stats.failed++;
        console.error(`retitle: ${item.rel}: ${error instanceof Error ? error.message : error}`);
      } finally {
        await manager?.close();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, selected.length) }, worker));

  const seconds = formatSeconds(Date.now() - startedAt);
  console.log(`
retitle ${opts.apply ? "APPLY" : "DRY-RUN"} — ${opts.dir}
  gescannt     ${scanned}
  uebersprungen: zu jung ${stats.recent}, subagent ${stats.subagent}, user ${stats.user}, unbekannt ${stats.unknown},
                 schon benannt ${stats.already}, kein Slot ${stats.unparseable}
  benannt      ${stats.titled}
  abgelehnt    ${stats.declined} (Modell), ${stats.noSource} ohne Textquelle
  fehlgeschlagen ${stats.failed}
  Modellaufrufe ${stats.modelCalls}
  Laufzeit     ${seconds}`);
  printHistogram("emoji vorher", rows.map((row) => firstEmoji(row.before) ?? "none"));
  printHistogram("emoji nachher", rows.map((row) => firstEmoji(row.after) ?? "none"));
  console.log("vorher -> nachher (10):");
  for (const row of rows.filter((row) => row.changed).slice(0, 10)) {
    console.log(`  ${row.before || "(leer)"}  ->  ${row.after}`);
  }
  if (backupPath) console.log(`backup: ${backupPath}`);
  if (!opts.apply && stats.titled === 0) {
    console.log("kein Modellaufruf lieferte einen Titel — Titelmodell erreichbar? (SDK-Log pruefen)");
  }
}

main().catch((error) => {
  console.error(`retitle: ${error instanceof Error ? error.stack ?? error.message : error}`);
  process.exit(1);
});
