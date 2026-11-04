// scripts/fetch-bun.mjs fuehrt beim Import sofort aus. Der Test importiert die
// echte Datei (keine Kopie, damit die Coverage auf scripts/fetch-bun.mjs
// landet) und laesst nur den Download scheitern — damit laufen bunVersion und
// fetchTriple, ohne dass etwas nach src-tauri/resources geschrieben wird.
import assert from "node:assert/strict";
import test from "node:test";

// Pfad, keine file://-URL: Bun cachet fehlgeschlagene file-URL-Module ohne
// Query, waehrend ein Pfad mit Query neu ausgewertet wird. Die Coverage
// landet trotzdem auf scripts/fetch-bun.mjs.
const SCRIPT = new URL("./fetch-bun.mjs", import.meta.url).pathname;

async function runScript({ args = [], env = {}, fetchOk = false }) {
  const logs = [];
  const original = {
    log: console.log,
    error: console.error,
    exit: process.exit,
    argv: process.argv,
    fetch: globalThis.fetch,
    version: process.env.BUN_VERSION,
  };
  console.log = (...parts) => logs.push(["log", parts.map(String).join(" ")]);
  console.error = (...parts) => logs.push(["error", parts.map(String).join(" ")]);
  process.argv = ["bun", SCRIPT, ...args];
  if ("BUN_VERSION" in env) process.env.BUN_VERSION = env.BUN_VERSION;
  else delete process.env.BUN_VERSION;
  process.exit = (code) => { throw new Error(`EXIT:${code}`); };
  globalThis.fetch = async (url) => {
    logs.push(["fetch", String(url)]);
    if (fetchOk) return { ok: true, status: 200, statusText: "OK", arrayBuffer: async () => new ArrayBuffer(4) };
    return { ok: false, status: 500, statusText: "Server Error" };
  };
  let exitCode = null;
  let error = null;
  try {
    await import(`${SCRIPT}?case=${Math.random()}`);
  } catch (thrown) {
    if (String(thrown.message).startsWith("EXIT:")) exitCode = Number(thrown.message.slice(5));
    else error = thrown;
  } finally {
    console.log = original.log;
    console.error = original.error;
    process.exit = original.exit;
    process.argv = original.argv;
    globalThis.fetch = original.fetch;
    if (original.version === undefined) delete process.env.BUN_VERSION;
    else process.env.BUN_VERSION = original.version;
  }
  assert.equal(error, null);
  return { logs, exitCode };
}

test("unbekanntes Triple bricht mit Usage-Fehler ab, bevor etwas geladen wird", async () => {
  const { logs, exitCode } = await runScript({ args: ["solaris"] });
  assert.equal(exitCode, 1);
  assert.match(logs.find(([level]) => level === "error")[1], /unknown triple "solaris"/);
  assert.equal(logs.some(([level]) => level === "fetch"), false);
});

test("die Standard-Triples werden gepinnt und jeder Downloadfehler gemeldet", async () => {
  const { logs, exitCode } = await runScript({});
  assert.equal(exitCode, 1);
  assert.match(logs[0][1], /pinning bun v/);
  const urls = logs.filter(([level]) => level === "fetch").map(([, url]) => url);
  assert.equal(urls.length, 3);
  for (const triple of ["darwin-aarch64", "darwin-x64", "windows-x64"]) {
    assert.ok(urls.some((url) => url.includes(`bun-${triple}.zip`)), `URL fuer ${triple}`);
  }
  const errors = logs.filter(([level]) => level === "error").map(([, line]) => line);
  assert.equal(errors.filter((line) => line.includes("download failed: HTTP 500 Server Error")).length, 3);
});

test("BUN_VERSION und --force werden respektiert", async () => {
  const { logs, exitCode } = await runScript({
    args: ["--force", "darwin-aarch64"],
    env: { BUN_VERSION: "9.9.9" },
  });
  assert.equal(exitCode, 1);
  assert.ok(logs.some(([, line]) => line.includes("pinning bun v9.9.9")));
  const url = logs.find(([level]) => level === "fetch")[1];
  assert.match(url, /bun-v9\.9\.9\/bun-darwin-aarch64\.zip$/);
});
