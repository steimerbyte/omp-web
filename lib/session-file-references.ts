import { getSessionEntries, resolveSessionPath, resolveSessionPathForIdentity } from "./session-reader";
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
 * Ohne Identitaet ist die Antwort `false`, nicht `true` und nicht `null`:
 * `resolveSessionPathForIdentity` gibt ohne Identitaet `null` zurueck, und ein
 * vergessener Aufrufer darf daraus keine Freischaltung bauen koennen.
 */
export async function isFilePathReferencedBySession(
  filePath: string,
  sessionId: string | null,
  identity: WebIdentity | null,
): Promise<boolean> {
  if (!identity) return false;
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
 * **dieser** Identitaet? Dieselbe Bindung wie oben, dieselbe Begruendung.
 */
export async function isBashOutputPathReferencedBySession(
  filePath: string,
  sessionId: string | null,
  identity: WebIdentity | null,
): Promise<boolean> {
  if (!identity) return false;
  if (!isValidSessionId(sessionId)) return false;
  try {
    const sessionPath = identity
      ? await resolveSessionPathForIdentity(sessionId, identity)
      : await resolveSessionPath(sessionId);
    if (!sessionPath) return false;
    return isBashOutputPathReferencedByEntries(filePath, await getSessionEntries(sessionPath));
  } catch {
    return false;
  }
}