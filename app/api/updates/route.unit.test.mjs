import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `/api/updates`: GET is the status every account may see, POST is the one that
 * would move the host and stays admin-only. This fork publishes no installable
 * artifact, so an admin POST answers 409 with the status — the check is that the
 * guard sits in front of the release lookup, not behind it.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const route = await jiti.import("./route.ts");

const ORIGIN = "http://localhost:30141";
const ADMIN = { host: "localhost:30141", "x-omp-user": "pi", "x-omp-admin": "1" };
const TENANT = { host: "localhost:30141", "x-omp-user": "alice" };

const RELEASE = {
  tag_name: "v9.9.9",
  name: "v9.9.9",
  body: "notes",
  html_url: "https://github.com/steimerbyte/omp-web/releases/tag/v9.9.9",
  published_at: "2026-01-01T00:00:00Z",
};

const realFetch = globalThis.fetch;

function stubFetch(handler) {
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = realFetch;
  };
}

function get(headers = TENANT) {
  return route.GET(new Request(`${ORIGIN}/api/updates`, { headers }));
}

function post(headers, body, contentType = "application/json") {
  return route.POST(
    new Request(`${ORIGIN}/api/updates`, {
      method: "POST",
      headers: { ...headers, "content-type": contentType },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

test.after(() => {
  globalThis.fetch = realFetch;
});

test("GET liefert den Release-Status, ohne dass der Host etwas veraendert", async () => {
  const previousVersion = process.env.NEXT_PUBLIC_APP_VERSION;
  process.env.NEXT_PUBLIC_APP_VERSION = "0.1.0";
  const restore = stubFetch(async () => Response.json(RELEASE));
  try {
    const response = await get();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const body = await response.json();
    assert.equal(body.currentAppVersion, "0.1.0");
    assert.equal(body.latestRelease.version, "9.9.9");
    assert.equal(body.updateAvailable, true);
    assert.equal(body.availability, "manual");
    // No artifact is shipped, so the plan is a link to the release, not a script.
    assert.equal(body.install.canInstall, false);
    assert.equal(body.install.reason, "manual");
  } finally {
    restore();
    if (previousVersion === undefined) delete process.env.NEXT_PUBLIC_APP_VERSION;
    else process.env.NEXT_PUBLIC_APP_VERSION = previousVersion;
  }
});

test("ein Operator-Schalter macht den Install-Grund sichtbar", async () => {
  const previous = process.env.OMP_WEB_DISABLE_SELF_UPDATE;
  process.env.OMP_WEB_DISABLE_SELF_UPDATE = "1";
  const restore = stubFetch(async () => Response.json(RELEASE));
  try {
    const body = await (await get()).json();
    assert.equal(body.install.reason, "disabled");
    assert.equal(body.install.canInstall, false);
  } finally {
    restore();
    if (previous === undefined) delete process.env.OMP_WEB_DISABLE_SELF_UPDATE;
    else process.env.OMP_WEB_DISABLE_SELF_UPDATE = previous;
  }
});

test("ein fehlgeschlagener Release-Abruf ist 502, kein stiller Erfolg", async () => {
  const restore = stubFetch(async () => new Response("rate limited", { status: 403 }));
  try {
    const response = await get();
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /HTTP 403/);
  } finally {
    restore();
  }
});

test("ein fremder Host wird abgewiesen", async () => {
  const response = await route.GET(new Request(`${ORIGIN}/api/updates`, { headers: { host: "evil.example" } }));
  assert.equal(response.status, 403);
});

test("POST ist admin-only, auch wenn der Body stimmt", async () => {
  const response = await post(TENANT, {});
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Administrator access is required.");
});

test("POST verlangt JSON, bevor der Release abgefragt wird", async () => {
  let fetched = 0;
  const restore = stubFetch(async () => {
    fetched += 1;
    return Response.json(RELEASE);
  });
  try {
    const response = await post(ADMIN, undefined, "text/plain");
    assert.equal(response.status, 415);
    assert.equal(fetched, 0);
  } finally {
    restore();
  }
});

test("der Admin bekommt 409 mit dem Status statt eines stillen Install", async () => {
  const restore = stubFetch(async () => Response.json(RELEASE));
  try {
    const response = await post(ADMIN, {});
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.match(body.error, /No installable omp-web update/);
    assert.equal(body.status.latestRelease.version, "9.9.9");
  } finally {
    restore();
  }
});
