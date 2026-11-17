import { randomUUID } from "node:crypto";

/**
 * Short-lived, single-use permission to stream one file body to one path.
 *
 * The body cannot travel through the proxy (see `MAX_UPLOAD_FILE_BYTES` in
 * `lib/file-upload.ts`), and a route outside the proxy matcher has no identity
 * headers. A ticket bridges the two: it is minted by an authenticated,
 * proxied request that already resolved the directory, checked the write
 * boundary and inspected the conflict, and it authorizes exactly one PUT of
 * exactly the declared size into exactly that file.
 *
 * The token is `crypto.randomUUID()` — a v4 UUID with 122 random bits, not
 * derived from the path — and is consumed by the first `takeUploadTicket`, so
 * a captured URL cannot be replayed. Lookup is a Map key lookup on the exact
 * string, not a `timingSafeEqual`: the secret is 122 bits, so the comparison
 * timing is not the weak side. The token is returned in the mint response body
 * and used as the PUT path; it is never logged and never set as a header.
 * State lives on `globalThis` because the dev server re-evaluates modules on
 * reload and would otherwise mint tokens into a map nobody reads.
 */
export interface UploadTicket {
  directory: string;
  fileName: string;
  size: number;
  replacing: boolean;
  expiresAt: number;
}

/** Ten minutes is ample for starting one upload; a stale ticket is a 404. */
const TICKET_TTL_MS = 10 * 60 * 1000;

declare global {
  var __ompUploadTickets: Map<string, UploadTicket> | undefined;
}

function ticketStore(): Map<string, UploadTicket> {
  if (!globalThis.__ompUploadTickets) globalThis.__ompUploadTickets = new Map();
  return globalThis.__ompUploadTickets;
}

export function mintUploadTicket(
  ticket: Omit<UploadTicket, "expiresAt">,
  now: number = Date.now(),
): string {
  const tickets = ticketStore();
  for (const [token, entry] of tickets) {
    if (entry.expiresAt <= now) tickets.delete(token);
  }

  const token = randomUUID();
  tickets.set(token, { ...ticket, expiresAt: now + TICKET_TTL_MS });
  return token;
}

/**
 * Consume a ticket. `null` covers unknown, already used and expired alike —
 * the caller answers all three with the same 404, because telling them apart
 * would tell a prober which tokens once existed.
 */
export function takeUploadTicket(token: string, now: number = Date.now()): UploadTicket | null {
  const tickets = ticketStore();
  const ticket = tickets.get(token);
  if (!ticket) return null;
  tickets.delete(token);
  return ticket.expiresAt > now ? ticket : null;
}
