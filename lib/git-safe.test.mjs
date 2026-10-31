import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getGitFileDiff, getGitStatus } from "./git-changes.ts";

/**
 * `git` in einem Repository, das ein Mandant schreiben darf, ist eine Shell.
 *
 * Gemessen in SHELL-ISOLATION-SCAN §4b: ein `core.fsmonitor`-Hook bekam
 * `BRAVE_API_KEY`, `OMP_WEB_PASSWORD` und `OPENROUTER_API_KEY`, sobald der
 * Datei-Explorer `git status` ausgeloest hat. `GIT_ISOLATION_ARGS` schaltet die
 * Ausfuehrung ab; `childEnv()` nimmt die Geheimnisse aus der Umgebung des
 * Aufrufs.
 *
 * Der Test prueft beides in der Reihenfolge, in der es zaehlt: erst dass der
 * Fixture-Aufruf den Hook wirklich ausfuehrt (sonst waere der zweite Teil
 * gruen, weil nichts passiert), dann dass der App-Aufruf ihn nicht ausfuehrt.
 */

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), "omp-git-safe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", dir]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  execFileSync("git", ["-C", dir, "add", "a.txt"]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  return dir;
}

function installFsmonitorHook(dir, hook) {
  writeFileSync(hook, `#!/bin/sh\nenv > "${hook}.env"\nprintf '\\n'\n`);
  chmodSync(hook, 0o755);
  execFileSync("git", ["-C", dir, "config", "core.fsmonitor", hook]);
}

test("ohne Schutz laeuft der fsmonitor-Hook des Repos und sieht die Dienstumgebung", (t) => {
  const dir = repo(t);
  const hook = join(dir, "fsmonitor.sh");
  installFsmonitorHook(dir, hook);
  process.env.BRAVE_API_KEY = "brave-secret-should-not-leak";
  t.after(() => delete process.env.BRAVE_API_KEY);

  // Genau der Aufruf, den `lib/git-changes.ts` vorher machte.
  execFileSync("git", ["-C", dir, "status", "--porcelain=v1"], {
    env: { ...process.env, LC_ALL: "C" },
  });

  assert.ok(existsSync(`${hook}.env`), "fixture is dead: the hook did not run, so the next test proves nothing");
  assert.match(readFileSync(`${hook}.env`, "utf8"), /BRAVE_API_KEY=brave-secret-should-not-leak/);
});

test("der App-Aufruf fuehrt keinen Repo-Hook aus und liefert trotzdem das richtige Status", async (t) => {
  const dir = repo(t);
  const hook = join(dir, "fsmonitor.sh");
  installFsmonitorHook(dir, hook);
  // Eine Datei aendern, damit der Status etwas zu melden hat.
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");

  const status = await getGitStatus(dir);
  assert.equal(status.isGitRepository, true);
  assert.equal(status.repositoryRoot, dir);
  assert.ok(status.files.some((file) => file.filePath === join(dir, "a.txt")), "git still has to work");

  assert.ok(
    !existsSync(`${hook}.env`),
    "core.fsmonitor ran: the tenant's hook is a shell with the service environment",
  );
});

test("ein Repo mit post-checkout-Hook laesst sich weiterhin als Worktree benutzen", async (t) => {
  const dir = repo(t);
  const hook = join(dir, ".git", "hooks", "post-checkout");
  writeFileSync(hook, `#!/bin/sh\nenv > "${join(dir, "post-checkout.env")}"\n`);
  chmodSync(hook, 0o755);

  // `git worktree add` fuehrt `post-checkout` aus. Mit `core.hooksPath=/dev/null`
  // nicht — der Hook ist derselbe Ausfuehrungsweg wie fsmonitor.
  const { addWorktree } = await import("./worktree.ts");
  const created = await addWorktree(dir, "omp-safe-branch", null);
  t.after(() => rmSync(`${dir}-worktrees`, { recursive: true, force: true }));
  assert.ok(existsSync(created.path), "the worktree must still be created");
  assert.ok(!existsSync(join(dir, "post-checkout.env")), "post-checkout ran with the service environment");
});

test("Repo-Filter und textconv werden nicht ausgefuehrt — der Mandant definiert sie selbst", async (t) => {
  const dir = repo(t);
  const cleanMarker = join(dir, "clean-ran.txt");
  const textconvMarker = join(dir, "textconv-ran.txt");
  // Genau der zweite Ausfuehrungsweg: `.gitattributes` waehlt den Treiber, die
  // Repo-Config liefert das Kommando. `git status` fuehrt `clean` aus, sobald es
  // Inhalt vergleichen muss (gleiche Groesse, andere Bytes — bei
  // unterschiedlicher Groesse entscheidet git schon am `stat`), `git diff` die
  // `textconv` (gemessen mit git 2.56).
  writeFileSync(join(dir, ".gitattributes"), "*.txt filter=demo\na.txt diff=demo\n");
  writeFileSync(join(dir, "clean.sh"), `#!/bin/sh\necho ran > "${cleanMarker}"\ncat\n`);
  chmodSync(join(dir, "clean.sh"), 0o755);
  writeFileSync(join(dir, "tc.sh"), `#!/bin/sh\necho ran > "${textconvMarker}"\ncat\n`);
  chmodSync(join(dir, "tc.sh"), 0o755);
  execFileSync("git", ["-C", dir, "config", "filter.demo.clean", join(dir, "clean.sh")]);
  execFileSync("git", ["-C", dir, "config", "diff.demo.textconv", join(dir, "tc.sh")]);
  // "one" ist vier Bytes, "two" auch: so muss git den clean-Filter fragen.
  writeFileSync(join(dir, "a.txt"), "two\n");

  const status = await getGitStatus(dir);
  assert.ok(status.files.some((file) => file.filePath === join(dir, "a.txt")), "git still reports the change");
  assert.ok(!existsSync(cleanMarker), "the repository's own clean filter ran during git status");

  const diff = await getGitFileDiff(dir, join(dir, "a.txt"));
  assert.ok(diff.patch.includes("+two"), `the diff must still be there, saw: ${diff.patch}`);
  assert.ok(!existsSync(textconvMarker), "textconv ran during git diff");
});

test("ohne die Schutzargumente laufen dieselben Treiber — die Fixture ist nicht tot", async (t) => {
  const dir = repo(t);
  const cleanMarker = join(dir, "clean-ran.txt");
  writeFileSync(join(dir, ".gitattributes"), "*.txt filter=demo\n");
  writeFileSync(join(dir, "clean.sh"), `#!/bin/sh\necho ran > "${cleanMarker}"\ncat\n`);
  chmodSync(join(dir, "clean.sh"), 0o755);
  execFileSync("git", ["-C", dir, "config", "filter.demo.clean", join(dir, "clean.sh")]);
  writeFileSync(join(dir, "a.txt"), "two\n");

  execFileSync("git", ["-C", dir, "status", "--porcelain=v1"]);
  assert.ok(existsSync(cleanMarker), "fixture dead: the clean filter did not run even without protection");
});
