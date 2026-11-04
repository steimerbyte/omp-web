import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./request-identity.ts");
}

/**
 * Die Wurzel, unter der ein Konto arbeiten darf.
 *
 * `resolveUserRoot` ist `getUserHome` in absoluter Form: der Aufrufer prueft
 * spaeter relative Pfade dagegen, und ein relatives Ergebnis waere eine Grenze,
 * die vom aktuellen Verzeichnis abhaengt. Der Admin-Fall bleibt `/` — das ist
 * die dokumentierte Entscheidung "ein Admin-Passwort kompromittiert den Host".
 *
 * Die Home-Wurzel kommt aus `OMP_WEB_HOME_ROOT`; ein Test, der sie nicht setzt,
 * prueft `/home/<name>` gegen die echte Maschine.
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

test("a tenant root is the absolute home under the configured home root", async () => {
  const { resolveUserRoot } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "omp-root-"));

  try {
    const resolved = withHomeRoot(root, () => resolveUserRoot({ username: "alice", isAdmin: false }));
    assert.equal(resolved, join(root, "alice"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the admin root is the filesystem root", async () => {
  const { resolveUserRoot } = await loadSubject();

  assert.equal(resolveUserRoot({ username: "pi", isAdmin: true }), "/");
});

test("a relative home root is still answered absolutely", async () => {
  const { resolveUserRoot } = await loadSubject();

  // `resolve` ist der Grund fuer den Namen: ein relativer Override (etwa
  // `OMP_WEB_HOME_ROOT=accounts` in einem Startskript) darf keine relative
  // Grenze erzeugen.
  const resolved = withHomeRoot("accounts", () => resolveUserRoot({ username: "bob", isAdmin: false }));
  assert.equal(resolved, join(process.cwd(), "accounts", "bob"));
});
