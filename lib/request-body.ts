/**
 * Body ceiling for the agent routes, which accept prompts plus base64 images.
 *
 * This is the route's own budget, not a copy of `proxyClientMaxBodySize`
 * (`next.config.ts`): the proxy clones every `/api` body and Next ends that
 * clone **silently** at its limit, so the proxy is a transport ceiling that
 * produces no answer the client can show. The route has to say "too large"
 * itself, and it has to say it about the bytes that actually arrive.
 */
export const MAX_AGENT_REQUEST_BODY_BYTES = 30 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  /** Declared length when there was a usable one, else bytes counted so far. */
  readonly bytes: number;

  constructor(bytes: number) {
    super("Request body exceeds the allowed size");
    this.bytes = bytes;
  }
}

/** Trusted Content-Length, or null when absent or not a plain integer. */
export function declaredContentLength(request: Request): number | null {
  const header = request.headers.get("content-length");
  if (!header || !/^\d+$/.test(header)) return null;
  const length = Number(header);
  return Number.isSafeInteger(length) ? length : null;
}

/**
 * Parse a JSON body only after bounding the bytes read.
 *
 * A declared Content-Length is checked first and rejects without touching the
 * stream, which is what a normal client sends. Chunked requests carry no such
 * header (or a false one), so the stream itself is the only reliable count:
 * the reader aborts as soon as the running total passes `maxBytes` and never
 * buffers the over-budget body. The parse afterwards is the same one
 * `request.json()` performs, so the JSON contract and its errors are unchanged.
 */
export async function readJsonBodyWithinLimit(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const declared = declaredContentLength(request);
  if (declared !== null && declared > maxBytes) {
    throw new RequestBodyTooLargeError(declared);
  }

  const reader = request.body?.getReader();
  // No stream to bound (body already consumed or absent): let `json()` report
  // it exactly as before instead of inventing a second error shape.
  if (!reader) return request.json();

  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RequestBodyTooLargeError(Math.max(size + value.byteLength, declared ?? 0));
      }
      size += value.byteLength;
      // `BlobPart` excludes a SharedArrayBuffer-backed view; a fetch body never
      // arrives on one, and copying every chunk would double the body in memory.
      chunks.push(value as Uint8Array<ArrayBuffer>);
    }
  } finally {
    reader.releaseLock();
  }

  return new Response(new Blob(chunks)).json();
}

/** The `prompt_rejected` payload both agent routes answer an oversized body with. */
export function oversizedRequestBody(error: RequestBodyTooLargeError) {
  return {
    error: `Request body is too large (${Math.round(error.bytes / (1024 * 1024))}MB); attach fewer or smaller images`,
    code: "prompt_rejected",
    accepted: false,
  };
}
