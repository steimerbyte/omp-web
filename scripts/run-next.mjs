#!/usr/bin/env bun
/**
 * run-next.mjs — start the Next.js CLI on the Bun runtime.
 *
 * Why this exists instead of `bun --bun next <args>` in package.json scripts:
 *
 *   As of Bun 1.4.2, `bun --bun <bare-name>` no longer forces the Bun runtime
 *   when the name is resolved through `node_modules/.bin`. Bun execs the
 *   binstub and the `#!/usr/bin/env node` shebang wins, so the whole build
 *   silently runs under Node. Measured on agent-pc (Bun 1.4.2, Node 24.11):
 *
 *     bun --bun node_modules/.bin/next ...   -> execPath = bun    (path form)
 *     bun --bun next ...                     -> execPath = node   (bare name)
 *
 *   The same script with Bun 1.4.0 honoured `--bun` in both forms, which is
 *   why the build worked before and then broke without any repo change.
 *
 *   Under Node the build fails at "Collecting page data":
 *
 *     ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
 *
 *   @oh-my-pi/pi-coding-agent ships TypeScript sources only — every condition
 *   in its "exports" map ("." and "./*") points at "./src/*.ts", and there is no
 *   compiled JS entry point. Node refuses to strip types below node_modules,
 *   so nothing in the SDK is loadable outside a Bun runtime.
 *
 * This launcher keeps the Bun runtime by construction: it is itself executed by
 * Bun (`bun run scripts/run-next.mjs …`), so `process.execPath` *is* the Bun
 * binary, and it invokes Next by absolute path — the form Bun never hands to a
 * shebang. The bin path is read from next's own package.json instead of being
 * hardcoded, so a Next release that moves its CLI does not break the build.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const NEXT_PKG = join(REPO_ROOT, "node_modules", "next", "package.json");

if (typeof process.versions.bun === "undefined") {
  console.error(
    `[run-next] must be executed by Bun (next is loaded from TypeScript sources and\n` +
      `[run-next] cannot be resolved by Node). Got execPath=${process.execPath}.\n` +
      `[run-next] Run it as: bun run scripts/run-next.mjs <next args…>`,
  );
  process.exit(1);
}

if (!existsSync(NEXT_PKG)) {
  console.error(`[run-next] next is not installed — ${NEXT_PKG} not found`);
  process.exit(1);
}

const { bin } = JSON.parse(readFileSync(NEXT_PKG, "utf8"));
// "bin" is either "./dist/bin/next" or { "next": "./dist/bin/next" }.
const relBin = typeof bin === "string" ? bin : bin?.next;
if (typeof relBin !== "string" || relBin.length === 0) {
  console.error(`[run-next] cannot read the Next CLI path from ${NEXT_PKG}`);
  process.exit(1);
}

const nextBin = join(REPO_ROOT, "node_modules", "next", relBin);
if (!existsSync(nextBin)) {
  console.error(`[run-next] Next CLI declared at ${nextBin} but the file is missing`);
  process.exit(1);
}

const result = spawnSync(process.execPath, [nextBin, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: process.cwd(),
});

if (result.error) {
  console.error(`[run-next] failed to start ${nextBin}: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  process.exit(1);
}
process.exit(result.status ?? 1);