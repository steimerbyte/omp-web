import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
} from "@/lib/file-access";
import { getRequestIdentity } from "@/lib/request-identity";
import { resolveDirentIsDirectory } from "@/lib/file-dirent";
import { buildEntriesFromFiles, filterFileEntries, type FileIndexEntry } from "@/lib/file-fuzzy";
import { isPathWithinRoots } from "@/lib/path-security";
import { isApiRequestAllowed } from "@/lib/request-security";

const execFileAsync = promisify(execFile);

// Same skip lists as /api/files — only used for the non-git readdir fallback.
// Git-tracked repos rely on .gitignore instead (matches the TUI's fd behavior).
const IGNORED_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store",
]);

const IGNORED_SUFFIXES = [".pyc"];

/** Cap on the plain (no-query) response used as the client-side index */
const MAX_FILES = 5000;
/** Hard caps on the full in-memory listing that ?q= searches against */
const GIT_HARD_CAP = 200_000;
const WALK_HARD_CAP = 50_000;
const MAX_WALK_DEPTH = 8;
const MAX_QUERY_LENGTH = 500;
const CACHE_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 20;

interface FileListing {
  /** Full listing up to the hard cap (not the client cap) */
  files: string[];
  /** True when even the hard cap was exceeded */
  hardTruncated: boolean;
}

interface CacheEntry {
  listing: FileListing;
  /** Derived lazily on the first ?q= search against this listing */
  entries?: FileIndexEntry[];
  expiresAt: number;
}

// Per-cwd cache on globalThis so it survives Next.js hot-reload; the @ menu
// re-requests on every open and searches on every keystroke, so listings must
// not be recomputed within a short window.
declare global {
  var __ompFileIndexCache: Map<string, CacheEntry> | undefined;
}

function getIndexCache(): Map<string, CacheEntry> {
  if (!globalThis.__ompFileIndexCache) globalThis.__ompFileIndexCache = new Map();
  return globalThis.__ompFileIndexCache;
}

async function listWithGit(cwd: string): Promise<FileListing | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { timeout: 10_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
    );
    const all = stdout.split("\0").filter(Boolean);
    if (all.length > GIT_HARD_CAP) {
      return { files: all.slice(0, GIT_HARD_CAP), hardTruncated: true };
    }
    return { files: all, hardTruncated: false };
  } catch {
    // Not a git repo (or git unavailable) — caller falls back to readdir walk.
    return null;
  }
}

/** The resolved path, or `null` when it cannot be resolved. Never throws. */
function realpathOrNull(candidate: string): string | null {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return null;
  }
}

function listWithWalk(cwd: string): FileListing {
  const files: string[] = [];
  const rootReal = realpathOrNull(cwd);
  // `real` travels with each queued directory so the visited set can be filled
  // without a `realpath` syscall per directory: the real path of a plain child
  // of a directory whose own real path is known is that path plus the name.
  const queue: Array<{ abs: string; rel: string; depth: number; real: string | null }> = [
    { abs: cwd, rel: "", depth: 0, real: rootReal },
  ];
  // Symbolic links are listed and — when they point at a directory inside the
  // tree — descended into. Both conditions are needed:
  //
  // - Without following them at all, `d.isFile()` and `d.isDirectory()` are
  //   false for a link, so every symlink fell through the loop and vanished.
  //   `git ls-files` *does* list them, so the two listing paths disagreed on
  //   the same folder: `link.ts` and a symlinked `src/` were @-mentionable in
  //   a git repo and not in a plain directory. `resolveDirentIsDirectory` is
  //   the same stat fallback /api/files uses for its listing.
  // - Only inside the tree, and only once per real directory. A link to /etc
  //   would put foreign files into the @ menu, and every one of them is
  //   refused by the allowlist when it is opened; a link that resolves to a
  //   directory that is already in the walk — an ancestor, or `src/self` —
  //   would be re-expanded under a second, third, fourth name.
  const visited = new Set<string>();
  if (rootReal) visited.add(rootReal);

  while (queue.length > 0) {
    const { abs, rel, depth, real } = queue.shift()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (IGNORED_NAMES.has(d.name) || IGNORED_SUFFIXES.some((s) => d.name.endsWith(s))) continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      const childAbs = path.join(abs, d.name);
      if (d.isDirectory()) {
        if (depth + 1 <= MAX_WALK_DEPTH) {
          const childReal = real ? path.join(real, d.name) : realpathOrNull(childAbs);
          if (childReal) visited.add(childReal);
          queue.push({ abs: childAbs, rel: childRel, depth: depth + 1, real: childReal });
        }
      } else if (d.isFile()) {
        if (files.length >= WALK_HARD_CAP) {
          return { files, hardTruncated: true };
        }
        files.push(childRel);
      } else if (d.isSymbolicLink()) {
        if (depth + 1 > MAX_WALK_DEPTH) continue;
        const isDir = resolveDirentIsDirectory(d, childAbs);
        if (isDir === null) continue; // broken link, or gone between readdir and stat
        if (!isDir) {
          // Dieselbe Grenze wie im Ordnerzweig unten: ein Link zeigt nur dann in
          // den Index, wenn sein Ziel innerhalb der Wurzel liegt. Ein Link auf
          // /etc/passwd wuerde die Datei sonst im @-Menue und in der Suche
          // anzeigen, obwohl das Oeffnen an der Allowlist scheitert — der
          // Eintrag verraten Existenz und Verzeichnis fremder Dateien und ist
          // keiner zu bedienen. Innerhalb der Wurzel bleibt ein verlinkter
          // Inhalt natuerlich drin.
          const fileReal = realpathOrNull(childAbs);
          if (!fileReal) continue;
          if (rootReal && !isPathWithinRoots(fileReal, new Set([rootReal]))) continue;
          if (files.length >= WALK_HARD_CAP) {
            return { files, hardTruncated: true };
          }
          files.push(childRel);
          continue;
        }
        const realChild = realpathOrNull(childAbs);
        if (!realChild || visited.has(realChild)) continue;
        if (rootReal && !isPathWithinRoots(realChild, new Set([rootReal]))) continue;
        visited.add(realChild);
        queue.push({ abs: childAbs, rel: childRel, depth: depth + 1, real: realChild });
      }
    }
  }
  return { files, hardTruncated: false };
}

// GET /api/file-index?cwd=/abs/path[&q=query]
// Without q: { files: string[] (relative to cwd, capped at MAX_FILES),
// truncated: boolean } — the client-side index for local filtering.
// With q: { matches: { path, isDir }[] } — ranked against the FULL listing so
// repos larger than MAX_FILES still find deep files (cap applied after
// matching, like the TUI passing the query to fd).
// Guarded by the same allow-list as /api/files.
export async function GET(req: NextRequest) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const cwd = req.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }
    const query = req.nextUrl.searchParams.get("q")?.slice(0, MAX_QUERY_LENGTH) ?? "";

    const allowedRoots = await getAllowedFileRoots(getRequestIdentity(req.headers));
    if (!isFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return NextResponse.json({ error: "Directory not found" }, { status: 404 });
    }
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "Not a directory" }, { status: 400 });
    }
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const cache = getIndexCache();
    const now = Date.now();
    let cached = cache.get(cwd);
    if (!cached || cached.expiresAt <= now) {
      const listing = (await listWithGit(cwd)) ?? listWithWalk(cwd);
      for (const [key, entry] of cache) {
        if (entry.expiresAt <= now) cache.delete(key);
      }
      if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
      cached = { listing, expiresAt: now + CACHE_TTL_MS };
      cache.set(cwd, cached);
    }

    if (query) {
      cached.entries ??= buildEntriesFromFiles(cached.listing.files);
      return NextResponse.json({ matches: filterFileEntries(cached.entries, query) });
    }

    const { files, hardTruncated } = cached.listing;
    return NextResponse.json({
      files: files.slice(0, MAX_FILES),
      truncated: hardTruncated || files.length > MAX_FILES,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
