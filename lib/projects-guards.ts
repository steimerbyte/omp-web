import { getAllowedFileRoots } from "./file-access";
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

/**
 * The roots of `roots` that this identity may see at all.
 *
 * Filtering happens on *this* identity's allowed roots, so a project that
 * another account added to its own registry does not appear with a path this
 * account cannot open. Hidden rather than refused: the request itself was
 * legitimate, and a 403 would confirm that something exists over there.
 *
 * ### Why it is shared
 *
 * The board (`GET /api/projects`) filters its cards with it, and the sizes
 * endpoint (`GET /api/projects/sizes`) filters its answer with it. The two
 * read the same registry, so they have to answer the same question: a
 * folder that the board does not show must not be reported by the sizes
 * endpoint either — not its size, not its measurement time, and not as
 * something the client is still waiting for.
 *
 * A copy of the check would be a second answer to the same question, and
 * `AGENTS.md` is explicit that a guard copied into a route is a guard that
 * will be out of date in one of the two copies.
 *
 * The allow-list is read once per call and cached for five seconds
 * (`lib/file-access.ts`); the per-root check afterwards is a string
 * comparison.
 */
export async function visibleProjectRoots(
  identity: WebIdentity,
  roots: readonly string[],
): Promise<Set<string>> {
  const visible = new Set<string>();
  const allowed = await getAllowedFileRoots(identity);
  if (allowed.size === 0) return visible;

  const bases = [...allowed].map((root) => root.replace(/\\/g, "/").replace(/\/$/, ""));
  for (const root of roots) {
    const resolved = root.replace(/\\/g, "/");
    if (bases.some((base) => resolved === base || resolved.startsWith(`${base}/`))) {
      visible.add(root);
    }
  }
  return visible;
}
