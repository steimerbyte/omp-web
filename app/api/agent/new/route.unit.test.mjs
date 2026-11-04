import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `POST /api/agent/new` — das Denk-Level, das der Browser schickt.
 *
 * Die Route benutzt fuer den Selektor dieselbe Grammatik wie die CLI
 * (`parseOmpThinkingLevel` aus dem SDK). Ein Wert, den der Selektor nicht
 * kennt, wird abgelehnt — und zwar bevor eine Session entsteht: der Test
 * beobachtet die 500-Antwort und dass kein Agent gestartet wurde.
 *
 * Der gueltige Zweig braucht `startRpcSession` und damit einen echten Agenten;
 * die Grenze hier ist bewusst der Fehlerzweig.
 */

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { POST } = await jiti.import("./route.ts");
const { clearAllowedRootsCache } = await jiti.import("@/lib/allowed-roots");
const { invalidateSessionListCache } = await jiti.import("@/lib/session-reader");
const { allowFileRoot } = await jiti.import("@/lib/file-access");

const homeRoot = mkdtempSync(join(tmpdir(), "omp-web-agent-new-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
const aliceHome = join(homeRoot, "alice");
mkdirSync(aliceHome, { recursive: true });

// `OMP_WEB_HOME_ROOT` ist prozessweit, und `bun test` laedt die
// Testdateien im selben Prozess: eine Zuweisung auf Modulebene gilt nicht
// mehr, sobald eine andere Datei ihre eigene setzt. Deshalb pro Test.
test.beforeEach(() => {
  process.env.OMP_WEB_HOME_ROOT = homeRoot;
  // Die Route laesst nur cwd-Werte zu, die in einer bekannten Wurzel liegen —
  // das Home allein ist keine Wurzel. Im Betrieb kommt die Wurzel aus einer
  // Session; hier wird sie ausdruecklich vergeben.
  allowFileRoot(aliceHome, { username: "alice", isAdmin: false });
  // Wurzeln und Session-Liste werden prozessweit gecacht; ein Home-Root aus
  // einer anderen Testdatei wuerde sonst weiter gelten.
  // `allowFileRoot` leert nur den Lese-Cache; der Schreib-Cache spiegelt ihn und
  // haelt seine Menge 5 s. Ohne das Leeren gewinnt in einem kombinierten Lauf
  // die leere Menge einer frueheren Datei.
  globalThis.__ompWriteRootsCache?.clear();
  clearAllowedRootsCache();
  invalidateSessionListCache();
});

test.after(() => {
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  rmSync(homeRoot, { recursive: true, force: true });
});

const ALICE = { host: "localhost", "x-omp-user": "alice" };

function post(body) {
  return POST(new Request("http://localhost/api/agent/new", {
    method: "POST",
    headers: { ...ALICE, "content-type": "application/json" },
    body: JSON.stringify({ cwd: aliceHome, ...body }),
  }));
}

test("ein unbekanntes Denk-Level wird abgelehnt, ohne Session", async () => {
  const res = await post({ type: "prompt", message: "hi", thinkingLevel: "super-high" });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /Invalid thinking level: super-high/);
  // Ein abgelehnter Prompt ist kein akzeptierter Prompt.
  assert.equal(body.code, "prompt_rejected");
  assert.equal(body.accepted, false);
});

test("ein Nicht-String als Denk-Level wird ebenfalls abgelehnt", async () => {
  const res = await post({ type: "prompt", message: "hi", thinkingLevel: 5 });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /Invalid thinking level: 5/);
});

test("ein fehlendes Paar aus provider und modelId wird abgelehnt", async () => {
  const res = await post({ type: "ensure_session", provider: "buds-gateway" });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /provider and modelId must be provided together/);
});

test("ohne JSON-Content-Type gibt es 415", async () => {
  const res = await POST(new Request("http://localhost/api/agent/new", {
    method: "POST",
    headers: { ...ALICE, "content-type": "text/plain" },
    body: "{}",
  }));
  assert.equal(res.status, 415);
});

test("ein Cross-Site-Request wird abgelehnt", async () => {
  const res = await POST(new Request("http://evil.example/api/agent/new", {
    method: "POST",
    headers: { ...ALICE, host: "evil.example", "content-type": "application/json" },
    body: JSON.stringify({ cwd: aliceHome }),
  }));
  assert.equal(res.status, 403);
});
