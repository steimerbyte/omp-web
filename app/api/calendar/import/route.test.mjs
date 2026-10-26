import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { root: process.cwd() });

/**
 * `OMP_WEB_HOME_ROOT` entscheidet, wo `getUserHome()` nachsieht — dieselbe
 * Vorbemerkung wie in `app/api/calendar/calendar-routes.test.mjs`.
 */
const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-calendar-import-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const route = await jiti.import("./route.ts");
const { getCalendarPath, readCalendarFile } = await jiti.import("@/lib/calendar-store.ts");

const ANON = { host: "localhost" };

let accountCounter = 0;

/**
 * Legt ein eigenes Konto an und gibt seine Request-Header zurueck.
 *
 * Jedes Test bekommt ein eigenes Konto: der Kalender liegt pro Konto in
 * einer eigenen Datei, und ein gemeinsames Konto wuerde die Termine der
 * vorherigen Tests erben.
 */
function createAccount(label) {
  const username = `${label}-${accountCounter++}`;
  mkdirSync(join(HOME_ROOT, username), { recursive: true });
  return { host: "localhost", "x-omp-user": username };
}

/** Ein Request mit JSON-Body. */
function post(headers, body) {
  return new Request("http://localhost/api/calendar/import", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Eine ICS-Datei mit einem Termin. */
function icsWith(summary = "Teammeeting", start = "20261028T140000", end = "20261028T150000") {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:test-1",
    `SUMMARY:${summary}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

// ------------------------------------------------------------- die Waechter --

test("the import needs an identity", async () => {
  const response = await route.POST(post(ANON, { ics: icsWith() }));
  assert.equal(response.status, 403);
});

test("a foreign host is refused before the identity is even read", async () => {
  const response = await route.POST(post({ host: "evil.example" }, { ics: icsWith() }));
  assert.equal(response.status, 403);
});

test("a request without a JSON content type is refused", async () => {
  const headers = createAccount("alice");
  const response = await route.POST(
    new Request("http://localhost/api/calendar/import", {
      method: "POST",
      headers: { host: "localhost", "x-omp-user": headers["x-omp-user"] },
      body: "ics=egal",
    }),
  );
  assert.equal(response.status, 415);
});

// -------------------------------------------------------------- die Grenzen --

test("an empty file is a 400", async () => {
  const headers = createAccount("alice");
  const response = await route.POST(post(headers, { ics: "   " }));
  assert.equal(response.status, 400);
});

test("a text that is no calendar is a 400", async () => {
  const headers = createAccount("alice");
  const response = await route.POST(post(headers, { ics: "Hallo, das ist kein Kalender." }));
  assert.equal(response.status, 400);
});

test("a body without an ics field is a 400", async () => {
  const headers = createAccount("alice");
  const response = await route.POST(post(headers, { apply: true }));
  assert.equal(response.status, 400);
});

test("a file of more than two megabytes is a 413", async () => {
  const headers = createAccount("alice");
  const filler = "x".repeat(2 * 1024 * 1024 + 1);
  const response = await route.POST(post(headers, { ics: `BEGIN:VCALENDAR\r\n${filler}` }));
  assert.equal(response.status, 413);
});

// -------------------------------------------------------------- die Vorschau --

test("a preview writes nothing", async () => {
  const headers = createAccount("alice");
  const response = await route.POST(post(headers, { ics: icsWith() }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.applied, false);
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0].title, "Teammeeting");
  assert.equal(body.report.imported, 1);

  const stored = readCalendarFile({ username: headers["x-omp-user"], isAdmin: false });
  assert.equal(stored.exists, false);
  assert.equal(stored.events.length, 0);
});

test("a preview does not create the calendar file", async () => {
  const headers = createAccount("alice");
  await route.POST(post(headers, { ics: icsWith() }));
  const path = getCalendarPath({ username: headers["x-omp-user"], isAdmin: false });
  assert.equal(existsSync(path), false);
});

// ----------------------------------------------------------------- der Import --

test("apply writes the event into the calendar file", async () => {
  const headers = createAccount("alice");
  const response = await route.POST(post(headers, { ics: icsWith(), apply: true }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.applied, true);
  assert.equal(body.events.length, 1);
  assert.equal(body.report.imported, 1);

  const stored = readCalendarFile({ username: headers["x-omp-user"], isAdmin: false });
  assert.equal(stored.events.length, 1);
  assert.equal(stored.events[0].title, "Teammeeting");
  assert.equal(stored.events[0].start, "2026-10-28T14:00");
  assert.equal(stored.events[0].end, "2026-10-28T15:00");
});

test("the id of an imported event is one the server chose", async () => {
  const headers = createAccount("alice");
  const response = await route.POST(post(headers, { ics: icsWith(), apply: true }));
  const body = await response.json();
  assert.equal(typeof body.events[0].id, "string");
  assert.equal(body.events[0].id.length > 0, true);
});

test("an account does not see another account's import", async () => {
  const alice = createAccount("alice");
  const bob = createAccount("bob");
  await route.POST(post(alice, { ics: icsWith(), apply: true }));

  const stored = readCalendarFile({ username: bob["x-omp-user"], isAdmin: false });
  assert.equal(stored.events.length, 0);
});

// ------------------------------------------------------------- die Duplikate --

test("the same file twice does not create the event twice", async () => {
  const headers = createAccount("alice");
  await route.POST(post(headers, { ics: icsWith(), apply: true }));
  const response = await route.POST(post(headers, { ics: icsWith(), apply: true }));
  const body = await response.json();
  assert.equal(body.events.length, 0);
  assert.equal(body.report.imported, 0);
  assert.equal(body.report.skipped[0].reason, "duplicate");

  const stored = readCalendarFile({ username: headers["x-omp-user"], isAdmin: false });
  assert.equal(stored.events.length, 1);
});

test("two events with the same uid in one file are imported once", async () => {
  const headers = createAccount("alice");
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:doppelt",
    "SUMMARY:Erster",
    "DTSTART:20261028T140000",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:doppelt",
    "SUMMARY:Zweiter",
    "DTSTART:20261104T140000",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const response = await route.POST(post(headers, { ics, apply: true }));
  const body = await response.json();
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0].title, "Erster");
  assert.equal(body.report.skipped.some((entry) => entry.reason === "duplicate"), true);
});

// ------------------------------------------------------------------ der Bericht --

test("the report names what could not be imported", async () => {
  const headers = createAccount("alice");
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:ohne-start",
    "SUMMARY:Ohne Beginn",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:mit-start",
    "SUMMARY:Mit Beginn",
    "DTSTART:20261028T140000",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const response = await route.POST(post(headers, { ics, apply: true }));
  const body = await response.json();
  assert.equal(body.events.length, 1);
  assert.equal(body.report.skipped.length, 1);
  assert.equal(body.report.skipped[0].reason, "no-start-date");
});

test("the report counts what the calendar cannot hold", async () => {
  const headers = createAccount("alice");
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:1",
    "SUMMARY:Titel",
    "DTSTART:20261028T140000",
    "ATTENDEE;CN=Anna:mailto:anna@example.org",
    "CATEGORIES:Arbeit",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const response = await route.POST(post(headers, { ics }));
  const body = await response.json();
  assert.equal(body.report.ignored.attendees, 1);
  assert.equal(body.report.ignored.categories, 1);
});

test("an all-day event keeps its days in the file", async () => {
  const headers = createAccount("alice");
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:ganztag",
    "SUMMARY:Urlaub",
    "DTSTART;VALUE=DATE:20261028",
    "DTEND;VALUE=DATE:20261030",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const response = await route.POST(post(headers, { ics, apply: true }));
  const body = await response.json();
  assert.equal(body.events[0].allDay, true);
  assert.equal(body.events[0].start, "2026-10-28");
  assert.equal(body.events[0].end, "2026-10-29");
});

test.after(() => {
  rmSync(HOME_ROOT, { recursive: true, force: true });
});
