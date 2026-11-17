import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createJiti } from "jiti";

/**
 * `OMP_WEB_HOME_ROOT` entscheidet, wo `getUserHome()` nachsieht — dieselbe
 * Vorbemerkung wie in `lib/calendar-tool.test.mjs`.
 */
const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-newsletter-tool-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const jiti = createJiti(import.meta.url, { root: process.cwd() });
const { makeNewsletterTools } = await jiti.import("./newsletter-tool.ts");
const { readNewsletterFile, writeNewsletterFile } = await jiti.import("./newsletter-store.ts");

let accountCounter = 0;

/**
 * Legt ein eigenes Konto an und gibt seine Identitaet zurueck.
 *
 * Jedes Test bekommt ein eigenes Konto, weil die Newsletter pro Konto in einer
 * eigenen Datei liegen: ein gemeinsames Konto wuerde die Ausgaben der
 * vorherigen Tests erben.
 */
function createIdentity(label) {
  const username = `${label}-${accountCounter++}`;
  mkdirSync(join(HOME_ROOT, username), { recursive: true });
  return { username, isAdmin: false };
}

/** Ruft ein Werkzeug auf und gibt seinen Text zurueck. */
async function callTool(tool, params) {
  const result = await tool.execute("call-1", params, undefined, undefined, { cwd: HOME_ROOT });
  return result.content.map((part) => part.text ?? "").join("\n");
}

/** Ein gespeicherter Newsletter, wie ihn die Route anlegen wuerde. */
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
    issues: [],
    ...overrides,
  };
}

function issue(overrides = {}) {
  return {
    id: "issue-1",
    generatedAt: "2026-11-10T06:00:00.000Z",
    title: "Die Woche",
    intro: "Kurz und knapp.",
    sections: [{
      topic: "KI-Regulierung",
      headline: "Brüssel bewegt sich",
      items: [{ title: "Einigung im Trilog", url: "https://example.org/trilog" }],
    }],
    ...overrides,
  };
}

/** Die Argumente fuer einen brauchbaren newsletter_write. */
function writeParams(overrides = {}) {
  return {
    newsletterId: "nl-1",
    title: "Neue Ausgabe",
    intro: "Was diese Woche wichtig war.",
    sections: [{
      topic: "KI-Regulierung",
      headline: "Einigung",
      items: [{ title: "Meldung", summary: "Zusammenfassung", url: "https://example.org/meldung" }],
    }],
    ...overrides,
  };
}

// --- Die Werkzeuge existieren und tragen die richtigen Namen -------------------

test("the newsletter ships a read tool and a write tool", () => {
  const tools = makeNewsletterTools({ identity: createIdentity("namen") });
  assert.deepEqual(tools.map((tool) => tool.name), ["newsletter_read", "newsletter_write"]);
});

test("the tools are marked as tool definitions", () => {
  // Ohne den `defineTool`-Marker bridged das SDK den Eintrag mit einer anderen
  // Argumentreihenfolge — die Falle steht in `lib/present-files-tool.ts`.
  const tools = makeNewsletterTools({ identity: createIdentity("marker") });
  for (const tool of tools) {
    assert.equal(tool.__isToolDefinition, true, `${tool.name} ist nicht als Werkzeugdefinition markiert`);
  }
});

test("the read tool is read-only and the write tool mutates", () => {
  const tools = makeNewsletterTools({ identity: createIdentity("freigabe") });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.newsletter_read.approval, "read");
  assert.equal(byName.newsletter_write.approval, "write");
});

test("the tools stay in the top-level schema", () => {
  const tools = makeNewsletterTools({ identity: createIdentity("stufe") });
  for (const tool of tools) {
    assert.equal(tool.loadMode, "essential");
  }
});

// --- Lesen ---------------------------------------------------------------------

test("reading without newsletters says so", async () => {
  const [read] = makeNewsletterTools({ identity: createIdentity("leer") });
  assert.match(await callTool(read, {}), /noch keinen Newsletter/);
});

test("reading lists every newsletter with its id, name and topics", async () => {
  const identity = createIdentity("liste");
  writeNewsletterFile(identity, [newsletter({ issues: [issue()] })]);
  const [read] = makeNewsletterTools({ identity });

  const text = await callTool(read, {});
  assert.match(text, /nl-1/);
  assert.match(text, /Wochenblick/);
  assert.match(text, /KI-Regulierung, Klimapolitik/);
  assert.match(text, /1 Ausgabe/);
  assert.match(text, /10\.11\.2026/);
});

test("reading one newsletter names the newest issue and what was already published", async () => {
  const identity = createIdentity("ausgabe");
  writeNewsletterFile(identity, [newsletter({ issues: [issue({ id: "neu" })] })]);
  const [read] = makeNewsletterTools({ identity });

  const text = await callTool(read, { newsletterId: "nl-1" });
  assert.match(text, /Neueste Ausgabe vom 10\.11\.2026/);
  assert.match(text, /Die Woche/);
  assert.match(text, /bereits erschienen/);
  assert.match(text, /Einigung im Trilog/);
  assert.match(text, /https:\/\/example\.org\/trilog/);
});

test("reading a newsletter without an issue says so", async () => {
  const identity = createIdentity("ohne-ausgabe");
  writeNewsletterFile(identity, [newsletter()]);
  const [read] = makeNewsletterTools({ identity });
  assert.match(await callTool(read, { newsletterId: "nl-1" }), /Noch keine Ausgabe/);
});

test("reading an unknown id is an error that names the valid ids", async () => {
  const identity = createIdentity("unbekannt");
  writeNewsletterFile(identity, [newsletter()]);
  const [read] = makeNewsletterTools({ identity });
  await assert.rejects(
    () => callTool(read, { newsletterId: "gibt-es-nicht" }),
    /Valid ids: nl-1/,
  );
});

// --- Schreiben -----------------------------------------------------------------

test("a written issue is prepended and comes back through the store", async () => {
  const identity = createIdentity("schreiben");
  writeNewsletterFile(identity, [newsletter({ issues: [issue({ id: "alt", generatedAt: "2026-11-03T06:00:00.000Z" })] })]);
  const [, write] = makeNewsletterTools({ identity });

  const text = await callTool(write, writeParams());
  assert.match(text, /Newsletter-Ausgabe gespeichert/);
  assert.match(text, /1 Abschnitt, 1 Beitrag/);

  const { newsletters } = readNewsletterFile(identity);
  assert.equal(newsletters[0].issues.length, 2);
  assert.equal(newsletters[0].issues[0].title, "Neue Ausgabe");
  assert.equal(newsletters[0].issues[0].sections[0].items[0].url, "https://example.org/meldung");
  assert.equal(newsletters[0].issues[1].id, "alt");
  assert.equal(newsletters[0].updatedAt, newsletters[0].issues[0].generatedAt);
});

test("writing to an unknown newsletter is refused and lists the valid ids", async () => {
  const identity = createIdentity("fremd");
  writeNewsletterFile(identity, [newsletter()]);
  const [, write] = makeNewsletterTools({ identity });
  await assert.rejects(
    () => callTool(write, writeParams({ newsletterId: "keins" })),
    /Valid ids: nl-1/,
  );
  assert.equal(readNewsletterFile(identity).newsletters[0].issues.length, 0);
});

test("an issue without sections is refused", async () => {
  const identity = createIdentity("ohne-abschnitt");
  writeNewsletterFile(identity, [newsletter()]);
  const [, write] = makeNewsletterTools({ identity });
  await assert.rejects(() => callTool(write, writeParams({ sections: [] })), /at least one section/);
});

test("a section without items is refused and names the topic", async () => {
  const identity = createIdentity("leerer-abschnitt");
  writeNewsletterFile(identity, [newsletter()]);
  const [, write] = makeNewsletterTools({ identity });
  await assert.rejects(
    () => callTool(write, writeParams({ sections: [{ topic: "Klimapolitik", items: [] }] })),
    /'Klimapolitik' has no items/,
  );
});

test("an issue whose every item is broken is refused", async () => {
  const identity = createIdentity("kaputt");
  writeNewsletterFile(identity, [newsletter()]);
  const [, write] = makeNewsletterTools({ identity });
  await assert.rejects(
    () => callTool(write, writeParams({
      sections: [{ topic: "KI-Regulierung", items: [{ title: " ", url: "https://example.org/a" }] }],
    })),
    /Write nothing rather than a placeholder issue/,
  );
});

test("over-long values are dropped by the store, not truncated", async () => {
  const identity = createIdentity("grenzen");
  writeNewsletterFile(identity, [newsletter()]);
  const [, write] = makeNewsletterTools({ identity });

  const text = await callTool(write, writeParams({
    title: "x".repeat(201),
    sections: [
      {
        topic: "KI-Regulierung",
        items: [
          { title: "Zu lang", summary: "x".repeat(401), url: "https://example.org/a" },
          { title: "x".repeat(201), url: "https://example.org/b" },
        ],
      },
      { topic: "Klimapolitik", items: [{ title: "Gueltig", url: "https://example.org/c" }] },
    ],
  }));
  assert.match(text, /2 Abschnitte, 2 Beiträge/);

  const stored = readNewsletterFile(identity).newsletters[0].issues[0];
  assert.equal(stored.title, undefined);
  assert.equal(stored.sections[0].items.length, 1);
  assert.equal(stored.sections[0].items[0].summary, undefined);
});

test("a section that survives nothing is dropped and the answer says so", async () => {
  const identity = createIdentity("weggefallen");
  writeNewsletterFile(identity, [newsletter()]);
  const [, write] = makeNewsletterTools({ identity });

  const text = await callTool(write, writeParams({
    sections: [
      { topic: "KI-Regulierung", items: [{ title: "Meldung", url: "https://example.org/a" }] },
      { topic: "Klimapolitik", items: [{ title: "x".repeat(201), url: "https://example.org/b" }] },
    ],
  }));
  assert.match(text, /1 Abschnitt, 1 Beitrag/);
  assert.match(text, /1 Abschnitt wurde nicht uebernommen \(leer, ungueltig oder ueber der Grenze von 12\)/);
});

test("the archive keeps at most twenty issues and drops the oldest", async () => {
  const identity = createIdentity("archiv");
  const issues = Array.from({ length: 20 }, (_, index) => issue({ id: `alt-${index}`, generatedAt: "2026-10-01T06:00:00.000Z" }));
  writeNewsletterFile(identity, [newsletter({ issues })]);
  const [, write] = makeNewsletterTools({ identity });

  await callTool(write, writeParams());
  const { issues: kept } = readNewsletterFile(identity).newsletters[0];
  assert.equal(kept.length, 20);
  assert.equal(kept[0].title, "Neue Ausgabe");
  assert.equal(kept[19].id, "alt-18");
});

test("more sections and items than the limits are cut", async () => {
  const identity = createIdentity("kappung");
  writeNewsletterFile(identity, [newsletter()]);
  const [, write] = makeNewsletterTools({ identity });

  const sections = Array.from({ length: 13 }, (_, index) => ({
    topic: `Thema ${index}`,
    items: Array.from({ length: 12 }, (_, itemIndex) => ({ title: `Meldung ${itemIndex}`, url: "https://example.org/x" })),
  }));
  await callTool(write, writeParams({ sections }));

  const stored = readNewsletterFile(identity).newsletters[0].issues[0];
  assert.equal(stored.sections.length, 12);
  assert.equal(stored.sections[0].items.length, 10);
});

// --- Ohne Identitaet -------------------------------------------------------------

test("a session without an account cannot use the tools", async () => {
  const [read, write] = makeNewsletterTools({});
  await assert.rejects(() => callTool(read, {}), /signed-in account/);
  await assert.rejects(() => callTool(write, writeParams()), /signed-in account/);
});

// Der Temp-Baum bleibt fuer die Dauer der Datei liegen; `OMP_WEB_HOME_ROOT`
// zeigt fuer den ganzen Prozess darauf.
test.after(() => {
  rmSync(HOME_ROOT, { recursive: true, force: true });
});
