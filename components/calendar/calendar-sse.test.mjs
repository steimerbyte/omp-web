import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Der SSE-Strom des Kalenders — der Weg, auf dem eine Aenderung des Agenten
 * in der Oberflaeche ankommt.
 *
 * ### Warum dieser Test den Strom *wirklich* abliest
 *
 * Die Ereignisnamen im SSE-Protokoll sind nicht verhandelbar: ein Browser
 * stellt ein `data:`-Feld ohne `event:`-Feld als Ereignis vom Typ
 * `"message"` zu. Ein Listener, der sich auf `"calendar_changed"`
 * registriert, feuert bei einem solchen Frame **nie** — unabhaengig davon,
 * was der JSON-Body enthaelt.
 *
 * Der Test liest deshalb die echten Bytes aus der echten Route und schickt
 * sie durch einen Parser, der die Zuordnung der HTML-Spezifikation
 * nachbildet. Ein Test, der nur in der Quelle nach einem String sucht, wuerde
 * beide Fehler Varianten gleich setzen: "Server sendet `data:` ohne
 * `event:`" und "Client hoert auf `calendar_changed`".
 */

const jiti = createJiti(import.meta.url, { root: process.cwd() });

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-calendar-sse-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;
mkdirSync(join(HOME_ROOT, "sse-account"), { recursive: true });

const eventsRoute = await jiti.import("@/app/api/calendar/events/route.ts");
const calendarRoute = await jiti.import("@/app/api/calendar/route.ts");

const HEADERS = { host: "localhost", "x-omp-user": "sse-account" };

/**
 * Die Ereignisse eines SSE-Streams, nach der Zuordnung der HTML-Spezifikation.
 *
 * Der Kern der Regel: **ohne** ein `event:`-Feld ist der Ereignistyp
 * `"message"`. Der JSON-Body sagt nur, *was* passiert ist — nicht, wie das
 * Ereignis heisst.
 */
function parseEventStream(text) {
  const events = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let type = "message";
    const data = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) data.push(line.slice("data:".length).trim());
    }
    events.push({ type, data: data.join("\n") });
  }
  return events;
}

/** Der Ereignistyp, auf den der Client sich registriert. */
async function clientSubscribedType() {
  const source = await readFile(new URL("../../hooks/useCalendar.ts", import.meta.url), "utf8");
  const named = source.match(/addEventListener\(\s*"([^"]+)"/);
  if (named) return named[1];
  if (/onmessage\s*=/.test(source)) return "message";
  return null;
}

test("the calendar change reaches a listener that the client actually registers", async () => {
  const stream = await eventsRoute.GET(new Request("http://localhost/api/calendar/events", { headers: HEADERS }));
  assert.equal(stream.status, 200);

  const reader = stream.body.getReader();
  const decoder = new TextDecoder();

  const readUntil = async (predicate) => {
    let text = "";
    while (!predicate(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  };

  // Das Aequivalent zu einem Termin, den der Agent anlegt.
  const created = await calendarRoute.POST(new Request("http://localhost/api/calendar", {
    method: "POST",
    headers: { ...HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ title: "Agententermin", start: "2026-03-14T15:00", end: "2026-03-14T16:00" }),
  }));
  assert.equal(created.status, 201);

  const text = await readUntil((buffer) => buffer.includes("calendar_changed"));
  reader.cancel().catch(() => {});

  const events = parseEventStream(text);
  const change = events.find((event) => event.data.includes("calendar_changed"));
  assert.ok(change, "der Strom enthaelt die Aenderung");

  const subscribed = await clientSubscribedType();
  assert.ok(subscribed, "der Client registriert sich auf einen Ereignistyp");

  // Der Kern der Aussage: der Typ, auf den der Client hoert, muss der Typ
  // sein, den der Browser dem Frame gibt.
  assert.equal(
    change.type,
    subscribed,
    `der Server liefert den Ereignistyp "${change.type}", der Client hoert aber auf "${subscribed}"`,
  );
});

test.after(() => {
  rmSync(HOME_ROOT, { recursive: true, force: true });
});
