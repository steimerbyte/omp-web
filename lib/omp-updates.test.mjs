import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";

/**
 * The update check of this distribution.
 *
 * This fork is published as a GitHub release in `steimerbyte/omp-web`. The npm
 * package `omp-web` belongs to the upstream line and is a different build, so
 * the check must never compare against it and must never offer an install of
 * it. The tests below pin that: they fail against the old code, which asked
 * the npm registry for the version and offered `npm install --global
 * omp-web@latest` as the way to update.
 *
 * The release link is checked against the payload's own `html_url` as well:
 * a payload that names another repository must not put that link in front of
 * the browser.
 */

const jiti = createJiti(import.meta.url);
const {
  OMP_WEB_GITHUB_RELEASE_API_URL,
  OMP_WEB_RELEASE_REPO,
  buildInstallPlan,
  compareVersions,
  getOmpWebUpdateStatus,
} = await jiti.import("./omp-updates.ts");

const OUR_RELEASE_API = "https://api.github.com/repos/steimerbyte/omp-web/releases/latest";

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A fetcher that answers the release API of this repository and records every
 * URL it was asked for. A URL it does not know answers 503 rather than a
 * plausible payload, so a second source cannot slip in unnoticed.
 */
function fetcher({ release, requested }) {
  return async (url) => {
    requested.push(url);
    if (url === OUR_RELEASE_API) {
      return release === null ? response({}, 503) : response(release);
    }
    return response({}, 503);
  };
}

const release = {
  tag_name: "v0.12.0",
  name: "v0.12.0",
  body: "## Fixed\n\n- A release fix",
  html_url: "https://github.com/steimerbyte/omp-web/releases/tag/v0.12.0",
  published_at: "2026-10-12T01:32:09Z",
};

test("compares release versions with prerelease ordering", () => {
  assert.equal(compareVersions("v0.1.8", "0.1.7"), 1);
  assert.equal(compareVersions("0.1.8-rc.1", "0.1.8"), -1);
  assert.equal(compareVersions("0.1.8+build.2", "0.1.8+build.1"), 0);
  assert.equal(compareVersions("not-a-version", "0.1.8"), 0);
});

test("the status check asks this repository's release API and nothing else", async () => {
  // The URL is the whole claim of this distribution: the version comes from
  // the releases of THIS repo. A second source — the npm registry of the
  // upstream package — would make a foreign version line the source of truth.
  const requested = [];
  await getOmpWebUpdateStatus({
    currentAppVersion: "0.11.0",
    fetcher: fetcher({ release, requested }),
  });

  assert.deepEqual(requested, [OUR_RELEASE_API]);
  assert.equal(OMP_WEB_GITHUB_RELEASE_API_URL, OUR_RELEASE_API);
  assert.equal(OMP_WEB_RELEASE_REPO, "steimerbyte/omp-web");
});

test("a release of this repository is reported with its changelog", async () => {
  const status = await getOmpWebUpdateStatus({
    currentAppVersion: "0.11.0",
    fetcher: fetcher({ release, requested: [] }),
  });

  assert.equal(status.updateAvailable, true);
  assert.equal(status.availability, "manual");
  assert.equal(status.currentAppVersion, "0.11.0");
  assert.equal(status.latestRelease.version, "0.12.0");
  assert.equal(status.latestRelease.body, release.body);
});

test("a release of this repository is advertised even though nothing is published to npm", async () => {
  // The old code hid a GitHub release until the npm registry had the same
  // version, so a release of this repository was invisible until it was also
  // published as the upstream package — which this distribution never does.
  const requested = [];
  const status = await getOmpWebUpdateStatus({
    currentAppVersion: "0.11.0",
    fetcher: fetcher({ release, requested }),
  });

  assert.equal(status.updateAvailable, true);
  assert.equal(status.latestRelease.version, "0.12.0");
  assert.deepEqual(requested, [OUR_RELEASE_API], "no npm publication may gate it");
});

test("a release that is not newer than the running version is no update", async () => {
  const status = await getOmpWebUpdateStatus({
    currentAppVersion: "0.12.0",
    fetcher: fetcher({ release, requested: [] }),
  });

  assert.equal(status.updateAvailable, false);
  assert.equal(status.availability, "up-to-date");
  assert.equal(status.latestRelease.version, "0.12.0");
});

test("an unparseable running version is reported as unknown, not as up to date", async () => {
  const status = await getOmpWebUpdateStatus({
    currentAppVersion: "not-a-version",
    fetcher: fetcher({ release, requested: [] }),
  });

  assert.equal(status.currentAppVersion, "unknown");
  assert.equal(status.updateAvailable, false);
  assert.equal(status.availability, "unknown");
  assert.equal(status.install.reason, "current-version-unknown");
});

test("the npm registry is never asked, so a foreign package with a higher version changes nothing", async () => {
  // The counterfactual of the old defect: the upstream package sits at a
  // higher version than this fork. If it were consulted, it would either
  // advertise an update to a foreign build or install that build over the
  // running server.
  const requested = [];
  const foreign = {
    version: "9.9.9",
    repository: "ddallabenetta/omp-web",
  };
  const status = await getOmpWebUpdateStatus({
    currentAppVersion: "0.11.0",
    fetcher: async (url) => {
      requested.push(url);
      if (url === OUR_RELEASE_API) return response(release);
      if (url.includes("registry.npmjs.org")) return response(foreign);
      return response({}, 503);
    },
  });

  assert.deepEqual(requested, [OUR_RELEASE_API], "the registry must not be asked");
  assert.equal(status.install.canInstall, false);
  assert.equal(status.latestRelease.version, "0.12.0", "the version is this repository's");
  assert.match(status.latestRelease.htmlUrl, /^https:\/\/github\.com\/steimerbyte\/omp-web\//);
});

test("the release link points at this repository, whatever the payload says", async () => {
  // A payload naming another repository must not put that link in the
  // browser: the release link is the only place the operator can go to get
  // this distribution.
  const status = await getOmpWebUpdateStatus({
    currentAppVersion: "0.11.0",
    fetcher: fetcher({
      release: {
        ...release,
        html_url: "https://github.com/ddallabenetta/omp-web/releases/tag/v0.12.0",
      },
      requested: [],
    }),
  });

  assert.equal(
    status.latestRelease.htmlUrl,
    "https://github.com/steimerbyte/omp-web/releases/tag/v0.12.0",
  );
  assert.doesNotMatch(status.latestRelease.htmlUrl, /ddallabenetta/);
});

test("a release without a link still yields one that points at this repository", async () => {
  const status = await getOmpWebUpdateStatus({
    currentAppVersion: "0.11.0",
    fetcher: fetcher({
      release: { tag_name: "v0.12.0", name: "v0.12.0", body: "" },
      requested: [],
    }),
  });

  assert.equal(
    status.latestRelease.htmlUrl,
    "https://github.com/steimerbyte/omp-web/releases/tag/v0.12.0",
  );
});

test("the install plan never offers an install", () => {
  // There is no installable artifact for this distribution: the releases
  // carry none and the npm package belongs to another build. The plan says so
  // instead of naming a command that would install that build.
  const plan = buildInstallPlan({
    currentAppVersion: "0.11.0",
    updateAvailable: true,
    env: {},
  });

  assert.equal(plan.canInstall, false);
  assert.equal(plan.reason, "manual");
  assert.equal(JSON.stringify(plan).includes("omp-web@latest"), false);
  assert.equal(JSON.stringify(plan).includes("npm install"), false);
  assert.equal(JSON.stringify(plan).includes("bun add"), false);
});

test("self-update can be disabled, and then says so", () => {
  const plan = buildInstallPlan({
    currentAppVersion: "0.11.0",
    updateAvailable: true,
    env: { OMP_WEB_DISABLE_SELF_UPDATE: "1" },
  });

  assert.equal(plan.canInstall, false);
  assert.equal(plan.reason, "disabled");
});

test("an unknown current version is reported as such", () => {
  const plan = buildInstallPlan({
    currentAppVersion: null,
    updateAvailable: false,
    env: {},
  });

  assert.equal(plan.canInstall, false);
  assert.equal(plan.reason, "current-version-unknown");
});

test("the check fails when the release API of this repository is unavailable", async () => {
  // There is no second source to fall back to. Falling back would mean
  // answering with a version of a package this distribution does not ship.
  await assert.rejects(
    () => getOmpWebUpdateStatus({
      currentAppVersion: "0.11.0",
      fetcher: fetcher({ release: null, requested: [] }),
    }),
    /HTTP 503/,
  );
});

test("the module names neither the upstream repository nor the npm registry", async () => {
  // The behaviour tests above pin what the check does. This one pins the
  // source, so a second URL cannot be added without one of them failing:
  // there is no place in this module for a foreign distribution to enter.
  const source = await readFile(new URL("./omp-updates.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /ddallabenetta/);
  assert.doesNotMatch(source, /registry\.npmjs\.org/);
  assert.doesNotMatch(source, /omp-web@latest/);
  assert.doesNotMatch(source, /npm install/);
  assert.doesNotMatch(source, /bun add/);
});
