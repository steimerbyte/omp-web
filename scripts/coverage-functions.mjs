#!/usr/bin/env node
// Funktionszähler aus lcov — das kleine Werkzeug für die Test-Arbeiter.
//
// Bun 1.4.4 schreibt keine `FN:`/`FNDA:`-Sätze, nur `FNF:` (Funktionen in der
// Datei) und `FNH:` (davon ausgeführt). Mehr braucht das Ratchet nicht:
// `uncovered = FNF - FNH`.
//
// Vertrag (stabil, andere Tests hängen daran):
//
//   node scripts/coverage-functions.mjs [--missing <datei>] <pfad>...
//
//   <pfad>            lcov-Datei oder Verzeichnis; ein Verzeichnis trägt
//                     dessen `lcov.info` bei (fehlt sie: Exit 1).
//   --missing <datei> gibt nur die Zeilen für diese Quelldatei aus (exakter
//                     repo-relativer Pfad oder Suffix nach einem `/`).
//
//   Ausgabe, eine Zeile je Quelldatei, TAB-getrennt:
//       <found> <hit> <uncovered> <datei>
//   Ohne --missing folgt als letzte Zeile die Summe mit `(total)` als Label.
//   Pfade werden so gedruckt, wie sie im Report stehen (`SF:`).
//   Mehrere Reports: derselbe `SF:` wird zeilenweise vereinigt (Maximum von
//   FNF und FNH) — zwei Läufe können eine Datei nicht kleiner machen.
//
//   Exit-Codes: 0 = ok, 1 = Aufruf-/Lesefehler, 2 = --missing ohne Treffer.
//
// Beispiel:
//   node scripts/coverage-functions.mjs coverage
//   node scripts/coverage-functions.mjs --missing lib/foo.ts coverage/lcov.info
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const missingAt = argv.indexOf("--missing");
const missing = missingAt === -1 ? null : argv[missingAt + 1];
const paths = missingAt === -1 ? argv : argv.filter((arg, i) => i !== missingAt && i !== missingAt + 1);

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (missingAt !== -1 && !missing) fail("--missing braucht einen Dateinamen");
if (paths.length === 0) fail("Aufruf: node scripts/coverage-functions.mjs [--missing <datei>] <lcov-oder-verzeichnis>...");

const files = paths.map((path) => {
  const abs = resolve(path);
  if (!existsSync(abs)) fail(`fehlt: ${path}`);
  if (statSync(abs).isDirectory()) {
    const info = join(abs, "lcov.info");
    if (!existsSync(info)) fail(`kein lcov.info in ${path}`);
    return info;
  }
  return abs;
});

/** `SF:` → { found, hit }, vereinigt über Reports per Maximum. */
const perFile = new Map();
for (const file of files) {
  for (const record of readFileSync(file, "utf8").split("\nend_of_record")) {
    const sf = /^SF:(.+)$/m.exec(record);
    if (!sf) continue;
    const source = sf[1].trim();
    const num = (key) => Number(new RegExp(`^${key}:(\\d+)$`, "m").exec(record)?.[1] ?? 0);
    const found = num("FNF");
    const hit = num("FNH");
    const previous = perFile.get(source);
    perFile.set(source, {
      found: Math.max(found, previous?.found ?? 0),
      hit: Math.max(hit, previous?.hit ?? 0),
    });
  }
}

if (perFile.size === 0) fail("kein einziger SF:-Satz in den Reports");

const matches = (path) => missing === null || path === missing || path.endsWith(`/${missing}`);
const rows = [...perFile].filter(([path]) => matches(path)).sort(([a], [b]) => a.localeCompare(b));

if (missing !== null && rows.length === 0) {
  console.error(`keine Zeile für ${missing} im Report`);
  process.exit(2);
}

let totalFound = 0;
let totalHit = 0;
for (const [path, { found, hit }] of rows) {
  totalFound += found;
  totalHit += hit;
  console.log(`${found}\t${hit}\t${Math.max(0, found - hit)}\t${path}`);
}
if (missing === null) {
  console.log(`${totalFound}\t${totalHit}\t${Math.max(0, totalFound - totalHit)}\t(total)`);
}
