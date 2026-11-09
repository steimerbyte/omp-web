import { chmodSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { AgentSessionLike, GoalRuntimeLike } from "./omp-types";
import { getOmpRuntime, getSettingsForIdentity } from "./omp-runtime";
import { getUserHome, type WebIdentity } from "./request-identity";
import { tenantSessionsRoot, tightenTenantSessionTree } from "./tenant-sessions";
import type { TenantWorker } from "./tenant-worker";

/**
 * Die Sitzung eines Mandanten, gehostet in seinem Worker.
 *
 * ### Warum diese Klasse ueberhaupt existiert
 *
 * `AgentSessionWrapper` (lib/rpc-manager.ts) ist die Form, die jede Route,
 * jeder SSE-Strom und jede Werkzeugleiste erwartet: `send(type)`, `isAlive()`,
 * `subscribe()` und `inner` fuer die Zustandsabfragen. Sie ist aber gebaut um
 * eine **In-Process**-`AgentSession` (`new AgentSessionWrapper(inner, bus)`).
 * Fuer einen Worker gibt es diese `inner` nicht — die Session lebt im
 * Kindprozess.
 *
 * Diese Klasse fuellt die Luecke: sie implementiert `AgentSessionLike` so,
 * dass der bestehende Wrapper unveraendert weiterlaeuft, und leitet jeden
 * **veraendernden** Aufruf ueber RPC an den Worker. Das ist bewusst kein
 * nachgebauter Agent — es ist ein Transport-Stellvertreter.
 *
 * ### Was lokal und was im Worker passiert
 *
 * | Aufruf | Wo | Warum |
 * |---|---|---|
 * | `prompt`, `steer`, `followUp`, `abort`, `compact`, `executeBash`, `setModel`, `setThinkingLevel`, `navigateTree`, `branch`, `handoff`, `setAutoCompactionEnabled`, `setAutoRetryEnabled` | Worker (`RpcClient`) | Das ist die Session; sie gehoert in die Grenze |
 * | `subscribe` | Worker (`client.onEvent`) | Die Frames kommen aus dem Kindprozess |
 * | `sessionManager`, `settings`, `modelRegistry` | lokal | Lesezugriff auf das **Archiv des Mandanten**. Der Server darf es lesen (die Grenze schuetzt den Agenten, nicht den Server), und ein zweiter `SessionManager` auf derselben Datei ist billiger als jede Zustandskopie |
 * | `extensionRunner`, `goalRuntime`, `asyncJobManager` | `undefined` | Sie existieren nur in einem Prozess mit `createAgentSession`; ein Ersatz waere eine Attrappe und wuerde Zusagen vortaeuschen (§5 des Plans: keine Behauptung ohne Deckung) |
 *
 * ### Was bewusst `undefined` ist, und was das kostet
 *
 * `goalRuntime` und `asyncJobManager` fehlen. Goal-Modus und Vibe-Modus
 * funktionieren fuer eine Worker-Session deshalb nicht — sie brauchen den
 * `GoalRuntime` des Prozesses, der die Session fuehrt. Das ist eine
 * **Einschraenkung, keine Attrappe**: die Regler melden "nicht verfuegbar",
 * statt in einem Serverprozess-Goal zu laufen, das die Session im Worker nie
 * sieht. Ein nachgebauter `GoalRuntime` waere schlimmer als keiner.
 *
 * Die uebrigen optionalen Mitglieder (`planMode`, `skills`,
 * `slashCommands`) bleiben `undefined`; die Aufrufer pruefen sie bereits mit
 * `?.`, weil sie auch fuer eine In-Process-Session optional sind.
 */

/** Was eine Worker-Session ueber ihre Grenze sagt. */
export interface WorkerSessionBoundary {
  kind: "tenant-worker";
  enforced: boolean;
  pid?: number;
}

const GOAL_UNAVAILABLE = "Goal mode is not available for a worker-hosted session: it needs the GoalRuntime of the process that hosts the session.";

/**
 * Ein `GoalRuntime`, dessen jede Methode den benannten Fehler wirft.
 *
 * Nicht `undefined`, weil der Typ es nicht zulaesst, und nicht ein
 * funktionierender Ersatz, weil es den nicht gibt: der Goal-Zustand liegt im
 * Worker. So bleibt der Aufrufer in seinem bestehenden `try`/`catch`, und der
 * Fehler sagt, was fehlt, statt dass eine Attrappe Erfolg meldet.
 */
const unavailableGoalRuntime = {
  async createGoal(): Promise<never> { throw new Error(GOAL_UNAVAILABLE); },
  async replaceGoal(): Promise<never> { throw new Error(GOAL_UNAVAILABLE); },
  async resumeGoal(): Promise<never> { throw new Error(GOAL_UNAVAILABLE); },
  async pauseGoal(): Promise<never> { throw new Error(GOAL_UNAVAILABLE); },
  async dropGoal(): Promise<never> { throw new Error(GOAL_UNAVAILABLE); },
  async onThreadResumed(): Promise<never> { throw new Error(GOAL_UNAVAILABLE); },
  async onBudgetMutated(): Promise<never> { throw new Error(GOAL_UNAVAILABLE); },
  buildContinuationPrompt(): string | undefined { throw new Error(GOAL_UNAVAILABLE); },
  clearAccounting(): void { throw new Error(GOAL_UNAVAILABLE); },
} satisfies GoalRuntimeLike;

export interface WorkerBackedSessionOptions {
  worker: TenantWorker;
  identity: WebIdentity;
  /** Das Session-Archiv dieses Kontos (`<tenantAgentDir>/sessions`). */
  sessionDir: string;
  /** Der cwd des Mandanten, wie er **im Server** gilt (Host-Pfad). */
  hostCwd: string;
  /**
   * Ein bestehendes Archiv, das der Worker oeffnen soll.
   *
   * Ein Worker hostet **alle** Sessions eines Kontos (`RpcClient.switchSession`
   * ist der dafuer vorgesehene Befehl). Ohne diesen Schritt wuerde jeder
   * `/api/agent/<id>`-Aufruf eine frische Session bauen und das bestehende
   * Transcript nie sehen — gemessen ist das der Unterschied zwischen "Chat
   * fortsetzen" und "Chat verlieren".
   */
  sessionFile?: string;
}


/** Der Gast-Pfad des Session-Verzeichnisses eines Kontos. */
export function guestSessionDir(identity: WebIdentity): string {
  return `/home/${identity.username}/.omp/agent/sessions`;
}

/**
 * Vom Host-Pfad zum Gast-Pfad — die Umkehrung von {@link toHostPath}.
 *
 * `null` statt einer Vermutung, aus demselben Grund: ein Pfad ausserhalb des
 * Konto-Homes ist kein Mandanten-Pfad, und der Worker wuerde ihn in seiner
 * Namespace ohnehin nicht finden.
 */
export function toGuestPath(hostPath: string | undefined, identity: WebIdentity): string | null {
  if (typeof hostPath !== "string" || hostPath.length === 0) return null;
  const hostHome = getUserHome(identity);
  const guestHome = `/home/${identity.username}`;
  if (hostPath === hostHome) return guestHome;
  if (!hostPath.startsWith(`${hostHome}/`)) return null;
  return `${guestHome}/${hostPath.slice(hostHome.length + 1)}`;
}

/**
 * Vom Gast-Pfad eines Workers zum Host-Pfad — oder `null`.
 *
 * Der Worker laeuft in einer Namespace, in der sein Konto-Home
 * `/home/<name>` heisst. Auf dem Host ist dasselbe Verzeichnis
 * `getUserHome(identity)`. Jeder Pfad, den der Worker meldet, muss durch diese
 * Abbildung, bevor der Server ihn anfasst.
 *
 * `null` statt einer Vermutung: ein Pfad ausserhalb des Gast-Homes ist kein
 * Mandanten-Pfad, und ihn trotzdem zu uebersetzen hiesse, den naechsten
 * zufaelligen String als Datei zu oeffnen. Der Aufrufer entscheidet, ob das ein
 * Fehler ist — hier ist es einer.
 */
export function toHostPath(guestPath: string | undefined, identity: WebIdentity): string | null {
  if (typeof guestPath !== "string" || guestPath.length === 0) return null;
  const guestHome = `/home/${identity.username}`;
  const hostHome = getUserHome(identity);
  if (guestPath === guestHome) return hostHome;
  if (!guestPath.startsWith(`${guestHome}/`)) return null;
  return join(hostHome, guestPath.slice(guestHome.length + 1));
}

/**
 * Ein `AgentSessionLike` ueber einen Worker.
 *
 * Der Konstruktor ist absichtlich `async`, weil er den `SessionManager` auf
 * dem Archiv oeffnen muss: `SessionManager.open` liest die Datei, und deren
 * Kopfzeile traegt `sessionId` und `cwd`. Ein Objekt ohne diesen Manager waere
 * fuer `getRpcSessionInfos` (Titel, Nachrichtenzahl, Modell) blind.
 */
export async function createWorkerBackedSession(
  options: WorkerBackedSessionOptions,
): Promise<AgentSessionLike & { boundary: WorkerSessionBoundary }> {
  const { worker, identity } = options;
  const client: RpcClient = worker.client;

  // Ein bestehendes Transcript zuerst oeffnen: der Worker laeuft schon, aber
  // seine Session ist die zuletzt geoeffnete. Genau das ist die Zusage
  // "Granularitaet ist der Mandant, nicht die Session" (Plan §7 L1): ein
  // Worker, viele Chats, umgeschaltet per RPC statt per Neustart.
  if (options.sessionFile) {
    const switched = await client.switchSession(toGuestPath(options.sessionFile, identity) ?? options.sessionFile);
    if (switched.cancelled) {
      throw new Error(`The worker refused to open ${options.sessionFile} (cancelled).`);
    }
  } else {
    // Eine **neue** Session muss der Worker anlegen, nicht der Server.
    //
    // `getState()` allein legt nichts an: das SDK vergibt `sessionFile` beim
    // Start, schreibt die Datei aber erst beim ersten Eintrag. Gemessen am
    // 2026-11-08: der Worker meldete einen Pfad, die Datei existierte nicht,
    // und der Server haette sie — mit seiner eigenen umask — angelegt.
    // `open_session` mit dem Gast-Verzeichnis ist der RPC-Weg dafuer: er
    // erzeugt die Session **im Worker** und persistiert sie dort (rpc-mode.ts:
    // `openRpcSession`, `session.sessionFile`), mit der umask des Workers
    // (0077). Danach ist der Pfad real und gehoert dem Mandanten.
    await client.openSession(guestSessionDir(identity));
  }
  const state = await client.getState();

  // Der Manager zeigt auf das **Archiv des Mandanten**, nicht auf das
  // Prozessverzeichnis. Das ist derselbe Pfad, den der Worker beschreibt, und
  // damit derselbe Inhalt — nur aus der Sicht des Servers gelesen.
  //
  // Wichtig: hier wird **keine** neue Datei angelegt. Der Worker hat die
  // Session erzeugt (oder geoeffnet), also ist `sessionFile` gesetzt, sobald
  // das SDK geschrieben hat. Ein `SessionManager.create` an dieser Stelle
  // wuerde eine **zweite** Datei im Serverprozess anlegen — mit der umask des
  // Servers (0022) und damit 0644, obwohl der Worker 0077 faehrt. Gemessen am
  // 2026-11-08: genau das war der Grund, warum `3e` trotz korrektem Worker
  // weiter 644 meldete. Fehlt der Pfad, ist das ein Fehler und keine Datei.
  // Der Worker meldet den **Gast**-Pfad (`/home/<name>/...`), der Server
  // braucht den **Host**-Pfad. Das ist derselbe Pfad hinter dem Bind-Mount,
  // aber ein anderer String — und `existsSync` auf dem Gast-Pfad liefert
  // `false`, weil `/home/<name>` auf diesem Host nicht der Mandant ist.
  // Gemessen am 2026-11-08: ohne diese Abbildung meldete der Server "worker
  // reported no session file" und legte gar keine Session an.
  //
  // Die Abbildung ist bewusst eine Funktion und kein `replace`: sie prueft die
  // Wurzel und gibt `null` statt zu raten (`toHostPath`-Vertrag aus §7 L4).
  const sessionFile = toHostPath(state.sessionFile, identity);
  if (sessionFile === null) {
    throw new Error(
      `The worker reported session file ${String(state.sessionFile)}, which is not inside the tenant's guest home; refusing to touch it.`,
    );
  }
  // Die Datei muss **nicht** existieren. Das SDK vergibt den Pfad beim Anlegen
  // und schreibt ihn erst mit dem ersten Eintrag — gemessen am 2026-11-08:
  // `open_session` meldete einen Pfad, das Verzeichnis blieb leer, bis der
  // erste Turn kam. Ein `existsSync`-Zwang hier haette jede frische Session
  // abgewiesen (und genau das tat er auch, bevor diese Zeile korrigiert wurde).
  //
  // Die Zusage, die bleibt: der Server legt die Datei **nicht** an. Er oeffnet
  // sie nur, wenn es sie gibt; sonst haelt er einen Manager ohne Datei und
  // liest sie, sobald das SDK sie geschrieben hat. Damit entsteht der
  // Transcript immer im Worker — mit dessen umask.
  // Der Manager zeigt auf **genau den Pfad, den der Worker gemeldet hat** —
  // kein zweiter Transcript, sondern dieselbe Datei. Existiert sie noch nicht
  // (das SDK schreibt sie erst mit dem ersten Eintrag), legt `create` sie an
  // dieser Stelle an; der Worker haengt seinen ersten Eintrag daran an.
  //
  // Der Modus ist der Punkt: `create` benutzt die umask **dieses** Prozesses
  // (0022), und die Datei kaeme als 0644 heraus, obwohl der Worker 0077 faehrt.
  // Deshalb wird der Modus sofort nachgezogen — und danach noch einmal, weil
  // ein spaeterer `open(O_CREAT)` durch das SDK den bestehenden Modus nicht
  // aendert, aber ein neu angelegtes Verzeichnis schon.
  // `SessionManager.open` legt eine fehlende Datei **an genau diesem Pfad** an
  // (gemessen am 2026-11-08: `open(<verzeichnis>/x.jsonl)` erzeugte x.jsonl,
  // waehrend `create` einen eigenen Zeitstempel-Namen waehlt). Damit ist der
  // Manager derselbe Transcript wie der des Workers und nicht ein zweiter.
  //
  // `initialCwd` ist **nicht** optional. Ohne die Angabe faellt `open` auf
  // `getProjectDir()` zurueck, und das ist der cwd des *Serverprozesses* —
  // gemessen am 2026-11-08: die Kopfzeile einer Mandanten-Session trug
  // `/home/pi/workspace/omp-web-iso` statt des Mandanten-Homes. Der `cwd` aus
  // der Kopfzeile ist kein Anzeigefeld: `getRpcSessionInfos` reicht ihn als
  // `SessionInfo.cwd` heraus, `attachSessionProjectInfo` macht daraus den
  // `projectRoot`, und `getAllowedFileRoots` (lib/file-access.ts:46-49) nimmt
  // **jeden** `cwd` der Session-Liste als erlaubte Datei-Wurzel. Ein Mandant
  // haette damit das Quellbaum-Verzeichnis des Betreibers als Wurzel bekommen
  // und ueber `/api/files` lesen koennen — gemessen: mit dem falschen Header
  // `roots: ["/home/pi/workspace/omp-web-iso", "<tenant home>"]`, danach `true`
  // fuer `package.json`; mit dieser Zeile bleibt es bei `[<tenant home>]`.
  //
  // Genommen wird `options.hostCwd`, also der **Host**-Pfad des Kontos, und
  // nicht der Gast-Pfad `/home/<name>`: der Besitz einer Session wird aus ihrem
  // `cwd` abgeleitet (`isSessionOwnedBy` in `lib/session-reader.ts`, gegen
  // `getUserHome(identity)`), und ein Gast-Pfad existiert auf diesem Host nicht
  // — die Session waere fuer ihr eigenes Konto unsichtbar. Der Gast-Pfad bleibt
  // der Vertrag fuer alles, was **im** Worker laeuft (§9); die Kopfzeile
  // beschreibt dagegen die Sicht des Servers auf dieselbe Datei.
  const manager = await SessionManager.open(sessionFile, undefined, undefined, {
    initialCwd: options.hostCwd,
  });
  // Modus nachziehen: `open` legt mit der umask dieses Prozesses an (0022 ->
  // 0644). Der Worker faehrt 0077, aber diese Datei entsteht hier. Ein `chmod`
  // auf eine gerade angelegte Datei ist kein Rennen; das Verzeichnis bleibt
  // 0700 und wird von `tightenTenantSessionTree` mitgeprueft.
  try { chmodSync(sessionFile, 0o600); } catch { /* 3e misst den Rest */ }
  // Die umask des Workers (0077, siehe `planTenantWorker`) gilt fuer seine
  // eigenen `open(O_CREAT)`-Aufrufe. Der `.jsonl`-Writer des SDK oeffnet die
  // Datei aber ohne Modus, und ob die umask dort greift, haengt daran, welcher
  // Prozess sie zuerst anlegt — gemessen am 2026-11-08 legte der Server sie mit
  // 0644 an, als er noch selbst eine Datei erzeugte. Deshalb wird der Modus
  // hier einmal nachgezogen: derselbe Schnitt wie in `startRpcSession` fuer den
  // In-Process-Pfad, nur an der Stelle, an der die Datei wirklich entsteht.
  tightenTenantSessionTree(sessionFile.slice(0, sessionFile.lastIndexOf("/")));
  const runtime = await getOmpRuntime();
  const settings = await getSettingsForIdentity(identity, options.hostCwd);

  const listeners = new Set<(event: never) => void>();
  const unsubscribeClient = client.onEvent((event) => {
    for (const listener of listeners) (listener as (value: unknown) => void)(event);
  });

  const session: AgentSessionLike & { boundary: WorkerSessionBoundary } = {
    boundary: worker.boundary.enforced
      ? { kind: "tenant-worker", enforced: true, pid: worker.pid }
      : { kind: "tenant-worker", enforced: false },

    get sessionId() { return state.sessionId; },
    // Der Host-Pfad, nicht der Gast-Pfad: der Server oeffnet diese Datei
    // (`SessionManager.open`) und schreibt sie in die Session-Liste. Ein
    // Gast-Pfad waere hier ein Pfad, den es auf diesem Host nicht gibt.
    get sessionFile() { return sessionFile; },
    // Die einzige Wahrheit ueber das Leben dieser Session ist der Worker. Der
    // Wrapper fragt sie ueber `isAlive()` ab; ohne diese Zeile blieb `_alive`
    // auf `true` stehen, und ein abgeraeumter oder abgeschossener Worker
    // vergiftete die Session fuer die restliche Prozesslaufzeit.
    isAlive() { return worker.isAlive(); },
    get isStreaming() { return state.isStreaming; },
    get isCompacting() { return state.isCompacting; },
    get autoCompactionEnabled() { return state.autoCompactionEnabled; },
    get autoRetryEnabled() {
      // `RpcSessionState` fuehrt das Feld nicht; der Worker meldet nur, was er
      // kennt. `true` ist die Vorgabe des SDK, nicht eine Behauptung ueber diesen
      // Worker.
      return "autoRetryEnabled" in state && typeof state.autoRetryEnabled === "boolean"
        ? state.autoRetryEnabled
        : true;
    },
    get model() { return state.model; },
    // Der Typ verlangt `refresh(strategy?: string)`; die echte Signatur ist
    // enger typisiert (`ModelRefreshStrategy`). Eine Bruecke statt eines Casts,
    // damit die Verengung an genau einer Stelle steht und nicht im Aufrufer.
    modelRegistry: {
      find: (provider, modelId) => runtime.modelRegistry.find(provider, modelId),
      getAll: () => runtime.modelRegistry.getAll(),
      getAvailable: () => runtime.modelRegistry.getAvailable(),
      refresh: async (strategy) => {
        await runtime.modelRegistry.refresh(strategy as never);
      },
    },
    get sessionManager() { return manager; },
    get settings() { return settings; },
    // Kein Prozess, kein Systemprompt: der liegt im Worker. `undefined` ist die
    // ehrliche Antwort; ein leerer String waere eine falsche Zusage.
    get agent() { return { state: {} }; },
    // Extension-UI gehoert zum Prozess, der die Session fuehrt.
    get extensionRunner() { return undefined; },
    get promptTemplates() { return []; },
    get skills() { return []; },

    async reload() {
      // Ein Reload wuerde die Session neu aufbauen. Fuer einen Worker heisst
      // das: Prozess neu starten. Das ist ein eigener Vorgang mit eigener
      // Zusage (Sessions gehen verloren) und deshalb hier nicht versteckt.
      throw new Error("Reload is not supported for a worker-hosted session; restart the worker instead.");
    },

    subscribe(listener: (event: never) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async prompt(text, promptOptions) {
      await client.prompt(text, promptOptions?.images, promptOptions?.streamingBehavior);
      return true;
    },
    async abort() {
      await client.abort();
    },
    async executeBash(command) {
      const result = await client.bash(command);
      return { output: result.output, exitCode: result.exitCode };
    },
    abortBash() {
      void client.abortBash();
    },
    get isBashRunning() { return false; },
    async setModel(model) {
      await client.setModel(model.provider, model.id);
      return { switched: true };
    },
    resolveRoleModel() {
      return undefined;
    },
    async navigateTree(targetId, navOptions) {
      return await client.navigateTree(targetId, navOptions) as never;
    },
    async branch(entryId) {
      const result = await client.branch(entryId);
      return { cancelled: result.cancelled };
    },
    async handoff(customInstructions) {
      const result = await client.handoff(customInstructions);
      return result === null ? undefined : { document: (result as { document?: string }).document ?? "" };
    },
    setThinkingLevel(level) {
      void client.setThinkingLevel(level as never);
    },
    configuredThinkingLevel() {
      return state.thinkingLevel;
    },
    async compact(customInstructions) {
      return await client.compact(customInstructions);
    },
    getSessionStats() {
      return { tokens: 0, contextWindow: 0, percent: 0 } as never;
    },
    getLastAssistantText() {
      return undefined;
    },
    setAutoCompactionEnabled(enabled) {
      void client.setAutoCompaction(enabled);
    },
    setAutoRetryEnabled(enabled) {
      void client.setAutoRetry(enabled);
    },
    async steer(text, images) {
      await client.steer(text, images);
    },
    async followUp(text, images) {
      await client.followUp(text, images);
    },
    get queuedMessageCount() { return 0; },
    getQueuedMessages() {
      return { steering: [], followUp: [] };
    },
    clearQueue() {
      return { steering: [], followUp: [] };
    },
    // Werkzeugnamen kommen aus dem Worker-Zustand; ohne RPC-Befehl dafuer ist
    // eine leere Liste die einzige Aussage, die nicht geraten ist.
    getAllToolNames() { return []; },
    getToolByName() { return undefined; },
    getActiveToolNames() { return []; },
    getEnabledToolNames() { return []; },
    async setActiveToolsByName() { /* kein RPC-Gegenstueck */ },
    abortCompaction() { /* kein RPC-Gegenstueck */ },
    getContextUsage() { return undefined; },
    async dispose() {
      unsubscribeClient();
      listeners.clear();
    },
    // Goal- und Vibe-Modus brauchen den Prozess, der die Session fuehrt.
    //
    // `goalRuntime` ist im Typ **nicht** optional, also kann es hier nicht
    // `undefined` sein, ohne zu luegen. Ein werfender Getter waere schlimmer:
    // `GoalModeController.getStatus()` liest ihn bei jedem Statusabruf, und
    // damit wuerde jede Zustandsabfrage der Sitzung scheitern. Der Vertrag
    // dieses Objekts ist deshalb: die Methoden werfen einen benannten Fehler,
    // und der Getter liefert ein Objekt, dessen Methoden genau das tun.
    get goalRuntime() { return unavailableGoalRuntime; },
    async sendGoalModeContext() {
      throw new Error(GOAL_UNAVAILABLE);
    },
    async promptCustomMessage() {
      throw new Error("Custom prompt messages are not available for a worker-hosted session.");
    },
  };

  return session;
}

/**
 * Das Session-Verzeichnis eines Kontos, oder `null`.
 *
 * Ein eigener Name, weil `createWorkerBackedSession` den Pfad an drei Stellen
 * braucht und eine zweite Ableitung die falsche Stelle fuer einen Tippfehler
 * waere.
 */
export function tenantArchiveDir(identity: WebIdentity): string | null {
  const root = tenantSessionsRoot(identity);
  if (root !== null) return root;
  const home = getUserHome(identity);
  return join(home, ".omp", "agent", "sessions");
}
