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

/** Ein Datum in deutscher Schreibweise: `30.10.2026`. */
function germanDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

/** Maskiert die Punkte eines Datums fuer einen regulaeren Ausdruck. */
function escapeRegExp(value) {
  return value.replace(/\./g, "\\.");
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
  // Die Meldung ist an das Modell gerichtet und deshalb englisch — sie sagt,
  // was fehlt und was stattdessen zu tun ist.
  await assert.rejects(
    () => callTool(write, { action: "create", start: "2026-03-14T15:00", end: "2026-03-14T16:00" }),
    /title is required/i,
  );
});

test("creating with a broken date is refused", async () => {
  const identity = createIdentity("kaputt");
  const [, write] = makeCalendarTools({ identity });
  // Die Meldung nennt beide erlaubten Formen, damit das Modell sich korrigieren kann.
  await assert.rejects(
    () => callTool(write, { action: "create", title: "X", start: "2026-13-45", end: "2026-13-45" }),
    /YYYY-MM-DD/,
  );
  await assert.rejects(
    () => callTool(write, { action: "create", title: "X", start: "2026-13-45", end: "2026-13-45" }),
    /YYYY-MM-DDTHH:mm/,
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

test("an update with only a new start keeps the duration of the event", async () => {
  // Das Verschieben ist eine Eigenschaft des Werkzeugs: der Agent nennt nur
  // die neue Anfangszeit, das Ende folgt aus der Dauer des Termins.
  const identity = createIdentity("verschieben-nur-start");
  const [, write] = makeCalendarTools({ identity });
  await callTool(write, {
    action: "create",
    title: "Werkstatt",
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:30",
  });
  const { events } = readCalendarFile(identity);

  await callTool(write, { action: "update", id: events[0].id, start: "2026-03-14T18:00" });

  const after = readCalendarFile(identity);
  assert.equal(after.events[0].start, "2026-03-14T18:00");
  // 90 Minuten Dauer bleiben 90 Minuten: 18:00 plus 90 Minuten sind 19:30.
  assert.equal(after.events[0].end, "2026-03-14T19:30");
});

test("an update with only a new end keeps the duration of the event", async () => {
  const identity = createIdentity("verschieben-nur-end");
  const [, write] = makeCalendarTools({ identity });
  await callTool(write, {
    action: "create",
    title: "Werkstatt",
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:30",
  });
  const { events } = readCalendarFile(identity);

  await callTool(write, { action: "update", id: events[0].id, end: "2026-03-14T14:00" });

  const after = readCalendarFile(identity);
  // Das Ende rueckt vor den alten Beginn: der Beginn rueckt um die Dauer
  // (90 Minuten) mit, auf 12:30.
  assert.equal(after.events[0].end, "2026-03-14T14:00");
  assert.equal(after.events[0].start, "2026-03-14T12:30");
});

test("a date-only start turns a timed event into an all-day event", async () => {
  const identity = createIdentity("wechsel-zum-ganztag");
  const [, write] = makeCalendarTools({ identity });
  await callTool(write, {
    action: "create",
    title: "Werkstatt",
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:00",
  });
  const { events } = readCalendarFile(identity);

  await callTool(write, { action: "update", id: events[0].id, start: "2026-03-16" });

  const after = readCalendarFile(identity);
  assert.equal(after.events[0].allDay, true);
  assert.equal(after.events[0].start, "2026-03-16");
  // Ein Termin, der einen Tag braucht, ist ein Ganztagestermin — und dessen
  // Ende ist derselbe Tag.
  assert.equal(after.events[0].end, "2026-03-16");
});

test("a start with a time turns an all-day event into a timed event", async () => {
  const identity = createIdentity("wechsel-zur-uhrzeit");
  const [, write] = makeCalendarTools({ identity });
  await callTool(write, {
    action: "create",
    title: "Urlaub",
    start: "2026-03-14",
    end: "2026-03-14",
  });
  const { events } = readCalendarFile(identity);

  await callTool(write, { action: "update", id: events[0].id, start: "2026-03-16T15:00" });

  const after = readCalendarFile(identity);
  assert.equal(after.events[0].allDay, false);
  assert.equal(after.events[0].start, "2026-03-16T15:00");
  // Ein Ganztagestermin, der auf eine Uhrzeit gezogen wird, wird zu einem
  // Termin mit Uhrzeit — 60 Minuten, wie in der Oberflaeche.
  assert.equal(after.events[0].end, "2026-03-16T16:00");
});

test("an update without start and end leaves the all-day flag alone", async () => {
  const identity = createIdentity("flag-unveraendert");
  const [, write] = makeCalendarTools({ identity });
  await callTool(write, {
    action: "create",
    title: "Urlaub",
    start: "2026-03-14",
    end: "2026-03-16",
  });
  const { events } = readCalendarFile(identity);

  await callTool(write, { action: "update", id: events[0].id, title: "Urlaubstag" });

  const after = readCalendarFile(identity);
  assert.equal(after.events[0].allDay, true);
  assert.equal(after.events[0].title, "Urlaubstag");
  assert.equal(after.events[0].start, "2026-03-14");
  assert.equal(after.events[0].end, "2026-03-16");
});

test("moving an all-day event keeps its number of days", async () => {
  const identity = createIdentity("ganztag-verschieben");
  const [, write] = makeCalendarTools({ identity });
  await callTool(write, {
    action: "create",
    title: "Urlaub",
    start: "2026-03-14",
    end: "2026-03-16",
  });
  const { events } = readCalendarFile(identity);

  await callTool(write, { action: "update", id: events[0].id, start: "2026-04-02" });

  const after = readCalendarFile(identity);
  // Drei Tage bleiben drei Tage — das Ende ist der letzte Tag, einschliesslich.
  assert.equal(after.events[0].start, "2026-04-02");
  assert.equal(after.events[0].end, "2026-04-04");
  assert.equal(after.events[0].allDay, true);
});

test("an update that mixes a date and a date-time is refused", async () => {
  // Ein Ganztagestermin hat kein 'T' im Ende, ein Termin mit Uhrzeit schon —
  // beides zusammen laesst sich nicht in einen Termin rechnen.
  const identity = createIdentity("gemischt");
  const [, write] = makeCalendarTools({ identity });
  await callTool(write, {
    action: "create",
    title: "Werkstatt",
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:00",
  });
  const { events } = readCalendarFile(identity);

  await assert.rejects(
    () => callTool(write, {
      action: "update",
      id: events[0].id,
      start: "2026-03-16",
      end: "2026-03-16T17:00",
    }),
    /same format/i,
  );
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

// --- Zeitraum, Tageswechsel und Kuerzung --------------------------------------------

test("a timed event whose end equals its start asks for a length, not for an earlier end", async () => {
  // Das Ende liegt *gleich* auf dem Beginn — die Meldung "end is before start"
  // waere sachlich falsch und wuerde das Modell ins Leere suchen lassen.
  const identity = createIdentity("gleiches-ende");
  const [, write] = makeCalendarTools({ identity });
  await assert.rejects(
    () => callTool(write, {
      action: "create",
      title: "Kurz",
      start: "2026-07-01T09:00",
      end: "2026-07-01T09:00",
    }),
    /AFTER/i,
  );
});

test("an all-day event may start and end on the same day", async () => {
  // Bei einem Ganztagestermin ist derselbe Tag Beginn und Ende — das ist ein
  // eintägiger Termin und darf nicht als Fehler gemeldet werden.
  const identity = createIdentity("ganztag-gleich");
  const [, write] = makeCalendarTools({ identity });
  await callTool(write, {
    action: "create",
    title: "Eintag",
    start: "2026-07-01",
    end: "2026-07-01",
  });
  const { events } = readCalendarFile(identity);
  assert.equal(events[0].allDay, true);
  assert.equal(events[0].start, "2026-07-01");
  assert.equal(events[0].end, "2026-07-01");
});

test("an event over midnight shows both days in the tool output", async () => {
  // Der Nutzer liest diese Zeile im Chat: am zweiten Tag muss erkennbar sein,
  // dass der Termin dort noch laeuft.
  const identity = createIdentity("ueber-mitternacht");
  const tools = makeCalendarTools({ identity });
  const write = tools[1];
  await callTool(write, {
    action: "create",
    title: "Nachtschicht",
    start: "2026-10-26T22:00",
    end: "2026-10-27T02:00",
  });

  const { text } = await callTool(tools[0], {});
  assert.match(text, /26\.10\.2026, 22:00/);
  assert.match(text, /27\.10\.2026, 02:00/);
});

test("a title longer than 300 characters is truncated and the truncation is reported", async () => {
  const identity = createIdentity("langer-titel");
  const [, write] = makeCalendarTools({ identity });
  const { text } = await callTool(write, {
    action: "create",
    title: "a".repeat(320),
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:00",
  });

  const { events } = readCalendarFile(identity);
  assert.equal(events[0].title.length, 300);
  // Der Nutzer muss erfahren, dass dem Termin 20 Zeichen fehlen.
  assert.match(text, /Titel wurde auf 300 Zeichen gekuerzt/);
});

test("a title of exactly 300 characters is not reported as truncated", async () => {
  const identity = createIdentity("genau-300");
  const [, write] = makeCalendarTools({ identity });
  const { text } = await callTool(write, {
    action: "create",
    title: "a".repeat(300),
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:00",
  });

  const { events } = readCalendarFile(identity);
  assert.equal(events[0].title.length, 300);
  assert.doesNotMatch(text, /gekuerzt/);
});

// --- Der Anker: heute, Wochentag und Wochenbereich ----------------------------------

test("reading names today's date, its weekday and the bounds of the current week", async () => {
  // Der Anker ist die Information, nicht der Kalenderinhalt — er steht auch
  // bei einem leeren Kalender.
  const identity = createIdentity("anker");
  const [read] = makeCalendarTools({ identity });
  const { text } = await callTool(read, {});

  const now = new Date();
  const weekday = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"][
    (now.getDay() + 6) % 7
  ];
  assert.match(text, new RegExp(`Heute ist ${weekday}, ${escapeRegExp(germanDate(now))}\\.`));
  // Die Wochen heiessen "Kalenderwoche" — ein Begriff, den es im Kalender
  // nur einmal gibt ("KW 11" in der Kopfzeile).
  assert.match(text, /Diese Kalenderwoche: Mo \d{2}\.\d{2}\.\d{4} – So \d{2}\.\d{2}\.\d{4}\./);
  assert.match(text, /Nächste Kalenderwoche: Mo \d{2}\.\d{2}\.\d{4} – So \d{2}\.\d{2}\.\d{4}\./);
  assert.doesNotMatch(text, /Diese Woche:/);
  assert.doesNotMatch(text, /Nächste Woche:/);
  // Der Anker steht vor der Terminliste.
  assert.ok(text.indexOf("Heute ist") < text.indexOf("Termin"), "der Anker steht nicht vorn");
});

test("the anchor names a week that starts on Monday", async () => {
  const identity = createIdentity("anker-montag");
  const [read] = makeCalendarTools({ identity });
  const { text } = await callTool(read, {});

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Der Montag der Woche, in der heute liegt.
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const mondayText = escapeRegExp(germanDate(monday));
  const sundayText = escapeRegExp(germanDate(sunday));
  assert.match(text, new RegExp(`Diese Kalenderwoche: Mo ${mondayText} – So ${sundayText}\\.`));
});

test("the error for an unusable date names today's date", async () => {
  const identity = createIdentity("anker-fehler");
  const [read] = makeCalendarTools({ identity });
  await assert.rejects(
    () => callTool(read, { from: "letzte Woche" }),
    /Today is (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}\.\d{2}\.\d{4}/,
  );
});

test("the error for an unusable date uses the same week term as the anchor", async () => {
  // Das Modell darf "diese Woche" und "diese Kalenderwoche" nicht fuer zwei
  // Dinge halten — der Anker und die Fehlermeldung muessen dasselbe Wort
  // benutzen.
  const identity = createIdentity("anker-fehler-begriff");
  const [read] = makeCalendarTools({ identity });
  await assert.rejects(
    () => callTool(read, { from: "letzte Woche" }),
    /diese Kalenderwoche/,
  );
  await assert.rejects(
    () => callTool(read, { to: "nächstes Mal" }),
    /diese Kalenderwoche/,
  );
});

// --- Das Loeschen nennt ein lesbares Datum -------------------------------------------

test("the delete message names the date and the time of a timed event", async () => {
  // `formatGermanDate` erwartet ein reines Datum und zerlegt einen String mit
  // Uhrzeit — der Loesch-Zweig hatte den Termin mit Uhrzeit ungekuerzt
  // uebergeben und lieferte "am 30T15:00.10.2026".
  const identity = createIdentity("loesch-datum");
  const tools = makeCalendarTools({ identity });
  const write = tools[1];
  await callTool(write, {
    action: "create",
    title: "Termin mit Dr. Weber",
    start: "2026-10-30T15:00",
    end: "2026-10-30T16:00",
  });
  const { events } = readCalendarFile(identity);

  const { text } = await callTool(write, { action: "delete", id: events[0].id });
  assert.match(text, /am 30\.10\.2026, 15:00 Uhr/);
  assert.doesNotMatch(text, /T15:00/);
});

test("the delete message names an all-day event without a time", async () => {
  const identity = createIdentity("loesch-ganztag");
  const tools = makeCalendarTools({ identity });
  const write = tools[1];
  await callTool(write, {
    action: "create",
    title: "Urlaub",
    start: "2026-10-30",
    end: "2026-10-30",
  });
  const { events } = readCalendarFile(identity);

  const { text } = await callTool(write, { action: "delete", id: events[0].id });
  assert.match(text, /am 30\.10\.2026\./);
  assert.doesNotMatch(text, /am 30\.10\.2026,/);
});

// --- Farben -------------------------------------------------------------------------

test("creating an event with a preset colour stores it and names it in German", async () => {
  const identity = createIdentity("farbe-preset");
  const [, write] = makeCalendarTools({ identity });
  const { text } = await callTool(write, {
    action: "create",
    title: "Teammeeting",
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:00",
    color: "success",
  });

  const { events } = readCalendarFile(identity);
  assert.equal(events[0].color, "success");
  // Die Rueckmeldung steht auf Deutsch — sie nennt den deutschen Namen.
  assert.match(text, /Teammeeting \(Erfolg\)/);
});

test("creating an event with a hex colour stores the canonical hex", async () => {
  const identity = createIdentity("farbe-hex");
  const [, write] = makeCalendarTools({ identity });
  const { text } = await callTool(write, {
    action: "create",
    title: "Teambuilding",
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:00",
    color: "#ff00aa",
  });

  const { events } = readCalendarFile(identity);
  assert.equal(events[0].color, "#ff00aa");
  // Bei einer eigenen Farbe nennt die Rueckmeldung den Code selbst.
  assert.match(text, /#ff00aa/);
});

test("creating an event with an unusable colour is refused", async () => {
  const identity = createIdentity("farbe-unsinn");
  const [, write] = makeCalendarTools({ identity });
  await assert.rejects(
    () => callTool(write, {
      action: "create",
      title: "Teammeeting",
      start: "2026-03-14T15:00",
      end: "2026-03-14T16:00",
      color: "nonsense",
    }),
    /'accent', 'success', 'warning', 'danger', 'violet'/,
  );
  await assert.rejects(
    () => callTool(write, {
      action: "create",
      title: "Teammeeting",
      start: "2026-03-14T15:00",
      end: "2026-03-14T16:00",
      color: "nonsense",
    }),
    /#ff00aa/,
  );
  // Der Termin darf nicht halb angelegt worden sein.
  assert.equal(readCalendarFile(identity).events.length, 0);
});

test("creating an event without a colour leaves the colour to the default", async () => {
  const identity = createIdentity("farbe-ohne");
  const [, write] = makeCalendarTools({ identity });
  const { text } = await callTool(write, {
    action: "create",
    title: "Teammeeting",
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:00",
  });

  const { events } = readCalendarFile(identity);
  // Keine eigene Farbe im Ereignis — die Voreinstellung entscheidet, nicht das Werkzeug.
  assert.equal(events[0].color, undefined);
  assert.doesNotMatch(text, /Teammeeting \(/);
});

test("an update without a colour keeps the colour of the event", async () => {
  const identity = createIdentity("farbe-beibehalten");
  const [, write] = makeCalendarTools({ identity });
  await callTool(write, {
    action: "create",
    title: "Teammeeting",
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:00",
    color: "success",
  });
  const { events } = readCalendarFile(identity);

  await callTool(write, { action: "update", id: events[0].id, title: "Teammeeting kurz" });

  const after = readCalendarFile(identity);
  assert.equal(after.events[0].color, "success");
});

test("an update with a colour changes the colour of the event", async () => {
  const identity = createIdentity("farbe-wechsel");
  const [, write] = makeCalendarTools({ identity });
  await callTool(write, {
    action: "create",
    title: "Teammeeting",
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:00",
    color: "success",
  });
  const { events } = readCalendarFile(identity);

  const { text } = await callTool(write, { action: "update", id: events[0].id, color: "danger" });

  const after = readCalendarFile(identity);
  assert.equal(after.events[0].color, "danger");
  assert.match(text, /Teammeeting \(Gefahr\)/);
});

test("reading names the colour of an event", async () => {
  const identity = createIdentity("farbe-lesen");
  const tools = makeCalendarTools({ identity });
  const write = tools[1];
  await callTool(write, {
    action: "create",
    title: "Sprint-Review",
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:00",
    color: "warning",
  });

  const { text } = await callTool(tools[0], {});
  assert.match(text, /Sprint-Review \(Warnung\)/);
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

// --- Die Meldungen, mit denen das Modell sich korrigieren kann ---------------------

test("a date with a space between date and time is accepted and stored canonically", async () => {
  // Das Modell schreibt die Leerzeichenform oft genug, dass eine Ablehnung
  // einen Rundlauf gekostet haette. Gespeichert wird trotzdem die kanonische
  // Form mit 'T'.
  const identity = createIdentity("leerzeichen");
  const [, write] = makeCalendarTools({ identity });
  await callTool(write, {
    action: "create",
    title: "Spaziergang",
    start: "2026-10-26 15:00",
    end: "2026-10-26 16:00",
  });
  const { events } = readCalendarFile(identity);
  assert.equal(events[0].start, "2026-10-26T15:00");
  assert.equal(events[0].end, "2026-10-26T16:00");
  assert.equal(events[0].allDay, false);
});

test("a malformed 'from' names the format and asks for a concrete date", async () => {
  const identity = createIdentity("relatives-datum");
  const [read] = makeCalendarTools({ identity });
  await assert.rejects(
    () => callTool(read, { from: "letzte Woche" }),
    /YYYY-MM-DD/,
  );
  await assert.rejects(
    () => callTool(read, { from: "letzte Woche" }),
    /convert/i,
  );
});

test("a missing id points the model at calendar_read", async () => {
  const identity = createIdentity("id-fehlt");
  const [, write] = makeCalendarTools({ identity });
  await assert.rejects(
    () => callTool(write, { action: "delete" }),
    /calendar_read/,
  );
});

test("a missing title says that a title is required", async () => {
  const identity = createIdentity("titel-fehlt");
  const [, write] = makeCalendarTools({ identity });
  await assert.rejects(
    () => callTool(write, { action: "create", start: "2026-10-26T15:00", end: "2026-10-26T16:00" }),
    /title is required/i,
  );
});

// --- Aufraeumen ---------------------------------------------------------------------

test.after(() => {
  rmSync(HOME_ROOT, { recursive: true, force: true });
});
