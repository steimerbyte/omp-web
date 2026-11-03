import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./path-security.ts");
}

test("rejects an existing path that escapes an allowed root through a symlink", async (t) => {
  const { isExistingPathWithinRoots, isPathWithinRoots } = await loadSubject();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-file-access-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  const link = path.join(allowed, "link");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  const target = path.join(link, "secret.txt");
  const roots = new Set([allowed]);

  assert.equal(isPathWithinRoots(target, roots), true);
  assert.equal(isExistingPathWithinRoots(target, roots), false);
});

const ALICE = { username: "alice", isAdmin: false };

/**
 * Run `run` with `OMP_WEB_HOME_ROOT` pointing at a fresh temp dir.
 *
 * The roots cache is keyed by identity but not by environment, so it is
 * dropped on both sides — otherwise one case's home directory answers the next
 * case's `getAllowedFileRoots`.
 */
async function withHomeRoot(run) {
  const { clearAllowedRootsCache } = await import("./allowed-roots.ts");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-file-access-home-"));
  const pinned = process.env.OMP_WEB_HOME_ROOT;
  process.env.OMP_WEB_HOME_ROOT = base;
  clearAllowedRootsCache();
  try {
    return await run(base);
  } finally {
    // `process.env.X = undefined` stores the string "undefined", which would
    // outlive this file and move every later test's account home.
    if (pinned === undefined) delete process.env.OMP_WEB_HOME_ROOT;
    else process.env.OMP_WEB_HOME_ROOT = pinned;
    clearAllowedRootsCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test("a symlinked omp-cwd entry does not become an allowed file root", async () => {
  const { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } = await import("./file-access.ts");

  await withHomeRoot(async (base) => {
    const home = path.join(base, "alice");
    const outside = path.join(base, "outside");
    fs.mkdirSync(home);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "marker.txt"), "OUTSIDE-SECRET");

    // OMP-006: the entry is a symlink to a directory outside the home. Adding
    // it as a root is enough for every later check, because roots are resolved
    // too — the outside file then compares as "inside" the resolved root.
    const linkRoot = path.join(home, "omp-cwd-20261103");
    fs.symlinkSync(outside, linkRoot, process.platform === "win32" ? "junction" : "dir");
    // The legitimate case has to keep working: a real scratch directory.
    const realRoot = path.join(home, "omp-cwd-20261104");
    fs.mkdirSync(realRoot);
    fs.writeFileSync(path.join(realRoot, "ok.txt"), "ok");

    const roots = await getAllowedFileRoots(ALICE);

    assert.equal(roots.has(linkRoot), false, "a symlinked omp-cwd entry must not be granted");
    assert.equal(roots.has(realRoot), true, "a real omp-cwd directory must still be granted");

    const viaLink = path.join(linkRoot, "marker.txt");
    assert.equal(isFilePathAllowed(viaLink, roots), true, "precondition: the link sits lexically in the home");
    assert.equal(
      isExistingFilePathAllowed(viaLink, roots),
      false,
      "the outside file must not be readable through the symlinked root",
    );
    assert.equal(isExistingFilePathAllowed(path.join(realRoot, "ok.txt"), roots), true);
  });
});

test("openAuthorizedFile reads the checked object and refuses a swap after the check", async (t) => {
  const { openAuthorizedFile } = await import("./file-access.ts");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-file-access-open-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "dir"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, "dir", "file.txt"), "INSIDE");
  fs.writeFileSync(path.join(outside, "file.txt"), "OUTSIDE-SECRET");
  // Keep a second root copy so the swap can be undone between cases.
  const target = path.join(root, "dir", "file.txt");
  const roots = new Set([root]);

  // A symlink that stays inside the root keeps working: users rely on it.
  const link = path.join(root, "link.txt");
  fs.symlinkSync(target, link);
  const linked = openAuthorizedFile(link, roots);
  assert.equal(linked.ok, true, "a link that resolves inside the root must stay readable");
  if (linked.ok) {
    assert.equal(fs.readFileSync(linked.file.fd).toString(), "INSIDE");
    fs.closeSync(linked.file.fd);
  }

  // OMP-019: authorization resolved `root/dir/file.txt`, then the directory is
  // exchanged for a symlink to the outside. The open follows it; the descriptor
  // now holds the outside file, and the post-open resolution must refuse it.
  const swapped = openAuthorizedFile(target, roots, () => {
    fs.renameSync(path.join(root, "dir"), path.join(base, "dir-moved"));
    fs.symlinkSync(outside, path.join(root, "dir"), process.platform === "win32" ? "junction" : "dir");
  });
  assert.equal(swapped.ok, false, "a swap after authorization must not hand out the outside file");
  assert.equal(swapped.ok ? null : swapped.reason, "not-allowed");

  // The same at the final component: O_NOFOLLOW refuses a symlink that replaced
  // the resolved file.
  fs.rmSync(path.join(root, "dir"));
  fs.mkdirSync(path.join(root, "dir"));
  fs.writeFileSync(path.join(root, "dir", "file.txt"), "INSIDE-AGAIN");
  const fileSwap = openAuthorizedFile(target, roots, () => {
    fs.rmSync(path.join(root, "dir", "file.txt"));
    fs.symlinkSync(path.join(outside, "file.txt"), path.join(root, "dir", "file.txt"));
  });
  assert.equal(fileSwap.ok, false);
  assert.equal(fileSwap.ok ? null : fileSwap.reason, "not-allowed");
});

test("a FIFO inside an allowed root is refused without blocking the process", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-file-access-fifo-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const fifo = path.join(base, "pipe");
  try {
    execFileSync("mkfifo", [fifo]);
  } catch {
    t.skip("mkfifo is not available on this host");
    return;
  }

  // In a child process on purpose: without O_NONBLOCK `open(2)` on a FIFO
  // blocks synchronously on Bun's only thread, so an in-process timeout could
  // never fire. The child prints READY after the import and only then opens the
  // FIFO, so the 2 s budget covers the open itself and a slow module load on a
  // loaded host cannot be mistaken for a blocking open. SIGKILL because the
  // imported SDK installs a SIGTERM handler; a blocked child would survive the
  // default signal and hang the wait.
  const moduleUrl = new URL("./file-access.ts", import.meta.url).href;
  const script = `
    const { openAuthorizedFile } = await import(process.env.OMP_FIFO_MODULE);
    process.stdout.write("READY\\n");
    const result = openAuthorizedFile(process.env.OMP_FIFO_PATH, new Set([process.env.OMP_FIFO_ROOT]));
    process.stdout.write(JSON.stringify(result.ok ? { ok: true } : { ok: false, reason: result.reason }));
  `;
  const child = spawn(process.execPath, ["--eval", script], {
    env: {
      ...process.env,
      OMP_FIFO_MODULE: moduleUrl,
      OMP_FIFO_PATH: fifo,
      OMP_FIFO_ROOT: base,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });

  const outcome = await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let ready = false;
    let readyAt = 0;
    let settled = false;
    let openTimer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      clearTimeout(startupTimer);
      resolve({ ...value, stdout, stderr });
    };
    // A broken import must fail too; this is not the open budget.
    const startupTimer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ready, timedOut: false, startupTimedOut: true });
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (ready || !stdout.includes("READY\n")) return;
      ready = true;
      readyAt = Date.now();
      openTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ ready: true, timedOut: true, startupTimedOut: false, openMs: Date.now() - readyAt });
      }, 2000);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("exit", (code, signal) => {
      finish({ ready, timedOut: false, startupTimedOut: false, code, signal, openMs: ready ? Date.now() - readyAt : null });
    });
  });

  assert.equal(outcome.ready, true, `the child never loaded the module: ${outcome.stderr}`);
  assert.equal(outcome.startupTimedOut, false, `the child did not start: ${outcome.stderr}`);
  assert.equal(outcome.timedOut, false, "open(2) blocked for more than 2000 ms");
  assert.equal(outcome.signal, null, "the child had to be killed, so the open blocked");
  const payload = String(outcome.stdout).split("READY\n")[1] ?? "";
  assert.deepEqual(JSON.parse(payload), { ok: false, reason: "not-a-file" });
  t.diagnostic(`FIFO open returned ${outcome.openMs} ms after the module loaded`);
});
