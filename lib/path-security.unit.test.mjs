import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./path-security.ts");
}

/**
 * "Das ist das Home eines *anderen* Kontos."
 *
 * Die Frage ist strukturell und nicht systemisch beantwortet: der Dienst kann
 * die Konten nicht zuverlaessig aufzaehlen, und die Antwort speist nur eine
 * Ablehnung. Wichtig sind die beiden Richtungen — das eigene Home ist kein
 * fremdes (sonst sperrt sich jeder Nutzer selbst aus), und ein Pfad unter
 * `/home/<name>` ist es sehr wohl, auch wenn er noch nicht existiert.
 */
function withHomeRoot(root, run) {
  const previous = process.env.OMP_WEB_HOME_ROOT;
  process.env.OMP_WEB_HOME_ROOT = root;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.OMP_WEB_HOME_ROOT;
    else process.env.OMP_WEB_HOME_ROOT = previous;
  }
}

test("without an identity nothing is foreign", async () => {
  const { isForeignUserHome } = await loadSubject();

  assert.equal(isForeignUserHome(null, "/home/bob/project"), false);
});

test("the account's own home is not foreign", async () => {
  const { isForeignUserHome } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "omp-homes-"));
  const ownHome = join(root, "alice");
  mkdirSync(join(ownHome, "project"), { recursive: true });

  try {
    const alice = { username: "alice", isAdmin: false };
    withHomeRoot(root, () => {
      assert.equal(isForeignUserHome(alice, join(ownHome, "project")), false);
      assert.equal(isForeignUserHome(alice, ownHome), false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("another account's home tree is foreign, existing or not", async () => {
  const { isForeignUserHome } = await loadSubject();
  const alice = { username: "alice", isAdmin: false };

  assert.equal(isForeignUserHome(alice, "/home/bob"), true);
  assert.equal(isForeignUserHome(alice, "/home/bob/project/file.ts"), true);
  // Ein Praefix, das nur so aussieht: `/homepage` ist kein Home.
  assert.equal(isForeignUserHome(alice, "/homepage/x"), false);
  assert.equal(isForeignUserHome(alice, "/srv/app"), false);
});
