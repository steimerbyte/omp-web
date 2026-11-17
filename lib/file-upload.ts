import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";

/**
 * The one upload size limit, enforced by the route that accepts the bytes.
 *
 * It is 10 GiB, and the reason it is not enforced on `/api/**` is the proxy:
 * `experimental.proxyClientMaxBodySize` in `next.config.ts` clones the body of
 * every request `proxy.ts` matches into memory and ends that clone silently
 * once the ceiling is passed (`next/dist/server/body-streams.js`,
 * `cloneBodyStream`) — measured at +100 MB RSS for a 100 MB POST. A 10 GiB
 * limit behind that clone is a 10 GiB buffer, so the bytes go to
 * `PUT /upload/<token>` (`app/upload/[token]/route.ts`) instead: a path
 * outside the proxy matcher that streams `request.body` into a sibling temp
 * file of the destination and only then renames it into place. The PUT is
 * authorized by a single-use ticket minted through the proxy by
 * `POST /api/files/**?type=upload-ticket`, so the identity still comes from
 * `proxy.ts` alone.
 *
 * `lib/file-upload-client.ts` mirrors the number so the browser refuses before
 * a byte is sent; `lib/file-upload.test.mjs` asserts that the streaming path
 * is not covered by the proxy matcher.
 */
export const MAX_UPLOAD_FILE_BYTES = 10 * 1024 ** 3;

/** The same limit as text, so rejection messages and the check cannot drift. */
export const MAX_UPLOAD_LABEL = "10 GB";

export const UPLOAD_CONFLICT_STRATEGIES = ["error", "overwrite", "skip"] as const;
export type UploadConflictStrategy = typeof UPLOAD_CONFLICT_STRATEGIES[number];

const UPLOAD_CONFLICT_STRATEGY_SET = new Set<string>(UPLOAD_CONFLICT_STRATEGIES);

export interface UploadTargetInspection {
  conflicts: string[];
  nonReplaceable: string[];
}

export function parseUploadConflictStrategy(value: string | null): UploadConflictStrategy | null {
  const candidate = value ?? "error";
  return UPLOAD_CONFLICT_STRATEGY_SET.has(candidate)
    ? candidate as UploadConflictStrategy
    : null;
}

export function validateUploadFileNames(fileNames: string[]): string | null {
  if (fileNames.length === 0) return "No files selected";

  const seen = new Set<string>();
  for (const fileName of fileNames) {
    if (!fileName || fileName === "." || fileName === ".." || fileName.includes("\0")) {
      return `Invalid file name: ${fileName || "(empty)"}`;
    }
    if (fileName.includes("/") || fileName.includes("\\") || path.basename(fileName) !== fileName) {
      return `File names must not contain a path: ${fileName}`;
    }
    if (seen.has(fileName)) return `Duplicate file name in upload: ${fileName}`;
    seen.add(fileName);
  }

  return null;
}

export function inspectUploadTargets(directory: string, fileNames: string[]): UploadTargetInspection {
  const conflicts: string[] = [];
  const nonReplaceable: string[] = [];

  for (const fileName of fileNames) {
    const destination = path.join(directory, fileName);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw error;
    }

    conflicts.push(fileName);
    if (!stat.isFile() || stat.isSymbolicLink()) nonReplaceable.push(fileName);
  }

  return { conflicts, nonReplaceable };
}

/**
 * The sibling temp file the streamed body lands in.
 *
 * Same directory as the target on purpose: `rename`/`link` must not cross a
 * filesystem boundary, or the commit stops being atomic.
 */
export function uploadTempPath(directory: string, fileName: string): string {
  return path.join(directory, `.${fileName}.${randomUUID()}.upload`);
}

/**
 * Put a fully received upload in place, replacing an existing target atomically.
 *
 * The previous implementation deleted the target and then wrote it. Anything
 * that made the write fail — ENOSPC, a read-only filesystem, or a full disk —
 * therefore destroyed the old file and left nothing behind, while the response
 * could only report "error". Here the bytes were streamed to a sibling temp
 * file first and are put in place in one step, so a failure anywhere before
 * this call leaves the old file exactly as it was and leaves no half-written
 * file under the target name either.
 *
 * For a fresh name the temp file is `link`ed rather than renamed: link fails
 * with EEXIST if the name was taken in the meantime, which is the guarantee
 * the old `flag: "wx"` gave, without the window in which the name was claimed
 * and then written.
 *
 * The file takes the target's mode when replacing one, so overwriting a 0755
 * script does not quietly strip its +x.
 */
export function commitUploadedTempFile(
  tempPath: string,
  destination: string,
  replacing: boolean,
): void {
  // A fresh upload gets the usual umask-derived mode; a replacement keeps the
  // mode of the file it takes the place of.
  let mode = 0o666 & ~process.umask();
  if (replacing) {
    try {
      mode = fs.statSync(destination).mode & 0o777;
    } catch {
      // Vanished between the check and here. The default mode is what any
      // other fresh file would get, so there is nothing better to fall back to.
    }
  }

  try {
    // The temp file was created with the umask-derived mode, so an inherited
    // mode that is more permissive than the umask would arrive weakened.
    if (replacing) fs.chmodSync(tempPath, mode);
    if (replacing) {
      fs.renameSync(tempPath, destination);
    } else {
      fs.linkSync(tempPath, destination);
      fs.unlinkSync(tempPath);
    }
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // The temp file never came into existence, or something else took it.
      // Either way the target is untouched, which is what this function is for.
    }
    throw error;
  }
}
