import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { readArchivedIds, setSessionArchived } from "./session-archive.ts";

/**
 * Das Archiv ist eine reine Frontend-Markierung: eine flache Liste neben den
 * Session-Dateien, die keine Session anfasst. Ein kaputter Registry-Inhalt darf
 * die Session-Liste nie mitreissen.
 */

const REGISTRY = "omp-web-archived.json";

function withAgentDir(t) {
  const previous = getAgentDir();
  const dir = mkdtempSync(join(tmpdir(), "omp-web-archive-"));
  setAgentDir(dir);
  t.after(() => {
    setAgentDir(previous);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("a missing registry reads as an empty set", (t) => {
  withAgentDir(t);

  assert.deepEqual([...readArchivedIds()], []);
});

test("archiving adds and restoring removes, keeping the file sorted and atomic", (t) => {
  const dir = withAgentDir(t);

  setSessionArchived("session-b", true);
  setSessionArchived("session-a", true);
  assert.deepEqual([...readArchivedIds()], ["session-a", "session-b"]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, REGISTRY), "utf8")), {
    archived: ["session-a", "session-b"],
  });

  setSessionArchived("session-a", false);
  assert.deepEqual([...readArchivedIds()], ["session-b"]);

  // Restoring an id that is not archived is a no-op, not an error.
  setSessionArchived("never-archived", false);
  assert.deepEqual([...readArchivedIds()], ["session-b"]);
});

test("a corrupt registry is treated as empty instead of breaking the list", (t) => {
  const dir = withAgentDir(t);

  writeFileSync(join(dir, REGISTRY), "{not json");
  assert.deepEqual([...readArchivedIds()], []);

  // A structurally valid file with the wrong shape reads the same way.
  writeFileSync(join(dir, REGISTRY), JSON.stringify({ archived: "session-a" }));
  assert.deepEqual([...readArchivedIds()], []);

  // Non-string entries are dropped, string entries survive.
  writeFileSync(join(dir, REGISTRY), JSON.stringify({ archived: ["session-a", 7, null, "session-b"] }));
  assert.deepEqual([...readArchivedIds()], ["session-a", "session-b"]);
});

test("writing recreates the registry directory if it was removed", (t) => {
  const dir = withAgentDir(t);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  setSessionArchived("session-c", true);

  assert.equal(readFileSync(join(dir, REGISTRY), "utf8").includes("session-c"), true);
});
