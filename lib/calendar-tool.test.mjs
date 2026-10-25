import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { root: process.cwd() });

/**
 * `OMP_WEB_HOME_ROOT` entscheidet, wo `getUserHome()` nachsieht — dieselbe
 * Vorbemerkung wie in `lib/calendar-store.test.mjs`.
 */
const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-calendar-tool-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const { makeCalendarTools } = await jiti.import("./calendar-tool.ts");
const { readCalendarFile } = await jiti.import("./calendar-store.ts");

let accountCounter = 0;

/**
 * Legt ein eigenes Konto an und gibt seine Identitaet zurueck.
 *
 * Jedes Test bekommt ein eigenes Konto, weil der Kalender pro Konto in einer
 * eigenen Datei liegt: ein gemeinsames Konto wuerde die Termine der
 * vorherigen Tests erben.
 */
function createIdentity(label) {
  const username = `${label}-${accountCounter++}`;
  mkdirSync(join(HOME_ROOT, username), { recursive: true });
  return { username, isAdmin: false };
}

/** Ruft ein Werkzeug auf und gibt Text und `details` zurueck. */
async function callTool(tool, params) {
  const result = await tool.execute("call-1", params, undefined, undefined, {
    cwd: HOME_ROOT,
  });
  return {
    text: result.content.map((part) => part.text ?? "").join("\n"),
    details: result.details,
  };
}

// --- Die Werkzeuge existieren und tragen die richtigen Namen -------------------

test("the calendar ships a read tool and a write tool", () => {
  const tools = makeCalendarTools({ identity: createIdentity("namen") });
  assert.deepEqual(tools.map((tool) => tool.name), ["calendar_read", "calendar_write"]);
});

test("the tools are marked as tool definitions", () => {
  // Ohne den `defineTool`-Marker behandelt das SDK den Eintrag als
  // `CustomTool` und bridged ihn mit einer *anderen* Argumentreihenfolge fuer
  // `execute` um. Die Falle ist in `lib/present-files-tool.ts` beschrieben.
  const tools = makeCalendarTools({ identity: createIdentity("marker") });
  for (const tool of tools) {
    assert.equal(tool.__isToolDefinition, true, `${tool.name} ist nicht als Werkzeugdefinition markiert`);
  }
});

test("the read tool is read-only and the write tool mutates", () => {
  const tools = makeCalendarTools({ identity: createIdentity("freigabe") });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.calendar_read.approval, "read");
  assert.equal(byName.calendar_write.approval, "write");
});

test("the tools stay in the top-level schema", () => {
  // "discoverable" wuerde sie unter `xd://` mounten und aus dem
  // Top-Level-Schema nehmen — der Agent muesste sie dann ueber einen Umweg
  // aufrufen. Fuer ein Werkzeug, das der Agent von sich aus benutzen soll,
  // ist "essential" die richtige Stufe.
  const tools = makeCalendarTools({ identity: createIdentity("stufe") });
  for (const tool of tools) {
    assert.equal(tool.loadMode, "essential");
  }
});

// --- Lesen ---------------------------------------------------------------------

test("reading an empty calendar says so", async () => {
  const identity = createIdentity("leer");
  const [read] = makeCalendarTools({ identity });
  const { text } = await callTool(read, {});
  assert.match(text, /kein Termin/i);
});

test("reading returns the event with its id", async () => {
  const identity = createIdentity("leser");
  const tools = makeCalendarTools({ identity });
  const [, write] = tools;
  const read = tools[0];

  await callTool(write, {
    action: "create",
    title: "Teammeeting",
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:00",
  });

  const { text } = await callTool(read, {});
  assert.match(text, /Teammeeting/);
  assert.match(text, /14\.03\.2026/);
  // Die Kennung muss mitkommen: ohne sie kann der Agent den Termin nicht
  // wieder aendern oder loeschen.
  const { events } = readCalendarFile(identity);
  assert.match(text, new RegExp(events[0].id));
});

test("reading a range filters the events", async () => {
  const identity = createIdentity("bereich");
  const tools = makeCalendarTools({ identity });
  const read = tools[0];
  const write = tools[1];

  await callTool(write, { action: "create", title: "Maerz", start: "2026-03-14T15:00", end: "2026-03-14T16:00" });
  await callTool(write, { action: "create", title: "April", start: "2026-04-14T15:00", end: "2026-04-14T16:00" });

  const { text } = await callTool(read, { from: "2026-03-01", to: "2026-03-31" });
  assert.match(text, /Maerz/);
  assert.doesNotMatch(text, /April/);
});

test("a malformed range is refused with a usable message", async () => {
  const identity = createIdentity("falscher-bereich");
  const [read] = makeCalendarTools({ identity });
  await assert.rejects(
    () => callTool(read, { from: "letzte Woche" }),
    /YYYY-MM-DD/,
  );
});

// --- Schreiben -------------------------------------------------------------------

test("creating an event puts it in the calendar", async () => {
  const identity = createIdentity("ersteller");
  const [, write] = makeCalendarTools({ identity });
  const { text } = await callTool(write, {
    action: "create",
    title: "Zahnarzt",
    start: "2026-03-14T09:00",
    end: "2026-03-14T10:00",
    location: "Praxis Dr. Weber",
  });

  const { events } = readCalendarFile(identity);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Zahnarzt");
  assert.equal(events[0].location, "Praxis Dr. Weber");
  assert.match(text, /angelegt/i);
});

test("an all-day event is recognized from its date form", async () => {
  const identity = createIdentity("ganztag");
  const [, write] = makeCalendarTools({ identity });
  await callTool(write, {
    action: "create",
    title: "Urlaub",
    start: "2026-03-14",
    end: "2026-03-16",
  });
  const { events } = readCalendarFile(identity);
  assert.equal(events[0].allDay, true);
  // Das Ende ist der letzte Tag, einschliesslich.
  assert.equal(events[0].end, "2026-03-16");
});

test("creating without a title is refused", async () => {
  const identity = createIdentity("ohne-titel");
  const [, write] = makeCalendarTools({ identity });
  await assert.rejects(
    () => callTool(write, { action: "create", start: "2026-03-14T15:00", end: "2026-03-14T16:00" }),
    /Titel/,
  );
});

test("creating with a broken date is refused", async () => {
  const identity = createIdentity("kaputt");
  const [, write] = makeCalendarTools({ identity });
  await assert.rejects(
    () => callTool(write, { action: "create", title: "X", start: "2026-13-45", end: "2026-13-45" }),
    /Datum|Daten/i,
  );
});

test("a date-only start means an all-day event", async () => {
  // Das Werkzeug schliesst den Ganztag-Flag aus der Schreibweise: ein
  // Datum ohne Uhrzeit *ist* ein Ganztagestermin. So muss das Modell nicht
  // beides angeben und kann sich nicht widersprechen.
  const identity = createIdentity("aus-der-form");
  const [, write] = makeCalendarTools({ identity });
  await callTool(write, { action: "create", title: "Konferenz", start: "2026-03-14", end: "2026-03-14" });
  const { events } = readCalendarFile(identity);
  assert.equal(events[0].allDay, true);
});

test("moving an event changes its time and keeps its id", async () => {
  const identity = createIdentity("verschieber");
  const tools = makeCalendarTools({ identity });
  const write = tools[1];

  await callTool(write, { action: "create", title: "Umzug", start: "2026-03-14T15:00", end: "2026-03-14T16:00" });
  const { events } = readCalendarFile(identity);
  const id = events[0].id;

  await callTool(write, {
    action: "update",
    id,
    start: "2026-03-16T10:00",
    end: "2026-03-16T11:00",
  });

  const after = readCalendarFile(identity);
  assert.equal(after.events[0].id, id);
  assert.equal(after.events[0].start, "2026-03-16T10:00");
  assert.equal(after.events[0].title, "Umzug");
});

test("an update without an id is refused with a hint to read first", async () => {
  const identity = createIdentity("ohne-id");
  const [, write] = makeCalendarTools({ identity });
  await assert.rejects(
    () => callTool(write, { action: "update", title: "X" }),
    /calendar_read/,
  );
});

test("an update of an unknown id is refused", async () => {
  const identity = createIdentity("unbekannt");
  const [, write] = makeCalendarTools({ identity });
  await assert.rejects(
    () => callTool(write, { action: "update", id: "gibt-es-nicht", title: "X" }),
    /gibt-es-nicht/,
  );
});

test("deleting an event removes it", async () => {
  const identity = createIdentity("loescher");
  const tools = makeCalendarTools({ identity });
  const write = tools[1];
  await callTool(write, { action: "create", title: "Weg", start: "2026-03-14T15:00", end: "2026-03-14T16:00" });
  const { events } = readCalendarFile(identity);

  await callTool(write, { action: "delete", id: events[0].id });
  assert.equal(readCalendarFile(identity).events.length, 0);
});

// --- Mandantengrenze ---------------------------------------------------------------

test("a tool of one account does not see another account's events", async () => {
  const alice = createIdentity("alice");
  const bob = createIdentity("bob");

  const aliceTools = makeCalendarTools({ identity: alice });
  const bobTools = makeCalendarTools({ identity: bob });

  await callTool(aliceTools[1], {
    action: "create",
    title: "Alices geheimer Termin",
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:00",
  });

  const { text } = await callTool(bobTools[0], {});
  assert.doesNotMatch(text, /geheimer/i);
});

test("a tool without an account refuses to work instead of guessing", async () => {
  // Ohne Konto gibt es keinen Kalender. Das Werkzeug sagt das deutlich, statt
  // in den Kalender des Betreibers zu greifen.
  const tools = makeCalendarTools({ identity: null });
  await assert.rejects(
    () => callTool(tools[0], {}),
    /Konto/,
  );
  await assert.rejects(
    () => callTool(tools[1], { action: "create", title: "X", start: "2026-03-14T15:00", end: "2026-03-14T16:00" }),
    /Konto/,
  );
});

// --- Aufraeumen ---------------------------------------------------------------------

test.after(() => {
  rmSync(HOME_ROOT, { recursive: true, force: true });
});
