import { EventEmitter } from "node:events";
import type * as Undici from "undici";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
type UndiciModule = typeof Undici;

type DispatcherGlobal = typeof globalThis & {
  __ompWebHttpDispatcherConfigured?: boolean;
  __ompWebHttpDispatcherConfiguring?: Promise<void>;
};

const dispatcherGlobal = globalThis as DispatcherGlobal;
const originalGlobalFetch = globalThis.fetch;
const ignoreUndiciDispatcherError = (): void => {};

function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "disabled") return 0;
    if (trimmed.length === 0) return undefined;
    return parseHttpIdleTimeoutMs(Number(trimmed));
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

// Undici can emit an internal Client error while terminating a response body.
// The body stream still rejects; this prevents the EventEmitter error from
// terminating the Next.js process first.
function withUndiciErrorListener<T extends Undici.Dispatcher>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
  }
  return dispatcher;
}

function createUndiciClient(
  undici: UndiciModule,
  origin: string | URL,
  options: object,
): Undici.Dispatcher {
  return withUndiciErrorListener(
    new undici.Client(origin, options as Undici.Client.Options),
  );
}

function createUndiciOriginDispatcher(
  undici: UndiciModule,
  origin: string | URL,
  options: object,
): Undici.Dispatcher {
  const dispatcherOptions = options as Undici.Pool.Options;
  if (dispatcherOptions.connections === 1) {
    return createUndiciClient(undici, origin, dispatcherOptions);
  }

  return withUndiciErrorListener(
    new undici.Pool(origin, {
      ...dispatcherOptions,
      factory: (factoryOrigin, factoryOptions) =>
        createUndiciClient(undici, factoryOrigin, factoryOptions),
    }),
  );
}

/**
 * Whether the process is running on Bun's runtime.
 *
 * Bun ships its own `undici` module: `setGlobalDispatcher` there does not affect
 * `fetch`, and `install` does not exist. So the dispatcher dance below is both
 * ineffective and unnecessary under Bun — which is the runtime `omp-web`
 * actually serves on.
 *
 * ### Loopback ist NICHT automatisch ausgenommen (Bun 1.4.2, gemessen)
 *
 * Eine fruehere Fassung dieser Notiz behauptete, Bun leite Loopback nie ueber
 * den Proxy. Das trifft nicht zu: mit gesetztem `HTTP_PROXY` landet ein `fetch`
 * auf `127.0.0.1` beim Proxy und kommt mit einem leeren 204 statt mit der
 * Antwort des lokalen Servers zurueck. Betroffen ist damit genau der Weg, den
 * die lokalen Provider brauchen — ollama, LM Studio, llama.cpp.
 *
 * Und fehlendes `NO_PROXY` wird nicht durch einen eigenen Default ersetzt:
 * ein Aussenproxy, den der Operator ueber eine Firmenvariable setzt, schluckt
 * dann still jeden Aufruf an ein Modell, das auf diesem Host laeuft.
 */
export function isBunRuntime(): boolean {
  return typeof process.versions.bun === "string";
}

/** Hosts a local provider can be reached on. Both spellings, both stacks. */
const LOOPBACK_NO_PROXY = ["localhost", "127.0.0.1", "::1", "0.0.0.0"];

/**
 * Make sure `NO_PROXY` covers loopback before the first request goes out.
 *
 * Bun reads `HTTP_PROXY` / `NO_PROXY` once at process start, so this has to
 * run before anything fetches — which is why it is in
 * `configureHttpDispatcher` rather than at the point of use. An existing
 * `NO_PROXY` is extended, never replaced: an operator who excluded
 * `internal.example` keeps that exclusion.
 *
 * Returns the resulting value so a caller (and a test) can assert on it.
 */
export function ensureLoopbackNotProxied(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env.NO_PROXY ?? env.no_proxy ?? "";
  const entries = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  const present = new Set(entries.map((entry) => entry.toLowerCase()));
  for (const host of LOOPBACK_NO_PROXY) {
    if (!present.has(host)) {
      entries.push(host);
      present.add(host);
    }
  }
  const result = entries.join(",");
  env.NO_PROXY = result;
  // Bun and Node both read the lowercase spelling when it is set; leaving a
  // stale one behind would let a proxy win again.
  env.no_proxy = result;
  return result;
}

export function configureHttpDispatcher(
  timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS,
): void | Promise<void> {
  if (dispatcherGlobal.__ompWebHttpDispatcherConfigured) return;

  const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
  if (normalizedTimeoutMs === undefined) {
    throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
  }

  // Bun resolves the proxy environment once at process start, so the loopback
  // exclusion has to be in place before the first request — not only on the
  // Node path below, which `instrumentation.ts` skips entirely under Bun.
  ensureLoopbackNotProxied();

  if (isBunRuntime()) {
    dispatcherGlobal.__ompWebHttpDispatcherConfigured = true;
    return;
  }

  if (dispatcherGlobal.__ompWebHttpDispatcherConfiguring) {
    return dispatcherGlobal.__ompWebHttpDispatcherConfiguring;
  }
  const configuring = import("undici")
    .then((undici) => {
      const dispatcher = withUndiciErrorListener(
        new undici.EnvHttpProxyAgent({
          allowH2: false,
          bodyTimeout: normalizedTimeoutMs,
          headersTimeout: normalizedTimeoutMs,
          clientFactory: (origin, options) =>
            createUndiciClient(undici, origin, options),
          factory: (origin, options) =>
            createUndiciOriginDispatcher(undici, origin, options),
        }),
      );
      undici.setGlobalDispatcher(dispatcher);

      // Keep fetch and the dispatcher on the same undici implementation.
      // Preserve an intentional fetch override installed after module load.
      if (globalThis.fetch === originalGlobalFetch) {
        undici.install?.();
      }

      dispatcherGlobal.__ompWebHttpDispatcherConfigured = true;
    })
    .finally(() => {
      delete dispatcherGlobal.__ompWebHttpDispatcherConfiguring;
    });
  dispatcherGlobal.__ompWebHttpDispatcherConfiguring = configuring;
  return configuring;
}
