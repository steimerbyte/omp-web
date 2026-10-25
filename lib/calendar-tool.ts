import { Type } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox";
import { defineTool } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import {
  formatGermanDate,
  germanWeekdayName,
  GERMAN_WEEKDAYS_SHORT,
  isCalendarDate,
  isCalendarDateTime,
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
  validateEventRange,
  type CalendarEvent,
} from "./calendar";
import {
  notifyCalendarChange,
  readCalendarFile,
  writeCalendarFile,
} from "./calendar-store";
import type { WebIdentity } from "./request-identity";
import { randomUUID } from "crypto";

/**
 * `calendar_read` und `calendar_write` — der Agent liest und schreibt den
 * Kalender des Kontos, in dessen Sitzung er laeuft.
 *
 * ### Warum das ein natives Tool ist und keine Extension
 *
 * Dasselbe Argument wie bei `present_files` in `lib/present-files-tool.ts`:
 * Die Definition wird ueber `CreateAgentSessionOptions.customTools` an das SDK
 * gereicht, also ist das Tool in *jeder* Sitzung vorhanden. Eine Datei unter
 * `.omp/extensions` waere davon abhaengig, ob das Projekt sie ueberhaupt
 * freigibt — und der Kalender gehoert dem Konto, nicht dem Projekt.
 *
 * ### Warum der `defineTool`-Marker noetig ist
 *
 * Ohne den Marker behandelt das SDK den Eintrag als `CustomTool` und bridged
 * ihn mit einer *anderen* Argumentreihenfolge fuer `execute` um. Dieselbe
 * Falle steht in `lib/present-files-tool.ts` beschrieben.
 *
 * ### Warum die Identitaet mit hereingereicht wird
 *
 * Der Kalender liegt pro Konto in einer eigenen Datei. Das Tool laeuft im
 * Serverprozess und hat keinen Request, aus dem es die Identitaet lesen
 * koennte — es kennt nur die Sitzung. Deshalb wird die Identitaet beim
 * Start der Sitzung festgehalten und hier eingeschlossen: das Tool kann nur
 * den Kalender des Kontos sehen, das die Sitzung geoeffnet hat. Ohne diese
 * Bindung wuerde ein Agent eines Mandanten den globalen Kalender des
 * Betreibers lesen und schreiben.
 */

/** Die Identitaet, an die das Tool gebunden ist. */
export interface CalendarToolContext {
  /**
   * Das Konto, dessen Kalender das Tool liest und schreibt.
   *
   * `null` heisst: es gibt kein Konto. Der Kalender gehoert immer einem
   * Konto, und ohne Konto gibt es keinen — die Werkzeuge sagen das dann auch
   * deutlich, statt in den Kalender des Betreibers zu greifen.
   */
  identity: WebIdentity | null | undefined;
}

/**
 * Die Zusammenfassung eines Termins fuer das Modell.
 *
 * Deutsch, weil der Kalender ein deutsches Kalender ist: der Nutzer liest
 * dieses Text im Chatverlauf, und ein deutscher Kalender, dessen Werkzeug
 * englisch spricht, ist genau die halbe Loesung.
 */
function describeEvent(event: CalendarEvent): string {
  // Die Formatierer erwarten ein *Datum* (`YYYY-MM-DD`), die Felder des
  // Termins duerfen aber ein Datum *mit* Zeit enthalten (`YYYY-MM-DDTHH:mm`).
  // Ohne das Abschneiden landet die Uhrzeit im Tagesfeld — und der Wochentag
  // wird zu "undefined", weil `germanWeekdayName` an der falschen Stelle
  // abschneidet.
  const startDate = event.start.slice(0, 10);
  const endDate = event.end.slice(0, 10);
  const when = event.allDay
    ? `${formatGermanDate(startDate)}${endDate !== startDate ? ` – ${formatGermanDate(endDate)}` : ""} (ganztägig)`
    : `${formatGermanDate(startDate)}, ${event.start.slice(11)}–${event.end.slice(11)} Uhr`;
  const lines = [`- ${event.title} | ${germanWeekdayName(startDate)}, ${when}`];
  if (event.location) lines.push(`  Ort: ${event.location}`);
  if (event.description) lines.push(`  Notiz: ${event.description.replace(/\n/g, " ")}`);
  lines.push(`  ID: ${event.id}`);
  return lines.join("\n");
}

/**
 * Die Kalender-Tools fuer eine Sitzung.
 *
 * Eine Fabrik und keine Konstante: die Definition wird einmal pro Sitzung
 * gebaut (so wie `pi-web-ui` das mit seinem eigenen `present_files` macht) und
 * schliesst die Identitaet ein.
 */
export function makeCalendarTools(context: CalendarToolContext) {
  const { identity } = context;

  /**
   * Der Kalender dieses Kontos, oder ein Fehler, der sagt, warum nicht.
   *
   * Die Meldung ist an den *Agenten* gerichtet: er soll nicht raten, warum
   * das Werkzeug nicht funktioniert, sondern es dem Nutzer erklaeren koennen.
   */
  const requireIdentity = (): WebIdentity => {
    if (!identity) {
      throw new Error(
        "Dieser Kalender gehoert zu einem angemeldeten Konto, und diese Sitzung hat keins. " +
        "Der Kalender ist nur in einer Sitzung nutzbar, die ueber das Web mit einem Konto geoeffnet wurde.",
      );
    }
    return identity;
  };

  const readTool = defineTool({
    name: "calendar_read",
    label: "Kalender lesen",
    description:
      "Lies die Termine des Kalenders dieses Kontos. Ohne Parameter kommen alle Termine, " +
      "sortiert nach Beginn. Mit 'from' und 'to' (YYYY-MM-DD) nur die Termine in diesem Zeitraum. " +
      "Die Termine kommen in deutscher Schreibweise zurueck, mit Kennung, damit sie danach geaendert " +
      "oder geloescht werden koennen. Nutze dieses Werkzeug, bevor du ueber Termine sprichst — " +
      "nicht aus dem Gedaechtnis, sondern aus dem Kalender.",
    approval: "read",
    loadMode: "essential",
    parameters: Type.Object({
      from: Type.Optional(Type.String({
        description: "Nur Termine ab diesem Tag (YYYY-MM-DD).",
      })),
      to: Type.Optional(Type.String({
        description: "Nur Termine bis zu diesem Tag (YYYY-MM-DD), einschliesslich.",
      })),
    }),

    async execute(_toolCallId, params) {
      const owner = requireIdentity();
      const { events } = readCalendarFile(owner);

      const from = params.from?.trim();
      const to = params.to?.trim();
      if (from && !isCalendarDate(from)) {
        throw new Error(`'from' muss ein Datum im Format YYYY-MM-DD sein, war aber '${from}'.`);
      }
      if (to && !isCalendarDate(to)) {
        throw new Error(`'to' muss ein Datum im Format YYYY-MM-DD sein, war aber '${to}'.`);
      }

      const filtered = events.filter((event) => {
        const eventStart = event.start.slice(0, 10);
        const eventEnd = event.end.slice(0, 10);
        if (from && eventEnd < from) return false;
        if (to && eventStart > to) return false;
        return true;
      });

      if (filtered.length === 0) {
        const range = from && to ? ` zwischen ${formatGermanDate(from)} und ${formatGermanDate(to)}` : "";
        return {
          content: [{ type: "text" as const, text: `Im Kalender steht${range} kein Termin.` }],
        };
      }

      const count = filtered.length;
      const header = `${count} Termin${count === 1 ? "" : "e"} im Kalender:\n`;
      return {
        content: [{ type: "text" as const, text: header + filtered.map(describeEvent).join("\n") }],
      };
    },
  });

  const writeTool = defineTool({
    name: "calendar_write",
    label: "Kalender schreiben",
    description:
      "Legt Termine im Kalender dieses Kontos an, aendert sie oder loescht sie. " +
      "'create' braucht title, start und end; 'update' braucht die id des Termins und nur die Felder, " +
      "die sich aendern sollen; 'delete' braucht nur die id. " +
      "Zeiten sind lokal und ohne Zone: ganztaegig als '2026-03-14', mit Uhrzeit als '2026-03-14T15:00'. " +
      "Bei einem Ganztagestermin ist 'end' der letzte Tag (einschliesslich), nicht der Tag danach. " +
      "Nutze dieses Werkzeug, wenn der Nutzer einen Termin anlegen, verschieben, aendern oder " +
      "absagen will — und nenne danach im Chat, was du getan hast.",
    approval: "write",
    loadMode: "essential",
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("create"), Type.Literal("update"), Type.Literal("delete")],
        { description: "Was mit dem Termin geschehen soll." },
      ),
      id: Type.Optional(Type.String({
        description: "Die Kennung des Termins — noetig fuer 'update' und 'delete'. Bekommst du aus calendar_read.",
      })),
      title: Type.Optional(Type.String({
        description: "Der Titel des Termins. Pflicht fuer 'create'.",
      })),
      start: Type.Optional(Type.String({
        description: "Beginn: '2026-03-14' (ganztaegig) oder '2026-03-14T15:00' (mit Uhrzeit). Pflicht fuer 'create'.",
      })),
      end: Type.Optional(Type.String({
        description: "Ende, im selben Format wie 'start'. Pflicht fuer 'create'.",
      })),
      allDay: Type.Optional(Type.Boolean({
        description: "true fuer einen Ganztagestermin. Ohne Angabe wird aus der Schreibweise von start und end geschlossen.",
      })),
      description: Type.Optional(Type.String({
        description: "Optionale Notiz zum Termin.",
      })),
      location: Type.Optional(Type.String({
        description: "Optionaler Ort des Termins.",
      })),
    }),

    async execute(_toolCallId, params) {
      const owner = requireIdentity();
      const { events } = readCalendarFile(owner);

      if (params.action === "create") {
        const title = params.title?.trim().slice(0, MAX_TITLE_LENGTH);
        if (!title) throw new Error("Ein neuer Termin braucht einen Titel.");
        const start = params.start?.trim() ?? "";
        const end = params.end?.trim() ?? "";
        if (!start || !end) {
          throw new Error("Ein neuer Termin braucht einen Beginn und ein Ende.");
        }
        // Der Ganztag-Flag wird aus der Schreibweise geschlossen, wenn er nicht
        // ausdruecklich da ist: '2026-03-14' ist ein Datum, '2026-03-14T15:00'
        // ist ein Zeitpunkt. Sonst muesste das Modell beides angeben und
        // koennte sich widersprechen.
        const allDay = params.allDay ?? !start.includes("T");
        const startValid = allDay ? isCalendarDate(start) : isCalendarDateTime(start);
        const endValid = allDay ? isCalendarDate(end) : isCalendarDateTime(end);
        if (!startValid || !endValid) {
          throw new Error(
            allDay
              ? "Beginn und Ende eines Ganztagestermins muessen Datumsangaben sein (YYYY-MM-DD)."
              : "Beginn und Ende eines Termins mit Uhrzeit muessen Zeitangaben sein (YYYY-MM-DDTHH:mm).",
          );
        }
        const rangeError = validateEventRange(start, end, allDay);
        if (rangeError) throw new Error(rangeError);

        const now = new Date().toISOString();
        const created: CalendarEvent = {
          id: randomUUID(),
          title,
          start,
          end,
          allDay,
          ...(params.description ? { description: params.description.slice(0, MAX_TEXT_LENGTH) } : {}),
          ...(params.location ? { location: params.location.slice(0, MAX_TEXT_LENGTH) } : {}),
          createdAt: now,
          updatedAt: now,
        };
        writeCalendarFile(owner, [...events, created]);
        notifyCalendarChange(owner);
        return {
          content: [{
            type: "text" as const,
            text: `Termin angelegt: ${describeEvent(created)}\nDer Kalender des Nutzers ist jetzt aktualisiert.`,
          }],
        };
      }

      const id = params.id?.trim();
      if (!id) {
        throw new Error(`Fuer '${params.action}' wird die id des Termins gebraucht — bitte zuerst calendar_read aufrufen.`);
      }
      const existing = events.find((event) => event.id === id);
      if (!existing) {
        throw new Error(
          `Es gibt keinen Termin mit der Kennung '${id}'. ` +
          `Mit calendar_read laesst sich die richtige Kennung finden.`,
        );
      }

      if (params.action === "delete") {
        writeCalendarFile(owner, events.filter((event) => event.id !== id));
        notifyCalendarChange(owner);
        return {
          content: [{
            type: "text" as const,
            text: `Termin geloescht: ${existing.title} am ${formatGermanDate(existing.start)}. ` +
              `Der Kalender des Nutzers ist jetzt aktualisiert.`,
          }],
        };
      }

      // 'update': nur die genannten Felder aendern. Das Verschieben ist
      // derselbe Aufruf mit neuem start und end.
      const allDay = params.allDay ?? existing.allDay;
      const start = params.start?.trim() ?? existing.start;
      const end = params.end?.trim() ?? existing.end;
      const startValid = allDay ? isCalendarDate(start) : isCalendarDateTime(start);
      const endValid = allDay ? isCalendarDate(end) : isCalendarDateTime(end);
      if (!startValid || !endValid) {
        throw new Error(
          allDay
            ? "Beginn und Ende eines Ganztagestermins muessen Datumsangaben sein (YYYY-MM-DD)."
            : "Beginn und Ende eines Termins mit Uhrzeit muessen Zeitangaben sein (YYYY-MM-DDTHH:mm).",
        );
      }
      const rangeError = validateEventRange(start, end, allDay);
      if (rangeError) throw new Error(rangeError);

      const title = params.title === undefined
        ? existing.title
        : params.title.trim().slice(0, MAX_TITLE_LENGTH);
      if (!title) throw new Error("Der Titel eines Termins darf nicht leer sein.");

      const updated: CalendarEvent = {
        ...existing,
        title,
        start,
        end,
        allDay,
        ...(params.description !== undefined ? { description: params.description.slice(0, MAX_TEXT_LENGTH) } : {}),
        ...(params.location !== undefined ? { location: params.location.slice(0, MAX_TEXT_LENGTH) } : {}),
        updatedAt: new Date().toISOString(),
      };
      writeCalendarFile(owner, events.map((event) => (event.id === id ? updated : event)));
      notifyCalendarChange(owner);
      return {
        content: [{
          type: "text" as const,
          text: `Termin geaendert: ${describeEvent(updated)}\nDer Kalender des Nutzers ist jetzt aktualisiert.`,
        }],
      };
    },
  });

  return [readTool, writeTool];
}

/**
 * Die Wochentagsnamen der Woche, in der ein Datum liegt — fuer die Kopfzeile
 * der Wochenansicht im Werkzeug.
 *
 * Exportiert, weil die Oberflaeche dieselbe Reihenfolge braucht und eine
 * eigene Kopie der Wochentagsnamen ein zweiter Ort waere, an dem sie
 * veralten.
 */
export { GERMAN_WEEKDAYS_SHORT };
