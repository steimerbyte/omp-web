import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { isPathWithinRoots } from "./path-security";
import { getUserHome, type WebIdentity } from "./request-identity";
import { resolveTenantAgentDir } from "./tenant-config";
import {
  isCalendarDate,
  isCalendarDateTime,
  MAX_CALENDAR_EVENTS,
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
  normalizeCalendarColor,
  validateEventRange,
  type CalendarEvent,
} from "./calendar";

/**
 * Die serverseitige Ablage des Kalenders, eine Datei pro Konto.
 *
 * ### Warum ueberhaupt eine Datei
 *
 * Der Kalender muss von *zwei* Seiten aus erreichbar sein: aus dem Browser
 * (die Oberflaeche) und aus dem Agenten (das Tool). Beide laufen im selben
 * Serverprozess — der Browser ueber eine API-Route, der Agent ueber ein
 * natives Tool in derselben Session. Eine Datei ist deshalb die einfachste
 * Form, die beide teilen, ohne dass ein zweiter Speicher (SQLite, Redis, ein
 * fremder Dienst) eingefuehrt werden muss.
 *
 * Und es ist dieselbe Form, die die Anwendung fuer alles andere benutzt, die
 * pro Konto liegt: `omp-web-quick-phrases.json` in `lib/quick-phrases-store.ts`,
 * `omp-web-projects.json` in `lib/projects-store.ts`. Drei Beispiele, eine
 * Regel: eine Datei pro Konto, im Agent-Verzeichnis, mit `omp-web-`-Praefix.
 *
 * ### Warum `resolveTenantAgentDir` und nicht ein neues Verzeichnis
 *
 * `lib/tenant-config.ts` beantwortet genau die Frage "welcher Pfad gehoert zu
 * diesem bereits festgestellten Benutzer" und macht das an *einer* Stelle.
 * Ein zweites `getUserHome`-Variant fuer Web-Daten wuerde die Mandantengrenze
 * aufspalten.
 *
 * Der Dateiname traegt das `omp-web-`-Praefix: die Datei liegt im
 * Agent-Verzeichnis, gehoert aber *nicht* omp. Das Praefix sagt das beim Lesen
 * im Verzeichnis, ohne dass man den Importgraphen aufmachen muss.
 *
 * ### Warum die Grenze trotzdem geprueft wird
 *
 * `resolveTenantAgentDir` ist die *Herleitung* des Pfades, nicht dessen
 * Abnahme. `isPathWithinRoots` fragt, ob der fertige Pfad tatsaechlich unter
 * der Home der Identitaet liegt — und das **vor** dem `mkdir`, wie in
 * `app/api/default-cwd/route.ts`. Ein Pfad, der erst erzeugt und dann geprueft
 * wird, hinterlaesst bei jeder verweigerten Anfrage eine Datei in fremder Home.
 */
const STORE_FILE = "omp-web-calendar.json";

/**
 * Der Pfad der Kalenderdatei einer Identitaet.
 *
 * Bewusst abgeleitet und nicht ueber einen globalen Pfad gebaut: der Pfad
 * haengt an der Identitaet, also wandert er mit dem Konto.
 */
export function getCalendarPath(identity: WebIdentity): string {
  return join(resolveTenantAgentDir(identity), STORE_FILE);
}

/**
 * `true`, wenn der Pfad der Kalenderdatei unterhalb der Konto-Home liegt.
 *
 * Fuer den Admin ist die Home `/` (siehe `getUserHome`), damit besteht diese
 * Pruefung fuer ihn immer — das ist dieselbe Formel, die auch fuer die
 * Quick Phrases gilt.
 */
export function isCalendarPathAllowed(identity: WebIdentity, path: string): boolean {
  return isPathWithinRoots(path, new Set([getUserHome(identity)]));
}

/**
 * Die gespeicherten Termine, oder `null`, wenn es noch keine Datei gibt.
 *
 * `null` ist nicht "leere Liste". Eine leere Liste ist eine Entscheidung des
 * Nutzers, die gespeichert wurde; `null` heisst "dieses Konto hat noch keinen
 * Kalender". Der Unterschied entscheidet, ob ein Seed stattfinden darf.
 *
 * Unlesbarer Inhalt (kaputtes JSON, falscher Typ) gilt wie "keine Datei" fuer
 * die Form, aber nicht fuer den Inhalt: es wird `[]` mit `exists: true`
 * zurueckgegeben. Ein Seed auf einen zerstoerten Bestand wuerde Termine
 * ueberschreiben, die der Nutzer weder sehen noch verteidigen kann.
 */
export function readCalendarFile(identity: WebIdentity): { exists: boolean; events: CalendarEvent[] } {
  const path = getCalendarPath(identity);
  if (!existsSync(path)) return { exists: false, events: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const list =
      typeof parsed === "object" && parsed !== null && "events" in parsed ? parsed.events : parsed;
    return { exists: true, events: normalizeCalendarEvents(list) };
  } catch {
    return { exists: true, events: [] };
  }
}

/**
 * Schreibt die Termine atomar und mit `0o600`.
 *
 * `writePrivateFileAtomicSync` legt eine Temp-Datei mit `wx` an und benennt
 * sie um; ein Absturz mitten im Schreiben hinterlaesst damit die alte Datei
 * und keine halbe. Das Verzeichnis wird vorher mit `0o700` erzeugt.
 *
 * Ungueltige Termine fallen vor dem Schreiben weg — ein Termin ohne Titel oder
 * ohne gueltiges Datum ist in der Oberflaeche nicht darstellbar und wuerde
 * dort nur einen zerbrochenen Block erzeugen.
 */
export function writeCalendarFile(identity: WebIdentity, events: unknown): CalendarEvent[] {
  const path = getCalendarPath(identity);
  const valid = normalizeCalendarEvents(events);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, JSON.stringify({ events: valid }, null, 2) + "\n");
  return valid;
}

/**
 * Die Termine, sortiert nach Beginn, bei gleichem Beginn nach Ende.
 *
 * Die Sortierung passiert **hier** und nicht in der Oberflaeche: die Monats-
 * und Wochenansicht brauchen dieselbe Reihenfolge, und der Agent, der die
 * Termine liest, soll sie auch bekommen. Zwei Sortierungen an zwei Stellen
 * waeren zwei Antworten auf dieselbe Frage.
 */
export function sortCalendarEvents(events: CalendarEvent[]): CalendarEvent[] {
  return [...events].sort((left, right) => {
    if (left.start !== right.start) return left.start < right.start ? -1 : 1;
    if (left.end !== right.end) return left.end < right.end ? -1 : 1;
    return left.title.localeCompare(right.title, "de");
  });
}

/**
 * Filtert eine Liste auf die gueltigen Termine und sortiert sie.
 *
 * ### Was hier geprueft wird
 *
 * Ein Termin ist gueltig, wenn:
 * - er eine Kennung, einen Titel, einen Beginn und ein Ende hat,
 * - der Beginn und das Ende gueltige Kalenderwerte sind (Datum oder
 *   Datum mit Zeit, jeweils ohne Zone),
 * - das Ende nicht vor dem Beginn liegt,
 * - der Ganztag-Flag zu den Werten passt: ein Ganztagestermin hat nur
 *   Datumswerte, ein Termin mit Uhrzeit hat Zeitwerte.
 *
 * ### Warum so streng
 *
 * Diese Funktion ist die einzige Stelle, an der ein Termin aus fremdem
 * Grund in die Datei kommt: aus dem Browser ueber die API und aus dem
 * Agenten ueber das Tool. Beide schreiben ungeprueft, wenn man sie laesst, und
 * eine Datei mit einem Termin ohne Datum laesst sich in der Oberflaeche nicht
 * darstellen — der Block waere eine leere Flaeche an einer Position, die aus
 * einer kaputten Zahl berechnet wurde.
 *
 * Zu viele Termine werden gekappt: `MAX_CALENDAR_EVENTS` ist eine Grenze, weil
 * die Datei sonst unbegrenzt wachsen kann und jede Anfrage sie komplett liest.
 */
export function normalizeCalendarEvents(value: unknown): CalendarEvent[] {
  if (!Array.isArray(value)) return [];
  const events: CalendarEvent[] = [];
  for (const entry of value) {
    const event = normalizeCalendarEvent(entry);
    if (event) events.push(event);
    if (events.length >= MAX_CALENDAR_EVENTS) break;
  }
  return sortCalendarEvents(events);
}

/**
 * Ein Termin aus ungeprueftem Material — oder `null`, wenn er unbrauchbar ist.
 *
 * ### Die Farbe
 *
 * Die Farbe wird uebernommen, aber nur, wenn sie eine Farbe ist: ein
 * Preset-Name oder ein Hex-Code. Eine kaputte Farbe wird **verworfen**, nicht
 * gespeichert — der Termin faellt dann auf die Voreinstellung zurueck, statt
 * mit Muell in der Datei zu liegen. Die Route prueft dieselbe Regel und
 * antwortet bei einer unbrauchbaren Farbe mit einem Fehler; diese Pruefung
 * hier schuetzt den Bestand, wenn die Datei von Hand geschrieben wurde.
 */
export function normalizeCalendarEvent(value: unknown): CalendarEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;

  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, MAX_TITLE_LENGTH) : "";
  if (!title) return null;

  const allDay = raw.allDay === true;
  const start = typeof raw.start === "string" ? raw.start.trim() : "";
  const end = typeof raw.end === "string" ? raw.end.trim() : "";
  if (!start || !end) return null;

  const startValid = allDay ? isCalendarDate(start) : isCalendarDateTime(start);
  const endValid = allDay ? isCalendarDate(end) : isCalendarDateTime(end);
  if (!startValid || !endValid) return null;

  if (validateEventRange(start, end, allDay)) return null;

  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString();
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt;

  const description =
    typeof raw.description === "string" ? raw.description.slice(0, MAX_TEXT_LENGTH) : undefined;
  const location = typeof raw.location === "string" ? raw.location.slice(0, MAX_TEXT_LENGTH) : undefined;
  const color = normalizeCalendarColor(raw.color);

  return {
    id,
    title,
    ...(description ? { description } : {}),
    ...(location ? { location } : {}),
    ...(color ? { color } : {}),
    start,
    end,
    allDay,
    createdAt,
    updatedAt,
  };
}

/**
 * Die gespeicherte Farbe eines Termins — Preset-Name oder Hex-Code.
 *
 * Der Wert kommt aus der Datei und ist deshalb *Datenhaltung*: der Nutzer
 * hat diese Farbe gewaehlt, und sie soll den Theme-Wechsel ueberleben. Fuer
 * die *Anzeige* ist `resolveEventColor` aus `lib/calendar.ts` zustaendig.
 */
export function calendarEventColor(event: CalendarEvent): string | undefined {
  return normalizeCalendarColor(event.color);
}

declare global {
  /**
   * Die Abonnenten der Kalender-Aenderungen.
   *
   * `globalThis` und nicht ein Modul-`Set`: `AGENTS.md` ist ausdruecklich
   * darauf hin, dass der Entwicklungsserver die Module bei jeder Aenderung neu
   * laedt, und ein `Set` im Modul waere nach dem Reload wieder leer — die
   * offene SSE-Verbindung im Browser bekomme dann nie wieder eine Meldung.
   * `lib/rpc-manager.ts` haelt seinen Session-Register und seine
   * Start-Sperren genauso.
   */
  var __ompCalendarListeners: Set<(identity: WebIdentity) => void> | undefined;
}

/**
 * Die Abonnenten der Kalender-Aenderungen.
 */
function getCalendarListeners(): Set<(identity: WebIdentity) => void> {
  if (!globalThis.__ompCalendarListeners) globalThis.__ompCalendarListeners = new Set();
  return globalThis.__ompCalendarListeners;
}

/**
 * Meldet, dass sich der Kalender eines Kontos geaendert hat.
 *
 * ### Warum die Identitaet mitgeschickt wird
 *
 * Der Prozess bedient mehrere Konten, und die Datei eines Kontos liegt im
 * Verzeichnis *dieses* Kontos. Ein Aenderungs-Vorgang ohne Kontoangabe
 * wuerde daher bei jedem Abonnenten eine Meldung ausloesen — auch beim
 * Mandanten, dessen Kalender sich gar nicht geaendert hat.
 *
 * Der Abonnent filtert selbst, genau wie es `subscribeRunningSessions` in
 * `lib/rpc-manager.ts` tut: was der eine als fremd sieht, ist beim Admin
 * seine eigene, und das laesst sich nicht in einem prozess-globalen Broadcast
 * entscheiden.
 */
export function notifyCalendarChange(identity: WebIdentity): void {
  for (const listener of getCalendarListeners()) {
    try {
      listener(identity);
    } catch {
      // Ein Abonnent, der schon geschlossen ist, darf den anderen nicht stoeren.
    }
  }
}

/**
 * Abonniert die Kalender-Aenderungen des Prozesses.
 *
 * @returns Eine Funktion, die das Abonnieren beendet.
 */
export function subscribeCalendarChanges(listener: (identity: WebIdentity) => void): () => void {
  const listeners = getCalendarListeners();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
