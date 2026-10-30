export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the allowed size");
  }
}

/**
 * The body ended before the byte count it declared.
 *
 * This is what a truncated body looks like from inside a route: the transport
 * does not refuse an oversized request, it ends the body early, so the stream
 * reports a normal end in the middle of the payload. Without this check the
 * caller reads a short body that still *looks* complete, and the next step
 * fails with an unrelated parse error — measured on a 40 MB multipart POST
 * against Next's body-clone ceiling: `FormData parse error missing final
 * boundary`, answered as HTTP 500 instead of a 413. It also catches a
 * connection that died mid-upload, which is the same observable fact.
 */
export class RequestBodyTruncatedError extends Error {
  readonly received: number;
  readonly declared: number;

  constructor(received: number, declared: number) {
    super(`Request body ended after ${received} of ${declared} bytes`);
    this.received = received;
    this.declared = declared;
  }
}

function declaredContentLength(request: Request): number | null {
  const value = request.headers.get("content-length");
  if (!value || !/^\d+$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

/**
 * Parse multipart data only after constraining the complete wire body. This
 * bounds chunked requests too, where Content-Length is unavailable or false.
 */
export async function parseFormDataWithinLimit(request: Request, maxBytes: number): Promise<FormData> {
  const declared = declaredContentLength(request);
  if (declared !== null && declared > maxBytes) {
    throw new RequestBodyTooLargeError();
  }

  const reader = request.body?.getReader();
  if (!reader) return request.formData();

  const chunks: BlobPart[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RequestBodyTooLargeError();
      }
      size += value.byteLength;
      const chunk = new Uint8Array(value.byteLength);
      chunk.set(value);
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  // A complete stream that stopped short of its declared length was cut, not
  // finished: the transport ends an oversized body silently instead of
  // refusing it. Checked here, after the size bound above, so an honest
  // oversize still reports "too large" rather than "truncated".
  if (declared !== null && size < declared) {
    throw new RequestBodyTruncatedError(size, declared);
  }

  const contentType = request.headers.get("content-type");
  const headers = contentType ? { "content-type": contentType } : undefined;
  return new Response(new Blob(chunks), { headers }).formData();
}
