import { randomUUID } from "crypto";
import os from "os";
import path from "path";
import type { Subprocess } from "bun";
import { buildTerminalEnv, planSandboxSpawn, type SandboxFailureReason } from "./sandbox";
import { getUserHome } from "./request-identity";
import { childEnv } from "./runtime-secrets";
import { secretMaskFiles } from "./secret-mask";

export type TerminalStatus = "running" | "exited";

export interface TerminalInfo {
  id: string;
  cwd: string;
  pid: number;
  status: TerminalStatus;
  exitCode: number | null;
  shell: string;
  cols: number;
  rows: number;
  createdAt: number;
  lastActivityAt: number;
  /**
   * Der angemeldete Benutzername, der die Shell gestartet hat.
   *
   * Teil des `TerminalInfo` und nicht nur des internen Records, weil die
   * Route sie serialisiert und ein Besitz-Filter dann an einem Feld haengt,
   * das in beiden Formen dasselbe ist.
   */
  owner: string;
  /**
   * Laeuft die Shell wirklich in einer Sandbox?
   *
   * Teil der oeffentlichen Form, weil "isoliert" eine Behauptung ist, die
   * jemand pruefen koennen muss: auf einem Host ohne `bwrap` ist das `false`,
   * und das gehoert sichtbar in die Antwort, statt in einem Kommentar im
   * Modul zu stehen, den niemand liest, wenn er die Shell benutzt.
   */
  sandboxed: boolean;
}

interface TerminalRecord {
  info: TerminalInfo;
  child: Subprocess;
  streams: Set<WritableStreamDefaultWriter<Uint8Array>>;
  /** Every byte the PTY produced, bounded — replay for the next client. */
  history: TerminalReplayBuffer;
}

/**
 * Besitzer einer Shell.
 *
 * Pflichtargument, kein Default: eine Shell ohne Konto haette kein Home und
 * damit nichts zu isolieren — die alte Fassung oeffnete sie unconfined.
 */

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Replay-Budget pro Shell, in Bytes.
 *
 * Bytes, nicht Zeilen: eine eingefuegte Zeile kann Megabyte lang sein, eine
 * Zeilengrenze wuerde also den Speicher nicht begrenzen — und die Leitung
 * transportiert ohnehin Bytes. 256 KiB sind bei 80 Spalten rund 3 200 Zeilen,
 * mehr als ein Vollbild-Repaint von `htop`/`vim` und vergleichbar mit xterms
 * eigenem 5000-Zeilen-Scrollback.
 */
export const MAX_REPLAY_BYTES = 256 * 1024;

/**
 * Der Schwanz der PTY-Ausgabe, begrenzt und in Reihenfolge.
 *
 * `append` haelt die Bytes als Chunks und wirft die aeltesten zuerst weg; ein
 * einzelner Chunk, der groesser als das Budget ist, bleibt als sein eigener
 * Schwanz stehen. Ein eigener Typ statt einer Liste im Record, weil die Grenze
 * ohne Prozess testbar sein muss.
 */
export class TerminalReplayBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly limit: number = MAX_REPLAY_BYTES) {}

  append(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.limit && this.chunks.length > 0) {
      const overflow = this.bytes - this.limit;
      const oldest = this.chunks[0]!;
      if (oldest.length <= overflow) {
        this.chunks.shift();
        this.bytes -= oldest.length;
      } else {
        // `subarray` teilt den Speicher mit dem Original; der Rest des Chunks
        // bleibt hoechstens eine Chunk-Groesse langreferenziert.
        this.chunks[0] = oldest.subarray(overflow);
        this.bytes -= overflow;
      }
    }
  }

  /** Aeltestes zuerst. */
  snapshot(): readonly Buffer[] {
    return this.chunks;
  }
}

/** Dieselbe Form, die `validateAccountName` in `bin/web-auth-store.js` zulaesst. */
const SHELL_SAFE_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;

/**
 * Ist die Shell verweigert worden, weil keine Sandbox moeglich ist?
 *
 * Fuer einen Mandanten ist "keine Sandbox" keine Warnung mehr, sondern eine
 * Absage: die alte Fassung oeffnete stattdessen eine unconfined Shell mit der
 * vollen Dienstumgebung (`SHELL-ISOLATION-SCAN.md` §2, dreifach gemessen).
 * Die Route antwortet damit 503 und nennt `remediation`; der Status 500 ist
 * danach echte Serverfehler.
 */
export class TerminalUnavailableError extends Error {
  readonly reason: SandboxFailureReason | "unsupported-platform";

  constructor(reason: SandboxFailureReason, detail: string, readonly remediation: string) {
    super(`Shell unavailable on this host: ${detail} ${remediation}`.trim());
    this.name = "TerminalUnavailableError";
    this.reason = reason;
  }
}

declare global {
  // Stored on globalThis so Next.js hot-reload in dev mode does not wipe
  // existing child processes (each module reload otherwise restarts the
  // manager and leaves orphan shells behind).
  var __ompTerminalManager: TerminalManager | undefined;
}

export class TerminalManager {
  private terminals = new Map<string, TerminalRecord>();
  private idleTimer: NodeJS.Timeout | null = null;

  constructor() {
    if (!globalThis.__ompTerminalManager) {
      globalThis.__ompTerminalManager = this;
      const exitHandler = () => this.killAll();
      process.once("SIGTERM", exitHandler);
      process.once("SIGINT", exitHandler);
      process.once("exit", exitHandler);
    }
    this.scheduleIdleSweep();
    return globalThis.__ompTerminalManager!;
  }

  private scheduleIdleSweep(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, record] of this.terminals) {
        if (record.info.status !== "running") continue;
        if (now - record.info.lastActivityAt > IDLE_TIMEOUT_MS) {
          console.warn(`[terminal] killing idle session ${id}`);
          this.kill(id).catch(() => undefined);
        }
      }
    }, 60 * 1000);
    this.idleTimer.unref?.();
  }

  // Spawn a real PTY-backed shell via `script(1)`. `@lydell/node-pty`,
  // `node-pty`, and Bun.Terminal are all unusable from a Bun server process
  // today (SIGHUP on spawn, no Linux prebuilds, or no readable stream),
  // but `script` is a standard Linux util that allocates a PTY for its child
  // and pipes the master side through stdin/stdout. That gives bash proper
  // line discipline, prompts that re-render on resize, and nested shells.
  //
  // The whole thing then runs inside a `bwrap` user namespace
  // (`lib/sandbox.ts`). The previous comment here said the absence of a
  // `uid`/`gid` switch was deliberate and left an open shell able to read
  // `/etc/shadow`. That was true, and it is the reason this is no longer a
  // plain `Bun.spawn`: the boundary is now enforced by the kernel, which
  // measured out as `sudo: no new privileges flag is set` and
  // `cat: /home/<other>: No such file or directory`.
  async spawn(cwd: string, cols: number, rows: number, owner: string, isAdmin = false): Promise<TerminalInfo> {
    // Der Kontoname landet in der Shell-Zeichenkette (siehe `USER=` unten).
    // Die Route bekommt ihn schon validiert, aber diese Klasse ist auch direkt
    // aufrufbar — eine Zeichenkette, die in ein `sh -c` geht, wird hier geprueft,
    // nicht dort, wo sie zufaellig herkommt.
    if (!SHELL_SAFE_NAME.test(owner)) {
      throw new TerminalUnavailableError(
        "bad-username",
        `${JSON.stringify(owner)} is not a usable account name for a shell.`,
        "Account names are [a-z_][a-z0-9_-]{0,31}; no other name can be put into a shell.",
      );
    }
    const isWindows = os.platform() === "win32";
    const shell = process.env.SHELL?.trim() || (isWindows ? "powershell.exe" : "bash");
    const id = randomUUID();
    const startedAt = Date.now();

    let cmd: string[];
    if (isWindows) {
      cmd = [shell];
    } else {
      // `script -qfc <cmd> /dev/null` runs <cmd> in a fresh PTY with the
      // typescript log discarded. The inner PS1 prints a one-line banner so
      // the user sees immediate feedback that the terminal is alive.
      //
      // No `$PWD`, `$$` or `export PS1` in the argument any more. Nicht, weil
      // eine Namespace sie verbieten wuerde — er braucht keines von beidem.
      // Der Grund ist die `sudoers`-Nebenstelle weiter oben: eine Regel dort
      // kann einen interpolierten String nicht matchen, das Argument muss also
      // statisch bleiben. Was der Banner anzeigt, ist der Grund fuer die
      // Einschraenkung, nicht ihre Ursache.
      // `USER`/`LOGNAME` muessen **hinter** `script` wieder gesetzt werden:
      // util-linux' `script` ueberschreibt `USER` aus dem passwd-Eintrag der
      // aufrufenden uid (gemessen: `--setenv USER=omp` kam als `USER=steimer`
      // in der Shell an, `LOGNAME` blieb richtig). Ohne das zeigt die Shell den
      // Dienstbenutzer an, obwohl `HOME` schon das Konto ist.
      // `$0` ist unter `script -qfc … /dev/null` leer (gemessen: `0=`), also
      // druckt der Banner den aufgeloesten Shell-Namen als Literal. Nur
      // [A-Za-z0-9._-] ueberlebt, damit kein Anfuehrungszeichen das `sh -c`
      // aufbricht. Die Groesse fehlt bewusst: sie waere die Spawn-Groesse, und
      // die ist nach dem ersten Resize des Clients falsch — eine Angabe, die
      // luegt, ist schlechter als keine.
      //
      // `stty cols/rows` setzt die echte Winsize der PTY. Ohne das steht sie
      // auf `0 0` (gemessen) und nur `COLUMNS`/`LINES` tragen die Groesse —
      // bash respektiert das, `vim`/`htop` lesen aber den ioctl und tun es
      // nicht. `stty` fehlt auf keinem System mit `script(1)`; falls doch,
      // bleibt es beim alten Verhalten.
      const shellLabel = path.basename(shell).replace(/[^A-Za-z0-9._-]/g, "") || "shell";
      const inner = `stty cols ${cols} rows ${rows} 2>/dev/null; printf '\\033[36m[omp-web terminal]\\033[0m ready in %s (shell=%s)\\n' "$PWD" '${shellLabel}'; USER=${owner} LOGNAME=${owner} exec ${shell} -i`;
      cmd = ["/usr/bin/script", "-qfc", inner, "/dev/null"];
    }

    // Die Umgebung ist eine allow-gelistete Menge, nicht `process.env` mit einem
    // `delete`. Der Unterschied ist gemessen: ein `delete` wirkt nur auf die
    // Kopie, nicht auf das, was im Prozess steht, und der alte Fallback-Zweig hat
    // `OMP_WEB_PASSWORD` gleich mit durchgereicht.
    //
    // Auf Windows ist die Allow-Liste die falsche Form: `powershell.exe` braucht
    // `SystemRoot` und `PATHEXT`, und dort gibt es ohnehin keine Sandbox (siehe
    // `unsupported-platform` in `lib/sandbox.ts`). Also die gescrubbte
    // Prozessumgebung — dieselbe Grenze wie `git`/`du`, nur ohne die
    // Geheimnis-Namen.
    const env: Record<string, string> = isWindows
      ? (childEnv() as Record<string, string>)
      : {
        ...buildTerminalEnv(),
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        COLUMNS: String(cols),
        LINES: String(rows),
      };

    // Ein Konto ohne Shell-Sandbox bekommt keine Shell. Windows hat keine
    // User-Namespaces (siehe `unsupported-platform` in `lib/sandbox.ts`), und
    // die alte Bedingung `!isWindows` hat dort jeden Mandanten unconfined
    // durchgelassen — mit `sandboxed: false`, also genau dem Zustand, den die
    // API sonst nicht mehr ausgibt.
    if (isWindows && !isAdmin) {
      throw new TerminalUnavailableError(
        "unsupported-platform",
        "This host has no user namespaces, so a tenant shell cannot be sandboxed.",
        "Run omp-web on Linux with bubblewrap, or open the terminal as an admin (sandboxed: false).",
      );
    }

    let sandboxed = false;
    if (!isWindows && !isAdmin) {
      // Genau ein Aufruf beantwortet alle Absagegruende: fehlendes `bwrap`,
      // abgeschaltete User-Namespaces, fehlendes Home, cwd ausserhalb des
      // Homes, unbrauchbarer Kontoname. Vorher stand hier ein `console.warn`
      // und die Shell lief unconfined weiter — dreifach fail-open gemessen.
      const plan = planSandboxSpawn({
        home: getUserHome({ username: owner, isAdmin: false }),
        username: owner,
        command: cmd,
        cwd,
        env,
        // Alles, was der Dienst an Geheimnissen auf der Platte haelt. `/etc` ist
        // als Ganzes readonly gebunden (eine Shell ohne `/etc/passwd` ist keine),
        // also waere die Geheimnisdatei darin fuer den Mandanten lesbar — die
        // Namespace aendert die uid nicht, und die Datei gehoert dem
        // Dienstbenutzer. Ohne diese Liste waere die Umgebung sauber und der
        // Weg zum Admin-Passwort offen (`cat /etc/omp-web.env`).
        maskFiles: secretMaskFiles(),
      });
      if (!plan.ok) {
        throw new TerminalUnavailableError(plan.reason, plan.detail, plan.remediation);
      }
      cmd = plan.argv;
      sandboxed = true;
    }
    // Der Admin-Zweig ist eine Entscheidung, kein Versehen: ein Admin ist der
    // Host, sein Home ist `/`, und eine Sandbox um `/` waere die ganze Platte.
    // `sandboxed: false` in der Antwort sagt es, und `TerminalInfo` fuehrt den
    // Schluessel immer. Die Umgebung ist trotzdem die allow-gelistete, also
    // sieht auch er nur PATH/HOME/LANG und nicht die Unit.

    const child = Bun.spawn({
      cmd,
      cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const info: TerminalInfo = {
      id,
      cwd,
      pid: child.pid,
      status: "running",
      exitCode: null,
      shell,
      cols,
      rows,
      createdAt: startedAt,
      lastActivityAt: startedAt,
      owner,
      sandboxed,
    };

    const record: TerminalRecord = {
      info,
      child,
      streams: new Set(),
      history: new TerminalReplayBuffer(),
    };
    this.terminals.set(id, record);

    const pipeOutput = async (stream: ReadableStream<Uint8Array>) => {
      try {
        const reader = stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          record.info.lastActivityAt = Date.now();
          const chunk = Buffer.from(value);
          // Auch ohne Zuschauer mitschreiben: der naechste Client bekommt
          // diese Bytes als Replay. stdout und stderr teilen sich einen
          // Puffer, damit ihre Reihenfolge zueinander erhalten bleibt.
          record.history.append(chunk);
          for (const writer of record.streams) this.safeWrite(writer, chunk);
        }
      } catch {
        // Stream closed; ignore.
      }
    };

    void pipeOutput(child.stdout);
    void pipeOutput(child.stderr);

    child.exited.then((exitCode) => {
      record.info.status = "exited";
      record.info.exitCode = exitCode;
      record.info.lastActivityAt = Date.now();
      this.closeStreams(record);
    });

    return info;
  }

  list(): TerminalInfo[] {
    return Array.from(this.terminals.values())
      .map((r) => r.info)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Nur die Shells, die `username` gestartet hat. */
  listOwnedBy(username: string): TerminalInfo[] {
    return this.list().filter((info) => info.owner === username);
  }

  /** Alle Shells — nur fuer einen Admin, der Entschreiber im Filter. */
  listAll(): TerminalInfo[] {
    return this.list();
  }

  get(id: string): TerminalInfo | null {
    return this.terminals.get(id)?.info ?? null;
  }

  /**
   * Besitzt `username` diese Shell?
   *
   * Der Admin-Zweig bleibt bewusst aussen: die Route entscheidet vor dem Aufruf,
   * ob sie den Adminpfad nimmt, damit es an genau einer Stelle steht. Hier
   * zaehlt nur Gleichheit, und ein Leerstring-Besitz passt zu keinem Namen.
   */
  isOwnedBy(id: string, username: string): boolean {
    return this.terminals.get(id)?.info.owner === username;
  }

  async write(id: string, data: string): Promise<void> {
    const record = this.requireRecord(id);
    if (record.info.status !== "running") {
      throw new Error(`Terminal ${id} has exited`);
    }
    const stdin = record.child.stdin as unknown as WritableStreamDefaultWriter<Uint8Array>;
    await stdin.write(new TextEncoder().encode(data));
    record.info.lastActivityAt = Date.now();
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    if (cols < 2 || rows < 1) throw new Error("Invalid terminal size");
    // `script(1)` haelt die PTY-Master-Seite; dieser Prozess hat kein Handle,
    // auf dem ein TIOCSWINSZ ein SIGWINCH beim Kind ausloesen koennte. Die
    // Werte werden fuer die UI gemerkt (GET und `connected` melden, was der
    // Client angefordert hat); die echte Winsize setzt `stty` beim Spawn
    // (siehe `spawn`), also gilt die Spawn-Groesse fuer alle PTY-Programme.
    const record = this.terminals.get(id);
    if (!record) return;
    record.info.cols = cols;
    record.info.rows = rows;
  }

  async kill(id: string): Promise<void> {
    const record = this.terminals.get(id);
    if (!record) return;
    if (record.info.status === "running") {
      try { record.child.kill(); } catch { /* may have already exited */ }
    }
    // Vor dem Loeschen, damit die Route den echten Exit-Code noch lesen kann.
    this.closeStreams(record);
    this.terminals.delete(id);
  }

  /**
   * Beendet jeden angehaengten Strom: die letzte Meldung als Ausgabe, dann
   * `close()` — die Route antwortet darauf mit `event: exit` und schliesst SSE.
   */
  private closeStreams(record: TerminalRecord): void {
    const exitCode = record.info.exitCode ?? -1;
    const exitMsg = Buffer.from(
      `\n[Process exited with code ${exitCode}]\n`,
      "utf-8",
    );
    for (const writer of record.streams) {
      this.safeWrite(writer, exitMsg);
      try { writer.close().catch(() => undefined); } catch { /* ignore */ }
    }
    record.streams.clear();
  }

  private killAll(): void {
    for (const id of Array.from(this.terminals.keys())) {
      try { this.kill(id); } catch { /* ignore */ }
    }
  }

  attach(id: string, writer: WritableStreamDefaultWriter<Uint8Array>): () => void {
    const record = this.requireRecord(id);
    // Erst der Verlauf, dann live: `pipeOutput` schreibt die History und die
    // angeschlossenen Stroeme im selben synchronen Block, es gibt also keinen
    // Zeitpunkt zwischen beiden, an dem ein Chunk doppelt oder gar nicht
    // ankaeme. Deshalb wird die History hier geflusht und nicht in der Route
    // separat gelesen — das waere ein zweiter Zeitpunkt mit Luecke.
    for (const chunk of record.history.snapshot()) this.safeWrite(writer, chunk);
    record.streams.add(writer);
    return () => {
      record.streams.delete(writer);
    };
  }

  private requireRecord(id: string): TerminalRecord {
    const record = this.terminals.get(id);
    if (!record) throw new Error(`Unknown terminal session: ${id}`);
    return record;
  }

  private safeWrite(writer: WritableStreamDefaultWriter<Uint8Array>, data: Buffer): void {
    try {
      writer.write(new Uint8Array(data)).catch(() => {
        // Client disconnected.
      });
    } catch {
      // Stream closed.
    }
  }
}

let _manager: TerminalManager | null = null;
export function getTerminalManager(): TerminalManager {
  if (!_manager) _manager = new TerminalManager();
  return _manager;
}

export function resolveDefaultShellCwd(cwd: string): string {
  return path.isAbsolute(cwd) ? cwd : process.cwd();
}
