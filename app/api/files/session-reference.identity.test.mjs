import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { createJiti } from "jiti";

/**
 * Der Session-Durchlass von `GET /api/files/*`, am ROUTE-HANDLER gemessen.
 *
 * ### Was hier geprueft wird
 *
 * `GET /api/files/...` darf eine Datei auch dann liefern, wenn sie in keinem
 * Root des Aufrufers liegt — dann, wenn sie in *seiner* Session vorkommt. Dafuer
 * gab es drei unabhaengige Luecken, die zusammen eine vollstaendige Umgehung der
 * Mandantengrenze ergaben:
 *
 * 1. Die Referenzpruefung bekam **keine Identitaet**. Die Session-Id steht im
 *    Query-String, also waehlt der Aufrufer die Session aus — jede Id auf diesem
 *    Host genuegte.
 * 2. Der Durchlass ersetzte **beide** Allowlist-Pruefungen, also auch die nach
 *    `realpath` aufgeloeste. Damit fiel der Test fuer `..` und symbolische Links
 *    ersatzlos weg, und ein Pfad ausserhalb der Roots wurde wie ein Pfad
 *    innerhalb behandelt.
 * 3. Die Referenzpruefung war eine Volltextsuche ueber den ganzen Session-Eintrag.
 *
 * Die ersten beiden sind hier die identity- und realpath-Halbte, die dritte die
 * Feld-Halbte in `lib/session-file-references.test.mjs`.
 *
 * ### Warum die Dateien wirklich existieren muessen
 *
 * `getAllowedFileRoots` und `isExistingPathWithinRoots` loesen Pfade mit
 * `realpathSync` auf und **verwerfen** eine Wurzel, die sich nicht aufloesen
 * laesst. Eine erfundene Fixture unter `/home/alice` faellt auf dieser Maschine
 * sofort aus der Wurzelmenge, und die Route antwortet dann 403 — aus dem
 * richtigen Grund, aber der Test koennte nicht unterscheiden, ob der Guard
 * greift oder die Wurzel fehlt. Deshalb liegt das gesamte Szenario unter einem
 * echten temporaeren Verzeichnis, und `OMP_WEB_HOME_ROOT` zeigt darauf.
 *
 * ### Warum jede Pruefung ihre eigene Welt aufbaut
 *
 * Weil sie sich sonst die Zustand zerstoeren: `SessionManager.listAll` ist ein
 * monkey-patch auf einem geteilten Modul und `OMP_WEB_HOME_ROOT` ein
 * prozessweites `process.env`. Ein gemeinsames Verzeichnis wuerde vom ersten
 * Test weggeräumt und alle folgenden liefeen gegen eine Welt ohne Dateien.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
});

const route = await jiti.import("./[...path]/route.ts");
const { SessionManager } = await jiti.import("@oh-my-pi/pi-coding-agent");
const { invalidateSessionListCache } = await jiti.import("@/lib/session-reader");
const { clearAllowedRootsCache } = await jiti.import("@/lib/allowed-roots");

const ALICE_SESSION = "11111111-1111-4111-8111-111111111111";
const BOB_SESSION = "22222222-2222-4222-8222-222222222222";

const ALICE = { host: "localhost", "x-omp-user": "alice" };
const BOB = { host: "localhost", "x-omp-user": "bob" };
const ADMIN = { host: "localhost", "x-omp-user": "pi", "x-omp-admin": "1" };
const ANON = { host: "localhost" };

function assistantEntry(id, content) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "assistant", content },
  };
}

function toolCall(id, name, args) {
  return { type: "toolCall", id, name, arguments: args };
}

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
 * Zwei Mandanten auf der Platte, mit echten Sessions und echten Roots.
 *
 * `aliceEntries` enthaelt drei Sorten von Pfaden:
 *
 * - `foreign` als **Fliesstext** — darf nichts oeffnen,
 * - `foreign` als **Pfadfeld** eines `read`-Aufrufs — oeffnet auch nichts, weil
 *   die Datei nicht in ihren Roots liegt,
 * - `own` als Pfadfeld — bleibt erreichbar, das ist der Nutzfall.
 *
 * `bobEntries` referenziert dieselbe fremde Datei strukturiert, damit die
 * "fremde Session-Id" unten einen Pfad hat, der ohne Guard tatsaechlich
 * durchgelassen wuerde.
 */
function buildWorld(t) {
  const root = mkdtempSync(join(tmpdir(), "omp-web-session-reference-"));
  // `bun test` teilt sich einen Prozess zwischen den Dateien. `OMP_WEB_HOME_ROOT`
  // ist prozessweit, also wird der vorherige Wert hier gesichert und im
  // `t.after` wiederhergestellt — sonst schiebt diese Datei das Home-Root aller
  // nachfolgenden Tests auf ein Wegwerfverzeichnis.
  const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
  process.env.OMP_WEB_HOME_ROOT = root;
  t.after(() => {
    if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
    else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  });

  const aliceProject = join(root, "alice", "project");
  const bobProject = join(root, "bob", "project");
  const foreignDir = join(root, "fremde-mandantin");
  for (const dir of [aliceProject, bobProject, foreignDir]) mkdirSync(dir, { recursive: true });

  const own = join(aliceProject, "notiz.md");
  writeFileSync(own, "# Notiz von alice\n");
  const foreign = join(foreignDir, "geheim.txt");
  writeFileSync(foreign, "geheim\n");

  const sessionFile = (name) => {
    const path = join(root, `${name}.jsonl`);
    // Die Datei muss da sein: `resolveSessionPath` verwirft Cache-Eintraege,
    // deren Datei fehlt.
    writeFileSync(path, "{}\n");
    return path;
  };
  const alicePath = sessionFile("alice");
  const bobPath = sessionFile("bob");

  const entriesByPath = new Map([
    [alicePath, [
      assistantEntry("a1", [{ type: "text", text: `schau mal ${foreign} und /etc/passwd an` }]),
      assistantEntry("a2", [toolCall("c1", "read", { path: foreign })]),
      assistantEntry("a3", [toolCall("c2", "read", { path: own })]),
    ]],
    [bobPath, [
      assistantEntry("b1", [toolCall("c3", "read", { path: foreign })]),
    ]],
  ]);

  const opened = [];
  const originalListAll = SessionManager.listAll;
  const originalOpen = SessionManager.open;
  SessionManager.listAll = async () => [
    sessionInfo(ALICE_SESSION, aliceProject, alicePath),
    sessionInfo(BOB_SESSION, bobProject, bobPath),
  ];
  SessionManager.open = async (filePath) => {
    opened.push(filePath);
    return {
      getEntries: () => entriesByPath.get(filePath) ?? [],
      getLeafId: () => null,
      getTree: () => [],
      getHeader: () => ({ id: "opened", timestamp: "2026-01-01T00:00:00.000Z" }),
      getSessionName: () => null,
      getSessionFile: () => filePath,
      getSessionPath: () => filePath,
    };
  };
  invalidateSessionListCache();
  clearAllowedRootsCache();

  t.after(() => {
    SessionManager.listAll = originalListAll;
    SessionManager.open = originalOpen;
    invalidateSessionListCache();
    clearAllowedRootsCache();
    rmSync(root, { recursive: true, force: true });
  });

  return { own, foreign, foreignDir, alicePath, bobPath, opened };
}

function get(target, { type = "read", sessionId, headers = ALICE } = {}) {
  const segments = target.split("/").filter(Boolean);
  const url = new URL(`http://localhost/api/files/${segments.map(encodeURIComponent).join("/")}`);
  url.searchParams.set("type", type);
  if (sessionId) url.searchParams.set("sessionId", sessionId);
  return route.GET(new NextRequest(url, { headers }), { params: Promise.resolve({ path: segments }) });
}

async function assertDenied(response, label) {
  assert.equal(response.status, 403, `${label}: erwartet 403, bekam ${response.status}`);
  assert.equal((await response.json()).error, "Access denied", label);
}

async function assertBody(response, label, expected) {
  assert.equal(response.status, 200, `${label}: erwartet 200, bekam ${response.status}`);
  assert.equal((await response.json()).content, expected, label);
}

// ------------------------------------------------------------------ Ablehnungen

test("GET weist eine fremde Datei ab, die nur als Fliesstext in der eigenen Session steht", async (t) => {
  const world = buildWorld(t);

  await assertDenied(
    await get(world.foreign, { sessionId: ALICE_SESSION }),
    "Fliesstext in der eigenen Session",
  );
});

test("GET weist eine fremde Datei ab, die als Pfadfeld der eigenen Session steht", async (t) => {
  const world = buildWorld(t);

  await assertDenied(
    await get(world.foreign, { sessionId: ALICE_SESSION }),
    "Pfadfeld in der eigenen Session, Datei ausserhalb der Roots",
  );
});

test("GET weist die Session eines anderen Kontos ab", async (t) => {
  const world = buildWorld(t);

  await assertDenied(
    await get(world.foreign, { sessionId: BOB_SESSION }),
    "fremde Session-Id",
  );
  assert.deepEqual(world.opened, [], "die fremde Session wurde geoeffnet");
});

test("GET weist einen Pfad ab, der in gar keiner Session steht", async (t) => {
  const world = buildWorld(t);

  await assertDenied(
    await get(world.foreign, { sessionId: ALICE_SESSION, headers: BOB }),
    "fremde Datei ohne jeden Session-Bezug",
  );
});

test("GET weist /etc/passwd mit der eigenen Session-Id ab", async (t) => {
  buildWorld(t);

  await assertDenied(
    await get("/etc/passwd", { sessionId: ALICE_SESSION }),
    "/etc/passwd mit eigener Session-Id",
  );
});

test("GET braucht eine Identitaet, auch mit Session-Id", async (t) => {
  const world = buildWorld(t);

  await assertDenied(
    await get(world.own, { sessionId: ALICE_SESSION, headers: ANON }),
    "ohne Identitaet",
  );
});

// ------------------------------------------------------------- Nutzfall bleibt

test("GET liefert die eigene Session-Datei weiterhin im eigenen Root", async (t) => {
  const world = buildWorld(t);

  await assertBody(
    await get(world.own, { sessionId: ALICE_SESSION }),
    "eigene Datei",
    "# Notiz von alice\n",
  );
});

test("GET liefert dem Admin weiterhin alles", async (t) => {
  const world = buildWorld(t);

  // Der Admin hat `/` als Wurzel (`getAdditionalAllowedRoots`). Die
  // realpath-Pruefung muss fuer ihn folgenlos bleiben — sonst waere der Fix
  // hier eine Rechtewegnahme des Admins.
  await assertBody(
    await get("/etc/passwd", { sessionId: ALICE_SESSION, headers: ADMIN }),
    "Admin liest /etc/passwd",
    readFileSync("/etc/passwd", "utf-8"),
  );

  const foreign = await get(world.foreign, { sessionId: BOB_SESSION, headers: ADMIN });
  assert.equal(foreign.status, 200, `Admin liest die Datei der fremden Mandantin: ${foreign.status}`);
  assert.equal((await foreign.json()).content, "geheim\n");
});

test("GET liefert dem Admin die Session-Datei auch ueber den Durchlass", async (t) => {
  const world = buildWorld(t);

  await assertBody(
    await get(world.own, { sessionId: ALICE_SESSION, headers: ADMIN }),
    "Admin liest die Session-Datei",
    "# Notiz von alice\n",
  );
});

// ------------------------------------------------------------------- type-Werte

/**
 * Der Durchlass galt fuer **alle** Nicht-`list`-Typen, weil er vor der
 * Aufteilung in `read`/`download`/`meta`/`preview`/`watch`/`list` geprueft wurde.
 * Der Test haelt alle fuenf fest, damit eine spaetere Verschiebung der
 * Pruefungen nicht nur einen davon wieder aufreisst.
 */
const NON_LIST_TYPES = ["read", "download", "meta", "preview", "watch"];

for (const type of NON_LIST_TYPES) {
  test(`GET weist type=${type} fuer eine fremde, sessionreferenzierte Datei ab`, async (t) => {
    const world = buildWorld(t);

    await assertDenied(
      await get(world.foreign, { type, sessionId: ALICE_SESSION }),
      `type=${type}`,
    );
  });
}

test("GET haelt type=list vom Durchlass fern", async (t) => {
  const world = buildWorld(t);

  // `list` war und bleibt ausgeschlossen: der Durchlass darf kein Verzeichnis
  // aufzaehlen, auch nicht eines, das nur als Pfadfeld in der Session steht.
  await assertDenied(
    await get(world.foreignDir, { type: "list", sessionId: ALICE_SESSION }),
    "type=list auf fremdem Verzeichnis",
  );
});