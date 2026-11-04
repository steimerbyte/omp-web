import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./git-changes.ts");
}

/**
 * Das Diff einer noch nicht verfolgten Datei.
 *
 * Fuer eine untracked Datei gibt es kein `git diff` — sie steht in keinem
 * Baum, den git vergleichen koennte. Der Patch wird deshalb hier gebaut, und
 * die zwei Zusagen sind: die Kopfzeilen sind die eines neuen Feldes
 * (`--- /dev/null`, `new file mode`), und eine Datei ohne abschliessenden
 * Zeilenumbruch bekommt den `\ No newline at end of file`-Vermerk. Ohne den
 * zeigt ein Patch-Betrachter eine zusaetzliche leere Zeile an, die die Datei
 * nicht hat.
 */
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "omp-diff-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { env: gitEnv, encoding: "utf8" });
  git("init", "--quiet", "--initial-branch=main");
  writeFileSync(join(dir, "README.md"), "start\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "init");
  return dir;
}

test("an untracked text file gets a new-file patch", async () => {
  const { getGitFileDiff } = await loadSubject();
  const dir = makeRepo();
  const file = join(dir, "neu.ts");

  try {
    writeFileSync(file, "erste Zeile\nzweite Zeile\n");

    const diff = await getGitFileDiff(dir, file);

    assert.equal(diff.supported, true);
    assert.equal(diff.status, "untracked");
    assert.match(diff.patch, /^diff --git a\/neu\.ts b\/neu\.ts$/m);
    assert.match(diff.patch, /^new file mode 100644$/m);
    assert.match(diff.patch, /^--- \/dev\/null$/m);
    assert.match(diff.patch, /^\+\+\+ b\/neu\.ts$/m);
    assert.match(diff.patch, /^@@ -0,0 \+1,2 @@$/m);
    assert.match(diff.patch, /^\+erste Zeile$/m);
    assert.match(diff.patch, /^\+zweite Zeile$/m);
    assert.doesNotMatch(diff.patch, /No newline at end of file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file without a trailing newline is marked as such", async () => {
  const { getGitFileDiff } = await loadSubject();
  const dir = makeRepo();
  const file = join(dir, "ohne-umbruch.txt");

  try {
    writeFileSync(file, "nur eine Zeile");

    const diff = await getGitFileDiff(dir, file);

    assert.equal(diff.supported, true);
    assert.match(diff.patch, /^@@ -0,0 \+1,1 @@$/m);
    assert.match(diff.patch, /^\+nur eine Zeile$/m);
    assert.match(diff.patch, /^\\ No newline at end of file$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a binary file has no patch to show", async () => {
  const { getGitFileDiff } = await loadSubject();
  const dir = makeRepo();
  const file = join(dir, "bild.bin");

  try {
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

    const diff = await getGitFileDiff(dir, file);

    assert.equal(diff.supported, false, "ein Nullbyte heisst: kein Textdiff");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
