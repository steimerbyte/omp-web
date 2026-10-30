import { randomUUID } from "crypto";
import { isAbsolute } from "path";
import { listWebAccounts } from "../bin/web-auth-store.js";
import { getUserHome, type WebIdentity } from "./request-identity";
import { startRpcSession } from "./rpc-manager";
import { nextRunAfter, parseSchedule } from "./schedule";
import { readScheduledSettings } from "./scheduled-settings";
import {
  claimRun,
  listTasks,
  markRun,
  type ScheduledTask,
} from "./scheduled-tasks-store";
import { invalidateSessionListCache } from "./session-reader";
import { resolveTenantAgentDir } from "./tenant-config";

/**
 * Der Zeitplaner: welche geplante Aufgabe jetzt faellig ist, und wer sie startet.
 *
 * ### Zwei Teile, ein Modul
 *
 * Die **Entscheidung** ist rein (`selectDueTasks`): sie bekommt Aufgaben und
 * zwei Zeitpunkte und sagt, was faellig ist. Sie hat keinen Timer, kein Netz
 * und kein Dateisystem, also ist die Regel testbar, ohne zu warten.
 *
 * Der **Betrieb** ist ein Prozess-Singleton, das genau *einen* `setTimeout`
 * haelt und ihn nach jedem Tick und nach jeder Aenderung neu stellt.
 *
 * ### Warum ein Timer und nicht einer pro Aufgabe
 *
 * Hundert Aufgaben mit hundert Timern sind hundert Weckrufe, von denen
 * neunundneunzig nichts finden. Ein Timer auf den *naechsten* faelligen Slot
 * ueber alle Konten ist ein Weckruf pro faelligem Slot — und die Frage "wann
 * ist der naechste" ist billig, weil die Zeitplaene das direkt beantworten.
 *
 * ### Was ein Zeitsprung anrichten kann
 *
 * Die Uhr kann springen: NTP zieht sie nach, ein Admin stellt sie, eine VM
 * wird aus dem Standby geweckt. Der Schaden ist bewusst begrenzt und benannt:
 *
 * - **Vorwaerts** (Server war aus, Uhr nachgezogen): die Aufgaben, die in der
 *   Luecke faellig waren, feuern **einmal**, nicht einmal pro verpasstem Slot.
 *   Es gibt keinen Nachholsturm — ein Nachholsturm waere eine Lastspitze
 *   genau in dem Moment, in dem der Server gerade wieder hochkommt.
 * - **Rueckwaerts**: `lastTickMs` wird monoton gehalten (siehe
 *   `advanceCursor`), also feuert nichts, bis die Uhr den alten Stand wieder
 *   erreicht hat. Eine Stunde Rueckwaertssprung heisst: eine Stunde keine
 *   Laeufe. Das ist die stille Richtung, und sie ist die richtige: lieber
 *   einen Lauf verpassen als einen doppelt starten.
 *
 * Was ein Zeitsprung **nicht** kann: denselben Slot zweimal starten. Dafuer
 * sorgt `claimRun` im Speicher, pro Slot und ueber Prozessgrenzen.
 */

/** Was in einem Fenster faellig geworden ist. */
export interface DueRun {
  /** Die Aufgabe, so wie sie im Speicher stand. */
  task: ScheduledTask;
  /** Der Slot, der sie faellig gemacht hat — Epoch-ms, auf die Minute. */
  slotMs: number;
}

/** Das Fenster, in dem Aufgaben faellig werden. */
export interface DueWindow {
  /** Der letzte Zeitpunkt, der schon abgearbeitet ist. */
  lastTickMs: number;
  /** Jetzt. Ein Slot genau auf dieser Minute ist noch faellig. */
  nowMs: number;
}

/**
 * Die Aufgaben, die in `(lastTickMs, nowMs]` einen Slot haben — hoechstens
 * einmal pro Aufgabe, mit dem **ersten** Slot des Fensters.
 *
 * Der erste und nicht der letzte Slot ist die Entscheidung gegen den
 * Nachholsturm: sechs Stunden Ausfall bei einem Viertelstundenplan ergeben
 * einen Lauf, nicht vierundzwanzig. Der Lauf selbst weiss nicht, dass er
 * spaet dran ist — er holt nicht nach, er laeuft.
 *
 * Eine Aufgabe, deren Cron nicht mehr lesbar ist, wird uebersprungen statt zu
 * werfen: eine kaputte Zeile darf den Tick fuer alle anderen nicht anhalten.
 * (Der Speicher laesst so eine Zeile gar nicht erst durch; das hier ist die
 * zweite Schicht fuer einen Aufrufer, der seine Aufgaben selbst baut.)
 */
export function selectDueTasks(tasks: readonly ScheduledTask[], window: DueWindow): DueRun[] {
  const { lastTickMs, nowMs } = window;
  // Eine Uhr, die rueckwaerts gesprungen ist, hat kein Fenster. `<=` und nicht
  // `===`: ein Fenster der Laenge null ist leer, kein Fehler.
  if (!Number.isFinite(lastTickMs) || !Number.isFinite(nowMs) || nowMs <= lastTickMs) return [];

  const due: DueRun[] = [];
  for (const task of tasks) {
    if (!task.enabled) continue;
    let slotMs: number;
    try {
      slotMs = nextRunAfter(parseSchedule(task.cron), lastTickMs);
    } catch {
      continue;
    }
    if (slotMs <= nowMs) due.push({ task, slotMs });
  }
  // Reihenfolge nach Faelligkeit, damit zwei Aufgaben, die im selben Fenster
  // faellig sind, in einer vorhersagbaren Reihenfolge starten.
  return due.sort((a, b) => a.slotMs - b.slotMs || a.task.id.localeCompare(b.task.id));
}

/**
 * Der naechste Slot **nach** `afterMs` ueber alle Aufgaben, oder `null`.
 *
 * Deaktivierte Aufgaben und unlesbare Zeitplaene zaehlen nicht: sie koennen
 * keinen Timer rechtfertigen. Erkannt wird nur der Zeitpunkt, nicht die
 * Aufgabe — der Tick liest die Aufgaben ohnehin neu, und ein zwischenzeitlich
 * geaenderter Plan wird dadurch von selbst richtig.
 */
export function nextWakeupMs(tasks: readonly ScheduledTask[], afterMs: number): number | null {
  let earliest: number | null = null;
  for (const task of tasks) {
    if (!task.enabled) continue;
    let slotMs: number;
    try {
      slotMs = nextRunAfter(parseSchedule(task.cron), afterMs);
    } catch {
      continue;
    }
    if (earliest === null || slotMs < earliest) earliest = slotMs;
  }
  return earliest;
}

/**
 * Die Obergrenze fuer einen einzelnen Timer.
 *
 * `setTimeout` kann nicht beliebig weit in die Zukunft gestellt werden, und
 * eine Aufgabe, deren naechster Slot Monate entfernt liegt, soll den Prozess
 * nicht daran hindern, eine von aussen geaenderte Datei zu bemerken. Eine
 * Stunde ist der Kompromiss: hoechstens ein Weckruf und ein Dateilesevorgang
 * pro Konto und Stunde, auch wenn gar nichts faellig ist.
 *
 * Der Wert ist konstant und geprueft (`lib/scheduler.test.mjs`), weil er eine
 * Zahl in einem Kommentar ist.
 */
export const MAX_TIMER_DELAY_MS = 60 * 60 * 1000;

/** Der Zeitplaner haengt an `globalThis`, damit ein Hot-Reload keinen zweiten startet. */
interface SchedulerState {
  /** Der eine Timer, oder `undefined`, wenn keiner gestellt ist. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** `true`, sobald `startScheduler` einmal gelaufen ist. */
  started: boolean;
  /** Der letzte abgearbeitete Zeitpunkt. Monoton, siehe `advanceCursor`. */
  cursorMs: number;
  /** `true`, solange ein Tick laeuft — ein zweiter wuerde dieselben Slots sehen. */
  ticking: boolean;
}

declare global {
  /**
   * `globalThis` und nicht eine Modulvariable: `AGENTS.md` verlangt das fuer
   * Prozess-Singletons, weil der Dev-Server Module bei jeder Aenderung neu
   * laedt und eine Modulvariable danach leer ist — hier waere das ein zweiter
   * Timer neben dem ersten.
   */
  var __ompScheduler: SchedulerState | undefined;
}

function getState(): SchedulerState {
  globalThis.__ompScheduler ??= { timer: undefined, started: false, cursorMs: Date.now(), ticking: false };
  return globalThis.__ompScheduler;
}

/**
 * Den Zeiger vorziehen, aber nie zuruecksetzen.
 *
 * Das ist die ganze Behandlung eines Rueckwaertssprungs der Uhr: der Zeiger
 * bleibt stehen, das Fenster ist leer, und es feuert nichts, bis die Uhr ihn
 * wieder eingeholt hat. Ein Zeiger, der mit der Uhr zurueckgeht, wuerde jeden
 * Slot zwischen alter und neuer Zeit ein zweites Mal faellig machen.
 */
function advanceCursor(state: SchedulerState, nowMs: number): number {
  const previous = state.cursorMs;
  if (nowMs > previous) state.cursorMs = nowMs;
  return previous;
}

/**
 * Die Identitaeten, deren Aufgabendateien der Tick liest.
 *
 * ### Warum der Zeitplaner die Konten selbst aufzaehlen muss
 *
 * Jeder Speicher dieser Anwendung haengt an einer `WebIdentity`, und ein Timer
 * hat keinen Request, aus dem er eine lesen koennte (Karte R3). Die Liste steht
 * deshalb in `omp-web-accounts.json`, gelesen ueber `listWebAccounts` — dieselbe
 * Quelle, aus der `proxy.ts` die Rolle ableitet.
 *
 * Dazu kommt das Agent-Verzeichnis des **Prozesses**: eine Installation ohne
 * Kontendatei (oder der Betreiber, der keinen Eintrag hat) legt seine Aufgaben
 * dort ab. `resolveTenantAgentDir` bildet fuer einen Admin genau dieses
 * Verzeichnis, also ist die synthetische Admin-Identitaet kein Sonderweg,
 * sondern derselbe Pfad.
 *
 * Doppelte Verzeichnisse fallen weg: ein Admin-Konto *ist* das
 * Prozessverzeichnis, und zweimal dieselbe Datei zu lesen wuerde dieselbe
 * Aufgabe zweimal starten wollen — der Claim faengt es ab, aber die zweite
 * Lesung waere trotzdem unsinnig.
 */
export function listScheduleIdentities(env: NodeJS.ProcessEnv = process.env): WebIdentity[] {
  const identities: WebIdentity[] = [];
  const seen = new Set<string>();

  const add = (identity: WebIdentity): void => {
    const dir = resolveTenantAgentDir(identity);
    if (seen.has(dir)) return;
    seen.add(dir);
    identities.push(identity);
  };

  let accounts: ReturnType<typeof listWebAccounts>["accounts"] = [];
  try {
    accounts = listWebAccounts({ env }).accounts;
  } catch (error) {
    // Eine unlesbare Kontendatei darf den Zeitplaner nicht anhalten — das
    // Prozessverzeichnis wird trotzdem gelesen.
    console.error("[scheduler] the account list could not be read:", error);
  }
  for (const account of accounts) {
    if (!account.enabled) continue;
    add({ username: account.username, isAdmin: account.isAdmin });
  }

  // Der Betreiber des Prozesses. `isAdmin` ist hier kein Recht, das jemand
  // bekommt: die Identitaet entsteht im Timer, nicht in einem Request, und
  // dient nur dazu, das Prozess-Agent-Verzeichnis zu benennen.
  add({ username: env.USER ?? "operator", isAdmin: true });

  return identities;
}

/**
 * Das Arbeitsverzeichnis eines Laufs.
 *
 * Die Reihenfolge ist die der Frage "was hat der Nutzer gemeint": die Angabe an
 * *dieser* Aufgabe schlaegt die Voreinstellung des Kontos ("Arbeitsordner" in
 * den Einstellungen), und erst wenn beides fehlt, die Home des Kontos. Damit
 * ist die Konto-Einstellung ein Default im Wortsinn: sie aendert jede Aufgabe,
 * die keine eigene Angabe hat, und keine, die eine hat.
 *
 * Die eine Stelle fuer beide Wege — der Durchlauf und `runTaskNow` rufen
 * dieselbe Funktion. Ein zweiter Aufloeser wuerde frueher oder spaeter eine
 * andere Reihenfolge haben, und dann startete der Handstart in einem anderen
 * Verzeichnis als der Zeitplan.
 *
 * `readScheduledSettings` wirft nicht und liefert `null` fuer eine kaputte
 * Datei: eine unlesbare *Vorliebe* darf den Lauf nicht verhindern, sie faellt
 * auf die Home zurueck.
 */
function runCwd(identity: WebIdentity, task: ScheduledTask): string {
  return task.cwd ?? readScheduledSettings(identity).defaultCwd ?? getUserHome(identity);
}

/**
 * Eine Aufgabe starten: neue Session, Prompt, Lauf vermerken.
 *
 * ### Warum jede Ausfuehrung eine eigene Session ist
 *
 * Eine geplante Aufgabe ist ein eigener Lauf mit eigenem Kontext. Sie in eine
 * bestehende Session zu schreiben haette zwei Folgen, die beide falsch sind:
 * sie wuerde den Verlauf eines Menschen mitten im Gespraech unterbrechen (und
 * `send({type:"prompt"})` wirft sogar, solange dort ein Shell-Befehl laeuft,
 * Karte R9), und der Nutzer saehe die Antwort in einem Kontext, den er nicht
 * bestellt hat. Eine frische Session ist auch der Grund, warum der
 * Leerlauf-Reaper (Karte R8) hier kein Gegner ist: die Session entsteht mit
 * dem Prompt und wird nach ihren zehn Minuten Leerlauf abgeraeumt wie jede
 * andere.
 *
 * ### Warum `owner` mitgegeben wird
 *
 * Ohne `owner` schreibt `startRpcSession` den Leerstring als Besitzer, und
 * `isRpcSessionVisibleTo` findet dann fuer keinen Mieter einen Treffer — die
 * Session waere fuer ihr eigenes Konto unsichtbar, waehrend sie laeuft (Karte
 * R4). Der Besitz ist ein Name, keine Rolle: auch ein Admin besitzt seine
 * Session unter seinem eigenen Namen.
 */
/**
 * Der Start einer Session — als Parameter, nicht als feste Abhaengigkeit.
 *
 * Der Grund ist der Test: `runTaskNow` soll pruefen, *dass* der Handstart
 * denselben Weg nimmt und `claimedSlotMs` stehen laesst, ohne dafuer eine
 * echte Session mit Modell und SDK zu oeffnen. Ein `mock.module` waere der
 * falsche Weg — es ist prozessweit und laesst sich nicht zuruecknehmen, also
 * vergiftet es Testdateien, die dasselbe Modul spaeter brauchen (gemessen:
 * sieben fremde Tests wurden rot). Der Standardwert ist der echte Start; die
 * Signatur bleibt fuer jeden Aufrufer im Produktionscode unveraendert.
 */
type SessionStarter = typeof startRpcSession;

async function runTask(identity: WebIdentity, task: ScheduledTask, starter: SessionStarter = startRpcSession): Promise<{ sessionId: string }> {
  const cwd = runCwd(identity, task);
  // Eine eigene Kennung pro Lauf: `startRpcSession` fasst Aufrufer mit
  // derselben Kennung zu *einer* Session zusammen.
  const { session, realSessionId } = await starter(`__scheduled__${randomUUID()}`, "", cwd, {
    initialModel: { provider: task.provider, modelId: task.modelId },
    ...(task.thinkingLevel ? { thinkingLevel: task.thinkingLevel } : {}),
    identity,
    owner: identity.username,
  });
  await session.send({ type: "prompt", message: task.prompt });
  markRun(identity, task.id, { at: Date.now(), sessionId: realSessionId, status: "ok" });
  // Die neue Sitzung soll in der Verlaufsliste des Kontos sofort auftauchen
  // und nicht erst nach Ablauf des Listen-Caches.
  invalidateSessionListCache();
  return { sessionId: realSessionId };
}

/**
 * Eine Aufgabe sofort starten — der Weg hinter dem Knopf "Jetzt ausfuehren".
 *
 * Es ist derselbe `runTask` wie im Durchlauf: eine zweite Fassung wuerde
 * frueher oder spaeter anders starten als der Zeitplan (Kennung, Besitzer,
 * Modell, Cache), und dann liefe der Handstart nicht mehr dieselbe Sache.
 *
 * **Kein `claimRun`.** Ein Handstart darf keinen Slot beanspruchen und keinen
 * verschieben: `claimedSlotMs` ist die Behauptung "diesen faelligen Slot hat
 * schon jemand gestartet", und ein Klick um 07:59 darf den Slot um 08:00
 * nicht verschlucken. Deshalb bleibt der naechste geplante Lauf, was er ohne
 * den Klick gewesen waere.
 *
 * Anders als der Durchlauf schluckt diese Fassung den Fehler nicht: der Fehler
 * geht an den Aufrufer, der ihn als Status zeigen kann. Vermerkt wird er in
 * beiden Faellen — `lastRunStatus: "error"` ist die Wahrheit ueber den Lauf,
 * auch wenn er nicht fahrplanmaessig war.
 */
export async function runTaskNow(
  identity: WebIdentity,
  task: ScheduledTask,
  starter: SessionStarter = startRpcSession,
): Promise<{ sessionId: string }> {
  try {
    return await runTask(identity, task, starter);
  } catch (error) {
    try {
      markRun(identity, task.id, { at: Date.now(), status: "error" });
    } catch (markError) {
      console.error(`[scheduler] task ${task.id}: the failed run could not be recorded:`, markError);
    }
    throw error;
  }
}

/**
 * Ein Durchlauf: alles lesen, Faelliges beanspruchen, starten.
 *
 * Die Reihenfolge ist die Sicherheit: **erst** `claimRun`, **dann** starten.
 * Andersherum wuerden zwei Prozesse beide starten und der zweite Claim nur
 * noch den Schaden feststellen. Der Claim ist die Behauptung "dieser Slot
 * gehoert mir"; wer sie nicht bekommt, startet nicht.
 *
 * Ein Fehler bei einer Aufgabe beendet den Durchlauf nicht: die naechste
 * Aufgabe hat damit nichts zu tun, und ein einzelner kaputter Eintrag darf
 * nicht der Grund sein, dass alle anderen nie laufen. Der Fehler wird
 * geschluckt, als `lastRunStatus: "error"` vermerkt, und die Zaehlung steigt
 * nicht — der Tick meldet die Zahl der **erfolgreichen** Starts.
 *
 * `starter` und `identities` sind dieselben Test-Parameter wie bei
 * `runTaskNow`: der Betrieb uebergibt sie nie, also laeuft hier der echte
 * Session-Start ueber alle Konten. `identities` erspart dem Test, `USER` und
 * `PI_CODING_AGENT_DIR` zu verbiegen — die sind prozessweit, wuerden also
 * jede parallel laufende Testdatei mitverstellen.
 */
export async function runSchedulerTick(
  window: DueWindow,
  starter: SessionStarter = startRpcSession,
  identities: readonly WebIdentity[] = listScheduleIdentities(),
): Promise<number> {
  let started = 0;
  for (const identity of identities) {
    let tasks: ScheduledTask[];
    try {
      tasks = listTasks(identity);
    } catch (error) {
      console.error(`[scheduler] the task file of ${identity.username} could not be read:`, error);
      continue;
    }
    for (const { task, slotMs } of selectDueTasks(tasks, window)) {
      let claimed: boolean;
      try {
        claimed = claimRun(identity, task.id, slotMs);
      } catch (error) {
        console.error(`[scheduler] task ${task.id} could not be claimed:`, error);
        continue;
      }
      if (!claimed) continue;
      try {
        await runTask(identity, task, starter);
        started += 1;
      } catch (error) {
        // Hier wird der Fehler geschluckt, nicht weitergereicht: ein einzelner
        // kaputter Eintrag darf den Durchlauf nicht beenden.
        console.error(`[scheduler] task ${task.id} of ${identity.username} failed to start:`, error);
        try {
          markRun(identity, task.id, { at: Date.now(), status: "error" });
        } catch (markError) {
          console.error(`[scheduler] task ${task.id}: the failed run could not be recorded:`, markError);
        }
      }
    }
  }
  return started;
}

/** Die Aufgaben aller Konten, fuer die naechste Weckzeit. */
function readAllTasks(): ScheduledTask[] {
  const tasks: ScheduledTask[] = [];
  for (const identity of listScheduleIdentities()) {
    try {
      tasks.push(...listTasks(identity));
    } catch {
      // Ein unlesbares Konto traegt zu "wann ist der naechste Slot" nichts bei.
    }
  }
  return tasks;
}

/**
 * Den einen Timer neu stellen.
 *
 * Wird nach jedem Tick und nach jeder Aenderung ueber die API aufgerufen. Die
 * Neuberechnung liest die Aufgaben neu — ein geaenderter Zeitplan wirkt damit
 * sofort und nicht erst beim naechsten Weckruf.
 */
export function rescheduleScheduler(): void {
  const state = getState();
  if (!state.started) return;
  clearTimeout(state.timer);
  state.timer = undefined;

  const nowMs = Date.now();
  const next = nextWakeupMs(readAllTasks(), nowMs);
  if (next === null) return;
  // Ein Slot in der Vergangenheit (die Uhr stand still) wird sofort
  // abgearbeitet, nicht in negativer Zeit.
  const delay = Math.min(Math.max(next - nowMs, 0), MAX_TIMER_DELAY_MS);

  state.timer = setTimeout(() => {
    state.timer = undefined;
    void tick();
  }, delay);
  // Der Timer darf den Prozess nicht am Beenden hindern.
  state.timer.unref?.();
}

/** Ein Tick, der nie wirft und danach den Timer neu stellt. */
async function tick(): Promise<void> {
  const state = getState();
  // Zwei Ticks gleichzeitig wuerden dasselbe Fenster sehen und dieselben
  // Aufgaben bearbeiten; der Claim faengt es ab, aber die doppelte Arbeit
  // ist unnoetig.
  if (state.ticking) return;
  state.ticking = true;
  try {
    const nowMs = Date.now();
    const lastTickMs = advanceCursor(state, nowMs);
    await runSchedulerTick({ lastTickMs, nowMs });
  } catch (error) {
    // Ein Tick, der wirft, wuerde den Timer nicht neu stellen — und dann waere
    // der Zeitplaner still tot, ohne dass es jemand merkt.
    console.error("[scheduler] the tick failed:", error);
  } finally {
    state.ticking = false;
    rescheduleScheduler();
  }
}

/**
 * Den Zeitplaner starten — idempotent.
 *
 * Der Aufruf kommt aus `instrumentation.ts`, also beim Prozessstart, und darf
 * **nicht** werfen: ein kaputter Zeitplaner darf die Oberflaeche nicht am
 * Starten hindern. Ein zweiter Aufruf (Hot-Reload, ein zweiter Import) ist ein
 * No-op, weil `started` auf `globalThis` steht.
 */
export function startScheduler(): void {
  const state = getState();
  if (state.started) return;
  state.started = true;
  state.cursorMs = Date.now();
  rescheduleScheduler();
}

/** Den Zeitplaner anhalten. Nur fuer Tests und das Herunterfahren. */
export function stopScheduler(): void {
  const state = getState();
  clearTimeout(state.timer);
  state.timer = undefined;
  state.started = false;
}

/** `true`, solange ein Timer gestellt ist. Nur fuer Tests. */
export function isSchedulerArmed(): boolean {
  return getState().timer !== undefined;
}

/**
 * Der naechste geplante Zeitpunkt aller Aufgaben, fuer die Listenansicht.
 *
 * `null` heisst "keine aktive Aufgabe" — nicht "unbekannt". Die Route rechnet
 * ihn pro Aufgabe selbst; diese Funktion ist fuer den Fall, dass jemand den
 * naechsten Weckruf des Prozesses anzeigen will.
 */
export function nextScheduledRunMs(afterMs = Date.now()): number | null {
  return nextWakeupMs(readAllTasks(), afterMs);
}

/** Prueft, ob ein Arbeitsverzeichnis als Aufgaben-`cwd` taugt: absolut und nicht leer. */
export function isUsableTaskCwd(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value !== "" && isAbsolute(value);
}
