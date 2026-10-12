import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server";

const require = createRequire(import.meta.url);
const store = require("../bin/web-auth-store.js");

const PASSWORD = "a-long-enough-password";
/** Cheap scrypt: these tests exercise the call graph, not the cost factor. */
const PARAMS = { cost: 16, keyLength: 32 };

const ORIGIN = "http://localhost:30141";

/**
 * This file guards ONE claim: that the mtime-only cache key in
 * `lib/web-auth.ts` is unreachable as a wrong-username oracle.
 *
 * The hazard is concrete. `globalThis.__ompWebAuthUsernameCache` is keyed on
 * `fileMtimeMs` with no path, so two *different* credential files whose
 * `mtimeMs` is identical would serve each other's name — a name from the wrong
 * file would then pass `verifyCredential`. The question is whether any caller
 * can put two different files in front of it.
 *
 * The answer is no, and it is no for a structural reason: `resolveWebAuthFile`
 * takes its input from `options.env ?? process.env`, every production call site
 * passes no options at all, and no production code mutates `process.env`. One
 * server process therefore resolves exactly one credential file, and one file
 * cannot have a same-mtime sibling.
 *
 * Two halves, because either alone proves nothing:
 *
 *   1. A wiring test over the *sources* of the real entry points. It asserts
 *      that no production call site passes `env`/`file`/`accountsFile` into the
 *      auth API. This is the load-bearing half — it is what makes the cache key
 *      sound, and it fails loudly if someone threads an env in later.
 *   2. A behavioural test that drives `proxy.ts` and the login route for real
 *      against two same-mtime files, and asserts both resolve the one file the
 *      server was pointed at. It runs the callers rather than the cache code,
 *      because a test of the cache alone would pass with or without a reachable
 *      second file — which is exactly the mistake AGENTS.md warns about for
 *      guards.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

/** Production files that reach the auth API. Test files are excluded on purpose. */
const ENTRY_POINTS = [
  "proxy.ts",
  "app/api/web-access/login/route.ts",
  "app/api/web-access/route.ts",
  "app/api/web-access/recovery/route.ts",
  "lib/web-auth.ts",
  "lib/web-auth-session.ts",
];

/** Names whose `options` argument carries `env` / `file` / `accountsFile`. */
const AUTH_CALLS = [
  "getExpectedUsername",
  "verifyCredential",
  "authorizeWebRequest",
  "issueSessionCookie",
  "readSessionCookie",
  "verifySessionCookie",
  "getWebAuthStatus",
  "resolveWebAuthPolicy",
  "isAdminUsername",
];

function readEntryPoint(relative) {
  return readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
}

// ---------------------------------------------------------------------------
// 1 — Wiring. The property that keeps the two-file case out of reach.
// ---------------------------------------------------------------------------

test("kein produktiver Aufrufer reicht ein eigenes env oder file in die Auth-API", () => {
  // For each entry point: every call to an auth function must be either
  // argument-less or carry only positional arguments — never an options object
  // with a path or env in it. `lib/web-auth.ts` itself forwards `options.env`
  // internally, so its own definitions are checked by the behavioural half
  // below; what must not exist is a *caller outside* the two lib modules
  // choosing a second credential file.
  const offenders = [];
  for (const relative of ENTRY_POINTS) {
    const source = readEntryPoint(relative);
    const isLibrary = relative.startsWith("lib/");
    for (const name of AUTH_CALLS) {
      // Match a call with its argument list, ignoring the declarations that
      // introduce the function itself.
      const pattern = new RegExp(`(?<![\\w.$])${name}\\s*\\(`, "g");
      for (const match of source.matchAll(pattern)) {
        const before = source.slice(Math.max(0, match.index - 40), match.index);
        if (/function\s+$/.test(before)) continue;
        const args = readCallArguments(source, match.index + match[0].length - 1);
        if (args === null) continue;
        const carriesPath = /\benv\s*:|\bfile\s*:|\baccountsFile\s*:/.test(args);
        if (!carriesPath) continue;
        // Inside the two library modules the forwarding is the documented
        // design (`options.env ?? process.env`); what matters is that the
        // caller of those functions is the one supplying `process.env`.
        if (isLibrary) continue;
        offenders.push(`${relative}: ${name}(${args.replace(/\s+/g, " ")})`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "Ein Aufrufer waehlt eine zweite Credential-Datei; der mtime-only Cache-Schluessel "
      + "in lib/web-auth.ts traegt dann den Pfad nicht mehr:\n" + offenders.join("\n"),
  );
});

/** Read a balanced `(...)` argument list starting at `open`. */
function readCallArguments(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

test("der Server behaelt sein process.env: keine Runtime-Mutation der Pfad-Variablen", () => {
  // The other half of "one file per process". Even with no caller passing an
  // env, a mutated `process.env.OMP_WEB_AUTH_FILE` would move the file under a
  // live cache. `bin/omp-web.js` sets the variable once, in the child's spawn
  // env, before the server starts — nothing rewrites it afterwards.
  const mutable = [
    "OMP_WEB_AUTH_FILE",
    "PI_CODING_AGENT_DIR",
    "PI_CONFIG_DIR",
    "OMP_PROFILE",
    "PI_PROFILE",
  ];
  const offenders = [];
  for (const relative of [...ENTRY_POINTS, "bin/omp-web.js", "instrumentation.ts"]) {
    let source;
    try {
      source = readEntryPoint(relative);
    } catch {
      continue;
    }
    // Strip comments so prose about the variable is not mistaken for a write.
    source = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    for (const key of mutable) {
      const pattern = new RegExp(`process\\.env\\.${key}\\s*(?:=|\\+=|-=)`, "g");
      for (const match of source.matchAll(pattern)) {
        const line = source.slice(0, match.index).split("\n").length;
        // The launcher's spawn env is a fresh object handed to the child, not a
        // mutation of this process's env. Anything else would be the hazard.
        if (relative === "bin/omp-web.js" && source.slice(0, match.index).includes("spawn(")) continue;
        offenders.push(`${relative}:${line} process.env.${key}`);
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

// ---------------------------------------------------------------------------
// 2 — Behaviour. The real callers, against two files with identical mtime.
// ---------------------------------------------------------------------------

/**
 * Two credential files, byte-identical mtime, different stored usernames.
 *
 * This is the exact input the cache key cannot tell apart. If any production
 * caller could reach the second file, the name below would leak across — so the
 * test asserts both real entry points keep answering with `alice`, the file the
 * server was actually pointed at.
 */
async function withCollidingFiles(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-username-cache-"));
  const pointed = join(dir, "pointed", "omp-web-auth.json");
  const sibling = join(dir, "sibling", "omp-web-auth.json");
  const saved = {
    OMP_WEB_AUTH_FILE: process.env.OMP_WEB_AUTH_FILE,
    OMP_WEB_ACCOUNTS_FILE: process.env.OMP_WEB_ACCOUNTS_FILE,
    OMP_WEB_PASSWORD: process.env.OMP_WEB_PASSWORD,
    OMP_WEB_USERNAME: process.env.OMP_WEB_USERNAME,
    OMP_WEB_ADMINS: process.env.OMP_WEB_ADMINS,
    cache: globalThis.__ompWebAuthUsernameCache,
  };

  try {
    store.setWebPassword(PASSWORD, { file: pointed, env: {}, params: PARAMS });
    store.setWebUsername("alice", { file: pointed, env: {} });
    store.setWebPassword(PASSWORD, { file: sibling, env: {}, params: PARAMS });
    store.setWebUsername("bob", { file: sibling, env: {} });

    // Pin both files to the same timestamp. The cache reads `statSync(...).mtimeMs`
    // and nothing else, so this is what makes the two indistinguishable.
    const pinned = new Date("2026-01-02T03:04:05.000Z");
    utimesSync(pointed, pinned, pinned);
    utimesSync(sibling, pinned, pinned);

    // The server sees exactly one of them — this is what `bin/omp-web.js`
    // hands the child process.
    process.env.OMP_WEB_AUTH_FILE = pointed;
    delete process.env.OMP_WEB_PASSWORD;
    delete process.env.OMP_WEB_USERNAME;
    process.env.OMP_WEB_ADMINS = "alice";
    process.env.OMP_WEB_ACCOUNTS_FILE = join(dir, "no-accounts.json");

    const { getExpectedUsername } = await import("./web-auth.ts");

    // Ohne diese Zeile waere der ganze Test mueglichst vakuos: faelle
    // `utimesSync` auf diesem Dateisystem aus oder veraendere sich die mtime
    // durch das Lesen, waeren die beiden Dateien unterscheidbar, der Cache
    // haette nie verwechselt, und beide Aufrufer hier waeren gruen, ohne dass
    // irgendetwas geprueft wurde. Der Zusammenfall ist die Voraussetzung des
    // Beweises, also wird er behauptet, bevor er benutzt wird.
    const pointedMtime = statSync(pointed).mtimeMs;
    const siblingMtime = statSync(sibling).mtimeMs;
    assert.equal(pointedMtime, siblingMtime, "die beiden Dateien teilen sich die mtime");
    assert.notEqual(pointed, sibling, "es sind zwei verschiedene Pfade");

    // Der Cache traegt keinen Pfad — nur diese mtime und den Namen. Genau das
    // macht die Verwechslung moeglich, und genau deshalb wird sie hier geprueft.
    const { getExpectedUsername: probe } = { getExpectedUsername };
    assert.equal(probe({ OMP_WEB_AUTH_FILE: pointed }), "alice", "die pointete Datei liefert alice");
    assert.equal(
      probe({ OMP_WEB_AUTH_FILE: sibling }),
      "alice",
      "die Geschwisterdatei liefert durch den mtime-Schluessel ebenfalls alice — das ist "
        + "die Luecke, und sie ist genau dann harmlos, wenn kein Aufrufer die zweite Datei waehlt",
    );

    // Der Server selbst sieht nur die pointete Datei.
    assert.equal(getExpectedUsername(), "alice", "Vorbedingung: der Server sieht die pointete Datei");
    assert.equal(getExpectedUsername(), "alice", "Vorbedingung: der Cache liefert weiterhin alice");

    return await run({ dir, pointed, sibling, getExpectedUsername });
  } finally {
    store.clearVerificationCache();
    for (const [key, value] of Object.entries({
      OMP_WEB_AUTH_FILE: saved.OMP_WEB_AUTH_FILE,
      OMP_WEB_ACCOUNTS_FILE: saved.OMP_WEB_ACCOUNTS_FILE,
      OMP_WEB_PASSWORD: saved.OMP_WEB_PASSWORD,
      OMP_WEB_USERNAME: saved.OMP_WEB_USERNAME,
      OMP_WEB_ADMINS: saved.OMP_WEB_ADMINS,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // `bun test` shares one globalThis across files, so a cache left behind
    // here would leak into the next test file's credentials.
    if (saved.cache === undefined) delete globalThis.__ompWebAuthUsernameCache;
    else globalThis.__ompWebAuthUsernameCache = saved.cache;
    rmSync(dir, { recursive: true, force: true });
  }
}

function basic(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function proxyRequest(headers = {}) {
  return new NextRequest(`${ORIGIN}/api/whoami`, {
    headers: { host: "localhost:30141", ...headers },
  });
}

test("proxy.ts beantwortet die Anfrage mit dem Namen der Datei, auf die der Server zeigt", async () => {
  await withCollidingFiles(async () => {
    const { proxy } = await jiti.import("../proxy.ts");

    const allowed = proxy(proxyRequest({ authorization: basic("alice", PASSWORD) }));
    assert.equal(allowed.status, 200, "alice ist die konfigurierte Identitaet und muss durchkommen");

    // The sibling file's name must not be accepted, even though its mtime is
    // identical and it carries a valid digest for the same password.
    const impostor = proxy(proxyRequest({ authorization: basic("bob", PASSWORD) }));
    assert.equal(impostor.status, 401, "bob gehoert zur anderen Datei und darf nicht gelten");
  });
});

test("die Login-Route beantwortet das leere username-Feld mit dem Namen der pointeten Datei", async () => {
  await withCollidingFiles(async () => {
    const { POST } = await jiti.import("../app/api/web-access/login/route.ts");

    // `getExpectedUsername()` is what the route calls when the body omits the
    // name — the browser login form's normal path.
    const withoutName = await POST(new Request(`${ORIGIN}/api/web-access/login`, {
      method: "POST",
      headers: { host: "localhost:30141", "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    }));
    assert.equal(withoutName.status, 200, "Das leere Namensfeld nimmt alice an");
    const okBody = await withoutName.json();
    assert.equal(okBody.user.username, "alice");

    const withName = await POST(new Request(`${ORIGIN}/api/web-access/login`, {
      method: "POST",
      headers: { host: "localhost:30141", "content-type": "application/json" },
      body: JSON.stringify({ username: "bob", password: PASSWORD }),
    }));
    assert.equal(withName.status, 401, "bob ist nicht die Identitaet dieses Servers");
  });
});