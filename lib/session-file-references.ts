import { getSessionEntries, resolveSessionPathForIdentity } from "./session-reader";
export { isFilePathReferencedByEntries } from "./session-file-references-core";
import {
  isBashOutputPathReferencedByEntries,
  isFilePathReferencedByEntries,
  isValidSessionId,
} from "./session-file-references-core";
import type { WebIdentity } from "./request-identity";

/**
 * Steht `filePath` in einer Session **dieser** Identitaet?
 *
 * Die Identitaet ist ein Pflichtargument und nicht ein Zusatz: eine Session-Id
 * ist aus dem Aufruf waehlbar, also beantwortet eine Abfrage ohne Identitaet die
 * Frage "steht der Pfad in *irgendeiner* Session auf diesem Host" — und genau
 * damit wurde aus einem Leser ein vollstaendiger Mandanten-Bypass. Der Pfad
 * selbst kommt hierher freiwillig aus der URL, die Session-Id aus dem
 * Query-String; beides sind Angaben des Aufrufers, und beides wird hier gegen
 * den Request-Header geprueft, den nur `proxy.ts` setzt.
 *
 * Der Typ von `identity` ist `WebIdentity`, nicht `WebIdentity | null`: ein
 * Aufrufer ohne Identitaet hat die Anfrage schon mit 403 beantwortet und
 * erreicht diese Funktion nicht. Wer das nicht mehr kontrollieren kann, soll den
 * Typ wieder auf `| null` setzen und `if (!identity) return false;`
 * zurueckbringen — dann aber auch im Kommentar sagen, dass der Check eine
 * Laufzeitverteidigung ist, keine Tatsache ueber den Aufrufer.
 */
export async function isFilePathReferencedBySession(
  filePath: string,
  sessionId: string | null,
  identity: WebIdentity,
): Promise<boolean> {
  if (!isValidSessionId(sessionId)) return false;
  try {
    const sessionPath = await resolveSessionPathForIdentity(sessionId, identity);
    if (!sessionPath) return false;
    return isFilePathReferencedByEntries(filePath, await getSessionEntries(sessionPath));
  } catch {
    return false;
  }
}

/**
 * Steht `filePath` als `fullOutputPath` einer Bash-Ausfuehrung in einer Session
 * **dieser** Identitaet? Dieselbe Bindung wie oben, dieselbe Begruendung, und
 * derselbe nicht nullable Identitaetstyp — der Aufrufer in
 * `app/api/agent/[id]/bash-output/route.ts` gibt ohne Identitaet 403 zurueck.
 */
export async function isBashOutputPathReferencedBySession(
  filePath: string,
  sessionId: string | null,
  identity: WebIdentity,
): Promise<boolean> {
  if (!isValidSessionId(sessionId)) return false;
  try {
    const sessionPath = await resolveSessionPathForIdentity(sessionId, identity);
    if (!sessionPath) return false;
    return isBashOutputPathReferencedByEntries(filePath, await getSessionEntries(sessionPath));
  } catch {
    return false;
  }
}