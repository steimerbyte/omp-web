import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `/api/agent/[id]` und `/api/agent/[id]/events` nehmen eine Session-Id aus dem
 * URL-Pfad. Bis zum Guard hat die Route nur `isApiRequestAllowed` geprueft — also
 * die Herkunft des Requests, nicht die Identitaet des Mandanten. Damit konnte
 * jeder angemeldete Mandant eine fremde Session-Id angeben, sie ueber POST
 * starten und Befehle hineinschicken, oder ueber GET den Event-Stream der
 * fremden Session mitlesen.
 *
 * Gemessen wird am ROUTE-HANDLER, mit einer fremden Session, die wirklich
 * existiert: einmal laufend (im Registry, ohne Datei) und einmal persistiert
 * (echte Datei, `cwd` unter `/home/bob`). "Mandant fragt eine unbekannte Id" waere
 * als Test wertlos — ohne Guard antwortet die Route dann ebenfalls 404.
 *
 * Zwei Gegenproben sind Pflicht und stehen deshalb unten: der Besitzer muss seine
 * eigene laufende Session weiterhin bedienen koennen, und der Admin muss fremde
 * sehen. Ein Guard, der beides mitreisst, sperrt den Besitzer aus.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
});

// Wie in `app/api/sessions/session-ownership.test.mjs`: `OMP_WEB_HOME_ROOT`
// entscheidet, wo `getUserHome()` nachsieht. Ohne diesen Wert wandern die
// Fixture-Pfade mit dem Heimatverzeichnis des Entwicklers, und der Test
// scheitert an einem Grund, der nichts mit dem Guard zu tun hat.
process.env.OMP_WEB_HOME_ROOT = "/home";

const agentRoute = await jiti.import("./[id]/route.ts");
const eventsRoute = await jiti.import("./[id]/events/route.ts");
const { SessionManager } = await jiti.import("@oh-my-pi/pi-coding-agent");
const { invalidateSessionListCache } = await jiti.import("@/lib/session-reader");

const ALICE = { host: "localhost", "x-omp-user": "alice" };
const ADMIN = { host: "localhost", "x-omp-user": "pi", "x-omp-admin": "1" };
const ANON = { host: "localhost" };

const idParams = (id) => ({ params: Promise.resolve({ id }) });

function sessionInfo(id, cwd, path) {
  return {
    id,
    path,
    cwd,
    title: null,
    created: new Date(0),
    modified: new Date(0),
    messageCount: 1,
    firstMessage: "hallo",
  };
}

/**
 * Zwei Laufzeit-Sessions ohne Datei auf der Platte: eine gehoert `alice`, eine
 * `bob`. `send` zaehlt mit, damit "die Route hat die fremde Session angefasst"
 * beobachtbar ist und nicht aus der Fehlermeldung geraten wird.
 *
 * Der Registry wird direkt gefuellt statt ueber `startRpcSession`: eine echte
 * AgentSession zu starten wuerde einen Prozess und ein Modell spawnen. Die
 * Owner-Map ist derselbe `globalThis.__ompSessionOwners`, den `startRpcSession`
 * pflegt und den `isRpcSessionVisibleTo` liest — der Test beschreibt damit genau
 * den Zustand, den ein echter Start hinterlaesst.
 */
function installLiveSessions(t) {
  const previousSessions = globalThis.__ompSessions;
  const previousOwners = globalThis.__ompSessionOwners;
  const sent = [];
  const listeners = [];
  const fake = (id) => ({
    isAlive: () => true,
    isRunning: () => true,
    inner: { sessionManager: null },
    sessionFile: `/tmp/${id}-not-persisted.jsonl`,
    sessionId: id,
    cwd: "/tmp",
    send: async (command) => {
      sent.push({ id, type: command?.type });
      return { ok: true, session: id };
    },
    onEvent: (listener) => {
      listeners.push({ id, listener });
      return () => {};
    },
    shutdown: async () => {},
  });

  globalThis.__ompSessions = new Map([["alice-live", fake("alice-live")], ["bob-live", fake("bob-live")]]);
  globalThis.__ompSessionOwners = new Map([["alice-live", "alice"], ["bob-live", "bob"]]);

  t.after(() => {
    globalThis.__ompSessions = previousSessions;
    globalThis.__ompSessionOwners = previousOwners;
  });

  return { sent, listeners };
}

/**
 * Eine persistierte Session von `bob`, mit echter Datei. Die Datei existiert
 * wirklich: `resolveSessionPath` verwirft Cache-Eintraege ohne Datei, und mit
 * erfundtem Pfad faellt die Route auch **ohne** Guard auf 404 zurueck — der Test
 * waere dann gruen, weil der Fehler der falsche ist.
 */
function installPersistedForeignSession(t) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-agent-ownership-"));
  const path = join(dir, "bob-file.jsonl");
  writeFileSync(path, "{}\n");
  const opened = [];
  const originalListAll = SessionManager.listAll;
  const originalOpen = SessionManager.open;
  SessionManager.listAll = async () => [
    sessionInfo("bob-file", "/home/bob/project", path),
    sessionInfo("alice-file", "/home/alice/project", join(dir, "alice-file.jsonl")),
  ];
  SessionManager.open = async (filePath) => {
    opened.push(filePath);
    throw new Error("die fremde Session wurde geoeffnet");
  };
  invalidateSessionListCache();
  t.after(() => {
    SessionManager.listAll = originalListAll;
    SessionManager.open = originalOpen;
    invalidateSessionListCache();
    rmSync(dir, { recursive: true, force: true });
  });
  return { opened };
}

function post(id, headers, body = { type: "get_state" }) {
  return new Request(`http://localhost/api/agent/${id}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(url, headers) {
  return new Request(`http://localhost${url}`, { headers });
}

// ----------------------------------------- POST /api/agent/[id]: Laufzeit ---

test("POST /api/agent/[id] schickt keine Befehle an die Session eines anderen Kontos", async (t) => {
  const live = installLiveSessions(t);
  const response = await agentRoute.POST(post("bob-live", ALICE), idParams("bob-live"));

  assert.equal(response.status, 404, `erwartet 404, bekam ${response.status}`);
  assert.equal((await response.json()).error, "Session not found");
  assert.deepEqual(live.sent, [], "die fremde laufende Session hat einen Befehl bekommen");
});

test("POST /api/agent/[id] weist die persistierte Session eines anderen Kontos ab", async (t) => {
  installLiveSessions(t);
  const persisted = installPersistedForeignSession(t);
  const response = await agentRoute.POST(post("bob-file", ALICE), idParams("bob-file"));

  assert.equal(response.status, 404, `erwartet 404, bekam ${response.status}`);
  assert.deepEqual(persisted.opened, [], "die fremde persistierte Session wurde geoeffnet");
});

test("POST /api/agent/[id] verlangt eine Identitaet", async (t) => {
  const live = installLiveSessions(t);
  const response = await agentRoute.POST(post("bob-live", ANON), idParams("bob-live"));

  assert.equal(response.status, 401, `erwartet 401, bekam ${response.status}`);
  assert.deepEqual(live.sent, []);
});

test("POST /api/agent/[id] bedient die eigene laufende Session weiterhin", async (t) => {
  const live = installLiveSessions(t);
  const response = await agentRoute.POST(
    post("alice-live", ALICE, { type: "prompt", text: "hallo" }),
    idParams("alice-live"),
  );

  assert.equal(response.status, 200, `erwartet 200, bekam ${response.status}`);
  assert.deepEqual(live.sent, [{ id: "alice-live", type: "prompt" }]);
});

test("POST /api/agent/[id] laesst den Admin an eine fremde Session", async (t) => {
  const live = installLiveSessions(t);
  const response = await agentRoute.POST(post("bob-live", ADMIN), idParams("bob-live"));

  assert.equal(response.status, 200, `erwartet 200, bekam ${response.status}`);
  assert.deepEqual(live.sent, [{ id: "bob-live", type: "get_state" }]);
});

// ------------------------------------------ GET /api/agent/[id]/events ---

test("GET /api/agent/[id]/events streamt nicht die Session eines anderen Kontos", async (t) => {
  const live = installLiveSessions(t);
  const response = await eventsRoute.GET(
    get("/api/agent/bob-live/events", ALICE),
    idParams("bob-live"),
  );

  assert.equal(response.status, 404, `erwartet 404, bekam ${response.status}`);
  assert.deepEqual(live.listeners, [], "die fremde Session hat einen Event-Listener bekommen");
});

test("GET /api/agent/[id]/events weist die persistierte Session eines anderen Kontos ab", async (t) => {
  installLiveSessions(t);
  const persisted = installPersistedForeignSession(t);
  const response = await eventsRoute.GET(
    get("/api/agent/bob-file/events", ALICE),
    idParams("bob-file"),
  );

  assert.equal(response.status, 404, `erwartet 404, bekam ${response.status}`);
  assert.deepEqual(persisted.opened, [], "die fremde persistierte Session wurde geoeffnet");
});

test("GET /api/agent/[id]/events verlangt eine Identitaet", async (t) => {
  const live = installLiveSessions(t);
  const response = await eventsRoute.GET(
    get("/api/agent/bob-live/events", ANON),
    idParams("bob-live"),
  );

  assert.equal(response.status, 401, `erwartet 401, bekam ${response.status}`);
  assert.deepEqual(live.listeners, []);
});

test("GET /api/agent/[id]/events streamt die eigene laufende Session weiterhin", async (t) => {
  const live = installLiveSessions(t);
  const response = await eventsRoute.GET(
    get("/api/agent/alice-live/events", ALICE),
    idParams("alice-live"),
  );

  assert.equal(response.status, 200, `erwartet 200, bekam ${response.status}`);
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  assert.equal(live.listeners.length, 1, "es wurde kein Abonnent angehaengt");
  assert.equal(live.listeners[0].id, "alice-live");
  await response.body?.cancel();
});

test("GET /api/agent/[id]/events laesst den Admin an eine fremde Session", async (t) => {
  const live = installLiveSessions(t);
  const response = await eventsRoute.GET(
    get("/api/agent/bob-live/events", ADMIN),
    idParams("bob-live"),
  );

  assert.equal(response.status, 200, `erwartet 200, bekam ${response.status}`);
  assert.equal(live.listeners.length, 1);
  assert.equal(live.listeners[0].id, "bob-live");
  await response.body?.cancel();
});

// ------------------------------------------------ GET /api/agent/[id] ---

test("GET /api/agent/[id] liest nicht den Zustand einer fremden Session", async (t) => {
  const live = installLiveSessions(t);
  const response = await agentRoute.GET(
    get("/api/agent/bob-live", ALICE),
    idParams("bob-live"),
  );

  assert.equal(response.status, 404, `erwartet 404, bekam ${response.status}`);
  assert.deepEqual(live.sent, [], "die fremde laufende Session wurde abgefragt");
});

test("GET /api/agent/[id] liefert dem Besitzer seinen eigenen Zustand", async (t) => {
  installLiveSessions(t);
  const response = await agentRoute.GET(
    get("/api/agent/alice-live", ALICE),
    idParams("alice-live"),
  );

  assert.equal(response.status, 200, `erwartet 200, bekam ${response.status}`);
  assert.deepEqual(await response.json(), {
    running: true,
    state: { ok: true, session: "alice-live" },
  });
});