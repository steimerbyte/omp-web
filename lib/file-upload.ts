import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";

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
 * Write one uploaded file, replacing an existing target atomically.
 *
 * The previous implementation deleted the target and then wrote it. Anything
 * that made the write fail — ENOSPC, a read-only filesystem, or a full disk —
 * therefore destroyed the old file and left nothing behind, while the response
 * could only report "error". Here the bytes go to a sibling temp file that is
 * put in place in one step, so a failure anywhere before that step leaves the
 * old file exactly as it was and leaves no half-written file under the target
 * name either.
 *
 * For a fresh name the temp file is `link`ed rather than renamed: link fails
 * with EEXIST if the name was taken in the meantime, which is the guarantee
 * the old `flag: "wx"` gave, without the window in which the name was claimed
 * and then written.
 *
 * The temp file takes the target's mode when replacing one, so overwriting a
 * 0755 script does not quietly strip its +x.
 */
export function writeUploadedFileAtomicSync(
  destination: string,
  bytes: Buffer,
  replacing: boolean,
): void {
  const tempPath = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.upload`,
  );

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
    fs.writeFileSync(tempPath, bytes, { flag: "wx", mode });
    // writeFileSync masks `mode` with the umask again, so an inherited mode
    // that is more permissive than the umask would arrive weakened.
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
