import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Hostweite Routen: die zweite Haelfte der Admin-Grenze.
 *
 * Diese Tests rufen die **Route** auf, nicht den Guard. Ein Test, der nur
 * `requireAdmin()` aufruft, beweist, dass der Guard funktioniert — nicht, dass
 * die Route ihn benutzt. Genau diese Luecke hat die Einbrueche entstehen
 * lassen: `/api/web-access/route.ts` hat sie mit dem Kommentar "Every request
 * here has already passed proxy.ts" ueberbrueckt, und `proxy.ts` setzt nur die
 * Identitaet, nicht die Rolle. Der Unterschied zwischen "Guard existiert" und
 * "Route benutzt Guard" ist der Unterschied zwischen sicher und broken.
 *
 * Die Routen werden ueber `jiti` geladen, damit sie als echte Module laufen.
 * Das `agent.db` des Prozesskontos wird dabei **nicht** angefasst: die Routen
 * lesen den Runtime aus `globalThis.__ompRuntimePromise`, und die Tests setzen
 * dort einen Attrappen hinein. Damit ist zusaetzlich beobachtbar, ob eine Route
 * ueberhaupt schreibt — nicht nur, ob sie 403 sagt. Ein "403 zurueck, aber der
 * Schluessel wurde trotzdem geschrieben"-Fehler kann so nicht durchrutschen.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const updatesRoute = await jiti.import("../api/updates/route.ts");
const apiKeyRoute = await jiti.import("../api/auth/api-key/[provider]/route.ts");
const loginRoute = await jiti.import("../api/auth/login/[provider]/route.ts");
const logoutRoute = await jiti.import("../api/auth/logout/[provider]/route.ts");
const providersRoute = await jiti.import("../api/auth/providers/route.ts");
const allProvidersRoute = await jiti.import("../api/auth/all-providers/route.ts");

/** Ein Provider, den es nicht gibt — damit keine Route einen echten erreicht. */
const NO_SUCH_PROVIDER = "no-such-provider";
const params = (provider) => ({ params: Promise.resolve({ provider }) });

const ADMIN = { host: "localhost", "x-omp-user": "pi", "x-omp-admin": "1" };
const TENANT = { host: "localhost", "x-omp-user": "alice" };
const ANON = { host: "localhost" };

/** Der Attrappen-Runtime. `calls` beweist, dass eine Route geschrieben hat. */
function installFakeRuntime() {
  const calls = { set: [], remove: [], logout: [], login: [] };
  globalThis.__ompRuntimePromise = Promise.resolve({
    agentDir: "/nonexistent/omp-web-test",
    settings: { getCwd: () => "/nonexistent" },
    modelRegistry: {
      getAll: () => [],
      hasProvider: (provider) => provider === NO_SUCH_PROVIDER,
    },
    authStorage: {
      hasAuth: () => false,
      getCredentialOrigin: () => undefined,
      listStoredCredentials: () => [],
      set: async (provider, credential) => calls.set.push({ provider, credential }),
      remove: async (provider) => calls.remove.push(provider),
      logout: async (provider) => calls.logout.push(provider),
      login: async () => {
        calls.login.push("started");
        throw new Error("test runtime: login must not run in this test");
      },
    },
  });
  return calls;
}

function removeFakeRuntime() {
  delete globalThis.__ompRuntimePromise;
}

function request(url, { method = "GET", headers = TENANT, body } = {}) {
  return new Request(`http://${headers.host ?? "localhost"}${url}`, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Die Ablehnung des Admin-Guards, an der sich die Behauptung festmacht. */
async function assertAdminDenial(response, label) {
  assert.equal(response.status, 403, `${label}: erwartet 403, bekam ${response.status}`);
  const body = await response.json();
  assert.equal(body.error, "Administrator access is required.", label);
  assert.equal(response.headers.get("Cache-Control"), "no-store", label);
}

async function assertIdentityDenial(response, label) {
  assert.equal(response.status, 401, `${label}: erwartet 401, bekam ${response.status}`);
  const body = await response.json();
  assert.equal(body.error, "Authentication is required.", label);
}

// ---------------------------------------------------------------- updates --

test("a tenant cannot install an omp-web update, and nothing is installed", async () => {
  const response = await updatesRoute.POST(
    request("/api/updates", { method: "POST", headers: TENANT, body: {} }),
  );
  await assertAdminDenial(response, "POST /api/updates als Mandant");
});

test("a request without identity cannot install an omp-web update", async () => {
  const response = await updatesRoute.POST(
    request("/api/updates", { method: "POST", headers: ANON, body: {} }),
  );
  await assertAdminDenial(response, "POST /api/updates anonym");
});

test("the admin gate on POST sits before the content-type check, not after", async () => {
  // Derselbe Request, zweimal: als Mandant 415-frei abgewiesen, als Admin durch
  // die Rolle gekommen und erst an der Naechsten Bedingung gescheitert. Der
  // Unterschied der beiden Antworten ist der Beweis, dass der Guard im Weg ist
  // — und er faellt um, sobald der Guard fehlt.
  const wrongType = (headers) =>
    new Request("http://localhost/api/updates", {
      method: "POST",
      headers: { ...headers, "content-type": "text/plain" },
      body: "{}",
    });

  const asTenant = await updatesRoute.POST(wrongType(TENANT));
  await assertAdminDenial(asTenant, "POST /api/updates mit falschem Content-Type");

  const asAdmin = await updatesRoute.POST(wrongType(ADMIN));
  assert.equal(asAdmin.status, 415, `erwartet 415, bekam ${asAdmin.status}`);
});

test("the update status read is not admin-gated", async () => {
  // GET ruft `getOmpWebUpdateStatus()` auf — ein Netzaufruf. Ihn hier
  // auszufuehren wuerde den Test vom GitHub-Release-API abhaengig machen.
  // Geprueft wird deshalb die Quelle: der Guard steht im POST-Abschnitt
  // und nicht im GET-Abschnitt.
  const source = await readFile(new URL("./updates/route.ts", import.meta.url), "utf-8");
  const getSection = source.slice(
    source.indexOf("export async function GET"),
    source.indexOf("export async function POST"),
  );
  assert.doesNotMatch(getSection, /requireAdmin/, "GET ist eine Lese-Route");
  assert.match(source.slice(source.indexOf("export async function POST")), /requireAdmin/);

  // Die Route startet keinen Prozess. Das Upstream-Release hat sie ueber
  // `execFile` ein `npm install --global omp-web@latest` ausgefuehrt — das
  // Paket der Upstream-Linie, ein anderer Build als der laufende. Ein
  // ausgefuehrter Installationsbefehl gehoert nicht in diese Datei.
  assert.doesNotMatch(source, /execFile|child_process/, "die Route startet keinen Prozess");
  assert.doesNotMatch(source, /npm install|bun add|omp-web@latest/, "kein Installationsbefehl");
});

// --------------------------------------------------------------- api-key --

test("a tenant cannot write the process account's API key", async (t) => {
  const calls = installFakeRuntime();
  t.after(removeFakeRuntime);

  const response = await apiKeyRoute.POST(
    request(`/api/auth/api-key/${NO_SUCH_PROVIDER}`, {
      method: "POST",
      headers: TENANT,
      body: { apiKey: "sk-not-a-real-key" },
    }),
    params(NO_SUCH_PROVIDER),
  );

  await assertAdminDenial(response, "POST /api/auth/api-key als Mandant");
  assert.deepEqual(calls.set, [], "der Schluessel darf nicht geschrieben worden sein");
});

test("a request without identity cannot write an API key", async (t) => {
  const calls = installFakeRuntime();
  t.after(removeFakeRuntime);

  const response = await apiKeyRoute.POST(
    request(`/api/auth/api-key/${NO_SUCH_PROVIDER}`, {
      method: "POST",
      headers: ANON,
      body: { apiKey: "sk-not-a-real-key" },
    }),
    params(NO_SUCH_PROVIDER),
  );

  await assertAdminDenial(response, "POST /api/auth/api-key anonym");
  assert.deepEqual(calls.set, []);
});

test("an admin does reach the store", async (t) => {
  // `hasProvider` des Attrappen kennt nur `NO_SUCH_PROVIDER`, deshalb endet die
  // Route mit 400 "Unknown provider" — nach dem Guard, aber vor dem Schreiben.
  const calls = installFakeRuntime();
  t.after(removeFakeRuntime);

  const response = await apiKeyRoute.POST(
    request("/api/auth/api-key/real-provider", {
      method: "POST",
      headers: ADMIN,
      body: { apiKey: "sk-not-a-real-key" },
    }),
    params("real-provider"),
  );

  assert.equal(response.status, 400, `erwartet 400, bekam ${response.status}`);
  assert.equal((await response.json()).error, `Unknown provider: real-provider`);
  assert.deepEqual(calls.set, []);
});

test("a tenant cannot delete the process account's API key", async (t) => {
  const calls = installFakeRuntime();
  t.after(removeFakeRuntime);

  const response = await apiKeyRoute.DELETE(
    request(`/api/auth/api-key/${NO_SUCH_PROVIDER}`, { method: "DELETE", headers: TENANT }),
    params(NO_SUCH_PROVIDER),
  );

  await assertAdminDenial(response, "DELETE /api/auth/api-key als Mandant");
  assert.deepEqual(calls.remove, [], "der Schluessel darf nicht entfernt worden sein");
});

test("an admin can delete an API key", async (t) => {
  const calls = installFakeRuntime();
  t.after(removeFakeRuntime);

  const response = await apiKeyRoute.DELETE(
    request(`/api/auth/api-key/${NO_SUCH_PROVIDER}`, { method: "DELETE", headers: ADMIN }),
    params(NO_SUCH_PROVIDER),
  );

  assert.equal(response.status, 200, `erwartet 200, bekam ${response.status}`);
  assert.deepEqual(calls.remove, [NO_SUCH_PROVIDER], "der Admin kommt bis zum remove()");
});

test("the API key status read needs an identity, not the admin role", async (t) => {
  const calls = installFakeRuntime();
  t.after(removeFakeRuntime);

  const anonymous = await apiKeyRoute.GET(
    request(`/api/auth/api-key/${NO_SUCH_PROVIDER}`, { headers: ANON }),
    params(NO_SUCH_PROVIDER),
  );
  await assertIdentityDenial(anonymous, "GET /api/auth/api-key anonym");

  // Ein Mandant darf sehen, ob ein Schluessel hinterlegt ist — die Antwort
  // enthaelt kein Geheimnis, nur `configured` und eine Modellzahl.
  const tenant = await apiKeyRoute.GET(
    request(`/api/auth/api-key/${NO_SUCH_PROVIDER}`, { headers: TENANT }),
    params(NO_SUCH_PROVIDER),
  );
  assert.equal(tenant.status, 200, `erwartet 200, bekam ${tenant.status}`);
  const body = await tenant.json();
  assert.equal(body.provider, NO_SUCH_PROVIDER);
  assert.equal(body.configured, false);
  assert.equal(body.models, 0);
  assert.equal("apiKey" in body, false, "die Antwort nennt keinen Schluessel");
  assert.equal("credential" in body, false, "die Antwort nennt keine Credential-Zeile");
  assert.deepEqual(calls.set, []);
});

// ------------------------------------------------------- login / logout --

test("a tenant cannot start an OAuth login", async (t) => {
  const calls = installFakeRuntime();
  t.after(removeFakeRuntime);

  const response = await loginRoute.GET(
    request(`/api/auth/login/${NO_SUCH_PROVIDER}`, { headers: TENANT }),
    params(NO_SUCH_PROVIDER),
  );

  await assertAdminDenial(response, "GET /api/auth/login als Mandant");
  assert.deepEqual(calls.login, [], "der OAuth-Flow darf nicht gestartet sein");
});

test("a tenant cannot submit an OAuth code", async () => {
  const response = await loginRoute.POST(
    request(`/api/auth/login/${NO_SUCH_PROVIDER}`, {
      method: "POST",
      headers: TENANT,
      body: { token: "t", code: "c" },
    }),
    params(NO_SUCH_PROVIDER),
  );

  await assertAdminDenial(response, "POST /api/auth/login als Mandant");
});

test("the admin gate on the login handlers sits before the provider lookup", async () => {
  // Der Admin kommt an der Rolle vorbei und scheitert am leeren Body: 400 statt
  // 403, ohne dass ein Flow gestartet wird. Der Mandant mit demselben Request
  // wird abgewiesen — genau diese Differenz ist der Guard.
  const calls = installFakeRuntime();
  try {
    const post = (headers) =>
      loginRoute.POST(
        request(`/api/auth/login/${NO_SUCH_PROVIDER}`, { method: "POST", headers, body: {} }),
        params(NO_SUCH_PROVIDER),
      );

    await assertAdminDenial(await post(TENANT), "POST /api/auth/login mit leerem Body");
    const asAdmin = await post(ADMIN);
    assert.equal(asAdmin.status, 400, `erwartet 400, bekam ${asAdmin.status}`);
    assert.deepEqual(calls.login, []);
  } finally {
    removeFakeRuntime();
  }
});

test("a tenant cannot log the process account out of a provider", async (t) => {
  const calls = installFakeRuntime();
  t.after(removeFakeRuntime);

  const response = await logoutRoute.POST(
    request(`/api/auth/logout/${NO_SUCH_PROVIDER}`, { method: "POST", headers: TENANT }),
    params(NO_SUCH_PROVIDER),
  );

  await assertAdminDenial(response, "POST /api/auth/logout als Mandant");
  assert.deepEqual(calls.logout, [], "die gespeicherte Zeile darf nicht geloescht worden sein");
});

test("an admin logout reaches the store once the provider resolves", async (t) => {
  const calls = installFakeRuntime();
  t.after(removeFakeRuntime);

  // Der Admin kommt an `resolveOAuthLoginId` vorbei und scheitert dort an einem
  // erfundenen Provider — nach dem Guard, vor dem `logout()`.
  const response = await logoutRoute.POST(
    request(`/api/auth/logout/${NO_SUCH_PROVIDER}`, { method: "POST", headers: ADMIN }),
    params(NO_SUCH_PROVIDER),
  );
  assert.equal(response.status, 400, `erwartet 400, bekam ${response.status}`);
  assert.deepEqual(calls.logout, []);
});

// ---------------------------------------------------------- provider list --

test("the provider listings need an identity, not the admin role", async (t) => {
  installFakeRuntime();
  t.after(removeFakeRuntime);

  for (const [name, route] of [
    ["/api/auth/providers", providersRoute],
    ["/api/auth/all-providers", allProvidersRoute],
  ]) {
    const anonymous = await route.GET(request(name, { headers: ANON }));
    await assertIdentityDenial(anonymous, `GET ${name} anonym`);

    const tenant = await route.GET(request(name, { headers: TENANT }));
    assert.equal(tenant.status, 200, `GET ${name} als Mandant: ${tenant.status}`);
    assert.ok(Array.isArray((await tenant.json()).providers), `GET ${name}: providers fehlt`);
  }
});