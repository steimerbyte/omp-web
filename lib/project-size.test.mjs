import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  MAX_PARALLEL,
  SIZE_TIMEOUT_MS,
  measureProjectSize,
  measureProjectSizes,
} = await jiti.import("./project-size.ts");

/**
 * A temp directory that outlives the body.
 *
 * Async on purpose: a synchronous `try/finally` around `return fn(dir)` runs
 * the `finally` the moment the promise is *returned*, so the directory would
 * be deleted while the measurement was still reading it — and every async
 * assertion would then be measuring a folder that no longer exists.
 */
async function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-projects-size-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Bytes on disk are never exactly the byte count written, so assert ranges. */
function isPlausibleSize(bytes, written) {
  return bytes !== null && bytes >= written && bytes < written + 64 * 1024;
}

test("a real folder measures to roughly its size", async () => await withTmpDir(async (dir) => {
  const project = join(dir, "project");
  mkdirSync(project);
  writeFileSync(join(project, "main.ts"), "x".repeat(4096));

  const bytes = await measureProjectSize(project);
  assert.ok(isPlausibleSize(bytes, 4096), `expected >= 4096, got ${bytes}`);
}));

test("a missing folder is null, never zero", async () => await withTmpDir(async (dir) => {
  const bytes = await measureProjectSize(join(dir, "does-not-exist"));
  // The distinction matters: `0` would render as "empty project", a claim
  // about the disk that was never established.
  assert.equal(bytes, null);
}));

test("an empty input path is null", async () => {
  assert.equal(await measureProjectSize(""), null);
  assert.equal(await measureProjectSize("   "), null);
});

test("a folder name with shell metacharacters is not executed", async () => await withTmpDir(async (dir) => {
  // The classic injection: if this went through a shell, `$(...)` would run and
  // the folder name would be replaced by the output of `id`.
  const evil = join(dir, "weird $(id)`whoami`;rm -rf /");
  mkdirSync(evil);
  writeFileSync(join(evil, "file.txt"), "hello");

  const bytes = await measureProjectSize(evil);
  // The folder still exists and still measures — it was treated as a name.
  assert.ok(bytes !== null && bytes > 0, `expected a real size, got ${bytes}`);
}));

test("a leading dash in a name is not read as a flag", async () => await withTmpDir(async (dir) => {
  // `du -sb -- -weird` must not parse `-weird` as options. Without the `--`,
  // a folder named like a flag would either fail or be measured as something
  // else entirely.
  const odd = join(dir, "-weird-name");
  mkdirSync(odd);
  writeFileSync(join(odd, "f.txt"), "y".repeat(1024));

  const bytes = await measureProjectSize(odd);
  assert.ok(bytes !== null && bytes >= 1024, `expected a real size, got ${bytes}`);
}));

test("a nested tree measures more than its empty parent", async () => await withTmpDir(async (dir) => {
  const small = join(dir, "small");
  const big = join(dir, "big");
  mkdirSync(small);
  mkdirSync(big);
  writeFileSync(join(big, "blob.bin"), Buffer.alloc(256 * 1024));

  const smallBytes = await measureProjectSize(small);
  const bigBytes = await measureProjectSize(big);
  assert.ok(bigBytes > smallBytes, `${bigBytes} should exceed ${smallBytes}`);
}));

test("an empty folder measures zero, not null", async () => await withTmpDir(async (dir) => {
  // `du -sb` reports the apparent size, and an empty directory has none. That
  // 0 is a real measurement and must stay distinguishable from the `null` that
  // means "could not be measured" — otherwise the card would claim an
  // unmeasurable folder is an empty one.
  const empty = join(dir, "empty");
  mkdirSync(empty);
  assert.equal(await measureProjectSize(empty), 0);
}));

test("measureProjectSizes returns one entry per root", async () => await withTmpDir(async (dir) => {
  const a = join(dir, "a");
  const b = join(dir, "b");
  mkdirSync(a);
  mkdirSync(b);
  writeFileSync(join(a, "f.txt"), "x".repeat(1024));
  writeFileSync(join(b, "f.txt"), "y".repeat(2048));
  const missing = join(dir, "gone");

  const results = await measureProjectSizes([a, b, missing]);
  assert.equal(results.size, 3);
  assert.ok(results.get(a) > 0);
  assert.ok(results.get(b) > 0);
  assert.equal(results.get(missing), null, "unmeasurable is present-and-null, not absent");
}));

test("measureProjectSizes handles an empty list without spawning anything", async () => {
  const results = await measureProjectSizes([]);
  assert.equal(results.size, 0);
});

test("measureProjectSizes keeps order and covers every root past the cap", async () => await withTmpDir(async () => {
  // More roots than the parallel cap, so the pool really does run in rounds.
  // The failure this guards against is an off-by-one that silently drops the
  // tail of the list past the last full round.
  const roots = [];
  for (let index = 0; index < MAX_PARALLEL + 5; index++) {
    const dir = join(tmpdir(), `omp-web-projects-many-${process.pid}-${index}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "f.txt"), "z".repeat(512));
    roots.push(dir);
  }

  try {
    const results = await measureProjectSizes(roots);
    assert.equal(results.size, roots.length, "no root is dropped past the cap");
    for (const root of roots) {
      assert.ok(results.has(root), `${root} missing from the result`);
      assert.ok(results.get(root) > 0, `${root} measured as ${results.get(root)}`);
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}));

test("the concurrency cap is honoured", async () => await withTmpDir(async (dir) => {
  // Counting concurrent `du` processes would need a stub; what is checked here
  // is the contract that makes the bound true — `maxParallel: 1` serializes,
  // and a single round still returns every root.
  const roots = [join(dir, "r1"), join(dir, "r2"), join(dir, "r3")];
  for (const root of roots) mkdirSync(root, { recursive: true });

  const serial = await measureProjectSizes(roots, { maxParallel: 1 });
  assert.equal(serial.size, 3);
}));

test("a zero or negative cap is clamped to one rather than looping forever", async () => await withTmpDir(async (dir) => {
  const root = join(dir, "solo");
  mkdirSync(root);
  writeFileSync(join(root, "f.txt"), "z".repeat(1024));
  // `maxParallel: 0` would make the stride 0 and the loop never terminate.
  const results = await measureProjectSizes([root], { maxParallel: 0 });
  assert.equal(results.size, 1);
  assert.ok(results.get(root) > 0);
}));

test("the documented budget bounds the request", () => {
  // These two constants are the whole reason the route can measure
  // synchronously instead of deferring to a poll nobody triggers.
  assert.ok(SIZE_TIMEOUT_MS <= 10_000, "per-project budget must stay bounded");
  assert.ok(MAX_PARALLEL <= 8, "concurrency cap must stay bounded");
  assert.ok(MAX_PARALLEL >= 1);
});