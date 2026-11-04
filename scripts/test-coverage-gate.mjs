#!/usr/bin/env node
// Test-Gate: Reichweite (erreicht ein Test das Modul?) + Funktions-Ratchet aus
// lcov.
//
// Zwei Fragen, zwei Antworten:
//   1. Wird die Datei von irgendeinem Test (transitiv) importiert?  -> sonst Debt-Liste.
//   2. Führt ein Test die Funktionen der Datei aus?                 -> sonst Debt-Zähler.
//
// Quelltext-Assertions (`readFileSync(new URL("./route.ts"))`) zählen bewusst NICHT:
// sie laden das Modul nicht und dürfen keine Abdeckung vortäuschen.
//
// CLI:
//   node scripts/test-coverage-gate.mjs            Gate prüfen (Exit 1 bei Verstoß)
//   node scripts/test-coverage-gate.mjs --update   Baseline neu schreiben
//
// Umgebung:
//   OMP_GATE_ROOT      Repo-Wurzel (Default: cwd)
//   OMP_GATE_BASELINE  Baseline-Datei (Default: <root>/.test-baseline.json)
//   OMP_GATE_LCOV      lcov-Report (Default: <root>/coverage/lcov.info)
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(process.env.OMP_GATE_ROOT ?? process.cwd());
const BASELINE = resolve(process.env.OMP_GATE_BASELINE ?? join(ROOT, ".test-baseline.json"));
const LCOV = resolve(process.env.OMP_GATE_LCOV ?? join(ROOT, "coverage/lcov.info"));
const UPDATE = process.argv.includes("--update");

const SOURCE_EXT = [".ts", ".tsx", ".mjs", ".js"];
const SKIP_DIRS = new Set(["node_modules", ".git", "coverage", "src-tauri", "public", "out", "dist", "build"]);
const SKIP_PREFIX = [".next"];
// Nur diese Bäume sind Produktcode; alles andere (docs, test, public) ist kein Gate-Gegenstand.
const SOURCE_TREES = ["lib", "components", "hooks", "app", "bin", "scripts"];
const ROOT_FILES = ["proxy.ts", "next.config.ts", "instrumentation.ts", "public/sw.js"];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || SKIP_PREFIX.some((p) => entry.startsWith(p))) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXT.some((e) => full.endsWith(e))) out.push(relative(ROOT, full));
  }
  return out;
}

const isTest = (p) => /\.test\.(mjs|js|ts)$/.test(p) || p.startsWith("test/") || p.includes(".probe.mjs");
// Testdateien sind Wurzeln der Reichweite und Gegenstand der Hygiene-Regeln —
// auch die vier im Repo-Wurzelverzeichnis (proxy*.test.mjs,
// next.config.headers.test.mjs) und die unter test/. Sie sind keine Quellen,
// aber ohne sie als Wurzel meldet das Gate proxy.ts/next.config.ts als
// ungetestet, obwohl ein Test sie importiert.
const all = [...SOURCE_TREES.filter((d) => existsSync(join(ROOT, d))).flatMap((d) => walk(join(ROOT, d))),
  ...ROOT_FILES.filter((f) => existsSync(join(ROOT, f))),
  ...readdirSync(ROOT).filter((f) => isTest(f) && statSync(join(ROOT, f)).isFile()),
  ...(existsSync(join(ROOT, "test")) ? walk(join(ROOT, "test")) : [])];
const sources = all.filter((f) => !isTest(f) && !/\.d\.ts$/.test(f)).sort();

function resolveSpecifier(fromFile, spec) {
  let base;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = join(dirname(fromFile), spec);
  else return null;
  for (const candidate of [base, ...SOURCE_EXT.map((e) => base + e),
    ...["index.ts", "index.tsx", "index.js", "index.mjs"].map((e) => join(base, e))]) {
    const abs = join(ROOT, candidate);
    if (existsSync(abs) && statSync(abs).isFile()) return relative(ROOT, abs);
  }
  return null;
}

const IMPORT_RE = /(?:import\s*\(\s*|from\s*|import\s+|require\s*\(\s*)["']([^"']+)["']/g;

const graph = new Map();
for (const f of all) {
  const text = readFileSync(join(ROOT, f), "utf8");
  const deps = new Set();
  for (const m of text.matchAll(IMPORT_RE)) {
    const hit = resolveSpecifier(f, m[1]);
    if (hit) deps.add(hit);
  }
  graph.set(f, [...deps]);
}

const reached = new Set();
const queue = all.filter(isTest);
while (queue.length) {
  const f = queue.pop();
  if (reached.has(f)) continue;
  reached.add(f);
  for (const dep of graph.get(f) ?? []) queue.push(dep);
}

const reachable = new Set(sources.filter((f) => reached.has(f)));
const unreachableNow = sources.filter((f) => !reached.has(f));

const baseline = existsSync(BASELINE)
  ? JSON.parse(readFileSync(BASELINE, "utf8"))
  : { schemaVersion: 1, unreachable: [], coverage: {} };
const debt = new Map((baseline.unreachable ?? []).map((e) => [typeof e === "string" ? e : e.file, e]));

const failures = [];   // Baseline-fähig: in --update übernehmbar
const violations = []; // nie: Test-Hygiene (.only, stille Skips)
const notices = [];

// --- Regel 1: neue Datei ohne Testpfad ------------------------------------
for (const file of unreachableNow) {
  if (!debt.has(file)) failures.push(`ungetestet: ${file} — kein Test importiert dieses Modul (auch nicht transitiv)`);
}
// --- Regel 2: Debt ist abbezahlt -> Eintrag muss raus (Ratchet) -----------
for (const file of debt.keys()) {
  if (!unreachableNow.includes(file)) {
    if (UPDATE) notices.push(`Baseline aufgeräumt: ${file}`);
    else failures.push(`Baseline veraltet: ${file} wird inzwischen von einem Test erreicht — Eintrag entfernen`);
  }
}

// --- Regel 3: Funktionen ohne Test (lcov) ---------------------------------
const coverageNow = new Map();
if (existsSync(LCOV)) {
  for (const record of readFileSync(LCOV, "utf8").split("\nend_of_record")) {
    const sf = /^SF:(.+)$/m.exec(record);
    if (!sf) continue;
    const file = sf[1].trim();
    if (file.startsWith("..") || !sources.includes(file)) continue; // fremde Pfade (SDK/Plugins) ignorieren
    const num = (key) => Number(new RegExp(`^${key}:(\\d+)$`, "m").exec(record)?.[1] ?? 0);
    const found = num("FNF");
    const hit = num("FNH");
    coverageNow.set(file, { functionsFound: found, functionsHit: hit, uncovered: Math.max(0, found - hit) });
  }
} else {
  failures.push(`kein Coverage-Report: ${relative(ROOT, LCOV)} fehlt (bun test --coverage --coverage-reporter=lcov)`);
}

for (const [file, now] of coverageNow) {
  const before = baseline.coverage?.[file];
  if (!before) {
    if (now.uncovered > 0) failures.push(`neu ohne Test: ${file} — ${now.uncovered} von ${now.functionsFound} Funktionen nie ausgeführt`);
    continue;
  }
  if (now.uncovered > before.uncovered) {
    failures.push(`${file}: ${now.uncovered - before.uncovered} Funktion(en) ohne Test (${before.uncovered} -> ${now.uncovered})`);
  }
  if (now.uncovered < before.uncovered) notices.push(`besser: ${file} (${before.uncovered} -> ${now.uncovered})`);
}
for (const file of Object.keys(baseline.coverage ?? {})) {
  if (!coverageNow.has(file)) failures.push(`Baseline-Datei nicht mehr geladen: ${file} — Test entfernt oder Datei weg`);
}

// --- Regel 4/5: keine stillen Skips, kein .only ---------------------------
const testFiles = all.filter(isTest);
for (const file of testFiles) {
  const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
  lines.forEach((line, i) => {
    const at = `${file}:${i + 1}`;
    if (/\.only\s*\(/.test(line)) violations.push(`${at}: .only() — überspringt jede andere Datei im Lauf`);
    if (/(?:^|[^\w.])test\.(?:skip|todo)\s*\(/.test(line)) violations.push(`${at}: unbedingter Skip/Todo — ein echter Test darf nicht still ausfallen`);
    const skip = /\bskip:\s*([^,}]+)/.exec(line);
    if (skip) {
      // Vergleichsliterale ("win32", "darwin") sind keine Begründung.
      const withoutComparisons = skip[1].replace(/[!=]==?\s*("[^"]*"|'[^']*')/g, "");
      if (!/["'`]/.test(withoutComparisons)) violations.push(`${at}: skip ohne Begründung — "{ skip: <probe> && \"Grund\" }"`);
    }
  });
}

// --- Bericht --------------------------------------------------------------
const totalFound = [...coverageNow.values()].reduce((a, v) => a + v.functionsFound, 0);
const totalHit = [...coverageNow.values()].reduce((a, v) => a + v.functionsHit, 0);
console.log(`\nTest-Gate: ${sources.length} Quelldateien, ${reachable.size} erreichbar, ${unreachableNow.length} Debt`);
console.log(`Funktionen: ${totalHit}/${totalFound} ausgeführt (${totalFound ? ((100 * totalHit) / totalFound).toFixed(1) : "0"}%), `
  + `${[...coverageNow.values()].reduce((a, v) => a + v.uncovered, 0)} ohne Test`);
for (const n of notices.slice(0, 10)) console.log(`  ~ ${n}`);
if (notices.length > 10) console.log(`  ~ … ${notices.length - 10} weitere Verbesserungen`);

if (violations.length) {
  console.error(`\n✗ ${violations.length} Test-Hygiene-Verstoß/Verstöße (nicht baseline-fähig):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
if (UPDATE) {
  const next = {
    schemaVersion: 1,
    unreachable: unreachableNow.map((file) => debt.get(file) ?? { file, reason: "TODO: Test oder Begründung", since: new Date().toISOString().slice(0, 10) }),
    coverage: Object.fromEntries([...coverageNow].sort(([a], [b]) => a.localeCompare(b))),
  };
  writeFileSync(BASELINE, JSON.stringify(next, null, 2) + "\n");
  console.log(`Baseline geschrieben: ${relative(ROOT, BASELINE)}`);
}

if (failures.length) {
  const level = UPDATE ? console.warn : console.error;
  level(`\n${UPDATE ? "~" : "✗"} ${failures.length} Gate-Verstoß/Verstöße${UPDATE ? " (in die Baseline übernommen)" : ""}:`);
  for (const f of failures) level(`  - ${f}`);
  if (!UPDATE) process.exit(1);
}
console.log("✓ Gate bestanden");
