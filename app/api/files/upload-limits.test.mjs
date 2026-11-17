import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Was `POST /api/files/**?type=upload-ticket` mit einer zu grossen Datei, einem
 * Konflikt und einem unbrauchbaren Ticket-Body macht.
 *
 * Die Bytes selbst gehen danach an `PUT /upload/<token>` (eigene Testdatei);
 * hier wird nur die Autorisierung geprueft: die Grenze ist 10 GiB, ein Ticket
 * wird fuer mehr gar nicht ausgestellt, und was mit einem vorhandenen Ziel
 * passiert, entscheidet die Conflict-Strategie — nicht der Client.
 */

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-upload-limit-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;
process.env.PI_CODING_AGENT_DIR = join(HOME_ROOT, ".agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

const jiti = createJiti(import.meta.url, {
  root: process.cwd(),
  alias: { "@": process.cwd() },
  interopDefault: true,
});

const route = await jiti.import("./[...path]/route.ts");
const { NextRequest } = await jiti.import("next/server");
const { MAX_UPLOAD_FILE_BYTES, MAX_UPLOAD_LABEL } = await jiti.import("@/lib/file-upload.ts");
const { takeUploadTicket } = await jiti.import("@/lib/upload-tickets.ts");

const TENANT = "upload-limits-tenant";
const UPLOAD_DIR = join(HOME_ROOT, TENANT, "uploads");
mkdirSync(UPLOAD_DIR, { recursive: true });

test.after(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

function ticketRequest(body, { declared, conflict = "error", identity = TENANT } = {}) {
  const segments = UPLOAD_DIR.split("/").filter(Boolean);
  const headers = { host: "localhost", "content-type": "application/json" };
  if (identity) headers["x-omp-user"] = identity;
  if (declared !== undefined) headers["content-length"] = String(declared);
  return new NextRequest(
    `http://localhost/api/files${UPLOAD_DIR}?type=upload-ticket&conflict=${conflict}`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
}

function callTicket(body, options) {
  const segments = UPLOAD_DIR.split("/").filter(Boolean);
  return route.POST(ticketRequest(body, options), { params: Promise.resolve({ path: segments }) });
}

test("the limit is 10 GiB and a bigger ticket is refused before any byte moves", async () => {
  assert.equal(MAX_UPLOAD_FILE_BYTES, 10 * 1024 ** 3);
  assert.equal(MAX_UPLOAD_LABEL, "10 GB");

  const response = await callTicket({ name: "huge.bin", size: MAX_UPLOAD_FILE_BYTES + 1 });
  assert.equal(response.status, 413);
  const payload = await response.json();
  assert.equal(payload.error, `Files must be ${MAX_UPLOAD_LABEL} or smaller`);
  assert.deepEqual(readdirSync(UPLOAD_DIR), [], "a refused ticket must leave nothing behind");
});

test("a valid ticket names the file and size, and is single use", async () => {
  const response = await callTicket({ name: "report.csv", size: 1024 });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(typeof payload.token, "string");

  const ticket = takeUploadTicket(payload.token);
  assert.deepEqual(ticket, {
    directory: UPLOAD_DIR,
    fileName: "report.csv",
    size: 1024,
    replacing: false,
    expiresAt: ticket.expiresAt,
  });
  assert.equal(takeUploadTicket(payload.token), null, "the ticket is consumed once");
});

test("a conflict under `error` is a 409, under `skip` a skip, under `overwrite` a replacing ticket", async () => {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(UPLOAD_DIR, "taken.csv"), "existing");

  const conflict = await callTicket({ name: "taken.csv", size: 4 }, { conflict: "error" });
  assert.equal(conflict.status, 409);
  assert.deepEqual((await conflict.json()).conflicts, ["taken.csv"]);

  const skipped = await callTicket({ name: "taken.csv", size: 4 }, { conflict: "skip" });
  assert.equal(skipped.status, 200);
  assert.deepEqual(await skipped.json(), { uploaded: [], skipped: ["taken.csv"], errors: [] });

  const overwrite = await callTicket({ name: "taken.csv", size: 4 }, { conflict: "overwrite" });
  assert.equal(overwrite.status, 200);
  const token = (await overwrite.json()).token;
  assert.equal(takeUploadTicket(token).replacing, true);
});

test("a directory target is an error entry, never a replacement", async () => {
  mkdirSync(join(UPLOAD_DIR, "folder"), { recursive: true });
  const response = await callTicket({ name: "folder", size: 4 }, { conflict: "overwrite" });
  assert.equal(response.status, 207);
  assert.deepEqual((await response.json()).errors, [
    { name: "folder", error: "Cannot replace a directory or symbolic link" },
  ]);
});

test("an oversized ticket request body is a 413, not a crash", async () => {
  // Declared, not delivered: the early Content-Length check answers without
  // buffering a body. 16 KiB is the ticket ceiling.
  const response = await callTicket({ name: "a.txt", size: 1 }, { declared: 64 * 1024 });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /ticket request is too large/);
});

test("names with a path and non-integer sizes are rejected", async () => {
  for (const body of [
    { name: "../escape.txt", size: 1 },
    { name: "ok.txt", size: 1.5 },
    { name: "ok.txt", size: -1 },
    { name: "ok.txt" },
    { size: 1 },
  ]) {
    const response = await callTicket(body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
});

test("without an identity the ticket endpoint is a 403", async () => {
  const response = await callTicket({ name: "a.txt", size: 1 }, { identity: null });
  assert.equal(response.status, 403);
});
