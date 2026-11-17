import fs from "node:fs";
import { uploadTempPath } from "./file-upload";

/**
 * The upload body is bigger than the ticket allowed.
 *
 * The limit is the number the authenticated ticket was minted for, so this is
 * reached when a caller declares one size and sends more — not when a large
 * file is uploaded: the ticket route refused anything above
 * `MAX_UPLOAD_FILE_BYTES` before it was issued.
 */
export class UploadBodyTooLargeError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`Upload body exceeds ${limit} bytes`);
    this.limit = limit;
  }
}

/**
 * Stream a request body into the sibling temp file of its destination.
 *
 * The body is written chunk by chunk and never collected in memory — that is
 * the whole point of this function. A 10 GiB limit behind `request.arrayBuffer()`
 * or `request.formData()` is a 10 GiB buffer; here the process only ever holds
 * one chunk.
 *
 * On every failure (over the limit, a body that ends early, an I/O error) the
 * temp file is removed before the error is rethrown, so a refused upload leaves
 * neither a half-written target nor a stray `.upload` file behind.
 *
 * `maxBytes` is the ticket's declared size: the route rejects a body that
 * exceeds it, and compares the returned count with the declared size to catch
 * a body that ended early (which is also what a transport cut looks like).
 */
export async function spoolUploadBody(
  body: ReadableStream<Uint8Array> | null,
  directory: string,
  fileName: string,
  maxBytes: number,
): Promise<{ tempPath: string; bytes: number }> {
  const tempPath = uploadTempPath(directory, fileName);
  const handle = await fs.promises.open(tempPath, "wx", 0o666 & ~process.umask());
  let written = 0;

  const removeTemp = async () => {
    try {
      await handle.close();
    } catch {
      // Already closed, or the failure happened before it was usable.
    }
    try {
      await fs.promises.unlink(tempPath);
    } catch {
      // Nothing to remove is exactly what this is for.
    }
  };

  try {
    const reader = body?.getReader();

    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (written + value.byteLength > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // The source is already gone; the abort is what matters.
          }
          throw new UploadBodyTooLargeError(maxBytes);
        }
        // `write` may report a partial write; the rest of the chunk has to go
        // out before the next one is read, or the file would come out short.
        let offset = 0;
        while (offset < value.byteLength) {
          const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
          offset += bytesWritten;
        }
        written += value.byteLength;
      }
    }

    await handle.close();
    return { tempPath, bytes: written };
  } catch (error) {
    await removeTemp();
    throw error;
  }
}
