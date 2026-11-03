import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getGitFileDiff, getGitStatus } from "./git-changes.ts";
import { gitDriverOverrides } from "./git-safe.ts";

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

/**
 * Beweist, dass die Fixture unter ungeschuetztem `git status` den clean-Filter
 * wirklich ausfuehrt, und macht den naechsten Status wieder aussagekraeftig:
 * neue mtime, gleiche Groesse. Ohne diesen Beweis waere ein gruener
 * App-Aufruf auch dann moeglich, wenn die Fixture den Treiber nie ausgefuehrt
 * haette.
 */
function proveCleanFilterRuns(dir, marker) {
  execFileSync("git", ["-C", dir, "status", "--porcelain=v1"]);
  assert.ok(existsSync(marker), "fixture is dead: the clean filter did not run under plain git");
  rmSync(marker, { force: true });
  writeFileSync(join(dir, "a.txt"), "six\n");
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

test("eine veraltete unquoted [filter.x]-Sektion wird genauso abgeschaltet", async (t) => {
  const dir = repo(t);
  const cleanMarker = join(dir, "legacy-clean-ran.txt");
  writeFileSync(join(dir, ".gitattributes"), "*.txt filter=legacy\n");
  writeFileSync(join(dir, "clean.sh"), `#!/bin/sh\necho ran > "${cleanMarker}"\ncat\n`);
  chmodSync(join(dir, "clean.sh"), 0o755);
  // `git config` schreibt immer die gequotete Form `[filter "legacy"]`; die
  // veraltete, unquoted Form muss von Hand in die Datei.
  appendFileSync(join(dir, ".git", "config"), `[filter.legacy]\n\tclean = ${join(dir, "clean.sh")}\n`);
  writeFileSync(join(dir, "a.txt"), "two\n");
  proveCleanFilterRuns(dir, cleanMarker);

  const status = await getGitStatus(dir);
  assert.ok(status.files.some((file) => file.filePath === join(dir, "a.txt")), "git still reports the change");
  assert.ok(!existsSync(cleanMarker), "the clean filter from the deprecated unquoted section ran");
});

test("ein ueber include.path eingebundener Treiber wird abgeschaltet — clean und textconv", async (t) => {
  const dir = repo(t);
  const cleanMarker = join(dir, "include-clean-ran.txt");
  const textconvMarker = join(dir, "include-textconv-ran.txt");
  writeFileSync(join(dir, "clean.sh"), `#!/bin/sh\necho ran > "${cleanMarker}"\ncat\n`);
  chmodSync(join(dir, "clean.sh"), 0o755);
  writeFileSync(join(dir, "tc.sh"), `#!/bin/sh\necho ran > "${textconvMarker}"\ncat\n`);
  chmodSync(join(dir, "tc.sh"), 0o755);

  const included = join(dir, "drivers.cfg");
  writeFileSync(included, `[filter "inc"]\n\tclean = ${join(dir, "clean.sh")}\n[diff "inc"]\n\ttextconv = ${join(dir, "tc.sh")}\n`);
  execFileSync("git", ["-C", dir, "config", "include.path", included]);
  writeFileSync(join(dir, ".gitattributes"), "*.txt filter=inc\na.txt diff=inc\n");
  writeFileSync(join(dir, "a.txt"), "two\n");
  proveCleanFilterRuns(dir, cleanMarker);

  const status = await getGitStatus(dir);
  assert.ok(status.files.some((file) => file.filePath === join(dir, "a.txt")), "git still reports the change");
  assert.ok(!existsSync(cleanMarker), "the clean filter from include.path ran during git status");

  // Auch die textconv-Fixture muss unter ungeschuetztem git laufen.
  execFileSync("git", ["-C", dir, "diff", "--", "a.txt"]);
  assert.ok(existsSync(textconvMarker), "fixture is dead: textconv did not run under plain git diff");
  rmSync(textconvMarker, { force: true });

  const diff = await getGitFileDiff(dir, join(dir, "a.txt"));
  assert.ok(diff.patch.includes("+six"), `the diff must still be there, saw: ${diff.patch}`);
  assert.ok(!existsSync(textconvMarker), "the textconv from include.path ran during git diff");
});

test("ein verlinkter Worktree mit .git-Datei schaltet die Treiber der gemeinsamen Config ab", async (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, ".gitattributes"), "*.txt filter=wt\n");
  execFileSync("git", ["-C", dir, "add", ".gitattributes"]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "attrs"]);

  const cleanMarker = join(dir, "worktree-clean-ran.txt");
  writeFileSync(join(dir, "clean.sh"), `#!/bin/sh\necho ran > "${cleanMarker}"\ncat\n`);
  chmodSync(join(dir, "clean.sh"), 0o755);
  execFileSync("git", ["-C", dir, "config", "filter.wt.clean", join(dir, "clean.sh")]);

  const worktree = `${dir}-worktree`;
  execFileSync("git", ["-C", dir, "worktree", "add", "-q", "-b", "wt-branch", worktree]);
  t.after(() => rmSync(worktree, { recursive: true, force: true }));
  assert.match(
    readFileSync(join(worktree, ".git"), "utf8"),
    /^gitdir: /,
    "fixture: a linked worktree keeps its git dir pointer in a file",
  );
  writeFileSync(join(worktree, "a.txt"), "two\n");
  proveCleanFilterRuns(worktree, cleanMarker);

  const status = await getGitStatus(worktree);
  assert.equal(status.isGitRepository, true);
  assert.ok(status.files.some((file) => file.filePath === join(worktree, "a.txt")), "git still reports the change");
  assert.ok(!existsSync(cleanMarker), "the clean filter ran through the worktree's shared config");
});

test("ein Treibername mit '=' (nicht als -c-Schluessel schreibbar) wird ueber die Include-Datei abgeschaltet", async (t) => {
  const dir = repo(t);
  const cleanMarker = join(dir, "equals-clean-ran.txt");
  writeFileSync(join(dir, ".gitattributes"), "*.txt filter=we=ird\n");
  writeFileSync(join(dir, "clean.sh"), `#!/bin/sh\necho ran > "${cleanMarker}"\ncat\n`);
  chmodSync(join(dir, "clean.sh"), 0o755);
  // `git -c filter.we=ird.clean=` parst als Schluessel `filter.we`; der Treiber
  // bliebe damit aktiv. Genau dieser Fall geht ueber die Include-Datei.
  appendFileSync(join(dir, ".git", "config"), `[filter "we=ird"]\n\tclean = ${join(dir, "clean.sh")}\n`);
  writeFileSync(join(dir, "a.txt"), "two\n");
  proveCleanFilterRuns(dir, cleanMarker);

  const status = await getGitStatus(dir);
  assert.ok(status.files.some((file) => file.filePath === join(dir, "a.txt")), "git still reports the change");
  assert.ok(!existsSync(cleanMarker), "the clean filter with '=' in its name ran");
});

test("ein globaler Treiber (git-lfs-Fall) bleibt aktiv — ein Repo kann ihn nicht schreiben", async (t) => {
  const dir = repo(t);
  const cleanMarker = join(dir, "global-clean-ran.txt");
  const filterScript = join(dir, "global-clean.sh");
  // Der Filter muss den Inhalt veraendern: nur dann zeigt die Gegenprobe unten,
  // warum das Abschalten eines globalen Treibers die Datei als geaendert meldet.
  writeFileSync(filterScript, `#!/bin/sh\necho ran > "${cleanMarker}"\ntr a-z A-Z\n`);
  chmodSync(filterScript, 0o755);
  const globalConfig = join(dir, "global-gitconfig");
  writeFileSync(globalConfig, `[filter "global-demo"]\n\tclean = ${filterScript}\n`);
  writeFileSync(join(dir, ".gitattributes"), "*.txt filter=global-demo\n");

  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  t.after(() => {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
  });

  // Commit mit aktivem Filter: "two\n" wird als "TWO\n" gespeichert.
  writeFileSync(join(dir, "a.txt"), "two\n");
  execFileSync("git", ["-C", dir, "add", ".gitattributes", "a.txt"]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "global filter"]);
  rmSync(cleanMarker, { force: true });
  const plainStatus = ["-C", dir, "status", "--porcelain=v1", "--untracked-files=no"];

  // Lebendig: ungeschuetztes git fuehrt den globalen Filter aus und sieht die
  // Datei danach als clean, weil der Filter "two\n" zu "TWO\n" macht.
  writeFileSync(join(dir, "a.txt"), "two\n");
  assert.equal(execFileSync("git", plainStatus, { encoding: "utf8" }), "");
  assert.ok(existsSync(cleanMarker), "fixture is dead: the global clean filter did not run under plain git");
  rmSync(cleanMarker, { force: true });

  // Gegenprobe: mit leerem Treiber meldet git die Datei als geaendert. Genau
  // diese kaputte Anzeige waere die Folge, wenn wir globale Treiber abschalten.
  writeFileSync(join(dir, "a.txt"), "two\n");
  const poisoned = execFileSync(
    "git",
    ["-C", dir, "-c", "filter.global-demo.clean=", ...plainStatus.slice(2)],
    { encoding: "utf8" },
  );
  assert.match(poisoned, /^ M a\.txt$/m, "neutralising a global clean filter reports the file as modified");

  // Der App-Aufruf laesst den globalen Treiber in Ruhe: kein Override, und er
  // laeuft beim naechsten Status wieder.
  const overrides = gitDriverOverrides(dir);
  assert.ok(!overrides.includes("filter.global-demo.clean="), `global driver must not be neutralised: ${overrides.join(" ")}`);
  writeFileSync(join(dir, "a.txt"), "six\n");
  const status = await getGitStatus(dir);
  assert.ok(status.files.some((file) => file.filePath === join(dir, "a.txt")), "git still reports the change");
  assert.ok(existsSync(cleanMarker), "the operator's global driver must keep running");
});
