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

test("the proxy body ceiling sits above every limit the upload route enforces", async () => {
  const {
    MAX_UPLOAD_FILE_BYTES,
    MAX_UPLOAD_REQUEST_BYTES,
    MAX_UPLOAD_TOTAL_BYTES,
  } = await loadSubject();
  const { readConfiguredProxyBodyLimit } = await import("../test/proxy-body-limit.mjs");

  const configured = readConfiguredProxyBodyLimit();

  // Next clones the request body for `proxy.ts` and ends that copy silently
  // once the ceiling is passed — it does not refuse. Measured on this build
  // with the old 32 MB ceiling: a raw 40 MB POST arrived as 33 391 238 of
  // 41 943 040 bytes, and a 40 MB multipart upload answered HTTP 500
  // `FormData parse error missing final boundary`. A limit at or above the
  // ceiling is therefore unreachable, and its documented 413 never fires.
  assert.ok(
    MAX_UPLOAD_REQUEST_BYTES < configured,
    `the ${MAX_UPLOAD_REQUEST_BYTES} byte request limit cannot be enforced: the proxy ceiling is ${configured}`,
  );

  // The weaker two are only reachable if the strongest one is, so this also
  // keeps them honest: a per-file or per-total limit above the request limit
  // could never be what answers.
  assert.ok(MAX_UPLOAD_TOTAL_BYTES <= MAX_UPLOAD_REQUEST_BYTES);
  assert.ok(MAX_UPLOAD_FILE_BYTES <= MAX_UPLOAD_TOTAL_BYTES);
});
