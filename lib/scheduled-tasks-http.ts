import { NextResponse } from "next/server";
import { ScheduleError } from "./schedule";
import { ScheduledTaskError } from "./scheduled-tasks-store";

/**
 * Die Fehler von `lib/schedule.ts` und `lib/scheduled-tasks-store.ts` als
 * HTTP-Antwort.
 *
 * Beide Fehlerklassen nennen das Feld, um das es geht — daraus wird der
 * Statuscode, ohne die Meldung zu zerlegen. Das ist der Grund, warum die
 * Fehler ein Feld tragen und nicht nur einen Satz: eine Route, die den
 * Statuscode aus dem Text ableitet, bricht, sobald jemand den Text umformuliert.
 *
 * Warum diese Funktion nicht in `route.ts` steht: eine Next-Route exportiert
 * Handler und Konfiguration, keinen Fehlerkatalog. Zwei Routen brauchen ihn
 * aber, und eine Kopie pro Datei waere der zweite Ort fuer dieselbe Regel.
 */
export function scheduledTaskErrorResponse(error: unknown): NextResponse {
  if (error instanceof ScheduleError) {
    // 400, nicht 500: der Ausdruck kommt vom Aufrufer, und Feld und Token
    // sagen ihm, was er aendern muss.
    return NextResponse.json(
      { error: error.message, field: error.field, token: error.token },
      { status: 400 },
    );
  }
  if (error instanceof ScheduledTaskError) {
    const status = error.field === "version" ? 409 : error.field === "lock" ? 503 : 400;
    return NextResponse.json({ error: error.message, field: error.field }, { status });
  }
  console.error("[scheduled-tasks] the request failed:", error);
  return NextResponse.json({ error: "Unable to save the scheduled task" }, { status: 500 });
}
