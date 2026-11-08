import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { secretFilePaths, secretMaskFiles } from "./secret-mask.ts";
import { planSandboxSpawn } from "./sandbox.ts";

/**
 * Die Dateien, die in keiner Grenze lesbar sein duerfen.
 *
 * Der Test prueft zwei Dinge, die zusammen erst die Zusage ergeben:
 *
 *  1. **Die Liste ist vollstaendig und stabil** — alle vier Dateien, keine
 *     doppelt, und die Reihenfolge haengt nicht an der Umgebung.
 *  2. **Sie kommt im argv an** — und zwar als `--ro-bind <leer> <ziel>` **nach**
 *     dem Bind, der das Ziel sichtbar macht. Eine Maske davor waere mit dem
 *     naechsten Mount ueberschrieben und damit keine.
 *
 * Dazu die Gegenprobe: eine Datei, die in diesem Plan gar nicht sichtbar waere,
 * ist ein **Planfehler**, kein stiller Filterfall. Ein weggelassener Filter
 * hinterlaesst den Aufrufer in dem Glauben, die Datei sei verdeckt.
 */

const opts = (overrides = {}) => ({
  home: "/tmp",
  username: "tenant",
  command: ["/usr/bin/true"],
  cwd: "/tmp",
  ...overrides,
});

test("die Liste enthaelt alle vier Geheimdateien, ohne Duplikate", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-secret-mask-"));
  const env = {
    OMP_WEB_SECRETS_FILE: join(root, "omp-web.env"),
    OMP_WEB_AUTH_FILE: join(root, "omp-web-auth.json"),
    OMP_WEB_ACCOUNTS_FILE: join(root, "omp-web-accounts.json"),
    OMP_WEB_SESSION_KEY_FILE: join(root, "omp-web-session-key"),
  };
  try {
    const paths = secretFilePaths(env);
    assert.deepEqual(Object.keys(paths), ["secrets", "auth", "accounts", "sessionKey"]);
    assert.equal(paths.secrets, env.OMP_WEB_SECRETS_FILE);
    assert.equal(paths.auth, env.OMP_WEB_AUTH_FILE);
    assert.equal(paths.accounts, env.OMP_WEB_ACCOUNTS_FILE);
    assert.equal(paths.sessionKey, env.OMP_WEB_SESSION_KEY_FILE);

    const list = secretMaskFiles(env);
    assert.deepEqual(list, [paths.secrets, paths.auth, paths.accounts, paths.sessionKey]);
    assert.equal(new Set(list).size, list.length, "no duplicates");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("zwei Pfade auf dieselbe Datei erscheinen nur einmal", () => {
  const env = {
    OMP_WEB_SECRETS_FILE: "/etc/omp-web.env",
    OMP_WEB_AUTH_FILE: "/srv/omp/auth.json",
    // Die Kontendatei zeigt hier absichtlich auf dieselbe Datei wie die
    // Anmeldedaten: das passiert in einer Testinstallation schnell, und ein
    // doppeltes `--ro-bind` auf dasselbe Ziel waere ein Mount ohne Wirkung.
    OMP_WEB_ACCOUNTS_FILE: "/srv/omp/auth.json",
    OMP_WEB_SESSION_KEY_FILE: "/srv/omp/session-key",
  };

  assert.deepEqual(secretMaskFiles(env), [
    "/etc/omp-web.env",
    "/srv/omp/auth.json",
    "/srv/omp/session-key",
  ]);
});

test("die Vorgaben liegen neben der Credential-Datei, nicht in der Umgebung", () => {
  const paths = secretFilePaths({});

  assert.equal(paths.secrets, "/etc/omp-web.env", "the documented default secrets file");
  assert.equal(
    paths.sessionKey.includes("omp-web-session-key"),
    true,
    "the key file name is a contract: docs/plans/tenant-isolation.md A3 names it",
  );
  assert.equal(paths.accounts.endsWith("omp-web-accounts.json"), true);
  assert.equal(paths.auth.endsWith("omp-web-auth.json"), true);
});

test("die Masken stehen im argv, und zwar nach dem Bind des Ziels", (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-mask-plan-"));
  const home = join(root, "tenant");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const secret = join(home, "omp-web.env");
  writeFileSync(secret, "OMP_WEB_PASSWORD=x\n", { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const plan = planSandboxSpawn(opts({ home, cwd: home, maskFiles: [secret] }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  const pairs = [];
  for (let i = 0; i < plan.argv.length; i += 1) {
    if (plan.argv[i] === "--ro-bind") pairs.push([plan.argv[i + 1], plan.argv[i + 2]]);
  }
  // Das Ziel ist der Guest-Pfad: das Home haengt als /home/<name>, der
  // Host-Pfad existiert in der Namespace nicht.
  const guestSecret = `/home/tenant/${secret.slice(home.length + 1)}`;
  const maskIndex = plan.argv.findIndex((arg, i) => arg === "--ro-bind" && plan.argv[i + 2] === guestSecret);
  assert.ok(maskIndex > 0, "the secret must be masked");
  const bindIndex = plan.argv.indexOf("--bind");
  assert.ok(bindIndex >= 0, "the home is bound");
  assert.ok(maskIndex > bindIndex, "the mask must come after the bind it overrides");
  assert.equal(
    pairs.find(([, to]) => to === guestSecret)?.[0],
    plan.argv[maskIndex + 1],
    "the mask source is the empty file, not the secret",
  );
  assert.ok(plan.argv[maskIndex + 1] !== secret, "the secret must not be re-bound over itself");
  assert.equal(plan.argv.includes(secret), false, "the host path is never a bind target inside the namespace");
});

test("eine Maske ausserhalb jedes Binds wird uebersprungen — ENOENT ist die staerkere Zusage", (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-mask-unref-"));
  const home = join(root, "tenant");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Diese Datei existiert, liegt aber weder unter einem System-Bind noch unter
  // dem Home: in der Namespace waere sie nicht sichtbar. Sie trotzdem
  // "mitzumaskieren" waere eine Zusage ohne Deckung.
  const elsewhere = join(root, "nirgendwo", "omp-web-session-key");
  mkdirSync(join(root, "nirgendwo"), { recursive: true });
  writeFileSync(elsewhere, "key\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const plan = planSandboxSpawn(opts({ home, cwd: home, maskFiles: [elsewhere] }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  // Kein Bind macht den Pfad sichtbar, also existiert er in der Grenze nicht.
  // Eine leere Datei dort anzulegen waere schwaecher: sie wuerde einen Pfad
  // erschaffen, den es sonst nicht gibt.
  assert.equal(plan.argv.includes(elsewhere), false);
  assert.equal(plan.argv.includes("--ro-bind") && plan.argv.includes(elsewhere), false);
});

test("eine nicht existierende Maske wird uebersprungen, nicht als Fehler gemeldet", (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-mask-missing-"));
  const home = join(root, "tenant");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // `docs/plans/tenant-isolation.md`: eine frische Installation hat noch keine
  // Kontendatei. `bwrap` bricht bei einem fehlenden Quellpfad ab, also darf die
  // Maske dafuer gar nicht erst in den argv.
  const missing = join(root, "tenant", "gibt-es-nicht.json");
  const plan = planSandboxSpawn(opts({ home, cwd: home, maskFiles: [missing] }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.argv.includes(missing), false, "a missing source is not written into argv");
});

test("in der echten Grenze liest eine maskierte Datei als leer", { skip: !hasBoundary() && "bwrap oder User-Namespaces fehlen" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-mask-live-"));
  const home = join(root, "tenant");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const secret = join(home, "omp-web.env");
  writeFileSync(secret, "OMP_WEB_PASSWORD=streng-geheim\n", { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const guestSecret = `/home/tenant/${secret.slice(home.length + 1)}`;
  const plan = planSandboxSpawn(opts({
    home,
    cwd: home,
    maskFiles: [secret],
    // `wc -c` ohne Dateinamen im Aufruf: sonst steht die Groesse plus Pfad
    // in der Ausgabe und die Behauptung misst die falsche Sache.
    command: ["/usr/bin/sh", "-c", `wc -c < ${guestSecret}`],
  }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  const out = execFileSync(plan.argv[0], plan.argv.slice(1), { encoding: "utf8" });
  assert.equal(out.trim(), "0", "a masked file must read as empty inside the boundary");
});

test("in der echten Grenze ist die Maske auch für eine Datei unter dem Home wirksam", { skip: !hasBoundary() && "bwrap oder User-Namespaces fehlen" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-mask-home-"));
  const home = join(root, "tenant");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Der Fall, den nur das Home-Bind sichtbar macht: die Kontendatei liegt
  // *innerhalb* des Konto-Homes (eine Testinstallation mit
  // `OMP_WEB_ACCOUNTS_FILE` unter dem Home). Ohne die Maske nach dem Bind
  // waere sie in der Grenze lesbar, obwohl der Aufrufer sie fuer verdeckt haelt.
  const secret = join(home, "omp-web-accounts.json");
  writeFileSync(secret, "{\"accounts\":[]}\n", { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const guestSecret = `/home/tenant/${secret.slice(home.length + 1)}`;
  const plan = planSandboxSpawn(opts({
    home,
    cwd: home,
    maskFiles: [secret],
    command: ["/usr/bin/sh", "-c", `wc -c < ${guestSecret}`],
  }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  const out = execFileSync(plan.argv[0], plan.argv.slice(1), { encoding: "utf8" });
  assert.equal(out.trim(), "0", "a secret inside the tenant home must be masked too");
});

function hasBoundary() {
  try {
    execFileSync("unshare", ["-Ur", "true"], { stdio: "ignore" });
    execFileSync("which", ["bwrap"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
