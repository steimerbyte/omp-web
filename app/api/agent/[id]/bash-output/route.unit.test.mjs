import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `GET /api/agent/[id]/bash-output` — das Log einer Bash-Ausfuehrung.
 *
 * Der Durchlass haengt an zwei Dingen: der Pfad muss nach
 * `<tmpdir>/pi-bash-*.log` aufloesen, und die Session muss ihn als
 * `fullOutputPath` fuehren. Beides wird hier an der Route gemessen, mit einer
 * echten Datei und einer gepatchten `SessionManager`, wie es
 * `app/api/files/session-reference.identity.test.mjs` schon macht.
 *
 * Der Pfad ist trotzdem nicht frei: er kommt aus der URL. Wer ihn waehlt, waehlt
 * nicht die Session — die Session-Id kommt ebenfalls aus der URL, und die
 * Referenzpruefung bindet beides an die Identitaet.
 */

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const route = await jiti.import("./route.ts");
const { SessionManager } = await jiti.import("@oh-my-pi/pi-coding-agent");
const { MAX_INLINE_BASH_OUTPUT_BYTES } = await jiti.import("@/lib/bash-output");
const { clearAllowedRootsCache } = await jiti.import("@/lib/allowed-roots");
const { invalidateSessionListCache } = await jiti.import("@/lib/session-reader");

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const ALICE = { host: "localhost", "x-omp-user": "alice" };
const ANON = { host: "localhost" };

const root = mkdtempSync(join(tmpdir(), "omp-web-bash-output-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
const aliceHome = join(root, "alice");
mkdirSync(aliceHome, { recursive: true });

function outputPath(name) {
  return join(tmpdir(), `pi-bash-${name}-${process.pid}.log`);
}

const inlinePath = outputPath("inline");
writeFileSync(inlinePath, "line one\nline two\n");
const largePath = outputPath("large");
writeFileSync(largePath, "x".repeat(MAX_INLINE_BASH_OUTPUT_BYTES + 1));
const missingPath = outputPath("missing");
const unreferencedPath = outputPath("unreferenced");
writeFileSync(unreferencedPath, "not mine\n");

const sessionFile = join(root, "alice-session.jsonl");
writeFileSync(sessionFile, "{}\n");

let openedEntries = [];
const originalListAll = SessionManager.listAll;
const originalOpen = SessionManager.open;
SessionManager.listAll = async () => [{
  id: SESSION_ID,
  path: sessionFile,
  cwd: aliceHome,
  title: null,
  created: new Date(0),
  modified: new Date(0),
  messageCount: 1,
  firstMessage: "hallo",
}];
SessionManager.open = async (filePath) => {
  assert.equal(filePath, sessionFile);
  return {
    getEntries: () => openedEntries,
    getLeafId: () => null,
    getTree: () => [],
    getHeader: () => ({ id: "opened", timestamp: "2026-01-01T00:00:00.000Z" }),
    getSessionName: () => null,
    getSessionFile: () => filePath,
  };
};

// `OMP_WEB_HOME_ROOT` ist prozessweit, und `bun test` laedt die
// Testdateien im selben Prozess: eine Zuweisung auf Modulebene gilt nicht
// mehr, sobald eine andere Datei ihre eigene setzt. Deshalb pro Test.
test.beforeEach(() => {
  process.env.OMP_WEB_HOME_ROOT = root;
  // Wurzeln und Session-Liste werden prozessweit gecacht; ein Home-Root aus
  // einer anderen Testdatei wuerde sonst weiter gelten.
  clearAllowedRootsCache();
  invalidateSessionListCache();
});

test.after(() => {
  SessionManager.listAll = originalListAll;
  SessionManager.open = originalOpen;
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  rmSync(root, { recursive: true, force: true });
});

function bashExecutionEntries(...paths) {
  return paths.map((fullOutputPath, index) => ({
    type: "message",
    id: `e${index}`,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "bashExecution", command: "true", fullOutputPath },
  }));
}

function get(path, { headers = ALICE, download = false, sessionId = SESSION_ID } = {}) {
  const url = new URL(`http://localhost/api/agent/${sessionId}/bash-output`);
  if (path !== undefined) url.searchParams.set("path", path);
  if (download) url.searchParams.set("download", "1");
  return route.GET(new Request(url, { headers }), { params: Promise.resolve({ id: sessionId }) });
}

test("ohne path gibt es 400", async () => {
  openedEntries = [];
  const res = await get(undefined);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "path required" });
});

test("ein Pfad ausserhalb von <tmpdir>/pi-bash-*.log ist 400", async () => {
  openedEntries = [];
  for (const path of ["/etc/passwd", join(aliceHome, "pi-bash-x.log"), join(tmpdir(), "other.log")]) {
    const res = await get(path);
    assert.equal(res.status, 400, path);
    assert.deepEqual(await res.json(), { error: "invalid path" }, path);
  }
});

test("eine unbrauchbare URL ist 400", async () => {
  // `new URL(req.url)` in der Route; ein kaputter String kommt aus einem
  // Proxy, nicht aus einem Browser, und darf keinen 500er erzeugen.
  const res = await route.GET(
    { url: "http://[", headers: new Headers() },
    { params: Promise.resolve({ id: SESSION_ID }) },
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid url" });
});

test("ohne Identitaet gibt es 403, nicht 404", async () => {
  openedEntries = bashExecutionEntries(inlinePath);
  const res = await get(inlinePath, { headers: ANON });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "forbidden" });
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("ein Log, das nicht in der eigenen Session steht, ist 403", async () => {
  openedEntries = bashExecutionEntries(inlinePath);
  const res = await get(unreferencedPath);
  assert.equal(res.status, 403);
});

test("eine fremde Session-Id macht das eigene Log nicht lesbar", async () => {
  openedEntries = bashExecutionEntries(inlinePath);
  // Die Session-Id in der URL ist die des Aufrufers; eine andere (gueltige)
  // Form findet keine Session in `listAllSessions({ identity })`.
  const res = await get(inlinePath, { sessionId: "22222222-2222-4222-8222-222222222222" });
  assert.equal(res.status, 403);
  // Eine Id, die keine Session-Id ist, wird gar nicht erst aufgeloest.
  const malformed = await get(inlinePath, { sessionId: "../../etc" });
  assert.equal(malformed.status, 403);
});

test("ein referenziertes Log kommt inline zurueck", async () => {
  openedEntries = bashExecutionEntries(inlinePath);
  const res = await get(inlinePath);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    success: true,
    data: { output: "line one\nline two\n" },
  });
});

test("download=1 liefert einen Anhang mit dem vollen Inhalt", async () => {
  openedEntries = bashExecutionEntries(inlinePath);
  const res = await get(inlinePath, { download: true });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="bash-output.log"');
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(await res.text(), "line one\nline two\n");
});

test("ein zu grosses Log ist 413 mit Groesse und Deckel", async () => {
  openedEntries = bashExecutionEntries(largePath);
  const res = await get(largePath);
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.data.maxBytes, MAX_INLINE_BASH_OUTPUT_BYTES);
  assert.equal(body.data.size, MAX_INLINE_BASH_OUTPUT_BYTES + 1);
  assert.match(body.error, /too large/);
});

test("ein referenziertes, aber verschwundenes Log ist 404", async () => {
  openedEntries = bashExecutionEntries(missingPath);
  const res = await get(missingPath);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "full output unavailable" });
});
