import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `POST /api/skills/search` searches skills.sh.
 *
 * The upstream is stubbed with `globalThis.fetch`; the interesting parts are the
 * limit clamp, the install-count formatting/sorting and the shape of a result.
 * The npx fallback is deliberately not exercised — it would run a network tool.
 * The malformed-body case still reaches the parser in the outer catch, which is
 * where `parseSearchOutput` lives.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

process.env.SKILLS_API_URL = "https://skills.example";

const route = await jiti.import("./route.ts");

const realFetch = globalThis.fetch;
const ORIGIN = "http://localhost:30141";

// A stand-in `npx` for the fallback path. The route spawns it only when the
// HTTP search fails; without it that branch would run the real package runner
// against the network.
const BIN_DIR = mkdtempSync(join(tmpdir(), "omp-web-fake-npx-"));
writeFileSync(
  join(BIN_DIR, "npx"),
  [
    "#!/bin/sh",
    "cat <<'OUT'",
    "shadcn/ui@button  1.2K installs",
    "└ https://skills.sh/shadcn/ui/button",
    "acme/probe@thing  7 installs",
    "└ https://skills.sh/acme/probe/thing",
    "OUT",
    "",
  ].join("\n"),
  "utf8",
);
chmodSync(join(BIN_DIR, "npx"), 0o755);

function post(body, contentType = "application/json") {
  return route.POST(
    new Request(`${ORIGIN}/api/skills/search`, {
      method: "POST",
      headers: { "content-type": contentType, host: "localhost:30141", "x-omp-user": "search-alice" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

test.after(() => {
  globalThis.fetch = realFetch;
  delete process.env.SKILLS_API_URL;
  rmSync(BIN_DIR, { recursive: true, force: true });
});

test("ohne JSON ist 415, ohne query oder mit zu langer query 400", async () => {
  assert.equal((await post({ query: "x" }, "text/plain")).status, 415);

  const empty = await post({ query: "   " });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error, "query required");

  const tooLong = await post({ query: "x".repeat(201) });
  assert.equal(tooLong.status, 400);
  assert.match((await tooLong.json()).error, /200 characters/);
});

test("ein fremder Host wird abgewiesen", async () => {
  const response = await route.POST(
    new Request(`${ORIGIN}/api/skills/search`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "evil.example" },
      body: JSON.stringify({ query: "x" }),
    }),
  );
  assert.equal(response.status, 403);
});

test("Treffer werden formatiert, nach Installationen sortiert und begrenzt", async () => {
  let seenUrl = "";
  globalThis.fetch = async (url) => {
    seenUrl = String(url);
    return Response.json({
      skills: [
        { id: "acme/low", name: "low", source: "acme/skills", installs: 12 },
        { id: "acme/high", name: "high", source: "acme/skills", installs: 1_500_000 },
        { id: "acme/mid", name: "mid", source: "acme/skills", installs: 1_200 },
        { id: "acme/nothing", name: "nothing", source: "acme/skills" },
        { id: "", name: "nameless", source: "acme/skills" },
      ],
    });
  };

  const response = await post({ query: "acme", limit: 3 });
  assert.equal(response.status, 200);
  assert.match(seenUrl, /^https:\/\/skills\.example\/api\/search\?q=acme&limit=3$/);

  const { results } = await response.json();
  // `limit` is the upstream's page size; the route itself does not re-truncate.
  assert.deepEqual(results, [
    { package: "acme/skills@high", installs: "1.5M installs", url: "https://skills.example/acme/high" },
    { package: "acme/skills@mid", installs: "1.2K installs", url: "https://skills.example/acme/mid" },
    { package: "acme/skills@low", installs: "12 installs", url: "https://skills.example/acme/low" },
    { package: "acme/skills@nothing", installs: "", url: "https://skills.example/acme/nothing" },
    { package: "acme/skills@nameless", installs: "", url: "" },
  ]);
});

test("ein zu grosses oder unsinniges limit wird geklemmt", async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return Response.json({ skills: [] });
  };

  await post({ query: "probe", limit: 500 });
  await post({ query: "probe", limit: 0 });
  await post({ query: "probe", limit: "nope" });

  assert.match(seen[0], /limit=50$/);
  assert.match(seen[1], /limit=1$/);
  assert.match(seen[2], /limit=50$/);
});

test("faellt der HTTP-Suche aus, wird die npx-Ausgabe geparst", async () => {
  const previousPath = process.env.PATH;
  process.env.PATH = `${BIN_DIR}:${previousPath ?? ""}`;
  globalThis.fetch = async () => {
    throw new Error("skills.sh unreachable");
  };
  try {
    const response = await post({ query: "probe" });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).results, [
      { package: "shadcn/ui@button", installs: "1.2K installs", url: "https://skills.sh/shadcn/ui/button" },
      { package: "acme/probe@thing", installs: "7 installs", url: "https://skills.sh/acme/probe/thing" },
    ]);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    globalThis.fetch = realFetch;
  }
});

test("ein kaputter Body landet im 500-Zweig, statt den Handler zu werfen", async () => {
  const response = await post("{ not json");
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(typeof body.error, "string");
});
