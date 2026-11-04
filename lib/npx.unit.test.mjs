import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runNpx } from "./npx.ts";

/**
 * `runNpx` startet npx ohne Shell. Zwei Dinge sind pruefbar: die Argumente
 * gehen byte-genau durch (kein `;`, kein Leerzeichen wird interpretiert), und
 * der Aufruf landet im PATH des uebergebenen Env.
 *
 * Findet Node ein echtes `npx-cli.js` neben seinem Binary, nimmt `runNpx`
 * diesen Pfad statt des PATH-Fallbacks; dann ist der Fake nicht beobachtbar und
 * der Test wird uebersprungen, statt eine falsche Zusage zu behaupten.
 */

const npxCliCandidates = [
  join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js"),
  join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
];

test("runNpx forwards argv verbatim and resolves it through the supplied PATH", async (t) => {
  if (npxCliCandidates.some((candidate) => existsSync(candidate))) {
    t.skip("node ships npx-cli.js next to the binary; the PATH fallback cannot be observed");
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "omp-web-npx-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, "ran.json");
  const fakeNpx = join(dir, "npx");
  writeFileSync(fakeNpx, `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg"; done > ${JSON.stringify(marker)}\nprintf 'done'\n`, { mode: 0o755 });
  mkdirSync(join(dir, "cwd"), { recursive: true });

  const args = ["install", "left-pad; touch /tmp/omp-web-npx-pwned", "--flag=a b"];
  const result = await runNpx(args, {
    cwd: join(dir, "cwd"),
    timeout: 10_000,
    env: { PATH: dir, HOME: dir },
  });

  assert.equal(result.stdout, "done");
  assert.equal(result.stderr, "");
  const seen = await Bun.file(marker).text();
  // `"$@"` splits on argv boundaries, not on spaces; the `;` stayed literal.
  assert.deepEqual(seen.trimEnd().split("\n"), args);
  assert.equal(existsSync("/tmp/omp-web-npx-pwned"), false);
});
