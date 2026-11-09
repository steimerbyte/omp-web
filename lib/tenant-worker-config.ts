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
  /**
   * Der Prozess lief, steht aber nicht in einer eigenen Mount-Namespace.
   *
   * Ein eigener Grund neben `boundary-unavailable`: dort fehlt eine
   * Voraussetzung, bevor irgendetwas startet (Home, SDK, `bun`). Hier ist
   * gestartet worden und die Grenze hat sich beim Nachmessen nicht eingestellt —
   * typischerweise ein Wrapper frueher im `PATH`, der `bwrap` heisst und die
   * Nutzlast ohne `--unshare-*` `exec`t. Ein Wiederholungsversuch aendert daran
   * nichts, deshalb kein 503 (siehe `BOUNDARY_STATUS_BY_REASON`).
   */
  | "boundary-not-enforced"
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

/**
 * Die Vorgaben. Gemessen an einem laufenden Worker: 265 MiB resident
 * (`VmRSS 271524 kB`) und 364 MiB Spitze (`VmHWM 372868 kB`), ~1,03 s Start.
 * Fuer die Obergrenze zaehlt die **Spitze**, nicht der Ruhewert.
 */
export const DEFAULT_WORKER_IDLE_MS = 300_000;
export const DEFAULT_WORKER_MAX = 4;
const MIN_IDLE_MS = 10_000;
const MAX_WORKER_MAX = 64;

/**
 * Die Anzahl gleichzeitiger Worker.
 *
 * Gemessen auf diesem Host: 6 Kerne, 12 GiB, 265 MiB resident und 364 MiB
 * Spitze pro Worker. Vier ist die Vorgabe, weil die **Kerne** vor dem Speicher
 * binden — 20 Worker wuerden in 12 GiB passen, aber jeder Start kostet ~1 s CPU.
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
 * Die Provider, fuer die der Betreiber seinen eigenen Schluessel freigibt.
 *
 * `OMP_WEB_TENANT_PROVIDER_GRANT` ist eine kommagetrennte Liste von
 * Provider-Namen (`brave,parallel`). Leer oder ungesetzt heisst **nichts** —
 * die Vorgabe ist keine Freigabe, sondern keine.
 *
 * Warum es diese Variable ueberhaupt gibt: der Name eines Providers ist die
 * Angabe des **Mandanten** (`models.yml` in seinem Home), der Wert waere der
 * des **Betreibers** (seine Geheimnisdatei). Ohne diese Trennung schreibt ein
 * Mandant `providers: { brave: … }` in seine eigene Datei und bekommt
 * `BRAVE_API_KEY` des Betreibers in seine Umgebung — gemessen und ausgenutzt:
 * `curl -H "authorization: Bearer $BRAVE_API_KEY"` zu einem beliebigen Host.
 * Ein Name ist eine Absicht, ein Schluessel ist ein Recht; die Freigabe ist
 * der Punkt, an dem der Betreiber das Recht vergibt.
 */
export function resolveProviderGrant(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.OMP_WEB_TENANT_PROVIDER_GRANT;
  if (typeof raw !== "string" || raw.trim().length === 0) return new Set();
  return new Set(
    raw.split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

/**
 * Die Umgebung fuer einen Mandanten-Worker.
 *
 * `PATH`, `LANG`, `TZ` und die drei Identitaetsvariablen. `HOME`/`USER`/
 * `LOGNAME` setzt `planSandboxSpawn` selbst auf die Gast-Werte; sie stehen hier
 * trotzdem, damit der Aufrufer eine vollstaendige Karte sieht und ein fehlender
 * `HOME` nicht als "erben" gelesen wird.
 *
 * **Zugangsdaten kommen nur aus einer ausdruecklichen Freigabe.** `providers`
 * sind die Namen, die der Mandant selbst konfiguriert hat; ein Wert wird nur
 * fuer einen Namen eingesetzt, den `OMP_WEB_TENANT_PROVIDER_GRANT` zusaetzlich
 * nennt. Ohne Freigabe bleibt die Umgebung leer, und der Mandant benutzt den
 * `apiKey`, der in **seinem** `models.yml` steht — das SDK liest ihn aus dem
 * Gast-Home, also ohne dass dieser Prozess ihn kennt. Ein Provider, dessen Name
 * nicht freigegeben ist, landet in `refused` (mit Logzeile); ein freigegebener
 * Name ohne aufloesbaren Wert landet in `missing`, nicht als leeres `--setenv`:
 * `KEY=` waere ein gesetzter, aber falscher Wert und wuerde den Fehler vom
 * Start in den ersten Modellaufruf verschieben.
 *
 * **Der Wert steht danach im argv des Workers.** `bwrap --setenv NAME WERT`
 * traegt ihn in `/proc/<leader>/cmdline`, und das ist fuer jeden Leser dieses
 * Hosts sichtbar — fuer die Dauer des Worker-Lebens. Die Freigabe ist deshalb
 * eine Entscheidung ueber einen lesbaren Wert, nicht nur ueber einen
 * funktionierenden. (Der Mandant selbst sieht ihn ohnehin in seiner `env`; das
 * ist der Zweck der Freigabe. Der Unterschied ist, dass ohne Freigabe gar kein
 * Betreiber-Schluessel in diesem Prozessbaum existiert.)
 */
export interface WorkerEnv {
  env: Record<string, string>;
  /** Freigegebene Provider, fuer die kein Schluessel aufloesbar war. */
  missing: Array<{ provider: string; envName: string | undefined }>;
  /** Provider des Mandanten ohne Freigabe — nichts eingesetzt, Logzeile geschrieben. */
  refused: string[];
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
  const refused: string[] = [];
  const grant = resolveProviderGrant(env);
  for (const provider of new Set(providers)) {
    const envName = getEnvApiKeyName(provider);
    if (envName === undefined) {
      // Ohne Zuordnung Provider → Umgebungsvariable gibt es keinen Weg, auf dem
      // ein Betreiber-Schluessel in dieses Kind kaeme; `local` ist genau so ein
      // Name. Hier zu warnen waere Rauschen, das die eine Zeile verdeckt, auf
      // die es ankommt. Als `missing` gemeldet wird er trotzdem, weil der
      // Aufrufer wissen soll, dass dieser Name keinen Wert bekommt.
      if (grant.has(provider)) missing.push({ provider, envName: undefined });
      continue;
    }
    // Die Freigabe steht **vor** der Aufloesung: ohne sie wird der Wert nicht
    // einmal gelesen. Ein `getRuntimeSecret` mit anschliessendem Verwerfen
    // waere derselbe Weg mit einem zusaetzlichen Schritt, in dem der Wert
    // schon im Prozess steht.
    if (!grant.has(provider)) {
      refused.push(provider);
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
  return { env: out, missing, refused };
}

/**
 * Die Absage an einen Mandanten, dessen Provider nicht freigegeben ist.
 *
 * Eine Zeile pro abgelehntem Namen, auf stderr: der Betreiber soll sehen, dass
 * ein Mandant einen Schluessel angefordert hat, den er nicht bekommt — ohne
 * diese Zeile sieht die Ablehnung wie ein Konfigurationsfehler des Mandanten
 * aus, und niemand erfaehrt von dem Versuch.
 */
export function logRefusedProviders(identity: WebIdentity, refused: readonly string[]): void {
  for (const provider of refused) {
    console.warn(
      `[tenant-boundary] ${identity.username} names provider "${provider}", which OMP_WEB_TENANT_PROVIDER_GRANT `
      + `does not grant. No operator key is injected for it; the tenant's own models.yml apiKey (if any) is used.`,
    );
  }
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
 *
 * Eine **kaputte** Datei ebenfalls — aber nicht stumm. `load()` liefert fuer
 * einen Syntax- oder Validierungsfehler `null`, also dieselbe Antwort wie fuer
 * "Datei fehlt"; der Unterschied ist fuer die Diagnose entscheidend, weil der
 * Mandant sonst einen Worker ohne Provider bekommt und die Ursache nirgends
 * steht. Deshalb wird der Fehler mit dem Pfad geloggt (der Parser des SDK
 * schreibt seine eigene Warnung ohne Pfad in der Zeile).
 */
export function tenantProviders(identity: WebIdentity): string[] {
  const agentDir = join(getUserHome(identity), ".omp", "agent");
  const file = join(agentDir, "models.yml");
  const loaded = ModelsConfigFile.relocate(file).tryLoad();
  if (loaded.status === "error") {
    console.warn(
      `[tenant-boundary] ${identity.username}: ${file} could not be parsed `
      + `(${loaded.error?.message ?? "unknown error"}); this worker starts with no provider from that file.`,
    );
    return [];
  }
  if (loaded.status === "not-found" || !loaded.value?.providers) return [];
  return Object.keys(loaded.value.providers);
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

