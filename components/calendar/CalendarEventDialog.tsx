"use client";

import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCalendarText } from "./useCalendarText";
import {
  CALENDAR_COLOR_PRESET_LABELS,
  CALENDAR_COLOR_PRESETS,
  CALENDAR_COLOR_VARIABLES,
  DEFAULT_CALENDAR_COLOR,
  formatGermanDate,
  isCalendarColorPreset,
  isCalendarHexColor,
  normalizeCalendarColor,
  normalizeDateInput,
  normalizeTimeInput,
  sanitizeHexInput,
  type CalendarColorPreset,
} from "@/lib/calendar";
import type { CalendarEventInput } from "@/hooks/useCalendar";

/**
 * Der Dialog zum Anlegen und Bearbeiten eines Termins.
 *
 * ### Warum Datum und Uhrzeit getrennt sind
 *
 * Der Kalender speichert Ganztagestermine als `"2026-03-14"` und Termine mit
 * Uhrzeit als `"2026-03-14T15:00"`. Der Dialog zeigt deshalb zwei Felder
 * (Datum und Uhrzeit), und das Kaestchen "Ganztaegig" entscheidet, welches
 * davon ueberhaupt sichtbar ist.
 *
 * ### Warum die Felder *Textfelder* sind und keine nativen
 *
 * Ein natives `<input type="date">` und `<input type="time">` zeigen ihre
 * Werte in der Sprache des **Browsers**, nicht in der der Seite. Gemessen in
 * Chromium mit englischem Browser-Locale: das Zeitfeld zeigt `03:00 PM` fuer
 * den Wert `15:00`, das Datumsfeld `10/26/2026` fuer `2026-10-26` — und
 * `lang="de"` am Element aendert daran nichts. Der *Wert* war die ganze Zeit
 * richtig (`input.value` stand `15:00`); nur die Anzeige war falsch.
 *
 * Ein deutscher Kalender, in dem die Uhrzeit amerikanisch und das Datum
 * amerikanisch erscheint, ist falsch. Deshalb stehen hier eigene Felder:
 * die Uhrzeit im 24-Stunden-Format `HH:MM`, das Datum in deutscher
 * Schreibweise `DD.MM.JJJJ`.
 *
 * ### Warum die Felder *uncontrolled* sind
 *
 * Der Text, den der Nutzer tippt, steht im DOM und nicht im Zustand: wer
 * "15:3" schreibt, muss danach noch "0" schreiben koennen — ein Zustand, der
 * schon beim Tippen normalisiert wuerde, wuerde die Eingabe zerstoeren. Der
 * Zustand haelt die *kanonischen* Werte (`HH:MM`, `YYYY-MM-DD`); die
 * Normalisierung sitzt an der Grenze zum Kalenderformat, in
 * `normalizeTimeInput` und `normalizeDateInput`.
 *
 * ### Warum die Texteingaben ihr `type` ausdruecklich tragen
 *
 * React erkennt eine Texteingabe an `elem.type`. Ohne `type`-Attribut ist
 * das in einem Browser "text" — aber nicht in jeder DOM-Implementierung,
 * und dann behandelt React das Feld nicht als Texteingabe: ein `onChange`
 * feuert nie, und der Dialog speichert einen leeren Titel. Ein
 * `type="text"` kostet nichts und nimmt die Mehrdeutigkeit weg.
 *
 * ### Warum der Dialog beim Oeffnen den Termin ausfuellt und nicht leert
 *
 * Beim Bearbeiten zeigt der Dialog den bestehenden Termin; beim Anlegen zeigt
 * er den vorbelegten Tag. Das Formular wird nicht bei jedem Rendern neu
 * aufgebaut — der `useEffect` haelt den Zustand nur dann fest, wenn sich der
 * bearbeitete Termin aendert. Sonst wuerde jeder Tastendruck im Titelfeld
 * den Zustand zuruecksetzen, weil `event` eine neue Objektidentitaet hat.
 */

/**
 * Die deutschen Namen der Preset-Farben kommen aus der Domaene
 * (`CALENDAR_COLOR_PRESET_LABELS`), nicht aus dem i18n-Katalog: es ist ein
 * festes Vokabular des Kalenders wie die Monats- und Wochentagsnamen, und
 * die Werkzeug-Ausgabe (Server) nennt dieselben fuenf Farben.
 */

/**
 * Der Name der CSS-Variablen in einer `var(...)`-Angabe — `--accent`.
 *
 * Die Zuordnung `CALENDAR_COLOR_VARIABLES` traegt die fertige CSS-Angabe
 * (`var(--accent)`), weil sie direkt als Farbwert gebraucht wird — fuer
 * `border-left` und `color-mix()`. Fuer den Zugriff auf die Variable selbst
 * wird der Name daraus gelesen.
 */
function cssVariableName(cssValue: string): string | null {
  const match = /^var\(\s*(--[\w-]+)\s*\)$/.exec(cssValue);
  return match ? match[1] : null;
}

/**
 * Der Hex-Wert einer Preset-Farbe — *jetzt*, nicht aus dem Quelltext.
 *
 * `applyOmpPalette` schreibt die Farbvariablen zur Laufzeit um, und ein
 * importiertes Theme hat eigene Werte. Der Farbwaehler des Browsers braucht
 * aber einen konkreten Hex-Code, sonst zeigt er eine Farbe, die der Termin
 * nicht traegt. Diese Funktion liest deshalb den geltenden Wert der Variable.
 *
 * @returns Der Hex-Wert — oder `null`, wenn es keinen gibt (etwa weil das
 * Theme die Farbe anders schreibt).
 */
function readThemeHex(cssValue: string): string | null {
  if (typeof document === "undefined" || typeof window === "undefined") return null;
  const variable = cssVariableName(cssValue);
  if (!variable) return null;
  const raw = window.getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : null;
}

/**
 * Das Ende, das ein neuer Termin bekommt, wenn der Nutzer keines eintragt.
 *
 * Eine Stunde nach dem Beginn — die Dauer, die ein Klick auf eine freie Stunde
 * im Wochenraster ergibt. Endet ein Ganztagestermin auf demselben Tag, ist
 * das ein *Ganztagestermin* — ein gueltiger Termin mit genau einem Tag.
 */
function defaultEndTime(presetTime: string | null): string {
  if (!presetTime) return "10:00";
  const [hours, minutes] = presetTime.split(":").map(Number);
  const endMinutes = (hours * 60 + minutes + 60) % 1440;
  return `${String(Math.floor(endMinutes / 60)).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;
}

export function CalendarEventDialog({
  event,
  preset,
  busy,
  error,
  onCancel,
  onSave,
  onDelete,
}: {
  /** Der bestehende Termin, oder `null` fuer einen neuen. */
  event: { id: string; title: string; start: string; end: string; allDay: boolean; description?: string; location?: string; color?: string } | null;
  /** Der vorbelegte Tag und die vorbelegte Uhrzeit eines neuen Termins. */
  preset: { date: string; time: string | null };
  /** `true`, solange gespeichert wird. */
  busy: boolean;
  /**
   * Der Fehler des letzten Speicherns oder Loeschens — oder `null`.
   *
   * Er kommt von der Ansicht, weil *dort* die Anfrage laeuft. Er wird
   * hier *innerhalb* des Dialogs angezeigt: eine Meldungsleiste unter der
   * Kalender-Kopfzeile liegt hinter dem Radix-Overlay und ist damit
   * unerreichbar, solange der Dialog offen ist.
   */
  error?: string | null;
  onCancel: () => void;
  onSave: (input: CalendarEventInput, id: string | null) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
}) {
  const t = useCalendarText();

  const [title, setTitle] = useState(event?.title ?? "");
  const [description, setDescription] = useState(event?.description ?? "");
  const [location, setLocation] = useState(event?.location ?? "");
  const [allDay, setAllDay] = useState(event?.allDay ?? preset.time === null);

  /**
   * Der Dialog fragt *im Dialog* nach, bevor er loescht.
   *
   * ### Warum keine native Rueckfrage
   *
   * `window.confirm()` hat zwei getrennte Fehler, und beide treffen das
   * Loeschen im Tauri-Desktop:
   *
   * 1. Der Desktop-Shell (wry 0.55.1) implementiert
   *    `runJavaScriptConfirmPanel` nicht. Apple dokumentiert fuer diese
   *    Luecke: "If you do not implement this method, the web view will
   *    behave as if the user selected the Cancel button." `confirm()`
   *    liefert dort also immer `false` — der Knopf tut, als sei nichts
   *    passiert: keine Anfrage, keine Aenderung, keine Meldung.
   * 2. Im Browser blockiert die native Rueckfrage den Seitent Thread, bis
   *    der Nutzer antwortet. Ein Klick auf "Loeschen" haengt dann im
   *    Automationstest fest.
   *
   * Die Rueckfrage ist deshalb ein Zustand *dieses* Dialogs: ein erster
   * Klick schaltet den Dialog in den Bestaetigungszustand, und erst der
   * zweite Klick loescht. Damit gibt es keine native Box, keinen
   * Thread-Blocker und keine zweite Fokusfalle.
   */
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  /**
   * Die kanonischen Werte des Termins.
   *
   * `null` heisst: die Eingabe ist unbrauchbar. Dann wird nicht gespeichert,
   * und der Dialog nennt den Grund.
   */
  const [startDate, setStartDate] = useState<string | null>(event?.start.slice(0, 10) ?? preset.date);
  const [startTime, setStartTime] = useState<string | null>(
    event?.start.includes("T") ? event.start.slice(11, 16) : preset.time ?? "09:00",
  );
  const [endDate, setEndDate] = useState<string | null>(event?.end.slice(0, 10) ?? preset.date);
  const [endTime, setEndTime] = useState<string | null>(
    event?.end.includes("T") ? event.end.slice(11, 16) : defaultEndTime(preset.time),
  );

  /**
   * Die Farbe des Termins: ein Preset-Name oder ein Hex-Code.
   *
   * `undefined` heisst: der Termin traegt keine eigene Farbe und faellt auf
   * die Voreinstellung zurueck.
   */
  const [color, setColor] = useState<string | undefined>(event?.color);
  /** `true`, wenn der eigene Farbwaehler offen ist. */
  const [customOpen, setCustomOpen] = useState(false);
  /** Der Text im Hex-Feld. Leer heisst: keine eigene Farbe. */
  const [hexText, setHexText] = useState<string>(
    typeof event?.color === "string" && isCalendarHexColor(event.color) ? event.color : "",
  );

  /** Die Felder, in denen der getippte Text steht. */
  const startDateRef = useRef<HTMLInputElement>(null);
  const startTimeRef = useRef<HTMLInputElement>(null);
  const endDateRef = useRef<HTMLInputElement>(null);
  const endTimeRef = useRef<HTMLInputElement>(null);
  const nativeColorRef = useRef<HTMLInputElement>(null);

  /**
   * Hat der Nutzer das Ende selbst gesetzt?
   *
   * Solange das nicht der Fall ist, wandert das Ende mit dem Beginn: wer im
   * Wochenraster die Stunde 14 anklickt, bekommt den Termin von 14:00 bis
   * 15:00 — und aendert er danach den Beginn auf 16:00, endet der Termin
   * um 17:00. Ein Ende, das beim Verschieben des Beginns stehen bliebe, waere
   * entweder vor dem Beginn (und der Termin waere ungueltig) oder laege
   * ploetzlich weit in der Zukunft.
   */
  const [endTouched, setEndTouched] = useState(false);

  /**
   * Das Formular an den bearbeiteten Termin anpassen.
   *
   * Der Vergleich laeuft ueber die Kennung, nicht ueber die Objektidentitaet:
   * der Aufrufer reicht bei jedem Rendern ein neues Objekt, und ein Vergleich
   * ueber die Identitaet wuerde das Formular bei jedem Tastendruck zuruecksetzen.
   */
  useEffect(() => {
    const nextStartDate = event?.start.slice(0, 10) ?? preset.date;
    const nextStartTime = event?.start.includes("T") ? event.start.slice(11, 16) : preset.time ?? "09:00";
    const nextEndDate = event?.end.slice(0, 10) ?? preset.date;
    const nextEndTime = event?.end.includes("T") ? event.end.slice(11, 16) : defaultEndTime(preset.time);
    const nextColor = event?.color;
    const nextHex = typeof nextColor === "string" && isCalendarHexColor(nextColor) ? nextColor : "";

    setTitle(event?.title ?? "");
    setDescription(event?.description ?? "");
    setLocation(event?.location ?? "");
    setAllDay(event?.allDay ?? preset.time === null);
    setStartDate(nextStartDate);
    setStartTime(nextStartTime);
    setEndDate(nextEndDate);
    setEndTime(nextEndTime);
    setEndTouched(false);
    setColor(nextColor);
    setCustomOpen(nextHex !== "");
    setHexText(nextHex);
    // Ein anderer Termin heisst auch: keine offene Loesch-Rueckfrage. Sonst
    // stuende die Bestaetigung noch, obwohl sie den *vorherigen* Termin
    // meint.
    setConfirmingDelete(false);

    // Die Felder sind uncontrolled: ihr Inhalt steht im DOM. Ein neuer Termin
    // braucht deshalb den passenden Text im Feld.
    if (startDateRef.current) startDateRef.current.value = formatGermanDate(nextStartDate);
    if (startTimeRef.current) startTimeRef.current.value = nextStartTime;
    if (endDateRef.current) endDateRef.current.value = formatGermanDate(nextEndDate);
    if (endTimeRef.current) endTimeRef.current.value = nextEndTime;
    // `preset` wird bewusst nicht mitgenommen: der Dialog wird pro Termin
    // neu geoeffnet, und die Vorbelegung aendert sich waehrend seiner
    // Lebensdauer nicht.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event?.id]);

  /**
   * Der eigene Farbwaehler bekommt beim Oeffnen die Farbe des Termins.
   *
   * Das Feld existiert nur, solange der own Farbwaehler offen ist — es
   * wird also *hier* erzeugt und nicht beim Oeffnen des Dialogs. Ohne diese
   * Regel stuende in ihm der schwarze Standardwert des Browsers, waehrend
   * der Termin in einer ganz anderen Farbe gezeichnet wird.
   */
  useEffect(() => {
    if (!customOpen) return;
    const field = nativeColorRef.current;
    if (!field) return;
    const preset = isCalendarColorPreset(color) ? color : DEFAULT_CALENDAR_COLOR;
    field.value = (typeof color === "string" && isCalendarHexColor(color) ? color : null)
      ?? readThemeHex(CALENDAR_COLOR_VARIABLES[preset])
      ?? "";
  }, [customOpen, color]);

  /**
   * Eine Uhrzeit wurde getippt.
   *
   * Der Text wird normalisiert und der kanonische Wert gesetzt. Der Text
   * selbst bleibt im Feld stehen — beim Verlassen des Feldes bekommt er die
   * kanonische Form.
   */
  const handleTimeInput = (which: "start" | "end", raw: string) => {
    const normalized = normalizeTimeInput(raw);
    if (!normalized) {
      if (which === "start") setStartTime(null);
      else {
        setEndTime(null);
        setEndTouched(true);
      }
      return;
    }
    if (which === "start") {
      setStartTime(normalized);
      if (!endTouched) {
        // Das Ende wandert mit dem Beginn, solange der Nutzer es nicht
        // selbst gesetzt hat.
        const next = defaultEndTime(normalized);
        setEndTime(next);
        if (endTimeRef.current) endTimeRef.current.value = next;
      }
      return;
    }
    setEndTouched(true);
    setEndTime(normalized);
  };

  /** Das Zeitfeld verliert den Fokus: es bekommt die kanonische Form. */
  const handleTimeBlur = (which: "start" | "end") => {
    const field = which === "start" ? startTimeRef : endTimeRef;
    const normalized = normalizeTimeInput(field.current?.value ?? "");
    if (normalized) field.current!.value = normalized;
  };

  /** Ein Datum wurde getippt — dieselbe Regel wie bei der Uhrzeit. */
  const handleDateInput = (which: "start" | "end", raw: string) => {
    const normalized = normalizeDateInput(raw);
    if (!normalized) {
      if (which === "start") setStartDate(null);
      else setEndDate(null);
      return;
    }
    if (which === "start") setStartDate(normalized);
    else setEndDate(normalized);
  };

  /** Das Datumsfeld verliert den Fokus: es bekommt die deutsche Form. */
  const handleDateBlur = (which: "start" | "end") => {
    const field = which === "start" ? startDateRef : endDateRef;
    const normalized = normalizeDateInput(field.current?.value ?? "");
    if (normalized) field.current!.value = formatGermanDate(normalized);
  };

  /**
   * Ein Preset wurde gewaehlt.
   *
   * Ein Preset schliesst eine eigene Farbe aus: der Nutzer hat damit
   * entschieden, dass der Termin die Farbe des Themes traegt. Der eigene
   * Farbwaehler bekommt deshalb die *laufende* Farbe des Presets zu sehen —
   * ein importiertes Theme hat eigene Werte, und der Waehler soll die
   * tatsaechliche Farbe zeigen, nicht eine aus dem Quelltext geratene.
   */
  const selectPreset = (preset: CalendarColorPreset) => {
    setColor(preset);
    setHexText("");
    if (nativeColorRef.current) {
      nativeColorRef.current.value = readThemeHex(CALENDAR_COLOR_VARIABLES[preset]) ?? "";
    }
  };

  /**
   * Der eigene Farbwaehler wurde benutzt.
   *
   * Der Browser liefert `#rrggbb`; der Hex-Code ist damit bereits in der
   * kanonischen Form, und das Hex-Feld zeigt denselben Wert.
   */
  const handleNativeColor = (raw: string) => {
    const normalized = normalizeCalendarColor(raw);
    if (!normalized || !isCalendarHexColor(normalized)) return;
    setColor(normalized);
    setHexText(normalized);
  };

  /**
   * Ein Hex-Code wurde getippt.
   *
   * Getippt wird der getippte Text, gespeichert wird der kanonische: erst
   * beim Verlassen des Feldes bekommt der Text seine endgueltige Form. Wer
   * `#f0a` tippt, sieht waehrend des Tippens `#f0a` und danach `#ff00aa` —
   * so wie beim Zeitfeld, und aus demselben Grund.
   */
  const handleHexInput = (raw: string) => {
    const cleaned = sanitizeHexInput(raw);
    setHexText(cleaned);
    const normalized = normalizeCalendarColor(cleaned);
    if (!normalized || !isCalendarHexColor(normalized)) return;
    setColor(normalized);
    if (nativeColorRef.current) nativeColorRef.current.value = normalized;
  };

  /** Das Hex-Feld verliert den Fokus: es bekommt die kanonische Form. */
  const handleHexBlur = () => {
    const normalized = normalizeCalendarColor(hexText);
    if (!normalized || !isCalendarHexColor(normalized)) return;
    setHexText(normalized);
    if (nativeColorRef.current) nativeColorRef.current.value = normalized;
  };

  /** Baut die Eingaben in das Format des Kalenders. */
  const buildInput = (): CalendarEventInput => ({
    title: title.trim(),
    allDay,
    start: allDay ? (startDate ?? "") : `${startDate ?? ""}T${startTime ?? ""}`,
    end: allDay ? (endDate ?? "") : `${endDate ?? ""}T${endTime ?? ""}`,
    ...(description.trim() ? { description: description.trim() } : {}),
    ...(location.trim() ? { location: location.trim() } : {}),
    ...(color ? { color } : {}),
  });

  const handleSubmit = (submitEvent: React.FormEvent) => {
    submitEvent.preventDefault();
    if (!title.trim()) return;
    // Ein unbrauchbarer Wert wird nicht gespeichert: der Dialog meldet es
    // und laesst das Speichern nicht zu.
    if (startDate === null || endDate === null || startTime === null || endTime === null) return;
    if (hexText !== "" && !isCalendarHexColor(hexText)) return;
    void onSave(buildInput(), event?.id ?? null);
  };

  /**
   * Der Termin wird geloescht — aber erst nach der Rueckfrage *im Dialog*.
   *
   * Das Loeschen ist nicht rueckgaendig zu machen: der Termin ist weg, und
   * der Agent weiss nichts davon. Eine Rueckfrage kostet einen Klick, ein
   * Versehen kostet den Termin.
   *
   * Der erste Klick schaltet nur in den Bestaetigungszustand; `onDelete`
   * laeuft erst beim zweiten. Siehe die Erklaerung am Zustand.
   */
  const handleDelete = () => {
    if (!event) return;
    setConfirmingDelete(true);
  };

  /** Der Bestaetigungszustand wird abgebrochen — der Termin bleibt. */
  const handleDeleteCancel = () => {
    setConfirmingDelete(false);
  };

  /** Der zweite Klick loescht wirklich. */
  const handleDeleteConfirm = () => {
    if (!event) return;
    setConfirmingDelete(false);
    void onDelete(event.id);
  };

  const inputStyle = {
    width: "100%",
    // `minWidth: 0` ist Pflicht, nicht Kosmetik: ein `<input>` hat eine
    // intrinsische Mindestbreite (Groesse des Default-`size`-Attributs), und
    // ohne diese Zeile weicht das Feld in einem Grid lieber aus, als dass es
    // schrumpft. Die Spalte waere dann breiter als der Dialog, und der
    // Inhalt laege ausserhalb des Fensters.
    minWidth: 0,
    padding: "6px 8px",
    fontSize: 13,
    fontFamily: "inherit",
    color: "var(--text)",
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 7,
    boxSizing: "border-box" as const,
  };

  const labelStyle = {
    display: "block",
    fontSize: 11,
    color: "var(--text-muted)",
    marginBottom: 4,
  };

  const errorStyle = {
    display: "block",
    fontSize: 11,
    color: "var(--danger)",
    marginTop: 4,
  };

  const hintStyle = {
    display: "block",
    fontSize: 10,
    color: "var(--text-dim)",
    marginTop: 4,
  };

  const timeInvalid = startTime === null || endTime === null;
  const dateInvalid = startDate === null || endDate === null;
  const hexInvalid = hexText !== "" && !isCalendarHexColor(hexText);

  /**
   * Das Preset, das als gewaehlt angezeigt wird.
   *
   * Ein Termin ohne eigene Farbe traegt die Voreinstellung — der Akzent. Der
   * Dialog zeigt deshalb *den* Knopf als gedrueckt an, mit dem der Termin
   * tatsaechlich gezeichnet wird. Zeigte er keinen an, wuerde der Nutzer
   * eine Leere sehen und einen Termin, der in Akzent erscheint.
   */
  const selectedPreset = isCalendarColorPreset(color)
    ? color
    : color === undefined
      ? DEFAULT_CALENDAR_COLOR
      : null;

  /**
   * Traegt der Termin eine eigene Farbe?
   *
   * Dann ist kein Preset gedrueckt, sondern der Knopf "Benutzerdefiniert" —
   * das ist die Wahl, die der Nutzer getroffen hat.
   */
  const customSelected = typeof color === "string" && isCalendarHexColor(color);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent
        showCloseButton={false}
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          color: "var(--text)",
          maxWidth: 420,
          // `100%` statt `100vw`: `vw` enthaelt die Breite des
          // Bildlaufleisten-Bereichs, `100%` nicht. Sonst ragt der Dialog auf
          // einem Desktop mit sichtbarer Bildlaufleiste ueber den sichtbaren
          // Bereich hinaus.
          width: "calc(100% - 32px)",
          // Der Dialog darf hoeher sein als der Bildschirm nicht. `100dvh`
          // statt `100vh`, weil die Adressleiste des Browsers die sichtbare
          // Hoehe veraendert.
          maxHeight: "calc(100dvh - 32px)",
          display: "flex",
          flexDirection: "column",
          // Der Inhalt scrollt *innerhalb* des Dialogs; der Fuss bleibt stehen.
          overflow: "hidden",
        }}
      >
        <form
          onSubmit={handleSubmit}
          noValidate
          style={{
            display: "flex",
            flexDirection: "column",
            // `minHeight: 0` ist die Voraussetzung dafuer, dass die
            // Flexbox das Formular unter die Hoehe des Dialogs schrumpfen
            // laesst. Ohne das bleibt die Hoehe beim Inhalt, und der Fuss
            // rutscht aus dem Fenster.
            minHeight: 0,
            flex: "1 1 auto",
          }}
        >
          <DialogHeader style={{ flexShrink: 0 }}>
            <DialogTitle style={{ fontSize: 15, color: "var(--text)" }}>
              {event ? t("calendar.editEvent") : t("calendar.newEvent")}
            </DialogTitle>
            <DialogDescription style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {t("calendar.eventTitlePlaceholder")}
            </DialogDescription>
          </DialogHeader>

          {/* Der Bereich mit den Feldern scrollt, der Fuss nicht. Damit bleibt
              „Termin speichern" auch auf einem flachen Bildschirm erreichbar,
              statt aus dem Fenster zu rutschen. */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 12,
              marginTop: 4,
              flex: "1 1 auto",
              minHeight: 0,
              overflowY: "auto",
              overflowX: "hidden",
              // Kein Scroll-Chaining: das Scrollen im Dialog soll nicht die
              // Seite dahinter mitziehen.
              overscrollBehavior: "contain",
            }}
          >
            <div>
              <label style={labelStyle} htmlFor="calendar-title">{t("calendar.eventTitle")}</label>
              <input
                id="calendar-title"
                type="text"
                autoFocus
                value={title}
                onChange={(inputEvent) => setTitle(inputEvent.target.value)}
                placeholder={t("calendar.eventTitlePlaceholder")}
                style={inputStyle}
              />
            </div>

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                fontSize: 12,
                color: "var(--text-muted)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={allDay}
                onChange={(checkEvent) => setAllDay(checkEvent.target.checked)}
                style={{ accentColor: "var(--accent)" }}
              />
              {t("calendar.allDay")}
            </label>

            {/* Die beiden Spalten (Beginn und Ende) stehen nebeneinander, nur
                wenn dafuer Platz ist. `auto-fit` mit einer Mindestbreite
                entscheidet das an der *Innenhöhe* des Containers, nicht an
                einer Fensterschwelle: unter ~310 px Inhaltsbreite faellt das
                Raster auf eine Spalte zusammen, und Datum und Uhrzeit stehen
                untereinander statt in zwei winzigen Kaestchen. */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                gap: 10,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <label style={labelStyle} htmlFor="calendar-start-date">{t("calendar.eventStart")}</label>
                <input
                  id="calendar-start-date"
                  ref={startDateRef}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  defaultValue={formatGermanDate(startDate ?? preset.date)}
                  onChange={(inputEvent) => handleDateInput("start", inputEvent.target.value)}
                  onBlur={() => handleDateBlur("start")}
                  aria-label={t("calendar.eventStartDate")}
                  pattern="\d{1,2}\.\d{1,2}\.\d{4}"
                  style={inputStyle}
                />
                {!allDay ? (
                  <input
                    ref={startTimeRef}
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    defaultValue={startTime ?? "09:00"}
                    onChange={(inputEvent) => handleTimeInput("start", inputEvent.target.value)}
                    onBlur={() => handleTimeBlur("start")}
                    aria-label={t("calendar.eventStartTime")}
                    pattern="([01]\d|2[0-3]):[0-5]\d"
                    style={{ ...inputStyle, marginTop: 6 }}
                  />
                ) : null}
                {dateInvalid ? <span style={errorStyle}>{t("calendar.invalidDate")}</span> : null}
                {timeInvalid ? <span style={errorStyle}>{t("calendar.invalidTime")}</span> : null}
                <span style={hintStyle}>{t("calendar.dateFormatHint")}</span>
              </div>
              <div style={{ minWidth: 0 }}>
                <label style={labelStyle} htmlFor="calendar-end-date">{t("calendar.eventEnd")}</label>
                <input
                  id="calendar-end-date"
                  ref={endDateRef}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  defaultValue={formatGermanDate(endDate ?? preset.date)}
                  onChange={(inputEvent) => handleDateInput("end", inputEvent.target.value)}
                  onBlur={() => handleDateBlur("end")}
                  aria-label={t("calendar.eventEndDate")}
                  pattern="\d{1,2}\.\d{1,2}\.\d{4}"
                  style={inputStyle}
                />
                {!allDay ? (
                  <input
                    ref={endTimeRef}
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    defaultValue={endTime ?? "10:00"}
                    onChange={(inputEvent) => handleTimeInput("end", inputEvent.target.value)}
                    onBlur={() => handleTimeBlur("end")}
                    aria-label={t("calendar.eventEndTime")}
                    pattern="([01]\d|2[0-3]):[0-5]\d"
                    style={{ ...inputStyle, marginTop: 6 }}
                  />
                ) : null}
                {dateInvalid ? <span style={errorStyle}>{t("calendar.invalidDate")}</span> : null}
                {timeInvalid ? <span style={errorStyle}>{t("calendar.invalidTime")}</span> : null}
                <span style={hintStyle}>{t("calendar.timeFormatHint")}</span>
              </div>
            </div>

            <div>
              <label style={labelStyle} htmlFor="calendar-location">{t("calendar.eventLocation")}</label>
              <input
                id="calendar-location"
                type="text"
                value={location}
                onChange={(inputEvent) => setLocation(inputEvent.target.value)}
                placeholder={t("calendar.eventLocationPlaceholder")}
                style={inputStyle}
              />
            </div>

            {/* Die Farbe. Die fuenf Presets kommen aus dem Theme, damit die
                Muster in hell und dunkel richtig aussehen; der eigene
                Farbwaehler daneben erlaubt einen beliebigen Hex-Code. */}
            <div>
              <span style={labelStyle} id="calendar-color-label">{t("calendar.eventColor")}</span>
              <div
                role="group"
                aria-labelledby="calendar-color-label"
                style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}
              >
                {CALENDAR_COLOR_PRESETS.map((preset) => {
                  const selected = selectedPreset === preset;
                  return (
                    <button
                      key={preset}
                      type="button"
                      aria-pressed={selected}
                      aria-label={CALENDAR_COLOR_PRESET_LABELS[preset]}
                      title={CALENDAR_COLOR_PRESET_LABELS[preset]}
                      onClick={() => selectPreset(preset)}
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 6,
                        // `flexShrink: 0`: das Farbfeld darf nicht kleiner
                        // werden, sonst waere die Farbe nicht mehr erkennbar.
                        // Die Reihe bricht lieber um.
                        flexShrink: 0,
                        // Die Farbe kommt aus der Theme-Variablen, nicht aus
                        // dem Quelltext — sonst waere die Farbe in einem
                        // importierten Theme die alte.
                        background: CALENDAR_COLOR_VARIABLES[preset],
                        border: selected ? "2px solid var(--text)" : "1px solid var(--border)",
                        cursor: "pointer",
                        padding: 0,
                      }}
                    />
                  );
                })}
                <button
                  type="button"
                  aria-pressed={customSelected}
                  aria-expanded={customOpen}
                  onClick={() => setCustomOpen((open) => !open)}
                  style={{
                    padding: "4px 9px",
                    fontSize: 12,
                    fontFamily: "inherit",
                    cursor: "pointer",
                    // Der Knopf bricht nicht um, sondern die *Reihe* bricht um.
                    // Ohne das schrumpft er zu einem unlesbaren Rest.
                    flexShrink: 0,
                    whiteSpace: "nowrap",
                    border: customSelected ? "2px solid var(--text)" : "1px solid var(--border)",
                    background: "none",
                    color: "var(--text-muted)",
                    borderRadius: 7,
                  }}
                >
                  {t("calendar.customColor")}
                </button>
              </div>

              {customOpen ? (
                <div style={{ marginTop: 8 }}>
                  {/* Der eigene Farbwaehler und das Hex-Feld teilen sich die
                      Breite. Das Hex-Feld waechst mit, der native Waehler
                      behaelt seine Groesse — bei 320 px bleiben so beide
                      bedienbar, statt dass eines aus der Zeile gedrueckt
                      wird. */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <input
                      ref={nativeColorRef}
                      type="color"
                      aria-label={t("calendar.colorHex")}
                      onChange={(inputEvent) => handleNativeColor(inputEvent.target.value)}
                      style={{
                        width: 36,
                        height: 28,
                        flexShrink: 0,
                        padding: 2,
                        border: "1px solid var(--border)",
                        borderRadius: 7,
                        background: "var(--bg)",
                        cursor: "pointer",
                      }}
                    />
                    <input
                      id="calendar-color-hex"
                      type="text"
                      inputMode="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={hexText}
                      onChange={(inputEvent) => handleHexInput(inputEvent.target.value)}
                      onBlur={() => handleHexBlur()}
                      aria-label={t("calendar.colorHex")}
                      placeholder={t("calendar.colorHexPlaceholder")}
                      style={{ ...inputStyle, flex: "1 1 110px", width: "auto", minWidth: 0 }}
                    />
                  </div>
                  {hexInvalid ? <span style={errorStyle}>{t("calendar.invalidColor")}</span> : null}
                </div>
              ) : null}
            </div>

            <div>
              <label style={labelStyle} htmlFor="calendar-description">{t("calendar.eventDescription")}</label>
              <textarea
                id="calendar-description"
                value={description}
                onChange={(inputEvent) => setDescription(inputEvent.target.value)}
                placeholder={t("calendar.eventDescriptionPlaceholder")}
                rows={3}
                style={{ ...inputStyle, resize: "vertical" }}
              />
            </div>
          </div>

          {/* Der Fehler des letzten Speicherns oder Loeschens steht *im*
              Dialog, unmittelbar ueber dem Fuss — nicht in der Leiste unter
              der Kalender-Kopfzeile. Diese Leiste liegt hinter dem
              Radix-Overlay (`fixed inset-0 z-50`) und ist damit unerreichbar,
              solange der Dialog offen ist: `document.elementFromPoint` auf
              ihrer Zeile liefert das Overlay, nie die Meldung.

              Der Fuss bleibt sichtbar, weil er nicht schrumpft
              (`flexShrink: 0`) und die Meldung *oberhalb* von ihm steht —
              die Meldung nimmt Platz aus dem scrollenden Feldbereich, nicht
              aus dem Fuss. */}
          {error ? (
            <div
              role="alert"
              style={{
                flexShrink: 0,
                marginTop: 12,
                padding: "8px 10px",
                fontSize: 12,
                color: "var(--danger)",
                background: "color-mix(in srgb, var(--danger) 10%, transparent)",
                border: "1px solid color-mix(in srgb, var(--danger) 45%, transparent)",
                borderRadius: 7,
              }}
            >
              {error}
            </div>
          ) : null}

          {/* Der Fuss ist eine *umbruchende* Zeile, keine feste.

              `justifyContent: "flex-start"` plus `marginLeft: "auto"` auf der
              Aktionsgruppe ist der Weg, der bei jeder Breite funktioniert:
              breit stehen „Abbrechen" und „Termin speichern" rechts, schmal
              bricht die Zeile um, und die Aktionsgruppe rutscht auf die zweite
              Zeile — nach rechts. Ein `marginRight: "auto"` auf „Loeschen"
              waere bei einem Umbruch wirkungslos und wuerde den Knopf auf
              schmalen Fenstern allein links stehen lassen, waehrend die beiden
              anderen die volle Breite naehmen.

              Im Bestaetigungszustand zeigt der Fuss *nur* die beiden Knoepfe
              der Rueckfrage. „Abbrechen" hat dort eine andere Bedeutung als
              sonst — es bricht den Loeschvorgang ab, statt den Dialog zu
              schliessen — und genau das macht den Zustand eindeutig: es gibt
              zu keinem Zeitpunkt zwei „Abbrechen"-Knoepfe. */}
          <DialogFooter
            style={{
              marginTop: 16,
              gap: 8,
              display: "flex",
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "flex-start",
              // Der Fuss wird nie kleiner als seine eigene Hoehe: er ist
              // der einzige Weg zu „Termin speichern".
              flexShrink: 0,
              // Der Bestaetigungszustand faellt optisch auf: ein normaler
              // Fuss waere hier ein Missverstaendnis, weil „Abbrechen"
              // gerade etwas anderes tut als sonst.
              ...(confirmingDelete
                ? {
                  background: "color-mix(in srgb, var(--danger) 9%, transparent)",
                  borderTop: "1px solid color-mix(in srgb, var(--danger) 45%, transparent)",
                }
                : {}),
            }}
          >
            {confirmingDelete ? (
              <>
                {/* Die Frage nennt den Termin: „Diesen Termin löschen?" sagt
                    bei vielen Terminen nicht, welcher gemeint ist. */}
                <div
                  style={{
                    flexBasis: "100%",
                    marginBottom: 2,
                    fontSize: 12,
                    fontWeight: 550,
                    color: "var(--danger)",
                  }}
                >
                  {t("calendar.deleteConfirm", { title: event?.title?.trim() || t("calendar.unnamed") })}
                </div>

                <div style={{ display: "flex", gap: 8, marginLeft: "auto", flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={handleDeleteCancel}
                    disabled={busy}
                    style={{
                      padding: "6px 12px",
                      fontSize: 12,
                      fontFamily: "inherit",
                      cursor: busy ? "not-allowed" : "pointer",
                      border: "1px solid var(--border)",
                      background: "none",
                      color: "var(--text-muted)",
                      borderRadius: 7,
                    }}
                  >
                    {t("calendar.cancel")}
                  </button>

                  <button
                    type="button"
                    onClick={handleDeleteConfirm}
                    disabled={busy}
                    style={{
                      padding: "6px 12px",
                      fontSize: 12,
                      fontWeight: 550,
                      fontFamily: "inherit",
                      cursor: busy ? "not-allowed" : "pointer",
                      border: "1px solid var(--danger)",
                      background: "var(--danger)",
                      color: "var(--bg)",
                      borderRadius: 7,
                      opacity: busy ? 0.6 : 1,
                    }}
                  >
                    {t("calendar.deleteEvent")}
                  </button>
                </div>
              </>
            ) : (
              <>
                {event ? (
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={busy}
                    style={{
                      flexShrink: 0,
                      padding: "6px 12px",
                      fontSize: 12,
                      fontFamily: "inherit",
                      cursor: busy ? "not-allowed" : "pointer",
                      border: "1px solid var(--danger)",
                      background: "none",
                      color: "var(--danger)",
                      borderRadius: 7,
                    }}
                  >
                    {t("calendar.delete")}
                  </button>
                ) : null}

                {/* Die beiden Aktionsknöpfe bleiben zusammen: sie brechen nicht
                    zwischen Abbrechen und Speichern um. */}
                <div style={{ display: "flex", gap: 8, marginLeft: "auto", flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={onCancel}
                    style={{
                      padding: "6px 12px",
                      fontSize: 12,
                      fontFamily: "inherit",
                      cursor: "pointer",
                      border: "1px solid var(--border)",
                      background: "none",
                      color: "var(--text-muted)",
                      borderRadius: 7,
                    }}
                  >
                    {t("calendar.cancel")}
                  </button>

                  <button
                    type="submit"
                    disabled={busy || !title.trim() || timeInvalid || dateInvalid || hexInvalid}
                    style={{
                      padding: "6px 12px",
                      fontSize: 12,
                      fontWeight: 550,
                      fontFamily: "inherit",
                      cursor: busy || !title.trim() ? "not-allowed" : "pointer",
                      border: "1px solid var(--accent)",
                      background: "var(--accent)",
                      color: "var(--bg)",
                      borderRadius: 7,
                      opacity: busy || !title.trim() ? 0.6 : 1,
                    }}
                  >
                    {busy ? t("calendar.saving") : t("calendar.save")}
                  </button>
                </div>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
