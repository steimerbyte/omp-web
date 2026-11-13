"use client";

import type { RefObject } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useIsMobile } from "@/hooks/useIsMobile";
import { formatGermanLongDate, type CalendarEvent } from "@/lib/calendar";
import { useCalendarText } from "./useCalendarText";

/**
 * Alle Termine eines Tages — die Tagesuebersicht.
 *
 * ### Was diese Liste ist
 *
 * Ein Klick auf einen Tag (in der Monatszelle, in der Kopfzelle der Wochen-
 * und Tagesansicht) oeffnet *immer* diese Uebersicht: Datum, Zahl der
 * Termine, jeder Termin mit Titel und Uhrzeit, und darunter der fette Knopf
 * „Termin hinzufuegen". Das gilt auch fuer einen Klick auf den Termin selbst
 * (Chip oder Block im Stundenraster): bei vielen Terminen auf einem Tag ist
 * der Nachbar einen Pixel entfernt, und ein direkter Klick in den Dialog
 * landete dann im falschen Termin. Gewaehlt wird erst hier, wo die Zeilen 44
 * Pixel hoch sind und die Liste scrollt. Aus der Uebersicht kommt der
 * Termin-Dialog — er bleibt die einzige Form zum Anlegen und Bearbeiten.
 *
 * Frueher war die Liste ein Zwischenschritt, den nur ein schmaler Bildschirm
 * oder eine abgeschnittene Zelle oeffnete; sonst legte der Klick direkt
 * einen Termin an. Das war eine Regel, die von der Fensterbreite und der
 * Hoehe der Zelle abhing — niemand konnte vorhersagen, was ein Klick tut.
 * Jetzt tut er ueberall dasselbe.
 *
 * ### Warum ein `Dialog` und kein eigenes Popup
 *
 * Fokusfalle, Escape, Klick auf den Hintergrund und `aria-modal` sind die
 * Arbeit, die ein Popup sonst selbst machen muesste. `components/ui/dialog`
 * bringt genau das mit und wird vom Termin-Dialog ohnehin benutzt — ein
 * zweites Popup-Primitiv waere eine zweite Sorte Verhalten im selben
 * Bildschirm. Auf jeder Breite ist es derselbe zentrierte Dialog; nur der
 * Fuss stapelt unter 640 Pixeln.
 *
 * ### Warum der Fokus zurueck zur Tageszelle geht
 *
 * Der Knopf, der die Liste geoeffnet hat, ist nach dem Schliessen das
 * naechste sinnvolle Ziel — sonst landet der Fokus im `body`, und die
 * Tastaturbenutzung faengt wieder oben an. `onCloseAutoFocus` ist der Ort,
 * an dem das Popup seinen Fokus zurueckgibt; `returnFocus` traegt die Zelle.
 * Oeffnet die Liste den Termin-Dialog, ist `returnFocus` vorher geleert —
 * sonst zoege das schliessende Sheet den Fokus aus dem gerade geoeffneten
 * Dialog.
 */
export function DayEventsSheet({
  date,
  events,
  returnFocus,
  onSelect,
  onCreate,
  onClose,
}: {
  /** Der Tag, dessen Termine gezeigt werden. */
  date: string;
  /** Die Termine des Tages — bereits nach Beginn sortiert. */
  events: CalendarEvent[];
  /** Die Tageszelle, die die Liste geoeffnet hat. */
  returnFocus: RefObject<HTMLElement | null>;
  /** Ein Termin wurde gewaehlt: die Liste schliesst, der Dialog oeffnet. */
  onSelect: (event: CalendarEvent) => void;
  /** „Termin hinzufuegen" an diesem Tag. */
  onCreate: (date: string) => void;
  onClose: () => void;
}) {
  const t = useCalendarText();
  const compact = useIsMobile();
  const count = events.length;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        data-cal-day-sheet="true"
        // Die Zentrierung des Primaerformulars (`top-1/2 left-1/2`
        // `-translate-*`) bleibt stehen: die Uebersicht ist auf jeder Breite
        // derselbe zentrierte Dialog, nur mit eigener Breite und Kappung.
        // Inline gewinnt gegen jede Klasse, deshalb kommen beide von hier.
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
        onCloseAutoFocus={(event) => {
          const target = returnFocus.current;
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader style={{ flexShrink: 0 }}>
          <DialogTitle style={{ fontSize: 15, color: "var(--text)" }}>
            {formatGermanLongDate(date)}
          </DialogTitle>
          <DialogDescription style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {count === 0
              ? t("calendar.emptyDay")
              : t(count === 1 ? "calendar.eventCountOne" : "calendar.eventCountMany", { count })}
          </DialogDescription>
        </DialogHeader>

        {/* Die Liste scrollt, der Fuss bleibt stehen — dieselbe Aufteilung
            wie im Termin-Dialog: ein Fuss, der mitscrollt, ist auf einem
            flachen Bildschirm irgendwann nicht mehr da. Die Hoehe begrenzt
            das Popup selbst, nicht die Liste: ein Tag mit dreissig Terminen
            scrollt, ein Tag mit zweien bleibt klein. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            flex: "1 1 auto",
            minHeight: 0,
            overflowY: "auto",
            overscrollBehavior: "contain",
          }}
        >
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

        <DialogFooter
          style={{
            flexShrink: 0,
            display: "flex",
            // Schmal: der fette Knopf steht oben und ueber die volle Breite,
            // „Schliessen" darunter. Breit: nebeneinander, der Knopf waechst.
            flexDirection: compact ? "column-reverse" : "row",
            alignItems: "stretch",
            gap: 8,
            justifyContent: "flex-end",
          }}
        >
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
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              flex: "1 1 auto", width: compact ? "100%" : undefined,
              padding: "12px 16px",
              // 48 Pixel: der Hauptweg dieses Bildschirms — groesser als die
              // 44-Pixel-Zeilen darueber, weil er das Ziel ist.
              minHeight: 48,
              fontSize: 14, fontWeight: 650,
              borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
              border: "1px solid var(--accent)", background: "var(--accent)", color: "var(--bg)",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M8 3v10M3 8h10" />
            </svg>
            {t("calendar.addEvent")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
