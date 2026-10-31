import { readFileSync, statSync } from "node:fs";
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
 * Treiber aus der `.git/config` des Repos, und warum sie abgeschaltet werden.
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
 * `git diff` die `textconv`, und `--no-textconv` nimmt den zweiten weg. Die
 * Umgebung der Kinder ist dann schon sauber (`childEnv`), aber der Prozess
 * laeuft als Dienstbenutzer *ausserhalb* jeder Sandbox — er koennte die
 * Geheimnisdatei genauso lesen wie die Homes anderer Mandanten.
 *
 * Ein leerer Wert schaltet einen Treiber ab; gemessen: mit
 * `-c filter.demo.clean=` lief der Filter nicht mehr und `git status` blieb
 * korrekt. Der Preis ist ein Lesevorgang auf eine Datei, deren mtime den Cache
 * schluesselt.
 *
 * `include.path` in der Repo-Config wird nicht aufgeloest — ein Filter, den das
 * Repo ueber einen Include einbindet, bleibt offen. Das ist die Grenze dieser
 * Loesung, keine Absicht.
 */
const DRIVER_SECTION_RE = /^\s*\[\s*(filter|diff)\s+"([^"]+)"\s*\]/i;
const driverCache = new Map<string, { mtimeMs: number; args: string[] }>();

export function gitDriverOverrides(cwd: string): string[] {
  const config = join(cwd, ".git", "config");
  let mtimeMs: number;
  try {
    mtimeMs = statSync(config).mtimeMs;
  } catch {
    // Kein `.git/config` an diesem Pfad: entweder kein Repo (der Aufruf
    // scheitert gleich mit git's eigener Meldung) oder ein Worktree, dessen
    // `.git` eine Datei ist. Dann bleibt es bei den festen Argumenten.
    return [];
  }
  const cached = driverCache.get(config);
  if (cached && cached.mtimeMs === mtimeMs) return cached.args;

  const names = new Set<string>();
  try {
    for (const line of readFileSync(config, "utf8").split("\n")) {
      const section = DRIVER_SECTION_RE.exec(line);
      if (section) names.add(section[2]);
    }
  } catch {
    return [];
  }

  const args: string[] = [];
  for (const name of names) {
    args.push(
      "-c", `filter.${name}.clean=`,
      "-c", `filter.${name}.smudge=`,
      "-c", `filter.${name}.process=`,
      "-c", `diff.${name}.command=`,
      "-c", `diff.${name}.textconv=`,
    );
  }
  driverCache.set(config, { mtimeMs, args });
  return args;
}

/** Die globalen Argumente fuer einen Aufruf in `cwd`, in der richtigen Reihenfolge. */
export function gitIsolationArgs(cwd: string): string[] {
  return [...GIT_ISOLATION_ARGS, ...gitDriverOverrides(cwd)];
}
