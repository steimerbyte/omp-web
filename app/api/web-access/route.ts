import { NextResponse } from "next/server";
import {
  clearWebPassword,
  getWebAuthStatus,
  setWebPassword,
  setWebPasswordEnabled,
  setWebUsername,
  validatePassword,
} from "@/bin/web-auth-store.js";
import { requireAdmin } from "@/lib/request-identity";
import { hasJsonContentType } from "@/lib/request-security";
import type { WebAccessStatus } from "@/lib/api-types";

/**
 * The password lock, as the settings panel drives it.
 *
 * **`proxy.ts` authorises nobody here, it only identifies everyone.** The proxy
 * answers three questions — is this host on the allow-list, is this a browser
 * cross-site call, and are the credentials valid — and it lets through *every
 * valid account*. "Authenticated" is not "administrator": on a multi-account
 * install a tenant named `bob` passes the proxy exactly like the operator does.
 * So the route checks the identity itself, in GET and in PUT, before it reads a
 * body or touches the store.
 *
 * That check was missing here, and it was missing *because of* a comment that said
 * the opposite: it argued from the proxy's pass to the route's own silence — the
 * proxy had vetted every request, so here only the payload was left to police.
 * That argument is what has to die, not the missing line below it.
 *
 * Measured on 12.10.2026: the account `bob` sent `PUT {"action":"disable"}` and
 * got `200`, after which `policy.mode` was `open` and `GET /api/settings`,
 * `/api/models`, `/api/file-index` answered `200` without any credential.
 *
 * The guard lives in `lib/request-identity.ts` next to `isAdminIdentity`, not here.
 * A copy of it in this route would have been the third reason for the next route to
 * grow a fourth.
 *
 * Recovery is deliberately *not* here: it is the one endpoint in this family that
 * answers without credentials, and it lives in `./recovery`.
 */

export const dynamic = "force-dynamic";

type WebAccessAction = "set-password" | "set-username" | "enable" | "disable" | "clear";

const ACTIONS = new Set<WebAccessAction>(["set-password", "set-username", "enable", "disable", "clear"]);

function statusResponse(status: WebAccessStatus) {
  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  // Same guard as PUT, one line, same handler family. `getWebAuthStatus()`
  // carries `username` and the absolute path of the credential file — neither is
  // a credential, so this is not an independent finding; it is there because the
  // status belongs to the host's lock, not to a tenant.
  const denied = requireAdmin(request);
  if (denied) return denied;

  return statusResponse(getWebAuthStatus());
}

export async function PUT(req: Request) {
  // Before the content-type check, before `req.json()`, before anything: a
  // tenant must not be able to change what the whole host asks for at login.
  const denied = requireAdmin(req);
  if (denied) return denied;

  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 415 });
  }

  let body: { action?: unknown; password?: unknown; username?: unknown };
  try {
    body = await req.json() as { action?: unknown; password?: unknown; username?: unknown };
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const action = body.action;
  if (typeof action !== "string" || !ACTIONS.has(action as WebAccessAction)) {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  // `OMP_WEB_PASSWORD` overrides the stored credential, so editing the store
  // while it is set would change nothing a user could observe. The same guard
  // covers `set-username`: an environment-managed lock owns the entire
  // credential pair, not just the password half.
  if (getWebAuthStatus().managedByEnvironment) {
    return NextResponse.json(
      { error: "Password access is managed by the OMP_WEB_PASSWORD environment variable. Unset it to manage the password here." },
      { status: 409 },
    );
  }

  try {
    switch (action as WebAccessAction) {
      case "set-password": {
        const invalid = validatePassword(body.password);
        if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
        // Carry `username` in the same atomic write so the panel can keep the
        // stored username in sync with the freshly-validated one. Omitting it
        // leaves any previously-stored username alone.
        //
        // The narrowing is deliberate: `body` is `unknown` all the way from
        // `req.json()`, and the store option is `string | undefined`. A
        // non-string is dropped rather than forwarded — `setWebPassword` treats
        // `undefined` as "keep what is stored", so a client that sends a number
        // gets the existing username back instead of a stored `"42"`.
        const username = typeof body.username === "string" ? body.username : undefined;
        return statusResponse(setWebPassword(body.password, { username }));
      }
      case "set-username":
        // `setWebUsername` throws on validation failure with a useful message,
        // and the catch below turns it into a 400.
        return statusResponse(setWebUsername(body.username));
      case "enable":
        return statusResponse(setWebPasswordEnabled(true));
      case "disable":
        return statusResponse(setWebPasswordEnabled(false));
      case "clear":
        return statusResponse(clearWebPassword());
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
