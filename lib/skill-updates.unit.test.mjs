import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./skill-updates.ts");
}

/**
 * Der Rueckfallweg der Update-Pruefung: git statt GitHub-API.
 *
 * Die API antwortet 401/403/429, wenn ihr Kontingent aufgebraucht ist — genau
 * dann ist der Baum-Hash per `git fetch` die zweite Quelle. Der Pfad laeuft
 * ohne Netz, weil git `url.<base>.insteadOf` kennt: ein lokales Repository
 * gibt sich als `github.com` aus, und `--depth=1 --filter=blob:none` holt
 * trotzdem nur den einen Commit. Das prueft den echten Ablauf (`init --bare`,
 * `fetch`, `rev-parse`), nicht eine Attrappe davon.
 *
 * `HOME` zeigt fuer die Dauer des Tests auf ein Verzeichnis mit der
 * `insteadOf`-Regel; `childEnv()` reicht `HOME` an `git` weiter, deshalb sieht
 * das Kind die Regel und die echte `~/.gitconfig` nicht.
 */
function withGitInsteadOf(run) {
  const root = mkdtempSync(join(tmpdir(), "omp-skill-update-"));
  const home = join(root, "home");
  const seed = join(root, "seed");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(seed, "skills", "foo"), { recursive: true });

  const git = (...args) => execFileSync("git", ["-C", seed, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });

  git("init", "--quiet", "--initial-branch=main");
  writeFileSync(join(seed, "skills", "foo", "SKILL.md"), "---\nname: foo\n---\n\nAnweisung.\n");
  git("add", "--all");
  git("commit", "--quiet", "-m", "init");
  git("config", "uploadpack.allowFilter", "true");

  writeFileSync(
    join(home, ".gitconfig"),
    `[url "file://${join(seed, ".git")}"]\n\tinsteadOf = https://github.com/test-owner/test-repo.git\n`,
  );

  const previousHome = process.env.HOME;
  process.env.HOME = home;

  return {
    treeHash: git("rev-parse", "HEAD:skills/foo").trim(),
    run: async () => {
      try {
        return await run({ home, seed });
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

function install(overrides = {}) {
  return {
    package: "test-owner/test-repo@foo",
    scope: "global",
    source: "test-owner/test-repo",
    skillPath: "skills/foo/SKILL.md",
    versionHash: "0".repeat(40),
    canCheckForUpdates: true,
    ...overrides,
  };
}

const rateLimited = async () => new Response("{}", { status: 429 });

test("a rate-limited API falls back to the tree hash of the repository", async () => {
  const { checkSkillUpdate } = await loadSubject();
  const env = withGitInsteadOf(async () => {
    const result = await checkSkillUpdate(install(), { fetcher: rateLimited });

    assert.equal(result.state, "update-available");
    assert.equal(result.latestVersion, env.treeHash, "der Hash ist der Baum des Skill-Ordners");
    assert.equal(result.currentVersion, "0".repeat(40));
  });

  await env.run();
});

test("an up-to-date skill is recognised by the same hash", async () => {
  const { checkSkillUpdate } = await loadSubject();
  const env = withGitInsteadOf(async () => {
    const result = await checkSkillUpdate(install({ versionHash: env.treeHash }), { fetcher: rateLimited });

    assert.equal(result.state, "up-to-date");
  });

  await env.run();
});

test("any other API failure is not retried through git", async () => {
  const { checkSkillUpdate } = await loadSubject();
  let fetches = 0;
  const serverError = async () => {
    fetches += 1;
    return new Response("{}", { status: 500 });
  };

  // Ohne `HOME`-Umbau: dieser Pfad darf git gar nicht erst starten.
  const result = await checkSkillUpdate(install(), { fetcher: serverError });

  assert.equal(result.state, "error");
  assert.equal(fetches, 1);
  assert.match(result.message, /HTTP 500/);
});
