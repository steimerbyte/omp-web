import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createJiti } from "jiti";

/**
 * `OMP_WEB_HOME_ROOT` entscheidet, wo `getUserHome()` nachsieht — dieselbe
 * Vorbemerkung wie in `lib/calendar-store.test.mjs`.
 */
const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-newsletter-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const jiti = createJiti(import.meta.url);
const {
  getNewsletterPath,
  isNewsletterPathAllowed,
  readNewsletterFile,
  writeNewsletterFile,
} = await jiti.import("./newsletter-store.ts");

const ALICE = { username: "alice", isAdmin: false };
const BOB = { username: "bob", isAdmin: false };

/**
 * Legt das Heimatverzeichnis eines Kontos an und gibt es zurueck.
 *
 * Der Ordner wird angelegt, weil `resolveTenantAgentDir` fuer einen Mieter
 * `<home>/.omp/agent` bildet und der Speicher dieses Verzeichnis beim
 * Schreiben selbst erzeugt — der *Heimatordner* selbst muss aber schon da
 * sein, sonst schlaegt genau dieses Anlegen fehl.
 */
function createAccount(username) {
  const home = join(HOME_ROOT, username);
  mkdirSync(home, { recursive: true });
  return { home, identity: { username, isAdmin: false } };
}

function issue(overrides = {}) {
  return {
    id: "issue-1",
    generatedAt: "2026-11-17T06:00:00.000Z",
    title: "Die Woche",
    sections: [{
      topic: "KI-Regulierung",
      items: [{ title: "Meldung", url: "https://example.org/meldung" }],
    }],
    ...overrides,
  };
}

function newsletter(overrides = {}) {
  return {
    id: "nl-1",
    name: "Wochenblick",
    topics: ["KI-Regulierung", "Klimapolitik"],
    provider: "buds-gateway",
    modelId: "qwen3.8-27b",
    taskId: "task-1",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    issues: [issue()],
    ...overrides,
  };
}

// --- Pfad und Mandantengrenze ------------------------------------------------

test("the newsletter file of two accounts is two different files", () => {
  assert.notEqual(getNewsletterPath(ALICE), getNewsletterPath(BOB));
});

test("the newsletter file carries the omp-web prefix and lives in the agent dir", () => {
  // Das Praefix sagt beim Lesen im Verzeichnis: die Datei gehoert *nicht*
  // omp und darf von dort nie gelesen oder ueberschrieben werden.
  assert.match(getNewsletterPath(ALICE), /omp-web-newsletters\.json$/);
  assert.match(getNewsletterPath(ALICE), /\.omp[/\\]agent/);
});

test("the path of a foreign home is refused", () => {
  const alicePath = getNewsletterPath(ALICE);
  assert.equal(isNewsletterPathAllowed(ALICE, alicePath), true);
  assert.equal(isNewsletterPathAllowed(BOB, alicePath), false);
});

test("a path outside the home is refused even for the owner", () => {
  assert.equal(isNewsletterPathAllowed(ALICE, "/etc/passwd"), false);
});

// --- Lesen und Schreiben ------------------------------------------------------

test("an account without newsletters has no file yet", () => {
  const { home, identity } = createAccount("neu");
  try {
    const { exists, newsletters } = readNewsletterFile(identity);
    assert.equal(exists, false);
    assert.deepEqual(newsletters, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a written newsletter comes back unchanged", () => {
  const { home, identity } = createAccount("schreiber");
  try {
    const written = writeNewsletterFile(identity, [newsletter()]);
    assert.equal(written.length, 1);
    const { exists, newsletters } = readNewsletterFile(identity);
    assert.equal(exists, true);
    assert.equal(newsletters[0].name, "Wochenblick");
    assert.deepEqual(newsletters[0].topics, ["KI-Regulierung", "Klimapolitik"]);
    assert.equal(newsletters[0].issues[0].sections[0].items[0].url, "https://example.org/meldung");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("one account's newsletters are not in another account's file", () => {
  const alice = createAccount("alice2");
  const bob = createAccount("bob2");
  try {
    writeNewsletterFile(alice.identity, [newsletter({ name: "Alices Blick" })]);
    const bobFile = readNewsletterFile(bob.identity);
    assert.equal(bobFile.exists, false);
    assert.deepEqual(bobFile.newsletters, []);
  } finally {
    rmSync(alice.home, { recursive: true, force: true });
    rmSync(bob.home, { recursive: true, force: true });
  }
});

test("the file is written privately and atomically", () => {
  const { home, identity } = createAccount("rechte");
  try {
    writeNewsletterFile(identity, [newsletter()]);
    const path = getNewsletterPath(identity);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    // Keine Temp-Datei darf liegen bleiben: sie waere ein zweiter Stand,
    // aus dem niemand liest — und den ein fremder Prozess lesen koennte.
    const dir = path.slice(0, path.lastIndexOf("/"));
    const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("unreadable content counts as existing but empty", () => {
  const { home, identity } = createAccount("kaputt");
  try {
    const path = getNewsletterPath(identity);
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(path, "{kein json");
    const { exists, newsletters } = readNewsletterFile(identity);
    assert.equal(exists, true);
    assert.deepEqual(newsletters, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a bare list is read like the wrapped form", () => {
  const { home, identity } = createAccount("nackt");
  try {
    const path = getNewsletterPath(identity);
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(path, JSON.stringify([newsletter()]));
    assert.equal(readNewsletterFile(identity).newsletters.length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- Validierung ---------------------------------------------------------------

test("a newsletter without topics is not stored", () => {
  const { home, identity } = createAccount("ohne-themen");
  try {
    const written = writeNewsletterFile(identity, [newsletter({ topics: [] })]);
    assert.deepEqual(written, []);
    assert.deepEqual(readNewsletterFile(identity).newsletters, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a hand-written file with a broken row keeps the good ones", () => {
  const { home, identity } = createAccount("gemischt");
  try {
    const path = getNewsletterPath(identity);
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(path, JSON.stringify({ newsletters: [newsletter({ id: "gut" }), { kaputt: true }] }));
    assert.deepEqual(readNewsletterFile(identity).newsletters.map((entry) => entry.id), ["gut"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the store cuts the issues of a newsletter to the kept limit", () => {
  const { home, identity } = createAccount("kappung");
  try {
    const issues = Array.from({ length: 25 }, (_, index) => issue({ id: `issue-${index}` }));
    const written = writeNewsletterFile(identity, [newsletter({ issues })]);
    assert.equal(written[0].issues.length, 20);
    assert.equal(written[0].issues[0].id, "issue-0");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
