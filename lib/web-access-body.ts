/**
 * The ceiling for the two public credential routes.
 *
 * `proxy.ts` lets login and recovery through without a credential, and both
 * read their body before asking the store anything. The proxy is not a
 * substitute: it clones each `/api` body only up to `proxyClientMaxBodySize`
 * and ends that clone silently — a transport limit, not an answer (see
 * `lib/request-body.ts`).
 *
 * Both bodies are tiny — `{username,password}` and `{action,code,password}` —
 * so 4 KiB is generous and leaves nothing worth buffering.
 */
export const MAX_CREDENTIAL_REQUEST_BODY_BYTES = 4 * 1024;

/**
 * One answer for both routes. It names neither an account nor the store's
 * state — the same promise the login route makes for every other rejection.
 */
export const CREDENTIAL_BODY_TOO_LARGE = { error: "Request body is too large" } as const;
