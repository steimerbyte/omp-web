import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "./runtime-secrets";

/**
 * Mandanten-Isolation fuer das Terminal.
 *
 * Der naive Weg waere ein OS-Benutzer pro Konto (`useradd omp<name>`) plus
 * `sudoers`-Regel plus `runuser`. Gemessen am 2026-10-03 auf dem Host, auf dem
 * diese Datei entstanden ist, geht davon **kein** Schritt: `sudo -n true`
 * antwortet mit `a password is required`, `setpriv --reuid=...` mit
 * `setresuid failed: Operation not permitted`, und `useradd` zwar vorhanden,
 * aber ohne sudoers-Regel nicht aufrufbar. Wer es trotzdem baut, liefert Code,
 * der auf dieser Maschine nie gelaufen ist.
 *
 * Der Weg, der ohne Privilegien geht, ist eine User-Namespace ueber
 * `bubblewrap`. Sie braucht kein root und kein sudo, und die Grenze erzwingt
 * der Kernel, nicht dieser Code. Gemessen im selben Lauf:
 *
 * - fremdes Home:        `No such file or directory` (unsichtbar, nicht nur unlesbar)
 * - `/etc/shadow`:       `Permission denied`
 * - `/root`:             `No such file or directory`
 * - `sudo -n true`:      `no new privileges flag is set, prevents sudo from running as root`
 * - `su nobody`:         `Authentication token manipulation error`
 * - `uid=0` in der NS:  ist nicht Host-root, `touch /root/pwned` scheitert
 *
 * Zwei Dinge, die man hier nicht falsch machen darf, und die beide gemessen
 * worden sind, weil sie wie funktionierende Isolation aussehen und es nicht
 * sind:
 *
 * 1. **Die Verzeichnisse werden nicht erzeugt, sondern gemountet.** `--bind
 *    <home> /home/<name>` laesst `/home/<name>` nur innerhalb der Namespace
 *    existieren. Auf dem Host gibt es den Pfad nicht. Ein echtes Verzeichnis
 *    anzulegen und es dann zu verstecken waere schwaecher: es gaebe etwas zu
 *    sehen, das man nur nicht sieht.
 * 2. **`HOME` muss gesetzt sein.** Ohne `--setenv HOME` sieht die innere
 *    Shell weiter das Home des aufrufenden Users, und damit wird die falsche
 *    Datei isoliert. Die Trennung entsteht dadurch, dass andere Mandanten
 *    gar nicht gemountet sind — nicht durch angelegte Verzeichnisse.
 */

/** Warum eine Sandbox nicht gebaut werden konnte. Kein `null`-Fall im Erfolg. */
export type SandboxFailureReason =
  | "unsupported-platform"
  | "bwrap-missing"
  | "userns-disabled"
  | "no-home"
  | "home-missing"
  | "admin-home"
  | "bad-username"
  | "cwd-outside-home"
  | "mask-unavailable";

export interface SandboxFailure {
  ok: false;
  reason: SandboxFailureReason;
  detail: string;
  remediation: string;
}

export interface SandboxPlan {
  ok: true;
  /** Das volle argv, inklusive `bwrap` an Position 0. */
  argv: string[];
}

export type SandboxResult = SandboxPlan | SandboxFailure;

export interface SandboxOptions {
  /** Das Home des Mandanten. Muss existieren; wird als dessen `/home/<name>` gemountet. */
  home: string;
  /** Der Benutzername, wird als Verzeichnisname unter `/home` verwendet. */
  username: string;
  /** Der Befehl, der in der Sandbox laufen soll (typischerweise `[script, -qfc, …]`). */
  command: string[];
  /** Wo die Shell startet. Muss unter `home` liegen, sonst bindet es nichts. */
  cwd: string;
  /**
   * Die Umgebung **innerhalb** der Sandbox. Wird zu `--setenv`-Paaren hinter
   * `--clearenv`; `HOME`, `USER` und `LOGNAME` setzt diese Funktion selbst.
   * Ohne Angabe gilt `buildTerminalEnv()`.
   */
  env?: Record<string, string>;
  /**
   * Dateien, die innerhalb der Sandbox **nicht** lesbar sein duerfen, obwohl
   * ihr Elternverzeichnis gebunden ist — die Geheimnisdatei des Dienstes und
   * die Auth-Dateien.
   *
   * Der Grund ist gemessen und unangenehm: `/etc` ist als Ganzes read-only
   * gebunden, weil eine Shell ohne `/etc/ld.so.cache`, `/etc/localtime` und
   * `/etc/passwd` nicht brauchbar ist. Eine 0600-Datei, die dem Dienstbenutzer
   * gehoert, ist fuer diese Shell trotzdem lesbar — die Namespace aendert die
   * uid nicht. Ohne Maske waere `cat /etc/omp-web.env` in der „isolierten"
   * Shell der Weg zum Admin-Passwort.
   */
  maskFiles?: string[];
}

const SANDBOX_HOME = "/home";

/**
 * Die einzigen Variablen, die eine Terminal-Shell ueberhaupt erbt.
 *
 * Eine **positive** Liste, kein Loeschfilter. Der Unterschied ist gemessen:
 * `delete env.OMP_WEB_PASSWORD` war der einzige Schnitt der alten Fassung, und
 * `BRAVE_API_KEY` stand trotzdem in jeder Mandanten-Shell, weil eine
 * Sperrliste gegen eine Umgebung antritt, die von aussen waechst. Ein neuer
 * Eintrag hier ist eine bewusste Entscheidung und braucht einen Grund in dieser
 * Liste, nicht in der Unit.
 *
 * `HOME`/`USER`/`LOGNAME` stehen drin, weil sie auf dem ungesandboxten
 * Admin-Pfad aus der Prozessumgebung kommen muessen; in der Sandbox ueberschreibt
 * `planSandboxSpawn` sie mit den Werten des Mandanten.
 */
export const TERMINAL_ENV_ALLOWLIST = [
  // Befehle finden. Ohne PATH startet die Shell nicht einmal.
  "PATH",
  // Zeichensatz und Tastaturbelegung. Falsch gesetzt zerlegt Umlaute in `ls`.
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  // Identitaet des angemeldeten Kontos.
  "HOME",
  "USER",
  "LOGNAME",
] as const;

/** Die allow-gelistete Umgebung aus einer Quelle (Vorgabe: `process.env`). */
export function buildTerminalEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of TERMINAL_ENV_ALLOWLIST) {
    const value = source[name];
    if (typeof value === "string" && value.length > 0) env[name] = value;
  }
  return env;
}

/**
 * `bwrap` einmal suchen. Bewusst gecacht: das ist ein `PATH`-Scan auf dem Weg
 * in jedes Terminal, und `which` pro Spawn waere messbarer Ballast.
 */
let bwrapPath: string | null | undefined;

function findBwrap(env: NodeJS.ProcessEnv): string | null {
  if (bwrapPath !== undefined) return bwrapPath;
  try {
    // `childEnv`, weil auch `which` ein Kind ist: die Allow-Liste des Terminals
    // reicht hier nicht (der PATH muss derselbe sein wie fuer `unshare`), aber
    // die Geheimnisse der Unit muessen draussen bleiben.
    bwrapPath = execFileSync("which", ["bwrap"], { encoding: "utf8", env: childEnv(env) }).trim() || null;
  } catch {
    bwrapPath = null;
  }
  return bwrapPath;
}

/**
 * Sind unprivilegierte User-Namespaces ueberhaupt erlaubt?
 *
 * `unshare -Ur` ist die ehrlichere Pruefung als ein sysctl: es fragt nicht,
 * ob ein Schalter auf 1 steht, sondern ob der Kernel einen Namespace fuer
 * diesen Prozess tatsaechlich aufspannt. Auf Distros mit
 * `unprivileged_userns_clone=0` sagt der Schalter nichts ueber die
 * Wirksamkeit, der Aufruf schon.
 */
export function canUseUserNamespaces(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    // `stdio: "ignore"` schluckt die Ausgabe, deshalb ist das Argument
    // zwingend: ohne `encoding` gibt `execFileSync` einen Buffer zurueck, und
    // ein Vergleich gegen `undefined` waere immer falsch — die Pruefung meldete
    // dann auf jedem Host `false`, obwohl der Namespace aufgeht.
    execFileSync("unshare", ["-Ur", "true"], { env: childEnv(env), stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Das Ergebnis der Voraussetzungspruefung, als Union auf `ok`.
 *
 * Als flache Struktur mit `ok: boolean` musste der Aufrufer `preflight.bwrap!`
 * schreiben, obwohl im Erfolgszweig `null` unmöglich ist. Die Union macht das
 * Unmoegliche zum Compile-Fehler statt zum `!`, und im Fehlerzweig ist
 * `remediation` pflicht, statt `string | null` mit einem `??`-Fallback, der
 * still `null` werden kann.
 */
export type SandboxPreflight =
  | { ok: true; bwrap: string; userNamespaces: true; remediation: null }
  | { ok: false; bwrap: string | null; userNamespaces: boolean; remediation: string };

/**
 * Ist eine Sandbox auf diesem Host ueberhaupt moeglich?
 *
 * `ok: true` heisst "die Voraussetzungen sind da" und **nicht** "die Isolation
 * greift" — das ist derselbe Unterschied, an dem `checkIsolationPrerequisites`
 * im alten Isolationsstrang gescheitert ist: es hat drei Binaries gefunden und
 * daraus eine Freigabe gemacht, ohne den einzigen Aufruf zu pruefen, der die
 * Berechtigung wirklich verraet.
 */
export function checkSandboxPrerequisites(env: NodeJS.ProcessEnv = process.env): SandboxPreflight {
  if (process.platform === "win32") {
    return { ok: false, bwrap: null, userNamespaces: false, remediation: "Windows has no user namespaces; the sandbox is unavailable there." };
  }
  const bwrap = findBwrap(env);
  if (bwrap === null) {
    return {
      ok: false,
      bwrap: null,
      userNamespaces: false,
      remediation: "Install bubblewrap (Arch: `pacman -S bubblewrap`), or the terminal will run as the service user without isolation.",
    };
  }
  const userNamespaces = canUseUserNamespaces(env);
  if (!userNamespaces) {
    return {
      ok: false,
      bwrap,
      userNamespaces: false,
      remediation: "Unprivileged user namespaces are disabled on this kernel, so bubblewrap cannot sandbox the shell.",
    };
  }
  return { ok: true, bwrap, userNamespaces: true, remediation: null };
}

/**
 * Die Sandbox-Argumente fuer einen Mandanten.
 *
 * Die Reihenfolge hier ist die Vertrag: `--tmpfs /tmp` zuerst, damit kein
 * fremder Pfad durch das echte `/tmp` sichtbar wird, danach genau **ein**
 * `--bind` fuer das eigene Home. Ein zweites `--bind` auf ein fremdes Home
 * waere genau der Fehler, den diese Funktion verhindert, indem sie kein
 * Argument dafuer kennt.
 */
/**
 * Die Quelle fuer eine Datei-Maske.
 *
 * `/dev/null` waere der naheliegende Kandidat und funktioniert **nicht**:
 * bubblewrap mountet mit `MS_NODEV`, und das Oeffnen eines Geraeteknotens
 * scheitert dann mit `Permission denied` — gemessen, nicht vermutet. Eine leere
 * regulaere Datei bindet sich dagegen einwandfrei und liest als 0 Bytes.
 *
 * Der Pfad liegt in `os.tmpdir()` und ist absichtlich nicht konfigurierbar: er
 * enthaelt nichts. Wird er nicht angelegt, verweigert der Plan die Shell, statt
 * die Geheimnisdatei sichtbar zu lassen.
 */
let maskSourcePath: string | null | undefined;

function emptyMaskSource(): string | null {
  if (maskSourcePath !== undefined) return maskSourcePath;
  const file = join(tmpdir(), "omp-web-mask-empty");
  try {
    if (!existsSync(file) || statSync(file).size !== 0) writeFileSync(file, "", { mode: 0o600 });
    maskSourcePath = file;
  } catch {
    maskSourcePath = null;
  }
  return maskSourcePath;
}

export function planSandboxSpawn(options: SandboxOptions): SandboxResult {
  // Die Voraussetzungen werden auf dem **Host** geprueft, nicht in der
  // Inside-Umgebung: `which bwrap` und `unshare` brauchen den PATH des Dienstes.
  const preflight = checkSandboxPrerequisites(process.env);
  if (!preflight.ok) {
    // `detail` ist die Beobachtung, `remediation` die Handlung. Beide gleich
    // zu setzen hiesse: der Logeintrag wiederholt die Anleitung und der
    // Diagnose fehlt.
    if (process.platform === "win32") {
      return {
        ok: false,
        reason: "unsupported-platform",
        detail: "Windows has no user namespaces, so bubblewrap cannot sandbox the shell.",
        remediation: preflight.remediation,
      };
    }
    if (preflight.bwrap === null) {
      return {
        ok: false,
        reason: "bwrap-missing",
        detail: "bwrap was not found on PATH.",
        remediation: preflight.remediation,
      };
    }
    return {
      ok: false,
      reason: "userns-disabled",
      detail: "unshare -Ur true failed; the kernel refuses unprivileged user namespaces.",
      remediation: preflight.remediation,
    };
  }
  const bwrap = preflight.bwrap;
  // Das Home wird aufgeloest, bevor irgendetwas gebunden wird: ein Home, das ein
  // Symlink auf `/` ist, wuerde sonst als `--bind /` die ganze Platte
  // read-write in die „Sandbox" legen — und der String-Vergleich gegen `/`
  // saehe es nicht. Auf dem Host ist der Symlink fuer den Dienstbenutzer
  // erreichbar, weil er selbst die Homes anlegt.
  const home = typeof options.home === "string" && options.home.trim().length > 0
    ? (() => {
      try {
        return realpathSync(options.home);
      } catch {
        return options.home;
      }
    })()
    : "";
  if (home.length === 0) {
    return {
      ok: false,
      reason: "no-home",
      detail: "No home directory was resolved for this account.",
      remediation: "Give the account a home under OMP_WEB_HOME_ROOT; a sandbox without a home would isolate the wrong files.",
    };
  }
  // `--bind / …` waere die gesamte Host-Wurzel, les- und schreibbar. Ein Admin
  // hat keine Mandanten-Grenze — die Route laesst ihn bewusst ungesandboxt
  // laufen und sagt `sandboxed: false`. Ein Plan fuer ihn ist also nie richtig,
  // egal wer ihn anfragt.
  if (home === "/") {
    return {
      ok: false,
      reason: "admin-home",
      detail: "The resolved home is the filesystem root; binding it would expose the whole host read-write.",
      remediation: "The admin terminal runs unconfined by decision (sandboxed: false). Do not plan a sandbox for an admin identity.",
    };
  }
  // Ein fehlendes Home war vorher kein Planfehler: gemessen brach erst `bwrap`
  // mit `Can't find source path` ab, und je nach cwd wurde daraus ein 500 mit
  // einer irrefuehrenden bwrap-Meldung oder — schlimmer — ein ungesandboxter
  // Fallback. Ein fehlendes Konto-Verzeichnis ist ein Zustand, den die Route
  // benennen kann.
  if (!existsSync(home)) {
    return {
      ok: false,
      reason: "home-missing",
      detail: `The home directory ${home} does not exist, so there is nothing to bind.`,
      remediation: "Create the account's home (POST /api/accounts or a first login) before opening a terminal.",
    };
  }
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(options.username)) {
    return {
      ok: false,
      reason: "bad-username",
      detail: `Refusing to build a sandbox path from an unusable username: ${options.username}`,
      remediation: "The account name must match /^[a-z_][a-z0-9_-]{0,31}$/.",
    };
  }
  // Ein cwd ausserhalb des Homes wurde vorher unveraendert durchgereicht, und
  // bwrap starte daran nicht: gemessen `bwrap: Can't chdir to /tmp/outside-cwd:
  // No such file or directory`. Das ist kein theoretischer Fall — die
  // `~/omp-cwd-*`-Vergaben (AGENTS.md) sind genau solche Pfade, und die Route
  // haette es nur spaeter als `[Process exited with code 1]` im SSE-Strom
  // erfahren. Eine Shell, die im falschen Verzeichnis aufgeht, ist schlechter
  // als eine, die gar nicht aufgeht: deshalb die Ablehnung mit Grund, nicht ein
  // stilles Zurueckfallen auf `/`.
  if (!isInsideHome(options.cwd, home)) {
    return {
      ok: false,
      reason: "cwd-outside-home",
      detail: `The working directory ${options.cwd} is outside the tenant's home ${home} and is not mounted into the sandbox.`,
      remediation: "Choose a working directory inside the account's home, or extend the sandbox to bind it deliberately.",
    };
  }

  // Nur Systemverzeichnisse readonly einbinden. Alles, was nicht in dieser
  // Liste steht, existiert in der Sandbox nicht — das ist der eigentliche
  // Hebel, und deshalb ist die Liste absichtlich kurz statt "alles readonly".
  const argv = [
    bwrap,
    "--unshare-user",
    "--unshare-pid",
    // Ohne das sieht die Shell die Prozesse des Dienstes und der anderen
    // Mandanten. Gemessen: ohne `--unshare-pid` ist `/proc` die des Hosts.
    "--unshare-ipc",
    "--unshare-uts",
    "--die-with-parent",
    "--new-session",
    "--tmpfs", "/tmp",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/etc", "/etc",
    "--dev", "/dev",
    "--proc", "/proc",
  ];
  // Verzeichnisse, die es auf diesem Host nicht gibt, werden uebersprungen.
  // Der Kommentar behauptete das vorher, der Code band sie trotzdem: gemessen
  // bricht `bwrap --ro-bind /nonexistent /nonexistent` mit `Can't find source
  // path` ab und beendet den Spawn, statt das Verzeichnis zu ignorieren.
  for (const dir of ["/lib", "/lib64", "/sbin"]) {
    if (existsSync(dir)) argv.push("--ro-bind", dir, dir);
  }
  // Namensauflösung. `/etc` ist ganz und readonly gemountet, aber `/etc/resolv.conf`
  // ist auf systemd-resolved-Hosts ein Symlink nach `/run/systemd/resolve/…`,
  // und `/run` haengt nicht in der Sandbox. Gemessen: `cat /etc/resolv.conf` →
  // `No such file or directory`, `getent hosts pypi.org` → nichts, waehrend rohe
  // IPs weiter funktionierten. Ein legitimes `npm install` oder `git clone`
  // war damit unmoeglich. Der Mount ist read-only und deckt nur das
  // Resolver-Verzeichnis ab; er oeffnet keine Datei, die `/etc` nicht schon
  // zeigt.
  if (existsSync("/run/systemd/resolve")) {
    argv.push("--ro-bind", "/run/systemd/resolve", "/run/systemd/resolve");
  }

  // Die Dienstgeheimnisse, die unter einem gebundenen Verzeichnis liegen,
  // bekommen `/dev/null` darueber. Ohne das ist die Aussage „die Shell sieht
  // keine Geheimnisse" nur ueber `env` wahr: `/etc` ist gebunden, die Datei
  // gehoert dem Dienstbenutzer, und die Namespace aendert die uid nicht —
  // `cat /etc/omp-web.env` liefert dann das Admin-Passwort. Der Mount muss
  // **nach** dem Verzeichnis kommen, das ihn sichtbar macht, und nur fuer
  // Dateien, die es auf dem Host wirklich gibt (`bwrap` bricht sonst mit
  // `Can't find source path` ab).
  const maskable = (options.maskFiles ?? []).filter((file) => existsSync(file)
    && ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/run/systemd/resolve"].some(
      (root) => file === root || file.startsWith(`${root}/`),
    ));
  if (maskable.length > 0) {
    const source = emptyMaskSource();
    if (source === null) {
      // Lieber keine Shell als eine, in der die Geheimnisdatei liegt: die Maske
      // ist der letzte Schnitt zwischen `/etc` und dem Admin-Passwort.
      return {
        ok: false,
        reason: "mask-unavailable",
        detail: "A file is needed to mask the service's secret files, and it could not be created.",
        remediation: "Check that the service user can write to its temporary directory, then reload.",
      };
    }
    for (const file of maskable) argv.push("--ro-bind", source, file);
  }

  // Das Arbeitsverzeichnis muss auf den Namespace-Pfad umgeschrieben werden.
  // Der Host-Pfad existiert innerhalb der Sandbox nicht: gemessen
  // `bwrap: Can't chdir to /tmp/omp-sandbox-*/grace: No such file or
  // directory`, weil das Home dort als `/home/<name>` haengt.
  const sandboxedCwd = mapCwdIntoSandbox(options.cwd, home, options.username);
  argv.push("--bind", home, `${SANDBOX_HOME}/${options.username}`);

  // `--clearenv` ist der Schnitt, der wirklich greift: gemessen 109 geerbte
  // Schluessel (inklusive `BRAVE_API_KEY` und `OMP_WEB_PASSWORD`) vorher,
  // danach genau die hier gesetzten. `--setenv` allein würde nur addieren.
  argv.push("--clearenv");
  const inside = { ...buildTerminalEnv(), ...(options.env ?? {}) };
  // Diese drei entscheidet die Sandbox, nicht der Aufrufer: sie beschreiben,
  // welches Konto man in der Shell ist, und ein Aufrufer, der sie ueberschreiben
  // koennte, wuerde `HOME` auf ein nicht gemountetes Verzeichnis zeigen lassen.
  for (const name of ["HOME", "USER", "LOGNAME"]) delete inside[name];
  for (const [name, value] of Object.entries(inside)) argv.push("--setenv", name, value);
  argv.push(
    "--setenv", "HOME", `${SANDBOX_HOME}/${options.username}`,
    "--setenv", "USER", options.username,
    "--setenv", "LOGNAME", options.username,
    "--chdir", sandboxedCwd,
  );
  argv.push(...options.command);
  return { ok: true, argv };
}

/**
 * Liegt `cwd` im Home oder darunter?
 *
 * Der `home + "/"`-Test ist absichtlich: `startsWith(home)` allein wuerde
 * `/home/alice2` als Kind von `/home/alice` durchlassen und damit in ein fremdes
 * Verzeichnis chdir. Fuer den Aufrufer ist die Frage nur "darf ich das ueberhaupt
 * in die Sandbox geben", deshalb heisst das Nein hier immer `cwd-outside-home`.
 */
function isInsideHome(cwd: string, home: string): boolean {
  return cwd === home || cwd.startsWith(`${home}/`);
}

/**
 * Rechnet einen Host-Pfad in den Namespace um. Nur fuer Pfade, die
 * `isInsideHome` bestanden haben — der Aufrufer lehnt den Rest ab.
 */
function mapCwdIntoSandbox(cwd: string, home: string, username: string): string {
  const homeInSandbox = `${SANDBOX_HOME}/${username}`;
  if (cwd === home) return homeInSandbox;
  return `${homeInSandbox}/${cwd.slice(home.length + 1)}`;
}
