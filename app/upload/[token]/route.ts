import fs from "node:fs";
import path from "node:path";
import { commitUploadedTempFile, MAX_UPLOAD_LABEL } from "@/lib/file-upload";
import { isApiRequestAllowed } from "@/lib/request-security";
import { spoolUploadBody, UploadBodyTooLargeError } from "@/lib/upload-stream";
import { takeUploadTicket } from "@/lib/upload-tickets";

/**
 * The byte side of an upload: `PUT /upload/<token>`.
 *
 * This route is deliberately **outside** the `proxy.ts` matcher. The proxy
 * clones the body of every request it matches into memory
 * (`node_modules/next/dist/server/body-streams.js`, `cloneBodyStream`) and cuts
 * that clone at `experimental.proxyClientMaxBodySize` — fine for a JSON body,
 * fatal for a 10 GiB one. Here `request.body` is consumed chunk by chunk and
 * written straight to a sibling temp file of the destination, so the process
 * holds one chunk, not the file.
 *
 * It has no identity headers for the same reason, and it needs none: the token
 * *is* the authorization. It was minted by the proxied
 * `POST /api/files/**?type=upload-ticket`, which resolved the directory from
 * the verified identity, checked the write boundary and inspected the
 * conflict. The ticket is single-use and names one file, one size and one
 * directory.
 *
 * Trust boundary, explicitly:
 * - The host allow-list and the Origin/Sec-Fetch-Site gate that `proxy.ts`
 *   applies to every other route are applied by this route too, through the
 *   same `isApiRequestAllowed` helper (`lib/request-security.ts:112`). Leaving
 *   the matcher does not leave that gate behind.
 * - **Authentication is the ticket.** There is no Basic/session check here and
 *   no `x-omp-user` header is read: a caller who holds a valid token may write
 *   the one file the token names, for ten minutes. That is why the mint is the
 *   authenticated half and why the token never appears in a log or a header.
 * - The destination is fixed at mint time; nothing about the path comes from
 *   this request.
 * - **No free-space check.** `spoolUploadBody` streams until the filesystem
 *   says ENOSPC/EDQUOT, then the temp file is removed and the old target stays.
 *   The disk is the only cap on how many accepted tickets can land.
 */

export const dynamic = "force-dynamic";

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  if (!isApiRequestAllowed(request)) {
    return json({ error: "Untrusted API request" }, 403);
  }

  const { token } = await params;
  const ticket = takeUploadTicket(token);
  if (!ticket) {
    return json({ error: "Upload link expired or already used; upload the file again" }, 404);
  }

  // The browser sends Content-Length for a File body. A mismatch cannot be an
  // honest upload of this ticket, so it is refused before the first byte.
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== ticket.size)) {
    return json({ error: "Upload size does not match the declared size" }, 400);
  }

  let spooled: { tempPath: string; bytes: number };
  try {
    spooled = await spoolUploadBody(request.body, ticket.directory, ticket.fileName, ticket.size);
  } catch (error) {
    if (error instanceof UploadBodyTooLargeError) {
      return json({
        error: `Each upload must be ${MAX_UPLOAD_LABEL} or smaller, and its body may not exceed `
          + `the ${ticket.size} bytes it declared`,
      }, 413);
    }
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }

  if (spooled.bytes !== ticket.size) {
    // The stream ended early: a cut connection, or a transport that stopped
    // silently. The temp file is already out of the way; the target is untouched.
    fs.rmSync(spooled.tempPath, { force: true });
    return json({
      error: `Upload ended after ${spooled.bytes} of ${ticket.size} bytes; nothing was written`,
    }, 400);
  }

  try {
    commitUploadedTempFile(spooled.tempPath, path.join(ticket.directory, ticket.fileName), ticket.replacing);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }

  return json({ uploaded: [ticket.fileName], skipped: [], errors: [] }, 200);
}
