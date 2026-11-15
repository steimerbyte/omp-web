"use client";

import { useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { normalizeTimeInput, sanitizeTimeInput } from "@/lib/calendar";
import { useCalendarText } from "./useCalendarText";
import {
  PICKER_RATIO,
  PICKER_WIDTH,
  dialNumberPositions,
  dialValueAt,
  type PickerFace,
} from "./calendar-picker";

/**
 * Die Uhrzeitwahl als Zifferblatt — dieselbe, die Android zeigt.
 *
 * ### Warum ein Zifferblatt und keine zwei Zahlenfelder
 *
 * Weil die Uhrzeit im Alltag meist *grob* gewaehlt wird: „heute Nachmittag um
 * vier" ist ein Punkt auf einer Scheibe, nicht die Ziffernfolge `16`. Wer
 * dagegen `16:37` braucht, tippt sie — dafuer gibt es den Umschalter unten
 * links, und das Feld dort nimmt jede Form an, die das Kalenderformat kennt
 * (`930`, `16:3`, `16:37`).
 *
 * ### Die zwei Schritte
 *
 * Wie in der Vorlage: erst die Stunde, dann die Minute. Sobald eine Stunde
 * angetippt ist, springt das Zifferblatt auf die Minuten; wer zurueck will,
 * tippt auf das Stundenfeld. Wer auf dem Minutenblatt nichts tut, bestaetigt
 * die volle Stunde (`:00`) — sie steht schon im Feld.
 *
 * ### Die Masse
 *
 * Alle Kantenlaengen kommen aus `PICKER_RATIO` (gemessen an der Vorlage) mal
 * `PICKER_WIDTH`; hier steht keine einzige Zahl, die nicht dort herkommt.
 * Farben sind ausschliesslich Theme-Variablen — das Zifferblatt und die
 * inaktiven Felder tragen `--bg` mit einem Rand, die gewaehlte Zahl und das
 * aktive Feld `--bg-selected`. `--bg-subtle` taugt hier nicht: es kann im
 * selben Palette denselben Wert wie `--bg-selected` tragen, und dann
 * verschwindet der gewaehlte Kreis.
 */

/** Zwei Ziffern mit fuehrender Null. */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Die Uhrzeit `HH:MM` in ihre beiden Zahlen. */
function parseTime(time: string | null): { hour: number; minute: number } {
  const normalized = normalizeTimeInput(time ?? "") ?? "09:00";
  return { hour: Number(normalized.slice(0, 2)), minute: Number(normalized.slice(3, 5)) };
}

export function TimePickerDialog({
  value,
  onCancel,
  onConfirm,
  layer = 60,
}: {
  /** Die Uhrzeit, mit der das Zifferblatt aufgeht (`HH:MM`). */
  value: string | null;
  onCancel: () => void;
  /** Eine Uhrzeit wurde bestaetigt. */
  onConfirm: (time: string) => void;
  /** Die Ebene ueber dem aufrufenden Dialog. */
  layer?: number;
}) {
  const t = useCalendarText();
  const initial = parseTime(value);
  const [hour, setHour] = useState(initial.hour);
  const [minute, setMinute] = useState(initial.minute);
  /** Welches der beiden Felder das Zifferblatt gerade zeigt. */
  const [face, setFace] = useState<PickerFace>("hour");
  /** `true`, wenn statt des Zifferblatts getippt wird. */
  const [typing, setTyping] = useState(false);
  /** Der Text im Tippfeld. */
  const [draft, setDraft] = useState(`${pad2(initial.hour)}:${pad2(initial.minute)}`);
  /** Der getippte Text ist keine Uhrzeit — dann wird nicht bestaetigt. */
  const [draftInvalid, setDraftInvalid] = useState(false);

  const dial = PICKER_WIDTH * PICKER_RATIO.dial;

  /**
   * Die gewaehlte Zahl auf dem Zifferblatt.
   *
   * Auf dem Minutenblatt gibt es nur Fuenf-Minuten-Schritte; eine getippte
   * `16:37` sitzt deshalb auf `35`. Der Kreis zeigt den Schritt, der *naechste*
   * Wert bleibt der getippte — das Zifferblatt zeigt die Scheibe, nicht den
   * Wert.
   */
  const active = face === "hour" ? hour : (Math.round(minute / 5) * 5) % 60;
  const positions = dialNumberPositions(face);
  const mark = positions.find((position) => position.value === active) ?? positions[0];

  /** Ein Wert wurde auf dem Zifferblatt gewaehlt. */
  const pick = (next: number) => {
    if (face === "hour") {
      // Die Vorlage springt nach der Stunde auf die Minuten; die Stunde ist
      // damit gesetzt, und `:00` steht schon im Minutenfeld.
      setHour(next);
      setFace("minute");
      return;
    }
    // Minuten sind Fuenf-Minuten-Schritte. Eine Zahl, die noch von der
    // Stundenscheibe stammt (ein Klick, der waehrend des Blattwechsels
    // eintrifft), wuerde sonst eine Minute wie 16:04 setzen.
    setMinute((Math.round(next / 5) * 5) % 60);
  };

  /**
   * Ein Punkt auf dem Zifferblatt wurde gegriffen — beim Druecken und beim
   * Ziehen.
   *
   * Gerechnet wird in Anteilen am Radius, also unabhaengig davon, wie breit
   * das Zifferblatt gerade gezeichnet ist: `getBoundingClientRect` liefert
   * die tatsaechliche Groesse, und dieselbe Rechnung gilt fuer Maus, Finger
   * und einen verkleinerten Dialog.
   *
   * `dragging` ist ein Ref und kein Zustand: ein Zug darf das Zifferblatt
   * nicht neu rendern, sonst haengt der Zeiger bei jedem Schritt einen
   * Renderzyklus hinterher.
   */
  const dragging = useRef(false);
  /** Der Zug endet — beim Loslassen, beim Verlassen und beim Abbruch gleich. */
  const stopDragging = () => { dragging.current = false; };
  const pickAt = (clientX: number, clientY: number, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const radius = rect.width / 2;
    if (radius === 0) return;
    const dx = (clientX - rect.left - radius) / radius;
    const dy = (clientY - rect.top - radius) / radius;
    // Die Mitte des Zifferblatts hat keinen Sektor; ein Griff dorthin ist
    // kein Wunsch nach „18 Uhr".
    if (Math.hypot(dx, dy) < 0.15) return;
    pick(dialValueAt(dx, dy, face));
  };

  /** Der Fuss: „OK". */
  const confirm = () => {
    if (typing) {
      const normalized = normalizeTimeInput(draft);
      if (!normalized) {
        setDraftInvalid(true);
        return;
      }
      onConfirm(normalized);
      return;
    }
    onConfirm(`${pad2(hour)}:${pad2(minute)}`);
  };

  const fieldStyle = (activeField: boolean): React.CSSProperties => ({
    width: PICKER_WIDTH * PICKER_RATIO.fieldWidth,
    height: PICKER_WIDTH * PICKER_RATIO.fieldHeight,
    display: "grid",
    placeItems: "center",
    fontFamily: "inherit",
    fontSize: PICKER_WIDTH * PICKER_RATIO.fieldHeight * 0.55,
    lineHeight: 1,
    fontVariantNumeric: "tabular-nums",
    color: "var(--text)",
    // Ein eigenes Feld hebt sich in JEDEM Theme ab: `--bg-subtle` und
    // `--bg-selected` koennen im selben Palette den gleichen Wert tragen
    // (gemessen: gruvbox setzt beide auf #282828), dann verschwindet das
    // Zifferblatt im Feld. Der Rand traegt den Rest.
    background: activeField ? "var(--bg-selected)" : "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    cursor: "pointer",
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent
        bare
        layer={layer}
        showCloseButton={false}
        aria-describedby={undefined}
        aria-modal="true"
        data-time-picker="true"
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          color: "var(--text)",
          maxWidth: "calc(100vw - 16px)",
        }}
      >
        <form
          onSubmit={(submitEvent) => { submitEvent.preventDefault(); confirm(); }}
          style={{
            width: PICKER_WIDTH,
            maxWidth: "100%",
            boxSizing: "border-box",
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <DialogTitle
            style={{
              fontSize: 13,
              fontWeight: 500,
              letterSpacing: "0.02em",
              color: "var(--text)",
            }}
          >
            {t("calendar.timePicker.title")}
          </DialogTitle>

          {/* Die beiden grossen Felder. Das aktive traegt den gewaehlten Ton,
              das andere bleibt ruhig — welches der beiden das Zifferblatt
              gerade stellt, ist damit auf einen Blick zu sehen. */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
            <button
              type="button"
              onClick={() => setFace("hour")}
              aria-label={t("calendar.picker.hour")}
              aria-pressed={face === "hour"}
              data-picker-field="hour"
              style={fieldStyle(face === "hour")}
            >
              {pad2(hour)}
            </button>
            <span
              aria-hidden="true"
              style={{
                width: PICKER_WIDTH * 0.06,
                textAlign: "center",
                fontSize: PICKER_WIDTH * PICKER_RATIO.fieldHeight * 0.42,
                color: "var(--text-muted)",
              }}
            >
              :
            </span>
            <button
              type="button"
              onClick={() => setFace("minute")}
              aria-label={t("calendar.picker.minute")}
              aria-pressed={face === "minute"}
              data-picker-field="minute"
              style={fieldStyle(face === "minute")}
            >
              {pad2(minute)}
            </button>
          </div>

          {typing ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <input
                autoFocus
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={draft}
                onChange={(inputEvent) => {
                  setDraft(sanitizeTimeInput(inputEvent.target.value));
                  setDraftInvalid(false);
                }}
                aria-label={t("calendar.timePicker.title")}
                aria-invalid={draftInvalid || undefined}
                placeholder="16:30"
                data-picker-text="true"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "10px 12px",
                  fontSize: 22,
                  fontFamily: "inherit",
                  fontVariantNumeric: "tabular-nums",
                  color: "var(--text)",
                  background: "var(--bg)",
                  border: `1px solid ${draftInvalid ? "var(--danger)" : "var(--border)"}`,
                  borderRadius: 8,
                }}
              />
              {draftInvalid
                ? <span style={{ fontSize: 11, color: "var(--danger)" }}>{t("calendar.invalidTime")}</span>
                : <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("calendar.timeFormatHint")}</span>}
            </div>
          ) : (
            <div
              data-picker-dial="true"
              onPointerDown={(pointerEvent) => {
                dragging.current = true;
                pickAt(pointerEvent.clientX, pointerEvent.clientY, pointerEvent.currentTarget);
              }}
              onPointerMove={(pointerEvent) => {
                if (dragging.current) pickAt(pointerEvent.clientX, pointerEvent.clientY, pointerEvent.currentTarget);
              }}
              onPointerUp={stopDragging}
              onPointerLeave={stopDragging}
              onPointerCancel={stopDragging}
              style={{
                position: "relative",
                width: dial,
                maxWidth: "100%",
                aspectRatio: "1",
                alignSelf: "center",
                borderRadius: "50%",
                // Eigene Flaeche statt `--bg-subtle`: der gewaehlte Kreis
                // traegt `--bg-selected`, und in manchen Paletten ist das
                // derselbe Farbwert — der Kreis waere unsichtbar.
                background: "var(--bg)",
                border: "1px solid var(--border)",
                touchAction: "none",
                userSelect: "none",
              }}
            >
              {/* Der Zeiger und der Punkt in der Mitte. Versteckt vor
                  Screenreadern: er zeigt nur, was der Kreis daneben schon
                  sagt. */}
              <svg
                aria-hidden="true"
                viewBox="-1 -1 2 2"
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
              >
                <line
                  x1={0}
                  y1={0}
                  x2={mark.dx}
                  y2={mark.dy}
                  stroke="var(--text-muted)"
                  strokeWidth={0.012}
                  data-picker-hand="true"
                />
                <circle cx={0} cy={0} r={0.033} fill="var(--text-muted)" />
              </svg>

              {/* Der gewaehlte Kreis liegt unter der Zahl, die er traegt. */}
              <span
                aria-hidden="true"
                data-picker-bubble="true"
                style={{
                  position: "absolute",
                  // Prozent statt Pixel: die Mitte des Zifferblatts plus dem
                  // Anteil am Radius — dieselbe Rechnung wie in
                  // `dialNumberPositions`, nur in CSS, damit ein schmaler
                  // Bildschirm das ganze Bild verkleinert statt es zu
                  // verschieben.
                  left: `${50 + mark.dx * 50}%`,
                  top: `${50 + mark.dy * 50}%`,
                  width: `${PICKER_RATIO.bubble * 100}%`,
                  aspectRatio: "1",
                  borderRadius: "50%",
                  background: "var(--bg-selected)",
                  transform: "translate(-50%, -50%)",
                  pointerEvents: "none",
                }}
              />

              {/* Die Zahlen sind Knoepfe, nicht gemalter Text: sie sind
                  damit auch ohne Maus erreichbar (Tab) und tragen ihren Wert
                  als Beschriftung. */}
              {positions.map((position) => (
                <button
                  key={position.value}
                  type="button"
                  onClick={() => pick(position.value)}
                  aria-label={String(position.value)}
                  aria-pressed={position.value === active}
                  data-picker-value={position.value}
                  style={{
                    position: "absolute",
                    left: `${50 + position.dx * 50}%`,
                    top: `${50 + position.dy * 50}%`,
                    minWidth: 24,
                    minHeight: 24,
                    padding: 0,
                    fontFamily: "inherit",
                    fontSize: dial * PICKER_RATIO.dialNumber,
                    lineHeight: 1,
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--text)",
                    background: "transparent",
                    border: "none",
                    borderRadius: "50%",
                    cursor: "pointer",
                    transform: "translate(-50%, -50%)",
                  }}
                >
                  {position.value}
                </button>
              ))}
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              onClick={() => {
                setDraft(`${pad2(hour)}:${pad2(minute)}`);
                setDraftInvalid(false);
                setTyping((open) => !open);
              }}
              aria-label={t("calendar.picker.keyboard")}
              aria-pressed={typing}
              data-picker-text-toggle="true"
              style={{
                display: "grid",
                placeItems: "center",
                width: 32,
                height: 32,
                color: "var(--text-muted)",
                background: "transparent",
                border: "none",
                borderRadius: 6,
                cursor: "pointer",
              }}
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

/** „Abbrechen" und „OK" — Textknoepfe wie in der Vorlage. */
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
