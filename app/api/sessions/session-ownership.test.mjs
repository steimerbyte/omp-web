import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Eigentuemlichkeit der Session-Detailrouten, am ROUTE-HANDLER gemessen.
 *
 * Warum das ueberhaupt eine eigene Testklasse ist: 770 Tests waren gruen, waehrend
 * sechs Routen unter `[id]` und darunter jede Session des Prozesses auslieferten.
 * Ein Test, der nur den Guard aufruft, haette das nicht gefunden — er beweist, dass
 * der Guard funktioniert, nicht, dass die Route ihn benutzt. Deshalb wird hier
 * jede Route **aufgerufen**, mit einer fremden Session, die wirklich existiert.
 *
 * ### Warum eine fremde Session wirklich existieren muss
 *
 * Der naheliegende Test — " Mandant fragt eine unbekannte Id, bekommt 403/404" —
 * ist wertlos: ohne Guard liefert die Route bei einer unbekannten Id *ebenfalls*
 * 404, weil `resolveSessionPath` dann `null` zurueckgibt. Der Test waere gruen
 * mit und ohne Guard.
 *
 * Deshalb wird `SessionManager.listAll` auf eine Session mit `cwd` unter
 * `/home/bob` gestellt und als Mandant `alice` angefragt. Der Mandant besitzt
 * sie nicht, der Guard muss also greifen. Ohne Guard laeuft die Route weiter in
 * `SessionManager.open()` — und `open` ist der Attrappe, der mitzaehlt. Damit
 * ist der Unterschied nicht "irgendein Fehler", sondern "die Route hat die
 * fremde Session angefasst oder nicht".
 *
 * Das Gegenstueck ist Pflicht: `alice` muss ihre *eigenen* Sessions weiterhin
 * sehen, und der Admin muss fremde sehen. Ein Filter, der beides mitreisst,
 * sperrt den Besitzer aus seiner eigenen Session aus — die Warnung steht in
 * `docs/known-findings.md` und ist der Grund, warum diese beiden Tests hier
 * stehen und nicht nur die Ablehnungen.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
});

const detailRoute = await jiti.import("./[id]/route.ts");
const stateRoute = await jiti.import("./[id]/state/route.ts");
const contextRoute = await jiti.import("./[id]/context/route.ts");
const exportRoute = await jiti.import("./[id]/export/route.ts");
const autoNameRoute = await jiti.import("./[id]/auto-name/route.ts");
const thinkingRoute = await jiti.import("./[id]/entries/[entryId]/thinking/route.ts");
const { SessionManager } = await jiti.import("@oh-my-pi/pi-coding-agent");
const { invalidateSessionListCache } = await jiti.import("@/lib/session-reader");

const ALICE = { host: "localhost", "x-omp-user": "alice" };

const ADMIN = { host: "localhost", "x-omp-user": "pi", "x-omp-admin": "1" };
const ANON = { host: "localhost" };

const idParams = (id) => ({ params: Promise.resolve({ id }) });
const entryParams = (id, entryId) => ({ params: Promise.resolve({ id, entryId }) });

function get(url, headers) {
  return new Request(`http://localhost${url}`, { headers });
}

/** Ein Minimalsatz an Session-Infos, den der Listenfilter akzeptiert. */
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
 * `listAll` liefert die angegebenen Sessions; `open` zaehlt mit. Damit ist
 * "die Route hat die fremde Session angefasst" direkt beobachtbar statt aus der
 * Fehlermeldung geraten.
 *
 * Die Dateien existieren wirklich. Das ist keine Feinheit: `resolveSessionPath`
 * verwirft einen Cache-Eintrag, dessen Datei nicht da ist
 * (`lib/session-reader.ts:196-198`), und befuellt ihn nur beim tatsaechlichen
 * Plattenlauf nach. Mit erfundenen Pfaden faellt die Route auch **ohne** Guard
 * auf 404 zurueck — der Test waere gruen, weil der Fehler der falsche ist.
 */
function installSessionWorld(sessions) {
  const opened = [];
  const originalListAll = SessionManager.listAll;
  const originalOpen = SessionManager.open;
  SessionManager.listAll = async () => sessions;
  SessionManager.open = async (filePath) => {
    opened.push(filePath);
    return {
      getEntries: () => [],
      getLeafId: () => null,
      getTree: () => [],
      getHeader: () => ({ id: "opened", timestamp: "2026-01-01T00:00:00.000Z" }),
      getSessionName: () => null,
      getSessionFile: () => filePath,
      getSessionPath: () => filePath,
    };
  };
  invalidateSessionListCache();
  return {
    opened,
    restore() {
      SessionManager.listAll = originalListAll;
      SessionManager.open = originalOpen;
      invalidateSessionListCache();
    },
  };
}

/** `alice` sieht `/home/alice`, `bob` sieht `/home/bob`, der Admin alles. */
function world(t) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-session-ownership-"));
  const file = (id) => {
    const filePath = join(dir, `${id}.jsonl`);
    writeFileSync(filePath, "{}\n");
    return filePath;
  };
  const sessions = [
    sessionInfo("bob-session", "/home/bob/project", file("bob-session")),
    sessionInfo("alice-session", "/home/alice/project", file("alice-session")),
  ];
  const w = installSessionWorld(sessions);
  t.after(() => {
    w.restore();
    rmSync(dir, { recursive: true, force: true });
  });
  return w;
}

async function assertNotOwned(response, label) {
  // 404 statt 403: 403 wuerde bestaetigen, dass die Id zu *irgendwem* gehoert.
  assert.equal(response.status, 404, `${label}: erwartet 404, bekam ${response.status}`);
  assert.equal(response.headers.get("Cache-Control"), "no-store", label);
  assert.equal((await response.json()).error, "Session not found", label);
}

async function assertUnauthenticated(response, label) {
  assert.equal(response.status, 401, `${label}: erwartet 401, bekam ${response.status}`);
  assert.equal(response.headers.get("Cache-Control"), "no-store", label);
  assert.equal((await response.json()).error, "Authentication is required.", label);
}

/**
 * Der Test, den man nicht schreiben darf: die Route mit fremder Session, und
 * `SessionManager.open` zaehlt mit. Ein Test dieser Form beweist, dass die Route
 * **nicht** bis zur fremden Session vordringt — er faellt genau dann um, wenn
 * jemand den Guard entfernt.
 */
function deniesForeignSession(label, call) {
  return async (t) => {
    const w = world(t);
    // Der Anfragende ist `alice`, die Session ist die von `bob` — die
    // fremde Session muss wirklich existieren und wirklich fremd sein.
    const response = await call(ALICE, "bob-session");
    await assertNotOwned(response, label);
    assert.deepEqual(w.opened, [], `${label}: die fremde Session wurde geoeffnet`);
  };
}

function requiresIdentity(label, call) {
  return async (t) => {
    const w = world(t);
    await assertUnauthenticated(await call(ANON), label);
    assert.deepEqual(w.opened, [], `${label}: ohne Identitaet wurde etwas geoeffnet`);
  };
}

// ------------------------------------------- app/api/sessions/[id]/route.ts --

test("[id] GET weist die Session eines anderen Kontos ab", deniesForeignSession(
  "GET /api/sessions/[id]",
  (headers, id) => detailRoute.GET(get(`/api/sessions/${id}`, headers), idParams(id)),
));

test("[id] GET verlangt eine Identitaet", requiresIdentity(
  "GET /api/sessions/[id] anonym",
  (headers) => detailRoute.GET(get("/api/sessions/bob-session", headers), idParams("bob-session")),
));

test("[id] PATCH benennt die Session eines anderen Kontos nicht um", deniesForeignSession(
  "PATCH /api/sessions/[id]",
  (headers, id) => detailRoute.PATCH(
    new Request(`http://localhost/api/sessions/${id}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "gekapert" }),
    }),
    idParams(id),
  ),
));

test("[id] PATCH verlangt eine Identitaet", requiresIdentity(
  "PATCH /api/sessions/[id] anonym",
  (headers) => detailRoute.PATCH(
    new Request("http://localhost/api/sessions/bob-session", {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "gekapert" }),
    }),
    idParams("bob-session"),
  ),
));

test("[id] DELETE loescht die Session eines anderen Kontos nicht", deniesForeignSession(
  "DELETE /api/sessions/[id]",
  (headers, id) => detailRoute.DELETE(
    new Request(`http://localhost/api/sessions/${id}`, { method: "DELETE", headers }),
    idParams(id),
  ),
));

test("[id] DELETE verlangt eine Identitaet", requiresIdentity(
  "DELETE /api/sessions/[id] anonym",
  (headers) => detailRoute.DELETE(
    new Request("http://localhost/api/sessions/bob-session", { method: "DELETE", headers }),
    idParams("bob-session"),
  ),
));

// ------------------------------------------------------- [id]/state --

test("[id]/state GET weist die Session eines anderen Kontos ab", deniesForeignSession(
  "GET /api/sessions/[id]/state",
  (headers, id) => stateRoute.GET(get(`/api/sessions/${id}/state`, headers), idParams(id)),
));

test("[id]/state GET verlangt eine Identitaet", requiresIdentity(
  "GET /api/sessions/[id]/state anonym",
  (headers) => stateRoute.GET(get("/api/sessions/bob-session/state", headers), idParams("bob-session")),
));

// ------------------------------------------------------ [id]/context --

test("[id]/context GET weist die Session eines anderen Kontos ab", deniesForeignSession(
  "GET /api/sessions/[id]/context",
  (headers, id) => contextRoute.GET(get(`/api/sessions/${id}/context`, headers), idParams(id)),
));

test("[id]/context GET verlangt eine Identitaet", requiresIdentity(
  "GET /api/sessions/[id]/context anonym",
  (headers) => contextRoute.GET(get("/api/sessions/bob-session/context", headers), idParams("bob-session")),
));

// --------------------------------------------------------- [id]/export --

test("[id]/export GET weist die Session eines anderen Kontos ab", async (t) => {
  const w = world(t);
  const response = await exportRoute.GET(
    get("/api/sessions/bob-session/export", ALICE),
    idParams("bob-session"),
  );
  await assertNotOwned(response, "GET /api/sessions/[id]/export");
  assert.deepEqual(w.opened, [], "die fremde Session wurde geoeffnet");
});

test("[id]/export GET verlangt eine Identitaet", async (t) => {
  const w = world(t);
  const response = await exportRoute.GET(
    get("/api/sessions/bob-session/export", ANON),
    idParams("bob-session"),
  );
  await assertUnauthenticated(response, "GET /api/sessions/[id]/export anonym");
  assert.deepEqual(w.opened, []);
});

// ------------------------------------------------------- [id]/auto-name --

test("[id]/auto-name POST benennt die Session eines anderen Kontos nicht um", async (t) => {
  const w = world(t);
  const response = await autoNameRoute.POST(
    new Request("http://localhost/api/sessions/bob-session/auto-name", { method: "POST", headers: ALICE }),
    idParams("bob-session"),
  );
  await assertNotOwned(response, "POST /api/sessions/[id]/auto-name");
  assert.deepEqual(w.opened, [], "die fremde Session wurde geoeffnet");
});

test("[id]/auto-name POST verlangt eine Identitaet", async (t) => {
  const w = world(t);
  const response = await autoNameRoute.POST(
    new Request("http://localhost/api/sessions/bob-session/auto-name", { method: "POST", headers: ANON }),
    idParams("bob-session"),
  );
  await assertUnauthenticated(response, "POST /api/sessions/[id]/auto-name anonym");
  assert.deepEqual(w.opened, []);
});

// ------------------------------- [id]/entries/[entryId]/thinking --

test("[id]/entries/[entryId]/thinking GET weist die Session eines anderen Kontos ab", deniesForeignSession(
  "GET /api/sessions/[id]/entries/[entryId]/thinking",
  (headers, id) => thinkingRoute.GET(
    get(`/api/sessions/${id}/entries/e1/thinking?blockIndex=0`, headers),
    entryParams(id, "e1"),
  ),
));

test("[id]/entries/[entryId]/thinking GET verlangt eine Identitaet", requiresIdentity(
  "GET /api/sessions/[id]/entries/[entryId]/thinking anonym",
  (headers) => thinkingRoute.GET(
    get("/api/sessions/bob-session/entries/e1/thinking?blockIndex=0", headers),
    entryParams("bob-session", "e1"),
  ),
));

// ------------------------------------------------ die beiden Gegenproben --

test("der Besitzer sieht seine eigene Session weiterhin", async (t) => {
  const w = world(t);
  const response = await detailRoute.GET(
    get("/api/sessions/alice-session", ALICE),
    idParams("alice-session"),
  );

  assert.equal(response.status, 200, `erwartet 200, bekam ${response.status}`);
  assert.equal((await response.json()).sessionId, "alice-session");
  assert.equal(w.opened.length, 1, "die eigene Session muss geoeffnet werden — sonst sperrt der Guard den Besitzer aus");
  assert.match(w.opened[0], /alice-session\.jsonl$/);
});

test("der Admin sieht die Session eines anderen Kontos weiterhin", async (t) => {
  const w = world(t);
  const response = await detailRoute.GET(
    get("/api/sessions/bob-session", ADMIN),
    idParams("bob-session"),
  );

  assert.equal(response.status, 200, `erwartet 200, bekam ${response.status}`);
  assert.equal((await response.json()).sessionId, "bob-session");
  assert.equal(w.opened.length, 1, "der Admin-Zweig steckt in isSessionOwnedBy, nicht in einer Kopie hier");
  assert.match(w.opened[0], /bob-session\.jsonl$/);
});