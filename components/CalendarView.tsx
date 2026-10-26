"use client";

import { useCallback, useMemo, useState } from "react";
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
  const { events, error, create, update, remove } = useCalendar();

  const [mode, setMode] = useState<CalendarMode>("month");
  const [anchor, setAnchor] = useState<string>(todayDateString);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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
    setEditing({ event: null, preset: { date, time } });
  }, []);

  /** Oeffnet den Dialog fuer einen bestehenden Termin. */
  const openEdit = useCallback((event: CalendarEvent) => {
    setEditing({ event, preset: { date: event.start.slice(0, 10), time: null } });
  }, []);

  /** Speichert den Termin aus dem Dialog. */
  const handleSave = useCallback(async (input: CalendarEventInput, id: string | null) => {
    setBusy(true);
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
      setNotice(t("calendar.saveFailed"));
    } finally {
      setBusy(false);
    }
  }, [create, t, update]);

  /** Loescht einen Termin. */
  const handleDelete = useCallback(async (id: string) => {
    setBusy(true);
    try {
      await remove(id);
      setNotice(t("calendar.deleted"));
      setEditing(null);
    } catch (cause) {
      // Siehe `handleSave`: der Servertext bleibt im Protokoll, die
      // Oberflaeche zeigt eine deutsche Meldung.
      console.error("Failed to delete the calendar event:", cause);
      setNotice(t("calendar.deleteFailed"));
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

  const toolbar = (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "16px 20px 12px",
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
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

      <h1 style={{ margin: 0, fontSize: 17, fontWeight: 650, color: "var(--text)" }}>
        {heading}
      </h1>

      <div style={{ flex: 1 }} />

      {/* Die Umschaltung zwischen den drei Ansichten. */}
      <div
        role="tablist"
        aria-label={t("calendar.title")}
        style={{
          display: "inline-flex",
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
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
            }}
          >
            {t(`calendar.${entry}`)}
          </button>
        ))}
      </div>

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
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        {t("calendar.newEvent")}
      </button>
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
          onCancel={() => setEditing(null)}
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
}: {
  days: string[];
  anchor: string;
  events: CalendarEvent[];
  holidays: Map<string, string>;
  onCreate: (date: string, time: string | null) => void;
  onEdit: (event: CalendarEvent) => void;
  onMove: (event: CalendarEvent, target: MoveTarget) => void;
}) {
  const t = useCalendarText();
  const month = anchor.slice(0, 7);
  const todayDate = todayDateString();

  /** Die Termine eines Tages, nach Beginn sortiert. */
  const eventsOf = (date: string) =>
    events
      .filter((event) => eventSpansDay(event, date))
      .sort((left, right) => (left.start < right.start ? -1 : left.start > right.start ? 1 : 0));

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
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

          return (
            <div
              key={date}
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
              <div style={{
                display: "flex", alignItems: "baseline", gap: 5, minHeight: 16,
                position: "relative", zIndex: 1, pointerEvents: "none",
              }}>
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

              {dayEvents.map((event) => (
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
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "auto" }}>
      {/* Die Ganztagestermine stehen ueber dem Raster, nicht darin. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `56px repeat(${days.length}, 1fr)`,
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
      <div style={{ display: "grid", gridTemplateColumns: `56px repeat(${days.length}, 1fr)`, flex: 1, minHeight: HOUR_HEIGHT * (MINUTES_PER_DAY / 60) }}>
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
