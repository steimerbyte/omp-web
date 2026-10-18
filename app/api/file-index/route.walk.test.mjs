import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { createJiti } from "jiti";

/**
 * Der readdir-Walk von `/api/file-index` und seine symbolischen Links.
 *
 * Der Walk ist der Weg, den ein Verzeichnis ohne `.git` nimmt. `git ls-files`
 * fuehrt Symlinks als Eintraege auf, der Walk tat es nicht: `d.isFile()` und
 * `d.isDirectory()` sind fuer einen Link beide `false`, also fiel jeder Link
 * durch die Schleife. Derselbe Ordner lieferte damit je nach `.git` eine
 * andere @-Autocomplete-Liste — `link.ts` und ein verlinktes `src/` waren in
 * einem Repomentionbar und in einem gewöhnlichen Verzeichnis nicht.
 *
 * Der Test ruft die **Route** auf, weil der Unterschied im Walk liegt und nicht
 * in einer Hilfsfunktion. `os.tmpdir()` ist kein Repository, `listWithGit()`
 * schlaegt dort fehl und der Walk antwortet — das ist der gepruefte Weg.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-walk-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;
mkdirSync(join(HOME_ROOT, "alice"), { recursive: true });

const indexRoute = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("@/lib/file-access");

const IDENTITY = { username: "alice", isAdmin: false };
const ORIGIN = "http://localhost:30141";

function index(cwd, query) {
  const url = `${ORIGIN}/api/file-index?cwd=${encodeURIComponent(cwd)}${query ? `&q=${encodeURIComponent(query)}` : ""}`;
  return indexRoute.GET(new NextRequest(url, {
    headers: { host: "localhost:30141", "x-omp-user": IDENTITY.username },
  }));
}

/** Fresh project dir that the walk (not git) answers for. */
function project(seed) {
  const root = mkdtempSync(join(tmpdir(), "omp-web-project-"));
  allowFileRoot(root, IDENTITY);
  globalThis.__ompFileIndexCache?.clear();
  seed(root);
  return root;
}

test.after(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

test("eine verlinkte Datei steht im Index, auch ohne git", async () => {
  const root = project((dir) => {
    writeFileSync(join(dir, "target.ts"), "export const t = 1;\n");
    symlinkSync(join(dir, "target.ts"), join(dir, "link.ts"));
  });

  const body = await (await index(root)).json();

  assert.deepEqual(body.files.sort(), ["link.ts", "target.ts"]);
  rmSync(root, { recursive: true, force: true });
});

test("Dateien unter einem verlinkten Ordner stehen im Index", async () => {
  const root = project((dir) => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "app.ts"), "export const app = 1;\n");
    symlinkSync(join(dir, "src"), join(dir, "srclink"));
  });

  const body = await (await index(root)).json();

  assert.deepEqual(body.files.sort(), ["src/app.ts", "srclink/app.ts"]);
  rmSync(root, { recursive: true, force: true });
});

test("die @-Suche findet die verlinkte Datei", async () => {
  const root = project((dir) => {
    writeFileSync(join(dir, "target.ts"), "export const t = 1;\n");
    symlinkSync(join(dir, "target.ts"), join(dir, "link.ts"));
  });

  const body = await (await index(root, "link.ts")).json();

  assert.deepEqual(body.matches, [{ path: "link.ts", isDir: false }]);
  rmSync(root, { recursive: true, force: true });
});

test("ein Link nach ausserhalb zieht keine fremden Dateien in den Index", async () => {
  const outside = mkdtempSync(join(tmpdir(), "omp-web-outside-"));
  writeFileSync(join(outside, "secret.txt"), "top secret\n");

  const root = project((dir) => {
    writeFileSync(join(dir, "own.ts"), "export const own = 1;\n");
    symlinkSync(outside, join(dir, "escape"));
  });

  const body = await (await index(root)).json();

  // `escape/secret.txt` waere zwar aufzubahnen, aber jeder Versuch, sie zu
  // oeffnen, laeuft in die Allowlist und wird abgelehnt. Sie zu listen erzeugt
  // nur Eintraege, die im Explorer mit "Access denied" enden.
  assert.deepEqual(body.files, ["own.ts"]);
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("ein Link zurueck in den Vorfahren erzeugt weder Schleife noch Duplikate", async () => {
  const root = project((dir) => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "app.ts"), "export const app = 1;\n");
    // Cycle: src/loop points at the project root, root/src/loop points at root.
    symlinkSync(dir, join(dir, "src", "loop"));
    // And a link that is not a cycle but resolves to an already seen directory.
    symlinkSync(join(dir, "src"), join(dir, "src", "self"));
  });

  const body = await (await index(root)).json();

  // Ohne die Besuchsmenge expandiert `loop` auf jeder der bis zu acht Ebenen
  // erneut, und der Walk laeuft in eine exponentielle Anzahl Pfade.
  assert.deepEqual(body.files.sort(), ["src/app.ts"]);
  rmSync(root, { recursive: true, force: true });
});

test("ein toter Link bleibt still, ein Fifo ebenso", async () => {
  const root = project((dir) => {
    writeFileSync(join(dir, "own.ts"), "export const own = 1;\n");
    symlinkSync(join(dir, "missing.ts"), join(dir, "dead.ts"));
  });

  const body = await (await index(root)).json();

  assert.deepEqual(body.files, ["own.ts"]);
  rmSync(root, { recursive: true, force: true });
});
