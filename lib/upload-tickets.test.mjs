import assert from "node:assert/strict";
import test from "node:test";
import { mintUploadTicket, takeUploadTicket } from "./upload-tickets.ts";

const TICKET = { directory: "/tmp/uploads", fileName: "report.csv", size: 1024, replacing: false };

test("a ticket comes back once with the values it was minted for", () => {
  const token = mintUploadTicket(TICKET, 1_000);
  const taken = takeUploadTicket(token, 2_000);
  assert.deepEqual(taken, { ...TICKET, expiresAt: 1_000 + 10 * 60 * 1000 });
});

test("a taken ticket cannot be taken again", () => {
  const token = mintUploadTicket(TICKET, 1_000);
  assert.ok(takeUploadTicket(token, 2_000));
  assert.equal(takeUploadTicket(token, 2_001), null);
});

test("an expired ticket is refused and swept from the store", () => {
  const token = mintUploadTicket(TICKET, 1_000);
  assert.equal(takeUploadTicket(token, 1_000 + 10 * 60 * 1000), null, "expiry is exclusive");
  // Minting sweeps what has expired; nothing about a dead token is recoverable.
  const fresh = mintUploadTicket(TICKET, 1_000 + 10 * 60 * 1000 + 1);
  assert.equal(takeUploadTicket(token, 1_000 + 10 * 60 * 1000 + 2), null);
  assert.ok(takeUploadTicket(fresh, 1_000 + 10 * 60 * 1000 + 2));
});

test("tokens are unguessable, not derived from the target", () => {
  const first = mintUploadTicket(TICKET, 1_000);
  const second = mintUploadTicket(TICKET, 1_000);
  assert.notEqual(first, second);
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal(first.includes("report"), false);
});
