import { readdir, realpath, stat } from "fs/promises";
import { homedir } from "os";
import path from "path";
import { getUserHome, type WebIdentity } from "./request-identity";

export interface BrowsableDirectory {
  name: string;
  path: string;
}

export function shouldShowWindowsDrivePicker(
  directory?: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && !directory;
}

/**
 * Where the picker opens when the caller named no directory.
 *
 * A function of the *identity*, never of `homedir()` alone. The process runs as
 * one account, so `homedir()` is the service account's home — and for a tenant
 * that path is in nobody's allowlist: `/api/cwd/browse` answers `403` for it,
 * so the picker used to open straight into "Access denied" and the only way out
 * was typing a path by hand. An admin keeps `homedir()`, which for him *is* his
 * own home; that is the same split `getAllowedFileRoots` makes when it scans
 * for `~/omp-cwd-*`.
 *
 * Without an identity there is nothing to derive from, so the old `homedir()`
 * stands — that path only reaches callers that have not established an identity
 * yet, and `/api/cwd/browse` refuses those before they get here.
 */
export function getBrowseStartDirectory(directory?: string, identity?: WebIdentity | null): string {
  if (directory) return directory;
  if (identity && !identity.isAdmin) return getUserHome(identity);
  return homedir();
}

export function getWindowsDriveCandidates(): BrowsableDirectory[] {
  return "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => ({
    name: `${letter}:`,
    path: `${letter}:\\`,
  }));
}

export async function listWindowsDrives(): Promise<BrowsableDirectory[]> {
  const candidates = await Promise.all(getWindowsDriveCandidates().map(async (drive) => {
    try {
      const driveStat = await stat(drive.path);
      return driveStat.isDirectory() ? drive : null;
    } catch {
      return null;
    }
  }));

  return candidates.filter((drive): drive is BrowsableDirectory => drive !== null);
}

export function normalizeDirectory(directory: string): string {
  if (directory === "~") return homedir();
  if (/^~[\\/]/.test(directory)) {
    const suffix = directory.slice(2).replace(/[\\/]+/g, path.sep);
    return path.resolve(homedir(), suffix);
  }

  const isWindowsPath = /^[a-zA-Z]:[\\/]/.test(directory)
    || directory.startsWith("\\\\")
    || directory.startsWith("//");
  const pathApi = isWindowsPath ? path.win32 : path;
  const launchCwd = process.env.OMP_WEB_LAUNCH_CWD;
  const baseDirectory = launchCwd ? pathApi.resolve(launchCwd) : process.cwd();
  return pathApi.resolve(baseDirectory, directory);
}

export function getParentDirectory(directory: string): string | null {
  const pathApi = /^[a-zA-Z]:[\\/]/.test(directory) || directory.startsWith("\\\\")
    ? path.win32
    : path;
  const normalized = pathApi.normalize(directory);
  const parent = pathApi.dirname(normalized);
  return parent === normalized ? null : parent;
}

export async function resolveDirectory(directory: string): Promise<string> {
  return realpath(normalizeDirectory(directory));
}

export async function listDirectories(directory: string): Promise<BrowsableDirectory[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  // 忽略损坏、不可访问或不指向目录的符号链接。
  const candidates = await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory()) {
      return { name: entry.name, path: path.join(directory, entry.name) };
    }
    if (!entry.isSymbolicLink()) return null;

    try {
      const entryPath = path.join(directory, entry.name);
      const realEntryPath = await realpath(entryPath);
      const entryStat = await stat(realEntryPath);
      if (!entryStat.isDirectory()) return null;
      return { name: entry.name, path: entryPath };
    } catch {
      return null;
    }
  }));

  return candidates
    .filter((entry): entry is BrowsableDirectory => entry !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}
