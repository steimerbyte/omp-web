import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Ein Modellwechsel an einer Session **ohne** laufenden Wrapper.
 *
 * ### Was hier gemessen wird
 *
 * Der Scan nennt die kalte Session als dritten Kostenposten: die Route startete
 * im `else`-Zweig `startRpcSession` — Extensions entdecken, Custom-Tools
 * entdecken, System-Prompt aufloesen, Modell-Scope bauen,
 * `createAgentSession`. Fuer einen Wechsel ist das die falsche Arbeit: es geht
 * um einen Eintrag im Journal, nicht um ein laufendes Agent-Objekt.
 *
 * Der Test misst deshalb zweierlei:
 * 1. `startRpcSession` wird fuer `set_model`/`set_role_model` **nicht**
 *    gerufen — der teuere Pfad ist weg.
 * 2. Der Eintrag landet wirklich in der Datei. Ohne die Spuelung waere der
 *    Wechsel nur im Speicher und der naechste Start zeigte das alte Modell.
 *
 * Und die Gegenprobe: ein `prompt` startet die Session weiterhin. Wer den
 * `else`-Zweig fuer alle Kommandos ueberspringt, haette den Wechsel
 * beschleunigt und das Senden kaputtgemacht.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
});

process.env.OMP_WEB_HOME_ROOT = "/home";

const agentRoute = await jiti.import("./[id]/route.ts");
const { SessionManager } = await jiti.import("@oh-my-pi/pi-coding-agent");
const { invalidateSessionListCache } = await jiti.import("@/lib/session-reader");

// Der Admin sieht jede Session (`isSessionOwnedBy`), also traegt er den Test
// ohne eine zweite Besitzregel. Die Besitzfrage selbst ist in
// `agent-session-ownership.test.mjs` gemessen, nicht hier.
const ADMIN = { host: "localhost", "x-omp-user": "pi", "x-omp-admin": "1" };
const idParams = (id) => ({ params: Promise.resolve({ id }) });

function post(id, headers, body) {
  return new Request(`http://localhost/api/agent/${id}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Eine echte Session-Datei und ein Registry, in dem **kein** Wrapper liegt —
 * genau der Zustand nach dem 10-Minuten-Reaper (`lib/rpc-manager.ts:752-763`).
 */
function installColdSession(t, id = "cold-1") {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-cold-switch-"));
  const path = join(dir, `${id}.jsonl`);

  const sm = SessionManager.create("/home/alice/project", dir);
  sm.appendSessionInit({ systemPrompt: ["t"], task: "t", tools: [] });
  sm.appendModelChange("buds-gateway/deepseek-v4.1-flash-1017", "default");
  sm.appendMessage({
    role: "user",
    content: [{ type: "text", text: "hallo" }],
    timestamp: Date.now(),
  });
  const header = sm.getHeader();
  const realId = header?.id ?? id;
  const realPath = sm.getSessionFile();
  writeFileSync(path, "");

  const originalListAll = SessionManager.listAll;
  SessionManager.listAll = async () => [{
    id: realId,
    path: realPath,
    cwd: "/home/alice/project",
    title: null,
    created: new Date(0),
    modified: new Date(0),
    messageCount: 1,
    firstMessage: "hallo",
  }];
  invalidateSessionListCache();

  // Der sichtbare Beweis fuer "es wurde eine Session gestartet": die Registry,
  // in die `startRpcSession` den Wrapper legt (`lib/rpc-manager.ts:1603`).
  // `startRpcSession` selbst laesst sich hier nicht ersetzen — das importierte
  // Modul ist eingefroren.
  const previousSessions = globalThis.__ompSessions;
  globalThis.__ompSessions = new Map();

  t.after(() => {
    SessionManager.listAll = originalListAll;
    globalThis.__ompSessions = previousSessions;
    invalidateSessionListCache();
    rmSync(dir, { recursive: true, force: true });
  });

  const startedSessions = () => [...(globalThis.__ompSessions?.keys() ?? [])];
  return { id: realId, path: realPath, startedSessions };
}

test("ein Modellwechsel an einer kalten Session startet keine Session", async (t) => {
  const cold = installColdSession(t);

  const response = await agentRoute.POST(
    post(cold.id, ADMIN, { type: "set_model", provider: "buds-gateway", modelId: "qwen3.8-27b" }),
    idParams(cold.id),
  );

  assert.equal(response.status, 200, `erwartet 200, bekam ${response.status}: ${await response.clone().text()}`);
  assert.deepEqual(cold.startedSessions(), [], "der Wechsel hat eine ganze Session gestartet");
});

test("der Wechsel steht danach in der Datei, nicht nur im Speicher", async (t) => {
  const cold = installColdSession(t);

  await agentRoute.POST(
    post(cold.id, ADMIN, { type: "set_model", provider: "buds-gateway", modelId: "qwen3.8-27b" }),
    idParams(cold.id),
  );

  // Gegenprobe ueber den SDK-Leser: der naechste Start stellt genau hieraus
  // wieder her (`getRestorableSessionModels`).
  const reopened = await SessionManager.open(cold.path);
  const context = reopened.buildSessionContext();
  assert.equal(
    context.models.default,
    "buds-gateway/qwen3.8-27b",
    "der model_change-Eintrag fehlt in der Datei",
  );
});

test("ein prompt an einer kalten Session startet sie weiterhin", async (t) => {
  const cold = installColdSession(t);

  const response = await agentRoute.POST(
    post(cold.id, ADMIN, { type: "prompt", text: "hallo" }),
    idParams(cold.id),
  );

  assert.equal(response.status, 200, `erwartet 200, bekam ${response.status}: ${await response.clone().text()}`);
  assert.equal(
    cold.startedSessions().length,
    1,
    `ein prompt muss die Session starten — der Wechsel-Pfad darf den Start nicht fuer alle Kommandos ueberspringen: ${JSON.stringify(cold.startedSessions())}`,
  );
});

test("ein unbekanntes Modell wird als Grund abgelehnt, nicht als Absturz", async (t) => {
  const cold = installColdSession(t);

  const response = await agentRoute.POST(
    post(cold.id, ADMIN, { type: "set_model", provider: "buds-gateway", modelId: "gibt-es-nicht" }),
    idParams(cold.id),
  );

  assert.equal(response.status, 500, `erwartet 500, bekam ${response.status}`);
  const body = await response.json();
  assert.match(body.error, /Model not found/, `der Grund fehlt: ${JSON.stringify(body)}`);

  // Und der Journal-Eintrag darf nicht entstanden sein: ein abgelehnter
  // Wechsel, der trotzdem schreibt, waere schlimmer als der Fehler.
  const entries = readFileSync(cold.path, "utf8")
    .split("\n")
    .filter((line) => line.includes('"model_change"'))
    .map((line) => JSON.parse(line));
  assert.doesNotMatch(
    JSON.stringify(entries),
    /gibt-es-nicht/,
    "das abgelehnte Modell steht trotzdem im Journal",
  );
});
