import { NextResponse } from "next/server";
import { isRpcSessionVisibleTo } from "@/lib/rpc-manager";
import { listAllSessions } from "@/lib/session-reader";
import { getRequestIdentity, requireIdentity } from "@/lib/request-identity";

/**
 * Gehoert diese Session zu diesem Request?
 *
 * `null` heisst weiter, ein `Response` heisst nein und wird unveraendert
 * zurueckgegeben. Dieselbe Form wie `requireIdentity` und `requireAdmin` aus
 * `lib/request-identity.ts` — eine Route fragt, bekommt eine Antwort, und muss
 * nichts selbst entscheiden.
 *
 * ### Warum ueberhaupt hier und nicht in `resolveSessionPath`
 *
 * `resolveSessionPath` befuellt seinen Pfad-Cache aus `listAllSessions()`
 * **ohne** Identitaet (`lib/session-reader.ts:193-204`). Das ist an sich kein
 * Fehler: der Cache ist eine Abbildung Id -> Pfad, und ein Pfad gehoert niemandem
 * allein. Der Fehler ist der *Lookup* — er beantwortet "welcher Pfad gehoert zu
 * dieser Id", ohne zu fragen, wer fragt. Eine Identitaet in diese Funktion
 * einzuziehen wuerde aber das Falsche reparieren: sie beantwortet weiter nur die
 * Pfadfrage und laesst die eigentliche Luecke, den Aufrufer, unveraendert.
 *
 * Ausserdem ist der Resolver nicht der einzige Weg zu einer fremden Session.
 * `[id]/route.ts` und `context` gehen zuerst an `getRpcSession(id)` — eine
 * lebende Session, deren Datei es noch gar nicht gibt, die also in keinem
 * Plattenlauf auftaucht. Ein Filter nur im Resolver wuerde diese Sessions gar
 * nicht sehen. Es gibt also zwei Quellen, und die Regel gehoert an die Stelle,
 * die beide kennt.
 *
 * ### Die Regel: was die Liste zeigen wuerde
 *
 * Genau zwei Pruefungen, in dieser Reihenfolge:
 *
 * 1. `isRpcSessionVisibleTo(id, identity)` — eine **laufende** Session. Sie
 *    gehoert dem Konto, das sie gestartet hat, auch wenn ihre Datei noch nicht
 *    existiert. Das ist der Fall, an dem ein reiner Plattenfilter den Besitzer
 *    aus der frisch geoeffneten Session werfen wuerde.
 * 2. `listAllSessions({ identity })` — eine **persistierte** Session, gefiltert
 *    ueber `isSessionOwnedBy`. Das ist derselbe Aufruf, den `/api/sessions`
 *    in `app/api/sessions/route.ts` macht, mit derselben `null`-Semantik und
 *    demselben Cache. Die Regel ist damit keine neue: die Detailroute zeigt
 *    genau das, was die Liste dem Konto ohnehin zeigen wuerde.
 *
 * ### Warum 404 und nicht 403 bei fremder Session
 *
 * 403 bestaetigt, dass die Id zu *irgendwem* gehoert. Damit waere die Route ein
 * Orakel fuer die Existenz fremder Sessions. 404 macht "gehoert mir nicht" und
 * "gibt es nicht" ununterscheidbar — dieselbe Begruendung, die in
 * `app/api/terminal/owner-guard.ts` steht. Der Admin-Zweig steckt in
 * `isSessionOwnedBy` und in `isRpcSessionVisibleTo`, nicht hier: das sind die
 * zwei Stellen, an denen die Ausnahme gemacht wird, und eine dritte waere eine
 * Kopie.
 *
 * ### Fehlende Identitaet: 401, nicht 404
 *
 * Anders als beim Terminal-Guard, und das ist Absicht. Fehlende Identitaet ist
 * "wer bist du", nicht "gibt es das" — die Shell-Antwort passt nicht zu einem
 * Request ohne `x-omp-user`. Der Guard dafuer ist derselbe wie in den uebrigen
 * in dieser Sitzung gesicherten Routen: `requireIdentity` aus
 * `lib/request-identity.ts`, 401 und `Cache-Control: no-store`.
 *
 * ### Woher das Modul hier liegt
 *
 * Neben den Routen, die es schuetzt — so wie `app/api/terminal/owner-guard.ts`
 * neben den Terminal-Routen. Inhaltlich gehoert es zu `lib/session-reader.ts`,
 * weil es dessen Filter benutzt; der Auftrag dieser Runde lautete aber, nur
 * `app/api/sessions/` anzufassen. Der Ort ist also eine Auflage dieser Runde,
 * keine Entscheidung ueber die Architektur — beim Aufraeumen gehoert es neben
 * `isSessionOwnedBy` und wird von dort importiert.
 */
export async function requireSessionAccess(
  request: Request,
  sessionId: string,
): Promise<Response | null> {
  const identity = getRequestIdentity(request.headers);
  if (identity === null) {
    // Kann nach `getRequestIdentity` nicht null sein; die zweite Abfrage macht nur
    // die Fehlerform eindeutig `requireIdentity` statt einer Kopie davon hier.
    return requireIdentity(request);
  }

  if (isRpcSessionVisibleTo(sessionId, identity)) return null;

  const owned = await listAllSessions({ identity });
  if (owned.some((session) => session.id === sessionId)) return null;

  return NextResponse.json(
    { error: "Session not found" },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}