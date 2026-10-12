"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/hooks/useI18n";

/**
 * Der Dialog lag vorher als `position: fixed`-Ebene bei 1100 im Baum von
 * `AppShell` und muss zwischen den uebrigen Overlays bleiben: die Seitenleiste
 * traegt auf dem Telefon 200, die grossen Overlays liegen bei 1000 bis 1300,
 * das Kontextmenue bei 1400. Radix setzt `z-50` ueber Klassen; ein Inline-Wert
 * gewinnt gegen die Klasse und haelt die bisherige Ebene. `DialogOverlay` und
 * `DialogContent` bekommen beide den Wert, weil sie Geschwister sind.
 */
const TRUST_Z_INDEX = 1100;

/** Deckt das Overlay ab: der alte Backdrop hatte kein `backdrop-filter`. */
const NO_BACKDROP_BLUR = "supports-backdrop-filter:backdrop-blur-none";

export function ProjectTrustDialog({
  cwd,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  cwd: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();

  // Wohin der Fokus zurueckgeht, wenn der Dialog schliesst. Radix gibt ihn im
  // `onCloseAutoFocus` an seinen `DialogTrigger` zurueck; einen gibt es hier
  // nicht, weil `AppShell` den Dialog von aussen ueber eine Zustandsvariable
  // oeffnet. `triggerRef.current` ist also `null`, der Default laeuft ins Leere
  // und der Fokus landet auf dem `body`. Deshalb wird er verhindert und das
  // Element gefokust, das beim Oeffnen aktiv war.
  const [restoreFocusTo] = useState<HTMLElement | null>(() =>
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );

  // Solange die Anfrage laeuft, belong weder Escape noch ein Klick neben dem
  // Dialog zum Abbruch — vorher war das an `disabled` und am
  // `target === currentTarget`-Test des Backdrops festgemacht.
  const blockWhileBusy = (event: { preventDefault: () => void }) => {
    if (busy) event.preventDefault();
  };

  return (
    <Dialog
      // Der Dialog wird von aussen gesteuert: `AppShell` haelt den Zustand und
      // mountet die Komponente nur, solange sie offen ist. `open` bleibt darum
      // konstant `true`, und `onOpenChange` meldet nur den Wunsch nach dem
      // Schliessen an den Aufrufer zurueck.
      open
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogPortal>
        <DialogOverlay
          className={NO_BACKDROP_BLUR}
          style={{ zIndex: TRUST_Z_INDEX, background: "rgba(0,0,0,0.4)" }}
        />
        <DialogContent
          showCloseButton={false}
          // Der Wrapper traegt `grid w-full max-w-… p-4 gap-4 rounded-xl ring-1`
          // und einen eigenen Close-Button. Beides ist hier nicht gewollt: das
          // Layout ist eine Spalte ohne Innenabstand, die Groesse kommt aus dem
          // Style darunter, und der Dialog hat keinen X-Knopf.
          className="flex w-auto max-w-none gap-0 rounded-none p-0 ring-0 sm:max-w-none"
          style={{
            zIndex: TRUST_Z_INDEX,
            flexDirection: "column",
            width: 440,
            maxWidth: "100%",
            overflow: "hidden",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg-panel)",
            boxShadow: "0 12px 36px rgba(0,0,0,0.24)",
          }}
          onEscapeKeyDown={blockWhileBusy}
          onPointerDownOutside={blockWhileBusy}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (restoreFocusTo?.isConnected) restoreFocusTo.focus();
          }}
        >
          <div style={{ display: "flex", gap: 12, padding: "18px 18px 14px" }}>
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#f59e0b"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              style={{ flexShrink: 0, marginTop: 1 }}
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
            <div style={{ minWidth: 0 }}>
              {/* `asChild` haelt die vorhandenen `div`s und ihre Styles; Radix
                  haengt nur die `id` an, ueber die der Dialog beschriftet wird.
                  Vorher stand hier ein `aria-labelledby` auf eine fest
                  geschriebene `id`. */}
              <DialogTitle asChild>
                <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
                  {t("trust.dialogTitle")}
                </div>
              </DialogTitle>
              <DialogDescription asChild>
                <div style={{ marginTop: 7, fontSize: 12, lineHeight: 1.6, color: "var(--text-muted)" }}>
                  {t("trust.dialogBody")}
                </div>
              </DialogDescription>
              <code
                style={{
                  display: "block",
                  marginTop: 10,
                  padding: "8px 10px",
                  border: "1px solid var(--border)",
                  borderRadius: 5,
                  background: "var(--bg)",
                  color: "var(--text)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  overflowWrap: "anywhere",
                }}
              >
                {cwd}
              </code>
              {error && (
                <div role="alert" style={{ marginTop: 10, color: "#ef4444", fontSize: 12, lineHeight: 1.5 }}>
                  {error}
                </div>
              )}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              padding: "10px 18px",
              borderTop: "1px solid var(--border)",
            }}
          >
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              style={{
                height: 32,
                padding: "0 12px",
                border: "1px solid var(--border)",
                borderRadius: 5,
                background: "transparent",
                color: "var(--text-muted)",
                cursor: busy ? "not-allowed" : "pointer",
                fontSize: 12,
              }}
            >
              {t("trust.cancel")}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              style={{
                height: 32,
                padding: "0 12px",
                border: "1px solid var(--accent)",
                borderRadius: 5,
                background: "var(--accent)",
                color: "white",
                cursor: busy ? "wait" : "pointer",
                opacity: busy ? 0.7 : 1,
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {busy ? t("trust.trusting") : t("trust.trustProject")}
            </button>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}