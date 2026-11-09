import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { getRpcSessionInfos } = await jiti.import("./rpc-manager.ts");

function makeRuntimeSession({ id, filePath, running, entries }) {
  const timestamp = "2026-08-12T01:02:03.000Z";
  const manager = {
    getHeader: () => ({ type: "session", id, cwd: "/tmp/runtime-cwd", timestamp }),
    getEntries: () => entries,
    getSessionFile: () => filePath,
    getSessionName: () => undefined,
  };
  return {
    isAlive: () => true,
    isRunning: () => running,
    inner: { sessionManager: manager },
    get sessionId() { return id; },
    get sessionFile() { return filePath; },
    get cwd() { return "/tmp/runtime-cwd"; },
  };
}

test("lists an accepted new prompt before its session file exists", (t) => {
  const previousRegistry = globalThis.__ompSessions;
  const timestamp = "2026-08-12T01:02:04.000Z";
  const visible = makeRuntimeSession({
    id: "visible-runtime",
    filePath: join(tmpdir(), "pi-web-missing-runtime-session.jsonl"),
    running: true,
    entries: [{
      type: "message",
      id: "u1",
      parentId: null,
      timestamp,
      message: {
        role: "user",
        content: [{ type: "text", text: "first" }, { type: "text", text: "prompt" }],
      },
    }],
  });
  const emptyEnsureSession = makeRuntimeSession({
    id: "empty-runtime",
    filePath: join(tmpdir(), "pi-web-missing-empty-session.jsonl"),
    running: false,
    entries: [],
  });
  globalThis.__ompSessions = new Map([
    ["visible-runtime", visible],
    ["empty-runtime", emptyEnsureSession],
  ]);
  t.after(() => {
    globalThis.__ompSessions = previousRegistry;
  });

  const infos = getRpcSessionInfos();

  assert.equal(infos.length, 1);
  assert.equal(infos[0].id, "visible-runtime");
  assert.equal(infos[0].firstMessage, "first prompt");
  assert.equal(infos[0].messageCount, 1);
  assert.equal(infos[0].transient, true);
});

test("keeps an idle runtime visible once its JSONL file exists", (t) => {
  const previousRegistry = globalThis.__ompSessions;
  const dir = mkdtempSync(join(tmpdir(), "pi-web-runtime-session-"));
  const filePath = join(dir, "session.jsonl");
  writeFileSync(filePath, "persisted\n");
  globalThis.__ompSessions = new Map([["persisted-runtime", makeRuntimeSession({
    id: "persisted-runtime",
    filePath,
    running: false,
    entries: [],
  })]]);
  t.after(() => {
    globalThis.__ompSessions = previousRegistry;
    rmSync(dir, { recursive: true, force: true });
  });

  const infos = getRpcSessionInfos();

  assert.equal(infos.length, 1);
  assert.equal(infos[0].transient, false);
});

/**
 * Die Sichtbarkeit der Grenze (Plan §8 Punkt 4, Anforderung 6 aus Phase 3).
 *
 * Zwei Aussagen, die auseinandergehalten werden muessen: **wo** eine Session
 * laeuft (`kind`) und **ob** die Grenze steht (`enforced`). Die zweite darf nur
 * mit einer gemeldeten PID `true` sein — ein Worker, der ohne Prozess-PID
 * meldet, ist keine Isolation, die der Server anzeigen duerfte.
 */
test("a worker-hosted session reports its boundary with the live pid", (t) => {
  const previousRegistry = globalThis.__ompSessions;
  const dir = mkdtempSync(join(tmpdir(), "pi-web-boundary-"));
  const filePath = join(dir, "session.jsonl");
  writeFileSync(filePath, "persisted\n");
  const session = makeRuntimeSession({
    id: "worker-runtime",
    filePath,
    running: false,
    entries: [],
  });
  session.inner.boundary = { kind: "tenant-worker", enforced: true, pid: 4711 };
  globalThis.__ompSessions = new Map([["worker-runtime", session]]);
  t.after(() => {
    globalThis.__ompSessions = previousRegistry;
    rmSync(dir, { recursive: true, force: true });
  });

  const [info] = getRpcSessionInfos();

  assert.deepEqual(info.boundary, { kind: "tenant-worker", enforced: true, pid: 4711 });
});

test("a worker without a reported pid never claims enforced: true", (t) => {
  const previousRegistry = globalThis.__ompSessions;
  const dir = mkdtempSync(join(tmpdir(), "pi-web-boundary-nopid-"));
  const filePath = join(dir, "session.jsonl");
  writeFileSync(filePath, "persisted\n");
  const session = makeRuntimeSession({
    id: "worker-no-pid",
    filePath,
    running: false,
    entries: [],
  });
  // Genau der Fall, den `startTenantWorker` bauen wuerde, wenn der Spawn keine
  // PID meldet: `enforced: true` ohne Prozess ist keine Messung, sondern eine
  // Behauptung. Deshalb bleibt `pid` hier weg und `enforced` muss fallen.
  session.inner.boundary = { kind: "tenant-worker", enforced: true };
  globalThis.__ompSessions = new Map([["worker-no-pid", session]]);
  t.after(() => {
    globalThis.__ompSessions = previousRegistry;
    rmSync(dir, { recursive: true, force: true });
  });

  const [info] = getRpcSessionInfos();

  assert.equal(info.boundary.kind, "tenant-worker");
  assert.equal(info.boundary.enforced, false, "ohne PID keine Behauptung");
  assert.equal(info.boundary.pid, undefined);
});

test("an in-process session says so and claims no enforcement", (t) => {
  const previousRegistry = globalThis.__ompSessions;
  const dir = mkdtempSync(join(tmpdir(), "pi-web-boundary-inproc-"));
  const filePath = join(dir, "session.jsonl");
  writeFileSync(filePath, "persisted\n");
  // Kein `boundary` am inneren Objekt: das ist der Admin-Pfad und der
  // Betriebsausstieg. Die Liste muss trotzdem eine Aussage machen, damit der
  // Client "laeuft im Serverprozess" von "weiss ich nicht" unterscheiden kann.
  globalThis.__ompSessions = new Map([["inproc-runtime", makeRuntimeSession({
    id: "inproc-runtime",
    filePath,
    running: false,
    entries: [],
  })]]);
  t.after(() => {
    globalThis.__ompSessions = previousRegistry;
    rmSync(dir, { recursive: true, force: true });
  });

  const [info] = getRpcSessionInfos();

  assert.deepEqual(info.boundary, { kind: "in-process", enforced: false });
});
