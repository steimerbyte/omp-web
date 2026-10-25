import { getCalendarPath, isCalendarPathAllowed, subscribeCalendarChanges } from "@/lib/calendar-store";
import { getRequestIdentity } from "@/lib/request-identity";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/**
 * GET /api/calendar/events — SSE-Strom der Kalender-Aenderungen.
 *
 * ### Warum es diesen Strom gibt
 *
 * Der Kalender wird von zwei Seiten aus geschrieben: von der Oberflaeche und
 * vom Agenten. Ohne einen Strom sieht der Nutzer einen Termin, den der Agent
 * gerade angelegt hat, erst nach einem Neuladen — und im Chat steht
 * gleichzeitig "Ich habe einen Termin angelegt". Das ist die Art von
 * Widerspruch, die ein Werkzeug unbrauchbar macht.
 *
 * Der Strom ist dasselbe Muster wie `app/api/agent/running/events/route.ts`:
 * ein Prozessereignis, das an alle Abonnenten geht, und der Abonnent filtert
 * selbst ueber die eigene Identitaet.
 *
 * ### Warum der Filter hier und nicht im Broadcast
 *
 * Der Broadcast kennt nur die Identitaet, die geschrieben hat. Ob das fuer
 * diesen Abonnenten ein fremder Kalender ist, entscheidet sich aber erst in
 * der Identitaet des Abonnenten — beim Admin ist ein Kalender, der ein
 * Mandant geschrieben hat, sichtbar, beim Mandanten nicht. Das laesst sich in
 * einem prozess-globalen Broadcast nicht entscheiden, also filtert der
 * Abonnent.
 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return new Response("Untrusted API request", { status: 403 });
  }

  const identity = getRequestIdentity(req.headers);
  if (!identity) {
    return new Response("Unknown user", { status: 403 });
  }
  if (!isCalendarPathAllowed(identity, getCalendarPath(identity))) {
    return new Response("Access denied", { status: 403 });
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      /**
       * Sendet eine *benannte* SSE-Meldung.
       *
       * ### Warum der Name im Protokoll und nicht nur in den Daten
       *
       * Eine SSE-Meldung ohne `event:`-Zeile kommt im Browser als
       * Standard-Ereignis `message` an. Ein `addEventListener("calendar_changed", …)`
       * laeuft dann **nie** — der Browser kennt nur `message`, `open`, `error`
       * und die im Protokoll benannten Ereignisse.
       *
       * Das ist kein Fehler im Client, sondern im Protokoll: der Client
       * hoert auf den Namen, den der Server geschickt hat. Die Datei-Watch-
       * Route macht es genauso (`app/api/files/[...path]/route.ts`), und der
       * Datei-Viewer hoert dort auf `connected` und `change`.
       */
      const encode = (eventName: string, data: unknown) => {
        const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // Der Strom ist schon geschlossen.
        }
      };

      // Abonnieren VOR dem ersten Snapshot, damit keine Aenderung zwischen
      // Snapshot und Abonnement durchschlupfen kann.
      const unsubscribe = subscribeCalendarChanges((changed) => {
        // Ein fremder Kalender ist fuer diesen Abonnenten keiner.
        if (changed.username !== identity.username) return;
        encode("calendar_changed", { type: "calendar_changed" });
      });

      encode("connected", { type: "connected" });

      // Heartbeat, damit die Verbindung durch Proxies und Timeouts lebt.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // Der Strom ist schon geschlossen.
        }
      }, 30_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };

      req.signal?.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
