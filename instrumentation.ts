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
