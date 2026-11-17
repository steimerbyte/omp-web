import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * `GET /api/sessions/search` am Handler gemessen: erst die Wache, dann die
 * Frage, dann der Bestand. Ein Test, der nur `searchSessions` aufruft, wuerde
 * eine Route ohne Identity-Wache nicht bemerken.
 */

const homeRoot = mkdtempSync(join(tmpdir(), "omp-web-search-route-"));
const previousRoot = process.env.OMP_WEB_HOME_ROOT;
process.env.OMP_WEB_HOME_ROOT = homeRoot;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
});

const route = await jiti.import("./route.ts");
const { SessionManager } = await jiti.import("@oh-my-pi/pi-coding-agent");
const { invalidateSessionPathCache } = await jiti.import("@/lib/session-reader");

after(() => {
  if (previousRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousRoot;
  rmSync(homeRoot, { recursive: true, force: true });
});

const ALICE = { host: "localhost", "x-omp-user": "alice" };
const ANON = { host: "localhost" };

const get = (url, headers) => new Request(`http://localhost${url}`, { headers });

function resetSessionListState() {
  globalThis.__ompSessionListCache = undefined;
  globalThis.__ompSessionListPromise = undefined;
  globalThis.__ompSessionListPromiseGeneration = undefined;
  globalThis.__ompSessionListGeneration = 0;
}

function aliceHome() {
  const home = join(homeRoot, "alice");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

test("ohne Identitaet antwortet die Route mit 403", async () => {
  const response = await route.GET(get("/api/sessions/search?q=fehler", ANON));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Unknown user" });
});

test("von einem fremden Host wird die Route mit 403 abgelehnt", async () => {
  const response = await route.GET(
    get("/api/sessions/search?q=fehler", { ...ALICE, host: "evil.example" }),
  );
  assert.equal(response.status, 403);
});

test("eine zu kurze oder zu lange Frage bekommt 400 mit Feld", async () => {
  for (const query of ["", "a", "x".repeat(101)]) {
    const response = await route.GET(
      get(`/api/sessions/search?q=${encodeURIComponent(query)}`, ALICE),
    );
    assert.equal(response.status, 400, `q=${JSON.stringify(query)}`);
    const body = await response.json();
    assert.equal(body.field, "q");
  }
});

test("eine gueltige Frage liefert Treffer aus dem eigenen Konto", async () => {
  const home = aliceHome();
  const manager = SessionManager.create(
    home,
    SessionManager.getDefaultSessionDir(home, join(home, ".omp", "agent")),
  );
  manager.appendMessage({ role: "user", content: "Der Rollout ist am Zertifikat gescheitert" });
  await manager.ensureOnDisk();
  const sessionId = manager.getSessionId();
  resetSessionListState();

  const response = await route.GET(get("/api/sessions/search?q=zertifikat", ALICE));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body.matches.map((m) => m.sessionId), [sessionId]);
  assert.equal(body.truncated, false);
  assert.ok(body.scanned >= 1);
  invalidateSessionPathCache(sessionId);
});

test("nur Leerzeichen sind keine Frage", async () => {
  const response = await route.GET(get("/api/sessions/search?q=%20%20", ALICE));
  assert.equal(response.status, 400);
});
