import { getRuntimeSecret } from "./runtime-secrets";
import { getEnvApiKeyName } from "@oh-my-pi/pi-ai/env-api-key";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";
import { join } from "node:path";
import { getUserHome, isAdminIdentity, type WebIdentity } from "./request-identity";
import type { SandboxFailureReason } from "./sandbox";

/**
 * Die Einstellungen des Mandanten-Workers, und was er an Umgebung bekommt.
 *
 * ### Warum eine eigene Datei
 *
 * Die drei Fragen — "darf ich ueberhaupt einen Worker starten", "welche
 * Umgebung bekommt er", "wie viele davon" — werden an drei Stellen gebraucht
 * (Plan, Lebenszyklus, Tests). Sie hier zu beantworten haelt die Grenze an
 * einer Stelle pruefbar; verstreut waere jede Kopie eine eigene Wahrheit.
 *
 * ### Die Umgebung ist eine Allowlist plus genau ein Geheimnis
 *
 * Der Worker erbt **nichts**. Er bekommt die Terminal-Allowlist (`PATH`,
 * `LANG`, `USER`, `HOME`, …) und dazu die **Provider-Zugangsdaten genau dieses
 * Kontos**. Nicht `OMP_WEB_PASSWORD`, nicht `BRAVE_API_KEY`, nicht
 * `PARALLEL_API_KEY`, nicht den Pfad zum Sitzungsschluessel.
 *
 * Die Namen dieser Zugangsdaten kommen aus dem SDK
 * (`getEnvApiKeyName(provider)`), nicht aus einer hier gepflegten Liste: eine
 * handgeschriebene Liste waere beim ersten neuen Provider still falsch, und
 * zwar so, dass der Worker mit einem leeren Schluessel startet und der Fehler
 * erst im Modellaufruf auftaucht.
 *
 * ### Der Mandant kann seinen eigenen Schluessel lesen
 *
 * Das ist gemessen und unvermeidlich, solange der Modellaufruf im selben
 * Prozess wie der Tool-Shell passiert (der Shell ist eine native Bibliothek,
 * §3 des Plans): ein `env` in einem Tool-Aufruf sieht den Schluessel, den der
 * Modellaufruf braucht. Die Grenze verhindert weiterhin *fremde* Schluessel.
 * Siehe `docs/plans/tenant-isolation.md` §12; das zu schliessen braucht einen
 * Modell-Proxy und ist nicht Teil dieses Schnitts.
 */

/** Warum kein Worker gestartet werden konnte. Benannt, nie still. */
export type TenantWorkerFailureReason =
  | "boundary-unavailable"
  | "tenant-worker-spawn-failed"
  | "tenant-worker-crashed"
  | "tenant-worker-timeout"
  | "tenant-worker-capacity"
  // Die Gruende des Plans werden unveraendert durchgereicht: der Plan weiss,
  // *warum* er abgelehnt hat (`bad-username`, `cwd-outside-home`,
  // `mask-unavailable`, `unsupported-platform`, …), und diese Datei wuerde nur
  // eine zweite, schlechtere Formulierung derselben Ursache erfinden.
  | SandboxFailureReason;

export interface TenantWorkerFailure {
  ok: false;
  reason: TenantWorkerFailureReason;
  detail: string;
  remediation: string;
}

/** Die Vorgaben. 256 MiB und ~1,03 s pro Worker sind auf diesem Host gemessen. */
export const DEFAULT_WORKER_IDLE_MS = 300_000;
export const DEFAULT_WORKER_MAX = 4;
const MIN_IDLE_MS = 10_000;
const MAX_WORKER_MAX = 64;

/**
 * Die Anzahl gleichzeitiger Worker.
 *
 * Gemessen auf diesem Host: 6 Kerne, 12 GiB, 288–295 MB pro Worker. Vier ist
 * die Vorgabe, weil die **Kerne** vor dem Speicher binden — 20 Worker wuerden
 * in 12 GiB passen, aber jeder Start kostet ~1 s CPU.
 */
export function resolveWorkerMax(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OMP_WEB_TENANT_WORKER_MAX;
  if (typeof raw !== "string" || raw.trim().length === 0) return DEFAULT_WORKER_MAX;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_WORKER_MAX) return DEFAULT_WORKER_MAX;
  return parsed;
}

/**
 * Nach welcher Ruhezeit ein Worker abgeraeumt wird.
 *
 * Ein zu kleiner Wert ist kein Sicherheitsproblem, sondern ein
 * Geschwindigkeitsproblem: jeder Request startet dann einen Prozess (~1 s).
 * Deshalb gibt es eine Untergrenze von 10 s statt eines Verbots.
 */
export function resolveWorkerIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OMP_WEB_TENANT_WORKER_IDLE_MS;
  if (typeof raw !== "string" || raw.trim().length === 0) return DEFAULT_WORKER_IDLE_MS;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < MIN_IDLE_MS) return DEFAULT_WORKER_IDLE_MS;
  return parsed;
}

/**
 * Der ausdrueckliche Ausstieg.
 *
 * `OMP_WEB_ALLOW_UNSANDBOXED_TENANT=1` heisst: "ich weiss, dass es keine Grenze
 * gibt, und will den Mandanten trotzdem". Das ist ein Betriebsnotausgang fuer
 * einen Host ohne User-Namespaces, kein Normalzustand. Der Start loggt ihn
 * laut, und `boundary.enforced` ist dann `false` — der Server behauptet nie
 * eine Isolation, die er nicht hat.
 */
export function allowUnsandboxedTenant(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMP_WEB_ALLOW_UNSANDBOXED_TENANT === "1";
}

/**
 * Der lauteste Satz, den dieser Prozess beim Start sagen kann.
 *
 * `null`, wenn der Ausstieg aus ist — der Aufrufer loggt dann nichts. Ein
 * stiller Ausstieg waere schlimmer als kein Ausstieg: der Betreiber wuerde
 * "isoliert" annehmen, weil niemand widersprochen hat.
 */
export function unsandboxedTenantWarning(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!allowUnsandboxedTenant(env)) return null;
  return [
    "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
    "  OMP_WEB_ALLOW_UNSANDBOXED_TENANT=1 — MANDANTEN-SESSIONS LAUFEN UNGESANDBOXT!",
    "  Ein Nicht-Admin-Agent laeuft im Serverprozess und kann jede Datei lesen,",
    "  die dem Dienstbenutzer gehoert: fremde Homes, Kontendatei, Sitzungsschluessel.",
    "  boundary.enforced ist fuer diese Sitzungen false. Nur fuer Entwicklung oder",
    "  einen Host ohne User-Namespaces gedacht.",
    "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
  ].join("\n");
}

/** Ist dieser Identity-Kandidat ueberhaupt ein Worker-Kandidat? */
export function isTenantWorkerIdentity(identity: WebIdentity | null): identity is WebIdentity {
  return identity !== null && !isAdminIdentity(identity);
}

/**
 * Die Umgebung fuer einen Mandanten-Worker.
 *
 * `PATH`, `LANG`, `TZ` und die drei Identitaetsvariablen. `HOME`/`USER`/
 * `LOGNAME` setzt `planSandboxSpawn` selbst auf die Gast-Werte; sie stehen hier
 * trotzdem, damit der Aufrufer eine vollstaendige Karte sieht und ein fehlender
 * `HOME` nicht als "erben" gelesen wird.
 *
 * Dazu genau die Zugangsdaten der Provider, die `providers` nennt, und nur
 * dann, wenn ein Wert aufloesbar ist. Ein Provider ohne aufloesbaren Schluessel
 * fuehrt zu einem Eintrag in `missing`, nicht zu einem leeren `--setenv`:
 * `KEY=` waere ein gesetzter, aber falscher Wert und wuerde den Fehler vom
 * Start in den ersten Modellaufruf verschieben.
 */
export interface WorkerEnv {
  env: Record<string, string>;
  /** Provider, fuer die kein Schluessel aufloesbar war — der Aufrufer entscheidet. */
  missing: Array<{ provider: string; envName: string | undefined }>;
}

export function buildWorkerEnv(
  identity: WebIdentity,
  providers: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): WorkerEnv {
  const out: Record<string, string> = {};
  // Ein **fester** Pfad, kein geerbter. Der geerbte PATH dieses Dienstes
  // enthaelt die Host-Verzeichnisse (`/home/pi/.bun/bin`, `/home/pi/.cargo/bin`,
  // …); ihn in die Grenze zu setzen verraet die Kontostruktur des Hosts und
  // hilft dem Worker nicht, weil diese Verzeichnisse dort nicht existieren.
  out.PATH = "/usr/local/bin:/usr/bin:/bin";
  out.LANG = env.LANG ?? "C.UTF-8";
  if (typeof env.TZ === "string" && env.TZ.length > 0) out.TZ = env.TZ;
  const guestHome = `/home/${identity.username}`;
  out.HOME = guestHome;
  out.USER = identity.username;
  out.LOGNAME = identity.username;
  // Der Agent-Ordner des Mandanten, ausdruecklich als Guest-Pfad. Ohne das
  // zeigt `PI_CODING_AGENT_DIR` auf das Prozessverzeichnis, das in der
  // Grenze nicht existiert, und der Worker sieht weder `models.yml` noch
  // seine `agent.db`.
  out.PI_CODING_AGENT_DIR = `${guestHome}/.omp/agent`;

  const missing: WorkerEnv["missing"] = [];
  for (const provider of new Set(providers)) {
    const envName = getEnvApiKeyName(provider);
    if (envName === undefined) {
      missing.push({ provider, envName: undefined });
      continue;
    }
    // Die Datei schlaegt die Umgebung (dieselbe Regel wie `getRuntimeSecret`):
    // der Dienst haelt seine Geheimnisse in einer Datei, nicht in `Environment=`.
    const value = getRuntimeSecret(envName, env);
    if (value === undefined || value.length === 0) {
      missing.push({ provider, envName });
      continue;
    }
    out[envName] = value;
  }
  return { env: out, missing };
}

/**
 * Die Provider, die das Konto **selbst** konfiguriert hat.
 *
 * Die Anforderung ist "die Zugangsdaten dieses Kontos, aufgeloest serverseitig
 * aus derselben Quelle, die das SDK benutzt". Diese Quelle ist das
 * `models.yml` des Kontos — seine eigene Datei im eigenen Agent-Verzeichnis
 * (`lib/tenant-config.ts`), nicht der globale Bestand des Betreibers.
 *
 * Gelesen wird mit `ModelsConfigFile.relocate(pfad)`, also mit dem Parser des
 * SDK: eine eigene YAML-Auswertung waere eine zweite Wahrheit ueber das
 * Dateiformat, und der Fehler faellt dann erst im Modellaufruf auf. Der
 * `relocate`-Aufruf liefert eine **eigene** Instanz, die den modulweiten Cache
 * nicht anfasst; die gecachte Instanz bleibt fuer den Prozesspfad unberuehrt.
 *
 * Zurueck kommen die **Namen**, nicht die Schluessel: welcher Wert daraus folgt,
 * entscheidet `buildWorkerEnv` mit `getEnvApiKeyName`. Damit steht die
 * Zuordnung Provider → Umgebungsvariable an genau einer Stelle, und sie ist die
 * des SDK.
 *
 * Ein Konto ohne `models.yml` bekommt eine leere Liste — kein Fehler. Es hat
 * dann keinen Provider, und der Worker scheitert beim ersten Modellaufruf mit
 * der Meldung des SDK, die genau das sagt. Ein Seeding mit dem Betreiber-Key
 * waere das Kostenleck aus `lib/tenant-config.ts`.
 */
export function tenantProviders(identity: WebIdentity): string[] {
  const agentDir = join(getUserHome(identity), ".omp", "agent");
  const providers = ModelsConfigFile.relocate(join(agentDir, "models.yml")).load()?.providers;
  if (!providers) return [];
  return Object.keys(providers);
}

/**
 * Die Gast-Pfade eines Workers, aus den Host-Pfaden abgeleitet.
 *
 * Eine Funktion, weil die Ableitung an drei Stellen gebraucht wird (argv,
 * Lifecycle, Tests) und eine zweite Kopie der falsche Ort fuer einen Tippfehler
 * waere. `hostHome` ist das aufgeloeste Konto-Home, `guestHome` sein Pfad in
 * der Namespace.
 */
export function workerGuestPaths(identity: WebIdentity): {
  guestHome: string;
  guestBun: string;
  guestNodeModules: string;
  guestCli: string;
  guestSessions: string;
  guestCwd: string;
} {
  const guestHome = `/home/${identity.username}`;
  return {
    guestHome,
    guestBun: `${guestHome}/bun`,
    guestNodeModules: `${guestHome}/node_modules`,
    guestCli: `${guestHome}/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`,
    guestSessions: `${guestHome}/.omp/agent/sessions`,
    guestCwd: guestHome,
  };
}

