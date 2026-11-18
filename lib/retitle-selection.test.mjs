import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { decideRetitle } = await jiti.import("./retitle-selection.ts");

const NOW = Date.UTC(2026, 10, 18, 8, 0, 0);
const OLD_MTIME = NOW - 2 * 60 * 60 * 1000; // zwei Stunden alt
const policy = (overrides = {}) => ({
  nowMs: NOW,
  recentMs: 30 * 60 * 1000,
  includeUser: false,
  onlyEmpty: false,
  ...overrides,
});
const candidate = (overrides = {}) => ({ depth: 2, title: "", source: "auto", mtimeMs: OLD_MTIME, ...overrides });

test("ein leerer Legacy-Record wird benannt", () => {
  assert.equal(decideRetitle(candidate({ title: "", source: undefined }), policy()), "title");
  assert.equal(decideRetitle(candidate({ title: "" }), policy({ onlyEmpty: true })), "title");
});

test("ein auto-Titel wird neu erzeugt, mit --only-empty nicht", () => {
  assert.equal(decideRetitle(candidate({ title: "Alter Titel" }), policy()), "title");
  assert.equal(decideRetitle(candidate({ title: "Alter Titel" }), policy({ onlyEmpty: true })), "skip-titled");
});

test("einen user-Titel fasst der Lauf nicht an, --include-user schon", () => {
  assert.equal(decideRetitle(candidate({ title: "Mein Name", source: "user" }), policy()), "skip-user");
  assert.equal(decideRetitle(candidate({ title: "Mein Name", source: "user" }), policy({ includeUser: true })), "title");
});

test("einen Titel unbekannter Herkunft ueberschreibt nichts", () => {
  assert.equal(decideRetitle(candidate({ title: "Wer weiss", source: undefined }), policy()), "skip-unknown");
  assert.equal(decideRetitle(candidate({ title: "Wer weiss", source: undefined }), policy({ includeUser: true })), "skip-unknown");
});

test("Subagent-Dateien und zu junge Dateien werden geschont", () => {
  assert.equal(decideRetitle(candidate({ depth: 3, title: "Alter Titel" }), policy()), "skip-subagent");
  assert.equal(decideRetitle(candidate({ depth: 4, title: "" }), policy()), "skip-subagent");
  const fresh = NOW - 5 * 60 * 1000;
  assert.equal(decideRetitle(candidate({ mtimeMs: fresh, title: "Alter Titel" }), policy()), "skip-recent");
  assert.equal(decideRetitle(candidate({ mtimeMs: NOW - 29 * 60 * 1000, title: "Alter Titel" }), policy()), "skip-recent");
  assert.equal(decideRetitle(candidate({ mtimeMs: NOW - 31 * 60 * 1000, title: "Alter Titel" }), policy()), "title");
  assert.equal(
    decideRetitle(candidate({ mtimeMs: fresh, title: "Mein Name", source: "user" }), policy({ includeUser: true })),
    "skip-recent",
    "das Alter gewinnt gegen --include-user",
  );
});
