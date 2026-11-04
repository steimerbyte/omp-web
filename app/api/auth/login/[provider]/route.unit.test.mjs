import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The OAuth login stream in `app/api/auth/login/[provider]`.
 *
 * GET is an SSE stream that runs `authStorage.oauth.login()`; POST completes a
 * prompt by token. Both are admin-only because the token lands in the *process
 * account's* `agent.db`.
 *
 * `authStorage.oauth.login` is scripted, so the flow is deterministic and no
 * provider is contacted: one script answers a prompt, one hangs until the
 * client disconnects. That is enough to drive every callback in the handler
 * (`onProgress`, `onAuth`, `onPrompt`), the token registry (resolve/reject and
 * cleanup) and both stream ends (success event and cancel).
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-auth-login-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;
const AGENT_DIR = join(HOME_ROOT, "agent");
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
mkdirSync(AGENT_DIR, { recursive: true });

const route = await jiti.import("./route.ts");

const PROVIDER = "anthropic";
const scripts = [];
const previousRuntime = globalThis.__ompRuntimePromise;
function installRuntime() {
  globalThis.__ompRuntimePromise = Promise.resolve({
    agentDir: AGENT_DIR,
    authStorage: {
      oauth: {
        login: async (loginId, handlers) => {
          assert.equal(loginId, PROVIDER);
          const script = scripts.shift();
          if (!script) throw new Error("no scripted login");
          return script(handlers);
        },
      },
    },
    settings: { getCwd: () => undefined },
    modelRegistry: { getAvailable: () => [], getAll: () => [], getError: () => undefined },
  });
}
installRuntime();

const ORIGIN = "http://localhost:30141";
const ADMIN = { host: "localhost:30141", "x-omp-user": "auth-admin", "x-omp-admin": "1" };

function get(signal, provider = PROVIDER, headers = ADMIN) {
  return route.GET(new Request(`${ORIGIN}/api/auth/login/${provider}`, { headers, signal }), {
    params: Promise.resolve({ provider }),
  });
}

function post(body, headers = ADMIN, provider = PROVIDER) {
  return route.POST(
    new Request(`${ORIGIN}/api/auth/login/${provider}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ provider }) },
  );
}

/** Read SSE events until `predicate` matches (or the stream ends). */
async function readUntil(reader, predicate, { max = 20 } = {}) {
  const events = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for (let i = 0; i < max; i += 1) {
    const { value, done } = await reader.read();
    if (done) return { events, done: true };
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      const event = JSON.parse(dataLine.slice("data: ".length));
      events.push(event);
      if (predicate(event)) return { events, done: false };
    }
  }
  return { events, done: false };
}

async function drain(reader) {
  for (let i = 0; i < 20; i += 1) {
    const { done } = await reader.read();
    if (done) return;
  }
}

test.after(() => {
  if (previousRuntime === undefined) delete globalThis.__ompRuntimePromise;
  else globalThis.__ompRuntimePromise = previousRuntime;
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  delete globalThis.__ompLoginCallbacks;
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

test("POST ist admin-only und prueft Token und Code", async () => {
  const tenant = await post({ token: "anthropic-1-x", code: "c" }, { host: "localhost:30141", "x-omp-user": "auth-tenant" });
  assert.equal(tenant.status, 403);
  assert.equal((await tenant.json()).error, "Administrator access is required.");

  const missing = await post({ token: "anthropic-1-x" });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, "token and code required");

  const unknown = await post({ token: "anthropic-1-nope", code: "c" });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, "No pending login for token");

  globalThis.__ompLoginCallbacks ??= new Map();
  globalThis.__ompLoginCallbacks.set("openai-codex-1-other", { resolve: () => {}, reject: () => {} });
  const mismatch = await post({ token: "openai-codex-1-other", code: "c" });
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).error, "Token does not match provider");
  globalThis.__ompLoginCallbacks.delete("openai-codex-1-other");
});

test("POST loest den passenden Callback auf und entfernt den Token", async () => {
  let resolvedWith;
  globalThis.__ompLoginCallbacks ??= new Map();
  globalThis.__ompLoginCallbacks.set("anthropic-1-pending", {
    resolve: (value) => {
      resolvedWith = value;
    },
    reject: () => {},
  });

  const response = await post({ token: "anthropic-1-pending", code: "the-code" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, provider: PROVIDER });
  assert.equal(resolvedWith, "the-code");
  assert.equal(globalThis.__ompLoginCallbacks.has("anthropic-1-pending"), false);
});

test("ein unbekannter Provider endet als error-Event, nicht als offener Stream", async () => {
  const response = await get(undefined, "no-such-provider");
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const { events, done } = await readUntil(reader, (event) => event.type === "error", { max: 3 });
  assert.equal(done, false);
  assert.match(events[0].message, /Unknown provider: no-such-provider/);
  await drain(reader);
});

test("der volle Flow meldet Fortschritt, Auth-URL, Prompt und Erfolg", async () => {
  installRuntime();
  scripts.push(async (handlers) => {
    handlers.onProgress("starting");
    handlers.onAuth({
      url: "https://auth.example/authorize?x=1",
      launchUrl: "http://127.0.0.1:43123/callback",
      instructions: "Paste the code",
    });
    const code = await handlers.onPrompt({ message: "Paste the code", placeholder: "code" });
    if (code !== "the-code") throw new Error(`unexpected code: ${code}`);
  });

  const response = await get();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.getReader();

  const first = await readUntil(reader, (event) => event.type === "auth");
  const progress = first.events.find((event) => event.type === "progress");
  assert.equal(progress.message, "starting");
  const auth = first.events.find((event) => event.type === "auth");
  assert.equal(auth.url, "http://127.0.0.1:43123/callback", "launchUrl hat Vorrang vor der vollen URL");
  assert.equal(auth.fullUrl, "https://auth.example/authorize?x=1");
  assert.equal(auth.instructions, "Paste the code");
  assert.match(auth.token, new RegExp(`^${PROVIDER}-\\d+-`));

  const second = await readUntil(reader, (event) => event.type === "prompt_request");
  const prompt = second.events.find((event) => event.type === "prompt_request");
  assert.equal(prompt.message, "Paste the code");
  assert.equal(prompt.placeholder, "code");
  assert.notEqual(prompt.token, auth.token);

  // Complete the prompt through the POST the browser would send.
  const completed = await post({ token: prompt.token, code: "the-code" });
  assert.equal(completed.status, 200);

  const third = await readUntil(reader, (event) => event.type === "success", { max: 5 });
  assert.ok(third.events.some((event) => event.type === "success"), JSON.stringify(third.events));
  await drain(reader);
});

test("onManualCodeInput teilt sich den Token mit der Auth-URL", async () => {
  installRuntime();
  scripts.push(async (handlers) => {
    handlers.onAuth({ url: "https://auth.example/manual" });
    // The manual-code flow reuses the request onAuth opened: one token, one
    // prompt, so a pasted redirect completes the login it belongs to.
    const code = await handlers.onManualCodeInput();
    if (code !== "pasted-code") throw new Error(`unexpected code: ${code}`);
  });

  const reader = (await get()).body.getReader();
  const { events } = await readUntil(reader, (event) => event.type === "auth");
  const auth = events.find((event) => event.type === "auth");
  assert.equal(auth.url, "https://auth.example/manual");
  assert.equal((await post({ token: auth.token, code: "pasted-code" })).status, 200);
  const tail = await readUntil(reader, (event) => event.type === "success", { max: 5 });
  assert.ok(tail.events.some((event) => event.type === "success"), JSON.stringify(tail.events));
  await drain(reader);
});

test("ein Abbruch des Clients raeumt offene Tokens auf und schliesst den Stream", async () => {
  installRuntime();
  const abort = new AbortController();
  scripts.push(async (handlers) => {
    handlers.onProgress("waiting for input");
    // Never resolves: the client is the only one who could answer, and it
    // aborts instead — the cleanup has to reject the pending token.
    await handlers.onPrompt({ message: "Paste the code" });
  });

  const response = await get(abort.signal);
  const reader = response.body.getReader();
  const { events } = await readUntil(reader, (event) => event.type === "prompt_request");
  const prompt = events.find((event) => event.type === "prompt_request");
  assert.ok(prompt, "kein prompt_request-Event");

  const registry = globalThis.__ompLoginCallbacks;
  assert.equal(registry.has(prompt.token), true);
  abort.abort();

  // The handler's cancel()/abort listener rejects the pending token, which
  // removes it from the registry.
  for (let i = 0; i < 20 && registry.has(prompt.token); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(registry.has(prompt.token), false, "der Token blieb nach dem Abbruch registriert");
  await reader.cancel();
});

test("cancel() auf dem Stream bricht den Login ab", async () => {
  installRuntime();
  scripts.push(async (handlers) => {
    handlers.onProgress("hanging");
    await new Promise(() => {}); // never settles
  });

  const response = await get();
  const reader = response.body.getReader();
  await readUntil(reader, (event) => event.type === "progress", { max: 2 });
  // Cancelling the consumer runs the ReadableStream's cancel(), which aborts
  // the AbortController handed to authStorage.login().
  await reader.cancel();
});
