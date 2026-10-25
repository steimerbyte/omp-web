"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCalendarText } from "./useCalendarText";
import type { CalendarEventInput } from "@/hooks/useCalendar";

/**
 * Der Dialog zum Anlegen und Bearbeiten eines Termins.
 *
 * ### Warum Datum und Uhrzeit getrennt sind
 *
 * Der Kalender speichert Ganztagestermine als `"2026-03-14"` und Termine mit
 * Uhrzeit als `"2026-03-14T15:00"`. Der Dialog zeigt deshalb zwei Felder
 * (`<input type="date">` und `<input type="time">`), und das Kästchen
 * "Ganztägig" entscheidet, welches davon ueberhaupt sichtbar ist.
 *
 * Zwei Felder statt eines Freitextfeldes, weil ein Freitextfeld die
 * Schreibweise nicht erzwingt: "14.3.2026 15:00" ist fuer einen Menschen
 * lesbar und fuer den Kalender unbrauchbar. Die zwei Felder koennen nicht
 * missverstanden werden.
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
 * Das Ende, das ein neuer Termin bekommt, wenn der Nutzer keines eintragt.
 *
 * ### Warum eine Stunde nach dem Beginn und nicht dieselbe Uhrzeit
 *
 * Ein Termin, dessen Ende gleich seinem Beginn ist, ist kein Termin: der
 * Server lehnt ihn ab ("Das Ende liegt vor dem Beginn"), und der Nutzer
 * bekaeme eine Fehlermeldung, ohne zu wissen, was er falsch gemacht hat.
 * Er hatte nichts falsch gemacht — er hatte auf eine freie Stunde geklickt.
 *
 * Deshalb bekommt ein Termin aus dem Wochen- oder Tagesraster eine Stunde.
 * Fuer die Monatsansicht (ein Ganztagestermin) gilt derselbe Satz: dort ist
 * das Ende derselbe Tag, und das ist ein *Ganztagestermin* — ein gueltiger
 * Termin mit genau einem Tag.
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
  onCancel,
  onSave,
  onDelete,
}: {
  /** Der bestehende Termin, oder `null` fuer einen neuen. */
  event: { id: string; title: string; start: string; end: string; allDay: boolean; description?: string; location?: string } | null;
  /** Der vorbelegte Tag und die vorbelegte Uhrzeit eines neuen Termins. */
  preset: { date: string; time: string | null };
  /** `true`, solange gespeichert wird. */
  busy: boolean;
  onCancel: () => void;
  onSave: (input: CalendarEventInput, id: string | null) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
}) {
  const t = useCalendarText();

  const [title, setTitle] = useState(event?.title ?? "");
  const [description, setDescription] = useState(event?.description ?? "");
  const [location, setLocation] = useState(event?.location ?? "");
  const [allDay, setAllDay] = useState(event?.allDay ?? preset.time === null);
  const [startDate, setStartDate] = useState(event?.start.slice(0, 10) ?? preset.date);
  const [startTime, setStartTime] = useState(
    event?.start.includes("T") ? event.start.slice(11, 16) : preset.time ?? "09:00",
  );
  const [endDate, setEndDate] = useState(event?.end.slice(0, 10) ?? preset.date);
  const [endTime, setEndTime] = useState(
    event?.end.includes("T") ? event.end.slice(11, 16) : defaultEndTime(preset.time),
  );

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
    setTitle(event?.title ?? "");
    setDescription(event?.description ?? "");
    setLocation(event?.location ?? "");
    setAllDay(event?.allDay ?? preset.time === null);
    setStartDate(event?.start.slice(0, 10) ?? preset.date);
    setStartTime(event?.start.includes("T") ? event.start.slice(11, 16) : preset.time ?? "09:00");
    setEndDate(event?.end.slice(0, 10) ?? preset.date);
    setEndTime(event?.end.includes("T") ? event.end.slice(11, 16) : defaultEndTime(preset.time));
    setEndTouched(false);
    // `preset` wird bewusst nicht mitgenommen: der Dialog wird pro Termin
    // neu geoeffnet, und die Vorbelegung aendert sich waehrend seiner
    // Lebensdauer nicht.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event?.id]);

  /**
   * Der Beginn wurde geaendert.
   *
   * Solange der Nutzer das Ende nicht selbst gesetzt hat, wandert es mit dem
   * Beginn: die Laenge des Termins bleibt, sein Ende nicht. Ein Termin, der
   * beim Verschieben des Beginns zurueckbliebe, waere entweder ungueltig
   * (Ende vor Beginn) oder laege ploetzlich weit in der Zukunft.
   */
  const handleStartTimeChange = (next: string) => {
    setStartTime(next);
    if (endTouched) return;
    setEndTime(defaultEndTime(next));
  };

  /** Baut die Eingaben in das Format des Kalenders. */
  const buildInput = (): CalendarEventInput => ({
    title: title.trim(),
    allDay,
    start: allDay ? startDate : `${startDate}T${startTime}`,
    end: allDay ? endDate : `${endDate}T${endTime}`,
    ...(description.trim() ? { description: description.trim() } : {}),
    ...(location.trim() ? { location: location.trim() } : {}),
  });

  const handleSubmit = (submitEvent: React.FormEvent) => {
    submitEvent.preventDefault();
    if (!title.trim()) return;
    void onSave(buildInput(), event?.id ?? null);
  };

  /**
   * Der Termin wird geloescht — aber erst nach der Rueckfrage.
   *
   * Das Loeschen ist nicht rueckgaengig zu machen: der Termin ist weg, und
   * der Agent weiss nichts davon. Eine Rueckfrage kostet einen Klick, ein
   * Versehen kostet den Termin.
   */
  const handleDelete = () => {
    if (!event) return;
    if (!window.confirm(t("calendar.deleteConfirm"))) return;
    void onDelete(event.id);
  };

  const inputStyle = {
    width: "100%",
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

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent
        showCloseButton={false}
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          color: "var(--text)",
          maxWidth: 420,
          width: "calc(100vw - 32px)",
        }}
      >
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle style={{ fontSize: 15, color: "var(--text)" }}>
              {event ? t("calendar.editEvent") : t("calendar.newEvent")}
            </DialogTitle>
            <DialogDescription style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {t("calendar.eventTitlePlaceholder")}
            </DialogDescription>
          </DialogHeader>

          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 4 }}>
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

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <label style={labelStyle} htmlFor="calendar-start">{t("calendar.eventStart")}</label>
                <input
                  id="calendar-start"
                  type="date"
                  value={startDate}
                  onChange={(inputEvent) => setStartDate(inputEvent.target.value)}
                  style={inputStyle}
                />
                {!allDay ? (
                  <input
                    type="time"
                    aria-label={t("calendar.eventStart")}
                    value={startTime}
                    onChange={(inputEvent) => handleStartTimeChange(inputEvent.target.value)}
                    style={{ ...inputStyle, marginTop: 6 }}
                  />
                ) : null}
              </div>
              <div>
                <label style={labelStyle} htmlFor="calendar-end">{t("calendar.eventEnd")}</label>
                <input
                  id="calendar-end"
                  type="date"
                  value={endDate}
                  onChange={(inputEvent) => setEndDate(inputEvent.target.value)}
                  style={inputStyle}
                />
                {!allDay ? (
                  <input
                    type="time"
                    aria-label={t("calendar.eventEnd")}
                    value={endTime}
                    onChange={(inputEvent) => {
                      setEndTouched(true);
                      setEndTime(inputEvent.target.value);
                    }}
                    style={{ ...inputStyle, marginTop: 6 }}
                  />
                ) : null}
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

          <DialogFooter style={{ marginTop: 16, gap: 8 }}>
            {event ? (
              <button
                type="button"
                onClick={handleDelete}
                disabled={busy}
                style={{
                  marginRight: "auto",
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
              disabled={busy || !title.trim()}
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
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
