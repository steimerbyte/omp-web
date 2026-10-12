# Inventur: Benutzeroberfläche

Rein lesend erstellt, kein Produktionscode geändert. Grundlage ist der Quelltext, nicht die
Historie: jede Aussage unten ist an einer `Datei.tsx:Zeile` oder an einer Stelle in
`node_modules` belegt. Was ich nicht belegen konnte, steht als **unklar**.

## Zwei Vorbemerkungen, die das ganze Dokument betreffen

**1. Es gibt keine deutschen Beschriftungen.** Die Aufgabenstellung verlangte, die deutsche
Beschriftung zu nennen, weil das ist, was der Nutzer sieht. Das trifft auf dieses Projekt nicht
zu: `lib/i18n/registry.ts:35-36` registriert genau zwei Sprachpakete, `en` und `zh-CN`
(`lib/i18n/messages/en.ts`, `lib/i18n/messages/zh-CN.ts`, je 618 Zeilen). `resolveBrowserLocale`
fällt für jede andere Browsersprache auf `en` zurück (`registry.ts:24-32`). `app/layout.tsx:53`
setzt `lang="en"`. **Die im Folgenden genannten Beschriftungen sind die englischen aus
`lib/i18n/messages/en.ts`, nicht übersetzte.** Nicht katalogeintragte Beschriftungen sind
Hartkodierungen in der jeweiligen Komponente; ich nenne sie im Klartext.

**2. Format.** Jedes Element bekommt vier Bullets. `Kann` = belegte Funktion. `Tastatur` =
gelesener Handler, kein Raten aus dem Namen. `Darf nicht` = Verhalten, das aus der
shadcn/radix-Umstellung entstanden ist und das beim Refactor wieder „repariert" würde.
`Ort` = Fundstelle.

---

## 1. Panels (Hauptflächen)

### AppShell — Hauptlayout mit drei Spalten
- **Kann**: Setzt das Rahmenwerk: linke Session-Sidebar, mittig Chat, rechts Dateifenster,
  getrennt durch zwei ziehbare Separatoren aus `react-resizable-panels`. Enthält die
  Kopfleiste (Settings, Sidebar-Umschalter, Theme, Sprache, Trust-Indikator, Volltextsuche,
  System-Prompt, Session-Titel mit Auto-Namensgebung, Systemstatistik) und blendet je nach
  Zustand `SessionSidebar`, `ChatWindow`, `FileExplorer`/`FileViewer`, `SubagentPanel` ein.
- **Tastatur**: Die Separatoren fangen die Pfeiltasten in der **Capture-Phase** ab
  (`AppShell.tsx:1207`, `:1999` → `separatorArrowKeys`, `AppShell.tsx:128-158`).
  `ArrowRight`/`ArrowLeft` verschieben in **12px-Schritten**, mit `Shift` in **32px**. `Home`,
  `End`, `Enter` und `F6` bleiben unangetastet und landen in der nativen Handler der Bibliothek.
  `Enter` setzt den Separator zurück (Text: „Double-click or press Enter to reset",
  `en.ts:87`). `Escape` gibt es im `AppShell` **nicht** (grep über die ganze Datei: null Treffer).
- **Darf nicht**: (a) Der Capture-Handler darf nicht in einen Bubble-`onKeyDown` umgezogen werden.
  `react-resizable-panels` registriert einen *nativen* `addEventListener("keydown", Ot)` direkt am
  Separator-Element; ein nativer Listener am Ziel feuert vor Reacts Bubble-Handler, und `Ot` bricht
  nur bei `defaultPrevented` ab — dort ist es noch `false`. Ein `preventDefault` im Bubble-Handler
  kommt zu spät: der Bibliotheksschritt (5 % der Zeile) ist dann schon angewandt, jeder Pfeildruck
  bewegt den Separator **doppelt**. (`AppShell.tsx:104-125`) (b) Das Argument von `panel.resize()`
  muss ein **Prozent-String** bleiben: der Parser der Bibliothek (`sn()`, `case "number": return
  [e, "px"]`) liest eine nackte Zahl als Pixel, und 18,9 px liegt unter `minSize` und wird weggeklemmt
  — der versprochene 12px-Schritt fände dann nie statt. (`AppShell.tsx:149-157`) (c) `disabled`
  auf dem Separator ist die Voraussetzung dafür, dass der Griff aus dem Tab-Bereich verschwindet, solange
  das Explorer-Fenster offen ist bzw. das Dateifenster als Overlay läuft — die Bibliothek filtert
  `disabled` aus dem Pointer-Hittest (`bt`) und nimmt den Tabindex. Wer statt `disabled` nur die
  Sichtbarkeit per CSS löschen würde, bekommt einen tastaturbedienbaren, aber wirkungslosen Griff.
- **Ort**: `components/AppShell.tsx:174` (Komponente), `:128-158` (`separatorArrowKeys`),
  `:1196-1210` (Sidebar-Separator), `:1989-2004` (Datei-Separator), `:2037` (TabBar im rechten Panel)

### SessionSidebar — Projekt- und Sitzungsliste
- **Kann**: Liste der Projekte und ihrer Sessions, mit Suchfeld, „New session", „Add custom
  project path", Worktree-Umschalter, Umbenennen, Archivieren, Löschen (mit Shift-Klick fürs
  Löschen ohne Rückfrage), Badge „Agent läuft" und Zähler für neue Aktivität.
- **Tastatur**: Suchfeld: `Escape` leert den Filter und verlässt das Feld
  (`SessionSidebar.tsx:1358-1363`, sichtbar „Search projects and session titles…",
  `en.ts:111`). Umbenennen-Feld: `Enter` = `commitRename`, `Escape` = Umbruch ohne Änderung
  (`:2461-2463`). Suchfelder in den Untermenüs (Worktrees, Aktionen) behandeln `Escape`
  ebenfalls (`:1652-1655`, `:1810-1816`). Kein globales `Escape` zum Schließen der Sidebar.
- **Darf nicht**: Der Suchfilter wird nur über das eigene `preventDefault()` behandelt, nicht über
  einen globalen Escape-Handler. Ein neu gebauter globaler Escape-Handler würde beim Leeren des
  Filters zusätzlich die Sidebar schließen — zwei Ebenen an einem Tastendruck.
- **Ort**: `components/SessionSidebar.tsx:1229-2240` (Fläche), `:1358` (Suche), `:2461` (Rename)

### ChatWindow — Nachrichtenstrom
- **Kann**: Rendert die Unterhaltung, den Prozess-Kopf (mit Auf-/Zuklappen), den Ladezustand der
  Session, „Jump to bottom", die Shimmer-Leiste mit Agent-Phase und laufendem Kommando, sowie die
  Overlay-Ebenen für Agentenfragen, Plan-Feedback und Extension-Eingaben.
- **Tastatur**: Agentenfrage-Overlay: `Escape` = mit `{ cancelled: true }` beantworten
  (`ChatWindow.tsx:1063-1065`); im Texteingabefeld zusätzlich `Cmd/Ctrl+Enter` = absenden
  (`:1225-1227`). Plan-Feedback: `Enter` = absenden, `Escape` = abbrechen (`:1445-1447`);
  in der Variante mit Eingabefeld `Escape` = abbrechen und `Cmd/Ctrl+Enter` = absenden
  (`:1466-1468`). Extension-Eingabe (`:1601`): **kein** eigener Tastatur-Handler — jede Taste geht
  über `toTerminalKeyData` an den Prozess, der Handler bricht bei laufender IME-Komposition ab.
  „Jump to bottom" hat keine Taste.
- **Darf nicht**: Das Extension-Eingabefeld ruft bei jedem Tastendruck `preventDefault()` und
  `stopPropagation()` (`ChatWindow.tsx:1603-1605`). Ohne das landen Tasten im umgebenden Dokument
  und lösen Chat-Escape-Logik aus. Die Kompositionsprüfung (`composingRef.current ||
  nativeEvent.isComposing`, `:1602`) darf nicht wegoptimiert werden: sonst frisst der IME-Kandidat
  die Tasten.
- **Ort**: `components/ChatWindow.tsx:170-190` (Prozess-Kopf), `:1063-1090` (Fragen-Overlay),
  `:1445-1470` (Plan-Feedback), `:1596-1620` (Extension-Eingabe), `:778-800` (Jump to bottom)

### ChatInput — Eingabefeld und Steuerleiste
- **Kann**: Texteingabe mit Höhenautomatik, Slash-Kommandos, `@`-Dateierwähnung, Verlauf der
  eigenen Eingaben, Bildanhänge, Modellauswahl inkl. Rollen, Reasoning-Level, Tool-Preset,
  Kontextkompaktierung, Stop/Steer/Follow-up, Sound-Schalter, Steuerleiste einklappen.
- **Tastatur** (alles aus `handleKeyDown`, `ChatInput.tsx:1095-1217`):
  `Enter` ohne `Shift` = senden; während des Streamings = **Steer** (falls vorhanden), sonst
  Follow-up (`:1208-1215`). `Shift+Enter` = Zeilenumbruch. `Escape` während des Streamings =
  `onAbort()` (`:1202-1207`). `ArrowUp` bei leerem Feld = Verlaufsmenü öffnen (`:1192-1200`).
  Slash-Menü: `ArrowUp/Down/Left/Right` navigieren (die Richtung bestimmt die nächste Übereinstimmung),
  `Escape` schließt, `Tab` oder `Enter` bestätigt (`:1135-1168`). `@`-Menü: `ArrowUp/Down`,
  `Escape`, `Tab`/`Enter` (`:1170-1190`). Verlaufsmenü: `ArrowUp/Down`, `Escape`,
  `Tab`/`Enter` (`:1112-1133`). Modellfilter-Feld: `Escape` leert Filter und schließt das Menü
  (`:2231-2235`).
- **Darf nicht**: (a) Die IME-Sperre ganz oben (`isComposingRef || nativeEvent.isComposing ||
  keyCode === 229`, `:1100-1103`) und das `COMPOSITION_END_ENTER_GRACE_MS`-Fenster (`:1106-1110`)
  dürfen nicht vereinfacht werden: ohne sie sendet der erste Enter nach dem Ende einer japanischen/
  chinesischen Eingabe die halbe Komposition. (b) Die Reihenfolge der Menü-Zweige ist Absicht:
  Verlauf vor Slash vor `@`. (c) `Escape` bricht **nur** ab, wenn `isStreaming && onAbort` — während
  eines offenen Menüs schließt `Escape` das Menü und bricht nicht den Lauf ab.
- **Ort**: `components/ChatInput.tsx:1095-1217` (`handleKeyDown`), `:1963` (Textfeld),
  `:2006` (Steer), `:2029` (Follow-up), `:2111` (Bild anhängen), `:2177` (Modell), `:2417`
  (mehr Steuerung), `:2677` (Komprimieren), `:2695` (Stopp), `:2766` (Steuerleiste einklappen)

### FileExplorer — Dateibaum
- **Kann**: Baum über `react-arborist` mit Ausklappen, Auswahl, Öffnen, Kontextmenü,
  Git-Status-Abzeichen, Upload mit Fortschritt und Zusammenfassung, „Open explorer in a large
  window", geänderte Dateien, Diff-Ansicht der Git-Änderungen.
- **Tastatur**: Auswahl ausschließlich per `Ctrl`/`Cmd`-Klick (`FileExplorer.tsx:1874-1878`),
  **nicht** per einfachem Klick — einfacher Klick öffnet (`handleRowClick`, `:1866-1893`).
  Der Klick setzt zusätzlich den Tastaturcursor (`node.focus()`), damit die Pfeiltasten dort
  ansetzen, wo der Nutzer zuletzt war. `Escape` schließt das große Explorer-Fenster
  (`:932-954`), sofern kein verschachtelter Dialog offen ist.
- **Darf nicht**: (a) `Escape` darf **nicht** über die Reihenfolge der Listener entscheiden,
  sondern über den Test `target?.closest("[data-nested-overlay]")` (`:950`). Bildvorschau,
  Zielordner und Properties haben eigene `document`-Listener, und `stopPropagation` wirkt zwischen
  Geschwistern auf demselben Knoten nicht — ohne den DOM-Test schließt ein Tastendruck alle Ebenen
  auf einmal. (b) Der `Ctrl/Cmd`-Modifikator für die Auswahl ist keine Versehenheit, sondern der
  Grund, warum ein Dateimanager-Einfachklick eine Datei öffnen darf (Kommentar `:1868-1873`).
- **Ort**: `components/FileExplorer.tsx:1194-1400` (Toolbar), `:1560-1760` (Baumzeilen),
  `:1866-1897` (Zeilen-Klick), `:932-954` (Fenster-Escape), `:999-1004` (`TabBar` mit `onReorder`)

### FileViewer — Dateiansicht
- **Kann**: `Source` / `Preview` / `Diff` / `Edit` (Beschriftungen hartkodiert in
  `DISPLAY_MODE_LABELS`, `FileViewer.tsx:51-56`), Live-Sync-Umschalter, Download, At-Mention
  auf markierten Zeilen, Konfliktwiederherstellung beim Editieren.
- **Tastatur**: `Cmd/Ctrl+S` im Edit-Textarea speichert (`FileViewer.tsx:1301-1306`, nur ohne
  `Alt`/`Shift`). `Cmd/Ctrl+I` in der Ansicht `Source` mit Textauswahl erzeugt eine
  Zeilen-`@`-Erwähnung (`:957-973`; ignoriert `Alt`/`Shift`, Tastendrücke in `input`,
  `textarea`, `[contenteditable]`). Klick auf einen lokalen Markdown-Link mit linker Taste und
  ohne Modifikator öffnet die Datei im Viewer (`:1234-1240`).
- **Darf nicht**: Die `Ctrl/Ctrl+I`-Erwähnung prüft `event.repeat` und den Fokus-Zielkontext
  (`closest("input, textarea, [contenteditable='true']")`, `:958-963`). Ohne diese beiden Filter
  feuert die Erwähnung auch beim Tippen im Edit-Modus.
- **Ort**: `components/FileViewer.tsx:51-56`, `:957-973`, `:1050-1073`, `:1234-1240`, `:1301-1306`

### SubagentPanel — Subagenten-Liste
- **Kann**: Zwei Gruppen (laufend / Verlauf) mit Zählern, Detailansicht pro Subagent mit
  Live-Transkript (1-Sekunden-Polling, solange der Subagent aktiv ist), Metazeile mit Dauer,
  Werkzeug- und Tokenzahl, aufklappbar über die Kopfzeile.
- **Tastatur**: In der Detailansicht schließt `Escape` über einen `window`-Listener zurück zur
  Liste (`SubagentPanel.tsx:161-166`). Weitere Tasten: **keine** — die Liste hat keine Pfeiltasten-
  oder Enter-Navigation, die Zeilen sind `<button>` mit `role="listitem"` und reagieren auf
  Enter/Leertaste nur über den nativen Button-Klick.
- **Darf nicht**: (a) Der `Escape`-Handler hängt an `window`, nicht am Panel, und wird sauber
  entfernt — ohne Cleanup bliebe nach dem Schließen ein Listener, der in die Liste zurückspringt.
  (b) `SubagentStatusGlyph` liest den Animationsmodus **selbst** (`useAnimationMode()`, Zeile 45)
  statt sich auf `MotionConfig reducedMotion` zu verlassen: laut Quellkommentar
  (`motion-dom/dist/cjs/index.js`, `shouldReduceMotion` an genau zwei Stellen — ~3753 für
  `positionalKeys` bei x/y/scale/rotate und ~8997 für Layout-Animationen) greift `repeat: Infinity`
  mit der Einstellung „Off" **nicht**. (c) Das Transkript scrollt nur nach, solange der Nutzer nicht
  selbst gescrollt hat (`followTailRef`, Abstand < 80px, `:120-128`).
- **Ort**: `components/SubagentPanel.tsx:39-70` (Statusglyphe), `:120-166` (Scrollen, Escape),
  `:180-260` (Detailansicht), `:307-360` (Liste)

---

## 2. Bedienelemente

### TabBar — Tab-Leiste mit Drag-to-Reorder
- **Kann**: Reiter für Dateien, Terminals und den Explorer-Baum. Radix `Tabs` meldet jede Auswahl;
  die Kachel trägt Rahmen, Hintergrund und Schrift (`TAB_CLASS`), radix' eigene Optik (Pille,
  `bg-muted`, `dark:`-Zweifarben) ist zurückgedreht. Der aktive Tab wird bei Bedarf in den
  sichtbaren Bereich gerollt (`scrollIntoView` mit `nearest`, `:139-146`).
- **Tastatur**: Klick, `Enter`/Leertaste, Pfeiltasten des Roving-Focus — alle laufen über
  `Tabs onValueChange` → `onSelectTab` (`TabBar.tsx:243-248`). **Mittlere Maustaste** (`button === 1`)
  schließt den Tab über `onAuxClick` (`:274-279`) und wird per `onMouseDown`/`preventDefault` unterdrückt.
  Ziehen beginnt erst nach **4px** (`DRAG_THRESHOLD_PX`, `:50`) — darunter bleibt es ein Klick.
- **Darf nicht**: (a) **Drag-to-Reorder funktioniert nur, wenn die Prop `onReorder` gesetzt ist.**
  `handlePointerDown` kehrt ohne sie sofort zurück (`:148`), es werden keine Pointer-Handler,
  kein `touch-action` und keine Ziehanimation registriert, und `onClick` wird ebenfalls nicht
  verdrahtet (`:258-260`). Die Leiste sieht dann unverändert aus und der Zug greift nicht.
  Das ist gewollt asymmetrisch: das Fenster im Explorer schaltet es ein (`FileExplorer.tsx:1004`),
  die Leiste im rechten Panel nicht (`AppShell.tsx:2037`) — dort ist die Reihenfolge die
  Reihenfolge des Öffnens. (b) `onMouseDown` am `TabsTrigger` **muss** `preventDefault()` setzen,
  wenn `onReorder` gesetzt ist (`:288-290`): radix' `composeEventHandlers` lässt seine eigene
  Auswahl genau dann aus. (c) Der abschließende Klick muss verschluckt werden
  (`swallowClickRef`, `:118-122`, `:257-262`): die Auswahl ist genau das, was der Nutzer mit dem
  Zug vermieden hat; das Flag wird bei jedem neuen `pointerdown` zurückgesetzt, damit es nie in
  den nächsten Klick hineinragt. (d) `min-w-0` am Trigger ist Pflicht (`:97-101`), sonst wählt
  der Trigger seine Mindestbreite aus dem Text und `truncate` greift nie. (e) Die mittlere Maustaste
  darf nicht mit dem Ziehen mitlaufen — sonst schließt jeder Zug den Tab.
- **Ort**: `components/TabBar.tsx:50` (Schwelle), `:56-78` (`onReorder`-Vertrag), `:148-221`
  (Zuglogik), `:239-337` (Render)

### TerminalViewer — Terminal-Fläche
- **Kann**: xterm-Fläche mit Kopfzeile (Statuspunkt, Terminal-ID, „type a command and press Enter")
  und Status-Badge unten rechts.
- **Tastatur**: Eingabe geht 1:1 an den Prozess; der Terminal-Viewer selbst hat **keinen**
  eigenen `keydown`-Handler. `Enter` wird als Zeilenabschluss gesendet.
- **Darf nicht**: **Der Badge schimmert nur im Status `connecting`.** `exited` und `error` sind
  Endzustände und benutzen ein **einfaches `div`**, keinen `Shimmer` (`TerminalViewer.tsx:210-249`).
  Vorher wusch auch ein beendetes Terminal endlos weiter — das war derselbe Fehler wie ein
  klemmender Shimmer, nur durch eine andere Tür, überlebt also einen Fix, der nur den Shimmer
  selbst bereinigt. Die Begründung steht wörtlich im Quelltext.
- **Ort**: `components/TerminalViewer.tsx:180-249`

### TerminalDropdown — Terminal-Menü
- **Kann**: Knopf „Terminal" mit Zähler der laufenden Terminals, Menü zum Öffnen neuer und zum
  Beenden bestehender Terminals.
- **Tastatur**: Der Menü-Knopf ist ein `<button>` mit `aria-haspopup="menu"` und `aria-expanded`
  (`:112-113`) — `Enter`/Leertaste öffnet, ein zweiter Druck schließt. Das Menü selbst
  (`<Enter direction="down" role="menu">`) hat **keinen** eigenen Tastatur-Handler;
  `Escape` zum Schließen ist **nicht** belegt (**unklar**, ob radix' Menü es bereitstellt —
  die Datei benutzt `Enter` aus `motion/`, nicht `ui/dropdown-menu`, es gibt also keinen
  DismissableLayer). Der Kill-Knopf (`aria-label="Kill terminal in …"`, `:268`) reagiert auf
  Enter/Leertaste.
- **Darf nicht**: Kein weiterer Hinweis; die Zählerdarstellung `aria-label={`${runningCount} running`}`
  (`:139`) ist Absicht — sie zählt `status === "running"`, nicht offene Terminals.
- **Ort**: `components/TerminalDropdown.tsx:100-152`, `:159-290`

### FileContextMenu — Rechtsklickmenü
- **Kann**: Mehrstufiges Menü (Liste → Umbenennen / Neuer Ordner / Löschen → Zielordner),
  mit Kopieren/Ausschneiden des Pfads in die Zwischenablage.
- **Tastatur**: In Phase `root` übernimmt die **Listenphase selbst** Escape und Klick-daneben über
  ihren `DismissableLayer` (`FileContextMenu.tsx:271-274`). Die Formularphasen liegen **außerhalb**
  davon und brauchen dieselbe Behandlung von Hand: `pointerdown` außerhalb schließt, `Escape`
  schließt nur, wenn der Tastendruck **nicht** im Formular-Panel stand (`:282-287`) — dort heißt
  Escape „zurück zur Liste" und wird ebenda behandelt.
- **Darf nicht**: (a) Die drei Wegweisungs-Events (`pointerdown`, `pointerup`, `click`) werden
  radix **vorenthalten**, solange der Zielordner-Dialog offen ist (Kommentar ab `:296`) — sonst
  liest radix den Dialog als „Klick daneben" und schließt das Menü unter ihm. (b) `preventDefault()`
  auf dem `pointerdown` wird benutzt, um dem `FileExplorer`-Fenster zu signalisieren, dass noch
  etwas offen ist (`data-nested-overlay`, `FileExplorer.tsx:950`).
- **Ort**: `components/FileContextMenu.tsx:271-300`, `:457-463` (Panel-Beschriftung je Phase),
  `:540-640` (Formularphasen)

### FileImagePreview — Bildvorschau
- **Kann**: Bild mit Zoomstufen, Vor/Zurück zwischen Bildern, Download, schließen.
- **Tastatur**: `Escape` schließen, `+`/`=` hineinzoomen, `-`/`_` herauszoomen, `0` = Originalgröße,
  `ArrowRight`/`ArrowLeft` = nächstes/vorheriges Bild (`FileImagePreview.tsx:298-323`, `document`-Listener).
- **Darf nicht**: Das Panel trägt `data-nested-overlay` (`FileExplorer.tsx:490`), weil sein
  Escape sonst zusätzlich das Explorer-Fenster schließen würde.
- **Ort**: `components/FileImagePreview.tsx:298-323`, `:393-545`

### FileBrowserDialog — Dateiauswahl-Dialog
- **Kann**: Verzeichnisbaum mit Krümeln, Sortierung, Listen-/Rasteransicht, Mehrfachauswahl,
  „Dismiss".
- **Tastatur**: `Escape` schließt, sofern nicht gerade `busy` (`:394-398`, `document`-Listener).
  In der Liste: `ArrowDown`/`ArrowUp` bewegen, `Enter`/`ArrowRight` öffnen, `Backspace`/`ArrowLeft`
  eine Ebene zurück, `Home` nach oben (`:455-467`).
- **Darf nicht**: `Escape` prüft `!busy`; während eines laufenden Vorgangs schließt der Dialog nicht.
- **Ort**: `components/FileBrowserDialog.tsx:394-398`, `:455-467`, `:520-630`

### SearchableSelect — Combobox mit Filter
- **Kann**: Textfeld mit Trefferliste, wie die Modellauswahl im `ChatInput`.
- **Tastatur**: `ArrowDown`/`ArrowUp` bewegen, `Enter` wählt, `Escape` schließt, `Tab` geht ins
  nächste Feld (`SearchableSelect.tsx:141-155`, `handleListKeys`).
- **Darf nicht**: `ArrowDown`/`ArrowUp` sind mit `preventDefault()` versehen (`:142-146`), damit
  die Seite nicht scrollt, während die Liste navigiert.
- **Ort**: `components/SearchableSelect.tsx:141-155`, `:166-230`

### MermaidBlock — Diagramm und Zoom-Viewer
- **Kann**: Mermaid-Quelltext rendern, zwischen Quelle und Vorschau umschalten, Zoom-Viewer öffnen.
- **Tastatur**: `Escape` schließt den Viewer (`:147-151`), `onCancel` ebenso (`:143-146`).
  Weitere Zoomtasten: **nur** die Knöpfe (`:162-198`) — **keine** Tastenkürzel im Code.
- **Darf nicht**: While `isStreaming` zeigt der Knopf „Preview after streaming" und ist damit kein
  Umschalter (`:77`).
- **Ort**: `components/MermaidBlock.tsx:77`, `:140-200`

### MessageView — einzelne Nachricht
- **Kann**: Rendert Nutzer- und Agentennachrichten, Copy-Knopf, „edit from here" (Fork), Token-Schätzung,
  Thinking-Block, Diff-Header, Todo-Checkliste, Fehlerbanner.
- **Tastatur**: **Keine eigenen Tastenkürzel.** Copy, Fork und Todo sind `<button>` ohne
  `onKeyDown` — sie reagieren nur auf `Enter`/`Leertaste` über den nativen Klick.
- **Darf nicht**: Der Thinking-Block trägt `aria-label` (`MessageView.tsx:828`) und ist als
  aufklappbar beschriftet — kein Fehler, aber beim Umbau auf `<details>` wäre die Beschriftung weg.
- **Ort**: `components/MessageView.tsx:380-450`, `:655`, `:828`, `:940-941`, `:1210-1255`, `:1431`

### BranchNavigator — Worktree-/Branch-Umschalter
- **Kann**: Liste der Branches/Worktrees eines Projekts, Auswahl erzeugt bzw. wechselt den Worktree.
- **Tastatur**: **Kein eigener `onKeyDown`** im Panel (grep: nur der `title`/`aria-label`-Treffer
  bei `:327-328`, sichtbar „Branches"). Navigation nur per Maus.
- **Darf nicht**: Kein belegter Grund, hier etwas zu schützen — **unklar**, ob die gewünschte
  Tastaturbedienung je existiert hat.
- **Ort**: `components/BranchNavigator.tsx:327-328`

### SystemStatsBadge — CPU/RAM/GPU
- **Kann**: Zeigt Systemlast, Klick öffnet eine Verlaufsanzeige.
- **Tastatur**: **Kein Tastatur-Handler** (grep: nur `role="img"` / `role="dialog"` / `aria-label`).
  Der Verlaufsdialog trägt einen Schließen-Knopf mit `aria-label="Close"` (`:301`), aber keine
  Escape-Bindung.
- **Darf nicht**: `role="img"` mit `aria-label="last 10 seconds"` (`:90-91`) ist die Erklärung
  des Sparkline-Verlaufs, kein Dekor.
- **Ort**: `components/SystemStatsBadge.tsx:90-91`, `:217-301`

### OmpUpdateIndicator — Update-Hinweis
- **Kann**: Zeigt verfügbare Version, Copy-Befehl, Dialog.
- **Tastatur**: `Escape` schließt den Dialog (`OmpUpdateIndicator.tsx:83-90`, `document`-Listener).
- **Darf nicht**: Kein weiterer belegter Punkt.
- **Ort**: `components/OmpUpdateIndicator.tsx:83-90`, `:147-252`

### ExtensionStatusBar — Statuszeile der Erweiterungen
- **Kann**: Einzeilige Statuszeile mit `role="status"`, Beschriftung und Tooltip aus dem Text.
- **Tastatur**: **keine** (kein `onKeyDown` in der Datei).
- **Darf nicht**: `role="status"` plus `title` **und** `aria-label` aus demselben Text
  (`:28-30`) — die Zeile wird von Screenreadern vorgelesen, sie ist kein reines Dekor.
- **Ort**: `components/ExtensionStatusBar.tsx:28-30`

### Login-Seite (`app/login/page.tsx`)
- **Kann**: Anmeldung gegen `/api/web-access/login`; setzt das `httpOnly`-Sitzungscookie und
  leitet mit `replace` auf `/` zurück. Passwort-Auge blendet den Wert um. Link auf `/recover`.
  **Die Beschriftungen sind hartkodiert englisch** (kein Katalogeintrag): „Sign in",
  „Username", „Password", „Show"/"Hide", „Signing in…", „Forgot password?".
- **Tastatur**: `Enter` im Formular = absenden (`<form onSubmit>`). Kein `Escape`.
- **Darf nicht**: (a) **Der Fokus springt nach einem abgelehnten Login zurück ins Passwortfeld**, über
  `useEffect(() => focusPassword(), [focusPassword, rejected])` (`page.tsx:73-75`). `autoFocus`
  funktioniert hier nicht: es feuert während des Commits, und `Reveal` hat zu diesem Zeitpunkt
  `opacity: 0` geschrieben — ein unsichtbares Element bekommt keinen Fokus, der Aufruf wird
  angenommen und der Cursor bleibt auf `body`. (b) **`select()` ist nicht Dekoration**
  (`page.tsx:47-55`): Chrome und Edge setzen den Cursor bei einem autofüllten Passwort ans Ende,
  wer direkt tippt, schreibt sonst in die Mitte des gespeicherten Geheimnisses. (c) Der Effekt
  hängt absichtlich an **nichts**, was sich während des Tippens ändert — `busy`, `error`,
  `password`, `username`, `revealed` dürfen ihn nicht auslösen, sonst kämpft er mit dem Nutzer
  um den Cursor. (d) Der Submit-Knopf ist `key={rejected}` (`:170`): dadurch remountet er bei
  jedem Fehlversuch, die Shake-Animation startet neu **und** der Fokus fällt auf `body` — der
  (a) behebt das nebenbei mit.
- **Ort**: `app/login/page.tsx:47-75`, `:170`, `:143-160` (Passwort-Auge)

### Recover-Seite (`app/recover/page.tsx`)
- **Kann**: Code anfordern und eingeben, Passwort zurücksetzen. Hartkodiert englisch.
- **Tastatur**: `Enter` im Code-Feld schickt ab, wenn `canSubmit` (`:149`).
- **Darf nicht**: Kein weiterer belegter Punkt.
- **Ort**: `app/recover/page.tsx:106-157`

---

## 3. Dialoge

### ProjectTrustDialog
- **Kann**: Fragt, ob dem Projekt vertraut wird; zeigt `cwd` und einen Fehlertext. Knöpfe
  „Cancel" und „Trust project" (bzw. „Trusting…" während `busy`). Beschriftungen aus dem Katalog:
  „Trust this project?" / „Project resources can run local code. Trust only projects whose contents
  you know." / „Cancel" / „Trust project" (`en.ts:462-466`).
- **Tastatur**: **`Escape` schließt den Dialog** — über `onEscapeKeyDown`, das nur bei `busy`
  blockiert (`ProjectTrustDialog.tsx:93-94`, `blockWhileBusy` `:47-49`). **Vorher hatte der Dialog
  gar keine Tastaturschließung** — er war über die Tastatur nicht zu schließen. `Enter`/`Leertaste`
  auf „Trust project" = bestätigen (nativer Button).
- **Darf nicht**: (a) **Rechtsklick und `Strg`/`Cmd`+Linksklick auf den Backdrop schließen diesen
  Dialog nicht — absichtlich.** radix unterbindt das, weil ein Dialog weg soll, den man aus
  Versehen weggeklickt hat. Zwei Ebenen sind dafür nötig, und wer nur eine liest, kommt zu einem
  falschen Schluss:
  - `react-dismissable-layer` feuert `POINTER_DOWN_OUTSIDE` **ohne jede Button-Prüfung**
    (`node_modules/@radix-ui/react-dismissable-layer/dist/index.mjs:240-280`, `handlePointerDown`) —
    die Event-Ebene ist offen.
  - `DialogContentModal` legt darüber seinen **eigenen** Guard
    (`node_modules/@radix-ui/react-dialog/dist/index.mjs:177-183`):
    `const ctrlLeftClick = originalEvent.button === 0 && originalEvent.ctrlKey === true;`
    `const isRightClick = originalEvent.button === 2 || ctrlLeftClick;`
    `if (isRightClick) event.preventDefault();`
  - `composeEventHandlers` (`node_modules/@radix-ui/primitive/dist/index.mjs:6-12`) führt beide
    hintereinander: zuerst der App-Handler, und **nur wenn der nicht selbst prevented hat** der
    radix-Handler. Der Dismissal wird also von radix' `preventDefault` verhindert, nicht von der
    unteren Ebene.

  **(b) `blockWhileBusy` verdrängt diesen Schutz.** `onPointerDownOutside` ist in beiden Dialogen
  mit `blockWhileBusy` belegt (hier `:93-94`, in `DirectoryPicker.tsx:174-176`), und dieses
  `preventDefault()` **nur bei `busy`** ruft. Solange `busy === false`, preventet der App-Handler
  nicht — radix' Rechtsklick-Schutz läuft und greift. Würde dort jemals das bedingte
  `preventDefault` entfallen (etwa weil jemand `blockWhileBusy` durch ein pauschales „immer
  schließen" ersetzt oder die Bedingung vereinfacht), preventet der App-Handler immer — und
  `composeEventHandlers` überspringt radix' eigenen Guard. **Der Dialog wäre dann bei `busy`
  offen für Rechtsklick.** Das ist die Falle: die Absicht „Rechtsklick schließt nicht" hängt an
  einer Bedingung in Anwendungscode, die radix nicht kennt.
  (c) Der Dialog liegt fest auf `z-index: 1100` (`TRUST_Z_INDEX`, `:19`) zwischen den großen
  Overlays (1000–1300), der mobilen Sidebar (200) und dem Kontextmenü (1400); `DialogOverlay`
  **und** `DialogContent` tragen den Wert, weil sie Geschwister sind (`:71-90`). (d) `onCloseAutoFocus`
  ist verhindert und fokust stattdessen das beim Öffnen aktive Element (`:95-98`): radix gäbe den
  Fokus an einen `DialogTrigger` zurück, den es hier nicht gibt (`AppShell` steuert von außen),
  also landete er auf `body`. (d) Das Overlay trägt `supports-backdrop-filter:backdrop-blur-none` (`:23`).
- **Ort**: `components/ProjectTrustDialog.tsx:19-49`, `:60-98`

### DirectoryPicker
- **Kann**: Verzeichnis wählen: Pfadeingabe mit „Go", „Go to parent directory", Liste der
  Unterverzeichnisse und Laufwerke, „Select current directory" bzw. „Select this folder".
  Katalog: „Select directory" / „Go to parent directory" / „Go to directory" / „Select current
  directory" (`en.ts:125-135`).
- **Tastatur**: `Escape` schließt über `onEscapeKeyDown` (blockiert nur bei `busy`, `:174`).
  Das Pfadeingabefeld wird beim Öffnen gefokust **und selektiert** — über `onOpenAutoFocus`
  (`:161-168`), nicht über `autoFocus`: radix setzt sonst auf den X-Knopf in der Kopfzeile, und
  das `autoFocus` aus dem Handcode greift im Portal-Mount nicht. `Enter` im Pfadformular =
  `handlePathSubmit`.
- **Darf nicht**: **Rechtsklick und `Strg`/`Cmd`+Linksklick auf den Backdrop schließen nicht** —
  dieselbe Kette wie im `ProjectTrustDialog`, siehe dort die vollständige Begründung mit den
  Fundstellen `react-dialog:177-183` und `primitive:6-12`. **Und dieselbe Falle:** Das
  `onPointerDownOutside` ist hier `blockWhileBusy` (`:175-176`) und preventet **nur bei `busy`**.
  Solange `busy === false`, preventet der App-Handler nicht, radix' eigener Guard läuft. Entfällt
  dieses bedingte `preventDefault` je — etwa weil `blockWhileBusy` durch ein pauschales „immer
  schließen" ersetzt wird —, überspringt `composeEventHandlers` radix' Guard, weil der
  App-Handler selbst prevented hat. **Der Dialog wäre dann bei `busy` offen für Rechtsklick.**
  (`components/DirectoryPicker.tsx:130-299`, Z-Index `PICKER_Z_INDEX` analog zu 1100)

---

## 4. Einstellungen (`SettingsConfig` und die Abschnitte)

### SettingsConfig — Fenster „Settings"
- **Kann**: Modal mit Seitenleiste und neun Abschnitten: Models, Themes, Skills, Plugins, MCP,
  Access, Accounts, Quick phrases, Animations (`SettingsConfig.tsx:41-49`). Die Beschriftungen
  sind hartkodiert englisch. Skills/Plugins/Accounts tragen `requiresCwd` bzw. `requiresAdmin`
  und werden ohne Projekt bzw. ohne Adminrolle deaktiviert (`:383`).
- **Tastatur**: In den Auswahlknöpfen löst `Enter` `blur()` aus (`:123`), damit der Wert greift.
  Das Fenster selbst: **kein Escape-Handler** (grep: null Treffer für `"Escape"` in der Datei).
  Es ist ein eigenes `role="dialog" aria-modal="true"` (`:377`), kein radix-Dialog.
- **Darf nicht**: Kein weiterer belegter Punkt. Dass das Fenster keinen Escape-Handler hat, ist
  der Zustand — nicht die Absicht, und nicht als Fehler dokumentiert.
- **Ort**: `components/SettingsConfig.tsx:41-49`, `:123`, `:377-383`

### UsersConfig — Abschnitt „Accounts"
- **Kann**: Konten anlegen, deaktivieren, aktivieren, Passwort setzen. Ladezustand
  „Loading accounts…".
- **Tastatur**: **Kein Escape-Handler.** Der Bestätigungsdialog für Deaktivieren/Aktivieren ist
  **inline, kein radix-Dialog** (`:318-320`) und schließt über `onMouseDown` mit
  `target === currentTarget` auf dem Backdrop.
- **Darf nicht**: **Dieser Dialog ist kein radix-Dialog und schließt beim Klick daneben — auch per
  Rechtsklick**, weil er den radix-Guards nicht hat. Das ist keine Inkonsistenz, sondern die
  Entscheidung, dass hier ein *nicht lokalisierbares* `window.confirm` ganz und gar nicht benutzt
  wird; ein Dialog, der sich versehentlich wegklicken lässt, wäre hier schlimmer als der
  mangelnde Schutz. Wer diese Datei auf `ui/dialog` umstellt, **gewinnt** den Rechtsklick-Schutz
  und muss das nicht als Verlust buchen. Die Begründung steht im Quelltext (`:312-315`): `window.confirm` ist im
  Browser nicht lokalisierbar, und ein Abschreiten an der falschen Stelle kostet hier mehr als
  Ärger. Der `target === currentTarget`-Test ist wörtlich zu übernehmen; ein `event.target`-freier
  Vergleich würde beim Klick **in** den Dialog schließen.
- **Ort**: `components/UsersConfig.tsx:158`, `:312-353`

### AccessConfig — Abschnitt „Access"
- **Kann**: Web-Lock einrichten: Benutzername, Passwort, „Require a password"-Schalter,
  Ladezustand „Loading password access…".
- **Tastatur**: `Enter` im Benutzernamefeld speichert den Namen, wenn `canSaveUsername`
  (`:228`); `Enter` im Passwortfeld speichert, wenn `canSavePassword` (`:284`).
- **Darf nicht**: Beide Enter-Handler sind an **je eine Bedingung** gebunden, nicht nur an
  Enter. Ein pauschales `preventDefault()` ohne `canSave*` würde ein unvollständiges Formular
  "speichern".
- **Ort**: `components/AccessConfig.tsx:144`, `:199`, `:228`, `:284`

### AnimationsConfig — Abschnitt „Animations"
- **Kann**: Wählt den Animationsmodus (`off` / reduziert / voll). Die Auswahl steuert
  `useAnimationPreference()` und damit **jede** Oberfläche der App im laufenden Betrieb.
- **Tastatur**: Auswahlknöpfe mit `aria-label={option.label}` (`:63`), keine eigene Tastenbindung
  — Auswahl per Enter/Leertaste als native Buttons.
- **Darf nicht**: **Dieser Schalter ist die einzige Bedienung, die eine noch schimmernde Fläche
  zur Laufzeit erreicht.** Genau deshalb ist die Shimmer-Implementierung so gebaut, dass „Off"
  *sofort* alles aufgeräumt: `useShimmerProps` liefert bei `off` eine **leere** Klassenliste
  (`motion/hooks.ts:135-141`), die Regel `.omp-shimmer` deklariert Verlauf **und** Animation
  zusammen, und es gibt keinen Inline-`backgroundImage` mehr, der zurückbleiben könnte. Vorher
  hinterließ der geteilte Zustand eingefrorene Flächen: am AppShell-„Opening workspace"-Panel mit
  vorab gewähltem „Off" bei `background-position: 0% 0%`, bei Umschalten mitten im Shimmer bei
  `-9% 0%` — in beiden Fällen `animationName: none` und trotzdem `el.style.backgroundImage` gefüllt.
- **Ort**: `components/AnimationsConfig.tsx:60-70`, `components/motion/hooks.ts:135-141`

### ModelsConfig / ModelRolesPanel / SkillsConfig / PluginsConfig / QuickPhrasesConfig
- **Kann**: Provider- und API-Key-Verwaltung mit Verbindungs-Test und OAuth-Login (Codeserver),
  Rollenzuweisung pro Modell, Skill- und Plugin-Verwaltung mit Suche und Installation, Kurzwortphrasen.
- **Tastatur**: `Enter` im OAuth-Code-Feld reicht den Code ein (`ModelsConfig.tsx:1385`); `Enter`
  im API-Key-Feld speichert (`:1540`); `Escape` schließt den Dialog (`:1697`). Skill-Suche: `Enter`
  löst die Suche aus (`SkillsConfig.tsx:477-478`). Plugin-Quelltext: `Enter` installiert, nur wenn
  Quelle nicht leer und nicht `busy` (`PluginsConfig.tsx:385-386`).
- **Darf nicht**: Der Plugin-`Enter` ist an `!busy` **und** an eine nicht leere Quelle gebunden
  (`PluginsConfig.tsx:385`) — ein unbedingtes `Enter` würde parallele Installationen starten.
  Kein weiterer belegter Punkt für die übrigen.
- **Ort**: `components/ModelsConfig.tsx:1385`, `:1540`, `:1697`, `:260-271`;
  `components/ModelRolesPanel.tsx:244-272`;
  `components/SkillsConfig.tsx:477-478`; `components/PluginsConfig.tsx:385-386`;
  `components/QuickPhrasesConfig.tsx:170-176`

---

## 5. Bausteine in `components/ui/**` — nach Zweck gruppiert

34 Dateien. **Nur neun werden tatsächlich importiert** (`grep` über `components/*.tsx` und `app/**`):

| Baustein | Importiert von |
|---|---|
| `dialog.tsx` (2×) | `ProjectTrustDialog.tsx`, `DirectoryPicker.tsx` |
| `context-menu.tsx` | `FileContextMenu.tsx` |
| `tabs.tsx` | `TabBar.tsx` |
| `separator.tsx` | `AppShell.tsx` |
| `tooltip.tsx` | `app/layout.tsx` (`TooltipProvider`) |
| `button.tsx` | über `dialog.tsx` |
| `input.tsx`, `field.tsx` | `ChatInput.tsx` |
| `kbd.tsx` | `ChatInput.tsx` (`<Kbd>` in Slash-/`@`-Menüs) |
| `badge.tsx` | `ModelsConfig.tsx` |

Die übrigen 25 sind **im aktuellen Stand ungenutzt** und existieren als Vorrat: `alert-dialog`,
`avatar`, `button-group`, `card`, `checkbox`, `combobox`, `command`, `drawer`, `dropdown-menu`,
`empty`, `hover-card`, `input-group`, `label`, `scroll-area`, `select`, `sheet`, `sidebar`,
`skeleton`, `slider`, `sonner`, `spinner`, `switch`, `table`, `textarea`.

### Was die genutzten Bausteine für die Oberfläche bedeutet
- **Kann**: `dialog` liefert Overlay, Portal, Fokusfalle, `Escape` und `onOpenAutoFocus` /
  `onCloseAutoFocus`; `tabs` liefert den Roving-Focus der Tab-Leiste; `separator` den Griff mit
  Tabindex; `tooltip` den Provider global in `app/layout.tsx`; `context-menu` den
  DismissableLayer, der Escape und Klick-daneben behandelt.
- **Tastatur**: `tabs` — Pfeiltasten, `Home`/`End` plus `Enter`/`Leertaste`; `dialog` — `Escape`,
  `Tab`-Fokusfalle; `context-menu` — `Escape` in der Listenphase.
- **Darf nicht**: (a) **`context-menu` und `dialog` behandeln Klick-daneben über einen
  DismissableLayer, der nach `event.button` nicht filtert** (`node_modules/@radix-ui/react-dismissable-layer/dist/index.mjs:240-280`) —
  die *Event-Ebene* ist also offen. **Bei `dialog` liegt darüber aber eine zweite Ebene, die den
  Button prüft und genau deshalb schließt der Rechtsklick nicht:**
  `DialogContentModal` setzt `onPointerDownOutside` per `composeEventHandlers(props.onPointerDownOutside, …)`
  (`node_modules/@radix-ui/react-dialog/dist/index.mjs:177-183`) und darin
  `isRightClick = originalEvent.button === 2 || ctrlLeftClick` → `event.preventDefault()`.
  `composeEventHandlers` (`node_modules/@radix-ui/primitive/dist/index.mjs:6-12`) ruft zuerst den
  App-Handler und **nur wenn der nicht selbst prevented hat** den radix-Handler. Ablauf für einen
  Rechtsklick auf den Backdrop: (1) `dismissable-layer` feuert `POINTER_DOWN_OUTSIDE` ohne
  Button-Prüfung; (2) `DialogContentModal` hängt seinen eigenen Handler darüber; (3) radix sieht
  `button === 2` und preventet; (4) erst das verhindert den Dismissal. Wer **nur**
  `dismissable-layer` liest, findet dort keine Button-Prüfung und schließt daraus fälschlich, dass
  Rechtsklick schließt — die untere Schicht stimmt für sich allein, ist aber nicht die ganze Kette.
  **Nach derselben Regel gilt: `button === 2` und `Strg`/`Cmd`+Linksklick schließen einen
  `ui/dialog`-Dialog nicht.** (b) `dialog.tsx`
  rendert einen eigenen Close-X mit hartkodiertem `<span className="sr-only">Close</span>`
  (`:86`). Beide Dialoge schalten ihn mit `showCloseButton={false}` ab und bringen ihren eigenen
  Knopf mit — das ist Absicht, kein Versehen. (c) `tabbar.tsx` dreht radix' eigene Optik der
  Trigger zurück; wer `TRIGGER_CLASS` auflöst, bekommt Pille und `bg-muted` zurück
  (`TabBar.tsx:96-101`). (d) **Der ungenutzte Vorrat darf nicht als „tote Dateien" gelöscht werden**,
  solange niemand geprüft hat, ob er geplant ist — die `sidebar.tsx` kollidiert vom Namen her mit
  der handgebauten `components/ui` nicht, aber `drawer`/`sheet` sind Mobil-Pendants zu noch nicht
  umgestellten Panels. **unklar**: ob der Vorrat bewusst ist.

---

## 6. Zwei Funktionen, die nicht zusammengelegt werden dürfen

### Shimmer — Endlos-Wash auf wartenden Flächen
- **Kann**: Ein von links nach rechts wandernder Lichtband, auf Flächen, die **tatsächlich noch
  warten**. Benutzt an: „Opening workspace" (`AppShell.tsx:1933`), Agent-Phase und laufendes
  Kommando (`ChatWindow.tsx:738-754`), Terminal-Badge nur bei `connecting` (`TerminalViewer.tsx:220`),
  sowie als Basis von `Skeleton`.
- **Tastatur**: keine.
- **Darf nicht**: Shimmer und Sweep sind **verschiedene Funktionen**. Der Shimmer ist die ganze
  Wirkung und liegt deshalb in **einer** CSS-Regel `.omp-shimmer` in `globals.css`, die Verlauf
  **und** `omp-shimmer-wash` zusammen deklariert; `useShimmerProps` liefert bei Modus „off" eine
  leere Klassenliste. Es gibt bewusst **kein** Inline-`backgroundImage` mehr. `radius` hat
  absichtlich **keinen** Default, damit die Radius-Regel des Aufrufers erhalten bleibt
  (`motion/Shimmer.tsx:29-33`). Die Dauer reist als Custom Property `--omp-shimmer-duration`,
  damit `SHIMMER_DURATION` die einzige Fundstelle der Zahl bleibt, und sie ist der **ganze Zyklus**
  (Lauf + Pause), nicht der Lauf allein.
- **Ort**: `components/motion/Shimmer.tsx:29-45`, `components/motion/hooks.ts:88-141`

### Sweep — Einmal-Wash beim Aufpoppen
- **Kann**: Dasselbe Band, **einmal**, beim Erscheinen eines Panels. Benutzt von `Reveal`, `Enter`
  und dem Login-Schild.
- **Tastatur**: keine.
- **Darf nicht**: (a) **Nicht als `{...sweep}` hinter ein `animate`-Prop spreaden** — ein Spread
  ersetzt das ganze Objekt statt zu mergen, wodurch die eigene `opacity: 1` des Panels
  verschwindet und das Element bei `initial.opacity = 0` stehenbleibt. Stattdessen merged der
  Aufrufer die Keyframes und gibt `backgroundPosition` einen eigenen wertabhängigen Übergang
  (`motion/hooks.ts:45-62`). (b) **`backgroundRepeat: "no-repeat"` ist die tragende Zeile**, und
  sie ist als Literal typisiert, damit ihr Wegfallen ein Compile-Fehler ist. Ohne sie füllt die
  Nachbarkachel die Lücke hinter dem wegziehenden Band: die Kachel ist 220 % des Elements und
  malt unter `repeat` [0.22, 1.98] Elementbreiten, die Lücke beträgt 2 × 0.10 × 220pp = 44pp,
  das Elementfenster aber 100pp — **ein 100pp-Fenster passt in keine 44pp-Lücke**, es gibt also
  unter `repeat` gar keine Position, auf der das Element leer ist. Gemessen:
  `+220 %` → 100 % bemalt (Peak 0.69997) bzw. 0 % unter `no-repeat`; `-220 %` → 56 % (Peak 0.30028)
  bzw. 0 % (`motion/hooks.ts:180-195`). (c) Die Reise muss auf Positionen enden, die **nichts
  bemalen**: `220 % → -220 %` verbrachte 209 von 440 Prozentpunkten auf nichts; `190 % → -90 %`
  hält beide Enden leer mit ~25pp Reserve und hebt den sichtbaren Durchlauf auf 505 von 720 ms.
  `0% 0%` — die Ruhelage vor jedem Lauf — bemalt unter `no-repeat` noch 78 % bei Peak 0.6894
  (`:203-215`). (d) `repeat: 0` und die Keyframes liegen **im Memo**, nicht darüber: motion
  behandelt ein neues `animate`-Objekt als neue Animation und würde den Sweep bei jedem Render
  neu starten.
- **Ort**: `components/motion/hooks.ts:151-225`, `components/motion/Reveal.tsx:26`,
  `components/motion/Enter.tsx:41`, `:76`

---

## 7. Zusammenfassung der Handarbeit

- **Panels**: 9 (`AppShell`, `SessionSidebar`, `ChatWindow`, `ChatInput`, `FileExplorer`,
  `FileViewer`, `SubagentPanel`, Login, Settings-Fenster)
- **Bedienelemente einzeln beschrieben**: 27
- **Dialoge einzeln**: 3 (`ProjectTrustDialog`, `DirectoryPicker`, der Inline-Bestätigungsdialog
  in `UsersConfig`) plus 7 Dialoge mit je eigener Tastaturbindung (Datei-Auswahl, Bildvorschau,
  Systemverlauf, Update, Mermaid-Zoom, Subagent-Detail, OAuth in `ModelsConfig`)
- **Bausteine**: 34 Dateien, davon 9 importiert, 25 ungenutzter Vorrat

### Nicht erreichbar / nicht belegbar

| Punkt | Grund |
|---|---|
| **Deutsche Beschriftungen** | Es gibt nur `en` und `zh-CN` (`lib/i18n/registry.ts:35-36`). Ich habe die englischen Katalogwerte genannt. |
| **„Rechtsklick/Strg-Klick schließt den Dialog nicht"** | **Belegt, zwei Ebenen.** `dismissable-layer` feuert `POINTER_DOWN_OUTSIDE` ohne Button-Prüfung (`index.mjs:240-280`); darüber prüft `DialogContentModal` `button === 2 || (button === 0 && ctrlKey)` und preventet (`react-dialog:177-183`), und `composeEventHandlers` (`primitive:6-12`) führt radix' Handler nur, wenn der App-Handler nicht selbst prevented hat. Details im Dialog-Abschnitt. |
| **„ProjectTrustDialog hat jetzt Escape, vorher keines"** | Die **Gegenwart** ist belegt (`onEscapeKeyDown` → `onOpenChange(false)` → `onCancel`, `ProjectTrustDialog.tsx:93`, `:65-68`). Die **Vergangenheit** ist im Repository nicht belegbar — ich habe keine Historie ausgewertet. |
| **`TerminalDropdown` Escape** | **unklar.** Die Datei benutzt `Enter` aus `motion/`, nicht `ui/dropdown-menu`; es gibt keinen DismissableLayer und keinen Tastatur-Handler. |
| **`BranchNavigator`, `SystemStatsBadge`, `ExtensionStatusBar`, `MessageView`** | Keine eigenen Tastaturkürzel im Code — nicht geraten. |
| **Historisches Verhalten** | „Vorher/nachher"-Aussagen sind nur dort belegt, wo der Quelltext sie selbst als Kommentar trägt (Shimmer/Sweep, Tab-`onReorder`, `autoFocus`, `select()`, `onReorder`-Asymmetrie). Alles andere habe ich als gegenwärtigen Zustand notiert, nicht als Vergleich. |