import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { resolveWebAuthPolicy, verifyWebPassword } from "@/bin/web-auth-store.js";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { SESSION_COOKIE_NAME, SESSION_TTL_MS, issueSessionCookie } from "@/lib/web-auth-session";
import { getExpectedUsername } from "@/lib/web-auth";

/**
 * Exchange the web credential for a session cookie.
 *
 * This is the browser door next to Basic Auth, not a replacement for it: curl,
 * the reverse proxy, and every existing client keep sending `Authorization:
 * Basic`, and `proxy.ts` still accepts that. What a cookie buys is a login page
 * instead of a native auth dialog.
 *
 * The credential is `(username, password)`. The username is configurable via
 * `OMP_WEB_USERNAME` (see `getExpectedUsername` in `lib/web-auth.ts`) and
 * defaults to `omp`, so existing deployments keep working without any new
 * wiring.
 */

export const dynamic = "force-dynamic";

/**
 * One message for every failure. Whether the username was wrong, the password
 * was wrong, the store was missing, or the lock is off is exactly what an
 * attacker wants to learn, and none of it helps a person who mistyped their
 * credential. `Sign-in failed.` says only that sign-in failed.
 */
const REJECTED = "Sign-in failed.";

/**
 * Roughly the cost of one scrypt verification, paid on every rejected attempt
 * so that a wrong username, a wrong password, a missing store, and a correct
 * one are indistinguishable over the wire. The username and password checks
 * both run on every attempt for the same reason: returning early on the first
 * mismatch would leak which half was wrong by timing alone.
 */
const FAILURE_DELAY_MS = 150;

const NO_STORE = { "Cache-Control": "no-store" } as const;

async function pause(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

function rejected(): NextResponse {
  return NextResponse.json({ error: REJECTED }, { status: 401, headers: NO_STORE });
}

/** sha-256 the strings so the comparison is the same cost regardless of length. */
function hash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function credentialsEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(hash(actual), hash(expected));
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 415 });
  }

  let body: { username?: unknown; password?: unknown };
  try {
    body = await req.json() as { username?: unknown; password?: unknown };
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  const hasUsername = username.length > 0;
  const hasPassword = password.length > 0;

  // A missing or empty username is rejected with the same generic message and
  // the same delay as a wrong credential: never let a caller probe whether a
  // username exists at all.
  if (!hasUsername || !hasPassword) {
    await pause(FAILURE_DELAY_MS);
    return rejected();
  }

  // Resolved once and passed down so verification and session minting cannot
  // disagree about which credential is in force.
  const policy = resolveWebAuthPolicy();

  // Both halves run unconditionally so an attacker cannot distinguish "wrong
  // username" from "wrong password" by which branch is taken. The boolean
  // results are tracked separately and combined at the end.
  const usernameMatches = credentialsEqual(username, getExpectedUsername());
  const passwordMatches = verifyWebPassword(password, { policy });
  const credentialMatches = usernameMatches && passwordMatches;

  if (!credentialMatches) {
    await pause(FAILURE_DELAY_MS);
    return rejected();
  }

  // `open` and `unavailable` both land on the same generic failure: a caller
  // cannot tell a locked server from an unlocked one, and `proxy.ts` already
  // explains the unreadable-store case to whoever can reach the console.
  if (policy.mode !== "environment" && policy.mode !== "stored") {
    await pause(FAILURE_DELAY_MS);
    return rejected();
  }

  const session = issueSessionCookie({ policy });
  if (session === null) {
    await pause(FAILURE_DELAY_MS);
    return rejected();
  }

  const response = NextResponse.json({ ok: true }, { headers: NO_STORE });
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: session,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    // omp-web is served over plain HTTP on :8788, and a `secure` cookie would be
    // dropped by the browser on every request. Set this to `true` once the
    // server sits behind TLS termination. Never `domain`-scoped: a host-only
    // cookie cannot be widened by a hostile parent domain.
    secure: false,
  });
  return response;
}

/** Sign out: clear the cookie. The Basic Auth path cannot be signed out of. */
export async function DELETE() {
  const response = NextResponse.json({ ok: true }, { headers: NO_STORE });
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: 0,
    secure: false,
  });
  return response;
}
