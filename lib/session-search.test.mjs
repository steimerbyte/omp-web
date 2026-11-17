import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Die Volltextsuche ueber Transkripte, an echten Session-Dateien gemessen.
 *
 * Jede Fixture wird vom echten `SessionManager` geschrieben, nicht von Hand
 * zusammengesetzt: nur so ist das Dateiformat (Titel-Zeile, Session-Zeile,
 * Eintraege) das, was die Suche im Betrieb liest. Handgeschriebene Zeilen
 * wuerden eine Formatannahme testen, die niemand sonst teilt.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
});

const {
  MAX_SESSION_SEARCH_BYTES,
  MAX_SESSION_SEARCH_HITS_PER_SESSION,
  MAX_SESSION_SEARCH_MATCHES,
  MAX_SESSION_SEARCH_MS,
  MAX_SESSION_SEARCH_SESSIONS,
  searchSessions,
} = await jiti.import("@/lib/session-search");
const { SessionManager } = await jiti.import("@oh-my-pi/pi-coding-agent");
const { invalidateSessionPathCache } = await jiti.import("@/lib/session-reader");

function resetSessionListState() {
  globalThis.__ompSessionListCache = undefined;
  globalThis.__ompSessionListPromise = undefined;
  globalThis.__ompSessionListPromiseGeneration = undefined;
  globalThis.__ompSessionListGeneration = 0;
}

const samuel = { username: "samuel", isAdmin: false };
const hannah = { username: "hannah", isAdmin: false };

/**
 * Ein leeres Konto-Heim, in dem Sessions wie im Betrieb entstehen.
 *
 * `OMP_WEB_HOME_ROOT` lenkt `getUserHome()` hierher; ohne das Praefix landeten
 * die Fixtures im echten Heim des Entwicklers.
 */
function createFixture(t) {
  const homeRoot = mkdtempSync(join(tmpdir(), "omp-web-search-"));
  const previousRoot = process.env.OMP_WEB_HOME_ROOT;
  process.env.OMP_WEB_HOME_ROOT = homeRoot;
  resetSessionListState();
  const homes = new Map();
  const sessionIds = [];

  const homeOf = (username) => {
    let home = homes.get(username);
    if (!home) {
      home = join(homeRoot, username);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      homes.set(username, home);
    }
    return home;
  };

  const addSession = async (username, messages, options = {}) => {
    const home = homeOf(username);
    const manager = SessionManager.create(
      home,
      SessionManager.getDefaultSessionDir(home, join(home, ".omp", "agent")),
    );
    for (const message of messages) manager.appendMessage(message);
    await manager.ensureOnDisk();
    if (options.name) await manager.setSessionName(options.name, "user");
    const id = manager.getSessionId();
    const file = manager.getSessionFile();
    if (options.mtime !== undefined) utimesSync(file, new Date(options.mtime), new Date(options.mtime));
    sessionIds.push(id);
    return { id, file, home };
  };

  t.after(() => {
    if (previousRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
    else process.env.OMP_WEB_HOME_ROOT = previousRoot;
    resetSessionListState();
    for (const id of sessionIds) invalidateSessionPathCache(id);
    rmSync(homeRoot, { recursive: true, force: true });
  });

  return { addSession, homeOf };
}

const user = (content) => ({ role: "user", content });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

test("findet eine Session ueber den Nachrichtentext, nicht ueber den Titel", async (t) => {
  const fx = createFixture(t);
  const target = await fx.addSession("samuel", [
    user("Bitte pruefe den Deployment-Fehler im Cluster"),
    assistant("Ich habe den Fehler in pod-7 gesehen."),
  ]);
  // Der Titel enthaelt das Wort, der Inhalt nicht: er darf nicht zaehlen.
  await fx.addSession("samuel", [user("anderes Thema")], { name: "Deployment-Fehler" });

  const result = await searchSessions(samuel, "fehler");

  assert.deepEqual(
    result.matches.map((m) => m.sessionId),
    [target.id],
    "nur die Session mit dem Wort im Transkript erscheint",
  );
  assert.equal(result.matches[0].hits, 2);
  assert.equal(result.matches[0].title, "Bitte pruefe den Deployment-Fehler im Cluster");
  assert.match(result.matches[0].snippet, /Deployment-Fehler im Cluster/);
  assert.equal(result.truncated, false);
});

test("ein Treffer nur im Tool-Ergebnis oder Tool-Aufruf zaehlt nicht", async (t) => {
  const fx = createFixture(t);
  await fx.addSession("samuel", [
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "Suchwort im Bash-Output" }],
      isError: false,
    },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-2", name: "read", arguments: { path: "Suchwort.txt" } },
        { type: "text", text: "Der Aufruf hat nichts ergeben." },
      ],
    },
    { role: "bashExecution", command: "echo Suchwort", output: "Suchwort" },
  ]);

  const result = await searchSessions(samuel, "Suchwort");
  assert.deepEqual(result.matches, []);
  assert.equal(result.scanned, 1);
});

test("ignoriert Gross-/Kleinschreibung und macht einen einzeiligen Ausschnitt", async (t) => {
  const fx = createFixture(t);
  await fx.addSession("samuel", [
    user("Zeile eins\n\n   Fehler    im   Pod\nZeile drei"),
    assistant("Ein Fehler reicht."),
  ]);

  const [match] = (await searchSessions(samuel, "  FEHLER  ")).matches;

  assert.ok(match, "die Suche ist getrimmt und unabhaengig von der Schreibung");
  assert.equal(match.hits, 2);
  assert.equal(match.snippet, "Zeile eins Fehler im Pod Zeile drei");
  assert.equal(match.snippet.includes("\n"), false, "der Ausschnitt ist einzeilig");
});

test("zaehlt Treffer pro Nachricht, nicht pro Vorkommen", async (t) => {
  const fx = createFixture(t);
  await fx.addSession("samuel", [user("Fehler Fehler Fehler"), user("kein Treffer")]);

  const [match] = (await searchSessions(samuel, "fehler")).matches;
  assert.equal(match.hits, 1);
});

test("ein Kompaktierungs-Summary zaehlt als Fundstelle", async (t) => {
  const fx = createFixture(t);
  const session = await fx.addSession("samuel", [user("spaeter")]);
  appendFileSync(
    session.file,
    `${JSON.stringify({
      type: "compaction",
      id: "compaction-1",
      parentId: null,
      timestamp: "2026-01-02T03:04:05.000Z",
      summary: "Zusammengefasst: der Rollout scheiterte am Zertifikat",
      firstKeptEntryId: null,
      tokensBefore: 1234,
    })}\n`,
  );

  const [match] = (await searchSessions(samuel, "zertifikat")).matches;
  assert.ok(match, "der Summary steht nach der Kompaktierung fuer den alten Verlauf");
  assert.equal(match.hits, 1);
  assert.equal(match.lastMatchedAt, "2026-01-02T03:04:05.000Z");
  assert.match(match.snippet, /Zertifikat/);
});

test("sortiert Treffer nach der neuesten Session zuerst", async (t) => {
  const fx = createFixture(t);
  const oldest = await fx.addSession("samuel", [user("fehler alt")], { mtime: "2026-01-01T00:00:00.000Z" });
  const newest = await fx.addSession("samuel", [user("fehler neu")], { mtime: "2026-01-03T00:00:00.000Z" });
  const middle = await fx.addSession("samuel", [user("fehler mittel")], { mtime: "2026-01-02T00:00:00.000Z" });

  const result = await searchSessions(samuel, "fehler");
  assert.deepEqual(
    result.matches.map((m) => m.sessionId),
    [newest.id, middle.id, oldest.id],
  );
});

test("kappt die Trefferliste bei 25 und meldet das", async (t) => {
  const fx = createFixture(t);
  for (let index = 0; index < MAX_SESSION_SEARCH_MATCHES + 2; index += 1) {
    await fx.addSession("samuel", [user(`fehler nummer ${index}`)], {
      mtime: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    });
  }

  const result = await searchSessions(samuel, "fehler");
  assert.equal(result.matches.length, MAX_SESSION_SEARCH_MATCHES);
  assert.equal(result.truncated, true, "mehr Treffer als die Anzeige fast, heisst abgeschnitten");
});

test("liest hoechstens 40 Sessions mit Treffern", async (t) => {
  const fx = createFixture(t);
  for (let index = 0; index < MAX_SESSION_SEARCH_SESSIONS + 2; index += 1) {
    await fx.addSession("samuel", [user(`fehler nummer ${index}`)], {
      mtime: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    });
  }

  const result = await searchSessions(samuel, "fehler");
  assert.equal(result.scanned, MAX_SESSION_SEARCH_SESSIONS, "nach 40 Sessions ist Schluss");
  assert.equal(result.matches.length, MAX_SESSION_SEARCH_MATCHES);
  assert.equal(result.truncated, true);
});

test("das Byte-Budget bricht eine Suche ab und meldet truncated", async (t) => {
  const fx = createFixture(t);
  await fx.addSession("samuel", [user("fehler mit viel text")]);

  const result = await searchSessions(samuel, "fehler", { maxBytes: 1 });
  assert.deepEqual(result.matches, [], "eine halb gelesene Datei traegt nichts bei");
  assert.equal(result.scanned, 1);
  assert.equal(result.truncated, true);
});

test("das Zeitbudget bricht ab, bevor eine Datei geoeffnet wird", async (t) => {
  const fx = createFixture(t);
  await fx.addSession("samuel", [user("fehler")]);

  const result = await searchSessions(samuel, "fehler", { maxMs: 0, now: () => 1000 });
  assert.deepEqual(result.matches, []);
  assert.equal(result.scanned, 0);
  assert.equal(result.truncated, true);
});

test("das Zeitbudget bricht auch mitten in einer Datei ab", async (t) => {
  const fx = createFixture(t);
  await fx.addSession("samuel", [user("fehler")]);
  // startedAt, die Pruefung vor der Session, dann der Leser: erst dort ist
  // das Budget ueberschritten.
  const times = [1000, 1000, 99_999];

  const result = await searchSessions(samuel, "fehler", {
    maxMs: 2000,
    now: () => times.shift() ?? 99_999,
  });
  assert.deepEqual(result.matches, [], "eine halb gelesene Datei traegt nichts bei");
  assert.equal(result.scanned, 1);
  assert.equal(result.truncated, true);
});

test("eine unlesbare Zeile oder ein fehlender Zeilenumbruch bricht nichts", async (t) => {
  const fx = createFixture(t);
  const session = await fx.addSession("samuel", [user("fehler am Anfang")]);
  appendFileSync(session.file, "{kaputt\n");
  appendFileSync(
    session.file,
    JSON.stringify({
      type: "message",
      id: "tail-1",
      parentId: null,
      timestamp: "2026-01-02T03:04:05.000Z",
      message: { role: "user", content: "fehler am Ende ohne Zeilenumbruch" },
    }),
  );

  const [match] = (await searchSessions(samuel, "fehler")).matches;
  assert.equal(match.sessionId, session.id);
  assert.equal(match.hits, 2);
  assert.equal(match.lastMatchedAt, "2026-01-02T03:04:05.000Z");
});

test("zaehlt hoechstens 99 Treffer pro Session", async (t) => {
  const fx = createFixture(t);
  const messages = [];
  for (let index = 0; index < MAX_SESSION_SEARCH_HITS_PER_SESSION + 10; index += 1) {
    messages.push(user(`wort nummer ${index}`));
  }
  await fx.addSession("samuel", messages);

  const [match] = (await searchSessions(samuel, "wort")).matches;
  assert.equal(match.hits, MAX_SESSION_SEARCH_HITS_PER_SESSION);
});

test("die Sessions eines anderen Kontos erscheinen nicht", async (t) => {
  const fx = createFixture(t);
  await fx.addSession("hannah", [user("geheimer fehler")]);
  const own = await fx.addSession("samuel", [user("eigener fehler")]);

  const samuelResult = await searchSessions(samuel, "fehler");
  assert.deepEqual(
    samuelResult.matches.map((m) => m.sessionId),
    [own.id],
  );

  const hannahResult = await searchSessions(hannah, "fehler");
  assert.equal(hannahResult.matches.length, 1);
  assert.equal(hannahResult.matches[0].sessionId !== own.id, true);
});

test("die Grenzen sind benannte Zahlen", () => {
  assert.equal(MAX_SESSION_SEARCH_MATCHES, 25);
  assert.equal(MAX_SESSION_SEARCH_SESSIONS, 40);
  assert.equal(MAX_SESSION_SEARCH_BYTES, 64 * 1024 * 1024);
  assert.equal(MAX_SESSION_SEARCH_MS, 2000);
  assert.equal(MAX_SESSION_SEARCH_HITS_PER_SESSION, 99);
});

test("misst die Dauer des Fixture-Scans", async (t) => {
  const fx = createFixture(t);
  for (let session = 0; session < 5; session += 1) {
    const messages = [];
    for (let message = 0; message < 200; message += 1) {
      messages.push(user(`Nachricht ${message} ueber ein Thema ohne Treffer`));
    }
    messages.push(user("der gesuchte begriff"));
    await fx.addSession("samuel", messages);
  }

  const startedAt = performance.now();
  const result = await searchSessions(samuel, "gesuchte begriff");
  const duration = performance.now() - startedAt;

  assert.equal(result.matches.length, 5);
  console.log(`Fixture-Scan (1005 Nachrichten in 5 Sessions): ${duration.toFixed(1)} ms`);
});
