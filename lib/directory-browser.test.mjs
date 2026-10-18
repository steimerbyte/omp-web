import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./directory-browser.ts");
}

/** Alle `.ts`/`.tsx` unter den drei Quellbaeumen, ohne `node_modules`/`.next`. */
function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

/**
 * Die Argumente eines Aufrufs, das bei `open` (der Klammer hinter dem Namen)
 * beginnt: zaehlt die Kommas auf oberster Ebene.
 */
function topLevelCommas(source, open) {
  let depth = 1;
  let commas = 0;
  let quote = null;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") { quote = char; continue; }
    if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) {
      if (depth === 1) return commas;
      depth -= 1;
    } else if (char === "," && depth === 1) commas += 1;
  }
  return commas;
}

/**
 * Kein Aufrufer laesst die Identitaet weg.
 *
 * Die drei Funktionen verlangen die Identitaet als Pflichtparameter, und
 * `tsc --noEmit` schuetzt die Signatur. Dieser Test schuetzt die andere Seite
 * des Fehlers: eine neue Route, die einen dieser Namen aufruft. `bun test`
 * laedt keine Typen, und ein Aufruf ohne Identitaet faellt erst dort zurueck,
 * wo `homedir()` still das Home des Dienstkontos einsetzt — der Fehler, den
 * `a7e5a8c` und `d809011` gerade beseitigt haben.
 */
test("kein Aufrufer von resolveDirectory/normalizeDirectory/getBrowseStartDirectory laesst die Identitaet weg", () => {
  const repo = process.cwd();
  const callers = ["getBrowseStartDirectory", "normalizeDirectory", "resolveDirectory"];
  const offenders = [];

  for (const dir of ["app", "lib", "components"]) {
    for (const file of sourceFiles(path.join(repo, dir))) {
      // Die Deklarationen selbst sind keine Aufrufe.
      if (file.endsWith(path.join("lib", "directory-browser.ts"))) continue;
      const source = readFileSync(file, "utf8");
      for (const name of callers) {
        let from = 0;
        for (;;) {
          const at = source.indexOf(`${name}(`, from);
          if (at < 0) break;
          from = at + name.length + 1;
          // `irgendwas.getBrowseStartDirectory(` waere eine fremde Methode,
          // `` `resolveDirectory()` `` im Kommentar ein bloss erwaehnter Name.
          if (source[at - 1] === "." || source[at - 1] === "`") continue;
          const lineStart = source.lastIndexOf("\n", at);
          if (source.slice(lineStart, at).includes("//")) continue;
          if (topLevelCommas(source, from) === 0) {
            offenders.push(`${path.relative(repo, file)}: ${name}()`);
          }
        }
      }
    }
  }

  assert.deepEqual(offenders, []);
});

test("lists directories and directory symlinks without returning files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-web-browse-"));
  try {
    await mkdir(path.join(root, "project"));
    await writeFile(path.join(root, "notes.txt"), "test", "utf8");
    await symlink(path.join(root, "project"), path.join(root, "linked-project"));

    const { listDirectories } = await loadSubject();
    const directories = await listDirectories(root);

    assert.deepEqual(directories.map((entry) => entry.name), ["linked-project", "project"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expands home-relative paths and rejects missing directories", async () => {
  const {
    getBrowseStartDirectory,
    normalizeDirectory,
    resolveDirectory,
    shouldShowWindowsDrivePicker,
  } = await loadSubject();
  // Die Identitaet ist Pflichtparameter: eine neue Route, die sie weglaesst,
  // bekaeme sonst kommentarlos `homedir()` des Dienstkontos. Fuer den Admin ist
  // das korrekt — sein `~` ist das Home des Prozesses.
  const ADMIN = { username: "admin", isAdmin: true };
  assert.equal(getBrowseStartDirectory(undefined, ADMIN), homedir());
  assert.equal(getBrowseStartDirectory("/project", ADMIN), "/project");
  assert.equal(shouldShowWindowsDrivePicker(undefined, "win32"), true);
  assert.equal(shouldShowWindowsDrivePicker(undefined, "darwin"), false);
  assert.equal(shouldShowWindowsDrivePicker(undefined, "linux"), false);
  assert.equal(shouldShowWindowsDrivePicker("C:\\Projects", "win32"), false);
  assert.equal(normalizeDirectory("~/project", ADMIN), path.join(homedir(), "project"));
  assert.equal(normalizeDirectory("~\\project\\nested", ADMIN), path.join(homedir(), "project", "nested"));
  await assert.rejects(resolveDirectory(path.join(tmpdir(), `omp-web-missing-${Date.now()}`), ADMIN));
});

test("builds every Windows drive-letter candidate", async () => {
  const { getWindowsDriveCandidates } = await loadSubject();
  const drives = getWindowsDriveCandidates();

  assert.equal(drives.length, 26);
  assert.deepEqual(drives[0], { name: "A:", path: "A:\\" });
  assert.deepEqual(drives.at(-1), { name: "Z:", path: "Z:\\" });
});

test("finds parent directories across POSIX and Windows paths", async () => {
  const { getParentDirectory } = await loadSubject();

  assert.equal(getParentDirectory("/Users/alex/project"), "/Users/alex");
  assert.equal(getParentDirectory("/"), null);
  assert.equal(getParentDirectory("C:\\Users\\Alex\\project"), "C:\\Users\\Alex");
  assert.equal(getParentDirectory("C:\\"), null);
});
