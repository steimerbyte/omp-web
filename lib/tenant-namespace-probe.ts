import { readdirSync, readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

/**
 * Steht dieser Prozess wirklich in einer eigenen Mount-Namespace?
 *
 * ### Warum das gemessen werden muss
 *
 * `lib/tenant-worker.ts` hat `enforced` aus `pid !== undefined` abgeleitet. Das
 * ist keine Messung des Kerns, sondern eine Annahme ueber den Spawn: liegt
 * frueher im `PATH` ein Wrapper (oder eine mitgelieferte `bwrap`-Kopie), der die
 * Nutzlast ohne Namespace `exec`t, meldet der Start trotzdem eine PID — und der
 * Server behauptet `enforced: true` fuer einen unconfined Mandanten. §5/§8 des
 * Plans verlangen das Gegenteil: keine Isolation behaupten, die nicht da ist.
 *
 * ### Was gemessen wird, und warum nicht der argv
 *
 * Der argv ist die Behauptung des Aufrufers; bei einem Wrapper ist er sogar
 * vollstaendig, weil der Wrapper ihn nur weiterreicht. Der Kernel ist die
 * Gegenprobe, und er beantwortet zwei Fragen:
 *
 *  1. **Welche Wurzel sieht der Prozess?** `/proc/<pid>/root` ist die Wurzel des
 *     Mount-Namespace dieses Prozesses. Traegt sie dasselbe Geraet und denselben
 *     Inode wie die Dienstwurzel (`<root>`, Vorgabe `/`), teilt der Prozess
 *     deren Mount-Namespace — es gibt keine Grenze. Ein anderes Paar heisst: er
 *     steht in einer eigenen Namespace, und das ist der **Beleg** fuer die
 *     Grenze, kein Fehler. (Die Richtung ist wesentlich: die Gleichheit ist der
 *     Befund.)
 *  2. **Was liegt dort unter `/home`?** In der Grenze ist genau das Gast-Home
 *     des Mandanten gebunden (`--bind <hostHome> /home/<name>`), also enthaelt
 *     `/proc/<pid>/root/home` genau `<name>` und nichts sonst. Insbesondere darf
 *     das Home des Dienstbenutzers (`os.userInfo().username`) dort nicht stehen:
 *     sein Vorhandensein heisst, dass dies das Host-`/home` ist.
 *
 * ### Gemessen am 2026-11-09 auf diesem Host (LXC 101, bubblewrap 0.12.0)
 *
 * An einem echten Worker-Start meldet `Bun.spawn` die PID des **aeusseren**
 * `bwrap` (`comm=bwrap`), und dieser Prozess steht noch in der Mount-Namespace
 * des Dienstes: `/proc/<pid>/root` = `device 46 inode 34` wie `/`, `/home` =
 * `["pi"]`. Erst sein Kind ist `pid 1` der neuen Namespace (`device 59 inode 2`,
 * `/home` = `["<name>"]`) — dieselbe Dreiteilung, die
 * `scripts/verify-tenant-isolation.mjs` (`insideOwnMountNamespace`) schon
 * beschreibt. Deshalb wird ab der uebergebenen PID **abwaerts** gesucht: die
 * gemeldete PID ist der Supervisor, nicht der Mandant.
 *
 * Ein Wrapper, der die Nutzlast ohne Namespace `exec`t, hinterlaesst keinen
 * solchen Nachfahren und faellt damit durch beide Fragen.
 *
 * ### Was es nicht beweist
 *
 * Ein absichtlich gefaelschtes `/proc` — ein Betreiber, der den Prozessbaum
 * manipuliert — liegt ausserhalb des Bedrohungsmodells. Die Grenze schuetzt
 * gegen einen Mandanten, nicht gegen den Betreiber der Maschine.
 */

export type WorkerNamespaceProbeResult = { ok: true } | { ok: false; detail: string };

/** Wie tief abwaerts gesucht wird, und wie viele Prozesse dabei angesehen werden. */
const MAX_DEPTH = 8;
const MAX_CANDIDATES = 128;

/**
 * Geraet und Inode eines Pfads, oder der `errno`-Text fuer `detail`.
 *
 * Drei Aufrufstellen (Dienstwurzel, PID-Wurzel, Kandidaten im Baum), und der
 * `errno`-Text muss ueberall dieselbe Form haben — deshalb eine Funktion und
 * kein dreimal abgeschriebener `try`/`catch`.
 */
function identityOf(path: string): { dev: number; ino: number } | { error: string } {
  try {
    const stat = statSync(path);
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    return { error: `${path} (${code})` };
  }
}

/**
 * Die Kinder eines Prozesses aus `/proc/<pid>/task/<tid>/children`.
 *
 * Fehlt die Datei (aelterer Kernel ohne `CONFIG_PROC_CHILDREN`), liefert sie
 * `[]` — dann traegt der ppid-Scan aus `childPidsByParentScan`. Ein stilles
 * "keine Kinder" waere hier fatal: jeder echte Worker-Start saehe dann wie ein
 * Wrapper aus.
 */
function childPidsFromProc(pid: number, procDir: string): number[] {
  const children: number[] = [];
  let threads: string[];
  try {
    threads = readdirSync(join(procDir, String(pid), "task"));
  } catch {
    return children;
  }
  for (const thread of threads) {
    let raw: string;
    try {
      raw = readFileSync(join(procDir, String(pid), "task", thread, "children"), "utf8");
    } catch {
      continue;
    }
    for (const field of raw.split(/\s+/)) {
      if (field.length === 0) continue;
      const child = Number(field);
      if (Number.isInteger(child) && child > 0) children.push(child);
    }
  }
  return children;
}

/** Alle Kinder aller Prozesse, aus dem `ppid`-Feld von `/proc/<pid>/stat`. */
function childPidsByParentScan(procDir: string): Map<number, number[]> {
  const byParent = new Map<number, number[]>();
  let entries: string[];
  try {
    entries = readdirSync(procDir);
  } catch {
    return byParent;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let raw: string;
    try {
      raw = readFileSync(join(procDir, entry, "stat"), "utf8");
    } catch {
      continue;
    }
    // `comm` steht in Klammern und darf Leerzeichen und Klammern enthalten;
    // deshalb wird hinter der **letzten** schliessenden Klammer gesplittet.
    const close = raw.lastIndexOf(")");
    if (close === -1) continue;
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    // fields[0] = state, fields[1] = ppid.
    const ppid = Number(fields[1]);
    if (!Number.isInteger(ppid) || ppid < 0) continue;
    const list = byParent.get(ppid) ?? [];
    list.push(Number(entry));
    byParent.set(ppid, list);
  }
  return byParent;
}

/**
 * Der erste Prozess im Baum ab `pid` (inklusive `pid` selbst), der eine andere
 * Wurzel sieht als der Dienst — also der Prozess, der wirklich in der neuen
 * Mount-Namespace steht.
 */
function findNamespacedPid(
  pid: number,
  procDir: string,
  serviceRoot: { dev: number; ino: number },
): { pid: number; dev: number; ino: number } | { error: string } {
  const directChildren = childPidsFromProc(pid, procDir);
  // Der ppid-Scan ist die Rueckfallebene fuer Kernel ohne `children`-Datei. Er
  // wird erst gebaut, wenn der direkte Weg leer bleibt: sonst waere jede Probe
  // ein Durchlauf ueber die ganze Prozesstabelle.
  let byParent: Map<number, number[]> | null = null;
  const childrenOf = (parent: number): number[] => {
    const direct = parent === pid ? directChildren : childPidsFromProc(parent, procDir);
    if (direct.length > 0) return direct;
    byParent ??= childPidsByParentScan(procDir);
    return byParent.get(parent) ?? [];
  };

  const queue: Array<{ pid: number; depth: number }> = [{ pid, depth: 0 }];
  const seen = new Set<number>();
  let firstError: string | null = null;
  while (queue.length > 0 && seen.size < MAX_CANDIDATES) {
    const current = queue.shift()!;
    if (seen.has(current.pid)) continue;
    seen.add(current.pid);
    const identity = identityOf(join(procDir, String(current.pid), "root"));
    if ("error" in identity) {
      firstError ??= identity.error;
    } else if (identity.dev !== serviceRoot.dev || identity.ino !== serviceRoot.ino) {
      return { pid: current.pid, dev: identity.dev, ino: identity.ino };
    }
    if (current.depth >= MAX_DEPTH) continue;
    for (const child of childrenOf(current.pid)) {
      queue.push({ pid: child, depth: current.depth + 1 });
    }
  }
  return { error: firstError ?? "shared" };
}

/**
 * Misst, ob `pid` (oder ein Nachfahre) in einer eigenen Mount-Namespace steht
 * und dort genau das Gast-Home `username` sieht.
 *
 * Alle Fehlerpfade liefern `ok: false` mit einem kurzen, sachlichen `detail`
 * (welcher Pfad, welcher `errno`); die Funktion wirft nie.
 */
export function probeWorkerNamespace(
  pid: number,
  username: string,
  opts: { root?: string } = {},
): WorkerNamespaceProbeResult {
  try {
    if (!Number.isInteger(pid) || pid <= 0) {
      return { ok: false, detail: `PID ${String(pid)} is not a positive integer, so there is no process to probe.` };
    }
    const root = opts.root ?? "/";
    const procDir = join(root, "proc");
    const serviceUser = userInfo().username;

    const serviceRoot = identityOf(root);
    if ("error" in serviceRoot) {
      return { ok: false, detail: `Cannot stat the service root: ${serviceRoot.error}.` };
    }
    const pidRootPath = join(procDir, String(pid), "root");
    const pidRoot = identityOf(pidRootPath);
    if ("error" in pidRoot) {
      return { ok: false, detail: `Cannot stat ${pidRoot.error}; the worker process is gone.` };
    }

    // Was unter `/home` in der Sicht dieses Prozesses liegt, als Text fuer
    // `detail`. Eine unlesbare Liste ist selbst ein Befund und keine Ausnahme.
    const listingOf = (path: string): string => {
      try {
        return JSON.stringify(readdirSync(path).sort());
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
        return `unreadable (${code})`;
      }
    };

    const namespaced = findNamespacedPid(pid, procDir, serviceRoot);
    if ("error" in namespaced) {
      // Genau der Defekt: eine gemeldete PID, aber keine eigene Namespace. Der
      // Befund nennt beide Wurzelpaare und das, was unter `/home` steht — damit
      // sind "geteilter Wurzelbaum" und "Host-Home sichtbar" in einer Zeile
      // belegt.
      const homePath = join(pidRootPath, "home");
      return {
        ok: false,
        detail:
          `PID ${pid} is not in a mount namespace of its own: ${pidRootPath} has device ${pidRoot.dev} inode ${pidRoot.ino}, `
          + `identical to ${root} (device ${serviceRoot.dev} inode ${serviceRoot.ino}), and ${homePath} lists ${listingOf(homePath)}`
          + `${username === serviceUser ? "" : ` — the service home "${serviceUser}" is visible`}`
          + `${namespaced.error === "shared" ? "" : ` (${namespaced.error})`}.`,
      };
    }

    const target = namespaced.pid;
    const homePath = join(procDir, String(target), "root", "home");
    let entries: string[];
    try {
      const stat = statSync(homePath);
      if (!stat.isDirectory()) {
        return { ok: false, detail: `${homePath} is not a directory (mode ${(stat.mode & 0o7777).toString(8)}).` };
      }
      entries = readdirSync(homePath).sort();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
      return {
        ok: false,
        detail: `Cannot read ${homePath} (${code}); PID ${target} has its own root (device ${namespaced.dev} inode ${namespaced.ino}), but the guest home cannot be verified.`,
      };
    }

    // Die ganze Zusage: genau ein Eintrag, und er ist der Mandant. Ein leerer
    // Eintrag hiesse "gar kein Home gebunden", ein zweiter "noch etwas
    // sichtbar" — beides ist keine Grenze um *diesen* Mandanten.
    const unexpected = entries.filter((entry) => entry !== username);
    if (unexpected.includes(serviceUser)) {
      return {
        ok: false,
        detail: `${homePath} contains the service home "${serviceUser}"; PID ${target} sees the host /home, not the tenant's mount namespace.`,
      };
    }
    if (unexpected.length > 0) {
      return {
        ok: false,
        detail: `${homePath} lists ${JSON.stringify(entries)}; expected exactly ["${username}"], so ${JSON.stringify(unexpected)} should not be visible.`,
      };
    }
    if (entries.length === 0) {
      return {
        ok: false,
        detail: `${homePath} is empty; the guest home "${username}" is not bound, so the boundary is not enforced.`,
      };
    }
    return { ok: true };
  } catch (error) {
    // Kein Pfad oben darf werfen; falls doch, ist der Befund die Meldung statt
    // einer Ausnahme im Worker-Start.
    return { ok: false, detail: `The namespace probe for PID ${pid} failed: ${String(error)}` };
  }
}
