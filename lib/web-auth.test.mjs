import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const store = require("../bin/web-auth-store.js");

const STORED_PASSWORD = "a-long-enough-password";
/** Keeps scrypt cheap: these tests exercise the decision, not the cost factor. */
const PARAMS = { cost: 16, keyLength: 32 };

async function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-auth-"));
  try {
    // `OMP_WEB_AUTH_FILE` is part of the same env, because the username and the
    // password are read from two different places: the username from the env's
    // file via `getExpectedUsername()`, the password from `options.file`.
    // Without this line the username came from the developer's real
    // ~/.omp/agent/omp-web-auth.json while the password came from the temp
    // file, so these tests decided against the operator's account name.
    const file = join(dir, "omp-web-auth.json");
    return await run({ file, env: { OMP_WEB_AUTH_FILE: file }, params: PARAMS });
  } finally {
    store.clearVerificationCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function loadSubject() {
  return import("./web-auth.ts");
}

function authorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

test("enables password authentication only for a non-empty configured password", async () => {
  const { isWebPasswordEnabled } = await loadSubject();
  assert.equal(isWebPasswordEnabled(undefined), false);
  assert.equal(isWebPasswordEnabled(""), false);
  assert.equal(isWebPasswordEnabled("secret"), true);
});

test("accepts only the configured username and password", async () => {
  await withStore(async (options) => {
    const { authorizeWebRequest } = await loadSubject();
    const password = "a-configured-password";
    store.setWebPassword(password, options);

    assert.equal(authorizeWebRequest(authorization("omp", password), options).decision, "allow");
    assert.equal(authorizeWebRequest(authorization("admin", password), options).decision, "unauthorized");
    assert.equal(authorizeWebRequest(authorization("omp", "wrong"), options).decision, "unauthorized");
  });
});

test("supports UTF-8 passwords and colons in the password", async () => {
  await withStore(async (options) => {
    const { authorizeWebRequest } = await loadSubject();
    const password = "口令:with:colons";
    store.setWebPassword(password, options);

    assert.equal(authorizeWebRequest(authorization("omp", password), options).decision, "allow");
  });
});

test("rejects missing, malformed, and non-canonical authorization values", async () => {
  const { parseBasicCredentials } = await loadSubject();
  const valid = authorization("omp", "secret");

  assert.equal(parseBasicCredentials(null), null);
  assert.equal(parseBasicCredentials("Bearer token"), null);
  assert.equal(parseBasicCredentials("Basic !!!"), null);
  assert.equal(parseBasicCredentials(`${valid}!`), null);
  assert.equal(parseBasicCredentials(
    `Basic ${Buffer.from("missing-separator", "utf8").toString("base64")}`,
  ), null);
});

test("does not authenticate an empty password", async () => {
  await withStore(async (options) => {
    const { authorizeWebRequest } = await loadSubject();
    store.setWebPasswordEnabled(false, options);

    // The lock is off, so the request is allowed — but through the open
    // policy, not by accepting an empty password. `verifyCredential` rejects
    // the empty string first, so no identity comes back and a caller cannot
    // build a tenant boundary out of `omp:`.
    const result = authorizeWebRequest(authorization("omp", ""), options);
    assert.equal(result.decision, "allow");
    assert.equal(result.identity, null);
  });
});

test("splits basic credentials on the first colon only", async () => {
  const { parseBasicCredentials } = await loadSubject();
  assert.deepEqual(parseBasicCredentials(authorization("omp", "a:b:c")), { username: "omp", password: "a:b:c" });
  assert.equal(parseBasicCredentials("Basic !!!"), null);
  assert.equal(parseBasicCredentials(null), null);
});

test("lets every request through while no password is configured", async () => {
  const { authorizeWebRequest } = await loadSubject();
  await withStore(async (options) => {
    assert.equal(authorizeWebRequest(null, options).decision, "allow");
  });
});

test("authorizes against the stored password", async () => {
  const { authorizeWebRequest } = await loadSubject();
  await withStore(async (options) => {
    store.setWebPassword(STORED_PASSWORD, options);

    assert.equal(authorizeWebRequest(authorization("omp", STORED_PASSWORD), options).decision, "allow");
    assert.equal(authorizeWebRequest(authorization("omp", "wrong-password"), options).decision, "unauthorized");
    assert.equal(authorizeWebRequest(authorization("admin", STORED_PASSWORD), options).decision, "unauthorized");
    assert.equal(authorizeWebRequest(null, options).decision, "unauthorized");
  });
});

/**
 * The decision now travels with the identity behind it, so a route can build a
 * tenant boundary without a second lookup. These two cases are the ones that
 * would silently collapse back into a bare string: the name that reaches the
 * caller, and the case where there is nobody to name.
 */
test("returns the authenticated identity alongside the decision", async () => {
  const { authorizeWebRequest } = await loadSubject();
  await withStore(async (options) => {
    store.setWebPassword(STORED_PASSWORD, options);

    assert.deepEqual(
      authorizeWebRequest(authorization("omp", STORED_PASSWORD), options).identity,
      { username: "omp", isAdmin: true },
    );
    // A rejected request has no identity — not the default one, not an empty
    // object. A caller that forgets to check `.decision` must get `null` here.
    assert.equal(authorizeWebRequest(authorization("omp", "wrong"), options).identity, null);
    assert.equal(authorizeWebRequest(null, options).identity, null);
  });
});

test("authorizes against OMP_WEB_PASSWORD ahead of the stored password", async () => {
  const { authorizeWebRequest } = await loadSubject();
  await withStore(async (options) => {
    store.setWebPassword(STORED_PASSWORD, options);
    // Merge rather than replace: `OMP_WEB_AUTH_FILE` is what keeps the
    // username on the throwaway file, and dropping it would send the
    // username lookup back to the developer's real credential file.
    const withEnv = { ...options, env: { ...options.env, OMP_WEB_PASSWORD: "environment-secret" } };

    assert.equal(authorizeWebRequest(authorization("omp", "environment-secret"), withEnv).decision, "allow");
    assert.equal(authorizeWebRequest(authorization("omp", STORED_PASSWORD), withEnv).decision, "unauthorized");
  });
});

test("stops refusing once the lock is switched off", async () => {
  const { authorizeWebRequest } = await loadSubject();
  await withStore(async (options) => {
    store.setWebPassword(STORED_PASSWORD, options);
    store.setWebPasswordEnabled(false, options);

    assert.equal(authorizeWebRequest(null, options).decision, "allow");
  });
});

test("reports an unreadable credential file rather than unlocking", async () => {
  const { authorizeWebRequest } = await loadSubject();
  await withStore(async (options) => {
    store.setWebPassword(STORED_PASSWORD, options);
    writeFileSync(options.file, "{ not json");

    assert.equal(authorizeWebRequest(authorization("omp", STORED_PASSWORD), options).decision, "unavailable");
  });
});

test("the file-stored username wins over OMP_WEB_USERNAME", async () => {
  const { getExpectedUsername } = await loadSubject();
  await withStore(async (options) => {
    store.setWebUsername("bsteimer", options);
    // `OMP_WEB_AUTH_FILE` is what `resolveWebAuthFile` honours, so the test
    // has to thread the temp credential file through the env for both the
    // resolver and the override scenarios.
    const fileEnv = { ...options.env, OMP_WEB_AUTH_FILE: options.file };

    assert.equal(getExpectedUsername({ ...fileEnv, OMP_WEB_USERNAME: "omp" }), "bsteimer");
    assert.equal(getExpectedUsername({ ...fileEnv, OMP_WEB_USERNAME: "" }), "bsteimer");
  });
});

test("an empty file-stored username falls back to OMP_WEB_USERNAME then the default", async () => {
  const { getExpectedUsername } = await loadSubject();
  await withStore(async (options) => {
    store.setWebPassword(STORED_PASSWORD, options);
    const fileEnv = { ...options.env, OMP_WEB_AUTH_FILE: options.file };

    // No username field at all → default.
    assert.equal(getExpectedUsername({ ...fileEnv }), "omp");
    // Env wins when the file has nothing.
    assert.equal(getExpectedUsername({ ...fileEnv, OMP_WEB_USERNAME: "from-env" }), "from-env");

    // Whitespace-only in the file is also a miss, so the env picks up.
    writeFileSync(options.file, JSON.stringify({
      version: 1,
      enabled: true,
      username: "   ",
    }));
    assert.equal(getExpectedUsername({ ...fileEnv, OMP_WEB_USERNAME: "from-env" }), "from-env");
  });
});

test("a settings-panel write invalidates the cached username without an explicit clear", async () => {
  const { getExpectedUsername } = await loadSubject();
  // Clear the cross-test cache so this scenario starts from a known state.
  delete globalThis.__ompWebAuthUsernameCache;
  await withStore(async (options) => {
    const fileEnv = { ...options.env, OMP_WEB_AUTH_FILE: options.file };

    store.setWebPassword(STORED_PASSWORD, options);
    assert.equal(getExpectedUsername({ ...fileEnv }), "omp");

    store.setWebUsername("bsteimer", options);
    // A fresh call without clearing the global cache must already see the
    // rotated username — the file's new mtimeMs is what invalidates the
    // cache, not a separate teardown hook.
    assert.equal(getExpectedUsername({ ...fileEnv }), "bsteimer");
  });
});
