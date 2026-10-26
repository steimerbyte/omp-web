/**
 * Die neun Formate, die der Kalender beim Import nicht uebernimmt.
 *
 * ### Warum diese Datei existiert
 *
 * Zwei Tests brauchen dieselben Dateien: der Parser-Test prueft, **welcher
 * Zaehler** aus welcher Datei kommt, der Oberflaechen-Test prueft, **welchen
 * deutschen Namen** die Vorschau dafuer nennt. Beide muessen dieselben
 * Dateien benutzen — sonst prueft der eine Test eine Datei und der andere
 * eine andere, und die Zahlen passen nicht mehr zusammen.
 *
 * ### Der Aufbau jeder Datei
 *
 * Jedes Format hat seinen **eigenen** Ausloeser, und die Datei enthaelt
 * **nur** dieses eine: die Erinnerung einen `VALARM` im Termin, die
 * Teilnehmer eine `ATTENDEE`-Eigenschaft, die Zeitzone einen
 * `VTIMEZONE`-Block, die uebrigen Bestandteile eine Aufgabe neben dem
 * Termin. So belegt die Datei, welcher Zaehler aus welcher Datei kommt —
 * gemessen am echten Parser, nicht geraten.
 *
 * `key` ist der Schluessel im Bericht des Parsers, `labelKey` der Schluessel
 * im deutschen Sprachpaket (`lib/i18n/messages/de.ts`). Der **Text** steht
 * damit an einer Stelle: der Test liest ihn aus dem Sprachpaket, statt ihn
 * hier noch einmal abzuschreiben.
 */

/** Die neun Formate mit ihrem Ausloeser und ihrem Schluessel im Sprachpaket. */
export const VERWORFENE_FORMATE = [
  {
    key: "alarms",
    labelKey: "calendar.import.ignoredAlarms",
    zeilen: [
      "BEGIN:VEVENT", "UID:one@example.com",
      "DTSTART:20261028T140000", "DTEND:20261028T150000", "SUMMARY:Teammeeting",
      "BEGIN:VALARM", "TRIGGER:-PT15M", "END:VALARM",
      "END:VEVENT",
    ],
  },
  {
    key: "attendees",
    labelKey: "calendar.import.ignoredAttendees",
    zeilen: [
      "BEGIN:VEVENT", "UID:one@example.com",
      "DTSTART:20261028T140000", "DTEND:20261028T150000", "SUMMARY:Teammeeting",
      "ATTENDEE:mailto:anna@example.org",
      "END:VEVENT",
    ],
  },
  {
    key: "categories",
    labelKey: "calendar.import.ignoredCategories",
    zeilen: [
      "BEGIN:VEVENT", "UID:one@example.com",
      "DTSTART:20261028T140000", "DTEND:20261028T150000", "SUMMARY:Teammeeting",
      "CATEGORIES:Arbeit",
      "END:VEVENT",
    ],
  },
  {
    key: "organizers",
    labelKey: "calendar.import.ignoredOrganizers",
    zeilen: [
      "BEGIN:VEVENT", "UID:one@example.com",
      "DTSTART:20261028T140000", "DTEND:20261028T150000", "SUMMARY:Teammeeting",
      "ORGANIZER:mailto:chef@example.org",
      "END:VEVENT",
    ],
  },
  {
    key: "urls",
    labelKey: "calendar.import.ignoredUrls",
    zeilen: [
      "BEGIN:VEVENT", "UID:one@example.com",
      "DTSTART:20261028T140000", "DTEND:20261028T150000", "SUMMARY:Teammeeting",
      "URL:https://example.org/termin",
      "END:VEVENT",
    ],
  },
  {
    key: "statuses",
    labelKey: "calendar.import.ignoredStatuses",
    zeilen: [
      "BEGIN:VEVENT", "UID:one@example.com",
      "DTSTART:20261028T140000", "DTEND:20261028T150000", "SUMMARY:Teammeeting",
      "STATUS:CONFIRMED",
      "END:VEVENT",
    ],
  },
  {
    key: "transparencies",
    labelKey: "calendar.import.ignoredTransparencies",
    zeilen: [
      "BEGIN:VEVENT", "UID:one@example.com",
      "DTSTART:20261028T140000", "DTEND:20261028T150000", "SUMMARY:Teammeeting",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    ],
  },
  {
    key: "timezones",
    labelKey: "calendar.import.ignoredTimezones",
    zeilen: [
      "BEGIN:VTIMEZONE", "TZID:Europe/Berlin", "END:VTIMEZONE",
      "BEGIN:VEVENT", "UID:one@example.com",
      "DTSTART:20261028T140000", "DTEND:20261028T150000", "SUMMARY:Teammeeting",
      "END:VEVENT",
    ],
  },
  {
    key: "otherComponents",
    labelKey: "calendar.import.ignoredOtherComponents",
    zeilen: [
      "BEGIN:VEVENT", "UID:one@example.com",
      "DTSTART:20261028T140000", "DTEND:20261028T150000", "SUMMARY:Teammeeting",
      "END:VEVENT",
      "BEGIN:VTODO", "UID:aufgabe@example.com", "SUMMARY:Aufgabe", "END:VTODO",
    ],
  },
];

/** Eine Kalenderdatei mit genau den genannten Zeilen. */
export function dateiMit(zeilen) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...zeilen, "END:VCALENDAR"].join("\r\n");
}

/**
 * Eine Datei, die **alle neun** Formate enthaelt — jede Datei aus
 * `VERWORFENE_FORMATE` ist ein eigenes Beispiel, diese eine sammelt sie.
 */
export const ICS_MIT_ALLEN_NEUN = dateiMit([
  "BEGIN:VTIMEZONE", "TZID:Europe/Berlin", "END:VTIMEZONE",
  "BEGIN:VEVENT", "UID:one@example.com",
  "DTSTART:20261028T140000", "DTEND:20261028T150000", "SUMMARY:Teammeeting",
  "ATTENDEE:mailto:anna@example.org",
  "CATEGORIES:Arbeit",
  "ORGANIZER:mailto:chef@example.org",
  "URL:https://example.org/termin",
  "STATUS:CONFIRMED",
  "TRANSP:OPAQUE",
  "BEGIN:VALARM", "TRIGGER:-PT15M", "END:VALARM",
  "END:VEVENT",
  "BEGIN:VTODO", "UID:aufgabe@example.com", "SUMMARY:Aufgabe", "END:VTODO",
]);
