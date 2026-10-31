import type {
  configureHttpDispatcher as ConfigureHttpDispatcher,
  ensureLoopbackNotProxied as EnsureLoopbackNotProxied,
} from "@/lib/http-dispatcher";

type DispatcherModule = {
  configureHttpDispatcher: typeof ConfigureHttpDispatcher;
  ensureLoopbackNotProxied: typeof EnsureLoopbackNotProxied;
};

/**
 * Der Zeitplaner, so wie `instrumentation.ts` ihn laden kann.
 *
 * Nur der Typ — das Modul selbst wird ueber dieselbe `Function("return
 * import")`-Umleitung geladen wie der HTTP-Dispatcher: `lib/scheduler.ts`
 * zieht `rpc-manager`, `session-reader` und die Agent-Laufzeit nach, und die
 * gehoeren nicht in das Edge-/Browser-Bundle der Instrumentation.
 */
type SchedulerModule = {
  startScheduler: () => void;
};

/**
 * Die Geheimnisdatei, wie `instrumentation.ts` sie laden kann.
 *
 * Nur die Typen — aus demselben Grund wie beim Zeitplaner: das Modul liest mit
 * `node:fs`, und ein statischer Import davon waere im Edge-Bundle der
 * Instrumentation ein Fehler.
 */
type SecretsModule = {
  resolveSecretsFile: () => string;
  secretsFileExists: () => boolean;
  runtimeSecrets: () => ReadonlyMap<string, string>;
  inheritedSecretNames: () => string[];
};

export async function register(): Promise<void> {
  // Keep the Node-only undici graph out of Next's browser/edge instrumentation
  // bundles. Node 22 can load this local TypeScript module directly.
  const importRuntimeModule = Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<DispatcherModule>;
  const moduleUrl = `file://${encodeURI(process.cwd())}/lib/http-dispatcher.ts`;

  // The Bun branch used to return before any of this ran, which left `NO_PROXY`
  // unset on the runtime omp-web actually serves on. Measured on Bun 1.4.2: with
  // a corporate `HTTP_PROXY` set, a `fetch` to `127.0.0.1` returned the proxy's
  // empty 204 instead of the local server's answer — ollama, LM Studio and
  // llama.cpp were unreachable through omp-web. `configureHttpDispatcher` is a
  // no-op under Bun beyond the loopback exclusion, so one path serves both.
  const { configureHttpDispatcher, ensureLoopbackNotProxied } = await importRuntimeModule(moduleUrl);
  if (process.env.NEXT_RUNTIME === "nodejs") await configureHttpDispatcher();
  else ensureLoopbackNotProxied();

  // Geheimnisse aus der Datei, nicht aus der Umgebung.
  //
  // `Environment=`/`EnvironmentFile=` in der systemd-Unit schreiben den Wert in
  // die Umgebung, und von dort erbt ihn **jeder** Kindprozess: der Agent-`bash`
  // (die Brush-Shell laeuft im Prozess), die MCP-stdio-Server, der Zeitplaner.
  // Gemessen auf Bun 1.4.4: ein `delete process.env.X` entfernt den Wert aus
  // `process.env`, aber nicht aus `/proc/self/environ` und nicht aus einem
  // Kind ohne eigene env-Map (SHELL-ISOLATION-SCAN §2b). Der einzige Schnitt
  // ist deshalb, ihn nie hineinzuschreiben: die App liest ihre Geheimnisse
  // selbst (`lib/runtime-secrets.ts`) und haelt sie in einem Modulwert.
  //
  // Das Log ist der einzige Ort, an dem eine noch nicht umgestellte Unit
  // auffaellt: von aussen ist einer sandboxten Shell nicht anzusehen, was in
  // ihrer Umgebung steht.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const loadSecrets = Function("specifier", "return import(specifier)") as (
        specifier: string,
      ) => Promise<SecretsModule>;
      const secretsUrl = `file://${encodeURI(process.cwd())}/lib/runtime-secrets.ts`;
      const { resolveSecretsFile, secretsFileExists, runtimeSecrets, inheritedSecretNames } = await loadSecrets(secretsUrl);
      const file = resolveSecretsFile();
      if (!secretsFileExists() && inheritedSecretNames().length === 0) {
        console.warn(`[secrets] no secrets file at ${file} and none in the environment; the login lock has no password until one is configured.`);
      }
      const inherited = inheritedSecretNames();
      if (inherited.length > 0) {
        console.warn(
          `[secrets] ${inherited.length} secret(s) are inherited from the process environment and reach every child `
            + `(agent bash, MCP stdio, scheduler, git): ${inherited.join(", ")}. `
            + `Move them into ${file} and remove Environment=/EnvironmentFile= for them from the unit; `
            + `omp-web reads that file itself, the environment copy is the leak.`,
        );
      } else if (secretsFileExists()) {
        console.log(`[secrets] ${runtimeSecrets().size} secret(s) loaded from ${file}; none are in the process environment.`);
      }
    } catch (error) {
      // Wie beim Zeitplaner: ein Logeintrag ist besser als ein Server, der
      // wegen seiner Diagnose nicht startet.
      console.error("[secrets] could not be loaded:", error);
    }
  }

  // Der Zeitplaner geplanter Aufgaben. `register` ist der einzige
  // Lebenszyklus-Haken, den Next anbietet — es gibt keinen "beim Beenden" —,
  // also wird er hier gestartet und laeuft, solange der Prozess laeuft.
  //
  // Nur auf dem Node-Runtime: im Edge-Runtime gibt es weder `fs` noch
  // `setTimeout` mit Prozess-Lebensdauer, und die Aufgaben liegen in Dateien.
  //
  // **Der Aufruf darf nicht werfen.** Ein kaputter Zeitplaner ist ein
  // Schoenheitsfehler; eine Instrumentation, die wirft, haelt den Server an,
  // und dann sieht der Nutzer gar nichts mehr — auch nicht die Aufgaben, die
  // er haette reparieren koennen. Deshalb `try`/`catch` um alles, mit einer
  // Zeile im Log.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const loadScheduler = Function("specifier", "return import(specifier)") as (
        specifier: string,
      ) => Promise<SchedulerModule>;
      const schedulerUrl = `file://${encodeURI(process.cwd())}/lib/scheduler.ts`;
      const { startScheduler } = await loadScheduler(schedulerUrl);
      startScheduler();
    } catch (error) {
      console.error("[scheduler] could not be started:", error);
    }
  }
}
