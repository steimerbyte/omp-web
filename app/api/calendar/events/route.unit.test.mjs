import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `GET /api/calendar/events` — SSE-Strom der Kalenderaenderungen.
 *
 * Der Broadcast ist prozessweit; der Abonnent filtert nach seiner Identitaet.
 * Gemessen wird beides: dass die fremde Aenderung keinen Frame erzeugt und die
 * eigene schon, und dass der Abbruch den Abonnenten wieder abmeldet.
 */

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { GET } = await jiti.import("./route.ts");
const { notifyCalendarChange } = await jiti.import("@/lib/calendar-store");

const homeRoot = mkdtempSync(join(tmpdir(), "omp-web-calendar-events-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
mkdirSync(join(homeRoot, "alice"), { recursive: true });

// `OMP_WEB_HOME_ROOT` ist prozessweit, und `bun test` laedt die
// Testdateien im selben Prozess: eine Zuweisung auf Modulebene gilt nicht
// mehr, sobald eine andere Datei ihre eigene setzt. Deshalb pro Test.
test.beforeEach(() => {
  process.env.OMP_WEB_HOME_ROOT = homeRoot;
});

test.after(() => {
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  rmSync(homeRoot, { recursive: true, force: true });
});

const ALICE = { host: "localhost", "x-omp-user": "alice" };
const ANON = { host: "localhost" };
const decoder = new TextDecoder();

function request({ headers = ALICE, signal } = {}) {
  return new Request("http://localhost/api/calendar/events", { headers, signal });
}


/**
 * Laesst den Keep-alive-Interval genau einmal laufen.
 *
 * Die Route setzt ihn auf 30 s; ein Test, der wartet, waere langsamer als die
 * ganze Suite. Ersetzt wird nur das globale `setInterval` fuer die Dauer des
 * Aufrufs, damit der Callback wirklich ausgefuehrt wird.
 */
async function withImmediateHeartbeat(run) {
  const original = globalThis.setInterval;
  globalThis.setInterval = (callback) => {
    callback();
    return 0;
  };
  try {
    return await run();
  } finally {
    globalThis.setInterval = original;
  }
}

test("der Keep-alive-Frame kommt als Kommentar-Zeile", async () => {
  const abort = new AbortController();
  const res = await withImmediateHeartbeat(() => GET(request({ signal: abort.signal })));
  const reader = res.body.getReader();
  await reader.read(); // connected
  assert.equal(decoder.decode((await reader.read()).value), ":\n\n");

  abort.abort();
  await reader.read();
});
test("ein Cross-Site-Request oeffnet keinen Strom", async () => {
  const res = await GET(request({ headers: { ...ALICE, host: "evil.example" } }));
  assert.equal(res.status, 403);
  assert.equal(await res.text(), "Untrusted API request");
});

test("ohne Identitaet gibt es 403, keinen leeren Strom", async () => {
  const res = await GET(request({ headers: ANON }));
  assert.equal(res.status, 403);
  assert.equal(await res.text(), "Unknown user");
});

test("nur die eigene Aenderung kommt als benannter Frame an", async (t) => {
  const abort = new AbortController();
  const res = await GET(request({ signal: abort.signal }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");

  const reader = res.body.getReader();
  const connected = decoder.decode((await reader.read()).value);
  assert.equal(connected, 'event: connected\ndata: {"type":"connected"}\n\n');

  // Eine fremde Aenderung darf keinen Frame erzeugen — sonst waere die
  // Meldung fuer den Client nicht von seiner eigenen zu unterscheiden.
  notifyCalendarChange({ username: "bob", isAdmin: false });
  // Und die eigene muss ankommen.
  notifyCalendarChange({ username: "alice", isAdmin: false });
  const changed = decoder.decode((await reader.read()).value);
  assert.equal(changed, 'event: calendar_changed\ndata: {"type":"calendar_changed"}\n\n');

  abort.abort();
  const end = await reader.read();
  assert.equal(end.done, true, "der Strom muss nach dem Abbruch schliessen");
});
