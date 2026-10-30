import { randomUUID } from "crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync } from "fs";
import { dirname, join } from "path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { isAbsolute } from "path";
import { MODEL_ROLE_THINKING_LEVELS } from "./model-role-selection";
import { isPathWithinRoots } from "./path-security";
import { MAX_MODEL_REF_LENGTH, MAX_TASK_NAME_LENGTH, MAX_TASK_PROMPT_LENGTH } from "./scheduled-task-limits";
import { isIsoTimestamp } from "./projects-schema";
import { getUserHome, type WebIdentity } from "./request-identity";
import { parseSchedule } from "./schedule";
import { resolveTenantAgentDir } from "./tenant-config";

/**
 * Die server­seitige Ablage der geplanten Agenten-Aufgaben, eine Datei pro Konto.
 *
 * Dieselbe Form wie `lib/quick-phrases-store.ts`, `lib/projects-store.ts` und
 * `lib/calendar-store.ts`: eine JSON-Datei im Agent-Verzeichnis des Kontos, mit
 * `omp-web-`-Praefix (die Datei liegt dort, gehoert aber *nicht* omp), Pfad
 * ueber `resolveTenantAgentDir`, Grenze ueber `isPathWithinRoots`, Schreiben
 * ueber `writePrivateFileAtomicSync`.
 *
 * ### Warum eine Sperrdatei, und warum sie nicht nur im Prozess liegt
 *
 * Der Zeitplan wird von einem Prozess ausgeloest, die Datei liegt aber im
 * gemeinsamen Dateisystem — und zwei Instanzen sind in dieser Installation der
 * Normalfall (`scripts/deploy-local.sh`: live und verify, gleiche Konten).
 * Ein `globalThis`-Lock wie in `lib/projects-sizes.ts:87` haelt nur einen
 * Prozess auf; deshalb ist die Sperre hier eine Datei, die mit `wx` angelegt
 * wird. Der kritische Abschnitt ist kurz (lesen, aendern, schreiben), also
 * *verweigert* die Sperre statt zu warten: ein Aufrufer, der sie nicht bekommt,
 * fragt beim naechsten Tick erneut. Waere sie dauerhaft, waere ein Absturz im
 * Abschnitt ein fuer immer stummer Zeitplan — deshalb uebernimmt ein Aufrufer
 * eine Sperre, die aelter als {@link LOCK_STALE_MS} ist.
 *
 * Die Schreibweise selbst bleibt atomar (Temp-Datei + `rename`): die Sperre
 * schuetzt vor verlorenen Aenderungen, der atomare Write davor, dass ein
 * Absturz eine halbe Datei hinterlaesst.
 */
const STORE_FILE = "omp-web-scheduled-tasks.json";

/**
 * Die Version des Dateiformats.
 *
 * Verglichen wird beim Lesen, aber ein Unterschied ist kein Fehler: es gibt
 * genau eine Version und keinen Migrationspfad (siehe `AGENTS.md` — es gibt
 * keinen Migrationsrahmen). Was gelesen werden kann, wird gelesen, und beim
 * naechsten Schreiben steht wieder {@link SCHEDULED_TASKS_SCHEMA_VERSION} in
 * der Datei. Eine Zeile, deren Form nicht passt, faellt beim Normalisieren weg;
 * die Anwendung darf an einer kaputten Zeile nicht scheitern.
 */
export const SCHEDULED_TASKS_SCHEMA_VERSION = 1 as const;

// Die Grenzen stehen in `lib/scheduled-task-limits.ts`, weil die Ansicht sie
// braucht und dieser Modul `fs` und die Laufzeit nachzieht. Hier werden sie
// weitergereicht, damit die oeffentliche Form des Speichers bleibt, wie sie
// war.
export { MAX_MODEL_REF_LENGTH, MAX_TASK_NAME_LENGTH, MAX_TASK_PROMPT_LENGTH } from "./scheduled-task-limits";

/** Nach dieser Zeit gilt eine liegengebliebene Sperrdatei als verwaist. */
const LOCK_STALE_MS = 30_000;

/**
 * Das Ergebnis eines Laufstarts, wie es der Zeitplaner vermerkt.
 *
 * Bewusst nur zwei Werte: der Zeitplaner *startet* eine Session, und ob die
 * Session danach gelingt, ist ihre Sache. `error` heisst "der Start ist
 * gescheitert", nicht "der Agent hat schlecht geantwortet".
 */
export type ScheduledRunStatus = "ok" | "error";

/** Eine geplante Aufgabe, so wie sie in der Datei steht. */
export interface ScheduledTask {
  id: string;
  name: string;
  /** Der Cron-Ausdruck, geprueft durch `parseSchedule`. */
  cron: string;
  prompt: string;
  provider: string;
  modelId: string;
  thinkingLevel?: ConfiguredThinkingLevel;
  /**
   * Das Arbeitsverzeichnis des Laufs, absolut und unterhalb der Konto-Home.
   *
   * Optional, weil der Normalfall die Home des Kontos ist. Es steht bewusst
   * *nicht* in der Oberflaeche: ein Feld, das den Agenten in ein anderes
   * Verzeichnis schickt, ist eine Sache fuer die API, nicht fuer ein Formular.
   */
  cwd?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunSessionId?: string;
  lastRunStatus?: ScheduledRunStatus;
  /**
   * Der zuletzt beanspruchte Slot als Epoch-ms — die Felds fuer
   * {@link claimRun}. Er wird nie zurueckgesetzt: ein Slot, der schon lief,
   * laeuft nicht noch einmal, auch nicht nach einem Neustart.
   */
  claimedSlotMs?: number;
}

/** Was ein Aufrufer zum Anlegen einer Aufgabe liefert. */
export interface ScheduledTaskInput {
  name: string;
  cron: string;
  prompt: string;
  provider: string;
  modelId: string;
  thinkingLevel?: ConfiguredThinkingLevel | null;
  /** Absolut und unterhalb der Konto-Home; sonst gilt die Home des Kontos. */
  cwd?: string | null;
  enabled?: boolean;
}

/** Eine Teilmenge von {@link ScheduledTaskInput}; `thinkingLevel: null` loescht die Angabe. */
export type ScheduledTaskPatch = Partial<ScheduledTaskInput>;

/**
 * "Ist dieses Modell-Paar bekannt?"
 *
 * Der Speicher kennt keine Modelliste — die kommt aus der Modellregistrierung
 * des Prozesses, und die haengt an `config.yml` und `agent.db`, nicht an dieser
 * Datei. Der Aufrufer reicht die Antwort herein (`modelRegistry.find(provider,
 * modelId) != null`), damit hier keine zweite, veraltende Kopie der Liste steht.
 */
export type KnownModelLookup = (provider: string, modelId: string) => boolean;

/**
 * Ein abgelehnter Aufruf.
 *
 * `field` ist das Feld, das der Aufrufer korrigieren muss; `id` steht fuer
 * "diese Aufgabe gibt es nicht", `lock` fuer "eine andere Instanz schreibt
 * gerade", `version` fuer "die Datei stammt aus einer anderen Fassung". Eine
 * Route kann daraus den Statuscode ableiten, ohne die Meldung zu zerlegen.
 */
export class ScheduledTaskError extends Error {
  readonly field:
    | "name"
    | "cron"
    | "prompt"
    | "provider"
    | "modelId"
    | "thinkingLevel"
    | "cwd"
    | "enabled"
    | "id"
    | "lock"
    | "version";

  constructor(field: ScheduledTaskError["field"], message: string) {
    super(message);
    this.name = "ScheduledTaskError";
    this.field = field;
  }
}

/** Der Pfad der Aufgabendatei einer Identitaet. */
export function getScheduledTasksPath(identity: WebIdentity): string {
  return join(resolveTenantAgentDir(identity), STORE_FILE);
}

/**
 * `true`, wenn der Pfad der Aufgabendatei unterhalb der Konto-Home liegt.
 *
 * Dieselbe zweite Schicht wie bei Kalender und Quick Phrases: die Ableitung des
 * Pfades ist nicht seine Abnahme. Die Route prueft das **vor** dem ersten
 * Schreiben.
 */
export function isScheduledTasksPathAllowed(identity: WebIdentity, path: string): boolean {
  return isPathWithinRoots(path, new Set([getUserHome(identity)]));
}

/** Was ein Lesen der Datei ergibt. */
export interface ScheduledTasksFile {
  /** `false` nur, wenn es die Datei nicht gibt. */
  exists: boolean;
  tasks: ScheduledTask[];
  /**
   * `true`, wenn die Datei eine andere `schemaVersion` traegt als dieser Build.
   *
   * Gelesen wird sie trotzdem — die Zeilen, die diese Fassung versteht, sind
   * lesbar. Geschrieben wird sie dann nicht: ein neuerer Build kann Felder
   * angelegt haben, die hier beim Normalisieren wegfallen, und ein
   * darauffolgendes Schreiben wuerde sie vernichten. Deshalb antwortet
   * {@link mutate} in diesem Fall mit einem Fehler statt mit einer
   * ueberschriebenen Datei.
   */
  versionMismatch: boolean;
}

/**
 * Der `cwd` einer gelesenen Aufgabe, aber nur innerhalb der Konto-Home.
 *
 * ### Warum das beim Lesen passieren muss und nicht nur beim Schreiben
 *
 * `assertCwd` prueft jede Eingabe ueber die API. Eine von Hand bearbeitete
 * Datei geht an dieser Pruefung vorbei — und der Zeitplaner startet dann eine
 * Session in einem fremden Verzeichnis. Der Besitz einer Session wird aus
 * ihrem `cwd` abgeleitet (`lib/session-reader.ts`), also waere das eine
 * Sitzung, die einem anderen Konto zugerechnet wird.
 *
 * Verworfen wird nur das Feld, nicht die Aufgabe: der Zeitplan selbst ist
 * weiterhin gueltig, und der Lauf faellt auf die Home des Kontos zurueck.
 */
function withAllowedCwd(tasks: ScheduledTask[], identity: WebIdentity): ScheduledTask[] {
  const home = getUserHome(identity);
  return tasks.map((task) => {
    if (task.cwd === undefined) return task;
    if (isAbsolute(task.cwd) && isPathWithinRoots(task.cwd, new Set([home]))) return task;
    const copy = { ...task };
    delete copy.cwd;
    return copy;
  });
}

/**
 * Die gespeicherten Aufgaben und was der Datei-Kopf sagt.
 *
 * `exists: false` ist nicht "leere Liste": eine leere Liste ist ein Loeschen
 * durch den Nutzer und darf nie durch Voreinstellungen aufgefuellt werden.
 * Unlesbarer Inhalt gilt wie "keine Datei" fuer die Form, aber nicht fuer den
 * Inhalt — es kommt `[]` mit `exists: true` zurueck.
 */
export function readScheduledTasksFile(identity: WebIdentity): ScheduledTasksFile {
  const path = getScheduledTasksPath(identity);
  if (!existsSync(path)) return { exists: false, tasks: [], versionMismatch: false };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const list = typeof parsed === "object" && parsed !== null && "tasks" in parsed ? parsed.tasks : parsed;
    // Eine Datei ohne `schemaVersion` ist von Hand geschrieben oder aus der
    // ersten Fassung; es gibt nichts zu vergleichen, also keinen Konflikt.
    const version = typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).schemaVersion
      : undefined;
    return {
      exists: true,
      tasks: withAllowedCwd(normalizeScheduledTasks(list), identity),
      versionMismatch: typeof version === "number" && version !== SCHEDULED_TASKS_SCHEMA_VERSION,
    };
  } catch {
    return { exists: true, tasks: [], versionMismatch: false };
  }
}

/**
 * Eine Aufgabe aus ungeprueftem Material — oder `null`, wenn sie unbrauchbar ist.
 *
 * Geprueft wird **ohne Reparatur**: was fehlt oder die falsche Form hat, macht
 * die Zeile ungueltig, und die Zeile faellt weg. Ein Feld wird nie erfunden —
 * eine erfundene `createdAt` oder ein auf `true` gesetztes `enabled` waere ein
 * Wert, von dem der Nutzer glaubt, er haette ihn gesetzt.
 *
 * Einzige Ausnahme sind die *optionalen* Felder (`thinkingLevel`, `lastRun*`,
 * `claimedSlotMs`): ist eines davon gesetzt, aber unlesbar, wird es als
 * abwesend gespeichert. Die Zeile bleibt, der Wert verschwindet — erfundene
 * Daten entstehen auch dabei nicht.
 */
export function normalizeScheduledTask(value: unknown): ScheduledTask | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  if (typeof raw.id !== "string" || raw.id.trim() === "") return null;
  if (typeof raw.name !== "string") return null;
  const name = raw.name.trim();
  if (name === "" || name.length > MAX_TASK_NAME_LENGTH) return null;
  if (typeof raw.prompt !== "string" || raw.prompt.trim() === "") return null;
  if (raw.prompt.length > MAX_TASK_PROMPT_LENGTH) return null;
  if (typeof raw.cron !== "string") return null;
  let cron: string;
  try {
    cron = parseSchedule(raw.cron).expression;
  } catch {
    return null;
  }
  if (typeof raw.provider !== "string" || typeof raw.modelId !== "string") return null;
  if (!raw.provider.trim() || !raw.modelId.trim()) return null;
  if (raw.provider.length > MAX_MODEL_REF_LENGTH || raw.modelId.length > MAX_MODEL_REF_LENGTH) return null;
  if (typeof raw.enabled !== "boolean") return null;
  if (!isIsoTimestamp(raw.createdAt) || !isIsoTimestamp(raw.updatedAt)) return null;

  const thinkingLevel =
    typeof raw.thinkingLevel === "string"
    && (MODEL_ROLE_THINKING_LEVELS as readonly string[]).includes(raw.thinkingLevel)
      ? (raw.thinkingLevel as ConfiguredThinkingLevel)
      : undefined;

  const lastRunStatus = raw.lastRunStatus === "ok" || raw.lastRunStatus === "error" ? raw.lastRunStatus : undefined;

  return {
    id: raw.id,
    name,
    cron,
    prompt: raw.prompt,
    provider: raw.provider,
    modelId: raw.modelId,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    // Die Form wird hier geprueft, die *Grenze* nicht: dieser Funktion fehlt
    // die Identitaet, sie sieht nur eine Zeile. Ob der Pfad in der richtigen
    // Home liegt, entscheidet `readScheduledTasksFile` — dort ist die Identitaet
    // bekannt, und dort wird ein fremder `cwd` verworfen.
    ...(typeof raw.cwd === "string" && raw.cwd !== "" ? { cwd: raw.cwd } : {}),
    enabled: raw.enabled,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    ...(isIsoTimestamp(raw.lastRunAt) ? { lastRunAt: raw.lastRunAt } : {}),
    ...(typeof raw.lastRunSessionId === "string" && raw.lastRunSessionId !== ""
      ? { lastRunSessionId: raw.lastRunSessionId }
      : {}),
    ...(lastRunStatus ? { lastRunStatus } : {}),
    ...(typeof raw.claimedSlotMs === "number" && Number.isSafeInteger(raw.claimedSlotMs) && raw.claimedSlotMs >= 0
      ? { claimedSlotMs: raw.claimedSlotMs }
      : {}),
  };
}

/** Eine Liste, in der ungueltige Zeilen fehlen und doppelte `id`s nur einmal vorkommen. */
export function normalizeScheduledTasks(value: unknown): ScheduledTask[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tasks: ScheduledTask[] = [];
  for (const entry of value) {
    const task = normalizeScheduledTask(entry);
    if (task === null) continue;
    // Zwei Zeilen mit einer id waeren zwei Karten fuer eine Aufgabe, und welche
    // gewinnt, haenge an der Reihenfolge in der Datei.
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    tasks.push(task);
  }
  return tasks;
}

function saveTasks(path: string, tasks: ScheduledTask[]): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(
    path,
    JSON.stringify({ schemaVersion: SCHEDULED_TASKS_SCHEMA_VERSION, tasks }, null, 2) + "\n",
  );
}

/**
 * Prueft den Inhaber der Sperrdatei und legt sie an — oder gibt `false`.
 *
 * `wx` ist die Pruefung: das Anlegen gelingt genau fuer einen Aufrufer, auch
 * ueber Prozessgrenzen. Eine vorhandene Datei ist entweder ein laufender
 * Vorgang (dann `false`) oder der Rest eines Absturzes (dann nach
 * {@link LOCK_STALE_MS} uebernehmbar).
 */
function takeLock(lockPath: string): boolean {
  try {
    closeSync(openSync(lockPath, "wx", 0o600));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  // Der billige Vorab-Test: solange die Sperre frisch ist, wird sie nicht
  // angefasst. Ohne ihn wuerde jeder Schreibvorgang mit Konkurrenz die Sperre
  // eines *laufenden* Schreibers kurz wegnehmen — und in dieser Luecke koennte
  // ein Dritter schreiben.
  try {
    if (Date.now() - statSync(lockPath).mtimeMs < LOCK_STALE_MS) return false;
  } catch {
    return false;
  }

  // Uebernahme einer verwaisten Sperre: erst *umbenennen*, dann pruefen, dann
  // anlegen. `rm` und Neuanlegen waere die naheliegende Variante und die
  // falsche: zwischen beiden Schritten ist der Pfad frei, und ein zweiter
  // Uebernehmer koennte seine eigene Sperre setzen, die der erste dann
  // loescht. Das Umbenennen ist atomar und gelingt genau einmal.
  const aside = `${lockPath}.${randomUUID()}.stale`;
  try {
    renameSync(lockPath, aside);
  } catch {
    // Schon weg: jemand anderes hat sie gerade uebernommen oder freigegeben.
    return false;
  }
  try {
    if (Date.now() - statSync(aside).mtimeMs < LOCK_STALE_MS) {
      // Zwischen Vorab-Test und Umbenennen hat jemand die Sperre neu gesetzt.
      // Zuruecklegen waere richtig, aber das Ziel kann inzwischen belegt sein;
      // dann ist dieser Rest wertlos und wird verworfen. Ein verwaister
      // `.stale`-Rest ist kein Zustand, den jemand liest.
      try {
        renameSync(aside, lockPath);
      } catch {
        rmSync(aside, { force: true });
      }
      return false;
    }
    rmSync(aside, { force: true });
    closeSync(openSync(lockPath, "wx", 0o600));
    return true;
  } catch {
    return false;
  }
}

/**
 * Fuehrt `action` unter der Sperrdatei aus.
 *
 * Innerhalb *eines* Prozesses braucht es die Datei nicht: `action` ist synchron,
 * und Node/Bun fuehrt synchrone Arbeit nicht verschraenkt aus — ein zweiter
 * Aufruf startet erst, wenn der erste zurueckgekehrt ist. Die Sperrdatei ist
 * fuer den Fall da, den ein `globalThis`-Lock nicht abdeckt: zwei Prozesse auf
 * demselben Dateisystem (`scripts/deploy-local.sh`).
 *
 * `locked: false` heisst "jemand anders schreibt gerade"; der Aufrufer
 * entscheidet, ob das ein Fehler ist (CRUD) oder ein "spaeter nochmal"
 * (`claimRun`).
 */
function withFileLock<T>(lockPath: string, action: () => T): { locked: false } | { locked: true; value: T } {
  if (!takeLock(lockPath)) return { locked: false };
  try {
    return { locked: true, value: action() };
  } finally {
    rmSync(lockPath, { force: true });
  }
}

/**
 * Liest, aendert und schreibt unter der Sperre.
 *
 * Gibt `apply` dieselbe Liste zurueck, die es bekommen hat, wird nicht
 * geschrieben — ein "Aufgabe nicht gefunden" hinterlaesst so keine neue
 * Dateiversion.
 */
function mutate<T>(
  identity: WebIdentity,
  apply: (tasks: ScheduledTask[]) => { tasks: ScheduledTask[]; value: T },
): { locked: false } | { locked: true; value: T } {
  const path = getScheduledTasksPath(identity);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  return withFileLock(`${path}.lock`, () => {
    const file = readScheduledTasksFile(identity);
    if (file.versionMismatch) {
      throw new ScheduledTaskError(
        "version",
        `The scheduled tasks file was written by another version and this build writes ${SCHEDULED_TASKS_SCHEMA_VERSION}`,
      );
    }
    const next = apply(file.tasks);
    if (next.tasks !== file.tasks) saveTasks(path, next.tasks);
    return next.value;
  });
}

function assertName(value: unknown): string {
  if (typeof value !== "string") throw new ScheduledTaskError("name", "The name must be a string");
  const name = value.trim();
  if (name === "") throw new ScheduledTaskError("name", "The name must not be empty");
  if (name.length > MAX_TASK_NAME_LENGTH) {
    throw new ScheduledTaskError("name", `The name must be at most ${MAX_TASK_NAME_LENGTH} characters`);
  }
  return name;
}

function assertPrompt(value: unknown): string {
  if (typeof value !== "string") throw new ScheduledTaskError("prompt", "The prompt must be a string");
  // Getrimmt wird nur fuer die Leerpruefung: der Prompt ist Inhalt, und eine
  // fuehrende Einrueckung kann Teil einer Vorlage sein.
  if (value.trim() === "") throw new ScheduledTaskError("prompt", "The prompt must not be empty");
  if (value.length > MAX_TASK_PROMPT_LENGTH) {
    throw new ScheduledTaskError("prompt", `The prompt must be at most ${MAX_TASK_PROMPT_LENGTH} characters`);
  }
  return value;
}

/** Der gepruefte Cron-Ausdruck; ein Fehler aus `parseSchedule` nennt Feld und Token selbst. */
function assertCron(value: unknown): string {
  if (typeof value !== "string") throw new ScheduledTaskError("cron", "The cron expression must be a string");
  return parseSchedule(value).expression;
}

function assertModel(pair: { provider: unknown; modelId: unknown }, isKnownModel: KnownModelLookup): {
  provider: string;
  modelId: string;
} {
  const { provider, modelId } = pair;
  if (typeof provider !== "string" || provider.trim() === "") {
    throw new ScheduledTaskError("provider", "A provider is required");
  }
  if (typeof modelId !== "string" || modelId.trim() === "") {
    throw new ScheduledTaskError("modelId", "A model id is required");
  }
  if (provider.length > MAX_MODEL_REF_LENGTH || modelId.length > MAX_MODEL_REF_LENGTH) {
    throw new ScheduledTaskError("modelId", `Provider and model id must be at most ${MAX_MODEL_REF_LENGTH} characters`);
  }
  if (!isKnownModel(provider, modelId)) {
    throw new ScheduledTaskError("modelId", `Unknown model ${provider}/${modelId}`);
  }
  return { provider, modelId };
}

/**
 * `enabled` ist ein Schalter, kein Wahrheitswert.
 *
 * `"false"` als String ist wahr, `0` ist falsch — beides waere eine stille
 * Umdeutung dessen, was der Aufrufer geschickt hat. Nur `undefined` bekommt
 * einen Vorgabewert (neu angelegte Aufgaben sind aktiv).
 */
function assertEnabled(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean") throw new ScheduledTaskError("enabled", "enabled must be true or false");
  return value;
}

function assertThinkingLevel(value: unknown): ConfiguredThinkingLevel | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && (MODEL_ROLE_THINKING_LEVELS as readonly string[]).includes(value)) {
    return value as ConfiguredThinkingLevel;
  }
  throw new ScheduledTaskError("thinkingLevel", `Unknown thinking level ${String(value)}`);
}

/**
 * Das Arbeitsverzeichnis: absolut, und unterhalb der Home dieses Kontos.
 *
 * Die Grenze ist nicht Kosmetik. `lib/session-reader.ts` leitet den *Besitz*
 * einer Session aus ihrem `cwd` ab; ein Lauf, dessen `cwd` in einer fremden
 * Home liegt, wuerde eine Session erzeugen, die einem anderen Konto
 * zugerechnet wird. Der Zeitplaner laeuft ohne Request, kann den Pfad also
 * nirgends gegenpruefen — die Pruefung muss beim Schreiben passieren, hier.
 */
function assertCwd(value: unknown, identity: WebIdentity): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ScheduledTaskError("cwd", "The working directory must be a non-empty string");
  }
  const cwd = value.trim();
  if (!isAbsolute(cwd)) throw new ScheduledTaskError("cwd", "The working directory must be an absolute path");
  if (!isPathWithinRoots(cwd, new Set([getUserHome(identity)]))) {
    throw new ScheduledTaskError("cwd", "The working directory must be inside your home directory");
  }
  return cwd;
}

/** Die Aufgaben eines Kontos, in der Reihenfolge der Datei. */
export function listTasks(identity: WebIdentity): ScheduledTask[] {
  return readScheduledTasksFile(identity).tasks;
}

/** Eine Aufgabe, oder `null`, wenn es sie nicht gibt. */
export function getTask(identity: WebIdentity, id: string): ScheduledTask | null {
  return listTasks(identity).find((task) => task.id === id) ?? null;
}

/** Legt eine Aufgabe an. `isKnownModel` ist Pflicht: ein unbekanntes Paar wird abgelehnt. */
export function createTask(
  identity: WebIdentity,
  input: ScheduledTaskInput,
  isKnownModel: KnownModelLookup,
): ScheduledTask {
  const now = new Date().toISOString();
  const thinkingLevel = assertThinkingLevel(input.thinkingLevel);
  const cwd = assertCwd(input.cwd, identity);
  const task: ScheduledTask = {
    id: randomUUID(),
    name: assertName(input.name),
    cron: assertCron(input.cron),
    prompt: assertPrompt(input.prompt),
    ...assertModel(input, isKnownModel),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(cwd ? { cwd } : {}),
    enabled: assertEnabled(input.enabled),
    createdAt: now,
    updatedAt: now,
  };

  const outcome = mutate(identity, (tasks) => ({ tasks: [...tasks, task], value: task }));
  if (!outcome.locked) throw new ScheduledTaskError("lock", "Another process is writing the scheduled tasks file");
  return outcome.value;
}

/**
 * Aendert eine Aufgabe; `null`, wenn es sie nicht gibt.
 *
 * Der Patch wird auf den gespeicherten Stand gelegt und das *Ergebnis* geprueft
 * — sonst koennte ein Patch den Cron zerstoeren, den ein zweiter Patch gerade
 * gesetzt hat. `thinkingLevel: null` entfernt die Angabe.
 */
export function updateTask(
  identity: WebIdentity,
  id: string,
  patch: ScheduledTaskPatch,
  isKnownModel: KnownModelLookup,
): ScheduledTask | null {
  const outcome = mutate(identity, (tasks) => {
    const index = tasks.findIndex((task) => task.id === id);
    if (index === -1) return { tasks, value: null };

    const existing = tasks[index];
    const next: ScheduledTask = {
      ...existing,
      name: patch.name === undefined ? existing.name : assertName(patch.name),
      cron: patch.cron === undefined ? existing.cron : assertCron(patch.cron),
      prompt: patch.prompt === undefined ? existing.prompt : assertPrompt(patch.prompt),
      ...(patch.provider === undefined && patch.modelId === undefined
        ? {}
        : assertModel(
          {
            provider: patch.provider === undefined ? existing.provider : patch.provider,
            modelId: patch.modelId === undefined ? existing.modelId : patch.modelId,
          },
          isKnownModel,
        )),
      ...(patch.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: assertThinkingLevel(patch.thinkingLevel) }),
      ...(patch.cwd === undefined ? {} : { cwd: assertCwd(patch.cwd, identity) ?? undefined }),
      enabled: patch.enabled === undefined ? existing.enabled : assertEnabled(patch.enabled),
      updatedAt: new Date().toISOString(),
    };
    // `null` im Patch loescht die Angabe; ein Feld mit `undefined` gehoert
    // nicht in die Datei.
    if (next.thinkingLevel === undefined) delete next.thinkingLevel;
    if (next.cwd === undefined) delete next.cwd;

    const updated = [...tasks];
    updated[index] = next;
    return { tasks: updated, value: next };
  });

  if (!outcome.locked) throw new ScheduledTaskError("lock", "Another process is writing the scheduled tasks file");
  return outcome.value;
}

/** Loescht eine Aufgabe; `false`, wenn es sie nicht gab. */
export function deleteTask(identity: WebIdentity, id: string): boolean {
  const outcome = mutate(identity, (tasks) => {
    const remaining = tasks.filter((task) => task.id !== id);
    // Dieselbe Referenz heisst "nichts geloescht" und spart das Schreiben.
    return { tasks: remaining.length === tasks.length ? tasks : remaining, value: remaining.length !== tasks.length };
  });
  if (!outcome.locked) throw new ScheduledTaskError("lock", "Another process is writing the scheduled tasks file");
  return outcome.value;
}

/**
 * Vermerkt einen Laufstart; `null`, wenn es die Aufgabe nicht gibt.
 *
 * `at` ist Epoch-ms und wird als ISO-Zeit gespeichert, wie `createdAt`.
 * `updatedAt` bleibt stehen: das ist der Zeitpunkt der letzten *Bearbeitung*
 * durch den Nutzer, und ein Lauf ist keine Bearbeitung.
 */
export function markRun(
  identity: WebIdentity,
  id: string,
  run: { at: number; sessionId?: string; status: ScheduledRunStatus },
): ScheduledTask | null {
  const at = new Date(run.at);
  if (!Number.isFinite(at.getTime())) throw new ScheduledTaskError("id", "markRun needs a valid timestamp");

  const outcome = mutate(identity, (tasks) => {
    const index = tasks.findIndex((task) => task.id === id);
    if (index === -1) return { tasks, value: null };

    const next: ScheduledTask = {
      ...tasks[index],
      lastRunAt: at.toISOString(),
      lastRunStatus: run.status,
      ...(run.sessionId ? { lastRunSessionId: run.sessionId } : {}),
    };
    const updated = [...tasks];
    updated[index] = next;
    return { tasks: updated, value: next };
  });

  if (!outcome.locked) throw new ScheduledTaskError("lock", "Another process is writing the scheduled tasks file");
  return outcome.value;
}

/**
 * Beansprucht einen faelligen Slot; `true` nur beim ersten Aufruf fuer ihn.
 *
 * Der Vergleich ist `slotMs <= claimedSlotMs`, nicht `===`: ein Slot, der
 * vor dem beanspruchten liegt, ist ebenfalls vorbei. Nach einer
 * Uhrzeitrueckstellung feuert die Aufgabe damit nicht rueckwirkend nach — im
 * Zweifel schweigen, nicht doppelt starten.
 *
 * Der Claim liegt in der Datei, nicht im Speicher. Genau deshalb ueberlebt er
 * einen Neustart und gilt auch fuer eine zweite Instanz. Unbekannte und
 * deaktivierte Aufgaben liefern `false`: sie sind nicht faellig, egal was der
 * Aufrufer rechnet.
 *
 * Eine "keine Sperre" ist ebenfalls `false` und kein Fehler — beim naechsten
 * Tick ist derselbe Slot noch faellig. Nur eine Datei aus einer anderen
 * Schemafassung wirft ({@link ScheduledTaskError} mit `field: "version"`): sie
 * zu ueberschreiben wuerde Felder vernichten, und stillschweigend nichts zu
 * tun waere ein Zeitplan, der nie wieder laeuft.
 */
export function claimRun(identity: WebIdentity, id: string, slotMs: number): boolean {
  if (!Number.isSafeInteger(slotMs) || slotMs < 0) {
    throw new ScheduledTaskError("id", `claimRun needs a whole slot timestamp, got ${slotMs}`);
  }

  const outcome = mutate(identity, (tasks) => {
    const index = tasks.findIndex((task) => task.id === id);
    if (index === -1) return { tasks, value: false };
    const task = tasks[index];
    if (!task.enabled) return { tasks, value: false };
    if (task.claimedSlotMs !== undefined && slotMs <= task.claimedSlotMs) return { tasks, value: false };

    const updated = [...tasks];
    updated[index] = { ...task, claimedSlotMs: slotMs };
    return { tasks: updated, value: true };
  });

  // Keine Sperre bekommen heisst: eine andere Instanz beansprucht gerade.
  // `false` ist hier die richtige Antwort — beim naechsten Tick ist der Slot
  // noch derselbe.
  return outcome.locked ? outcome.value : false;
}
