import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { isPathWithinRoots } from "./path-security";
import { getUserHome, type WebIdentity } from "./request-identity";
import { resolveTenantAgentDir } from "./tenant-config";
import { normalizeNewsletters, type Newsletter } from "./newsletter";

/**
 * Die serverseitige Ablage der Newsletter, eine Datei pro Konto.
 *
 * Dieselbe Form wie `lib/calendar-store.ts` und `lib/quick-phrases-store.ts`:
 * eine JSON-Datei im Agent-Verzeichnis des Kontos, mit `omp-web-`-Praefix,
 * Pfad ueber `resolveTenantAgentDir`, Grenze ueber `isPathWithinRoots`,
 * Schreiben ueber `writePrivateFileAtomicSync`.
 *
 * Der Zeitplan selbst liegt *nicht* hier, sondern in
 * `omp-web-scheduled-tasks.json`: der Datensatz traegt nur `taskId` und wird
 * beim Lesen mit dem Stand der Aufgabe verbunden. Zwei Kopien des Cron waeren
 * zwei Wahrheiten.
 *
 * Kein `schemaVersion`-Feld wie in den geplanten Aufgaben: dieses Format hat
 * genau eine Fassung und keinen Migrationspfad. Was gelesen werden kann, wird
 * gelesen; unbrauchbare Zeilen fallen beim Normalisieren weg und stehen beim
 * naechsten Schreiben nicht mehr in der Datei.
 */
const STORE_FILE = "omp-web-newsletters.json";

/**
 * Der Pfad der Newsletter-Datei einer Identitaet.
 *
 * Bewusst abgeleitet und nicht ueber einen globalen Pfad gebaut: der Pfad
 * haengt an der Identitaet, also wandert er mit dem Konto.
 */
export function getNewsletterPath(identity: WebIdentity): string {
  return join(resolveTenantAgentDir(identity), STORE_FILE);
}

/**
 * `true`, wenn der Pfad der Newsletter-Datei unterhalb der Konto-Home liegt.
 *
 * Fuer den Admin ist die Home `/` (siehe `getUserHome`), damit besteht diese
 * Pruefung fuer ihn immer — dieselbe Formel wie fuer Kalender und Phrasen.
 */
export function isNewsletterPathAllowed(identity: WebIdentity, path: string): boolean {
  return isPathWithinRoots(path, new Set([getUserHome(identity)]));
}

/**
 * Die gespeicherten Newsletter und was der Datei-Kopf sagt.
 *
 * `exists` ist nicht `newsletters.length > 0`: ein Konto, das alle Newsletter
 * geloescht hat, hat eine Datei mit leerer Liste. Unlesbarer Inhalt gilt wie
 * "keine Datei" fuer die Form, aber nicht fuer den Bestand — es wird `[]` mit
 * `exists: true` zurueckgegeben, damit ein spaeterer Seed nicht auf einen
 * zerstoerten Bestand schreibt.
 */
export function readNewsletterFile(identity: WebIdentity): { exists: boolean; newsletters: Newsletter[] } {
  const path = getNewsletterPath(identity);
  if (!existsSync(path)) return { exists: false, newsletters: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const list =
      typeof parsed === "object" && parsed !== null && "newsletters" in parsed ? parsed.newsletters : parsed;
    return { exists: true, newsletters: normalizeNewsletters(list) };
  } catch {
    return { exists: true, newsletters: [] };
  }
}

/**
 * Schreibt die Newsletter atomar und mit `0o600`.
 *
 * `writePrivateFileAtomicSync` legt eine Temp-Datei mit `wx` an und benennt sie
 * um; ein Absturz mitten im Schreiben hinterlaesst damit die alte Datei und
 * keine halbe. Das Verzeichnis wird vorher mit `0o700` erzeugt.
 *
 * Unbrauchbare Eintraege fallen vor dem Schreiben weg — ein Newsletter ohne
 * Themen oder ohne Aufgabe waere ein Eintrag, den die uebersicht nicht
 * darstellen und der Agent nicht ausfuellen kann.
 */
export function writeNewsletterFile(identity: WebIdentity, newsletters: unknown): Newsletter[] {
  const path = getNewsletterPath(identity);
  const valid = normalizeNewsletters(newsletters);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, JSON.stringify({ newsletters: valid }, null, 2) + "\n");
  return valid;
}
