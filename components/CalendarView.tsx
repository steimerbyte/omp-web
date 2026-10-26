"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  GERMAN_WEEKDAYS_MIN,
  addDays,
  buildMonthGrid,
  buildWeekGrid,
  formatGermanDate,
  formatGermanLongDate,
  formatGermanMonthYear,
  formatGermanWeekRange,
  germanHolidays,
  resolveEventColor,
  type CalendarEvent,
} from "@/lib/calendar";
import {
  HOUR_HEIGHT,
  MINUTE_HEIGHT,
  MINUTES_PER_DAY,
  eventSegmentForDay,
  eventSpansDay,
  moveEventToDay,
  moveEventToSlot,
  shiftMonth,
  todayDateString,
} from "./calendar/calendar-model";
import { useCalendar, type CalendarEventInput } from "@/hooks/useCalendar";
import { CalendarEventDialog } from "./calendar/CalendarEventDialog";
import { CalendarImportButton } from "./calendar/CalendarImport";
import { useCalendarText } from "./calendar/useCalendarText";

/**
 * Der Kalender: Monats-, Wochen- und Tagesansicht.
 *
 * ### Die drei Ansichten teilen sich eine Terminfliste
 *
 * Alle drei zeigen dieselben Termine, nur in einer anderen Anordnung. Der
 * Kalender laedt sie deshalb **einmal** — in `hooks/useCalendar.ts` — und
 * rechnet die Ansicht daraus. Drei Ansichten mit drei eigenen Ladevorgaengen
 * waeren drei Staende, die auseinanderlaufen koennen: ein Termin, den der
 * Agent anlegt, muesste in allen dreien erscheinen.
 *
 * ### Die Rechenlogik liegt in `components/calendar/calendar-model.ts`
 *
 * Die Frage "wo liegt dieser Termin auf dem Bildschirm" ist eine reine
 * Darstellung. Sie steht deshalb neben der Oberflaeche und nicht in
 * `lib/calendar.ts` — ein Server, der Bildschirmpixel kennt, ist ein Server
 * mit zwei Aufgaben.
 */

/** Die Ansichten, zwischen denen umgeschaltet wird. */
type CalendarMode = "month" | "week" | "day";

/**
 * Die Mindestbreite des Monatsrasters.
 *
 * Sieben gleich breite Spalten brauchen eine gewisse Breite, damit eine
 * Tageszelle ueberhaupt lesbar ist — ein Tag braucht Platz fuer die Zahl
 * und fuer einen Termin. Darunter ist die Breite der Spalten nicht mehr
 * das Problem, sondern die Frage, ob der Kalender ueberhaupt benutzbar ist.
 *
 * Deshalb hat das Raster eine Mindestbreite, und die Area, in der es
 * liegt, scrollt waagerecht.
 */
const MONTH_MIN_WIDTH = 7 * 96;

/**
 * Die Mindestbreite einer Tagespalte in der Wochen- und Tagesansicht.
 *
 * Neben der Stundenskala (`TIME_AXIS_WIDTH` Pixel) braucht ein Tag
 * mindestens so viel Platz, dass ein Termin mit Uhrzeit lesbar ist.
 */
const TIME_COLUMN_MIN_WIDTH = 120;

/** Die Breite der Stundenskala links neben den Tagen. */
const TIME_AXIS_WIDTH = 56;

/**
 * Wohin ein Termin gezogen wurde.
 *
 * Die Unterscheidung ist die zwischen einem *Tag* und einer *Stelle*. In der
 * Monatsansicht gibt es keine Zeitachse — ein Termin wandert auf einen anderen
 * Tag und behaelt seine Uhrzeit. In der Wochen- und Tagesansicht gibt es die
 * Zeitachse, und der Termin landet auf der gefallenen Stunde.
 *
 * Ohne diese Unterscheidung braeuchte die Monatsansicht einen Sonderfall
 * ("0 Uhr, wenn der Termin eine Uhrzeit hat"), und der waere genau die
 * Stelle, an der ein Termin seine Uhrzeit verliert.
 */
type MoveTarget =
  | { kind: "day"; date: string }
  | { kind: "slot"; date: string; minute: number };

/** Der Termin, der gerade bearbeitet wird — oder `null`, wenn keiner ist. */
interface EditingState {
  /** Der bestehende Termin, oder `null` fuer einen neuen. */
  event: CalendarEvent | null;
  /** Der vorbelegte Tag und die vorbelegte Uhrzeit eines neuen Termins. */
  preset: { date: string; time: string | null };
}

export function CalendarView() {
  const t = useCalendarText();
  const { events, error, create, update, remove, reload } = useCalendar();

  const [mode, setMode] = useState<CalendarMode>("month");
  const [anchor, setAnchor] = useState<string>(todayDateString);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Der Fehler des offenen Dialogs.
   *
   * ### Warum ein eigener Zustand und nicht `notice`
   *
   * `notice` steht in der Leiste *unter* der Kalender-Kopfzeile. Diese
   * Leiste liegt hinter dem Radix-Overlay (`fixed inset-0 z-50`), solange
   * der Dialog offen ist — `document.elementFromPoint` auf ihrer Zeile
   * liefert das Overlay, nie die Meldung. Ein Fehler, der zu einem Fehler
   * *im* Dialog gehoert, muss deshalb im Dialog stehen.
   *
   * `notice` bleibt fuer den Erfolgsfall: da ist der Dialog zu, und die
   * Leiste ist sichtbar.
   */
  const [dialogError, setDialogError] = useState<string | null>(null);

  /**
   * Die Feiertage des Jahres, in dem der Anker liegt.
   *
   * Ein `Map` statt einer Liste: die Anzeige fragt fuer jeden Tag der
   * Ansicht nach, und eine Liste wuerde bei jedem Tag linear durchlaufen.
   */
  const holidays = useMemo(
    () => germanHolidays(Number(anchor.slice(0, 4))),
    [anchor],
  );

  const allEvents = events ?? [];

  /** Die Tage, die das Raster der aktuellen Ansicht zeigt. */
  const gridDays = useMemo(() => {
    if (mode === "month") return buildMonthGrid(anchor);
    if (mode === "week") return buildWeekGrid(anchor);
    return [anchor.slice(0, 10)];
  }, [anchor, mode]);

  /** Die Ueberschrift der Ansicht. */
  const heading = useMemo(() => {
    if (mode === "month") return formatGermanMonthYear(anchor);
    if (mode === "week") return formatGermanWeekRange(anchor);
    return formatGermanLongDate(anchor.slice(0, 10));
  }, [anchor, mode]);

  /** Geht einen Schritt vor oder zurueck — je nach Ansicht eine andere Einheit. */
  const step = useCallback((direction: 1 | -1) => {
    setAnchor((current) => {
      if (mode === "month") {
        // Der erste des Monats plus 32 Tage landet garantiert im naechsten
        // Monat: der laengste Monat hat 31 Tage, und der 32. Tag des Monats
        // ist damit immer der erste des folgenden.
        return shiftMonth(current, direction);
      }
      if (mode === "week") return addDays(current, direction * 7);
      return addDays(current, direction);
    });
  }, [mode]);

  /** Oeffnet den Dialog fuer einen neuen Termin an einem Tag und einer Zeit. */
  const openCreate = useCallback((date: string, time: string | null) => {
    // Ein neuer Dialog beginnt ohne Fehler: der alte Fehler gehoerte zum
    // letzten Termin, nicht zu diesem.
    setDialogError(null);
    setEditing({ event: null, preset: { date, time } });
  }, []);

  /** Oeffnet den Dialog fuer einen bestehenden Termin. */
  const openEdit = useCallback((event: CalendarEvent) => {
    setDialogError(null);
    setEditing({ event, preset: { date: event.start.slice(0, 10), time: null } });
  }, []);

  /** Speichert den Termin aus dem Dialog. */
  const handleSave = useCallback(async (input: CalendarEventInput, id: string | null) => {
    setBusy(true);
    // Der alte Fehler verschwindet mit dem neuen Versuch: sonst stuende
    // eine alte Meldung da, waehrend der Dialog gerade erfolgreich speichert.
    setDialogError(null);
    try {
      if (id) {
        await update(id, input);
        setNotice(t("calendar.updated"));
      } else {
        await create(input);
        setNotice(t("calendar.created"));
      }
      setEditing(null);
    } catch (cause) {
      // Der Text des Servers ist englisch und bleibt im Protokoll — in die
      // Oberflaeche gehoert eine deutsche Meldung. Die Regel aus
      // `docs/i18n.md` sagt das ausdruecklich: einen API-Fehler uebersetzt man
      // nicht, indem man seinen englischen Text erkennt, sondern indem man
      // den *lokalen* Text darueberlegt.
      console.error("Failed to save the calendar event:", cause);
      // Der Fehler gehoert *in* den Dialog: die Leiste unter der Kopfzeile
      // liegt hinter dem Overlay und waere nicht lesbar.
      setDialogError(t("calendar.saveFailed"));
    } finally {
      setBusy(false);
    }
  }, [create, t, update]);

  /** Loescht einen Termin. */
  const handleDelete = useCallback(async (id: string) => {
    setBusy(true);
    setDialogError(null);
    try {
      await remove(id);
      setNotice(t("calendar.deleted"));
      setEditing(null);
    } catch (cause) {
      // Siehe `handleSave`: der Servertext bleibt im Protokoll, die
      // Oberflaeche zeigt eine deutsche Meldung.
      console.error("Failed to delete the calendar event:", cause);
      setDialogError(t("calendar.deleteFailed"));
    } finally {
      setBusy(false);
    }
  }, [remove, t]);

  /**
   * Verschiebt einen Termin auf ein neues Ziel.
   *
   * `targetDate` ist der Tag, `targetMinute` die Minute des Tages — oder
   * `null` fuer einen Ganztagestermin.
   *
   * ### Warum die Laenge erhalten bleibt
   *
   * Ein verschobener Termin ist derselbe Termin an einem anderen Ort. Wuerde
   * die Laenge dabei veraendert, waere ein zweistuendiger Termin nach dem
   * Ziehen einstuendig — und der Nutzer haette keine Moeglichkeit, das zu
   * merken, weil er es selbst gemacht hat.
   */
  const moveEvent = useCallback(async (
    event: CalendarEvent,
    target: MoveTarget,
  ) => {
    try {
      // Die Rechnung steht in `components/calendar/calendar-model.ts`: sie
      // kennt die Faelle, in denen ein Termin ueber Mitternacht laeuft, und
      // die Faelle, in denen ein Ganztagestermin seine Laenge in Tagen
      // behaelt.
      //
      // Der Unterschied zwischen "Tag" und "Stelle" ist nicht kosmetisch:
      // ein Termin, der in der **Monatsansicht** auf einen anderen Tag
      // gezogen wird, behaelt seine Uhrzeit — 14:00 bleibt 14:00. Erst in
      // der Wochen- und Tagesansicht gibt es eine Zeitachse, auf die man
      // fallen kann, und dort wird der Termin auf die gefallene Stunde
      // gesetzt.
      const moved = target.kind === "day"
        ? moveEventToDay(event, target.date)
        : moveEventToSlot(event, target.date, target.minute);
      await update(event.id, moved);
      setNotice(t("calendar.updated"));
    } catch (cause) {
      console.error("Failed to move the calendar event:", cause);
    }
  }, [t, update]);

  // --- Die Kopfzeile ---------------------------------------------------------

  /**
   * Die Kopfzeile.
   *
   * ### Warum sie umbricht und nicht schrumpft
   *
   * Die Kopfzeile ist eine Zeile aus fuenf Teilen: der Navigationsgruppe,
   * der Ueberschrift, dem Tablist und dem „Neuer Termin"-Knopf. Ein Panel
   * kann beliebig schmal sein — der Nutzer zieht die Trennlinie, und auf dem
   * Handy ist das Panel so breit wie das Display. Ein Knopf, den man
   * wegschiebt, ist ein Knopf, den niemand mehr benutzt.
   *
   * Deshalb ist die Zeile **umbruchbar** (`flexWrap`) und die Ueberschrift
   * darf schrumpfen (`minWidth: 0` plus Auslassungspunkte). Umbruchen
   * schrumpfen ist hier nicht moeglich: die Tablist und der Knopf haben
   * eine Mindestbreite, die ihre Beschriftung nicht abschneiden laesst — und
   * abgeschnittene Beschriftungen sind schlimmer als eine zweite Zeile.
   *
   * Die Aktionsgruppe (`marginLeft: "auto"`) sitzt rechts, wenn alles in
   * eine Zeile passt, und rutscht als *ein* Block auf die zweite Zeile,
   * wenn es nicht passt. So bleibt sie zusammen — ein halb umgebrochener
   * Tablist waere schlimmer als ein zweizeiliger.
   */
  const toolbar = (
    <header
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 12,
        rowGap: 8,
        padding: "16px 20px 12px",
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        <IconButton
          label={t("calendar.previous")}
          onClick={() => step(-1)}
          path={<polyline points="15 18 9 12 15 6" />}
        />
        <IconButton
          label={t("calendar.today")}
          onClick={() => setAnchor(todayDateString())}
          text={t("calendar.today")}
        />
        <IconButton
          label={t("calendar.next")}
          onClick={() => step(1)}
          path={<polyline points="9 18 15 12 9 6" />}
        />
      </div>

      <h1
        style={{
          margin: 0,
          fontSize: 17,
          fontWeight: 650,
          color: "var(--text)",
          // Die Ueberschrift ist der einzige Teil der Zeile, der schrumpfen
          // darf: sie ist Text, und ein Text laesst sich notfalls mit
          // Auslassungspunkten kuerzen. Ohne `minWidth: 0` weigert sich das
          // Flex-Element aber, seine Beschriftung zu beschneiden, und
          // schiebt damit die Aktionsgruppe aus dem Panel heraus.
          minWidth: 0,
          // `1 1 120px`: Die Ueberschrift waechst in den freien Platz
          // (sie schiebt damit die Aktionsgruppe nach rechts) und schrumpft
          // auf 120 Pixel Basis, wenn es eng wird. Die Basis ist wichtig
          // fuer den Umbruch: eine Ueberschrift mit der vollen Textbreite
          // als Basis wuerde die Zeile auch dann umbrechen lassen, wenn
          // genug Platz waere.
          flex: "1 1 120px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {heading}
      </h1>

      {/* Die Aktionsgruppe: Umschaltung und „Neuer Termin". */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          rowGap: 8,
          // Sie sitzt rechts, wenn die Zeile passt, und kommt als Block auf
          // die zweite Zeile, wenn sie nicht passt. Umbruch *innerhalb* der
          // Gruppe ist der letzte Ausweg: im schlimmsten Fall rutscht der
          // Knopf „Neuer Termin" unter die Umschaltung.
          flexWrap: "wrap",
          justifyContent: "flex-end",
          // Sie sitzt rechts, wenn die Zeile passt, und kommt als Block auf
          // die zweite Zeile, wenn sie nicht passt. Umbruch *innerhalb* der
          // Gruppe ist der letzte Ausweg: im schlimmsten Fall rutscht der
          // Knopf „Neuer Termin" unter die Umschaltung.
          marginLeft: "auto",
          flex: "0 1 auto",
          // `min-content` statt `0`: die Gruppe schrumpft nur so weit, wie
          // ihre schmalste Zeile breit ist. Mit `0` wuerde die Umschaltung
          // aus der Gruppe herausquellen, weil sie nicht schrumpft.
          minWidth: "min-content",
        }}
      >
        {/* Die Umschaltung zwischen den drei Ansichten. */}
        <div
          role="tablist"
          aria-label={t("calendar.title")}
          style={{
            display: "inline-flex",
            border: "1px solid var(--border)",
            borderRadius: 8,
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          {(["month", "week", "day"] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={mode === entry}
              onClick={() => setMode(entry)}
              style={{
                padding: "5px 12px",
                fontSize: 12,
                fontFamily: "inherit",
                cursor: "pointer",
                border: "none",
                background: mode === entry ? "var(--bg-selected)" : "none",
                color: mode === entry ? "var(--text)" : "var(--text-muted)",
                fontWeight: mode === entry ? 600 : 400,
                whiteSpace: "nowrap",
              }}
            >
              {t(`calendar.${entry}`)}
            </button>
          ))}
        </div>

        {/*
          * Die beiden Aktionsknöpfe: Import und „Neuer Termin".
          *
          * Sie stehen in einer *eigenen* Zeile der Gruppe, damit sie immer
          * zusammenbleiben. Ohne diese Kapselung wuerde der Umbruch sie
          * trennen: die Umschaltung faellt mit dem Import auf eine Zeile,
          * „Neuer Termin" auf die naechste — und die beiden Aktionen, die
          * zusammengehoeren, stuenden allein.
          *
          * `flexShrink: 0` heisst: die Knöpfe werden nie schrumpfen. Ihre
          * Beschriftung ist damit nie abgeschnitten — eine halb
          * abgeschnittene Beschriftung ist schlimmer als eine zweite Zeile.
          */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
          {/*
            * Der Import ist eine Kopfzeilen-Aktion wie „Neuer Termin" — kein
            * eigenes Bedienfeld. Deshalb sitzt er in derselben Gruppe und
            * zwischen der Umschaltung und dem Anlegen-Knopf.
            *
            * `reload` ist der Rueckfall: der Import schreibt ueber die
            * Route, die `notifyCalendarChange` loest, und der SSE-Strom
            * laedt den Kalender nach. Kommt der Strom nicht (der Tab war im
            * Hintergrund, die Verbindung ist weg), laedt `reload` die Termine
            * von Hand. Ohne den Aufruf waere eine importierte Datei erst
            * nach einem Neuladen sichtbar — ein halber Import.
            */}
          <CalendarImportButton onImported={() => { void reload(); }} />

          <button
            type="button"
            onClick={() => openCreate(anchor.slice(0, 10), null)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 12px",
              fontSize: 12,
              fontWeight: 550,
              borderRadius: 8,
              cursor: "pointer",
              border: "1px solid var(--accent)",
              background: "var(--accent)",
              color: "var(--bg)",
              fontFamily: "inherit",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            {t("calendar.newEvent")}
          </button>
        </div>
      </div>
    </header>
  );

  // --- Der Kalender ----------------------------------------------------------

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        // Das Panel kann schmaler sein als der Inhalt. Ohne `minWidth: 0`
        // weigert sich das Flex-Element, schrumpfen zu wollen, und schiebt
        // den Kalender aus dem Panel heraus — die Seite waere dann breiter
        // als das Fenster.
        minWidth: 0,
        overflow: "hidden",
        color: "var(--text)",
      }}
    >
      {toolbar}

      {notice ? (
        <div
          role="status"
          style={{
            padding: "6px 20px",
            fontSize: 12,
            color: "var(--text-muted)",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          {notice}
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            color: "var(--danger)",
            fontSize: 13,
          }}
        >
          {t("calendar.error")}
        </div>
      ) : mode === "month" ? (
        <MonthGrid
          days={gridDays}
          anchor={anchor}
          events={allEvents}
          holidays={holidays}
          onCreate={openCreate}
          onEdit={openEdit}
          onMove={moveEvent}
          onShowDay={(date) => {
            // Der Hinweis „N weitere" fuehrt in die Tagesansicht dieses
            // Tages: dort stehen alle Termine, ohne dass einer abgeschnitten
            // wird.
            setMode("day");
            setAnchor(date);
          }}
        />
      ) : (
        <TimeGrid
          days={gridDays}
          events={allEvents}
          holidays={holidays}
          onCreate={openCreate}
          onEdit={openEdit}
          onMove={moveEvent}
        />
      )}

      {editing ? (
        <CalendarEventDialog
          event={editing.event}
          preset={editing.preset}
          busy={busy}
          // Der Fehler steht *im* Dialog: die Leiste unter der Kopfzeile
          // liegt hinter dem Overlay und waere nicht lesbar.
          error={dialogError}
          onCancel={() => {
            setEditing(null);
            setDialogError(null);
          }}
          onSave={handleSave}
          onDelete={handleDelete}
        />
      ) : null}
    </div>
  );
}

/** Ein Knopf in der Kopfzeile. */
function IconButton({
  label,
  onClick,
  path,
  text,
}: {
  label: string;
  onClick: () => void;
  /** Das Pfad-Element des Icons. */
  path?: React.ReactNode;
  /** Der Text des Knopfes — fuer "Heute". */
  text?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        height: 28,
        minWidth: 28,
        padding: text ? "0 10px" : 0,
        borderRadius: 7,
        cursor: "pointer",
        border: "1px solid var(--border)",
        background: "var(--bg-hover)",
        color: "var(--text-muted)",
        fontSize: 12,
        fontFamily: "inherit",
      }}
    >
      {path ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {path}
        </svg>
      ) : null}
      {text}
    </button>
  );
}

/**
 * Wie viele Termine in eine Zelle des Monatsrasters passen.
 *
 * ### Warum das gerechnet und nicht geraten wird
 *
 * Die Tageszelle schneidet ihren Inhalt ab. Ein Tag mit mehr Terminen, als
 * die Zelle hoch ist, verliert die ueberzaehligen Termine *stillschweigend* —
 * kein Zeichen, kein Tooltip, kein Hinweis. Der Nutzer glaubt, der Tag sei
 * leer.
 *
 * Die Rechnung braucht drei gemessene Groessen:
 *
 * - `cellSpace` — der nutzbare Platz in einer Tageszelle (nach Innenabstand).
 * - `dayRowHeight` — die Hoehe der Zeile mit der Tageszahl.
 * - `chipHeight` — die Hoehe eines Terminchips samt Marge.
 *
 * Der Rest der Zelle steht den Chips zur Verfuegung. Passt ein Termin mehr
 * hinein, wird er gezeigt; passt er nicht, bleibt eine Zeile fuer den
 * Hinweis „N weitere" frei — sonst wuerde der Hinweis selbst abgeschnitten
 * und die Information wieder unsichtbar.
 */
function visibleEventCount(
  count: number,
  cellSpace: number,
  dayRowHeight: number,
  chipHeight: number,
): { shown: number; hidden: number } {
  // Ohne belastbare Messung (erster Durchlauf, oder eine Umgebung ohne
  // Layout) gibt es keine verlaessliche Zahl — dann wird nichts
  // abgeschnitten.
  //
  // Der Test auf `Number.isFinite` ist wichtig: eine Umgebung ohne Layout
  // liefert `undefined` fuer `clientHeight`, und daraus wird `NaN`. `NaN`
  // besteht jeden Vergleich mit `<= 0`, und `slice(0, NaN)` liefert eine
  // leere Liste — der Kalender waere dann *leer*, statt zu viel zu zeigen.
  if (!Number.isFinite(cellSpace) || !Number.isFinite(chipHeight)) {
    return { shown: count, hidden: 0 };
  }
  if (cellSpace <= 0 || chipHeight <= 0) return { shown: count, hidden: 0 };

  const available = cellSpace - (Number.isFinite(dayRowHeight) ? dayRowHeight : 0);
  const capacity = Math.floor(available / chipHeight);
  if (count <= capacity) return { shown: count, hidden: 0 };

  // Passt *nicht einmal* ein Termin hinein, ist die Messung unbrauchbar
  // (oder die Zelle ist so niedrig, dass auch der Hinweis nicht hineinpasst).
  // In beiden Faellen wird nichts abgeschnitten: ein leerer Kalender ist
  // schlimmer als ein ueberlaufender.
  if (capacity < 1) return { shown: count, hidden: 0 };

  // Eine Zeile bleibt fuer den Hinweis frei.
  const shown = Math.max(0, capacity - 1);
  return { shown, hidden: count - shown };
}

/**
 * Die Monatsansicht: ein 6×7-Raster.
 *
 * ### Warum ausserhalb des Monats liegende Tage sichtbar bleiben
 *
 * Der Raster hat immer sechs Wochen, und die Tage des Nachbarmonats stehen
 * mit in den Zellen. Sie sind abgedunkelt, aber *da* — weil eine Zelle, die
 * im Vor- oder Folgemonat liegt, dort hingeht. Wer einen Termin auf einen
 * solchen Tag zieht, soll ihn dort sehen, nicht in einem Fenster, das erst
 * beim Wechsel aufgeht.
 */
function MonthGrid({
  days,
  anchor,
  events,
  holidays,
  onCreate,
  onEdit,
  onMove,
  onShowDay,
}: {
  days: string[];
  anchor: string;
  events: CalendarEvent[];
  holidays: Map<string, string>;
  onCreate: (date: string, time: string | null) => void;
  onEdit: (event: CalendarEvent) => void;
  onMove: (event: CalendarEvent, target: MoveTarget) => void;
  /** Wechselt in die Tagesansicht — fuer den Hinweis „N weitere". */
  onShowDay: (date: string) => void;
}) {
  const t = useCalendarText();
  const month = anchor.slice(0, 7);
  const todayDate = todayDateString();

  /**
   * Das Raster, an dem die Zeilenhoehe gemessen wird.
   *
   * Die Zeilenhoehe entscheidet, wie viele Termine in eine Zelle passen —
   * und die ist nicht konstant, sondern haengt von der Hoehe des Panels ab.
   * Deshalb wird sie gemessen und nicht geraten.
   */
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [cellSpace, setCellSpace] = useState(0);
  const [dayRowHeight, setDayRowHeight] = useState(0);
  const [chipHeight, setChipHeight] = useState(0);
  /** Die Zahl der Termine — *nicht* das Array: `events ?? []` ist bei jedem
   *  Rendern ein neues Array, und ein Effekt, der daran haengt, laeuft bei
   *  jedem Rendern erneut. */
  const eventCount = events.length;

  /**
   * Den Platz in einer Tageszelle messen.
   *
   * Drei Zahlen bestimmen, wie viele Termine in eine Zelle passen: der
   * nutzbare Platz in der Zelle, die Hoehe der Zeile mit der Tageszahl und
   * die Hoehe eines Terminchips samt Marge.
   *
   * Sie werden *gemessen* und nicht geraten: die Zeilenhoehe haengt von der
   * Hoehe des Panels ab, und ein geratener Wert stimmt entweder zu gross
   * (dann schneidet die Zelle den letzten Termin ab — der alte Defekt) oder
   * zu klein (dann verschwinden Termine, die Platz haetten).
   *
   * Die Messung laeuft im Layout-Effekt, also *vor* dem ersten Malen: der
   * Nutzer sieht kein Bild mit ueberlaufenden Terminen, das gleich wieder
   * verschwindet.
   */
  useLayoutEffect(() => {
    const node = gridRef.current;
    if (!node) return;
    const measure = () => {
      // Die Messung darf den Kalender nie umwerfen: eine Umgebung ohne
      // Layout (ein Test-Harness) kennt `clientHeight` nicht, und eine
      // Ausnahme hier waere ein leerer Kalender. Deshalb wird jede Zahl
      // einzeln geprueft.
      try {
        const cell = node.querySelector<HTMLElement>("[data-cal-cell]");
        if (!cell) return;
        const style = getComputedStyle(cell);
        const padding = (Number.parseFloat(style.paddingTop) || 0)
          + (Number.parseFloat(style.paddingBottom) || 0);
        // `clientHeight` enthaelt den Innenabstand, aber keinen Rand — der
        // nutzbare Platz der Zelle ist also `clientHeight` minus Innenabstand.
        const space = cell.clientHeight - padding;
        if (Number.isFinite(space)) setCellSpace(space);

        // Die Tageszeile ist in allen Zellen gleich hoch; fuer den Fall, dass
        // ein Feiertagsname sie ein wenig streckt, zaehlt die groesste.
        const rows = node.querySelectorAll("[data-cal-day-row]");
        let dayRow = 0;
        for (let index = 0; index < rows.length; index++) {
          const height = (rows[index] as HTMLElement).offsetHeight;
          if (Number.isFinite(height)) dayRow = Math.max(dayRow, height);
        }
        if (Number.isFinite(dayRow)) setDayRowHeight(dayRow);

        // Die Chiphoehe ist fuer alle Chips gleich, also genuegt ein einziger
        // gemessener Chip. Die Marge gehoert dazu: sie steht *vor* dem Chip
        // und belegt Platz in der Zelle. Fehlt ein Chip (keine Termine), bleibt
        // der zuletzt gemessene Wert stehen.
        const chip = node.querySelector<HTMLElement>("[data-cal-chip]");
        if (chip) {
          const margin = Number.parseFloat(getComputedStyle(chip).marginTop) || 0;
          const height = chip.getBoundingClientRect().height + margin;
          if (Number.isFinite(height) && height > 0) setChipHeight(height);
        }
      } catch {
        // Ohne belastbare Messung zeigt die Zelle alle Termine.
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [eventCount]);

  /** Die Termine eines Tages, nach Beginn sortiert. */
  const eventsOf = (date: string) =>
    events
      .filter((event) => eventSpansDay(event, date))
      .sort((left, right) => (left.start < right.start ? -1 : left.start > right.start ? 1 : 0));

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/*
        * Der Bereich, in dem das Raster scrollt.
        *
        * Sieben gleich breite Spalten in einem schmalen Panel ergeben
        * Zellen von wenigen Pixeln — der Kalender wird unbrauchbar. Deshalb
        * hat das Raster eine Mindestbreite, und *diese* Area scrollt
        * waagerecht. Nicht die Seite: eine Seite, die seitlich scrollt,
        * verschiebt beim Scrollen das ganze Fenster, und das Panel waere
        * nicht mehr an seinem Platz.
        */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflowX: "auto",
          overflowY: "hidden",
        }}
      >
        <div
          style={{
            minWidth: MONTH_MIN_WIDTH,
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
          }}
        >
          {/* Die Wochentagskopfzeile — Montag zuerst. */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, 1fr)",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
            }}
          >
            {GERMAN_WEEKDAYS_MIN.map((name) => (
              <div
                key={name}
                style={{
                  padding: "6px 8px",
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--text-dim)",
                  textAlign: "center",
                  borderRight: "1px solid var(--border)",
                }}
              >
                {name}
              </div>
            ))}
          </div>

          <div
            ref={gridRef}
            style={{
              flex: 1,
              minHeight: 0,
              display: "grid",
              gridTemplateColumns: "repeat(7, 1fr)",
              gridTemplateRows: "repeat(6, 1fr)",
            }}
          >
        {days.map((date) => {
          const dayEvents = eventsOf(date);
          const outside = date.slice(0, 7) !== month;
          const holiday = holidays.get(date);
          const isToday = date === todayDate;

          /**
           * Wie viele Termine in diese Zelle passen.
           *
           * Die Zelle schneidet ihren Inhalt ab (`overflow: hidden`) — ohne
           * diese Rechnung verliert ein Tag mit vielen Terminen seine
           * Termine *stillschweigend*. Es gibt kein Zeichen, kein Tooltip,
           * nichts: der Termin ist einfach weg.
           *
           * Deshalb wird die Zahl der sichtbaren Termine berechnet und der
           * Rest als „N weitere" ausgewiesen. Der Klick darauf wechselt in
           * die Tagesansicht dieses Tages — dort stehen alle Termine.
           */
          const visibleEvents = visibleEventCount(
            dayEvents.length,
            cellSpace,
            dayRowHeight,
            chipHeight,
          );
          const shownEvents = dayEvents.slice(0, visibleEvents.shown);
          const hiddenCount = dayEvents.length - visibleEvents.shown;

          return (
            <div
              key={date}
              data-cal-cell="true"
              onClick={() => {
                // Der Klick legt einen Termin an — aber nur, wenn er nicht
                // auf einem bestehenden Termin landete. Der Termin
                // stoppt die Ereignisweitergabe selbst.
                onCreate(date, null);
              }}
              onDragEnter={(event) => {
                // `dragenter` ist das Ereignis, das Chromium beim *Betreten*
                // einer Zelle feuert; `dragover` folgt erst mit der
                // naechsten Mausbewegung. **Beide** muessen abgebrochen
                // werden: nur so gilt der Zug in dieser Zelle als
                // angenommen. Bleibt `dragenter` ungebrochen, ist der
                // Vorgang beim Loslassen "nicht angenommen" und der Browser
                // verweigert den Fall — der Termin bleibt dann einen Tag zu
                // frueh stehen. Gemessen im Browser: `dragover` allein
                // genuegt nicht, es fehlt dann jedes `drop`.
                event.preventDefault();
              }}
              onDragOver={(event) => {
                // `preventDefault` ist, was den Tag zum gueltigen
                // Abholziel macht. Ohne das weigert der Browser den Fall.
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const id = event.dataTransfer.getData("text/plain");
                const source = events.find((candidate) => candidate.id === id);
                if (!source) return;
                // In der Monatsansicht gibt es keine Zeitachse: der Termin
                // wandert auf den Tag und behaelt seine Uhrzeit.
                void onMove(source, { kind: "day", date });
              }}
              style={{
                position: "relative",
                borderRight: "1px solid var(--border)",
                borderBottom: "1px solid var(--border)",
                padding: "4px 5px",
                minHeight: 0,
                overflow: "hidden",
                background: outside ? "color-mix(in srgb, var(--bg) 60%, var(--bg-panel))" : "none",
                cursor: "pointer",
              }}
            >
              {/* Die Tageszeile ist ein *Geschwister* des Chips, nicht sein
                  Vorfahr. Sie darf den Zug deshalb nicht auffangen — sonst
                  waere ueber der Tageszahl kein Fall moeglich. */}
              <div
                data-cal-day-row="true"
                style={{
                  display: "flex", alignItems: "baseline", gap: 5, minHeight: 16,
                  position: "relative", zIndex: 1, pointerEvents: "none",
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: isToday ? 700 : 500,
                    color: isToday ? "var(--accent)" : outside ? "var(--text-dim)" : "var(--text-muted)",
                  }}
                >
                  {Number(date.slice(8, 10))}
                </span>
                {holiday ? (
                  <span
                    title={holiday}
                    style={{
                      fontSize: 10,
                      color: "var(--danger)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {holiday}
                  </span>
                ) : null}
              </div>

              {shownEvents.map((event) => (
                <EventChip
                  key={`${event.id}-${date}`}
                  event={event}
                  onClick={(clickEvent) => {
                    clickEvent.stopPropagation();
                    onEdit(event);
                  }}
                  onDragStart={(dragEvent) => {
                    dragEvent.dataTransfer.setData("text/plain", event.id);
                    dragEvent.dataTransfer.effectAllowed = "move";
                  }}
                />
              ))}

              {/* Die Termine, die nicht mehr passen, werden nicht
                  verschwiegen: der Hinweis nennt ihre Zahl und fuehrt in die
                  Tagesansicht, in der alle stehen. */}
              {hiddenCount > 0 ? (
                <button
                  type="button"
                  onClick={(clickEvent) => {
                    clickEvent.stopPropagation();
                    onShowDay(date);
                  }}
                  title={t("calendar.more", { count: hiddenCount })}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    marginTop: 2,
                    padding: "0 5px",
                    border: "none",
                    borderRadius: 4,
                    background: "none",
                    color: "var(--text-muted)",
                    fontSize: 10,
                    lineHeight: 1.4,
                    fontFamily: "inherit",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {t("calendar.more", { count: hiddenCount })}
                </button>
              ) : null}

              {dayEvents.length === 0 && !holiday && isToday ? (
                <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
                  {t("calendar.noEvents")}
                </div>
              ) : null}
            </div>
          );
        })}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Die Flaeche, auf der ein Termin gezeichnet wird.
 *
 * ### Warum die Farbe *gemischt* wird und nicht gefüllt
 *
 * Der Hintergrund ist die Terminfarbe, mit der Flaeche des Themes gemischt —
 * nicht die Terminfarbe selbst. Das ist der Grund, warum ein Termin auch
 * mit `#ffffff` lesbar bleibt: eine gefuellte weisse Flaeche im hellen Theme
 * waere ein weisses Rechteck auf weissem Grund, ohne Rand und ohne Text, der
 * sich vom Untergrund abhebt. Der Text bleibt deshalb `var(--text)` — die
 * Theme-Farbe, nicht die Terminfarbe. Nur so tragen *alle* Terminfarben
 * denselben Text: der Kontrast haengt am Theme, nicht an der Wahl des
 * Nutzers.
 *
 * Der linke Rand bleibt die volle Terminfarbe. Er ist das, was den Termin
 * auf einen Blick erkennbar macht — eine Flaeche, die nur 20 Prozent der
 * Farbe enthaelt, waere fuer sich allein zu leise.
 */
function eventSurface(event: CalendarEvent, mixPercent: number): {
  borderLeft: string;
  background: string;
  color: string;
} {
  const color = resolveEventColor(event);
  return {
    borderLeft: `3px solid ${color}`,
    background: `color-mix(in srgb, ${color} ${mixPercent}%, var(--bg-panel))`,
    color: "var(--text)",
  };
}

/**
 * Die Wochen- und die Tagesansicht: eine Stundenskala ueber den Tagen.
 *
 * Die beiden Ansichten unterscheiden sich nur in der Zahl der Spalten — der
 * Rest des Aufbaus ist derselbe. Deshalb sind sie eine Komponente mit einem
 * Schalter, und nicht zwei.
 */
function TimeGrid({
  days,
  events,
  holidays,
  onCreate,
  onEdit,
  onMove,
}: {
  days: string[];
  events: CalendarEvent[];
  holidays: Map<string, string>;
  onCreate: (date: string, time: string | null) => void;
  onEdit: (event: CalendarEvent) => void;
  onMove: (event: CalendarEvent, target: MoveTarget) => void;
}) {
  const t = useCalendarText();
  /** Die Ganztagestermine eines Tages. */
  const allDayOf = (date: string) =>
    events.filter((event) => event.allDay && eventSpansDay(event, date));

  /**
   * Die Termine mit Uhrzeit, die den Tag beruehren.
   *
   * Geprueft wird der *beruehrte* Tag und nicht der Starttag: ein Termin von
   * 23:00 bis 00:30 gehoert zu beiden Tagen, und im Tagesraster des zweiten
   * Tages muss sein Ende um 24:00 zu sehen sein.
   */
  const timedOf = (date: string) =>
    events.filter((event) => !event.allDay && eventSpansDay(event, date));

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/*
        * Der Bereich, in dem die Ansicht scrollt.
        *
        * Neben der Stundenskala (56 Pixel) braucht jeder Tag eine gewisse
        * Mindestbreite — sonst ist ein Termin mit Uhrzeit nicht lesbar. Bei
        * sieben Tagen ist das in einem schmalen Panel nicht mehr darstellbar.
        *
        * Deshalb hat der Raster eine Mindestbreite, und *diese* Area
        * scrollt waagerecht. Nicht die Seite: eine Seite, die seitlich
        * scrollt, verschiebt beim Scrollen das ganze Fenster.
        */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <div
          style={{
            minWidth: TIME_AXIS_WIDTH + days.length * TIME_COLUMN_MIN_WIDTH,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Die Ganztagestermine stehen ueber dem Raster, nicht darin. */}
          <div
            style={{
              display: "grid",
              // `minmax` statt `1fr`: die Spalte *darf* schrumpfen, aber
              // nicht unter ihre Mindestbreite — sonst ist ein Tag so breit
              // wie ein Pixel und ein Termin unlesbar.
              gridTemplateColumns: `${TIME_AXIS_WIDTH}px repeat(${days.length}, minmax(${TIME_COLUMN_MIN_WIDTH}px, 1fr))`,
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
            }}
          >
            <div />
            {days.map((date) => (
              <div key={date} style={{ padding: "4px 6px", borderRight: "1px solid var(--border)" }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>
                  {Number(date.slice(8, 10))}.
                </div>
                {holidays.get(date) ? (
                  <div style={{ fontSize: 10, color: "var(--danger)" }}>{holidays.get(date)}</div>
                ) : null}
                {allDayOf(date).map((event) => (
                  <EventChip
                    key={event.id}
                    event={event}
                    onClick={(clickEvent) => {
                      clickEvent.stopPropagation();
                      onEdit(event);
                    }}
                    onDragStart={(dragEvent) => {
                      dragEvent.dataTransfer.setData("text/plain", event.id);
                    }}
                  />
                ))}
              </div>
            ))}
          </div>

          {/* Die Stundenskala. */}
          <div style={{ display: "grid", gridTemplateColumns: `${TIME_AXIS_WIDTH}px repeat(${days.length}, minmax(${TIME_COLUMN_MIN_WIDTH}px, 1fr))`, flex: 1, minHeight: HOUR_HEIGHT * (MINUTES_PER_DAY / 60) }}>
        <div>
          {Array.from({ length: MINUTES_PER_DAY / 60 }, (_, hour) => (
            <div
              key={hour}
              style={{
                height: HOUR_HEIGHT,
                position: "relative",
                fontSize: 10,
                color: "var(--text-dim)",
                textAlign: "right",
                paddingRight: 6,
              }}
            >
              <span style={{ position: "relative", top: "-6px" }}>
                {String(hour).padStart(2, "0")}
              </span>
            </div>
          ))}
        </div>

        {days.map((date) => (
          <div
            key={date}
            style={{ borderRight: "1px solid var(--border)", position: "relative" }}
          >
            {Array.from({ length: MINUTES_PER_DAY / 60 }, (_, hour) => (
              <div
                key={hour}
                onClick={() => onCreate(date, `${String(hour).padStart(2, "0")}:00`)}
                onDragEnter={(dragEvent) => {
                  // `dragenter` ist das Ereignis, das Chromium beim *Betreten*
                  // der Stundenzelle feuert; `dragover` folgt erst mit der
                  // naechsten Mausbewegung. **Beide** muessen abgebrochen
                  // werden — sonst ist der Vorgang beim Loslassen nicht
                  // angenommen und der Browser verweigert den Fall. Siehe
                  // die gleiche Erklaerung an der Tageszelle der
                  // Monatsansicht.
                  dragEvent.preventDefault();
                }}
                onDragOver={(dragEvent) => {
                  dragEvent.preventDefault();
                  dragEvent.dataTransfer.dropEffect = "move";
                }}
                onDrop={(dropEvent) => {
                  dropEvent.preventDefault();
                  const id = dropEvent.dataTransfer.getData("text/plain");
                  const source = events.find((candidate) => candidate.id === id);
                  if (!source) return;
                  void onMove(source, { kind: "slot", date, minute: hour * 60 });
                }}
                style={{
                  height: HOUR_HEIGHT,
                  borderBottom: "1px solid color-mix(in srgb, var(--border) 55%, transparent)",
                  cursor: "pointer",
                }}
              />
            ))}

            {/* Die Termine mit Uhrzeit liegen absolut ueber dem Raster. */}
            {timedOf(date).map((event) => {
              // `eventSegmentForDay` liefert nur den Teil des Termins, der
              // auf *diesen* Tag liegt: ein Termin ueber Mitternacht endet
              // hier um 24:00 und beginnt im naechsten Tag um 00:00.
              const segment = eventSegmentForDay(event, date);
              if (!segment) return null;
              const position = segment;
              return (
                <div
                  key={event.id}
                  draggable
                  onDragStart={(dragEvent) => {
                    dragEvent.dataTransfer.setData("text/plain", event.id);
                    dragEvent.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={(clickEvent) => {
                    clickEvent.stopPropagation();
                    onEdit(event);
                  }}
                  title={`${event.title} · ${event.start.slice(11)}–${event.end.slice(11)}`}
                  style={{
                    position: "absolute",
                    top: position.top * MINUTE_HEIGHT,
                    height: position.height * MINUTE_HEIGHT,
                    left: 2,
                    right: 2,
                    borderRadius: 5,
                    padding: "2px 5px",
                    fontSize: 11,
                    lineHeight: 1.25,
                    overflow: "hidden",
                    cursor: "grab",
                    ...eventSurface(event, 22),
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{event.title}</div>
                  <div style={{ color: "var(--text-muted)", fontSize: 10 }}>
                    {event.start.slice(11)}–{event.end.slice(11)}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
          </div>
        </div>
      </div>

      {events.length === 0 ? (
        <div
          style={{
            padding: "24px",
            textAlign: "center",
            color: "var(--text-dim)",
            fontSize: 12,
          }}
        >
          {t("calendar.noEventsHint")}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Ein Termin als Chip.
 *
 * Der Chip ist der Griff zum Ziehen. `draggable` auf dem Chip und nicht auf
 * der ganzen Zelle: der Ziehen-Mauszeiger soll nur ueber dem Termin
 * erscheinen, und ein Klick auf die freie Flaeche der Zelle soll einen
 * *neuen* Termin anlegen, nicht den vorhandenen zu greifen.
 *
 * ### Warum der gezogene Termin im `dataTransfer` reist und nicht im State
 *
 * Der natuerliche Weg waere ein State-Feld "dieser Termin wird gerade
 * gezogen". Er ist aber der falsche: `setDragging` in `onDragStart` loest ein
 * Rendern aus, und Chromium **bricht den Zug ab**, wenn das Quellelement
 * waehrend des Ziehens ersetzt wird. Gemessen im Browser: mit dem State-Feld
 * endete der Zug nach dem ersten `dragover` auf dem Chip, mit dem
 * `dataTransfer` kommt er am Ziel an.
 *
 * Das `dataTransfer` ist ohnehin der richtige Ort: es gehoert zum Zug, nicht
 * zur Oberflaeche, und es ueberlebt ein Rendern.
 */
function EventChip({
  event,
  onClick,
  onDragStart,
}: {
  event: CalendarEvent;
  onClick: (event: React.MouseEvent) => void;
  onDragStart: (event: React.DragEvent) => void;
}) {
  return (
    <div
      draggable
      data-cal-chip="true"
      onClick={onClick}
      onDragStart={onDragStart}
      title={`${event.title} · ${formatGermanDate(event.start.slice(0, 10))}`}
      style={{
        // `position: relative` hebt den Chip ueber die Flaeche seiner Zelle —
        // er bleibt klickbar, und beim Ziehen ueber ihn trifft es die Zelle
        // darunter, die das Abholziel ist.
        position: "relative",
        zIndex: 1,
        marginTop: 2,
        padding: "1px 5px",
        borderRadius: 4,
        fontSize: 11,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        cursor: "grab",
        ...eventSurface(event, 20),
      }}
    >
      {event.title}
    </div>
  );
}
