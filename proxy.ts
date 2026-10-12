import { NextResponse, type NextRequest } from "next/server";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import { isAdminUsername, authorizeWebRequest, type WebIdentity } from "@/lib/web-auth";
import { REQUEST_ADMIN_HEADER, REQUEST_USER_HEADER } from "@/lib/request-identity";
import { SESSION_COOKIE_NAME, readSessionCookie } from "@/lib/web-auth-session";

/**
 * The surfaces that answer without credentials.
 *
 * `proxy.ts` hands a locked-out browser to `/login`, and the recovery page is
 * what that page links to — so both, and the API that backs them, have to be
 * reachable or the redirect would loop. Neither can let anyone in on its own:
 * `/recover` mints a code it prints on the server's own console, and the login
 * API answers with a session cookie only for a correct password.
 */
const RECOVERY_PAGE = "/recover";
const RECOVERY_API = "/api/web-access/recovery";
const LOGIN_PAGE = "/login";
const LOGIN_API = "/api/web-access/login";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * The challenge a client is met with when it is refused.
 *
 * `WWW-Authenticate` is what raises the native Basic dialog, so it may never
 * go to a browser. Rather than trust the rule "browsers only prompt on a
 * top-level navigation" — true today in Chrome and Firefox, and not something
 * this code can enforce — the header is withheld from anything that carries
 * Fetch Metadata, which every browser sends and no CLI sends. A header that
 * cannot reach a browser cannot open a dialog, whatever a future engine does
 * with a 401 on an XHR.
 *
 * Scripted clients keep it, and they need it: RFC 9110 §15.5.2 asks for the
 * header on every 401, it names the scheme this door accepts, and
 * challenge-response clients send nothing until they have seen it. `curl -u`
 * works either way — it offers Basic without waiting to be asked — but
 * `curl --anyauth`, and the Go, Java and Rust stacks, all wait. Losing the
 * header would not change their status code, only stop them from ever
 * authenticating.
 */
function rejectionHeaders(request: NextRequest): Record<string, string> {
  const isBrowser = request.headers.has("sec-fetch-mode") || request.headers.has("sec-fetch-site");
  return isBrowser ? { ...NO_STORE } : { ...NO_STORE, "WWW-Authenticate": 'Basic realm="omp-web", charset="UTF-8"' };
}

/**
 * Haenge die Identitaet an den Request an, damit die Route sie lesen kann.
 *
 * `request.headers.delete` zuerst ist nicht Kosmetik. Ein Request-Header ist
 * etwas, das jeder Client mitschickt — ohne das Loeschen koennte jeder Aufrufer
 * `x-omp-admin: 1` setzen und waere Admin. Der Proxy ist die einzige Stelle, an
 * der die Identitaet entsteht, also ist er auch die einzige, die den mitgelieferten
 * Wert entfernen darf.
 *
 * Der Weg geht ueber `NextResponse.next({ request: { headers } })`, weil ein
 * Header auf der `NextResponse` selbst nur in die Antwort zum Client ginge und
 * niemals im Handler ankommt. Ein duennes `return new NextResponse(...)` waere
 * die bequemere Form und waere falsch.
 */
/**
 * The identity headers, rewritten from what the request actually proved.
 *
 * `identity` is `null` for an anonymous request, and that case has to run
 * through here as well. Deleting the incoming headers is the only thing that
 * makes them trustworthy, and a delete that a branch never reaches is not a
 * protection but dead code: on an unlocked server (`policy.mode === "open"`,
 * no credential file) every request answers `allow` with `identity === null`,
 * so guarding this call on `identity !== null` let `x-omp-admin: 1` from the
 * client through untouched and handed out `/etc`.
 *
 * So the delete is unconditional and only the set is conditional. Measured
 * before the fix: `curl -H 'x-omp-user: root' -H 'x-omp-admin: 1'
 * .../api/files/etc?type=list` returned 200 and listed `/etc`.
 */
function withIdentity(request: NextRequest, identity: WebIdentity | null): NextResponse {
  const headers = new Headers(request.headers);
  headers.delete(REQUEST_USER_HEADER);
  headers.delete(REQUEST_ADMIN_HEADER);
  if (identity !== null) {
    headers.set(REQUEST_USER_HEADER, identity.username);
    if (identity.isAdmin) headers.set(REQUEST_ADMIN_HEADER, "1");
  }
  return NextResponse.next({ request: { headers } });
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApiRequest = pathname === "/api" || pathname.startsWith("/api/");
  const isTrustedRequest = isApiRequest
    ? isApiRequestAllowed(request)
    : isApiRequestHostAllowed(request);

  if (!isTrustedRequest) {
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  // Recovery and login stay reachable while locked out — they are the way out —
  // but only after the host and cross-site checks above have run. They go
  // through `withIdentity` too, with a null identity: no header is set, and
  // whatever the client sent under those names is gone. Neither route reads
  // them today, but a rule with an exception grows a second exception at the
  // next refactor, and this one is the line that would be copied.
  if (
    pathname === RECOVERY_PAGE || pathname === RECOVERY_API
    || pathname === LOGIN_PAGE || pathname === LOGIN_API
  ) {
    return withIdentity(request, null);
  }

  // Basic Auth still stands: curl, the reverse proxy, and existing clients all
  // send it. A session cookie is the browser's second door, signed by the same
  // credential — so changing the password kills both at once.
  const { decision, identity: basicIdentity } = authorizeWebRequest(request.headers.get("authorization"));

  // The session cookie is the second door, and it is also where the identity
  // usually comes from: a browser never sends `Authorization`, only the cookie.
  //
  // It is read whenever Basic Auth did *not* already identify someone — not
  // only when the request was rejected. An unlocked server with accounts on it
  // answers `allow` to everyone, and a signed-in browser there still has to be
  // told who it is; otherwise the first account created through the admin panel
  // would sign in to a session nobody downstream can attribute.
  let identity = basicIdentity;
  if (identity === null) {
    const sessionUser = readSessionCookie(request.cookies.get(SESSION_COOKIE_NAME)?.value);
    if (sessionUser !== null) identity = { username: sessionUser, isAdmin: isAdminUsername(sessionUser) };
  }

  // Every path that lets a request through goes out through `withIdentity`,
  // including the anonymous one. The early return below is only for the
  // identified case, where the headers get rewritten to the proven values.
  if (identity !== null) {
    return withIdentity(request, identity);
  }

  if (decision === "unavailable") {
    const message = "Password access is enabled but the omp-web credential file could not be read."
      + " Run `omp-web --reset-password` on the server to set a new password.";
    return isApiRequest
      ? NextResponse.json({ error: message }, { status: 503, headers: { "Cache-Control": "no-store" } })
      : new NextResponse(message, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  if (decision === "unauthorized") {
    // There are exactly two answers to being refused, and which one goes out
    // depends on who is asking.
    //
    // A browser gets the 302 to `/login` and nothing else. The alternative
    // shape — a 401 carrying `WWW-Authenticate` — is what raises the native
    // Basic dialog, and an inline HTML page behind it is a worse way in than a
    // real form: the visitor cannot see that the door moved. So no response a
    // browser can be shown carries that header, and the NGINX-style page is
    // gone rather than left as a fallback nobody reaches.
    //
    // A script keeps the 401, and the challenge on it where it can use one.
    // That is the machine-readable contract: RFC 9110 §15.5.2 asks for the
    // header on every 401, it names the accepted scheme, and a
    // challenge-response client sends nothing until it has seen it. Nothing
    // about the rejection is softer for a script than for a browser — same
    // `decision`, same status, same body; `rejectionHeaders` is what keeps the
    // one header apart, so a browser's own XHR to `/api/*` is refused without
    // being handed anything that could open a dialog.
    if (isNavigation(request, isApiRequest)) {
      return NextResponse.redirect(new URL(LOGIN_PAGE, request.url), {
        status: 302,
        headers: NO_STORE,
      });
    }

    return NextResponse.json(
      { error: "Authentication required", recoveryPath: RECOVERY_PAGE, loginPath: LOGIN_PAGE },
      { status: 401, headers: rejectionHeaders(request) },
    );
  }

  // Unlocked server, no credentials on the request: the request is allowed, and
  // `identity` is null. It still has to pass through `withIdentity`, otherwise
  // a client-supplied `x-omp-admin: 1` survives into the route. No header is
  // set, so downstream sees no identity and answers 403 — which is the same
  // answer an anonymous request gets, and the one its own guards already gave.
  return withIdentity(request, null);
}

/**
 * Whether this caller is loading a document into a browser window, as opposed
 * to a script asking for data. Only a real navigation is handed the login page
 * redirect; a client call stays on the 401 so its caller can react to it.
 *
 * `x-requested-with` is the one signal that settles it on its own: jQuery and
 * everything built on it set it on an XHR, and no browser sets it on a
 * navigation, so its presence rules a navigation out even when the fetch
 * metadata below is absent.
 *
 * Past that, the two request kinds are told apart by `Sec-Fetch-Mode`, and
 * they differ in how a *missing* header is read — which is the whole point:
 *
 *   - A page URL falls back to "navigation". No header means no promise of any
 *     kind, and `curl http://host/` has to be one, because the browser needs
 *     to land on `/login` and there is no other door left. The fallback errs
 *     toward the redirect, and it errs in the harmless direction: it may hand
 *     a script a 302 where it would have preferred a 401, but it can never
 *     hand a page to a caller that asked for data.
 *
 *   - An API URL requires the header. `curl http://host/api/whoami` sends
 *     none either, and its documented answer is a 401 with a challenge, so the
 *     same fallback would break it. It is also the stricter rule, which is why
 *     it is safe: a browser always sends `Sec-Fetch-Mode: navigate` for a
 *     top-level load — including of an `/api/*` URL typed into the address
 *     bar, which is a document load and would raise the dialog just like `/`
 *     does. No script sends that header by accident.
 */
function isNavigation(request: NextRequest, isApiRequest: boolean): boolean {
  if (request.headers.get("x-requested-with")) return false;
  if (!request.headers.has("sec-fetch-mode")) return !isApiRequest;
  return request.headers.get("sec-fetch-mode") === "navigate";
}

export const config = { matcher: ["/", "/login", "/recover", "/api/:path*"] };
