import { getRequestIdentity, type WebIdentity } from "./request-identity";
import { getProjectsPath, isProjectsPathAllowed } from "./projects-store";

/**
 * The guard for every route that touches the projects registry.
 *
 * ### Why this is a module and not a function in a route
 *
 * `app/api/projects/route.ts` had this check inline. The second route that
 * needed it — `GET /api/projects/sizes` — could have copied it, and copying
 * is what `AGENTS.md` forbids: a guard that exists twice exists once too
 * little. The web-access break of 12.10.2026 was exactly that shape: one
 * route had the check, the next one did not, and the gap was closed with a
 * comment that claimed the proxy had covered it.
 *
 * So the check lives here, and both routes call it. A third route that needs
 * it imports it; nobody writes a second copy.
 *
 * ### The two layers
 *
 * 1. `getRequestIdentity` — the account behind the request. `null` means
 *    nobody: there is no default user and no admin fallback, because the
 *    header is set by `proxy.ts` and nowhere else.
 * 2. `isProjectsPathAllowed` — the *derived* registry path must lie inside
 *    that account's own home. This is the second layer, and it catches an
 *    identity whose `OMP_WEB_HOME_ROOT` points somewhere foreign. The path
 *    is checked before any directory is touched, the same order
 *    `isQuickPhrasesPathAllowed` uses.
 *
 * `null` is the only answer that means "refused". The route turns it into
 * 403; it never falls back to a default identity.
 */
export function requireProjectsIdentity(req: Request): WebIdentity | null {
  const identity = getRequestIdentity(req.headers);
  if (identity === null) return null;
  return isProjectsPathAllowed(identity, getProjectsPath(identity)) ? identity : null;
}
