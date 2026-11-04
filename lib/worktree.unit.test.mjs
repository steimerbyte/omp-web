import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./worktree.ts");
}

/**
 * Worktrees eines Repositories: lesen, anlegen, entfernen.
 *
 * Die Liste ist die Auswahl des Umschalters, also muss sie stimmen: der
 * Hauptbaum ist `isMain`, ein verlinkter Baum traegt seinen Branch, und ein
 * `prunable` Eintrag (ein Worktree, dessen Verzeichnis weg ist) wird
 * weggelassen — er waere ein Knopf, der nichts oeffnet.
 *
 * `removeWorktree` prueft die Zugehoerigkeit **ueber die Liste**, nicht ueber
 * den uebergebenen Pfad: ein beliebiger Pfad ist kein Worktree dieses
 * Repositories, und `git worktree remove` auf einen fremden Pfad waere ein
 * Loeschbefehl auf Zuruf. Bleibt ein Fehler von `git`, wird dessen `stderr`
 * weitergereicht (`extractGitError`) — sonst saehe der Nutzer "Command failed"
 * statt des Grundes.
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
  const dir = mkdtempSync(join(tmpdir(), "omp-worktree-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { env: gitEnv, encoding: "utf8" });
  git("init", "--quiet", "--initial-branch=main");
  writeFileSync(join(dir, "README.md"), "start\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "init");
  return { dir, git };
}

test("a fresh repository has one worktree, and it is the main one", async () => {
  const { listWorktrees } = await loadSubject();
  const { dir } = makeRepo();

  try {
    const worktrees = await listWorktrees(dir);

    assert.equal(worktrees.length, 1);
    assert.deepEqual(worktrees[0], { path: dir, branch: "main", isMain: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an added worktree is listed with its branch and is not the main one", async () => {
  const { addWorktree, listWorktrees } = await loadSubject();
  const { dir } = makeRepo();
  let added;

  try {
    added = await addWorktree(dir, "feature/x", null);

    assert.equal(added.path, `${dir}-worktrees/feature-x`, "der Verzeichnisname ist der sanitisierte Branch");
    assert.equal(added.branch, "feature/x");

    const worktrees = await listWorktrees(dir);
    assert.equal(worktrees.length, 2);
    assert.equal(worktrees[0].isMain, true, "der Hauptbaum ist zuerst");
    assert.deepEqual(worktrees[1], { path: added.path, branch: "feature/x", isMain: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}-worktrees`, { recursive: true, force: true });
  }
});

test("removing a worktree refuses a foreign path and the main worktree", async () => {
  const { addWorktree, listWorktrees, removeWorktree } = await loadSubject();
  const { dir } = makeRepo();
  let added;

  try {
    added = await addWorktree(dir, "feature/y", null);

    await assert.rejects(
      removeWorktree(dir, join(dir, "irgendwo")),
      /Not a worktree of this repository/,
    );
    await assert.rejects(
      removeWorktree(dir, dir),
      /Cannot remove the main worktree/,
    );
    assert.equal((await listWorktrees(dir)).length, 2, "die abgelehnten Aufrufe haben nichts entfernt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}-worktrees`, { recursive: true, force: true });
  }
});

test("removing a worktree passes git's own reason on, and force removes it anyway", async () => {
  const { addWorktree, listWorktrees, removeWorktree } = await loadSubject();
  const { dir } = makeRepo();
  let added;

  try {
    added = await addWorktree(dir, "feature/dirty", null);
    writeFileSync(join(added.path, "ungespeichert.txt"), "nicht committet\n");

    // Ohne `--force` verweigert git, und der Grund ist der, den der Nutzer
    // lesen soll — nicht "Command failed".
    await assert.rejects(
      removeWorktree(dir, added.path),
      /contains modified or untracked files|use --force/i,
    );
    assert.equal(existsSync(added.path), true);

    await removeWorktree(dir, added.path, true);

    assert.equal(existsSync(added.path), false);
    assert.equal((await listWorktrees(dir)).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}-worktrees`, { recursive: true, force: true });
  }
});

test("a worktree whose directory vanished is not offered for selection", async () => {
  const { addWorktree, listWorktrees } = await loadSubject();
  const { dir, git } = makeRepo();
  let added;

  try {
    added = await addWorktree(dir, "feature/gone", null);
    // `git worktree remove` ohne Aufraeumen der Metadaten: der Eintrag bleibt
    // in `worktree list` stehen, das Verzeichnis ist weg — genau der Fall, den
    // der Filter weglaesst.
    rmSync(added.path, { recursive: true, force: true });
    git("worktree", "prune");

    const worktrees = await listWorktrees(dir);
    assert.deepEqual(worktrees.map((entry) => entry.path), [dir], "kein Eintrag ohne Verzeichnis");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}-worktrees`, { recursive: true, force: true });
  }
});
