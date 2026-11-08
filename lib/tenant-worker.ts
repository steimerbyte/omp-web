import { existsSync } from "node:fs";
import { join } from "node:path";
import { RpcClient, type RpcAgentProcess } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { planSandboxSpawn, type SandboxFailure, type SandboxPlan } from "./sandbox";
import { secretMaskFiles } from "./secret-mask";
import { getUserHome, type WebIdentity } from "./request-identity";
import { prepareTenantSessionDir } from "./tenant-sessions";
import {
  DEFAULT_WORKER_MAX,
  allowUnsandboxedTenant,
  buildWorkerEnv,
  isTenantWorkerIdentity,
  resolveWorkerIdleMs,
  resolveWorkerMax,
  workerGuestPaths,
  type TenantWorkerFailure,
} from "./tenant-worker-config";

/**
 * Ein Worker-Prozess pro Mandant — die eigentliche Grenze.
 *
 * ### Warum ein Prozess und nicht ein Werkzeug-Haken
 *
 * Der `bash` des Agenten ist eine **native Bibliothek im Prozess**
 * (`node_modules/@oh-my-pi/pi-coding-agent/src/exec/bash-executor.ts:701-706`,
 * `new Shell(...)` aus `@oh-my-pi/pi-natives`), und `read`/`write`/`edit` sind
 * `fs`-Aufrufe im selben Prozess. Es gibt also kein Kind, um das man `bwrap`
 * legen koennte, und `delete process.env.X` wirkt nicht (siehe
 * `lib/runtime-secrets.ts`). Die Grenze kann nur um **den Prozess** gebaut
 * werden, der die Session hostet — genau das macht diese Datei.
 *
 * ### Warum es keinen eigenen Session-Host gibt
 *
 * Das SDK kann es schon: `--mode rpc` (`src/cli/flag-tables.ts:136-144`,
 * Dispatch `src/main.ts:2802-2812`) startet eine headless Session mit
 * JSON-stdin/stdout, dokumentiert als "used for embedding the agent in other
 * applications" (`src/modes/rpc/rpc-mode.ts:1-12`). Ein nachgebauter Host waere
 * eine zweite Implementierung des Protokolls und damit eine zweite Wahrheit
 * ueber jede Frame-Form. Der Client ist ebenfalls da (`RpcClient`) und nimmt
 * einen fertigen argv ueber `command`.
 *
 * ### Gemessen auf diesem Host (2026-11-08, agent-pc, LXC 101)
 *
 * | Groesse | Wert |
 * |---|---|
 * | `ready` nach dem Start | 1030–1034 ms |
 * | RSS des Baums (bwrap-Leader + Kind + Worker) | 288 MB bei `ready`, 295 MB nach 3 s Ruhe |
 * | Nicht-JSON-Zeilen auf stdout | 0 |
 * | Exit nach stdin-EOF | 0 |
 * | Grenze innen: `ls /home/pi` | `No such file or directory` |
 * | Grenze innen: `env` | 6 Schluessel (Allowlist) |
 * | Grenze innen: `/proc` | 4 PIDs |
 *
 * Sechs Kerne binden vor 12 GiB: deshalb ist die Obergrenze 4 Worker
 * (`OMP_WEB_TENANT_WORKER_MAX`), nicht 20.
 */

/** Was ein gestarteter Worker ist: Prozess plus Client plus Grenzmetadaten. */
export interface TenantWorker {
  username: string;
  /** PID des bwrap-Leaders. `undefined`, wenn der Spawn ihn nicht meldet. */
  pid: number | undefined;
  /** `false` nur unter `OMP_WEB_ALLOW_UNSANDBOXED_TENANT=1`. */
  enforced: boolean;
  client: RpcClient;
  startedAt: number;
  /** Die Grenzmetadaten fuer die Session-Info. */
  boundary: TenantWorkerBoundary;
  stop(): Promise<void>;
}

/** Was die Session-Info ueber die Grenze sagt — nie mehr, als gemessen ist. */
export interface TenantWorkerBoundary {
  kind: "tenant-worker";
  enforced: boolean;
  pid?: number;
}

export interface TenantWorkerPlanOk {
  ok: true;
  plan: SandboxPlan;
  guest: WorkerGuestPaths;
  /** Der fertige argv: `bwrap … -- bun … --mode rpc …`. */
  argv: string[];
  env: Record<string, string>;
}

/** Die Gast-Seite eines Workers. */
export interface WorkerGuestPaths {
  guestHome: string;
  guestBun: string;
  guestNodeModules: string;
  guestCli: string;
  guestSessions: string;
  guestCwd: string;
}

export interface TenantWorkerOptions {
  bunPath: string;
  repoRoot: string;
  providers?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** Fuer Tests: zusaetzliche Argumente hinter `--session-dir`. */
  extraArgs?: string[];
  startTimeoutMs?: number;
}

/**
 * Der Plan fuer den Worker eines Kontos.
 *
 * Der Befehl ist der argv aus Plan §7 L1 mit zwei zusaetzlichen `--ro-bind`
 * (das `bun`-Binaerprogramm und die `node_modules` des Repos), beide in das
 * Gast-Home.
 *
 * Warum die beiden Binds noetig sind, ist gemessen: `bun` liegt unter
 * `/home/pi`, das die Grenze absichtlich nicht bindet — ohne den Bind gibt
 * `command -v bun` nichts. Und `dist/cli.js` in das Home zu **kopieren**
 * scheitert, weil das Buendel seine `node_modules`-Geschwister braucht
 * (`Cannot find module '@oh-my-pi/pi-natives'`).
 */
export function planTenantWorker(
  identity: WebIdentity,
  options: TenantWorkerOptions,
): TenantWorkerPlanOk | TenantWorkerFailure {
  const env = options.env ?? process.env;
  const guest = workerGuestPaths(identity) as WorkerGuestPaths;
  const hostHome = getUserHome(identity, env);

  if (!existsSync(hostHome)) {
    return {
      ok: false,
      reason: "boundary-unavailable",
      detail: `The tenant home ${hostHome} does not exist, so there is nothing to bind.`,
      remediation: "Create the account (POST /api/accounts) before the first agent request.",
    };
  }
  const nodeModules = join(options.repoRoot, "node_modules");
  const sdkDir = join(nodeModules, "@oh-my-pi", "pi-coding-agent");
  if (!existsSync(join(sdkDir, "dist", "cli.js"))) {
    return {
      ok: false,
      reason: "boundary-unavailable",
      detail: `The SDK CLI entry ${join(sdkDir, "dist", "cli.js")} does not exist; the worker cannot be started.`,
      remediation: "Run `bun install` in the installation directory, or point the service at the right repo root.",
    };
  }
  if (!existsSync(options.bunPath)) {
    return {
      ok: false,
      reason: "boundary-unavailable",
      detail: `The Bun binary ${options.bunPath} does not exist.`,
      remediation: "Install Bun (https://bun.sh) or set OMP_WEB_BUN to its path.",
    };
  }

  // Das Session-Verzeichnis des Mandanten anlegen, bevor der Worker startet:
  // sonst legt es das SDK mit der umask des Workers an, und der Pfad waere
  // 0755 statt 0700.
  prepareTenantSessionDir(identity, hostHome);

  const workerEnv = buildWorkerEnv(identity, options.providers ?? [], env);
  const plan = planSandboxSpawn({
    home: hostHome,
    username: identity.username,
    cwd: hostHome,
    env: workerEnv.env,
    // Dieselben vier Dateien wie im Terminal: der Worker laeuft in der Grenze,
    // also muss auch er sie nicht sehen. Seine eigenen Zugangsdaten stehen in
    // seiner Umgebung bzw. seinem `models.yml` im Gast-Home.
    maskFiles: secretMaskFiles(env),
    extraBinds: [
      [options.bunPath, guest.guestBun],
      [nodeModules, guest.guestNodeModules],
    ],
    command: [
      // `umask 077` vor dem Worker, nicht danach aufraeumen.
      //
      // Gemessen (2026-11-08, Scratch-Server): der Worker erbte die umask 022
      // des Dienstes, und `agent.db-shm`, `agent.db-wal` und das
      // Session-`.jsonl` kamen mit **0644** heraus — weltlesbar, obwohl das
      // Verzeichnis 0700 ist. Ein `chmod` nach dem Schreiben ist ein Rennen:
      // die WAL-Datei wird waehrend der Laufzeit neu angelegt. Die umask gilt
      // fuer jeden `open(O_CREAT)` des Prozesses und schliesst das Fenster.
      "/bin/sh", "-c",
      `umask 077; exec "$0" "$@"`,
      guest.guestBun,
      guest.guestCli,
      "--mode", "rpc",
      // Keine Extension-UI-Frames: der Worker hat keinen Bediener.
      "--no-ui",
      // Ohne dieses Flag macht `maybeAutoChdir` aus dem Startverzeichnis
      // `$HOME` ein `/tmp`: `src/cli/startup-cwd.ts:11-42` behandelt "startet im
      // Home" als "der Benutzer wollte ein Projekt, nicht sein Home" und zieht
      // nach `<home>/tmp`, `/tmp` oder `/var/tmp` um. Gemessen: `pwd` im Worker
      // war `/tmp`, obwohl bwrap `--chdir /home/<name>` setzt — jeder relative
      // Pfad des Agenten landete damit in einem geteilten, welt-beschreibbaren
      // Verzeichnis statt im Mandanten-Home. `--allow-home` ist der
      // dokumentierte Ausweg desselben Codes.
      "--allow-home",
      "--session-dir", guest.guestSessions,
      ...(options.extraArgs ?? []),
    ],
  });
  if (!plan.ok) return plan;
  return { ok: true, plan, guest, argv: plan.argv, env: workerEnv.env };
}

/**
 * Ein Worker fuer ein Konto, gestartet und bis `ready` gefahren.
 *
 * Der Transport ist ein `Bun.spawn` des **kompletten** Plan-argv, also mit
 * `bwrap` an Position 0. `RpcClient.spawn` ist genau dafuer da ("Spawn the RPC
 * agent over a custom transport instead of a local child process") und ist der
 * einzige Weg, den argv ohne Umbau zu starten: `command` haengt seine eigenen
 * `--mode rpc`-Argumente an, `spawn` bekommt sie nur zur Information.
 *
 * `pid` ist der Leader (bwrap), nicht der innere Bun: der Leader ist der
 * Prozess, den ein `kill` beenden muss, damit die Namespace mitgeht.
 */
export async function startTenantWorker(
  identity: WebIdentity,
  options: TenantWorkerOptions,
): Promise<TenantWorker | TenantWorkerFailure> {
  const planned = planTenantWorker(identity, options);
  if (!planned.ok) return planned;

  const argv = planned.argv;
  const spawnRef: { pid: number | undefined } = { pid: undefined };
  const client = new RpcClient({
    spawn: (agentArgs: string[]): RpcAgentProcess => {
      // `RpcClient` baut seinen eigenen argv (`--mode rpc`, `--provider`, …) und
      // reicht ihn hier herein. Der Plan-argv ist bereits vollstaendig — also
      // wird geprueft, dass der Client nichts Verwirrendes verlangt, und
      // ansonsten genau der Plan-argv gestartet. `--no-ui` und `--session-dir`
      // stehen im Plan, deshalb wird nichts angehaengt.
      const unexpected = agentArgs.filter((arg) => arg !== "--mode" && arg !== "rpc");
      if (unexpected.length > 0) {
        throw new Error(`RpcClient requested unexpected argument(s) for a fully-formed worker argv: ${unexpected.join(" ")}`);
      }
      const spawned = Bun.spawn({
        cmd: argv,
        env: { PATH: planned.env.PATH ?? "/usr/bin:/bin" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      spawnRef.pid = spawned.pid;
      const stderrChunks: string[] = [];
      void (async () => {
        const reader = (spawned.stderr as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            stderrChunks.push(decoder.decode(value, { stream: true }));
            if (stderrChunks.join("").length > 64_000) break;
          }
        } catch {
          // Der Prozess ist weg; der Exit-Pfad meldet das konkreter.
        } finally {
          reader.releaseLock();
        }
      })();
      const adapter: RpcAgentProcess = {
        stdin: {
          write(data: string | Uint8Array): unknown {
            return spawned.stdin.write(data);
          },
        },
        stdout: spawned.stdout as ReadableStream<Uint8Array>,
        peekStderr: () => stderrChunks.join(""),
        kill: (signal, graceMs) => {
          void (async () => {
            spawned.kill(signal as Parameters<Bun.Subprocess["kill"]>[0]);
            const timer = setTimeout(() => {
              spawned.kill("SIGKILL");
            }, graceMs ?? 1_000);
            timer.unref?.();
            await spawned.exited;
            clearTimeout(timer);
          })();
        },
        exited: spawned.exited as Promise<number>,
      };
      return adapter;
    },
  });

  const timeoutMs = options.startTimeoutMs ?? 30_000;
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    timeout.reject(new Error(`worker did not become ready within ${timeoutMs} ms`));
  }, timeoutMs);
  timer.unref?.();
  try {
    await Promise.race([client.start(), timeout.promise]);
  } catch (error) {
    await client.stop().catch(() => {});
    const stderr = client.getStderr().trim();
    return {
      ok: false,
      reason: /did not become ready/.test(String(error)) ? "tenant-worker-timeout" : "tenant-worker-spawn-failed",
      detail: `The tenant worker for ${identity.username} did not start: ${String(error)}${stderr ? ` (stderr: ${stderr.slice(0, 400)})` : ""}`,
      remediation: "Check that Bun, the SDK and the tenant's models.yml are readable inside the boundary, then retry.",
    };
  } finally {
    clearTimeout(timer);
  }

  const pid = spawnRef.pid;
  return {
    username: identity.username,
    pid,
    enforced: true,
    client,
    startedAt: Date.now(),
    // `enforced` nur mit lebendem Prozess — die Zusage aus §5/§8 des Plans: der
    // Server behauptet keine Isolation, die er nicht hat.
    boundary: pid === undefined
      ? { kind: "tenant-worker", enforced: false }
      : { kind: "tenant-worker", enforced: true, pid },
    async stop() {
      await client.stop().catch(() => {});
    },
  };
}

/**
 * Die Registry der laufenden Worker, einer pro Konto.
 *
 * Die Granularitaet ist der **Mandant**, nicht die Session: die Startkosten
 * (~1 s, ~290 MB) fallen einmal pro Konto an, nicht pro Chat. Der Registrierung
 * liegt ein `Promise` zugrunde, damit zwei gleichzeitige erste Requests nicht
 * zwei Worker starten.
 */
export interface TenantWorkerHost {
  max: number;
  idleMs: number;
  acquire(
    identity: WebIdentity,
    start: () => Promise<TenantWorker | TenantWorkerFailure>,
  ): Promise<TenantWorker | TenantWorkerFailure>;
  release(username: string): Promise<void>;
  /** Nur fuer Tests und Diagnose. */
  snapshot(): Array<{ username: string; pid: number | undefined; lastUsed: number }>;
  /** Setzt den Idle-Timer zurueck; wird bei jeder Anfrage gerufen. */
  touch(username: string): void;
}

interface WorkerSlot {
  worker: TenantWorker;
  timer: ReturnType<typeof setTimeout> | undefined;
  lastUsed: number;
}

export function createTenantWorkerHost(options: { max?: number; idleMs?: number } = {}): TenantWorkerHost {
  const max = options.max ?? resolveWorkerMax();
  const idleMs = options.idleMs ?? resolveWorkerIdleMs();
  const slots = new Map<string, WorkerSlot>();
  const starting = new Map<string, Promise<TenantWorker | TenantWorkerFailure>>();

  const evict = async (username: string): Promise<void> => {
    const slot = slots.get(username);
    if (!slot) return;
    slots.delete(username);
    clearTimeout(slot.timer);
    await slot.worker.stop();
  };

  const refuseCapacity = (): TenantWorkerFailure => ({
    ok: false,
    reason: "tenant-worker-capacity",
    detail: `All ${max} tenant worker slots are busy and none could be reaped.`,
    remediation: "Raise OMP_WEB_TENANT_WORKER_MAX, or lower OMP_WEB_TENANT_WORKER_IDLE_MS so idle workers are reaped sooner.",
  });

  const scheduleIdle = (username: string): void => {
    const slot = slots.get(username);
    if (!slot) return;
    clearTimeout(slot.timer);
    slot.lastUsed = Date.now();
    slot.timer = setTimeout(() => {
      // Der Timer laeuft ins Leere, wenn in der Zwischenzeit eine Anfrage kam:
      // dann hat `touch` ihn neu gesetzt und dieser hier ist veraltet.
      const current = slots.get(username);
      if (!current || Date.now() - current.lastUsed < idleMs) return;
      void evict(username);
    }, idleMs);
    slot.timer.unref?.();
  };

  return {
    max,
    idleMs,
    async acquire(identity, start) {
      const existing = slots.get(identity.username);
      if (existing) {
        scheduleIdle(identity.username);
        return existing.worker;
      }
      const inflight = starting.get(identity.username);
      if (inflight) return inflight;

      // Kapazitaet: der am laengsten unbenutzte Worker weicht, statt den neuen
      // Request scheitern zu lassen. Ein Konto, das gerade nichts tut, ist der
      // billigste Platz — ohne diese Regel waere die Grenze bei vier Konten ein
      // Dauerausfall des fuenften.
      if (slots.size >= max) {
        const victim = [...slots.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (victim) await evict(victim[0]);
      }
      if (slots.size >= max) return refuseCapacity();

      const promise = start().then(
        (result): TenantWorker | TenantWorkerFailure => {
          starting.delete(identity.username);
          if ("ok" in result && result.ok === false) return result;
          const worker = result as TenantWorker;
          slots.set(identity.username, { worker, timer: undefined, lastUsed: Date.now() });
          scheduleIdle(identity.username);
          return worker;
        },
        (error: unknown): TenantWorkerFailure => {
          starting.delete(identity.username);
          return {
            ok: false,
            reason: "tenant-worker-spawn-failed",
            detail: `The tenant worker for ${identity.username} could not be started: ${String(error)}`,
            remediation: "Check the service log for the boundary plan's reason, then retry the request.",
          };
        },
      );
      starting.set(identity.username, promise);
      return promise;
    },
    async release(username) {
      await evict(username);
    },
    snapshot() {
      return [...slots.entries()].map(([username, slot]) => ({
        username,
        pid: slot.worker.pid,
        lastUsed: slot.lastUsed,
      }));
    },
    touch(username) {
      scheduleIdle(username);
    },
  };
}

/**
 * Wo eine Session laufen soll — und warum.
 *
 * Zwei Ausgaenge, beide ausgesprochen:
 *
 * 1. `in-process` mit `reason: "admin"` oder `"no-identity"`: kein Mandant,
 *    also keine Grenze — die bestehende Entscheidung (Plan §9).
 * 2. `in-process` mit `reason: "opted-out"`: der Betreiber hat
 *    `OMP_WEB_ALLOW_UNSANDBOXED_TENANT=1` gesetzt. Der Start loggt laut,
 *    `boundary.enforced` ist `false`.
 *
 * Alles andere geht in einen Worker. Es gibt **keinen** stillen
 * In-Process-Fallback fuer einen Mandanten: ein fehlgeschlagener Plan ist ein
 * benannter Fehler mit Abhilfe, und der Request endet damit.
 */
export type BoundaryPolicy =
  | { mode: "in-process"; enforced: false; reason: "admin" | "no-identity" | "opted-out" }
  | { mode: "worker" };

export function tenantBoundaryPolicy(identity: WebIdentity | null, env: NodeJS.ProcessEnv = process.env): BoundaryPolicy {
  if (!isTenantWorkerIdentity(identity)) {
    return { mode: "in-process", enforced: false, reason: identity === null ? "no-identity" : "admin" };
  }
  if (allowUnsandboxedTenant(env)) return { mode: "in-process", enforced: false, reason: "opted-out" };
  return { mode: "worker" };
}

export { DEFAULT_WORKER_MAX, allowUnsandboxedTenant, resolveWorkerIdleMs, resolveWorkerMax };
