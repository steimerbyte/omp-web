import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getCalendarPath,
  isCalendarPathAllowed,
  normalizeCalendarEvent,
  normalizeCalendarEvents,
  notifyCalendarChange,
  readCalendarFile,
  sortCalendarEvents,
  subscribeCalendarChanges,
  writeCalendarFile,
} = await jiti.import("./calendar-store.ts");

const { resolveEventColor } = await jiti.import("./calendar.ts");

/**
 * `OMP_WEB_HOME_ROOT` entscheidet, wo `getUserHome()` nachsieht. Ohne diesen
 * Wert wandern die Fixture-Pfade mit dem Heimatverzeichnis des Entwicklers,
 * und der Test scheitert an einem Grund, der nichts mit dem Kalender zu tun
 * hat. Dieselbe Vorbemerkung steht in
 * `app/api/agent/agent-session-ownership.test.mjs`.
 *
 * Das Wurzelverzeichnis ist ein Wegwerf-Verzeichnis, weil die Konten hier
 * *ihre* Home darunter bekommen: `getUserHome()` liefert
 * `<root>/<benutzername>`, und genau dort legt der Kalenderspeicher sein
 * `.omp/agent` an. Ohne ein eigenes Wurzelverzeichnis wuerde der Test
 * `/home/<name>` anlegen wollen — im echten Heimatverzeichnis des Rechners.
 */
const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-calendar-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const ALICE = { username: "alice", isAdmin: false };
const BOB = { username: "bob", isAdmin: false };

/**
 * Legt das Heimatverzeichnis eines Kontos an und gibt es zurueck.
 *
 * Der Ordner wird angelegt, weil `resolveTenantAgentDir` fuer einen Mieter
 * `<home>/.omp/agent` bildet und der Speicher dieses Verzeichnis beim
 * Schreiben selbst erzeugt — der *Heimatordner* selbst muss aber schon
 * da sein, sonst schlaegt genau dieses Anlegen fehl.
 */
function createAccount(username) {
  const home = join(HOME_ROOT, username);
  mkdirSync(home, { recursive: true });
  return { home, identity: { username, isAdmin: false } };
}

function event(overrides = {}) {
  return {
    id: "evt-1",
    title: "Teammeeting",
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:00",
    allDay: false,
    createdAt: "2026-03-01T09:00:00.000Z",
    updatedAt: "2026-03-01T09:00:00.000Z",
    ...overrides,
  };
}

// --- Pfad und Mandantengrenze ------------------------------------------------

test("the calendar file of two accounts is two different files", () => {
  assert.notEqual(getCalendarPath(ALICE), getCalendarPath(BOB));
});

test("the calendar file carries the omp-web prefix and lives in the agent dir", () => {
  // Das Praefix sagt beim Lesen im Verzeichnis: die Datei gehoert *nicht*
  // omp und darf von dort nie gelesen oder ueberschrieben werden.
  assert.match(getCalendarPath(ALICE), /omp-web-calendar\.json$/);
  assert.match(getCalendarPath(ALICE), /\.omp[/\\]agent/);
});

test("the path of a foreign home is refused", () => {
  const alicePath = getCalendarPath(ALICE);
  assert.equal(isCalendarPathAllowed(ALICE, alicePath), true);
  // Bobs Konto darf Alices Datei nicht als die eigene anerkennen.
  assert.equal(isCalendarPathAllowed(BOB, alicePath), false);
});

test("a path outside the home is refused even for the owner", () => {
  assert.equal(isCalendarPathAllowed(ALICE, "/etc/passwd"), false);
});

// --- Lesen und Schreiben ------------------------------------------------------

test("an account without a calendar has no file yet", () => {
  const { home, identity } = createAccount("neu");
  try {
    const { exists, events } = readCalendarFile(identity);
    assert.equal(exists, false);
    assert.deepEqual(events, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a written event comes back unchanged", () => {
  const { home, identity } = createAccount("schreiber");
  try {
    const written = writeCalendarFile(identity, [event()]);
    assert.equal(written.length, 1);
    const { exists, events } = readCalendarFile(identity);
    assert.equal(exists, true);
    assert.equal(events[0].title, "Teammeeting");
    assert.equal(events[0].start, "2026-03-14T15:00");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("one account's events are not in another account's calendar", () => {
  const alice = createAccount("alice2");
  const bob = createAccount("bob2");
  try {
    writeCalendarFile(alice.identity, [event({ title: "Alices Termin" })]);
    const bobEvents = readCalendarFile(bob.identity);
    assert.equal(bobEvents.exists, false);
    assert.deepEqual(bobEvents.events, []);
  } finally {
    rmSync(alice.home, { recursive: true, force: true });
    rmSync(bob.home, { recursive: true, force: true });
  }
});

test("the file is written privately and atomically", () => {
  const { home, identity } = createAccount("rechte");
  try {
    writeCalendarFile(identity, [event()]);
    const path = getCalendarPath(identity);
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
    const path = getCalendarPath(identity);
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(path, "{kein json");
    const { exists, events } = readCalendarFile(identity);
    // Die Datei existiert: ein Seed darf jetzt nicht ueber den Bestand laufen.
    assert.equal(exists, true);
    assert.deepEqual(events, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- Validierung ---------------------------------------------------------------

test("an event without a title is not stored", () => {
  assert.equal(normalizeCalendarEvent(event({ title: "   " })), null);
  assert.equal(normalizeCalendarEvent(event({ title: "" })), null);
});

test("an event without a usable date is not stored", () => {
  assert.equal(normalizeCalendarEvent(event({ start: "2026-02-30T15:00" })), null);
  assert.equal(normalizeCalendarEvent(event({ start: "gestern" })), null);
  assert.equal(normalizeCalendarEvent(event({ end: "" })), null);
});

test("an all-day event with a time is not stored, and the other way round", () => {
  // Der Ganztag-Flag und die Form der Werte muessen zusammenpassen: sonst
  // waere der Termin in der einen Ansicht ein Block und in der anderen eine
  // Linie ohne Position.
  assert.equal(normalizeCalendarEvent(event({ allDay: true })), null);
  assert.equal(normalizeCalendarEvent(event({ start: "2026-03-14", end: "2026-03-14" })), null);
  assert.ok(normalizeCalendarEvent(event({ allDay: true, start: "2026-03-14", end: "2026-03-14" })));
});

test("an event that ends before it starts is not stored", () => {
  assert.equal(normalizeCalendarEvent(event({ end: "2026-03-14T14:00" })), null);
});

test("a list of broken events keeps the good ones", () => {
  const normalized = normalizeCalendarEvents([
    event({ id: "gut-1", title: "Guter Termin" }),
    { id: "schlecht", title: "" },
    "kein Objekt",
    event({ id: "gut-2", title: "Noch einer", start: "2026-03-15T09:00", end: "2026-03-15T10:00" }),
  ]);
  assert.deepEqual(normalized.map((e) => e.id), ["gut-1", "gut-2"]);
});

test("a value that is not a list is no list", () => {
  assert.deepEqual(normalizeCalendarEvents(null), []);
  assert.deepEqual(normalizeCalendarEvents({ events: [] }), []);
  assert.deepEqual(normalizeCalendarEvents("keine Liste"), []);
});

// --- Die Farbe ------------------------------------------------------------------

test("an event with a preset color keeps it", () => {
  const normalized = normalizeCalendarEvent(event({ color: "success" }));
  assert.equal(normalized?.color, "success");
});

test("an event with a custom hex color keeps it", () => {
  const normalized = normalizeCalendarEvent(event({ color: "#ff00aa" }));
  assert.equal(normalized?.color, "#ff00aa");
});

test("a custom hex color is stored in one form", () => {
  // Die kurze Form und die Schreibweise in Grossbuchstaben meinen dieselbe
  // Farbe — gespeichert wird trotzdem nur eine.
  assert.equal(normalizeCalendarEvent(event({ color: "#f0a" }))?.color, "#ff00aa");
  assert.equal(normalizeCalendarEvent(event({ color: "#FF00AA" }))?.color, "#ff00aa");
});

test("the store drops an invalid color from a hand-written file instead of storing it", () => {
  // Eine von Hand geschriebene Datei kann alles enthalten. Eine kaputte
  // Farbe wird nicht gespeichert — der Termin faellt auf die Voreinstellung
  // zurueck, statt mit Muell in der Datei zu liegen.
  assert.equal(normalizeCalendarEvent(event({ color: "nonsense" }))?.color, undefined);
  assert.equal(normalizeCalendarEvent(event({ color: "#ff00a" }))?.color, undefined);
  assert.equal(normalizeCalendarEvent(event({ color: 42 }))?.color, undefined);
  assert.ok(normalizeCalendarEvent(event({ color: "nonsense" })), "der Termin selbst bleibt gueltig");
});

test("an event without a color keeps none, and falls back to the default", () => {
  const normalized = normalizeCalendarEvent(event());
  assert.equal(normalized?.color, undefined);
  assert.equal(resolveEventColor(normalized ?? {}), "var(--accent)");
});

test("a color survives the round trip through the file", () => {
  const { home, identity } = createAccount("color");
  try {
    writeCalendarFile(identity, [event({ id: "b", color: "warning" }), event({ id: "c", color: "#123456" })]);
    const read = readCalendarFile(identity);
    assert.deepEqual(
      read.events.map((e) => e.color),
      ["warning", "#123456"],
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- Sortierung ----------------------------------------------------------------

test("the events are sorted by start, then by end", () => {
  const sorted = sortCalendarEvents([
    event({ id: "c", start: "2026-03-14T16:00", end: "2026-03-14T17:00" }),
    event({ id: "a", start: "2026-03-14T09:00", end: "2026-03-14T10:00" }),
    event({ id: "b", start: "2026-03-14T09:00", end: "2026-03-14T11:00" }),
  ]);
  assert.deepEqual(sorted.map((e) => e.id), ["a", "b", "c"]);
});

test("the file is written in the sorted order, not in the order it was given", () => {
  const { home, identity } = createAccount("reihenfolge");
  try {
    writeCalendarFile(identity, [
      event({ id: "spaet", start: "2026-03-20T09:00", end: "2026-03-20T10:00" }),
      event({ id: "frueh", start: "2026-03-10T09:00", end: "2026-03-10T10:00" }),
    ]);
    const { events } = readCalendarFile(identity);
    assert.deepEqual(events.map((e) => e.id), ["frueh", "spaet"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- Aenderungsmeldungen ---------------------------------------------------------

test("a change notification reaches the subscriber with the identity", () => {
  const seen = [];
  const unsubscribe = subscribeCalendarChanges((identity) => seen.push(identity));
  try {
    notifyCalendarChange(ALICE);
    notifyCalendarChange(BOB);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].username, "alice");
    assert.equal(seen[1].username, "bob");
  } finally {
    unsubscribe();
  }
});

test("an unsubscribed listener hears nothing more", () => {
  const seen = [];
  const unsubscribe = subscribeCalendarChanges(() => seen.push(1));
  unsubscribe();
  notifyCalendarChange(ALICE);
  assert.equal(seen.length, 0);
});

test("a throwing subscriber does not stop the others", () => {
  const seen = [];
  const unsubscribeBad = subscribeCalendarChanges(() => { throw new Error("kaputt"); });
  const unsubscribeGood = subscribeCalendarChanges(() => seen.push(1));
  try {
    assert.doesNotThrow(() => notifyCalendarChange(ALICE));
    assert.equal(seen.length, 1);
  } finally {
    unsubscribeBad();
    unsubscribeGood();
  }
});
