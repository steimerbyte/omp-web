import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `GET /api/whoami` is the one route that reports the identity `proxy.ts`
 * established. It reads both headers, maps the account root through
 * `getUserHome()` and must never invent a user for a request without one.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-whoami-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const route = await jiti.import("./route.ts");

const ORIGIN = "http://localhost:30141";

function get(headers) {
  return route.GET(new Request(`${ORIGIN}/api/whoami`, { headers: { host: "localhost:30141", ...headers } }));
}

test.after(() => {
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

test("ohne Identitaets-Header antwortet die Route mit user: null", async () => {
  const response = await get({});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { user: null });
});

test("ein Mandant bekommt Name, Rolle und seine Konto-Wurzel", async () => {
  const response = await get({ "x-omp-user": "who-alice" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.user.username, "who-alice");
  assert.equal(body.user.isAdmin, false);
  assert.equal(body.user.home, join(HOME_ROOT, "who-alice"));
});

test("das Admin-Kennzeichen kommt aus dem Header, die Wurzel ist /", async () => {
  const response = await get({ "x-omp-user": "pi", "x-omp-admin": "1" });
  const body = await response.json();
  assert.equal(body.user.username, "pi");
  assert.equal(body.user.isAdmin, true);
  assert.equal(body.user.home, "/");
});

test("ein Namenswert, der kein Konto sein kann, ist keine Identitaet", async () => {
  // A path segment (`../etc`) is not an account name; proxy.ts never sends one
  // and the route must not hand it back as a user.
  const response = await get({ "x-omp-user": "../etc", "x-omp-admin": "1" });
  assert.deepEqual(await response.json(), { user: null });
});
