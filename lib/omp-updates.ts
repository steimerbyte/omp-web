import type {
  OmpWebInstallPlan,
  OmpWebReleaseInfo,
  OmpWebUpdateResponse,
} from "@/lib/api-types";

/**
 * The distribution of this fork is a GitHub release in this repository.
 *
 * The npm package `omp-web` belongs to the upstream line and is a different
 * build: the npm publish workflow is disabled here (`docs/release.md`), so
 * neither the version comparison nor an install may use it. The release API
 * below and every link that leaves this server therefore point at this
 * repository and nowhere else.
 */
export const OMP_WEB_RELEASE_REPO = "steimerbyte/omp-web";
export const OMP_WEB_GITHUB_RELEASE_API_URL = `https://api.github.com/repos/${OMP_WEB_RELEASE_REPO}/releases/latest`;
export const OMP_WEB_RELEASE_PAGE_URL = `https://github.com/${OMP_WEB_RELEASE_REPO}/releases`;

const RELEASE_CACHE_SECONDS = 60 * 60;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_CHANGELOG_LENGTH = 40_000;

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[] | null;
}

interface GitHubReleasePayload {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
}

interface UpdateStatusOptions {
  currentAppVersion?: string;
  fetcher?: Fetcher;
  env?: NodeJS.ProcessEnv;
}

function parseVersion(value: unknown): ParsedVersion | null {
  const normalized = String(value ?? "").trim().replace(/^[^0-9]*/, "");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(normalized);
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : null,
  };
}

function canonicalVersion(value: unknown): string | null {
  const parsed = parseVersion(value);
  if (!parsed) return null;
  const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return parsed.prerelease ? `${core}-${parsed.prerelease.join(".")}` : core;
}

/** Compare SemVer-like values without throwing on malformed upstream data. */
export function compareVersions(left: unknown, right: unknown): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;

  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }

  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const leftNumber = Number(leftPart);
      const rightNumber = Number(rightPart);
      if (leftNumber !== rightNumber) return leftNumber > rightNumber ? 1 : -1;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function isNewerVersion(latest: string | null, current: string | null): boolean {
  return Boolean(latest && current && compareVersions(latest, current) > 0);
}

/**
 * The release of this repository, as the API reports it.
 *
 * A link that leaves this server points at this repository. The `html_url` of
 * the payload is used only when it says so itself; anything else — a foreign
 * repository, a redirect, a missing field — is replaced by the release page of
 * this repository, so no upstream link can travel to the browser.
 */
function releaseFromPayload(payload: GitHubReleasePayload): OmpWebReleaseInfo {
  const version = canonicalVersion(payload.tag_name);
  if (!version) throw new Error("The omp-web release did not contain a valid version tag");

  const tagName = typeof payload.tag_name === "string" && payload.tag_name.trim()
    ? payload.tag_name.trim()
    : `v${version}`;
  const htmlUrl = typeof payload.html_url === "string" && payload.html_url.startsWith(`https://github.com/${OMP_WEB_RELEASE_REPO}/`)
    ? payload.html_url
    : `${OMP_WEB_RELEASE_PAGE_URL}/tag/${encodeURIComponent(tagName)}`;
  const body = typeof payload.body === "string" ? payload.body.slice(0, MAX_CHANGELOG_LENGTH) : "";

  return {
    version,
    tagName,
    name: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : tagName,
    body,
    htmlUrl,
    publishedAt: typeof payload.published_at === "string" ? payload.published_at : null,
  };
}

async function fetchJson(url: string, fetcher: Fetcher): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "omp-web-update-check",
      },
      signal: controller.signal,
      // Next.js caches this server-side request so every browser tab does not
      // consume a GitHub API request. The injected fetcher in tests ignores it.
      next: { revalidate: RELEASE_CACHE_SECONDS },
    } as RequestInit & { next: { revalidate: number } });
    if (!response.ok) throw new Error(`Update source returned HTTP ${response.status}`);
    return await response.json() as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The plan for getting a newer version onto this host.
 *
 * This distribution is published as a GitHub release and its releases carry
 * no server artifact that a route could install, so there is no automatic
 * install: the plan names the reason and leaves the update to the operator,
 * who takes it from the release of this repository.
 */
export function buildInstallPlan({
  currentAppVersion,
  updateAvailable,
  env = process.env,
}: {
  currentAppVersion: string | null;
  updateAvailable: boolean;
  env?: NodeJS.ProcessEnv;
}): OmpWebInstallPlan {
  let reason: OmpWebInstallPlan["reason"];
  if (env.OMP_WEB_DISABLE_SELF_UPDATE === "1") reason = "disabled";
  else if (!currentAppVersion) reason = "current-version-unknown";
  else if (updateAvailable) reason = "manual";

  return {
    canInstall: false,
    reason,
    restartRequired: true,
  };
}

export async function getOmpWebUpdateStatus(options: UpdateStatusOptions = {}): Promise<OmpWebUpdateResponse> {
  const fetcher = options.fetcher ?? fetch;
  const currentVersion = canonicalVersion(options.currentAppVersion ?? process.env.NEXT_PUBLIC_APP_VERSION);
  const currentAppVersion = currentVersion ?? "unknown";

  const releasePayload = await fetchJson(OMP_WEB_GITHUB_RELEASE_API_URL, fetcher) as GitHubReleasePayload;
  const latestRelease = releaseFromPayload(releasePayload);

  const updateAvailable = isNewerVersion(latestRelease.version, currentVersion);
  const install = buildInstallPlan({
    currentAppVersion: currentVersion,
    updateAvailable,
    env: options.env,
  });
  const availability: OmpWebUpdateResponse["availability"] = !currentVersion
    ? "unknown"
    : !updateAvailable
      ? "up-to-date"
      : "manual";

  return {
    currentAppVersion,
    latestRelease,
    updateAvailable,
    availability,
    install,
    checkedAt: new Date().toISOString(),
  };
}
