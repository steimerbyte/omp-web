export function normalizeFilePathSlashes(filePath: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\")) {
    return filePath.replace(/\\/g, "/");
  }
  return filePath;
}

/**
 * Encode a filesystem path into the catch-all segment of a `/api/files` URL.
 *
 * The root is its own case: splitting `/` yields two empty segments, and
 * `.filter(Boolean)` dropped both, so the path left the URL entirely.
 * `/api/files/?type=list` then addresses no segment at all — Next answers it
 * with a 308 to `/api/files`, which no catch-all matches, and the explorer
 * showed "Failed to load files (HTTP 404)". A percent-encoded `/` is exactly
 * one segment, and `filePathFromSegments` turns it back into `/`.
 */
export function encodeFilePathForApi(filePath: string): string {
  const normalized = normalizeFilePathSlashes(filePath);
  if (/^\/+$/.test(normalized)) return "%2F";
  return normalized
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

/**
 * Rebuild a filesystem path from the catch-all route's decoded segments.
 *
 * Segments arrive percent-decoded, so a `%2F` inside a file name has already
 * become a real slash by the time it gets here. That is a property of the URL
 * scheme rather than something this function introduces, and it is why the
 * segments are rejoined verbatim instead of being re-validated: the allowlist
 * check downstream resolves the result and is what actually bounds access.
 */
export function filePathFromSegments(segments: string[]): string {
  const joined = segments.join("/");
  if (/^[a-zA-Z]:[\\/]/.test(joined) || joined.startsWith("\\\\")) {
    return joined.replace(/\\/g, "/");
  }
  return "/" + joined.replace(/^\/+/, "");
}

export function getFileName(filePath: string): string {
  const normalized = normalizeFilePathSlashes(filePath).replace(/\/+$/, "");
  return normalized.split("/").pop() ?? normalized;
}

export function getFileDirectory(filePath: string): string {
  const normalized = normalizeFilePathSlashes(filePath).replace(/\/+$/, "");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash < 0) return "";
  if (lastSlash === 0) return "/";
  if (lastSlash === 2 && /^[a-zA-Z]:\//.test(normalized)) return normalized.slice(0, 3);
  return normalized.slice(0, lastSlash);
}

export function getRelativeFilePath(filePath: string, cwd?: string): string {
  if (!cwd) return filePath;

  const normalizedFile = normalizeFilePathSlashes(filePath);
  const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
  if (normalizedFile.startsWith(normalizedCwd + "/")) {
    return normalizedFile.slice(normalizedCwd.length + 1);
  }
  return filePath;
}

export function joinFilePath(parent: string, child: string): string {
  return `${normalizeFilePathSlashes(parent).replace(/\/$/, "")}/${child}`;
}
