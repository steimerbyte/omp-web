import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `POST /api/cwd/validate` und die Tilde.
 *
 * Das Eingabefeld des DirectoryPickers wirbt mit `~/project`, und was der
 * Nutzer dort eintippt, geht unveraendert an diese Route. `normalizeDirectory()`
 * loeste die Tilde mit `os.homedir()` auf — der Home des Dienstkontos, weil der
 * Prozess als ein Benutzer laeuft. Das Verzeichnis existiert dort nicht
 * ("Directory does not exist: ~/projects/app"), und selbst wenn es existierte,
 * laege es ausserhalb der Home des Kontos und der Check `isPathInUserHome()`
 * wuerde es mit "Access denied" abweisen. Die Kurzschreibweise, die das eigene
 * Eingabefeld anbietet, war fuer Mandanten damit toter als ein unabhaengiger
 * Pfad.
 *
 * Der Test ruft die **Route** auf, weil genau ihre Weitergabe der Identitaet
 * fehlte — ein Test von `normalizeDirectory()` allein haette genau die Luecke
 * zugelassen, um die es geht.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-cwdval-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const validateRoute = await jiti.import("./route.ts");

function seedTenantHome(username) {
  const home = join(HOME_ROOT, username);
  mkdirSync(join(home, "projects", "app"), { recursive: true });
  return home;
}

function validate(cwd, username) {
  return validateRoute.POST(new Request("http://localhost:30141/api/cwd/validate", {
    method: "POST",
    headers: { host: "localhost:30141", "content-type": "application/json", "x-omp-user": username },
    body: JSON.stringify({ cwd }),
  }));
}

test.after(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

test("'~/projects/app' validiert gegen das Home des angemeldeten Kontos", async () => {
  const home = seedTenantHome("alice");

  const res = await validate("~/projects/app", "alice");
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.cwd, join(home, "projects", "app"));
});

test("zwei Konten loesen dieselbe Tilde auf verschiedene Verzeichnisse auf", async () => {
  const aliceHome = seedTenantHome("alice");
  const bobHome = seedTenantHome("bob");

  const [alice, bob] = await Promise.all([
    validate("~/projects/app", "alice"),
    validate("~/projects/app", "bob"),
  ]);

  assert.equal((await alice.json()).cwd, join(aliceHome, "projects", "app"));
  assert.equal((await bob.json()).cwd, join(bobHome, "projects", "app"));
});

test("die Tilde eines Mandanten erreicht nicht das Home eines anderen", async () => {
  const bobHome = seedTenantHome("bob");
  mkdirSync(join(HOME_ROOT, "alice", "projects", "app"), { recursive: true });

  // `~` ist die Home des Kontos, nicht irgendein Home. Ein Verzeichnis, das nur
  // bei bob existiert, ist fuer alice nicht valide.
  const res = await validate("~", "alice");
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.cwd, join(HOME_ROOT, "alice"));
  assert.notEqual(body.cwd, bobHome);
});
