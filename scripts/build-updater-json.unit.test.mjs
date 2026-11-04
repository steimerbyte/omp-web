// scripts/build-updater-json.mjs: die externen Befehle (gh, curl, bun) werden
// durch Skripte im PATH ersetzt; der Lauf selbst ist ein --dry-run, damit
// latest.json nicht im Repo landet.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Pfad, keine file://-URL: nur so wertet Bun ein fehlgeschlagenes Modul mit
// neuer Query erneut aus (siehe scripts/fetch-bun.unit.test.mjs).
const SCRIPT = new URL("./build-updater-json.mjs", import.meta.url).pathname;

const ASSETS = [
  { name: "Omp_1.2.3_universal.app.tar.gz", browser_download_url: "https://example.test/app.tar.gz" },
  { name: "Omp_1.2.3_x64-setup.exe", browser_download_url: "https://example.test/setup.exe" },
  { name: "Omp_1.2.3_x64-setup.exe.sig", browser_download_url: "https://example.test/setup.exe.sig" },
  { name: "notes.txt", browser_download_url: "https://example.test/notes.txt" },
];
const SIGNATURE = "A".repeat(64);

function makeFakeBin({ releaseJson, ghExit = 0, bunOutput = SIGNATURE }) {
  const root = mkdtempSync(join(tmpdir(), "omp-updater-bin-"));
  const jsonPath = join(root, "release.json");
  writeFileSync(jsonPath, JSON.stringify(releaseJson));
  const write = (name, body) => {
    const path = join(root, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  };
  write("gh", `#!/bin/sh
if [ "${ghExit}" != "0" ]; then exit ${ghExit}; fi
if [ "$1" = "release" ] && [ "$2" = "view" ]; then cat ${JSON.stringify(jsonPath)}; exit 0; fi
exit 0
`);
  write("curl", `#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; shift 2; else shift; fi
done
if [ -n "$out" ]; then printf 'artifact' > "$out"; fi
exit 0
`);
  write("bun", `#!/bin/sh
printf '%s\\n' ${JSON.stringify(bunOutput)}
exit 0
`);
  return root;
}

async function runScript({ args, releaseJson = { name: "Release 1.2.3", published_at: "2026-01-01T00:00:00Z", assets: ASSETS }, ghExit = 0, bunOutput = SIGNATURE }) {
  const bin = makeFakeBin({ releaseJson, ghExit, bunOutput });
  const logs = [];
  const original = {
    log: console.log,
    error: console.error,
    exit: process.exit,
    argv: process.argv,
    PATH: process.env.PATH,
    cwd: process.cwd(),
  };
  console.log = (...parts) => logs.push(["log", parts.map(String).join(" ")]);
  console.error = (...parts) => logs.push(["error", parts.map(String).join(" ")]);
  process.argv = ["bun", SCRIPT, ...args];
  process.env.PATH = `${bin}:${original.PATH}`;
  process.chdir(bin);
  process.exit = (code) => { throw new Error(`EXIT:${code}`); };
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
    process.env.PATH = original.PATH;
    process.chdir(original.cwd);
    rmSync(bin, { recursive: true, force: true });
  }
  assert.equal(error, null);
  return { logs, exitCode };
}

test("dry-run sammelt die Plattformen und signiert jedes Artefakt", async () => {
  const { logs, exitCode } = await runScript({ args: ["v1.2.3", "--dry-run"] });
  assert.equal(exitCode, 0);
  const printed = logs.find(([level, line]) => level === "log" && line.startsWith("{"));
  const latest = JSON.parse(printed[1]);
  assert.equal(latest.version, "1.2.3");
  assert.equal(latest.notes, "Release 1.2.3");
  assert.equal(latest.pub_date, "2026-01-01T00:00:00Z");
  assert.deepEqual(Object.keys(latest.platforms).sort(), ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"]);
  assert.equal(latest.platforms["darwin-aarch64"].signature, SIGNATURE);
  assert.equal(latest.platforms["darwin-aarch64"].url, "https://example.test/app.tar.gz");
  assert.equal(latest.platforms["windows-x86_64"].url, "https://example.test/setup.exe");
  // Die .sig-Datei wird nie als eigener Kandidat behandelt.
  assert.equal(Object.values(latest.platforms).some((entry) => entry.url.endsWith(".sig")), false);
});

test("ohne Tag nennt das Skript die Usage und endet mit 2", async () => {
  const { logs, exitCode } = await runScript({ args: [] });
  assert.equal(exitCode, 2);
  assert.match(logs[0][1], /usage: bun scripts\/build-updater-json\.mjs/);
});

test("ohne Updater-Artefakte endet es mit 1", async () => {
  const { logs, exitCode } = await runScript({
    args: ["v1.2.3", "--dry-run"],
    releaseJson: { name: "R", published_at: "x", assets: [{ name: "notes.txt", browser_download_url: "https://example.test/n" }] },
  });
  assert.equal(exitCode, 1);
  assert.match(logs.find(([level]) => level === "error")[1], /no updater artifacts/);
});

test("ein fehlgeschlagener externer Befehl bricht ab", async () => {
  const { logs, exitCode } = await runScript({ args: ["v1.2.3", "--dry-run"], ghExit: 1 });
  assert.equal(exitCode, 1);
  assert.match(logs.find(([level]) => level === "error")[1], /command failed: gh release view/);
});

test("eine unlesbare Signatur bricht ab", async () => {
  const { logs, exitCode } = await runScript({ args: ["v1.2.3", "--dry-run"], bunOutput: "keine signatur" });
  assert.equal(exitCode, 1);
  assert.match(logs.find(([level]) => level === "error")[1], /could not parse signature/);
});
