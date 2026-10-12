"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { getFileIcon } from "./FileIcons";
import { useI18n } from "@/hooks/useI18n";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

export interface FileTab {
  /**
   * `"explorer"` ist der Baum selbst, dauerhaft der erste Tab des Fensters.
   * Er traegt keine Datei und wird nie geschlossen: er ist der Rueckweg aus
   * jeder Datei heraus, und ein Tabstrom, in dem man sich selbst einschliessen
   * kann, ist keine Navigation. `"file"` ist alles, was eine Datei zeigt.
   */
  kind: "explorer" | "file";
  id: string;
  label: string;
  /**
   * Leer, solange der Tab keine Datei hat — dann ist er ein von Hand
   * angelegter Platzhalter und traegt `label` als eigene Beschriftung. Nur das
   * grosse Explorer-Fenster legt solche Tabs an; die Leiste im rechten Panel
   * kennt sie nicht. Solange `filePath` leer ist, darf kein `FileViewer`
   * gerendert werden: er wuerde einen leeren Pfad laden und mit einer
   * Fehlermeldung enden.
   */
  filePath: string;
  sourceSessionId?: string | null;
  initialDisplayMode?: "source" | "preview" | "diff" | "edit";
  /**
   * Verzeichnis, in dem der Tab angelegt wurde. Nur gesetzt bei einem Tab
   * ohne Datei, und nur damit dessen Auswahl-Ansicht dort startet, wo der
   * Nutzer den Baum gerade stehen hat. Beim Zuweisen einer Datei ist der Wert
   * bedeutungslos und bleibt einfach stehen.
   */
  startPath?: string;
}

export interface TerminalTab {
  kind: "terminal";
  id: string;
  label: string;
  terminalId: string;
}

export type Tab = FileTab | TerminalTab;

/**
 * Mindestbewegung in Pixeln, ab der aus einem Klick ein Zug wird. Ohne diese
 * Schwelle waehlt schon das kleinste Wackeln beim Klick den Tab aus.
 */
const DRAG_THRESHOLD_PX = 4;

interface Props {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  /**
   * Opt-in. Wenn gesetzt, lassen sich die Tabs mit Maus und Finger
   * verschieben, und beim Fallen wird `onReorder(id, beforeId)` gerufen.
   * `beforeId` ist die Id des Tabs, vor dem der gezogene Tab landet; ein
   * leerer String bedeutet "ganz ans Ende".
   *
   * Ohne diese Prop bleibt die Leiste unveraendert: keine Pointer-Handler,
   * kein `touch-action`, kein Verschieben. Das Fenster im Explorer schaltet
   * es ein, die Leiste im rechten Panel nicht — dort ist die Reihenfolge die
   * Reihenfolge, in der der Nutzer die Dateien geoeffnet hat.
   */
  onReorder?: (id: string, beforeId: string) => void;
}

/** Zustand eines laufenden Zugs, in einem Ref statt im State. */
interface DragState {
  id: string;
  pointerId: number;
  startX: number;
  /** `false`, solange die Mindestbewegung nicht erreicht ist. */
  active: boolean;
  /** Waehrend des Zugs wandernd; beim Fallen der Index, an dem landen. */
  toIndex: number;
}

/** Was der Renderer zum Verschieben braucht. */
interface DragVisual {
  id: string;
  offsetX: number;
  fromIndex: number;
  toIndex: number;
  width: number;
}

/* Die Kachel traegt Rahmen, Hintergrund und Schrift; radix' eigene Optik
 * (Pille, `bg-muted`, Hover-Wechsel, `dark:`-Zweifarben) wird zurueckgedreht.
 * `min-w-0` auf dem Trigger ist Pflicht, sonst waehlt der Trigger seine
 * Mindestbreite aus dem Text und `truncate` greift nie. */
const TAB_CLASS =
  "flex shrink-0 items-stretch border-r border-border bg-card text-xs font-normal text-muted-foreground " +
  "data-active:bg-background data-active:text-foreground data-active:font-medium " +
  "max-w-45 min-w-20 cursor-pointer scroll-m-1";

/* `text-current` und `bg-transparent` machen den Trigger farbneutral: Farbe und
 * Hintergrund kommen von der Kachel (`TAB_CLASS`), damit Aktivzustand und
 * Ziehanimation an einem Element haengen. `dark:text-muted-foreground` und
 * `dark:hover:text-foreground` sind die einzigen radix-Regeln, die ohne
 * `data-active` wirklich treffen, also werden sie hier ueberschrieben. */
const TRIGGER_CLASS =
  "h-full min-w-0 flex-1 justify-start gap-1.5 rounded-none border-0 bg-transparent px-3 py-0 text-xs " +
  "font-normal text-current after:hidden hover:text-current dark:text-current dark:hover:text-current";

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, onReorder }: Props) {
  const { t } = useI18n();
  const [drag, setDrag] = useState<DragVisual | null>(null);
  const dragRef = useRef<DragState | null>(null);
  // Nach einem abgeschlossenen Zug darf der abschliessende Klick den Tab nicht
  // waehlen: die Auswahl ist genau das, was der Nutzer mit dem Zug vermieden
  // hat. Zurueckgesetzt wird bei jedem neuen `pointerdown`, damit das Flag
  // niemals in den naechsten Klick hineinragt.
  const swallowClickRef = useRef(false);
  // Dynamische Schluessel, im Lauf geaendert — deshalb eine Map und kein
  // Record. Sie haelt die Elemente fuer die Trefferpruefung beim Ziehen.
  const tabRefs = useRef(new Map<string, HTMLDivElement>());

  /**
   * Haelt den aktiven Tab sichtbar.
   *
   * Die Tabs waechsen nach rechts, und nichts hat sie bisher gerollt: im
   * Hauptpanel faellt das nicht auf, weil die Leiste dort breiter ist als die
   * Tabs. Im Explorer-Fenster ist sie es nicht — der neu geoeffnete Tab ragt
   * hinaus und sieht abgeschnitten aus, obwohl die Kachel intakt ist. Die
   * Leiste scrollt bereits (`overflow-x-auto` an der Wurzel), es fehlte nur
   * der Anlass.
   *
   * `nearest` statt `center`: es rollt nur so weit, wie noetig ist. Ein
   * `center` wuerde beim Wechsel zwischen zwei sichtbaren Tabs die halbe
   * Leiste mitschieben, obwohl nichts verdeckt war. `scroll-m-1` auf der
   * Kachel haelt ihren Rand vom Leistenrand weg.
   */
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = stripRef.current;
    const active = tabRefs.current.get(activeTabId);
    if (!strip || !active) return;
    active.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs.length]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>, tabId: string) => {
    if (!onReorder) return;
    // Nur die linke Taste zieht. Die mittlere schliesst den Tab
    // (`onAuxClick`); liefe sie mit, wuerde jeder Zug den Tab schliessen.
    if (event.button !== 0) return;
    // Der Schliessen-Knopf ist kein Griff zum Verschieben.
    if ((event.target as HTMLElement).closest("[data-tab-close]")) return;
    swallowClickRef.current = false;
    dragRef.current = {
      id: tabId,
      pointerId: event.pointerId,
      startX: event.clientX,
      active: false,
      toIndex: tabs.findIndex((tab) => tab.id === tabId),
    };
    // Pointer-Capture haelt die Bewegung am Tab, auch wenn der Zeiger ueber
    // den Rand der Leiste wandert.
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>, tabId: string) => {
    const state = dragRef.current;
    if (!state || state.pointerId !== event.pointerId || state.id !== tabId) return;
    const delta = event.clientX - state.startX;
    if (!state.active) {
      if (Math.abs(delta) < DRAG_THRESHOLD_PX) return;
      state.active = true;
      swallowClickRef.current = true;
      // Ab hier ist es ein Zug und kein Klick. Eine Textmarkierung, die beim
      // `pointerdown` entstanden ist oder schon vorher stand, wird geloescht —
      // sie waechst sonst ueber die Leiste mit und bleibt stehen, wenn der Tab
      // fallen gelassen wurde. `select-none` verhindert nur den *Anfang*; was
      // bereits markiert ist, muss weg.
      window.getSelection?.()?.removeAllRanges?.();
    }

    const fromIndex = tabs.findIndex((tab) => tab.id === state.id);
    const element = tabRefs.current.get(state.id);
    if (fromIndex < 0 || !element) return;
    const rect = element.getBoundingClientRect();
    // Die Mitte des gezogenen Tabs entscheidet, wo es landet. Verglichen
    // wird gegen die Mitte jedes Tabs, das der Zeiger kreuzt — in beide
    // Richtungen, damit der Tab auch ueber den Rand der Liste wandern kann.
    const center = rect.left + rect.width / 2 + delta;
    let toIndex = fromIndex;
    tabs.forEach((tab, index) => {
      if (index === fromIndex) return;
      const other = tabRefs.current.get(tab.id);
      if (!other) return;
      const box = other.getBoundingClientRect();
      const otherMiddle = box.left + box.width / 2;
      if (index < fromIndex && center < otherMiddle) toIndex = Math.min(toIndex, index);
      if (index > fromIndex && center > otherMiddle) toIndex = Math.max(toIndex, index);
    });
    state.toIndex = toIndex;

    setDrag({ id: state.id, offsetX: delta, fromIndex, toIndex, width: rect.width });
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (typeof event.currentTarget.releasePointerCapture === "function"
      && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const state = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!state || !state.active) return;

    // Der eigentliche Umbau: nicht die Position rueckgaengig machen, sondern
    // die Reihenfolge melden. Wer nur den Versatz zuruecksetzt, laesst den Tab
    // beim naechsten Aufbau wieder an seiner alten Stelle stehen — er waere
    // nur optisch gewandert, nicht wirklich umsortiert.
    const without = tabs.filter((tab) => tab.id !== state.id);
    // `toIndex` ist der Zielplatz in der Liste *nach* dem Herausnehmen, und
    // genau dort wird wieder eingefuegt — nach links wie nach rechts gleich.
    const before = without[state.toIndex];
    onReorder?.(state.id, before?.id ?? "");
  };

  return (
    <Tabs
      ref={stripRef}
      value={activeTabId}
      // radix meldet jede Auswahl hier: Klick, Enter/Leertaste und die
      // Pfeiltasten des Roving-Focus. `mousedown` ist der einzige Weg, der
      // beim Verschieben ausgetrennt werden muss, und das erledigt der
      // `onMouseDown` am Trigger weiter unten.
      onValueChange={onSelectTab}
      className="data-horizontal:flex-row h-9 shrink-0 items-stretch gap-0 overflow-x-auto bg-card"
    >
      <TabsList
        variant="default"
        className="group-data-horizontal/tabs:h-9 w-max items-stretch justify-start gap-0 rounded-none bg-transparent p-0"
      >
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeTabId;
          // Nur der gezogene Tab folgt dem Zeiger; die uebrigen ruecken in die
          // Luecke, die beim Fallen ohnehin entsteht, damit man sie vorher sieht.
          let shift = 0;
          if (drag && index !== drag.fromIndex) {
            if (drag.fromIndex < drag.toIndex && index > drag.fromIndex && index <= drag.toIndex) shift = -drag.width;
            else if (drag.toIndex < drag.fromIndex && index >= drag.toIndex && index < drag.fromIndex) shift = drag.width;
          }
          const dragging = drag?.id === tab.id;
          return (
            <div
              key={tab.id}
              data-active={isActive ? "" : undefined}
              // `select-none` gehoert an den Griff, nicht an die Kachel selbst:
              // nur wenn `onReorder` gesetzt ist, wird ueberhaupt gezogen. Ohne den
              // Zusatz startet `pointerdown` auf dem Beschriftungstext eine
              // Textmarkierung, und `pointermove` verlaengert sie ueber die ganze
              // Leiste — der Nutzer zieht seinen Tab und markiert dabei die
              // Tabnamen daneben. `touch-none` allein unterbindet nur die
              // Touch-Geste, nicht die Maus.
              className={TAB_CLASS + (onReorder ? " touch-none select-none " : " ") + (dragging ? "opacity-85" : "transition-transform duration-150")}
              ref={(element) => {
                if (element) tabRefs.current.set(tab.id, element);
                else tabRefs.current.delete(tab.id);
              }}
              onClick={() => {
                if (!onReorder) return;
                if (swallowClickRef.current) {
                  swallowClickRef.current = false;
                  return;
                }
                onSelectTab(tab.id);
              }}
              onPointerDown={(event) => handlePointerDown(event, tab.id)}
              onPointerMove={(event) => handlePointerMove(event, tab.id)}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onMouseDown={(event) => {
                // `event.button === 0` ist der Fall, um den es hier geht: ohne
                // `preventDefault()` beginnt der Browser auf dem Text unter dem
                // Zeiger eine Markierung, bevor `select-none` überhaupt eine
                // Rolle spielen kann. `select-none` allein genuegt nicht, wenn
                // die Markierung schon begonnen hat — sie verhindert nur den
                // Anfang. Die mittlere Taste bleibt unberuehrt, sie wird ja
                // weiter unten ausgewertet.
                if (event.button === 1 || (onReorder && event.button === 0)) event.preventDefault();
              }}
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                event.stopPropagation();
                onCloseTab(tab.id);
              }}
              style={dragging
                ? { transform: `translateX(${drag!.offsetX}px)`, opacity: 0.85 }
                : shift !== 0 ? { transform: `translateX(${shift}px)` } : undefined}
            >
              <TabsTrigger
                value={tab.id}
                className={TRIGGER_CLASS}
                onMouseDown={(event) => {
                  // radix' `composeEventHandlers` laesst seine eigene
                  // Auswahl genau dann aus, wenn der eigene Handler
                  // `preventDefault()` gesetzt hat.
                  if (onReorder) event.preventDefault();
                }}
              >
                {/* Ein Tab ohne Datei bekommt bewusst KEIN Datei-Icon. Der Pfad
                    von `getFileIcon` waere der leere String, der ohne Treffer in
                    `EXTENSION_ICONS` auf das generische Dateisymbol zurueckfaellt
                    — und damit behauptete der Tab, eine Datei zu zeigen. Ein
                    leerer Tab braucht ein Merkmal, das seinen Zustand nennt und
                    nicht seinen Inhalt. */}
                <span className={"flex shrink-0 items-center " + (isActive ? "opacity-100" : "opacity-70")}>
                  {tab.kind === "file" && !tab.filePath
                    ? <Plus aria-hidden className="size-[13px]" strokeWidth={2.2} />
                    : getFileIcon(tab.label, 13)}
                </span>
                {/* Ohne Datei waere `tab.filePath` leer und der Tooltip stumm —
                    sichtbar ist dann nur der Titel des Tabs. Die Beschriftung
                    steht als Rueckfall dahinter, weil sie auch fuer einen leeren
                    Tab das einzige ist, was ihn benennt. */}
                <span
                  className="min-w-0 flex-1 truncate"
                  title={tab.kind === "file" ? (tab.filePath || tab.label) : tab.kind === "explorer" ? tab.label : `Terminal · ${tab.label}`}
                >
                  {tab.label}
                </span>
              </TabsTrigger>
              <button
                type="button"
                data-tab-close=""
                onClick={(event) => { event.stopPropagation(); onCloseTab(tab.id); }}
                // Der Explorer-Tab ist der Rueckweg und hat keinen. Der Knopf
                // verschwindet nicht nur optisch — `handleCloseTab` im Fenster
                // weist ihn ohnehin zurueck, und ein Knopf, der dann nichts
                // tut, waere schlechter als keiner.
                className={
                  "mr-1.5 my-auto flex size-6 shrink-0 items-center justify-center rounded border-0 bg-transparent p-0 " +
                  "text-text-dim transition-colors hover:bg-bg-hover hover:text-foreground " +
                  (tab.kind === "explorer" ? "hidden" : "")
                }
                title={t("i18n.close")}
                aria-label={`${t("i18n.close")} ${tab.label}`}
              >
                <X aria-hidden className="size-[11px]" strokeWidth={1.8} />
              </button>
            </div>
          );
        })}
      </TabsList>
    </Tabs>
  );
}