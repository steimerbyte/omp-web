import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Die globalen Argumente, die **jeder** `git`-Aufruf der App traegt.
 *
 * `git` in einem Repository, das ein Mandant schreiben darf, ist eine Shell:
 * `core.fsmonitor` wird beim ersten `git status` als Kommando ausgefuehrt, und
 * die App startete `git` mit der vollen Dienstumgebung. Gemessen
 * (`SHELL-ISOLATION-SCAN.md` §4b) bekam so ein Hook `BRAVE_API_KEY`,
 * `OMP_WEB_PASSWORD` und `OPENROUTER_API_KEY` — der Datei-Explorer reichte, um
 * ihn auszuloesen. `core.hooksPath=/dev/null` schaltet zusaetzlich
 * `post-checkout`/`post-merge` ab, die `git worktree add` sonst fährt.
 *
 * Die Reihenfolge ist Teil des Vertrags: `-c` und `--no-optional-locks` sind
 * globale Optionen und muessen **vor** dem Unterkommando stehen. `-C <cwd>`
 * gehoert ebenfalls davor, deshalb setzen die Aufrufer es an Position 1.
 *
 * `-c diff.external=` ist die dritte Variante: ein `diff.external` laeuft nur
 * mit `--ext-diff`, aber die Option kostet nichts und schliesst den Weg, falls
 * jemand spaeter `--ext-diff` hinzufuegt.
 */
export const GIT_ISOLATION_ARGS: readonly string[] = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "diff.external=",
  "--no-optional-locks",
];

/**
 * Treiber aus **allen** Config-Quellen des Repos, und warum sie abgeschaltet werden.
 *
 * Hooks waren nur der erste Ausfuehrungsweg. Ein Repository, das ein Mandant
 * schreiben darf, kann sich seine eigenen Inhaltsfilter definieren:
 *
 * ```ini
 * [filter "x"]
 *   clean = /bin/sh -c '...'      # laeuft bei jedem `git status`
 * [diff "y"]
 *   textconv = /bin/sh -c '...'   # laeuft bei jedem `git diff`
 * ```
 *
 * Gemessen (`git 2.56`): `git status --porcelain` fuehrt den `clean`-Filter aus,
 * `git diff` die `textconv`, und `--no-textconv` nimmt den zweiten weg. Ein
 * leerer Wert schaltet einen Treiber ab (gemessen: `-c filter.demo.clean=`
 * laesst `git status` korrekt und den Filter aus).
 *
 * **Nur was ein Repository schreiben kann.** Der Treiber kann in der
 * Repo-Config stehen (auch in der veralteten, unquoted Form `[filter.demo]`),
 * in einer per `include.path`/`includeIf` **von dort** eingebundenen Datei oder
 * in der `config.worktree` eines verlinkten Worktrees (dessen `.git` eine
 * Datei ist). Genau diese Quellen werden abgeschaltet: `git config` laeuft
 * dafuer mit `GIT_CONFIG_GLOBAL=/dev/null` und `GIT_CONFIG_NOSYSTEM=1`, also
 * mit denselben Includes, aber ohne die globale/System-Config.
 *
 * Globale Treiber bleiben absichtlich aktiv. `git-lfs` schreibt
 * `filter.lfs.clean`/`smudge` in `~/.gitconfig`; wuerde man sie abschalten,
 * meldete `git status` jede LFS-Datei als geaendert (der Vergleich laeuft dann
 * gegen den rohen Arbeitsbaum-Inhalt statt gegen den Pointer) und `git diff`
 * zeigte "Binary files differ". Ein Mandant kann die Operator-Config nicht
 * schreiben, also gibt es dort nichts zu verteidigen — und ein Override waere
 * kein Schutz, sondern ein kaputter Datei-Explorer.
 *
 * `--show-origin` waere der naheliegende Filter, ist aber nicht ausreichend:
 * die Origin einer per `include` eingebundenen Datei nennt nicht, *wer* sie
 * eingebunden hat, also liesse sich eine globale Include-Datei nicht von einer
 * Repo-Include-Datei unterscheiden. Die env-scoped Abfrage liefert genau die
 * Menge "Repo-Config + deren Includes + config.worktree".
 *
 * `git config` fuehrt dabei nichts aus (kein Hook, kein Filter, kein Index).
 * Scheitert die Abfrage, wird der git-Aufruf **abgelehnt** statt ohne Overrides
 * zu laufen: eine unbekannte Treiberliste ist genau der Zustand, in dem ein
 * `clean`-Kommando des Mandanten mit der Dienstumgebung laufen wuerde. Der
 * fruehere mtime-Cache ist entfallen: eine Include-Datei aendert die mtime der
 * Repo-Config nicht, also haette er genau die neuen Quellen uebersehen.
 *
 * Treibernamen mit Zeichen ausserhalb von `[A-Za-z0-9_.-]` (gemessen: ein
 * `=` im Namen laesst sich nicht als `-c`-Schluessel ausdruecken) wandern in
 * eine kleine, inhaltsadressierte Include-Datei, in der die Sektion gequotet
 * ist. Sie liegt in einem pro Prozess angelegten `mkdtemp`-Verzeichnis, damit
 * niemand sie vorher unterschieben kann.
 */
const DRIVER_KEY_RE = /^(?:filter|diff)\.(.+)\.(?:clean|smudge|process|textconv|command)$/i;
const SAFE_NAME_RE = /^[A-Za-z0-9_.-]+$/;

function configuredDriverNames(cwd: string): Set<string> {
  let output: string;
  try {
    output = execFileSync("git", ["-C", cwd, "config", "--list", "--name-only", "--includes", "-z"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      // Repo-Scope: Repo-Config, deren Includes und config.worktree. Globale
      // und System-Treiber (git-lfs) bleiben fuer den Operator aktiv.
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
  } catch (error) {
    throw new Error(
      `Cannot enumerate the git content drivers of ${cwd}; refusing to run git without disabling them`,
      { cause: error },
    );
  }

  const names = new Set<string>();
  for (const key of output.split("\0")) {
    const match = DRIVER_KEY_RE.exec(key);
    if (match) names.add(match[1]);
  }
  return names;
}

let driverConfigDir: string | undefined;

/** Die Treiber, deren Namen sich nicht als `-c`-Schluessel schreiben lassen. */
function disableFileFor(names: readonly string[]): string {
  const lines: string[] = [];
  for (const name of names) {
    if (/[\0\r\n]/.test(name)) {
      throw new Error("Cannot disable a git content driver whose name contains a line break");
    }
    const quoted = `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    lines.push(
      `[filter ${quoted}]`, "\tclean =", "\tsmudge =", "\tprocess =",
      `[diff ${quoted}]`, "\tcommand =", "\ttextconv =",
    );
  }
  const content = `${lines.join("\n")}\n`;
  driverConfigDir ??= mkdtempSync(join(tmpdir(), "omp-git-drivers-"));
  const file = join(driverConfigDir, `${createHash("sha256").update(content).digest("hex").slice(0, 16)}.cfg`);
  try {
    writeFileSync(file, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return file;
}

export function gitDriverOverrides(cwd: string): string[] {
  const args: string[] = [];
  const unsafe: string[] = [];
  for (const name of configuredDriverNames(cwd)) {
    if (!SAFE_NAME_RE.test(name)) {
      unsafe.push(name);
      continue;
    }
    args.push(
      "-c", `filter.${name}.clean=`,
      "-c", `filter.${name}.smudge=`,
      "-c", `filter.${name}.process=`,
      "-c", `diff.${name}.command=`,
      "-c", `diff.${name}.textconv=`,
    );
  }
  if (unsafe.length > 0) args.push("-c", `include.path=${disableFileFor(unsafe)}`);
  return args;
}

/** Die globalen Argumente fuer einen Aufruf in `cwd`, in der richtigen Reihenfolge. */
export function gitIsolationArgs(cwd: string): string[] {
  return [...GIT_ISOLATION_ARGS, ...gitDriverOverrides(cwd)];
}
