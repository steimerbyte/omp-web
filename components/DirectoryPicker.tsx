"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  Dialog,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/hooks/useI18n";

interface DirectoryEntry {
  name: string;
  path: string;
}

interface BrowseResponse {
  path?: string;
  parentPath?: string | null;
  directories?: DirectoryEntry[];
  drives?: DirectoryEntry[];
  error?: string;
}

async function loadDirectories(directory?: string): Promise<BrowseResponse> {
  const query = directory ? `?path=${encodeURIComponent(directory)}` : "";
  const response = await fetch(`/api/cwd/browse${query}`);
  const data = await response.json() as BrowseResponse;
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M1.5 3h4l1.5 2h7.5v7.5h-13z" />
    </svg>
  );
}

function DriveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 9h12" />
      <circle cx="11.5" cy="11" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function isWindowsDriveRoot(directory: string): boolean {
  return /^[a-zA-Z]:[\\/]?$/.test(directory);
}

/**
 * Der Picker lag vorher als `position: fixed`-Ebene bei 1000 und muss zwischen
 * den uebrigen Overlays bleiben: die grossen Dialoge liegen bei 1100, die
 * Bildvorschau bei 1200, das Explorer-Fenster bei 1300, das Kontextmenue bei
 * 1400. Radix setzt `z-50` ueber Klassen; ein Inline-Wert gewinnt gegen die
 * Klasse und haelt die bisherige Ebene. `DialogOverlay` und `DialogContent`
 * bekommen beide den Wert, weil sie Geschwister sind.
 */
const PICKER_Z_INDEX = 1000;

/** Deckt das Overlay ab: der alte Backdrop hatte kein `backdrop-filter`. */
const NO_BACKDROP_BLUR = "supports-backdrop-filter:backdrop-blur-none";

/**
 * Markiert die gesamte Eingabe, damit der naechste Tastendruck sie ersetzt
 * statt an sie anzusetzen.
 *
 * `select()` und `setSelectionRange(0, value.length)` liefern in Chromium
 * dasselbe, auch im leeren Fall — gemessen: leer `0/0` bei beiden, gefuellt
 * `0/18` bei beiden. Der Aufruf ist also nicht der Grund des Befunds.
 *
 * Der Grund ist die Reihenfolge: beim Oeffnen ist das Feld noch leer, weil
 * `navigateTo()` den ersten Pfad erst per `fetch` nachliefert. Der erste Aufruf
 * markiert damit `0/0`, und sobald React den Wert setzt, legt Chromium den
 * Cursor ans Ende des neuen Textes — gemessen `23/23` bei
 * `/home/user/project`. Wer den Aufruf liest, sieht eine vollstaendige
 * Markierung und schliesst daraus auf eine, die es nicht gibt.
 *
 * `setSelectionRange(0, value.length)` steht hier, weil es die Absicht ohne
 * Umweg ausdrueckt: von 0 bis zum Ende des aktuellen Wertes, auch wenn dieser
 * leer ist. Siehe den Effekt weiter unten, der die Markierung nach dem
 * nachgelieferten Pfad erneut setzt.
 */
function selectWholeInput(input: HTMLInputElement): void {
  input.setSelectionRange(0, input.value.length);
}

interface Props {
  onCancel: () => void;
  onSelect: (path: string) => void;
  busy?: boolean;
  error?: string | null;
}

export function DirectoryPicker({ onCancel, onSelect, busy = false, error }: Props) {
  const { t } = useI18n();
  const pathInputRef = useRef<HTMLInputElement>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [parentDirectory, setParentDirectory] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [directories, setDirectories] = useState<DirectoryEntry[]>([]);
  const [drives, setDrives] = useState<DirectoryEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Wohin der Fokus zurueckgeht, wenn der Dialog schliesst. Radix gibt ihn im
  // `onCloseAutoFocus` an seinen `DialogTrigger` zurueck; einen gibt es hier
  // nicht, weil `SessionSidebar` den Picker von aussen ueber eine
  // Zustandsvariable oeffnet. `triggerRef.current` ist also `null`, der Default
  // laeuft ins Leere und der Fokus landet auf dem `body`. Deshalb wird er
  // verhindert und das Element gefokust, das beim Oeffnen aktiv war.
  const [restoreFocusTo] = useState<HTMLElement | null>(() =>
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );

  const navigateTo = useCallback(async (directory?: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await loadDirectories(directory);
      const nextPath = data.path ?? directory ?? "/";
      setCurrentPath(nextPath);
      setParentDirectory(data.parentPath ?? null);
      setPathInput(nextPath);
      setDirectories(data.directories ?? []);
      setDrives(data.drives ?? null);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void navigateTo();
  }, [navigateTo]);

  // Der erste Pfad kommt asynchron aus `navigateTo()`, und beim Setzen eines
  // Wertes auf ein fokussiertes Feld legt Chromium den Cursor ans Ende. Die
  // Markierung aus `onOpenAutoFocus` gilt also nur fuer den leeren Zustand und
  // waere beim ersten sichtbaren Pfad schon wieder verschwunden.
  //
  // Deshalb wird sie nach jedem neuen Pfad erneut gesetzt — aber nur, solange
  // das Feld wirklich den Fokus traegt. Sonst wuerde ein spaeteres `navigateTo()`
  // (Klick auf einen Unterordner, Enter im Wegfeld) die Markierung eines
  // Feldes ueberschreiben, in dem der Nutzer gerade schreibt.
  useEffect(() => {
    const input = pathInputRef.current;
    if (!input || document.activeElement !== input) return;
    selectWholeInput(input);
  }, [pathInput]);

  const handlePathSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = pathInput.trim();
    if (candidate) void navigateTo(candidate);
  };
  const hasUncommittedPath = pathInput.trim() !== currentPath;
  const canSelect = Boolean(currentPath) && !hasUncommittedPath && !busy;
  const canNavigateUp = Boolean(parentDirectory) || isWindowsDriveRoot(currentPath);

  // Solange die Auswahl laeuft, belong weder Escape noch ein Klick neben dem
  // Dialog zum Abbruch — vorher war das am `disabled` der Knoepfe und am
  // `target === currentTarget`-Test des Backdrops festgemacht. Radix ruft
  // `onOpenChange(false)` nur, wenn keiner der beiden Handler
  // `preventDefault()` sagt.
  const blockWhileBusy = (event: { preventDefault: () => void }) => {
    if (busy) event.preventDefault();
  };

  return (
    <Dialog
      // Von aussen gesteuert: `SessionSidebar` haelt den Zustand und mountet
      // die Komponente nur, solange sie offen ist. `open` bleibt darum konstant
      // `true`, `onOpenChange` meldet nur den Wunsch nach dem Schliessen.
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
          style={{ zIndex: PICKER_Z_INDEX, background: "rgba(0,0,0,0.35)" }}
        />
        <DialogPrimitive.Content
          data-slot="dialog-content"
          className="fixed top-1/2 left-1/2 z-50 flex w-auto max-w-none -translate-x-1/2 -translate-y-1/2 gap-0 rounded-none p-0 outline-none ring-0 sm:max-w-none"
          style={{ zIndex: PICKER_Z_INDEX, width: 520, maxWidth: "calc(100vw - 16px)", height: "min(620px, calc(100dvh - 16px))", maxHeight: "calc(100dvh - 16px)", flexDirection: "column", overflow: "hidden", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}
          // Radix setzt beim Oeffnen sonst auf das erste fokussierbare Element,
          // und das ist der X-Knopf in der Kopfzeile. Das `autoFocus` am
          // Eingabefeld aus dem Handcode greift nicht, weil es im Portal-Mount
          // nicht ausgefuehrt wird; der Haken ist dieser Handler.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            const input = pathInputRef.current;
            if (!input) return;
            input.focus();
            // Der Fokus und die Auswahl gehoeren an das Wegfeld, nicht an den
            // X-Knopf, den Radix sonst als erstes fokussierbares Element
            // nimmt. Die Auswahl markiert zu diesem Zeitpunkt `0/0`, weil das
            // Feld leer ist; der Pfad kommt erst per `fetch`. Der Effekt unten
            // setzt sie deshalb erneut, sobald er eintrifft.
            selectWholeInput(input);
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (restoreFocusTo?.isConnected) restoreFocusTo.focus();
          }}
          onEscapeKeyDown={blockWhileBusy}
          onPointerDownOutside={blockWhileBusy}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, padding: "12px 18px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              {/* `asChild` laesst die vorhandenen `div`s und ihre Styles stehen;
                  Radix haengt nur die `id` an, ueber die der Dialog beschriftet
                  wird. Vorher war es ein `aria-label` am Backdrop. */}
              <DialogTitle asChild>
                <div style={{ color: "var(--text)", fontWeight: 700, fontSize: 15 }}>{t("directoryPicker.selectDirectory")}</div>
              </DialogTitle>
            </div>
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              title={t("i18n.close")}
              aria-label={t("i18n.close")}
              style={{ padding: "2px 6px", border: 0, background: "none", color: "var(--text-muted)", fontSize: 20, lineHeight: 1, cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1 }}
            >
              ×
            </button>
          </div>

          <form onSubmit={handlePathSubmit} style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
            <button className="directory-picker-back" type="button" onClick={() => void navigateTo(parentDirectory ?? undefined)} disabled={loading || !canNavigateUp} title={t("directoryPicker.goToParent")} aria-label={t("directoryPicker.goToParent")} style={{ width: 36, height: 36, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text-muted)", cursor: canNavigateUp ? "pointer" : "default", opacity: canNavigateUp ? 1 : 0.45 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m18 15-6-6-6 6" />
              </svg>
            </button>
            {/* Die Beschriftung des Wegfeldes ist zugleich die Beschreibung des
                Dialogs: Radix traegt ihre `id` als `aria-describedby` ein, damit
                der Screenreader den Dialog mit Text ansagt. */}
            <DialogDescription asChild>
              <label htmlFor="directory-path" style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}>
                {t("directoryPicker.directoryPath")}
              </label>
            </DialogDescription>
            <input
              ref={pathInputRef}
              className="directory-picker-path"
              id="directory-path"
              type="text"
              value={pathInput}
              placeholder="/path/to/project or ~/project"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setPathInput(event.target.value);
                setLoadError(null);
              }}
              style={{ minWidth: 0, flex: 1, height: 36, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 6, outline: "none", background: "var(--bg-panel)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12 }}
            />
            <button
              className="directory-picker-action"
              type="submit"
              disabled={loading || !pathInput.trim()}
              title={t("directoryPicker.goToDirectory")}
              style={{ minWidth: 58, height: 36, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text-muted)", cursor: loading || !pathInput.trim() ? "default" : "pointer", opacity: loading || !pathInput.trim() ? 0.6 : 1 }}
            >
              {t("directoryPicker.go")}
            </button>
          </form>

          <div className="directory-picker-list" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "8px 10px" }}>
            {loading ? (
              <div style={{ padding: 8, color: "var(--text-dim)", fontSize: 11 }}>{t("directoryPicker.loadingDirectories")}</div>
            ) : drives !== null ? (
              <>
                {drives.length > 0 ? (
                  drives.map((drive) => (
                    <button
                      key={drive.path}
                      className="directory-picker-entry"
                      type="button"
                      onClick={() => void navigateTo(drive.path)}
                      title={drive.path}
                      style={{ width: "100%", minHeight: 34, display: "flex", alignItems: "center", gap: 7, padding: "6px 8px", border: 0, borderRadius: 5, background: "none", color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-mono)", fontSize: 11 }}
                    >
                      <DriveIcon />
                      <span>{drive.name}</span>
                    </button>
                  ))
                ) : (
                  <div style={{ padding: 8, color: "var(--text-dim)", fontSize: 11 }}>{t("directoryPicker.noDrives")}</div>
                )}
              </>
            ) : directories.length > 0 ? (
              directories.map((entry) => (
                <button
                  key={entry.path}
                  className="directory-picker-entry"
                  type="button"
                  onClick={() => void navigateTo(entry.path)}
                  title={entry.path}
                  style={{ width: "100%", minHeight: 30, display: "flex", alignItems: "center", gap: 7, padding: "5px 8px", border: 0, borderRadius: 5, background: "none", color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-mono)", fontSize: 11 }}
                >
                  <FolderIcon />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
                </button>
              ))
            ) : (
              <div style={{ padding: 8, color: "var(--text-dim)", fontSize: 11 }}>{t("directoryPicker.noSubdirectories")}</div>
            )}
            {(loadError || error) && <div style={{ padding: "8px", color: "#dc2626", fontSize: 11 }}>{loadError ?? error}</div>}
          </div>

          <div className="directory-picker-footer" style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, flexShrink: 0, padding: "10px 18px", borderTop: "1px solid var(--border)" }}>
            <button className="directory-picker-action" type="button" onClick={onCancel} disabled={busy} style={{ padding: "6px 14px", border: "1px solid var(--border)", borderRadius: 6, background: "none", color: "var(--text-muted)", cursor: busy ? "default" : "pointer", fontSize: 13 }}>{t("i18n.cancel")}</button>
            <button
              className="directory-picker-action"
              type="button"
              onClick={() => onSelect(currentPath)}
              disabled={!canSelect}
              title={hasUncommittedPath ? t("directoryPicker.openBeforeSelecting") : t("directoryPicker.selectCurrentDirectory")}
              style={{ padding: "6px 16px", border: 0, borderRadius: 6, background: "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 600, opacity: canSelect ? 1 : 0.6, cursor: canSelect ? "pointer" : "default" }}
            >
              {busy ? t("i18n.checking") : t("directoryPicker.selectThisFolder")}
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
