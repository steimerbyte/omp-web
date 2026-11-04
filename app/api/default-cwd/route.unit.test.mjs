import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `POST /api/default-cwd` is the first call the UI makes after login: it creates
 * `omp-cwd-<date>` **in the caller's account root**, never in the process
 * account's home, and refuses a request without an identity.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-default-cwd-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

mkdirSync(join(HOME_ROOT, "cwd-alice"), { recursive: true });

const route = await jiti.import("./route.ts");

function post(headers) {
  return route.POST(
    new Request("http://localhost:30141/api/default-cwd", {
      method: "POST",
      headers: { host: "localhost:30141", ...headers },
    }),
  );
}

const today = () => new Date().toISOString().slice(0, 10);

test.after(() => {
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

test("ohne Identitaet wird kein Verzeichnis angelegt", async () => {
  const response = await post({});
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Unknown user");
  assert.equal(existsSync(join(HOME_ROOT, "omp-cwd-" + today().replace(/-/g, ""))), false);
});

test("ein Mandant bekommt sein Tagesverzeichnis in der eigenen Home", async () => {
  const response = await post({ "x-omp-user": "cwd-alice" });
  assert.equal(response.status, 200);
  const { cwd } = await response.json();
  assert.equal(cwd, join(HOME_ROOT, "cwd-alice", "omp-cwd-" + today().replace(/-/g, "")));
  assert.equal(statSync(cwd).isDirectory(), true);
});

test("der zweite Aufruf ist idempotent", async () => {
  const first = await (await post({ "x-omp-user": "cwd-alice" })).json();
  const second = (await (await post({ "x-omp-user": "cwd-alice" })).json()).cwd;
  assert.equal(second, first.cwd);
});

test("ein Konto ohne angelegte Home bekommt sie mit dem Verzeichnis", async () => {
  // Accounts restored from a backup exist in the credential store before their
  // home does; this call is the first one the UI makes, so it must not 403.
  const response = await post({ "x-omp-user": "cwd-bob" });
  assert.equal(response.status, 200);
  const { cwd } = await response.json();
  assert.equal(cwd, join(HOME_ROOT, "cwd-bob", "omp-cwd-" + today().replace(/-/g, "")));
  assert.equal(statSync(cwd).isDirectory(), true);
});
