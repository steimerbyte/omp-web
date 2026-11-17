import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./file-upload.ts");
}

test("validates upload names without accepting paths or duplicates", async () => {
  const { validateUploadFileNames } = await loadSubject();

  assert.equal(validateUploadFileNames(["one.txt", "two file.md"]), null);
  assert.match(validateUploadFileNames(["../secret.txt"]), /must not contain a path/);
  assert.match(validateUploadFileNames(["folder\\secret.txt"]), /must not contain a path/);
  assert.match(validateUploadFileNames(["same.txt", "same.txt"]), /Duplicate/);
  assert.match(validateUploadFileNames([]), /No files/);
});

test("finds conflicts and prevents replacing directories", async (t) => {
  const { inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-upload-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "file.txt"), "old");
  fs.mkdirSync(path.join(root, "directory"));

  assert.deepEqual(
    inspectUploadTargets(root, ["new.txt", "file.txt", "directory"]),
    {
      conflicts: ["file.txt", "directory"],
      nonReplaceable: ["directory"],
    },
  );
});

test("prevents replacing symbolic links", async (t) => {
  const { inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-upload-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "file.txt"), "old");
  try {
    fs.symlinkSync("file.txt", path.join(root, "link.txt"));
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  assert.deepEqual(
    inspectUploadTargets(root, ["link.txt"]),
    {
      conflicts: ["link.txt"],
      nonReplaceable: ["link.txt"],
    },
  );
});

test("parses only supported conflict strategies", async () => {
  const { parseUploadConflictStrategy } = await loadSubject();

  assert.equal(parseUploadConflictStrategy(null), "error");
  assert.equal(parseUploadConflictStrategy("overwrite"), "overwrite");
  assert.equal(parseUploadConflictStrategy("skip"), "skip");
  assert.equal(parseUploadConflictStrategy("rename"), null);
});

function matcherMatches(entry, pathname) {
  if (entry === pathname) return true;
  const star = entry.match(/^(.*?)\/:[^/]+\*$/);
  return Boolean(star && (pathname === star[1] || pathname.startsWith(`${star[1]}/`)));
}

function readProxyMatcher() {
  const source = fs.readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
  const declared = source.match(/matcher:\s*\[([^\]]*)\]/);
  assert.ok(declared, "proxy.ts must declare a matcher");
  return [...declared[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

test("the upload limit is 10 GiB and its streaming path is outside the proxy matcher", async () => {
  const { MAX_UPLOAD_FILE_BYTES, MAX_UPLOAD_LABEL } = await loadSubject();
  assert.equal(MAX_UPLOAD_FILE_BYTES, 10 * 1024 ** 3);
  assert.equal(MAX_UPLOAD_LABEL, "10 GB");

  // Next clones the body of every request `proxy.ts` matches into memory and
  // ends that clone at `proxyClientMaxBodySize`; a 10 GiB body through it would
  // be a 10 GiB buffer, so the bytes go to a path the matcher does not cover.
  const matchers = readProxyMatcher();
  assert.deepEqual(
    matchers.filter((entry) => matcherMatches(entry, "/upload/abc")),
    [],
    "PUT /upload/<token> must not be covered by the proxy matcher",
  );
  assert.ok(
    matchers.some((entry) => matcherMatches(entry, "/api/files/home/a")),
    "sanity: the file API itself is still proxied",
  );

  // Every body that still goes through the proxy must fit below its ceiling.
  const { MAX_AGENT_REQUEST_BODY_BYTES } = await import("./request-body.ts");
  const { readConfiguredProxyBodyLimit } = await import("../test/proxy-body-limit.mjs");
  assert.ok(
    MAX_AGENT_REQUEST_BODY_BYTES < readConfiguredProxyBodyLimit(),
    `the ${MAX_AGENT_REQUEST_BODY_BYTES} byte agent limit must sit below the proxy ceiling`,
  );
});

test("commits a streamed temp file under a fresh name, over an existing one, and refuses a taken name", async (t) => {
  const { commitUploadedTempFile, uploadTempPath } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-upload-commit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // A fresh name is linked into place; the temp name is gone afterwards.
  const freshTemp = uploadTempPath(root, "fresh.txt");
  assert.match(path.basename(freshTemp), /^\.fresh\.txt\.[0-9a-f-]+\.upload$/);
  fs.writeFileSync(freshTemp, "new content");
  commitUploadedTempFile(freshTemp, path.join(root, "fresh.txt"), false);
  assert.equal(fs.readFileSync(path.join(root, "fresh.txt"), "utf8"), "new content");
  assert.equal(fs.existsSync(freshTemp), false);

  // A replacement keeps the target's mode — overwriting a script must not strip +x.
  const script = path.join(root, "script.sh");
  fs.writeFileSync(script, "old script");
  fs.chmodSync(script, 0o755);
  const replaceTemp = uploadTempPath(root, "script.sh");
  fs.writeFileSync(replaceTemp, "new script");
  commitUploadedTempFile(replaceTemp, script, true);
  assert.equal(fs.readFileSync(script, "utf8"), "new script");
  assert.equal(fs.statSync(script).mode & 0o777, 0o755);
  assert.equal(fs.existsSync(replaceTemp), false);

  // The name was taken between inspection and commit: EEXIST, target untouched,
  // temp file removed. This is the guarantee `link` gives over `rename`.
  const takenTemp = uploadTempPath(root, "taken.txt");
  fs.writeFileSync(takenTemp, "upload");
  fs.writeFileSync(path.join(root, "taken.txt"), "existing");
  assert.throws(() => commitUploadedTempFile(takenTemp, path.join(root, "taken.txt"), false), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(root, "taken.txt"), "utf8"), "existing");
  assert.equal(fs.existsSync(takenTemp), false);
});
