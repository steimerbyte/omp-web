"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Pressable } from "./motion/Pressable";
import { encodeFilePathForApi, getFileDirectory } from "@/lib/file-paths";
import { isImagePath } from "@/lib/file-types";
import { copyText } from "@/lib/clipboard";
import { FileBrowserDialog } from "./FileBrowserDialog";
import { useI18n } from "@/hooks/useI18n";
import { Reveal } from "./motion/Reveal";
import { Enter } from "./motion/Enter";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";

/** Rechtsklick-Ziel einer Baumzeile, x/y in Viewport-Koordinaten. */
export interface FileMenuTarget {
  x: number;
  y: number;
  path: string;
  name: string;
  isDir: boolean;
}

/** Kurzhinweis zu einer Dateiaktion, unten rechts eingeblendet. */
export interface FileActionNotice {
  kind: "success" | "error";
  text: string;
}

/**
 * Was eine Dateiaktion zurueckgibt. Die API lehnt Regeln des Dateisystems ab
 * — vorhandenes Ziel, Ordner in sich selbst, fehlende Schreibberechtigung —
 * das sind erwartete Antworten und keine Programmfehler, deshalb kein Wurf.
 */
type ActionResult = { ok: true } | { ok: false; error: string };

interface FileActionResponse {
  ok?: boolean;
  path?: string;
  previousPath?: string;
  error?: string;
  reason?: string;
}

type MenuPhase = "root" | "rename" | "new-folder" | "confirm-delete";
type MenuAction = "copy-path" | "preview" | "new-folder" | "rename" | "copy-to" | "move-to" | "delete";
type TransferKind = "copy" | "move";

interface FileContextMenuProps {
  target: FileMenuTarget;
  onClose: () => void;
  onMutated: () => void;
  onNotify: (notice: FileActionNotice) => void;
  /**
   * Optionaler Weg zur grossen Bildvorschau. Fehlt er, bekommen Bilddateien
   * keinen Preview-Eintrag und verhalten sich wie jede andere Datei — die
   * Aktion haengt an der Verfuegbarkeit des Aufrufers, nicht an der Art der
   * Datei.
   */
  onOpenImage?: (filePath: string, fileName: string) => void;
}

/** Rand zwischen Panel und Viewportkante. */
const MENU_MARGIN = 8;
/**
 * Das Menue muss ueber allem liegen, auch ueber den Backdrops der grossen
 * Overlays. Der Explorer-Ordnerdialog sitzt bei 1100, die Bildvorschau bei 1200
 * und das grosse Explorer-Fenster bei 1300; ein Menue, das im Fenster oder in
 * der Bildvorschau aufgeht, faellt mit den frueheren 320 vollstaendig weg. Der
 * Wert liegt darueber, damit es in jeder Einbettung sichtbar bleibt. Radix
 * liest ihn einmalig aus dem berechneten Stil des Panels und traegt ihn auf den
 * Positionierungs-Wrapper, deshalb muss er dort als Inline-Wert stehen und
 * nicht als Tailwind-Klasse.
 */
const MENU_Z_INDEX = 1400;
const MENU_MIN_WIDTH = 172;
const MENU_MAX_WIDTH = 240;
const PANEL_CONTENT_WIDTH = 208;

/** `error` plus `reason`, damit ein 403 die Begruendung nicht verschluckt. */
function describeApiError(data: FileActionResponse, status: number): string {
  const message = data.error ?? data.reason ?? `HTTP ${status}`;
  if (!data.error || !data.reason || data.reason === data.error) return message;
  return `${message} (${data.reason})`;
}

/**
 * POST-Zweig von /api/file-actions. Der Pfad adressiert die Quelle, das Ziel
 * kommt als absoluter Verzeichnispfad im Body.
 */
async function postFileAction(
  targetPath: string,
  type: "mkdir" | "rename" | TransferKind,
  body: Record<string, string>,
): Promise<ActionResult> {
  try {
    const res = await fetch(`/api/file-actions/${encodeFilePathForApi(targetPath)}?type=${type}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({})) as FileActionResponse;
    if (!res.ok) return { ok: false, error: describeApiError(data, res.status) };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** DELETE-Zweig von /api/file-actions, entfernt rekursiv. */
async function deleteEntry(targetPath: string): Promise<ActionResult> {
  try {
    const res = await fetch(`/api/file-actions/${encodeFilePathForApi(targetPath)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({})) as FileActionResponse;
    if (!res.ok) return { ok: false, error: describeApiError(data, res.status) };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function MenuIcon({ children }: { children: ReactNode }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

interface MenuItem {
  action: MenuAction;
  label: string;
  icon: ReactNode;
  danger?: boolean;
}

/**
 * Rechtsklick-Menue fuer eine Zeile im Dateibaum.
 *
 * Die Listenphase ist ein Radix `ContextMenu`: Portal, Klemme gegen den
 * Viewportrand, Pfeiltasten, Enter-Auswahl und `role="menu"` kommen von dort,
 * und `onSelect` statt `onClick` ist der Punkt, an dem sich die Tastatur- von
 * der Mausbedienung nicht mehr unterscheidet.
 *
 * Die Formularschritte (`rename`, `new-folder`, `confirm-delete`) liegen
 * bewusst AUSSERHALB dieses Panels. Sie sind Geschwister im selben Portal, nicht
 * Submenues: nur so bleibt Escape in einem Formularschritt "zurueck zur Liste",
 * ohne dass der Weg zum naechsten Schritt verloren geht. Erfolg und Fehler
 * melden sie ueber `onMutated` bzw. `onNotify` nach aussen, damit der Aufrufer
 * das Ergebnis an einer Stelle behandelt statt in jedem Zweig des Panels.
 */
export function FileContextMenu({ target, onClose, onMutated, onNotify, onOpenImage }: FileContextMenuProps) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<MenuPhase>("root");
  const [draft, setDraft] = useState("");
  // Zielauswahl fuer Copy/Move. Sie lebt im Menue und nicht im aufrufenden
  // Explorer: das Menue ist der einzige Ort, der Quelle (`target.path`) und
  // Absicht (`kind`) kennt.
  const [transfer, setTransfer] = useState<{ kind: TransferKind; busy: boolean } | null>(null);
  // Klemme der Formularschritte. Die Listenphase klemmt Radix selbst ueber
  // `collisionPadding`; diese Schritte sind kein Radix-Panel und brauchen
  // deshalb weiterhin eine Messung.
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);
  // Die Formularschritte haengen an `document.body`, nicht am aufrufenden
  // Explorer. Grund ist das Koordinatensystem, nicht die Stapelebene:
  // `position: fixed` richtet sich nach dem Bezugssystem des Vorfahren, und
  // jeder Vorfahre mit `transform`, `filter`, `backdrop-filter`, `perspective`,
  // `contain` oder `will-change` eroeffnet ein eigenes. Im grossen
  // Explorer-Fenster tut das bereits der Backdrop (`backdrop-filter:
  // blur(8px)`, `FileExplorerWindow.module.css:75`) und auch das Panel selbst.
  // `left`/`top` waeren dann Koordinaten RELATIV ZU DIESEM FENSTER statt zum
  // Viewport, und `window.innerWidth` waere die falsche Bezugsbreite. Das
  // Menue stuende dann um genau den Fensterrand daneben — 5vh/5vw plus 1px
  // Rahmen, im gemessenen Fall 48px in der Breite und 49px in der Hoehe.
  // Der Ziel wird beim ersten Render gelesen statt in einem Effekt nachgetragen:
  // auf dem Server ist `document` nicht da, im Browser schon beim ersten Render
  // — es gibt also keine Zwischenphase mehr, in der das Panel ohne Portal
  // gerendert wuerde.
  const [portalTarget] = useState<HTMLElement | null>(() =>
    typeof document === "undefined" ? null : document.body,
  );
  const triggerRef = useRef<HTMLSpanElement>(null);
  const formPanelRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // `onCloseAutoFocus` feuert, nachdem Radix sein Panel bereits geschlossen hat.
  // Der `ContextMenuContent` existiert aber nur bei `phase === "root"` — TypeScript
  // erkennt deshalb, dass die Vergleichsfelder nie ueberschneiden, und meldet
  // TS2367. Zur Laufzeit stimmt der Vergleich trotzdem, weil der Phasenwechsel
  // in `onSelect` passiert und `phase` dann bereits der neue Wert ist. Die Ref
  // umgeht die statische Pruefung, ohne den Wert zu veralten.
  const phaseRef = useRef<MenuPhase>(phase);
  phaseRef.current = phase;

  // Radix erbt die Position des Panels aus dem `contextmenu`-Event auf seinem
  // Trigger und macht daraus einen virtuellen Anker am Klickpunkt. Der Explorer
  // oeffnet das Menue aber von aussen — er setzt `menuTarget` aus
  // `event.clientX/clientY` der Baumzeile —, es gibt also keinen Trigger, der
  // das Ereignis natuerlich empfaenge, und `radix-ui` 1.8.0 stellt fuer
  // `ContextMenu` keinen eigenen `Anchor` bereit (nur `Popover` hat einen).
  // Deshalb laeuft derselbe Weg hier einmal programmatisch ab: das Event mit
  // den bekannten Viewportkoordinaten auf den Trigger legen. Ohne diesen
  // Schritt verankert sich das Menue in der linken oberen Viewporthuecke —
  // genau das sagt die Dev-Warnung "its position is indeterminate".
  useLayoutEffect(() => {
    triggerRef.current?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: target.x,
      clientY: target.y,
    }));
  }, [target.x, target.y]);

  // Erst messen, dann setzen: der Layout-Effekt laeuft vor dem Paint, das
  // Panel erscheint also direkt an seiner endgueltigen Position. Die
  // Abhaengigkeit von `phase` faengt den Groessenwechsel der Formularschritte
  // ein.
  //
  // Gemessen wird `offsetWidth`/`offsetHeight`, nicht `getBoundingClientRect()`:
  // sobald das Panel am `body` haengt, ist es viewport-relativ und beide Groessen
  // sind identisch — aber die Rechteckmasse eines fixierten Nachfahren eines
  // transformierten Vorfahren liefern gezeichnete Masse, und nur darum geht es
  // hier: die Klemme rechnet in derselben Einheit wie `window.innerWidth`.
  useLayoutEffect(() => {
    if (phase === "root") return;
    const panel = formPanelRef.current;
    if (!panel) return;
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    setPlacement({
      left: Math.min(Math.max(target.x, MENU_MARGIN), Math.max(MENU_MARGIN, window.innerWidth - width - MENU_MARGIN)),
      top: Math.min(Math.max(target.y, MENU_MARGIN), Math.max(MENU_MARGIN, window.innerHeight - height - MENU_MARGIN)),
    });
  }, [phase, target.x, target.y]);

  // Der Fokuswechsel in die Formularschritte sitzt an `onCloseAutoFocus` am
  // `ContextMenuContent`, nicht hier. Drei Ansaetze waren hier vorher, alle
  // gemessen und keiner hat gewirkt, weil sie alleZU SPAET kamen:
  //   - `useLayoutEffect` mit `focus()`: Radix gibt beim Schliessen danach den
  //     Fokus zurueck.
  //   - `autoFocus` am Input: greift nicht, das Attribut wird im Portal-Mount
  //     nicht gesetzt (`inp.autofocus === false`).
  //   - `requestAnimationFrame` nach dem Mount: der Fokuswechsel passiert
  //     waehrend `onSelect`, also vor dem ersten Frame. Gemessen bei `+0ms` lag
  //     er schon auf dem Explorer-Panel.

  useEffect(() => {
    // Solange der Ziel-Dialog offen ist, gehoeren Escape, Klick-daneben und
    // Scroll dem Dialog: seine eigene Backdrop- und Escape-Behandlung gilt.
    // Sonst wuerde das Schliessen des Menuepfads den Dialog mitschliessen.
    if (transfer) return;
    // Die Position haengt am Viewport, nicht am Element: bei Scroll oder
    // Fenstergroessenaenderung waere sie veraltet, also schliessen statt
    // springen. Das gilt fuer beide Phasen. Radix wuerde die Listenphase zwar
    // neu ausrichten, der Anker sitzt aber am Klickpunkt und bliebe dabei
    // genau dort, wo die Zeile einmal war.
    const onViewportChange = () => onClose();
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    // Escape und Klick-daneben uebernimmt die Listenphase selbst ueber ihre
    // DismissableLayer. Die Formularschritte liegen ausserhalb davon und
    // brauchen dieselbe Behandlung von Hand.
    if (phase === "root") {
      return () => {
        window.removeEventListener("scroll", onViewportChange, true);
        window.removeEventListener("resize", onViewportChange);
      };
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!formPanelRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Escape innerhalb des Panels heisst "zurueck zur Liste" und wird schon
      // dort behandelt; dieser Zweig fasst nur die Tastatur ausserhalb an.
      if (event.key === "Escape" && !formPanelRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
    };
  }, [onClose, phase, transfer]);

  // Radix wuerde den Ziel-Dialog als "Klick daneben" lesen und das Menue unter
  // ihm zuschliessen. Solange der Dialog offen ist, bleiben die drei
  // Weg-weisen-Events deshalb Radix vorenthalten.
  const holdWhileTransfer = useCallback((event: { preventDefault: () => void }) => {
    if (transfer) event.preventDefault();
  }, [transfer]);

  const handlePanelKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    // In den Formularschritten heisst Escape "zurueck zur Liste", nicht
    // "Menue schliessen" — sonst verliert man den Weg zum naechsten Schritt.
    // Das Panel stoppt den Weg nach oben, damit nicht zugleich der
    // Dokument-Listener aus dem Effekt oberhalb das ganze Menue schliesst.
    event.preventDefault();
    event.stopPropagation();
    setPhase("root");
  }, []);

  const run = useCallback((work: () => Promise<ActionResult>, notice: string) => {
    onClose();
    void work().then((result) => {
      if (result.ok) {
        onMutated();
        onNotify({ kind: "success", text: notice });
        return;
      }
      onNotify({ kind: "error", text: result.error });
    });
  }, [onClose, onMutated, onNotify]);

  const handleCopyPath = useCallback(() => {
    onClose();
    void copyText(target.path).then(
      () => onNotify({ kind: "success", text: t("files.copyPathDone") }),
      () => onNotify({ kind: "error", text: t("files.copyPathFailed") }),
    );
  }, [onClose, onNotify, t, target.path]);

  const handleSubmitName = useCallback((value: string) => {
    const name = value.trim();
    const isRename = phase === "rename";
    onClose();
    // Ein Name ist genau ein Pfadsegment. Die API lehnt `../` ohnehin ab, aber
    // ein Versuch von hier aus ist eine vermeidbare Anfrage mit einer
    // technischen statt einer verstaendlichen Fehlermeldung.
    if (name.length === 0 || name === "." || name === ".."
      || name.includes("/") || name.includes("\\") || name.includes("\0")) {
      onNotify({ kind: "error", text: t("files.invalidName") });
      return;
    }
    // Sowohl rename als auch mkdir adressieren ueber den Pfad die Quelle: der
    // Pfad ist der umzubenennende Eintrag bzw. der Ordner, in dem der neue
    // Ordner entsteht.
    run(
      () => postFileAction(target.path, isRename ? "rename" : "mkdir", { name }),
      isRename ? t("files.renamedTo", { name }) : t("files.folderCreated", { name }),
    );
  }, [onClose, onNotify, phase, run, t, target.path]);

  const handleTransferStart = useCallback((kind: TransferKind) => {
    // Das Menue bleibt offen und legt nur den Dialog darueber — sonst riss der
    // naechste `pointerdown` auf dem Dialog das Menue mitsamt dem Dialog weg.
    setPhase("root");
    setTransfer({ kind, busy: false });
  }, []);

  const handleTransferConfirm = useCallback((destination: string) => {
    setTransfer((current) => current && { ...current, busy: true });
    void postFileAction(target.path, transfer?.kind ?? "copy", { destination })
      .then((result) => {
        setTransfer(null);
        onClose();
        if (result.ok) {
          onMutated();
          onNotify({
            kind: "success",
            text: transfer?.kind === "move"
              ? t("files.movedTo", { destination })
              : t("files.copiedTo", { destination }),
          });
          return;
        }
        onNotify({ kind: "error", text: result.error });
      });
  }, [onClose, onMutated, onNotify, t, target.path, transfer?.kind]);

  const handleDelete = useCallback(() => {
    run(
      () => deleteEntry(target.path),
      t("files.deleteDone", { name: target.name }),
    );
  }, [run, t, target.name, target.path]);

  const items = useMemo<MenuItem[]>(() => {
    const list: MenuItem[] = [];
    if (target.isDir) {
      list.push({
        action: "new-folder",
        label: t("files.contextNewFolder"),
        icon: <MenuIcon><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><line x1="12" y1="11" x2="12" y2="16" /><line x1="9.5" y1="13.5" x2="14.5" y2="13.5" /></MenuIcon>,
      });
    } else {
      // Nur Bilder bekommen den Vorschau-Eintrag. Er erscheint vor Copy path,
      // weil "was ist das fuer ein Bild" die häufigere Frage ist als der Pfad.
      if (onOpenImage && isImagePath(target.name)) {
        list.push({
          action: "preview",
          label: t("files.contextPreview"),
          icon: <MenuIcon><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m4 17 5-4 3.5 2.5L16 12l4 4" /></MenuIcon>,
        });
      }
      list.push({
        action: "copy-path",
        label: t("files.contextCopyPath"),
        icon: <MenuIcon><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></MenuIcon>,
      });
    }
    list.push({
      action: "rename",
      label: t("files.contextRename"),
      icon: <MenuIcon><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></MenuIcon>,
    });
    if (target.isDir) {
      list.push({
        action: "copy-to",
        label: t("files.contextCopyTo"),
        icon: <MenuIcon><rect x="9" y="3" width="11" height="12" rx="2" /><path d="M5 21V8a2 2 0 0 1 2-2h4" /></MenuIcon>,
      });
      list.push({
        action: "move-to",
        label: t("files.contextMoveTo"),
        icon: <MenuIcon><path d="M5 12h13" /><polyline points="13 6 19 12 13 18" /></MenuIcon>,
      });
    }
    list.push({
      action: "delete",
      label: t("files.contextDelete"),
      icon: <MenuIcon><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></MenuIcon>,
      danger: true,
    });
    return list;
  }, [t, target.isDir, target.name, onOpenImage]);

  const selectAction = useCallback((action: MenuAction) => {
    if (action === "copy-path") { handleCopyPath(); return; }
    if (action === "preview") {
      // Das Menue schliesst nicht selbst: die Vorschau ist ein zentriertes
      // Overlay, das ueber allem liegt. Wer beide offen haelt, sieht im
      // Hintergrund noch die Zeile, aus der herausgeklickt wurde.
      onOpenImage?.(target.path, target.name);
      return;
    }
    if (action === "new-folder") { setDraft(""); setPhase("new-folder"); return; }
    if (action === "rename") { setDraft(target.name); setPhase("rename"); return; }
    if (action === "copy-to") { handleTransferStart("copy"); return; }
    if (action === "move-to") { handleTransferStart("move"); return; }
    setPhase("confirm-delete");
  }, [handleCopyPath, handleTransferStart, onOpenImage, target.name, target.path]);

  const panelLabel = phase === "rename"
    ? t("files.contextRename")
    : phase === "new-folder"
      ? t("files.contextNewFolder")
      : phase === "confirm-delete"
        ? t("files.contextDelete")
        : t("files.contextLabel", { name: target.name });

  return (
    <ContextMenu
      open
      // `modal={false}` ist keine Verlegenheitsloesung: ein modales Menue legt
      // `pointer-events: none` ueber alles ausserhalb seiner DismissableLayer
      // und sperrt den Fokus. Der Ziel-Dialog liegt mit z-index 1100 ueber dem
      // Menue und muss bedienbar bleiben, und ein Fokusfalle hinter einem
      // zweiten Overlay ist genau die Kopplung, die invariant 5 aufloest.
      modal={false}
      onOpenChange={(open) => { if (!open) onClose(); }}
    >
      <ContextMenuTrigger ref={triggerRef} className="hidden" aria-hidden />
      {phase === "root" && (
        <ContextMenuContent
          aria-label={panelLabel}
          // Die Klemme macht Radix ueber die Kollisionserkennung; `MENU_MARGIN`
          // ist derselbe Rand, den die Formularschritte von Hand rechnen.
          collisionPadding={MENU_MARGIN}
          // Ohne Versatz beginnt das Panel genau am Klickpunkt wie vorher.
          sideOffset={0}
          // Die Pfeiltasten zyklisieren, so wie es die eigene `moveFocus` tat.
          loop
          onEscapeKeyDown={holdWhileTransfer}
          onPointerDownOutside={holdWhileTransfer}
          onFocusOutside={holdWhileTransfer}
          // Radix gibt den Fokus beim Schliessen an das Element zurueck, das es
          // vor dem Oeffnen gemerkt hat — hier das Panel des grossen Explorer-
          // Fensters. Gemessen: nach `Rename` lag `document.activeElement` auf
          // `FileExplorerWindow_panel__LVi1G`, nicht im Eingabefeld. Der
          // Phasenwechsel passiert in `onSelect`, also waehrend des Schliessens;
          // ein `requestAnimationFrame` danach kam messbar zu spaet (+0ms lag
          // der Fokus schon woanders). Der Haken sitzt deshalb genau hier.
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (phaseRef.current === "rename") {
              draftRef.current?.focus();
              draftRef.current?.select();
              return;
            }
            // Die Bestaetigung startet auf "Abbrechen" und nicht auf dem roten
            // Knopf, damit ein gewohnheitsmaessiges Enter nichts loescht.
            if (phaseRef.current === "confirm-delete") cancelRef.current?.focus();
          }}
          onContextMenu={(event) => event.preventDefault()}
          style={{
            zIndex: MENU_Z_INDEX,
            minWidth: MENU_MIN_WIDTH,
            maxWidth: `min(${MENU_MAX_WIDTH}px, calc(100vw - ${MENU_MARGIN * 2}px))`,
          }}
        >
          {items.map((item) => (
            <ContextMenuItem
              key={item.action}
              variant={item.danger ? "destructive" : "default"}
              className="gap-2 text-xs"
              onSelect={(event) => {
                // Radix schliesst das Menue nach einem `onSelect` von sich aus.
                // Hier entscheidet der Pfad, wer das Menue schliesst:
                // `preview` laesst es offen, die Formularschritte uebergeben an
                // den Panel-Zustand, und die abrschliessenden Aktionen rufen in
                // ihrem Zweig selbst `onClose`. `preventDefault` nimmt Radix in
                // allen drei Faellen das Schliessen ab, statt die Regel auf
                // mehrere Ebenen zu verteilen.
                event.preventDefault();
                selectAction(item.action);
              }}
            >
              {item.icon}
              <span className="flex-1">{item.label}</span>
            </ContextMenuItem>
          ))}
        </ContextMenuContent>
      )}

      {/* Die Formularschritte sind Geschwister der Liste im selben Portal und
          ausdruecklich KEINE Submenues: Escape muss hier "zurueck zur Liste"
          bedeuten. Sie klemmen sich deshalb selbst, weil sie kein Radix-Panel
          sind. */}
      {phase !== "root" && portalTarget && createPortal(
        <Reveal
          ref={formPanelRef}
          role="dialog"
          aria-modal
          aria-label={panelLabel}
          tabIndex={-1}
          onKeyDown={handlePanelKeyDown}
          onContextMenu={(event) => event.preventDefault()}
          style={{
            position: "fixed",
            left: placement?.left ?? target.x,
            top: placement?.top ?? target.y,
            zIndex: MENU_Z_INDEX,
            maxWidth: `min(${MENU_MAX_WIDTH}px, calc(100vw - ${MENU_MARGIN * 2}px))`,
          }}
          className="rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-md outline-none"
        >
          {(phase === "rename" || phase === "new-folder") && (
            <form
              aria-label={panelLabel}
              onSubmit={(event) => {
                event.preventDefault();
                handleSubmitName(draft);
              }}
              className="flex flex-col gap-1.5"
              style={{ width: PANEL_CONTENT_WIDTH, maxWidth: "100%" }}
            >
              <span title={target.path} className="truncate text-[10px] text-muted-foreground">
                {phase === "rename" ? target.name : target.path}
              </span>
              <Input
                ref={draftRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                aria-label={panelLabel}
                placeholder={phase === "new-folder" ? t("files.newFolderName") : undefined}
                className="h-6 font-mono text-xs"
                // Kein `autoFocus`: im Portal-Mount greift es nicht
                // (`inp.autofocus === false` gemessen), der Fokus laeuft ueber
                // den `requestAnimationFrame` im Effekt weiter oben.
              />
              <div className="flex justify-end gap-1.5">
                <Button ref={cancelRef} type="button" variant="outline" size="xs" onClick={() => setPhase("root")}>
                  {t("files.cancel")}
                </Button>
                <Button type="submit" size="xs">
                  {phase === "rename" ? t("files.actionRename") : t("files.actionCreate")}
                </Button>
              </div>
            </form>
          )}

          {phase === "confirm-delete" && (
            <div
              aria-label={panelLabel}
              className="flex flex-col gap-1.5"
              style={{ width: PANEL_CONTENT_WIDTH + 16, maxWidth: "100%" }}
            >
              <span className="break-words text-[11px] leading-[1.35]">
                {t("files.confirmDelete", { name: target.name })}
              </span>
              {target.isDir && (
                <span className="break-words text-[10px] leading-[1.35] text-destructive">
                  {t("files.confirmDeleteFolder")}
                </span>
              )}
              <div className="flex justify-end gap-1.5">
                <Button ref={cancelRef} type="button" variant="outline" size="xs" onClick={() => setPhase("root")}>
                  {t("files.cancel")}
                </Button>
                <Button type="button" variant="destructive" size="xs" onClick={handleDelete}>
                  {t("files.contextDelete")}
                </Button>
              </div>
            </div>
          )}
        </Reveal>,
        portalTarget,
      )}

      {transfer && (
        // Der Dialog ist ein Geschwister des Panels, nicht ein Kind: nur so
        // liegt sein Backdrop (z-index 1100) ueber dem Menue und nicht in
        // dessen Innenleben, das auf Zeilenhoehe und Tastaturfluss traint.
        <FileBrowserDialog
          open
          title={transfer.kind === "move"
            ? t("files.moveDialogTitle", { name: target.name })
            : t("files.copyDialogTitle", { name: target.name })}
          initialPath={getFileDirectory(target.path) || "/"}
          confirmLabel={transfer.kind === "move" ? t("files.moveHere") : t("files.copyHere")}
          busy={transfer.busy}
          onCancel={() => setTransfer(null)}
          onConfirm={handleTransferConfirm}
        />
      )}
    </ContextMenu>
  );
}

/** Kurzhinweis unten rechts zu Erfolg oder Fehler einer Dateiaktion. */
export function FileActionToast({ notice, onDismiss }: { notice: FileActionNotice; onDismiss: () => void }) {
  const { t } = useI18n();
  const isError = notice.kind === "error";
  return (
    <Enter
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      /* `Enter` nimmt keine `role`-/`aria-live`-Attribute an; der Toast traegt die
         Fehlermeldung in die Screenreader-Ansage, deshalb sitzt der Lauf direkt
         auf dem Element, mit den Werten von `Enter direction="up"`. */
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 900,
        display: "flex",
        alignItems: "flex-start",
        gap: 6,
        maxWidth: 360,
        padding: "7px 8px",
        background: "var(--bg-panel)",
        border: `1px solid color-mix(in srgb, ${isError ? "var(--danger)" : "var(--accent)"} 52%, var(--border))`,
        borderRadius: 6,
        boxShadow: "0 8px 24px rgba(0,0,0,0.24)",
      }}
    >
      <span style={{ minWidth: 0, flex: 1, fontSize: 11, lineHeight: 1.35, color: isError ? "var(--danger)" : "var(--text)", overflowWrap: "anywhere" }}>
        {notice.text}
      </span>
      <Pressable
        type="button"
        onClick={onDismiss}
        title={t("files.dismissError")}
        aria-label={t("files.dismissError")}
        style={{ width: 18, height: 18, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "none", borderRadius: 4, background: "transparent", color: "var(--text-dim)", cursor: "pointer" }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <path d="m6 6 12 12" />
          <path d="m18 6-12 12" />
        </svg>
      </Pressable>
    </Enter>
  );
}