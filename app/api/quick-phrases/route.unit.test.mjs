import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `/api/quick-phrases` — die Phrasenliste eines Kontos.
 *
 * Der Speicher ist eine Datei pro Konto unter `$HOME/<name>/.omp/agent`. Der
 * Test laeuft gegen ein temporaeres Home, damit „geschrieben" auch „gelesen"
 * heisst: eine Route, die 200 sagt und nichts schreibt, faellt hier auf.
 */

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { GET, PUT } = await jiti.import("./route.ts");

const homeRoot = mkdtempSync(join(tmpdir(), "omp-web-quick-phrases-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
const aliceHome = join(homeRoot, "alice");
mkdirSync(aliceHome, { recursive: true });

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
const storePath = join(aliceHome, ".omp", "agent", "omp-web-quick-phrases.json");

function request(url = "/api/quick-phrases", { method = "GET", headers = ALICE, body, contentType = "application/json" } = {}) {
  return new Request(`http://${headers.host ?? "localhost"}${url}`, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": contentType }),
    },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

test("ein Cross-Site-Request wird abgelehnt", async () => {
  const res = await GET(request(undefined, { headers: { ...ALICE, host: "evil.example" } }));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Untrusted API request" });
});

test("ohne Identitaet gibt es 403", async () => {
  const res = await GET(request(undefined, { headers: ANON }));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Access denied" });
});

test("ohne Datei meldet GET exists:false und eine leere Liste", async () => {
  rmSync(storePath, { force: true });
  const res = await GET(request());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { phrases: [], exists: false });
});

test("PUT schreibt die Liste und GET liest sie zurueck", async () => {
  const phrases = [
    { label: "Test", text: "fuehre den Test aus" },
    { label: "", text: "ohne Label" },
    // Ungueltige Eintraege fallen vor dem Schreiben weg: kein Text, kein Knopf.
    { label: "leer", text: "" },
    { label: "kein text" },
  ];
  const put = await PUT(request(undefined, { method: "PUT", body: { phrases } }));
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), {
    phrases: [
      { label: "Test", text: "fuehre den Test aus" },
      { label: "", text: "ohne Label" },
    ],
    exists: true,
  });

  // Der Beweis ist die Datei, nicht die Antwort.
  const stored = JSON.parse(readFileSync(storePath, "utf8"));
  assert.deepEqual(stored.phrases, [
    { label: "Test", text: "fuehre den Test aus" },
    { label: "", text: "ohne Label" },
  ]);

  const get = await GET(request());
  assert.deepEqual(await get.json(), { phrases: stored.phrases, exists: true });
});

test("eine leere Liste ist eine Entscheidung, kein 'nie gelesen'", async () => {
  const put = await PUT(request(undefined, { method: "PUT", body: { phrases: [] } }));
  assert.equal(put.status, 200);
  const get = await GET(request());
  assert.deepEqual(await get.json(), { phrases: [], exists: true });
});

test("kaputter Dateiinhalt liest als exists:true mit leerer Liste", async () => {
  mkdirSync(join(aliceHome, ".omp", "agent"), { recursive: true });
  writeFileSync(storePath, "{nicht json");
  const res = await GET(request());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { phrases: [], exists: true });
});

test("PUT ohne JSON-Content-Type ist 415", async () => {
  const res = await PUT(request(undefined, {
    method: "PUT",
    body: { phrases: [] },
    contentType: "text/plain",
  }));
  assert.equal(res.status, 415);
});

test("PUT verlangt ein Objekt mit phrases-Array", async () => {
  for (const body of [[], { phrases: "nope" }, { other: [] }, "{}"]) {
    const res = await PUT(request(undefined, { method: "PUT", body }));
    assert.equal(res.status, 400, JSON.stringify(body));
    const parsed = await res.json();
    assert.ok(parsed.error, JSON.stringify(body));
  }
});

test("ein Schreibfehler ist 500 und laesst die Antwort nicht wie Erfolg aussehen", async () => {
  // `.omp` als regulaere Datei: das Verzeichnis fuer den Store laesst sich nicht
  // anlegen, und der Fehler darf nicht als 200 durchgehen.
  rmSync(join(aliceHome, ".omp"), { recursive: true, force: true });
  writeFileSync(join(aliceHome, ".omp"), "kein Verzeichnis\n");

  const res = await PUT(request(undefined, { method: "PUT", body: { phrases: [{ text: "x" }] } }));
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "Unable to save quick phrases" });

  rmSync(join(aliceHome, ".omp"), { force: true });
});
