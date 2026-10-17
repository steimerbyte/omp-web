import type {
  configureHttpDispatcher as ConfigureHttpDispatcher,
  ensureLoopbackNotProxied as EnsureLoopbackNotProxied,
} from "@/lib/http-dispatcher";

type DispatcherModule = {
  configureHttpDispatcher: typeof ConfigureHttpDispatcher;
  ensureLoopbackNotProxied: typeof EnsureLoopbackNotProxied;
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
}
