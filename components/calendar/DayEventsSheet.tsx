"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatGermanLongDate, type CalendarEvent } from "@/lib/calendar";
import { useCalendarText } from "./useCalendarText";

/**
 * Die Termine eines Tages als Liste — der Zwischenschritt vor dem Dialog.
 *
 * ### Warum es diese Liste gibt
 *
 * In der Monatsansicht passt in eine Tageszelle nur eine Handvoll Chips. Ein
 * Tag mit vier Terminen zeigt auf einem 390 Pixel breiten Bildschirm einen
 * Chip und „3 weitere" — und der Chip ist 50 Pixel breit, also kein Ziel fuer
 * einen Finger. Ein Klick auf den Tag oeffnet deshalb erst diese Liste, und
 * *aus* der Liste kommt der Termin-Dialog. Damit ist jeder Termin eines Tages
 * erreichbar, unabhaengig davon, wie viele in die Zelle passen.
 *
 * ### Warum ein `Dialog` und kein eigenes Popup
 *
 * Fokusfalle, Escape, Klick auf den Hintergrund und `aria-modal` sind die
 * Arbeit, die ein Popup sonst selbst machen muesste. `components/ui/dialog`
 * bringt genau das mit und wird vom Termin-Dialog ohnehin benutzt — ein
 * zweites Popup-Primitiv waere eine zweite Sorte Verhalten im selben
 * Bildschirm.
 */
export function DayEventsSheet({
  date,
  events,
  onSelect,
  onCreate,
  onClose,
}: {
  /** Der Tag, dessen Termine gezeigt werden. */
  date: string;
  /** Die Termine des Tages — bereits nach Beginn sortiert. */
  events: CalendarEvent[];
  /** Ein Termin wurde gewaehlt: die Liste schliesst, der Dialog oeffnet. */
  onSelect: (event: CalendarEvent) => void;
  /** „Neuer Termin" an diesem Tag. */
  onCreate: (date: string) => void;
  onClose: () => void;
}) {
  const t = useCalendarText();

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          color: "var(--text)",
          maxWidth: 420,
          width: "calc(100% - 32px)",
          maxHeight: "calc(100dvh - 32px)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <DialogHeader style={{ flexShrink: 0 }}>
          <DialogTitle style={{ fontSize: 15, color: "var(--text)" }}>
            {formatGermanLongDate(date)}
          </DialogTitle>
          <DialogDescription style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {t("calendar.selectEvent")}
          </DialogDescription>
        </DialogHeader>

        {/* Die Liste scrollt, der Fuss bleibt stehen — dieselbe Aufteilung
            wie im Termin-Dialog: ein Fuss, der mitscrollt, ist auf einem
            flachen Bildschirm irgendwann nicht mehr da. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            flex: "1 1 auto",
            minHeight: 0,
            // Die Liste bleibt ein „kleines Popup": ab etwa sechs Terminen
            // scrollt sie, statt den Dialog auf die volle Bildschirmhoehe
            // wachsen zu lassen.
            maxHeight: "52dvh",
            overflowY: "auto",
            overscrollBehavior: "contain",
          }}
        >
          {events.length === 0 ? (
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-dim)" }}>
              {t("calendar.emptyDay")}
            </p>
          ) : null}

          {events.map((event) => (
            <button
              key={event.id}
              type="button"
              onClick={() => onSelect(event)}
              // 44 Pixel: das ist die kleinste Flaeche, die ein Finger
              // zuverlaessig trifft (dieselbe Zahl wie die Knoepfe der
              // Seitenleiste in `app/globals.css`).
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                minHeight: 44,
                width: "100%",
                padding: "6px 9px",
                border: "1px solid var(--border)",
                borderRadius: 8,
                background: "var(--bg)",
                color: "var(--text)",
                fontFamily: "inherit",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>
                {event.title}
              </span>
              <span style={{ flexShrink: 0, fontSize: 11, color: "var(--text-muted)" }}>
                {event.allDay
                  ? t("calendar.allDay")
                  : `${event.start.slice(11, 16)}–${event.end.slice(11, 16)}`}
              </span>
            </button>
          ))}
        </div>

        <DialogFooter style={{ flexShrink: 0, display: "flex", flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "8px 12px", minHeight: 44, fontSize: 12, fontWeight: 500,
              borderRadius: 8, cursor: "pointer", fontFamily: "inherit",
              border: "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--text-muted)",
            }}
          >
            {t("calendar.close")}
          </button>
          <button
            type="button"
            onClick={() => onCreate(date)}
            style={{
              padding: "8px 12px", minHeight: 44, fontSize: 12, fontWeight: 550,
              borderRadius: 8, cursor: "pointer", fontFamily: "inherit",
              border: "1px solid var(--accent)", background: "var(--accent)", color: "var(--bg)",
            }}
          >
            {t("calendar.newEvent")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
