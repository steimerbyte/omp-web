import { Type } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox";
import { defineTool } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import {
  addDays,
  CALENDAR_COLOR_PRESET_LABELS,
  CALENDAR_COLOR_PRESETS,
  dateToDayNumber,
  dayNumberToDate,
  formatGermanDate,
  germanWeekdayName,
  GERMAN_WEEKDAYS_SHORT,
  isCalendarColorPreset,
  isCalendarDate,
  isCalendarDateTime,
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
  minutesToTime,
  normalizeCalendarColor,
  startOfWeek,
  timeToMinutes,
  validateEventRange,
  weekdayIndex,
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
 * Die Farbe eines Termins fuer die deutsche Rueckmeldung: der deutsche Name
 * des Presets oder — bei einer eigenen Farbe — der Hex-Code selbst.
 *
 * Die deutschen Namen kommen aus der Domaene (`CALENDAR_COLOR_PRESET_LABELS`),
 * damit die Dialog-Komponente und diese Ausgabe dieselben fuenf Woerter
 * nennen. Sie stehen dort aus demselben Grund wie die Monats- und
 * Wochentagsnamen: es ist ein festes Vokabular des Kalenders, das in jeder
 * Sprache des Programms deutsch ist — der i18n-Katalog ist der Katalog der
 * Oberflaeche und haengt an der eingestellten Sprache.
 *
 * Ohne Farbe traegt der Termin die Voreinstellung; die wird nicht genannt,
 * denn sie steht an jedem Termin.
 */
function colorLabel(event: CalendarEvent): string | undefined {
  const color = normalizeCalendarColor(event.color);
  if (color === undefined) return undefined;
  if (isCalendarColorPreset(color)) return CALENDAR_COLOR_PRESET_LABELS[color];
  return color;
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
    // Ein Termin ueber den Tageswechsel laeuft: dann stehen beide Tage in der
    // Zeile — sonst sieht der Nutzer am zweiten Tag nicht, dass der Termin
    // dort noch laeuft.
    : endDate === startDate
      ? `${formatGermanDate(startDate)}, ${event.start.slice(11)}–${event.end.slice(11)} Uhr`
      : `${formatGermanDate(startDate)}, ${event.start.slice(11)} – ${formatGermanDate(endDate)}, ${event.end.slice(11)} Uhr`;
  const label = colorLabel(event);
  const lines = [`- ${event.title}${label ? ` (${label})` : ""} | ${germanWeekdayName(startDate)}, ${when}`];
  if (event.location) lines.push(`  Ort: ${event.location}`);
  if (event.description) lines.push(`  Notiz: ${event.description.replace(/\n/g, " ")}`);
  lines.push(`  ID: ${event.id}`);
  return lines.join("\n");
}

/**
 * Bringt eine Angabe mit Uhrzeit in die kanonische Schreibweise `YYYY-MM-DDTHH:mm`.
 *
 * Das Modell schreibt die Leerzeichenform (`2026-10-26 15:00`) oft genug, dass
 * eine Ablehnung jedes Mal einen Rundlauf gekostet haette. Die Umrechnung
 * betrifft nur die *Eingabe* — gespeichert wird immer die kanonische Form.
 */
function normalizeDateTime(value: string): string {
  return value.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/, "$1T$2");
}

/** Die Minuten eines Tages. */
const MINUTES_PER_DAY = 1440;

/**
 * Die Dauer eines Termins in Minuten.
 *
 * Dieselbe Definition wie `eventDurationMinutes` in
 * `components/calendar/calendar-model.ts`: ein Ganztagestermin belegt volle
 * Tage, ein Termin mit Uhrzeit die tatsaechliche Spanne — auch dann, wenn sie
 * ueber Mitternacht laeuft. Werkzeug und Oberflaeche muessen dasselbe rechnen,
 * sonst landet ein verschobener Termin an einer anderen Stelle als erwartet.
 */
function durationMinutes(event: CalendarEvent): number {
  if (event.allDay) {
    return durationDays(event) * MINUTES_PER_DAY;
  }
  return absoluteMinutes(event.end) - absoluteMinutes(event.start);
}

/**
 * Die Dauer eines Ganztagestermins in Tagen — das Ende ist der letzte Tag,
 * ein einzelner Tag also ein Tag.
 */
function durationDays(event: CalendarEvent): number {
  return dateToDayNumber(event.end.slice(0, 10)) - dateToDayNumber(event.start.slice(0, 10)) + 1;
}

/** Die Minuten seit Mitternacht, absolut gerechnet — auch ueber Tage hinweg. */
function absoluteMinutes(dateTime: string): number {
  return dateToDayNumber(dateTime.slice(0, 10)) * MINUTES_PER_DAY + timeToMinutes(dateTime.slice(11));
}

/** Das Gegenstueck zu `absoluteMinutes`: absolute Minuten als Datum mit Uhrzeit. */
function fromAbsoluteMinutes(minutes: number): string {
  const day = Math.floor(minutes / MINUTES_PER_DAY);
  return `${dayNumberToDate(day)}T${minutesToTime(minutes - day * MINUTES_PER_DAY)}`;
}

/**
 * Die Dauer des bestehenden Termins in der Einheit, in die verschoben wird.
 *
 * Beim Wechsel zwischen Ganztagestermin und Termin mit Uhrzeit gibt es keine
 * gemeinsame Einheit. Der Wechsel wird so aufgeloest, wie es die Oberflaeche
 * macht: ein Ganztagestermin, der auf eine Uhrzeit gezogen wird, wird zu einem
 * Termin von 60 Minuten (`moveEventToSlot`); ein Termin mit Uhrzeit, der zum
 * Ganztagestermin wird, belegt so viele ganze Tage, wie er braucht.
 */
function durationInDays(existing: CalendarEvent): number {
  if (existing.allDay) return durationDays(existing);
  return Math.max(1, Math.ceil(durationMinutes(existing) / MINUTES_PER_DAY));
}

/** Die Dauer in Minuten, in der Einheit eines Termins mit Uhrzeit. */
function durationInMinutes(existing: CalendarEvent): number {
  if (!existing.allDay) return durationMinutes(existing);
  return 60;
}

/**
 * Das Ende eines verschobenen Termins — die Dauer des bestehenden Termins wird
 * vom neuen Beginn aus weitergerechnet.
 */
function shiftedEnd(existing: CalendarEvent, newStart: string, allDay: boolean): string {
  if (allDay) {
    return addDays(newStart.slice(0, 10), durationInDays(existing) - 1);
  }
  return fromAbsoluteMinutes(absoluteMinutes(newStart) + durationInMinutes(existing));
}

/**
 * Der Beginn eines verschobenen Termins — die Dauer des bestehenden Termins
 * wird vom neuen Ende aus zurueckgerechnet.
 */
function shiftedStart(existing: CalendarEvent, newEnd: string, allDay: boolean): string {
  if (allDay) {
    return addDays(newEnd.slice(0, 10), -(durationInDays(existing) - 1));
  }
  return fromAbsoluteMinutes(absoluteMinutes(newEnd) - durationInMinutes(existing));
}

/**
 * Der heutige Tag als `YYYY-MM-DD` — der *lokale* Tag, nicht der UTC-Tag.
 *
 * `toISOString()` rechnet in UTC und waere in Mitteleuropa nach 22 Uhr der
 * Vortag; das Kalenderformat kennt keine Zeitzonen, also zaehlt der lokale
 * Tag. Dieselbe Rechnung wie `todayDateString` in
 * `components/calendar/calendar-model.ts`.
 */
function todayDateString(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Die Wochentagsnamen auf Englisch — fuer die Meldungen an das Modell.
 *
 * Deutsch sind sie in `lib/calendar.ts`; das Modell liest die englischen
 * Fehlermeldungen, und ein gemischter Satz ("Today is Montag") liest sich
 * falsch.
 */
const ENGLISH_WEEKDAYS = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
];

/** Ein Tag mit kurzem Wochentagsnamen: 'Mo 26.10.2026'. */
function weekdayLabel(date: string): string {
  return `${GERMAN_WEEKDAYS_SHORT[weekdayIndex(date)]} ${formatGermanDate(date)}`;
}

/**
 * Ein Terminzeitpunkt fuer den deutschen Ergebnis-Text: bei einem Termin mit
 * Uhrzeit Datum *und* Uhrzeit, bei einem Ganztagestermin nur das Datum.
 *
 * `formatGermanDate` erwartet ein reines Datum (`YYYY-MM-DD`) und zerlegt
 * einen String mit Uhrzeit an den Bindestrichen — deshalb wird vorher
 * abgeschnitten.
 */
function eventWhen(event: CalendarEvent): string {
  const startDate = event.start.slice(0, 10);
  return event.allDay
    ? formatGermanDate(startDate)
    : `${formatGermanDate(startDate)}, ${event.start.slice(11)} Uhr`;
}

/**
 * Der Anker, mit dem der Ergebnis-Text beginnt: heute, der Wochentag und der
 * Bereich der aktuellen und der naechsten Kalenderwoche.
 *
 * Das Kalenderformat kennt keine Zeitzone — "heute" ist der lokale Tag. Und
 * genau der ist die Groesse, an der sich "diese Woche" festmachen laesst:
 * ohne diesen Anker muss das Modell das Datum selbst bestimmen (im Extremfall
 * ueber ein Shell-Kommando) und rutscht dabei auf die falsche Woche — die Woche,
 * die gerade endet, statt der, die der Nutzer meint.
 *
 * Die Woche beginnt am Montag, wie in `startOfWeek` aus `lib/calendar.ts`.
 *
 * ### Warum "Kalenderwoche" und nicht "Woche"
 *
 * "Kalenderwoche" ist im Deutschen der etablierte Begriff fuer die
 * ISO-Woche (KW) — die Anwendung selbst schreibt "KW 11" in die Kopfzeile.
 * "Diese Woche" meint im Gespraech dagegen die laufende Woche, und genau
 * diese Verwechslung hat ein Agent produziert: er las die Zeile "Nächste
 * Woche", fragte zwei Wochen breit und nannte dann eine davon die falsche.
 * Der Anker sagt deshalb beide Male "Kalenderwoche" — ein Begriff, den es
 * nur einmal gibt.
 */
function todayAnchor(today: string): string {
  const monday = startOfWeek(today);
  return (
    `Heute ist ${germanWeekdayName(today)}, ${formatGermanDate(today)}.\n` +
    `Diese Kalenderwoche: ${weekdayLabel(monday)} – ${weekdayLabel(addDays(monday, 6))}.\n` +
    `Nächste Kalenderwoche: ${weekdayLabel(addDays(monday, 7))} – ${weekdayLabel(addDays(monday, 13))}.`
  );
}

/**
 * Der Anker fuer die Fehlermeldungen an das Modell — dieselben Angaben, aber
 * auf Englisch, weil die Meldung an das Modell geht.
 */
function todayAnchorEnglish(today: string): string {
  return `Today is ${ENGLISH_WEEKDAYS[weekdayIndex(today)]}, ${formatGermanDate(today)}`;
}

/**
 * Die deutschen Hinweise auf gekuerzte Felder.
 *
 * Ohne diesen Hinweis merkt der Nutzer nicht, dass ein langer Titel oder eine
 * lange Notiz unvollstaendig gespeichert wurde — die Rueckmeldung meldet
 * sonst Erfolg und verschweigt den Verlust. Geprueft wird die Laenge *vor*
 * dem Speichern, nicht geraten.
 */
function truncationNotices(raw: {
  title?: string;
  description?: string;
  location?: string;
}): string[] {
  const notices: string[] = [];
  if (raw.title !== undefined && raw.title.length > MAX_TITLE_LENGTH) {
    notices.push(`Der Titel wurde auf ${MAX_TITLE_LENGTH} Zeichen gekuerzt.`);
  }
  if (raw.description !== undefined && raw.description.length > MAX_TEXT_LENGTH) {
    notices.push(`Die Notiz wurde auf ${MAX_TEXT_LENGTH} Zeichen gekuerzt.`);
  }
  if (raw.location !== undefined && raw.location.length > MAX_TEXT_LENGTH) {
    notices.push(`Der Ort wurde auf ${MAX_TEXT_LENGTH} Zeichen gekuerzt.`);
  }
  return notices;
}

/**
 * Die Meldung fuer einen Zeitraum, der nicht stimmt.
 *
 * Zwei Faelle, zwei Meldungen: das Ende *vor* dem Beginn ist ein Tippfehler,
 * das Ende *gleich* dem Beginn ist bei einem bezeitigten Termin ein Termin
 * ohne Laenge. Der Satz muss dem Modell sagen, was es tun muss — deshalb
 * nennt er die erlaubte Form mit Beispiel.
 *
 * Bei einem Ganztagestermin ist derselbe Tag Beginn und Ende: das ist
 * erlaubt und darf nicht als Fehler gemeldet werden.
 */
function rangeErrorMessage(start: string, end: string, allDay: boolean): string {
  if (!allDay && end === start) {
    return (
      `The end of the event is the same as its start — for a timed event 'end' must be AFTER 'start' ` +
      `(got start '${start}', end '${end}'). Give the event a length, e.g. start '2026-07-01T09:00' with ` +
      `end '2026-07-01T10:00', and call again.`
    );
  }
  return (
    `The end of the event is before its start — 'end' must not be before 'start' ` +
    `(got start '${start}', end '${end}'` +
    `${allDay ? "; for an all-day event 'end' is the LAST day, inclusive, so it must not be earlier than the start day" : ""}). ` +
    `Fix the two values and call again.`
  );
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
      "Read the user's real calendar: every event with title, date, time, location, note and its id. " +
      "Use it whenever the user asks about appointments, plans, availability, the schedule or what is on " +
      "the calendar — also when they phrase it indirectly ('am Freitag was steht an', 'habe ich Zeit'). " +
      "Never answer a calendar question from the conversation or from memory: this tool is the only source " +
      "of truth, so if the user asks about an appointment and you have not read the calendar, you do not " +
      "know it yet. " +
      "The id of every event is exactly what calendar_write needs to change or delete it: if the user wants " +
      "an event changed or deleted and you do not have its id yet, call calendar_read first and take the " +
      "id from the answer. " +
      "The answer begins with today's date and its weekday — the weekday is not something you can derive " +
      "from the date alone without guessing, and every relative expression ('diese Woche', 'morgen', " +
      "'Freitag') depends on it. The answer also names the current 'diese Kalenderwoche' and the next one " +
      "(Monday to Sunday): use that as the anchor when you turn relative expressions like 'diese Woche', " +
      "'morgen' or 'next week' into concrete dates; you do not need to determine the date yourself. " +
      "If the user asks about a week, query exactly the range the answer's anchor names — one week, not a " +
      "wider window — and answer with that same range. " +
      "'from' and 'to' are YYYY-MM-DD (e.g. '2026-10-26'); convert relative expressions like 'next week' " +
      "or 'tomorrow' into concrete dates before the call. The range filters by overlap, not by start date: " +
      "an event that only partly lies in the range is returned as well (an event from 01.03. to 31.03. also " +
      "shows up for from = to = '2026-03-10'). " +
      "Example: calendar_read({ from: '2026-10-26', to: '2026-10-30' })",
    approval: "read",
    loadMode: "essential",
    parameters: Type.Object({
      from: Type.Optional(Type.String({
        description:
          "Lower bound of the range, inclusive. Format YYYY-MM-DD, e.g. '2026-10-26'. The range filters by " +
          "overlap: an event that only partly lies in it is returned as well — an event from 01.03. to " +
          "31.03. also shows up for from = '2026-03-10'. The answer begins with today's date and the bounds " +
          "of the 'diese Kalenderwoche' — use them to turn relative expressions like 'next week' into a " +
          "concrete date.",
      })),
      to: Type.Optional(Type.String({
        description:
          "Upper bound of the range, inclusive. Format YYYY-MM-DD, e.g. '2026-10-30'. The range filters by " +
          "overlap: an event that only partly lies in it is returned as well — an event from 01.03. to " +
          "31.03. also shows up for to = '2026-03-10'. The answer begins with today's date and the bounds " +
          "of the 'diese Kalenderwoche' — use them to turn relative expressions like 'next week' into a " +
          "concrete date.",
      })),
    }),

    async execute(_toolCallId, params) {
      const owner = requireIdentity();
      const { events } = readCalendarFile(owner);

      // Der Anker steht in jedem Ergebnis-Text: er ist die Information, nicht
      // der Kalenderinhalt — auch ein leerer Kalender nennt ihn.
      const today = todayDateString();
      const anchor = todayAnchor(today);

      const from = params.from?.trim();
      const to = params.to?.trim();
      if (from && !isCalendarDate(from)) {
        throw new Error(
          `Invalid 'from': expected a date as YYYY-MM-DD (e.g. '${today}'), but got '${from}'. ` +
          `${todayAnchorEnglish(today)} — convert relative expressions like 'next week', 'tomorrow' or ` +
          `'this month' to a concrete date: the answer's anchor names the current 'diese Kalenderwoche' ` +
          `(Monday to Sunday), so take the dates from there — and call again.`,
        );
      }
      if (to && !isCalendarDate(to)) {
        throw new Error(
          `Invalid 'to': expected a date as YYYY-MM-DD (e.g. '${today}'), but got '${to}'. ` +
          `${todayAnchorEnglish(today)} — convert relative expressions like 'next week', 'tomorrow' or ` +
          `'this month' to a concrete date: the answer's anchor names the current 'diese Kalenderwoche' ` +
          `(Monday to Sunday), so take the dates from there — and call again.`,
        );
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
          content: [{ type: "text" as const, text: `${anchor}\nIm Kalender steht${range} kein Termin.` }],
        };
      }

      const count = filtered.length;
      const header = `${count} Termin${count === 1 ? "" : "e"} im Kalender:\n`;
      return {
        content: [{
          type: "text" as const,
          text: `${anchor}\n${header}${filtered.map(describeEvent).join("\n")}`,
        }],
      };
    },
  });

  const writeTool = defineTool({
    name: "calendar_write",
    label: "Kalender schreiben",
    description:
      "Create, change, move and delete events in the user's real calendar. Every call is visible to the " +
      "user immediately — the calendar is the surface the user reads, not the chat. " +
      "Use it whenever the user wants an appointment made, changed, moved, cancelled or deleted, also when " +
      "they phrase it indirectly ('trag mal ein', 'passt das?', 'schieb den auf Freitag', 'mach mir einen " +
      "Termin'). " +
      "Never say that an appointment has been created, moved or cancelled unless you have called this tool: " +
      "an appointment that was only described in the chat does not exist, and the user is told it does. " +
      "If the request names no time, invent a sensible one (e.g. 09:00-10:00 on the next weekday) instead " +
      "of asking a question; if it names no title, invent a short descriptive one. " +
      "'create' needs title, start and end. 'update' needs the id and only the fields that change — moving " +
      "an event is an update with a new start (or a new end): the tool keeps the duration of the event, " +
      "so you only pass the side you want to move. 'delete' needs only the id and is final: there is no " +
      "trash and no undo, so read the event with calendar_read first when you are unsure. " +
      "For 'update' and 'delete' you need the id: if you do not have it, call calendar_read first and take " +
      "the id from its answer. " +
      "Formats: timed event '2026-10-26T15:00'; all-day event '2026-10-26' for start and end, where end " +
      "is the LAST day, inclusive (one day: start = end; 26.10.-28.10.: end = '2026-10-28'). There is no " +
      "timezone concept at all: '2026-10-26T15:00' means 15:00 in the user's local time, without conversion " +
      "and without daylight-saving correction — convert yourself if the user names another zone. " +
      "Limits: the title holds 300 characters, note and location 4000 each; longer values are truncated, and " +
      "the truncation is reported back to the user. " +
      "An event can carry a colour: one of the preset names 'accent', 'success', 'warning', 'danger', 'violet' " +
      "or a hex colour like '#ff00aa'. Without it a new event keeps the default colour and an existing event " +
      "keeps its colour. " +
      "The calendar format has no recurring events, no attendees and no reminders — such details are " +
      "discarded without an error, so the way to express them is several single events. " +
      "Examples: create { action: 'create', title: 'Zahnarzt', start: '2026-10-26T15:00', " +
      "end: '2026-10-26T16:00' } | move { action: 'update', id: '<id from calendar_read>', " +
      "start: '2026-10-30T15:00' } | delete { action: 'delete', id: '<id from calendar_read>' }. " +
      "After the call, tell the user in one short sentence what you changed — title, date, time.",
    approval: "write",
    loadMode: "essential",
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("create"), Type.Literal("update"), Type.Literal("delete")],
        {
          description:
            "What should happen: 'create' adds a new event, 'update' changes only the fields you pass of " +
            "an existing event, 'delete' removes it. Required.",
        },
      ),
      id: Type.Optional(Type.String({
        description:
          "The id of the event, a UUID like '1f9c2a44-7d0e-4b21-9c3a-5f6b7d8e9a01'. Required for 'update' " +
          "and 'delete' — take it from the answer of calendar_read.",
      })),
      title: Type.Optional(Type.String({
        description:
          "The title of the event, short and descriptive (e.g. 'Zahnarzt'). Required for 'create'; a short " +
          "invented title is better than no title at all.",
      })),
      start: Type.Optional(Type.String({
        description:
          "Start of the event. Either 'YYYY-MM-DD' for an all-day event (e.g. '2026-10-26') or " +
          "'YYYY-MM-DDTHH:mm' for a timed event (e.g. '2026-10-26T15:00'). Times are local, without a " +
          "timezone. Required for 'create'. For 'update' it is optional: pass a new start and the tool " +
          "recomputes the end so the event keeps its duration.",
      })),
      end: Type.Optional(Type.String({
        description:
          "End of the event, in the same two formats as 'start'. For an all-day event it is the LAST day, " +
          "inclusive — a one-day event has start = end, a three-day event from 26.10. to 28.10. has end " +
          "'2026-10-28'. 'end' must not be before 'start'. Required for 'create'. For 'update' it is " +
          "optional: pass a new end and the tool moves the start so the event keeps its duration.",
      })),
      allDay: Type.Optional(Type.Boolean({
        description:
          "true for an all-day event. Usually leave it out: the tool infers it from the format of start and " +
          "end (a date without a time means an all-day event) — the same for 'create' and for 'update'. " +
          "Set it explicitly only to override that.",
      })),
      description: Type.Optional(Type.String({
        description: "Optional note for the event, one line (e.g. 'Bring the documents').",
      })),
      location: Type.Optional(Type.String({
        description: "Optional location of the event (e.g. 'Praxis Dr. Weber').",
      })),
      color: Type.Optional(Type.String({
        description:
          "The colour of the event. Either one of the preset names 'accent', 'success', 'warning', 'danger' " +
          "or 'violet', or a hex colour like '#ff00aa'. The preset names are resolved by the theme, so they " +
          "look right in every theme — do not guess the hex code of a preset. Optional: without it a new " +
          "event gets the default colour and an existing event keeps its colour.",
      })),
    }),

    async execute(_toolCallId, params) {
      const owner = requireIdentity();
      const { events } = readCalendarFile(owner);

      // Die Farbe wird mit derselben Funktion geprueft wie in den Routen —
      // das Werkzeug schreibt in dieselbe Datei, und was die Route ablehnt,
      // muss auch hier abgelehnt werden. Beim Loeschen ist die Farbe
      // bedeutungslos und wird nicht geprueft.
      let color: string | undefined;
      if (params.color !== undefined && params.action !== "delete") {
        const normalized = normalizeCalendarColor(params.color);
        if (normalized === undefined) {
          // Die erlaubten Namen kommen aus der Domaene — die Liste kann nicht
          // veralten, solange sie hier nicht festgeschrieben wird.
          const presets = CALENDAR_COLOR_PRESETS.map((preset) => `'${preset}'`).join(", ");
          throw new Error(
            `Invalid 'color': expected one of the preset names ${presets} or a hex colour like ` +
            `'#ff00aa', but got '${params.color}'. Call again with a valid colour, or leave 'color' out ` +
            `to keep the default.`,
          );
        }
        color = normalized;
      }

      if (params.action === "create") {
        const rawTitle = params.title?.trim() ?? "";
        const title = rawTitle.slice(0, MAX_TITLE_LENGTH);
        if (!title) {
          throw new Error(
            "A title is required for 'create' — an event without a title is not an event. If the user " +
            "did not name one, invent a short descriptive title (e.g. 'Termin') instead of asking.",
          );
        }
        const start = normalizeDateTime(params.start?.trim() ?? "");
        const end = normalizeDateTime(params.end?.trim() ?? "");
        if (!start || !end) {
          throw new Error(
            "A new event needs both 'start' and 'end'. Use 'YYYY-MM-DD' for an all-day event " +
            "(e.g. '2026-10-26') or 'YYYY-MM-DDTHH:mm' for a timed one (e.g. '2026-10-26T15:00').",
          );
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
            `Invalid event date: 'start' and 'end' must be either 'YYYY-MM-DD' for an all-day event ` +
            `(e.g. '2026-10-26') or 'YYYY-MM-DDTHH:mm' for a timed event (e.g. '2026-10-26T15:00'). ` +
            `Times are local, without a timezone.`,
          );
        }
        const rangeError = validateEventRange(start, end, allDay);
        if (rangeError) {
          throw new Error(rangeErrorMessage(start, end, allDay));
        }

        const now = new Date().toISOString();
        const description = params.description ? params.description.slice(0, MAX_TEXT_LENGTH) : undefined;
        const location = params.location ? params.location.slice(0, MAX_TEXT_LENGTH) : undefined;
        const created: CalendarEvent = {
          id: randomUUID(),
          title,
          start,
          end,
          allDay,
          ...(description ? { description } : {}),
          ...(location ? { location } : {}),
          // Ohne Farbe traegt der Termin die Voreinstellung — die entscheidet
          // die Voreinstellung, nicht das Werkzeug.
          ...(color ? { color } : {}),
          createdAt: now,
          updatedAt: now,
        };
        writeCalendarFile(owner, [...events, created]);
        notifyCalendarChange(owner);
        return {
          content: [{
            type: "text" as const,
            text: [
              `Termin angelegt: ${describeEvent(created)}`,
              ...truncationNotices({
                title: rawTitle,
                description: params.description,
                location: params.location,
              }),
              "Der Kalender des Nutzers ist jetzt aktualisiert.",
            ].join("\n"),
          }],
        };
      }

      const id = params.id?.trim();
      if (!id) {
        throw new Error(
          `Missing 'id' for '${params.action}': the id of the event is required. Call calendar_read first ` +
          `and take the id of the event from its answer.`,
        );
      }
      const existing = events.find((event) => event.id === id);
      if (!existing) {
        throw new Error(
          `No event with the id '${id}' exists in this calendar. Call calendar_read to find the correct id.`,
        );
      }

      if (params.action === "delete") {
        writeCalendarFile(owner, events.filter((event) => event.id !== id));
        notifyCalendarChange(owner);
        return {
          content: [{
            type: "text" as const,
            text: [
              `Termin geloescht: ${existing.title} am ${eventWhen(existing)}.`,
              // Das Loeschen ist endgueltig — kein Papierkorb, kein Rueckgaengig.
              // Der Nutzer soll das wissen, sonst sucht er spaeter vergebens
              // nach dem Termin.
              "Das Loeschen ist endgueltig — es gibt keinen Papierkorb und kein Rueckgaengig.",
              "Der Kalender des Nutzers ist jetzt aktualisiert.",
            ].join("\n"),
          }],
        };
      }

      // 'update': nur die genannten Felder aendern. Das Verschieben ist
      // derselbe Aufruf mit einem neuen start (oder einem neuen end) — und
      // fuehrt der nur eines davon an, rechnet das Werkzeug die Dauer des
      // Termins um. Das Verschieben ist damit eine Eigenschaft des Werkzeugs
      // und keine Bitte an das Modell.
      const givenStart = params.start === undefined
        ? undefined
        : normalizeDateTime(params.start.trim());
      const givenEnd = params.end === undefined
        ? undefined
        : normalizeDateTime(params.end.trim());

      // Beide Werte in verschiedenen Schreibweisen sind ein Widerspruch, den
      // keine Rechnung mehr aufloesen kann: ein Ganztagestermin hat kein
      // 'T' im Ende, ein Termin mit Uhrzeit schon.
      if (
        givenStart !== undefined &&
        givenEnd !== undefined &&
        givenStart.includes("T") !== givenEnd.includes("T")
      ) {
        throw new Error(
          "'start' and 'end' must use the same format: either both 'YYYY-MM-DD' (all-day event) or " +
          "both 'YYYY-MM-DDTHH:mm' (timed event). Change one of the two to match the other.",
        );
      }

      // Der Ganztag-Flag richtet sich nach der Schreibweise des angegebenen
      // Wertes — genau wie beim Anlegen. Wird gar keine Zeit angegeben, bleibt
      // der Flag des bestehenden Termins stehen.
      let allDay: boolean;
      if (params.allDay !== undefined) {
        allDay = params.allDay;
      } else if (givenStart !== undefined) {
        allDay = !givenStart.includes("T");
      } else if (givenEnd !== undefined) {
        allDay = !givenEnd.includes("T");
      } else {
        allDay = existing.allDay;
      }

      let start: string;
      let end: string;
      if (givenStart !== undefined && givenEnd !== undefined) {
        start = givenStart;
        end = givenEnd;
      } else if (givenStart !== undefined) {
        start = givenStart;
        end = shiftedEnd(existing, start, allDay);
      } else if (givenEnd !== undefined) {
        end = givenEnd;
        start = shiftedStart(existing, end, allDay);
      } else {
        start = existing.start;
        end = existing.end;
      }

      const startValid = allDay ? isCalendarDate(start) : isCalendarDateTime(start);
      const endValid = allDay ? isCalendarDate(end) : isCalendarDateTime(end);
      if (!startValid || !endValid) {
        throw new Error(
          `Invalid event date: 'start' and 'end' must be either 'YYYY-MM-DD' for an all-day event ` +
          `(e.g. '2026-10-26') or 'YYYY-MM-DDTHH:mm' for a timed event (e.g. '2026-10-26T15:00'). ` +
          `Times are local, without a timezone.`,
        );
      }
      const rangeError = validateEventRange(start, end, allDay);
      if (rangeError) {
        throw new Error(rangeErrorMessage(start, end, allDay));
      }

      const rawTitle = params.title === undefined ? undefined : params.title.trim();
      const title = rawTitle === undefined
        ? existing.title
        : rawTitle.slice(0, MAX_TITLE_LENGTH);
      if (!title) {
        throw new Error(
          "The title of an event must not be empty — pass a short descriptive title instead of an " +
          "empty string.",
        );
      }

      const description = params.description === undefined
        ? undefined
        : params.description.slice(0, MAX_TEXT_LENGTH);
      const location = params.location === undefined
        ? undefined
        : params.location.slice(0, MAX_TEXT_LENGTH);
      const updated: CalendarEvent = {
        ...existing,
        title,
        start,
        end,
        allDay,
        ...(description !== undefined ? { description } : {}),
        ...(location !== undefined ? { location } : {}),
        // Ohne 'color' bleibt die Farbe des bestehenden Termins stehen — der
        // Aufruf von 'existing' traegt sie bereits.
        ...(color !== undefined ? { color } : {}),
        updatedAt: new Date().toISOString(),
      };
      writeCalendarFile(owner, events.map((event) => (event.id === id ? updated : event)));
      notifyCalendarChange(owner);
      return {
        content: [{
          type: "text" as const,
          text: [
            `Termin geaendert: ${describeEvent(updated)}`,
            ...truncationNotices({
              title: rawTitle,
              description: params.description,
              location: params.location,
            }),
            "Der Kalender des Nutzers ist jetzt aktualisiert.",
          ].join("\n"),
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
