import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { sessionPathKey } = await jiti.import("./session-path.ts");
const {
  listAllSessions,
  mergeSessionLists,
  buildSessionContext,
  cacheSessionPath,
  invalidateSessionListCache,
  invalidateSessionPathCache,
  readSessionHeader,
  readSessionRecord,
  resolveSessionIdByPath,
  resolveSessionPath,
} = await jiti.import("./session-reader.ts");
const { SessionManager } = await jiti.import("@oh-my-pi/pi-coding-agent");

function resetSessionListState() {
  globalThis.__ompSessionListCache = undefined;
  globalThis.__ompSessionListPromise = undefined;
  globalThis.__ompSessionListPromiseGeneration = undefined;
  globalThis.__ompSessionListGeneration = 0;
}

function userEntry(id, parentId, content, timestamp = "2026-01-01T00:00:00.000Z") {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "user",
      content,
    },
  };
}

function assistantEntry(id, parentId, text, timestamp = "2026-01-01T00:00:00.000Z") {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      provider: "test",
      model: "test-model",
      content: [{ type: "text", text }],
    },
  };
}

// omp renders the compaction summary at the chronological point it fired —
// after the kept messages, before the post-compaction turns — so the browser
// transcript matches what the TUI shows.
test("renders the SDK compaction-aware context with aligned entry IDs", () => {
  const entries = [
    userEntry("u1", null, "old user request"),
    assistantEntry("a1", "u1", "old assistant answer"),
    userEntry("u2", "a1", "kept user request"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "old exchange summary",
      firstKeptEntryId: "u2",
      tokensBefore: 123,
    },
    userEntry("u3", "cmp", "after compaction"),
  ];

  const context = buildSessionContext(entries);

  assert.deepEqual(context.entryIds, ["u2", "cmp", "u3"]);
  assert.deepEqual(
    context.messages.map((message) => [message.role, message.customType, message.content]),
    [
      ["user", undefined, "kept user request"],
      ["custom", "compaction", "old exchange summary"],
      ["user", undefined, "after compaction"],
    ],
  );
});

test("uses only the latest compaction on the active path", () => {
  const entries = [
    userEntry("u1", null, "old request"),
    assistantEntry("a1", "u1", "old answer"),
    userEntry("u2", "a1", "first kept request"),
    {
      type: "compaction",
      id: "cmp1",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "first summary",
      firstKeptEntryId: "u2",
      tokensBefore: 100,
    },
    assistantEntry("a2", "cmp1", "second kept answer"),
    userEntry("u3", "a2", "second kept request"),
    {
      type: "compaction",
      id: "cmp2",
      parentId: "u3",
      timestamp: "2026-01-01T00:00:06.000Z",
      summary: "latest summary",
      firstKeptEntryId: "a2",
      tokensBefore: 200,
    },
    assistantEntry("a3", "cmp2", "latest answer"),
  ];

  const context = buildSessionContext(entries);

  assert.deepEqual(context.entryIds, ["a2", "u3", "cmp2", "a3"]);
  assert.equal(context.messages[2].role, "custom");
  assert.equal(context.messages[2].content, "latest summary");
  assert.equal(context.messages.length, context.entryIds.length);
});

test("uses the selected leaf's path before a later compaction", () => {
  const entries = [
    userEntry("u1", null, "root request"),
    assistantEntry("a1", "u1", "root answer"),
    userEntry("u2", "a1", "main branch"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "main branch summary",
      firstKeptEntryId: "u2",
      tokensBefore: 100,
    },
    userEntry("alt", "a1", "alternate branch"),
  ];

  const context = buildSessionContext(entries, "alt");

  assert.deepEqual(context.entryIds, ["u1", "a1", "alt"]);
  assert.equal(context.messages.some((message) => message.role === "custom"), false);
});

test("returns an empty context for a null leaf", () => {
  const context = buildSessionContext([
    userEntry("u1", null, "not active"),
  ], null);

  assert.deepEqual(context.messages, []);
  assert.deepEqual(context.entryIds, []);
});

test("defers historical thinking without changing live-session content", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      ...assistantEntry("a1", "u1", "answer"),
      message: {
        role: "assistant",
        provider: "test",
        model: "test-model",
        content: [
          { type: "thinking", thinking: "large reasoning" },
          { type: "text", text: "answer" },
        ],
      },
    },
  ];

  const deferred = buildSessionContext(entries, undefined, { deferThinking: true });
  assert.deepEqual(deferred.messages[1].content[0], {
    type: "thinking",
    thinking: "",
    deferred: true,
  });

  const full = buildSessionContext(entries);
  assert.equal(full.messages[1].content[0].thinking, "large reasoning");
});

test("does not defer empty historical thinking blocks", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      ...assistantEntry("a1", "u1", "answer"),
      message: {
        role: "assistant",
        provider: "test",
        model: "test-model",
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: "answer" },
        ],
      },
    },
  ];

  const context = buildSessionContext(entries, undefined, { deferThinking: true });
  assert.deepEqual(context.messages[1].content[0], { type: "thinking", thinking: "" });
});

test("defers only base64 images from historical tool results", () => {
  const userImage = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
  };
  const toolImage = {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: "QUJDRA==" },
  };
  const toolUrlImage = {
    type: "image",
    source: { type: "url", url: "https://example.com/result.png" },
  };
  const flatToolImage = {
    type: "image",
    data: "QUJDRA==",
    mimeType: "image/png",
  };
  const entries = [
    userEntry("u1", null, [{ type: "text", text: "inspect this" }, userImage]),
    assistantEntry("a1", "u1", "reading"),
    {
      type: "message",
      id: "tr1",
      parentId: "a1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call1",
        content: [
          { type: "text", text: "Read image file" },
          toolImage,
          flatToolImage,
          toolUrlImage,
        ],
      },
    },
  ];

  const deferred = buildSessionContext(entries, undefined, { deferToolResultImages: true });
  assert.deepEqual(deferred.messages[0].content[1], userImage);
  assert.deepEqual(deferred.messages[2].content[0], { type: "text", text: "Read image file" });
  assert.deepEqual(deferred.messages[2].content[1], toolUrlImage);
  assert.match(deferred.messages[2].content[2].text, /2 tool result images omitted.*image\/jpeg, image\/png.*~8 bytes/);

  const full = buildSessionContext(entries);
  assert.deepEqual(full.messages[2].content[1], toolImage);
  assert.deepEqual(full.messages[2].content[2], flatToolImage);
  assert.deepEqual(full.messages[2].content[3], toolUrlImage);
});

test("preserves hidden custom messages with their display flag for the UI", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      type: "custom_message",
      id: "c1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:01.000Z",
      customType: "extension_debug",
      content: "hidden extension payload",
      display: false,
      details: { source: "test" },
    },
    assistantEntry("a1", "c1", "done"),
  ];

  const context = buildSessionContext(entries);

  assert.deepEqual(context.entryIds, ["u1", "c1", "a1"]);
  assert.equal(context.messages[1].role, "custom");
  assert.equal(context.messages[1].customType, "extension_debug");
  assert.equal(context.messages[1].display, false);
  assert.equal(context.messages[1].content, "hidden extension payload");
});

test("preserves valid epoch timestamps on synthetic UI messages", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u1",
      timestamp: "1970-01-01T00:00:00.000Z",
      summary: "epoch summary",
      firstKeptEntryId: "u1",
      tokensBefore: 10,
    },
  ];

  const context = buildSessionContext(entries);

  assert.deepEqual(context.entryIds, ["u1", "cmp"]);
  assert.equal(context.messages[1].role, "custom");
  assert.equal(context.messages[1].customType, "compaction");
  assert.equal(context.messages[1].timestamp, 0);
});

test("reads only a bounded session header, including headers larger than 4 KiB", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-header-"));
  const filePath = join(dir, "session.jsonl");
  const parentSession = `/tmp/${"p".repeat(5_000)}.jsonl`;
  // This fixture deviates from the real layout on purpose, and the deviation is
  // the point: a real writer puts a `title` record in line 1 (400 of 400 files
  // measured 2026-10-12), so a one-line reader can never find the header in a
  // file that exists. `readSessionHeader` is exactly that reader, and this test
  // pins its bound — one line, so an oversized `parentSession` is still read
  // without loading the file — for a file shaped the way it accepts.
  //
  // The test below covers the real layout end to end, where the same function
  // returns null and `readSessionRecord` finds the record. Do not "fix" this
  // fixture to match the writer: that would make the function under test
  // untested for the case it exists to handle.
  writeFileSync(filePath, `${JSON.stringify({
    type: "session",
    version: 3,
    id: "session",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: dir,
    parentSession,
  })}\n${JSON.stringify(userEntry("u1", null, "message"))}\n`);

  try {
    assert.equal(readSessionHeader(filePath)?.parentSession, parentSession);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns null for malformed or unbounded session headers", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-header-invalid-"));
  const malformedPath = join(dir, "malformed.jsonl");
  const oversizedPath = join(dir, "oversized.jsonl");
  writeFileSync(malformedPath, "{not-json}\n");
  writeFileSync(oversizedPath, "x".repeat(64 * 1024));

  try {
    assert.equal(readSessionHeader(malformedPath), null);
    assert.equal(readSessionHeader(oversizedPath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reads the session record from a real on-disk layout, where a title record comes first", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-record-"));
  const filePath = join(dir, "session.jsonl");
  const parentSession = `/tmp/${"q".repeat(4_000)}.jsonl`;
  // The layout that is actually on disk, verified 2026-10-12 across 400 real
  // session files: the first line is a `title` record in 400 of 400, the
  // `session` record follows it. `readSessionHeader` reads one line and accepts
  // it only if `type` is `session`, so it returns null for every session that
  // really exists — and the test above cannot catch that, because its fixture
  // writes `type: "session"` into the first line, a file no writer produces.
  writeFileSync(filePath, `${JSON.stringify({
    type: "title",
    title: "A session with a real title record first",
  })}\n${JSON.stringify({
    type: "session",
    version: 3,
    id: "session",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: dir,
    parentSession,
  })}\n${JSON.stringify(userEntry("u1", null, "message"))}\n`);

  try {
    // The contrast is the point: the same file, read by both functions.
    assert.equal(readSessionHeader(filePath), null);
    assert.equal(readSessionRecord(filePath)?.parentSession, parentSession);
    assert.equal(readSessionRecord(filePath)?.id, "session");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps forward and reverse session path caches in sync", async () => {
  const sessionId = "cache-test-session";
  const filePath = join(tmpdir(), "omp-web-cache-test", "..", "cache-test", "session.jsonl");

  cacheSessionPath(sessionId, filePath);
  try {
    assert.equal(
      await resolveSessionIdByPath(filePath),
      sessionId,
    );
  } finally {
    invalidateSessionPathCache(sessionId);
  }

  assert.equal(globalThis.__ompSessionPathCache?.has(sessionId), false);
  assert.equal(globalThis.__ompPathToSessionIdCache?.has(sessionPathKey(filePath)), false);
});

test("drops cached paths for transient sessions that were never persisted", async (t) => {
  const sessionId = "transient-cache-test-session";
  const dir = mkdtempSync(join(tmpdir(), "omp-web-transient-session-"));
  const filePath = join(dir, "session.jsonl");
  const originalListAll = SessionManager.listAll;
  SessionManager.listAll = async () => [];
  resetSessionListState();
  cacheSessionPath(sessionId, filePath);
  t.after(() => {
    SessionManager.listAll = originalListAll;
    invalidateSessionPathCache(sessionId);
    resetSessionListState();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(await resolveSessionPath(sessionId), null);
  assert.equal(globalThis.__ompSessionPathCache?.has(sessionId), false);
});

test("forced session listing bypasses the fresh server cache", async (t) => {
  const originalListAll = SessionManager.listAll;
  let scans = 0;
  SessionManager.listAll = async () => {
    scans += 1;
    return [];
  };
  resetSessionListState();
  t.after(() => {
    SessionManager.listAll = originalListAll;
    resetSessionListState();
  });

  await listAllSessions({ force: true });
  await listAllSessions();
  assert.equal(scans, 1);

  await listAllSessions({ force: true });
  assert.equal(scans, 2);
});

test("a scan invalidated in flight retries before returning to its caller", async (t) => {
  const originalListAll = SessionManager.listAll;
  let scans = 0;
  let releaseFirstScan;
  let markFirstScanStarted;
  const firstScanStarted = new Promise((resolve) => {
    markFirstScanStarted = resolve;
  });
  const firstScanGate = new Promise((resolve) => {
    releaseFirstScan = resolve;
  });
  SessionManager.listAll = async () => {
    scans += 1;
    if (scans === 1) {
      markFirstScanStarted();
      await firstScanGate;
    }
    return [];
  };
  resetSessionListState();
  t.after(() => {
    SessionManager.listAll = originalListAll;
    resetSessionListState();
  });

  const listing = listAllSessions({ force: true });
  await firstScanStarted;
  invalidateSessionListCache();
  releaseFirstScan();
  await listing;

  assert.equal(scans, 2);
});

test("disk sessions replace runtime snapshots with the same id", () => {
  const base = {
    path: "/tmp/session.jsonl",
    id: "same-id",
    cwd: "/tmp",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:01.000Z",
    messageCount: 2,
    firstMessage: "persisted",
  };
  const persisted = { ...base };
  const runtime = {
    ...base,
    path: "/tmp/not-written-yet.jsonl",
    modified: "2026-01-01T00:00:02.000Z",
    firstMessage: "runtime",
    transient: true,
  };
  const runtimeOnly = {
    ...runtime,
    id: "runtime-only",
    modified: "2026-01-01T00:00:03.000Z",
  };

  const merged = mergeSessionLists([persisted], [runtime, runtimeOnly]);

  assert.deepEqual(merged.map((session) => session.id), ["runtime-only", "same-id"]);
  assert.equal(merged[1], persisted);
  assert.equal(merged[1].transient, undefined);
});

test("the runtime boundary survives the merge, and no disk row can invent one", () => {
  // `boundary` ist die einzige Angabe, die die Platte nicht kennen kann: sie
  // beschreibt den **laufenden** Prozess (`getRpcSessionInfos`). Vorher fiel sie
  // hier heraus — `/api/sessions` lieferte fuer eine Worker-Session kein
  // `boundary`, obwohl der Server sie gerade gemessen hatte, und die
  // Abnahmezeile 2f haette nichts zu lesen gehabt.
  const base = {
    path: "/tmp/session.jsonl",
    id: "worker-session",
    cwd: "/home/hannah",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:01.000Z",
    messageCount: 2,
    firstMessage: "hi",
  };
  const persisted = { ...base };
  const boundary = { kind: "tenant-worker", enforced: true, pid: 4711 };
  const runtime = { ...base, modified: "2026-01-01T00:00:05.000Z", transient: true, boundary };

  const merged = mergeSessionLists([persisted], [runtime]);
  const row = merged.find((session) => session.id === base.id);
  // Die Platte gewinnt fuer jede dateigestuetzte Angabe — hier steht noch der
  // aeltere `modified`-Wert der Datei, nicht der der Laufzeit …
  assert.equal(row.modified, persisted.modified);
  assert.equal(row.transient, undefined);
  // … und die Laufzeitangabe wird nur additiv uebernommen, nicht ersetzt.
  assert.deepEqual(row.boundary, boundary);

  // Gegenprobe: eine Zeile ohne `boundary` in der Laufzeit bekommt auch keine,
  // und dann bleibt es bei derselben Objektidentitaet wie zuvor.
  const withoutRuntimeBoundary = mergeSessionLists([persisted], [{ ...base, transient: true }]);
  assert.equal(withoutRuntimeBoundary[0], persisted);
  assert.equal(withoutRuntimeBoundary[0].boundary, undefined);
});

// ============================================================================
// Mandanten-Archiv (lib/tenant-sessions.ts)
// ============================================================================

/**
 * Das eigene Archiv eines Kontos ist eine **zweite Quelle** neben dem
 * Prozess-Archiv, und sie kommt nach dem geteilten Cache. Zwei Zusagen muessen
 * hier gelten, und beide sind Verhalten, keine Form:
 *
 *  1. Eine Session im Mandanten-Archiv erscheint in der Liste dieses Kontos —
 *     sonst waere sie nach der Migration unsichtbar und der Pfad-Promise aus
 *     §9 des Plans gebrochen.
 *  2. Sie erscheint **nicht** bei einem anderen Konto, obwohl beide denselben
 *     geteilten Scan benutzen.
 */
test("eine Session im Mandanten-Archiv erscheint in der Liste dieses Kontos", async (t) => {
  const homeRoot = mkdtempSync(join(tmpdir(), "omp-web-tenant-list-"));
  const previousRoot = process.env.OMP_WEB_HOME_ROOT;
  process.env.OMP_WEB_HOME_ROOT = homeRoot;
  const home = join(homeRoot, "samuel");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const agentDir = join(home, ".omp", "agent");
  const manager = SessionManager.create(home, SessionManager.getDefaultSessionDir(home, agentDir));
  manager.appendMessage({ role: "user", content: "im eigenen Archiv" });
  await manager.ensureOnDisk();
  const sessionId = manager.getSessionId();
  resetSessionListState();
  t.after(() => {
    if (previousRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
    else process.env.OMP_WEB_HOME_ROOT = previousRoot;
    resetSessionListState();
    invalidateSessionPathCache(sessionId);
    rmSync(homeRoot, { recursive: true, force: true });
  });

  const identity = { username: "samuel", isAdmin: false };
  const listed = await listAllSessions({ force: true, identity });

  const found = listed.find((s) => s.id === sessionId);
  assert.ok(found, "the tenant's own archive has to be listed");
  assert.ok(found.path.startsWith(join(agentDir, "sessions")), found.path);
  assert.equal(await resolveSessionPath(sessionId), found.path, "the path cache is filled from the same scan");
});

test("das Archiv eines Kontos erscheint nicht bei einem anderen", async (t) => {
  const homeRoot = mkdtempSync(join(tmpdir(), "omp-web-tenant-list-b-"));
  const previousRoot = process.env.OMP_WEB_HOME_ROOT;
  process.env.OMP_WEB_HOME_ROOT = homeRoot;
  const samuelHome = join(homeRoot, "samuel");
  const hannahHome = join(homeRoot, "hannah");
  const { mkdirSync } = await import("node:fs");
  for (const home of [samuelHome, hannahHome]) mkdirSync(home, { recursive: true, mode: 0o700 });
  const manager = SessionManager.create(
    samuelHome,
    SessionManager.getDefaultSessionDir(samuelHome, join(samuelHome, ".omp", "agent")),
  );
  manager.appendMessage({ role: "user", content: "nur samuel" });
  await manager.ensureOnDisk();
  const sessionId = manager.getSessionId();
  resetSessionListState();
  t.after(() => {
    if (previousRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
    else process.env.OMP_WEB_HOME_ROOT = previousRoot;
    resetSessionListState();
    invalidateSessionPathCache(sessionId);
    rmSync(homeRoot, { recursive: true, force: true });
  });

  const hannah = await listAllSessions({ force: true, identity: { username: "hannah", isAdmin: false } });
  const samuel = await listAllSessions({ identity: { username: "samuel", isAdmin: false } });

  assert.equal(hannah.some((s) => s.id === sessionId), false, "hannah must not see samuel's archive");
  assert.equal(samuel.some((s) => s.id === sessionId), true, "samuel sees his own");
});

test("eine selbst geschriebene Kopfzeile mit fremdem cwd macht keine Wurzel", async (t) => {
  // Der Angriff, gemessen am 2026-11-08 an einem Scratch-Server: der Mandant
  // legt in seinem **eigenen** Archiv (0700, in seinem Home, also von seiner
  // Bash beschreibbar) eine Datei an, deren zweite Zeile die Session-Kopfzeile
  // ist — mit `cwd: "/"`. Der `cwd` wurde ungefiltert zur erlaubten
  // Datei-Wurzel, und `GET /api/files/etc/passwd?type=read` antwortete 200;
  // derselbe Weg oeffnete `omp-web-session-key` und damit Admin-Cookies.
  //
  // Geprueft wird hier die **Ursache**, nicht der HTTP-Effekt: eine Session aus
  // dem eigenen Archiv, deren `cwd` ausserhalb des eigenen Homs liegt, darf
  // weder in der Liste stehen noch in `getAllowedFileRoots` eine Wurzel
  // beitragen. Der zweite Teil ist die eigentliche Zusage — eine Zeile, die nur
  // die Liste prueft, waere gruen, waehrend die Wurzel weiter existiert.
  const homeRoot = mkdtempSync(join(tmpdir(), "omp-web-tenant-cwd-"));
  const previousRoot = process.env.OMP_WEB_HOME_ROOT;
  process.env.OMP_WEB_HOME_ROOT = homeRoot;
  const username = "forger";
  const home = join(homeRoot, username);
  const sessionsDir = join(home, ".omp", "agent", "sessions", "--forged--");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const forgedId = "01a1bbf1-0000-4000-8000-00000000dead";
  const forgedFile = join(sessionsDir, `2026-11-08T16-00-00-000Z_${forgedId}.jsonl`);
  writeFileSync(forgedFile, `${JSON.stringify({ type: "session", version: 3, id: forgedId, timestamp: "2026-11-08T16:00:00.000Z", cwd: "/" })}\n`, { mode: 0o600 });

  resetSessionListState();
  invalidateSessionListCache();
  t.after(() => {
    if (previousRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
    else process.env.OMP_WEB_HOME_ROOT = previousRoot;
    resetSessionListState();
    invalidateSessionPathCache(forgedId);
    rmSync(homeRoot, { recursive: true, force: true });
  });

  const identity = { username, isAdmin: false };
  const listed = await listAllSessions({ force: true, identity });
  assert.equal(
    listed.some((s) => s.id === forgedId),
    false,
    "a transcript whose header names a cwd outside the account's home is not that account's session",
  );

  const { getAllowedFileRoots, isExistingFilePathAllowed } = await jiti.import("./file-access.ts");
  const roots = await getAllowedFileRoots(identity);
  assert.equal(roots.has("/"), false, `the forged cwd must not become a root (roots: ${[...roots].join(", ")})`);
  for (const target of ["/etc/passwd", "/proc/self/environ"]) {
    assert.equal(isExistingFilePathAllowed(target, roots), false, `${target} must stay unreadable`);
  }
});

test("der cwd einer legitimen Mandanten-Session bleibt eine Wurzel", async (t) => {
  // Die Gegenprobe. Der Filter oben darf nicht einfach jede Session aus dem
  // eigenen Archiv verwerfen: eine Session, deren `cwd` im eigenen Home liegt,
  // ist die normale Lage und muss weiterhin gelistet werden und ihre Wurzel
  // beitragen. Ohne diesen Test waere ein Filter, der immer `false` sagt, gruen.
  const homeRoot = mkdtempSync(join(tmpdir(), "omp-web-tenant-cwd-ok-"));
  const previousRoot = process.env.OMP_WEB_HOME_ROOT;
  process.env.OMP_WEB_HOME_ROOT = homeRoot;
  const username = "keeper";
  const home = join(homeRoot, username);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const manager = SessionManager.create(
    home,
    SessionManager.getDefaultSessionDir(home, join(home, ".omp", "agent")),
  );
  manager.appendMessage({ role: "user", content: "eigene Sache" });
  await manager.ensureOnDisk();
  const sessionId = manager.getSessionId();

  resetSessionListState();
  invalidateSessionListCache();
  t.after(() => {
    if (previousRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
    else process.env.OMP_WEB_HOME_ROOT = previousRoot;
    resetSessionListState();
    invalidateSessionPathCache(sessionId);
    rmSync(homeRoot, { recursive: true, force: true });
  });

  const identity = { username, isAdmin: false };
  const listed = await listAllSessions({ force: true, identity });
  const found = listed.find((s) => s.id === sessionId);
  assert.ok(found, "a session inside the account's own home has to stay listed");
  assert.equal(found.cwd, home);

  const { getAllowedFileRoots } = await jiti.import("./file-access.ts");
  const roots = await getAllowedFileRoots(identity);
  assert.equal(roots.has(home), true, `the account's own home stays a root (roots: ${[...roots].join(", ")})`);
});

// omp schickt den Prompt eines abgebrochenen Turns als Steering-Nachricht
// erneut; die Sitzungsdatei enthaelt dann beide User-Zeilen. Der Verlauf darf
// den Operator-Text trotzdem nur einmal zeigen (Eintrag und ID zusammen weg,
// sonst verschieben sich Fork- und Sprungziele).
test("ein Steering-Echo desselben Prompts wird nicht als zweite Zeile geladen", () => {
  const entries = [
    userEntry("u1", null, "Bitte immer praesent"),
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted" },
    },
    {
      type: "message",
      id: "u2",
      parentId: "a1",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "user", content: "Bitte immer praesent", steering: true },
    },
    {
      type: "message",
      id: "u3",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: { role: "user", content: "und jetzt anders", steering: true },
    },
  ];

  const context = buildSessionContext(entries);

  assert.deepEqual(context.entryIds, ["u1", "a1", "u3"]);
  assert.deepEqual(context.messages.map((message) => message.role), ["user", "assistant", "user"]);
  assert.equal(context.messages[2].content, "und jetzt anders");
});
