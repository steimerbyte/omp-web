#!/usr/bin/env node
// Ein Kommando: Suite + Gate. Kein `bun run build`, keine Quelltext-Änderung.
//
// Warum --parallel: jeder Testfile bekommt einen eigenen Worker-Prozess mit
// frischem Modulzustand. Das ist nicht nur schneller (29 s statt 57 s), es
// entfernt auch die Ordnungsabhängigkeit, an der `mock.module`-Tests scheitern.
// Warum --timeout: unter Parallelität teilen sich 8 Worker die Kerne; die
// Subprozess-Proben brauchen dann länger als Bun's 5-s-Default.
//
// CLI:
//   node scripts/test-gate.mjs                   Suite + Coverage-Gate
//   node scripts/test-gate.mjs --fast            nur die Suite (ohne Coverage)
//   node scripts/test-gate.mjs --update-baseline Suite + Coverage, Baseline neu schreiben
//
// OMP_TEST_PARALLEL overridet die Worker-Zahl (Default 8, z. B. "4" auf einem
// 4-Kern-CI-Runner). Exit-Code: 0 grün, sonst Status der Suite bzw. des Gates.
import { spawnSync } from "node:child_process";

const update = process.argv.includes("--update-baseline");
const fast = process.argv.includes("--fast") && !update;  // ohne Coverage, für die Innenschleife
const parallel = process.env.OMP_TEST_PARALLEL ?? "8";

const env = { ...process.env, NODE_ENV: "test" };
const args = ["test", `--parallel=${parallel}`, "--timeout=30000"];
if (!fast) args.push("--coverage", "--coverage-reporter=lcov", "--coverage-dir=coverage");

const run = spawnSync("bun", args, { stdio: "inherit", env });
if (run.error) {
  console.error(`bun test konnte nicht gestartet werden: ${run.error.message}`);
  process.exit(2);
}
if (run.status !== 0) {
  console.error(`\n✗ Suite rot (${run.status}) — Gate wird nicht geprüft.`);
  process.exit(run.status ?? 1);
}
if (fast) process.exit(0);

const gateArgs = ["node", "scripts/test-coverage-gate.mjs"];
if (update) gateArgs.push("--update");
const gate = spawnSync(gateArgs[0], gateArgs.slice(1), { stdio: "inherit", env });
process.exit(gate.status ?? 1);
