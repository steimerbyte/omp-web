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
const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-calendar-api-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const calendarRoute = await jiti.import("./route.ts");
const eventRoute = await jiti.import("./[id]/route.ts");

const ANON = { host: "localhost" };

let accountCounter = 0;

/**
 * Legt ein eigenes Konto an und gibt seine Request-Header zurueck.
 *
 * **Warum jedes Test ein eigenes Konto bekommt.** Der Kalender liegt pro
 * Konto in einer eigenen Datei, und die Tests laufen in derselben Datei
 * weiter. Ein gemeinsames Konto wuerde die Termine der vorherigen Tests
 * erben — und ein Test, der "der Kalender ist leer" behauptet, wuerde an
 * einem Bestand scheitern, den er selbst erzeugt hat. Das waere kein Fehler
 * des Codes, sondern eine falsche Fixture: der Kalender *muss* die Termine
 * eines Kontos sehen und die eines anderen nicht.
 */
function createAccount(label) {
  const username = `${label}-${accountCounter++}`;
  mkdirSync(join(HOME_ROOT, username), { recursive: true });
  return { host: "localhost", "x-omp-user": username };
}

/** Ein Request mit JSON-Body. */
function post(url, headers, body) {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(url, headers) {
  return new Request(`http://localhost${url}`, { headers });
}

function patch(url, headers, body) {
  return new Request(`http://localhost${url}`, {
    method: "PATCH",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function del(url, headers) {
  return new Request(`http://localhost${url}`, { method: "DELETE", headers });
}

const eventParams = (id) => ({ params: Promise.resolve({ id }) });

/** Legt einen Termin an und gibt ihn zurueck. */
async function createEvent(headers, overrides = {}) {
  const response = await calendarRoute.POST(post("/api/calendar", headers, {
    title: "Teammeeting",
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:00",
    ...overrides,
  }));
  assert.equal(response.status, 201);
  const body = await response.json();
  return body.event;
}

// --- Zugriff ---------------------------------------------------------------

test("the calendar needs an identity", async () => {
  const response = await calendarRoute.GET(get("/api/calendar", ANON));
  assert.equal(response.status, 403);
});

test("a foreign host is refused before the identity is even read", async () => {
  const response = await calendarRoute.GET(get("/api/calendar", { host: "evil.example" }));
  assert.equal(response.status, 403);
});

test("an account sees its own empty calendar", async () => {
  const alice = createAccount("leer");
  const response = await calendarRoute.GET(get("/api/calendar", alice));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.events, []);
});

// --- Anlegen ---------------------------------------------------------------

test("a created event comes back with an id the client did not choose", async () => {
  const alice = createAccount("anleger");
  const response = await calendarRoute.POST(post("/api/calendar", alice, {
    title: "Teammeeting",
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:00",
  }));
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.event.title, "Teammeeting");
  assert.ok(body.event.id);
  // Die Kennung vergibt der Server. Ein Client, der seine eigene waehlt,
  // koennte einen fremden Termin ueberschreiben.
  assert.notEqual(body.event.id, "selbst-gewahlt");
});

test("an event without a title is refused", async () => {
  const alice = createAccount("ohne-titel");
  const response = await calendarRoute.POST(post("/api/calendar", alice, {
    title: "   ",
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:00",
  }));
  assert.equal(response.status, 400);
});

test("an event with an impossible date is refused", async () => {
  const alice = createAccount("kaputtes-datum");
  const response = await calendarRoute.POST(post("/api/calendar", alice, {
    title: "Kaputt",
    start: "2026-02-30T15:00",
    end: "2026-03-14T16:00",
  }));
  assert.equal(response.status, 400);
});

test("an event that ends before it starts is refused", async () => {
  const alice = createAccount("verkehrt");
  const response = await calendarRoute.POST(post("/api/calendar", alice, {
    title: "Verkehrt herum",
    start: "2026-03-14T16:00",
    end: "2026-03-14T15:00",
  }));
  assert.equal(response.status, 400);
});

test("a request without a JSON content type is refused", async () => {
  const alice = createAccount("kein-json");
  const request = new Request("http://localhost/api/calendar", {
    method: "POST",
    headers: { ...alice, "content-type": "text/plain" },
    body: "kein json",
  });
  const response = await calendarRoute.POST(request);
  assert.equal(response.status, 415);
});

// --- Die Farbe ------------------------------------------------------------------

test("an event is created with a preset color", async () => {
  const alice = createAccount("preset-farbe");
  const response = await calendarRoute.POST(post("/api/calendar", alice, {
    title: "Teammeeting",
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:00",
    color: "success",
  }));
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.event.color, "success");
});

test("an event is created with a custom hex color", async () => {
  const alice = createAccount("hex-farbe");
  const response = await calendarRoute.POST(post("/api/calendar", alice, {
    title: "Teammeeting",
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:00",
    color: "#ff00aa",
  }));
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.event.color, "#ff00aa");
});

test("an invalid color is refused and never reaches the file", async () => {
  const alice = createAccount("kaputte-farbe");
  const response = await calendarRoute.POST(post("/api/calendar", alice, {
    title: "Teammeeting",
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:00",
    color: "nonsense",
  }));
  // Der Client hat die Farbe gewaehlt — sie ist angekommen und unbrauchbar.
  // Das gehoert gemeldet, nicht stillschweigend verworfen.
  assert.equal(response.status, 400);

  // Und der Termin ist nicht in der Datei: ein abgelehnter Anlegvorgang
  // darf keinen halben Termin hinterlassen.
  const listed = await calendarRoute.GET(get("/api/calendar", alice));
  const body = await listed.json();
  assert.deepEqual(body.events, []);
});

test("an invalid color is refused when changing an event", async () => {
  const alice = createAccount("kaputte-farb-aenderung");
  const created = await createEvent(alice, { title: "Teammeeting" });
  const response = await eventRoute.PATCH(
    patch(`/api/calendar/${created.id}`, alice, { color: "nonsense" }),
    eventParams(created.id),
  );
  assert.equal(response.status, 400);

  // Der Termin behält seine Farbe — die kaputte hat ihn nicht erreicht.
  const listed = await calendarRoute.GET(get("/api/calendar", alice));
  const body = await listed.json();
  assert.equal(body.events[0].color, undefined);
});

test("an event without a color is stored without one", async () => {
  const alice = createAccount("ohne-farbe");
  const response = await calendarRoute.POST(post("/api/calendar", alice, {
    title: "Teammeeting",
    start: "2026-03-14T15:00",
    end: "2026-03-14T16:00",
  }));
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.event.color, undefined);
});

// --- Mandantengrenze --------------------------------------------------------

test("an account does not see another account's events", async () => {
  const alice = createAccount("alice");
  const bob = createAccount("bob");
  await createEvent(alice, { title: "Alices geheimer Termin" });

  const bobsView = await calendarRoute.GET(get("/api/calendar", bob));
  const bobsBody = await bobsView.json();
  assert.deepEqual(bobsBody.events, []);

  const aliceView = await calendarRoute.GET(get("/api/calendar", alice));
  const aliceBody = await aliceView.json();
  assert.equal(aliceBody.events.length, 1);
});

test("another account cannot change or delete an event", async () => {
  const alice = createAccount("alice2");
  const bob = createAccount("bob2");
  const event = await createEvent(alice, { title: "Alices Termin" });

  // Bob kennt die Kennung vielleicht — die Route muss ihn trotzdem abweisen.
  const patched = await eventRoute.PATCH(patch(`/api/calendar/${event.id}`, bob, { title: "Geraubt" }), eventParams(event.id));
  assert.equal(patched.status, 404);

  const deleted = await eventRoute.DELETE(del(`/api/calendar/${event.id}`, bob), eventParams(event.id));
  assert.equal(deleted.status, 404);

  const stillThere = await calendarRoute.GET(get("/api/calendar", alice));
  const body = await stillThere.json();
  assert.equal(body.events[0].title, "Alices Termin");
});

// --- Aendern ----------------------------------------------------------------

test("moving an event changes its start and end", async () => {
  const alice = createAccount("verschieber");
  const event = await createEvent(alice, { title: "Verschiebbar" });

  const response = await eventRoute.PATCH(patch(`/api/calendar/${event.id}`, alice, {
    start: "2026-03-16T10:00",
    end: "2026-03-16T11:00",
  }), eventParams(event.id));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.event.start, "2026-03-16T10:00");
  assert.equal(body.event.end, "2026-03-16T11:00");
  // Der Titel bleibt, weil er nicht mitschickt wurde: `PATCH` aendert nur das
  // Genannte.
  assert.equal(body.event.title, "Verschiebbar");
});

test("changing an event keeps its creation time", async () => {
  const alice = createAccount("zeitstempel");
  const event = await createEvent(alice, { title: "Mit Zeitstempel" });
  const response = await eventRoute.PATCH(patch(`/api/calendar/${event.id}`, alice, { title: "Umbenannt" }), eventParams(event.id));
  const body = await response.json();
  // `createdAt` ist der Zeitpunkt, an dem der Termin zum ersten Mal
  // existierte. Eine Bearbeitung aendert ihn nicht — sonst waere die
  // Entstehungszeit eines Termins von einem spaeteren Edit abhaengig.
  assert.equal(body.event.createdAt, event.createdAt);
  // `updatedAt` ist die letzte Aenderung. Es darf nicht *aelter* sein als die
  // Entstehung; dass es sich sichtbar unterscheidet, haengt an der
  // Millisekunde und waere kein Test, sondern eine Zufallsprobe.
  assert.ok(
    Date.parse(body.event.updatedAt) >= Date.parse(event.createdAt),
    "updatedAt darf nicht vor createdAt liegen",
  );
});

test("changing an unknown event is a 404", async () => {
  const alice = createAccount("unbekannt");
  const response = await eventRoute.PATCH(patch("/api/calendar/gibt-es-nicht", alice, { title: "X" }), eventParams("gibt-es-nicht"));
  assert.equal(response.status, 404);
});

test("deleting an event removes it", async () => {
  const alice = createAccount("loescher");
  const event = await createEvent(alice, { title: "Weg damit" });

  const response = await eventRoute.DELETE(del(`/api/calendar/${event.id}`, alice), eventParams(event.id));
  assert.equal(response.status, 200);

  const list = await calendarRoute.GET(get("/api/calendar", alice));
  const body = await list.json();
  assert.equal(body.events.length, 0);
});

// --- Filter ------------------------------------------------------------------

test("the range filter returns only the events in that range", async () => {
  const alice = createAccount("filter");
  await createEvent(alice, { title: "Maerz", start: "2026-03-14T15:00", end: "2026-03-14T16:00" });
  await createEvent(alice, { title: "April", start: "2026-04-14T15:00", end: "2026-04-14T16:00" });

  const response = await calendarRoute.GET(get("/api/calendar?from=2026-03-01&to=2026-03-31", alice));
  const body = await response.json();
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0].title, "Maerz");
});

// --- Aufraeumen --------------------------------------------------------------

test.after(() => {
  rmSync(HOME_ROOT, { recursive: true, force: true });
});
