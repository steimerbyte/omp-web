"use client";

import { useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  Dialog,
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

/**
 * Wohin der Fokus geht, wenn der Knopf im selben Commit mit verschwindet.
 *
 * Beim Bestaetigen setzt `AppShell` in einem Commit `trusted=true` und
 * schliesst den Dialog. Der Aufrufer, also genau der Knopf, auf den
 * `restoreFocusTo` zeigt, steht unter dem Guard
 * `showChat && projectTrust?.requiresTrust && !projectTrust.trusted` und wird
 * im selben Commit unmountet. `isConnected` ist dann `false`.
 *
 * Der alte Code hinderte `preventDefault()` in diesem Fall trotzdem. Damit
 * greift auch der Fallback von Radix' `FocusScope` nicht, und gemessen war
 * `document.activeElement === document.body` — das naechste Tab begann wieder
 * vom Dokumentanfang, mitten im Chat.
 *
 * `anchor` ist der Container, in dem der Knopf lag, beim Oeffnen gemerkt. Er
 * ueberlebt den Commit, weil er nicht an `trusted` haengt. Ein `div` ist nicht
 * von selbst fokussierbar, deshalb bekommt er `tabindex="-1"` — das nimmt ihn
 * nicht in die Tab-Reihenfolge auf, macht ihn aber programmatisch fokussierbar.
 *
 * Der Knopf selbst wird nicht wiederbelebt: `HTMLElement.focus()` auf einem
 * Element ohne `tabindex` wird von Chromium stillschweigend verworfen, das
 * wuerde also wieder auf dem `body` landen. Deshalb ist es der Elternknoten.
 */
function focusFallbackAfterTriggerRemoval(anchor: HTMLElement | null): boolean {
  if (!anchor?.isConnected) return false;
  if (!anchor.hasAttribute("tabindex")) anchor.setAttribute("tabindex", "-1");
  anchor.focus();
  return document.activeElement === anchor;
}

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
  // oeffnet. `triggerRef.current` ist also `null` und Radix' eigener Default
  // (`@radix-ui/react-dialog`, Z. 174-177) laeuft deshalb in einen
  // `triggerRef.current?.focus()` ohne Wirkung. Gemessen bleibt der Fokus
  // deshalb in jedem Fall auf dem `body`.
  //
  // `restoreFocusAnchor` ist der Elternknoten des Knopfes, beim Oeffnen
  // gemerkt, weil genau der Knopf beim Bestaetigen mit verschwindet. Siehe
  // `focusFallbackAfterTriggerRemoval`.
  // Ein Tupel in EINEM `useState`, nicht zwei: `useState` liefert
  // `[wert, setter]`, und beim Aufspalten von `useState<[A, B]>` in
  // `[a, b] = useState(...)` landet `a` auf dem Tupel und `b` auf dem Setter.
  const [restoreTargets] = useState<[HTMLElement | null, HTMLElement | null]>(() => {
    if (typeof document === "undefined") return [null, null];
    const active = document.activeElement as HTMLElement | null;
    return [active, active?.parentElement ?? null];
  });
  const restoreFocusTo = restoreTargets[0];
  const restoreFocusAnchor = restoreTargets[1];

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
        {/*
          Genau ein Overlay, und es ist dieses.

          `DialogContent` aus `@/components/ui/dialog` bringt ein eigenes
          `<DialogPortal><DialogOverlay />` mit. Zusammen mit dem hier
          gerenderten `DialogOverlay` waren das zwei, beide `fixed inset-0`:
          gemessen `querySelectorAll('[data-slot="dialog-overlay"]').length === 2`.
          Die zusaetzliche Flaeche war unsichtbar, hat aber mit
          `supports-backdrop-filter:backdrop-blur-xs` den ganzen Bildschirm
          weichgezeichnet, ohne dass dafuer ein Grund auf der Flaeche lag.

          Deshalb kommt hier der Radix-Primitive direkt. Die Zentrierung, die
          der shadcn-Wrapper mitbringt, steht jetzt ausgeschrieben in der
          Klasse darunter — sie ist `fixed top-1/2 left-1/2` plus den beiden
          `translate`, ohne sie hinge das Panel oben links statt mittig.
        */}
        <DialogOverlay
          className={NO_BACKDROP_BLUR}
          style={{ zIndex: TRUST_Z_INDEX, background: "rgba(0,0,0,0.4)" }}
        />
        <DialogPrimitive.Content
          data-slot="dialog-content"
          className="fixed top-1/2 left-1/2 z-50 flex w-auto max-w-none -translate-x-1/2 -translate-y-1/2 gap-0 rounded-none p-0 outline-none ring-0 sm:max-w-none"
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
            // Der Abbruch-Weg: der Knopf lebt, und genau dorthin gehoert der
            // Fokus zurueck.
            if (restoreFocusTo?.isConnected) {
              restoreFocusTo.focus();
              return;
            }
            // Der Bestaetigungs-Weg: `AppShell` hat `trusted` gesetzt und den
            // Knopf im selben Commit entfernt. Ohne diesen Zweig bliebe der
            // Fokus auf dem `body` — gemessen, nicht vermutet.
            focusFallbackAfterTriggerRemoval(restoreFocusAnchor);
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
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}