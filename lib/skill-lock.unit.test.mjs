import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./skill-lock.ts");
}

/**
 * Wessen Lock-Datei gelesen wird.
 *
 * Ein globaler Lock hiess: was Alice installiert, sperrt Bob, und ein fremder
 * Eintrag laesst einen Skill als installiert erscheinen, den dieses Konto nie
 * geholt hat. Ein Nicht-Admin bekommt deshalb seine eigene Datei unterhalb
 * seiner Home; der Admin bleibt auf der globalen, weil die Installation mit
 * `npx skills add -g` ohnehin genau dorthin schreibt.
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

test("a tenant reads the lock file below their own home", async () => {
  const { getSkillsLockPathForIdentity } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "omp-locks-"));

  try {
    const path = withHomeRoot(root, () => getSkillsLockPathForIdentity({ username: "alice", isAdmin: false }));
    assert.equal(path, join(root, "alice", ".agents", ".skill-lock.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an admin, and no identity at all, read the global lock file", async () => {
  const { getGlobalSkillsLockPath, getSkillsLockPathForIdentity } = await loadSubject();
  const global = getGlobalSkillsLockPath();

  assert.equal(getSkillsLockPathForIdentity({ username: "pi", isAdmin: true }), global);
  assert.equal(getSkillsLockPathForIdentity(null), global);
});

test("two tenants never share a lock file", async () => {
  const { getSkillsLockPathForIdentity } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "omp-locks-"));

  try {
    const [alice, bob] = withHomeRoot(root, () => [
      getSkillsLockPathForIdentity({ username: "alice", isAdmin: false }),
      getSkillsLockPathForIdentity({ username: "bob", isAdmin: false }),
    ]);
    assert.notEqual(alice, bob);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
