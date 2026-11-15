"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { formatGermanDate, normalizeDateInput, sanitizeDateInput, startOfMonth } from "@/lib/calendar";
import { todayDateString } from "./calendar-model";
import { useCalendarText } from "./useCalendarText";
import {
  PICKER_RATIO,
  PICKER_WIDTH,
  PICKER_WEEKDAY_INITIALS,
  nextPickerDate,
  pickerDateHeader,
  pickerMonthGrid,
  pickerMonthLabel,
  shiftPickerMonth,
} from "./calendar-picker";

/**
 * Die Datumswahl — dasselbe Bild wie in der Vorlage: ein Kopfband mit dem
 * gewaehlten Tag in grossen Lettern, darunter ein Monat zum Blaettern und ein
 * Raster aus sechs Wochen.
 *
 * ### Warum das Raster sechs Zeilen hat
 *
 * Damit es beim Blaettern nicht springt: ein Monat mit vier Wochen und einer
 * mit sechs haetten sonst verschiedene Hoehen, und der Knopf „weiter" wandert
 * unter dem Finger weg. Dieselbe Regel wie in der Monatsansicht des Kalenders
 * (`buildMonthGrid`).
 *
 * ### Warum der Kopf den Tag in Worten zeigt
 *
 * Das Raster zeigt Zahlen; „18" allein sagt nicht, ob der Termin auf einem
 * Mittwoch liegt oder auf einem Sonntag. Der Kopf nennt beides — Wochentag
 * und Tag — und ist damit die Antwort auf die Frage, die der Nutzer gerade
 * stellt: *Welcher Tag ist das?*
 *
 * Die Tage des Nachbarmonats bleiben leer; wer im Oktober stoebern will,
 * blaettert. Ein Raster, das zwei Monate zeigt, sieht aus wie ein Monat und
 * trifft den falschen Tag.
 */

export function DatePickerDialog({
  value,
  onCancel,
  onConfirm,
  layer = 60,
}: {
  /** Das Datum, mit dem der Dialog aufgeht (`YYYY-MM-DD`). */
  value: string | null;
  onCancel: () => void;
  /** Ein Tag wurde bestaetigt. */
  onConfirm: (date: string) => void;
  /** Die Ebene ueber dem aufrufenden Dialog. */
  layer?: number;
}) {
  const t = useCalendarText();
  const today = todayDateString();
  const [selected, setSelected] = useState(value ?? today);
  /**
   * Der gezeigte Monat, als erster Tag notiert.
   *
   * Eigener Zustand neben `selected`: Blaettern aendert, was man *sieht*,
   * nicht was man *waehlt*. Wer drei Monate vorblaettert und dann abbricht,
   * hat nichts gewaehlt.
   */
  const [month, setMonth] = useState(startOfMonth(value ?? today));
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState(formatGermanDate(value ?? today));
  const [draftInvalid, setDraftInvalid] = useState(false);

  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const grid = pickerMonthGrid(year, monthNumber);
  const header = pickerDateHeader(selected);

  const dayRefs = useRef(new Map<string, HTMLButtonElement>());

  /**
   * Der Fokus steht auf dem gewaehlten Tag.
   *
   * Ein Raster ohne Fokusmarke ist mit der Tastatur nicht zu bedienen: die
   * Pfeiltasten brauchen ein Element, das sie empfaengt, und der Nutzer muss
   * sehen, wo er steht. Beim Oeffnen ist das der gewaehlte Tag, nach jedem
   * Schritt der neue.
   */
  useEffect(() => {
    dayRefs.current.get(selected)?.focus();
  }, [selected, month]);

  /** Ein Tag wurde angetippt. */
  const choose = (date: string) => {
    setSelected(date);
  };

  /** Pfeiltasten, Bild auf/ab, Pos1/Ende — die Rechnung steht in der Domane. */
  const handleGridKey = (keyEvent: React.KeyboardEvent) => {
    if (keyEvent.key === "Enter" || keyEvent.key === " ") return;
    const next = nextPickerDate(selected, keyEvent.key);
    if (next === selected) return;
    keyEvent.preventDefault();
    setSelected(next);
    // Der Monat folgt der Auswahl: ein Tag jenseits des Rands ist sonst
    // gewaehlt, aber nicht zu sehen.
    setMonth(startOfMonth(next));
  };

  /** Der Fuss: „OK". */
  const confirm = () => {
    if (typing) {
      const normalized = normalizeDateInput(draft);
      if (!normalized) {
        setDraftInvalid(true);
        return;
      }
      onConfirm(normalized);
      return;
    }
    onConfirm(selected);
  };

  const cell = PICKER_WIDTH * 0.125;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent
        bare
        layer={layer}
        showCloseButton={false}
        aria-describedby={undefined}
        data-date-picker="true"
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          color: "var(--text)",
          maxWidth: "calc(100vw - 16px)",
          overflow: "hidden",
        }}
      >
        <form
          onSubmit={(submitEvent) => { submitEvent.preventDefault(); confirm(); }}
          style={{
            width: PICKER_WIDTH,
            maxWidth: "100%",
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Das Kopfband. Zwei Zeilen, weil sie zwei verschiedene Fragen
              beantworten: das Jahr ordnet den Tag ein, der Tag nennt ihn. */}
          <div
            data-picker-header="true"
            style={{
              padding: `${PICKER_WIDTH * 0.06}px ${PICKER_WIDTH * 0.07}px`,
              background: "var(--bg-selected)",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            <DialogTitle style={{ fontSize: PICKER_WIDTH * PICKER_RATIO.year, fontWeight: 500, lineHeight: 1.2 }}>
              {year}
            </DialogTitle>
            <span style={{ fontSize: PICKER_WIDTH * PICKER_RATIO.bigDate, lineHeight: 1.1, fontWeight: 400 }}>
              {header.weekday}, {header.dayMonth}
            </span>
          </div>

          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
            {/* Der Monat und die beiden Pfeile. */}
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <button
                type="button"
                onClick={() => setMonth(shiftPickerMonth(month, -1))}
                aria-label={t("calendar.picker.previousMonth")}
                data-picker-previous="true"
                style={chevronStyle}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m15 18-6-6 6-6" />
                </svg>
              </button>
              <span
                style={{ flex: "1 1 auto", textAlign: "center", fontSize: PICKER_WIDTH * PICKER_RATIO.month, fontWeight: 500 }}
                aria-live="polite"
              >
                {pickerMonthLabel(year, monthNumber)}
              </span>
              <button
                type="button"
                onClick={() => setMonth(shiftPickerMonth(month, 1))}
                aria-label={t("calendar.picker.nextMonth")}
                data-picker-next="true"
                style={chevronStyle}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", fontSize: PICKER_WIDTH * PICKER_RATIO.initials }}>
              {PICKER_WEEKDAY_INITIALS.map((initial, column) => (
                // Die Initialen wiederholen sich (M, D, S) — der Index ist
                // der einzige eindeutige Schluessel.
                <span key={column} aria-hidden="true" style={{ textAlign: "center", padding: "4px 0" }}>
                  {initial}
                </span>
              ))}
            </div>

            <div
              data-picker-grid="true"
              onKeyDown={handleGridKey}
              style={{
                display: "grid",
                // Sieben gleiche Spalten, die schrumpfen duerfen, und eine
                // Obergrenze von der gemessenen Zellgroesse: auf einem 320 px
                // breiten Bildschirm wird das Raster kleiner statt
                // abgeschnitten.
                gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
                maxWidth: cell * 7,
                margin: "0 auto",
                fontSize: PICKER_WIDTH * PICKER_RATIO.day,
              }}
            >
              {grid.flat().map((date, index) => (
                date === null
                  ? <span key={`leer-${index}`} style={{ width: "100%", aspectRatio: "1" }} />
                  : (
                    <button
                      key={date}
                      ref={(element) => {
                        if (element) dayRefs.current.set(date, element);
                        else dayRefs.current.delete(date);
                      }}
                      type="button"
                      onClick={() => choose(date)}
                      aria-label={formatGermanDate(date)}
                      aria-pressed={date === selected}
                      data-picker-day={date}
                      style={{
                        ...dayStyle,
                        width: "100%",
                        aspectRatio: "1",
                        ...(date === selected ? { background: "var(--bg-selected)" } : null),
                        // Der heutige Tag ist in der Vorlage blasser als die
                        // anderen und traegt keinen Ring: er ist ein Hinweis,
                        // keine Auswahl.
                        ...(date === today && date !== selected ? { color: "var(--text-muted)" } : null),
                      }}
                    >
                      {Number(date.slice(8, 10))}
                    </button>
                  )
              ))}
            </div>

            {typing
              ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
                  <input
                    autoFocus
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    value={draft}
                    onChange={(inputEvent) => {
                      setDraft(sanitizeDateInput(inputEvent.target.value));
                      setDraftInvalid(false);
                    }}
                    aria-label={t("calendar.datePicker.title")}
                    aria-invalid={draftInvalid || undefined}
                    placeholder="18.11.2026"
                    data-picker-text="true"
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      padding: "8px 10px",
                      fontSize: 14,
                      fontFamily: "inherit",
                      color: "var(--text)",
                      background: "var(--bg)",
                      border: `1px solid ${draftInvalid ? "var(--danger)" : "var(--border)"}`,
                      borderRadius: 8,
                    }}
                  />
                  {draftInvalid
                    ? <span style={{ fontSize: 11, color: "var(--danger)" }}>{t("calendar.invalidDate")}</span>
                    : <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("calendar.dateFormatHint")}</span>}
                </div>
              )
              : null}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px 10px" }}>
            <button
              type="button"
              onClick={() => {
                setDraft(formatGermanDate(selected));
                setDraftInvalid(false);
                setTyping((open) => !open);
              }}
              aria-label={t("calendar.picker.keyboard")}
              aria-pressed={typing}
              data-picker-text-toggle="true"
              style={chevronStyle}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm2 2v2h2V8H5Zm4 0v2h2V8H9Zm4 0v2h2V8h-2Zm4 0v2h2V8h-2ZM5 12v2h2v-2H5Zm4 0v2h2v-2H9Zm4 0v2h2v-2h-2Zm4 0v2h2v-2h-2Zm-8 4v1h8v-1H9Z" />
              </svg>
            </button>
            <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
              <button type="button" onClick={onCancel} style={footerButtonStyle}>
                {t("common.cancel")}
              </button>
              <button type="submit" style={{ ...footerButtonStyle, color: "var(--accent)" }}>
                {t("common.ok")}
              </button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Ein Tag im Raster — quadratisch, damit der gewaehlte Kreis rund wird. */
const dayStyle: React.CSSProperties = {
  margin: 0,
  padding: 0,
  fontFamily: "inherit",
  fontSize: "inherit",
  lineHeight: 1,
  fontVariantNumeric: "tabular-nums",
  color: "var(--text)",
  background: "transparent",
  border: "none",
  borderRadius: "50%",
  cursor: "pointer",
};

/** Die Pfeile und der Umschalter auf die Texteingabe. */
const chevronStyle: React.CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 32,
  height: 32,
  color: "var(--text)",
  background: "transparent",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
};

/** „Abbrechen" und „OK". */
const footerButtonStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 13,
  fontFamily: "inherit",
  fontWeight: 500,
  color: "var(--text-muted)",
  background: "transparent",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
};
