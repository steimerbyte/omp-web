# Projects-Feature — Spezifikation

Stand 2026-10-21, Commit `ed92611` auf `main`. Deployed auf agent-pc und in der Produktion verifiziert.

Dieses Dokument beschreibt, was ausgeliefert ist. Es ist keine Planung und kein Arbeitsbericht. Der Plan, gegen den die Umsetzung gebaut wurde, steht in `docs/plans/projects-dashboard-plan.md` und sagt zu Recht „Status: Plan, nicht implementiert“ — dieses Dokument ersetzt ihn nicht, es beschreibt das Ergebnis.

Jede Aussage hier ist am Code belegt und mit Datei:Zeile belegt. Wo eine Angabe nicht am Code prüfbar war, steht sie in Kapitel 9 als offener Punkt.

---

## 1. Status

Ausgeliefert ist:

- die Dashboard-Ansicht selbst (Kopfzeile, Kategorie-Chips mit Suche, Kartenraster nach Kategorie, Dialog für Anlegen, Dialog für Löschen),
- eine Registry pro Konto, in der die Projekte und die Kategorienamen liegen,
- die API-Routen `GET/PUT/POST /api/projects` und `GET/DELETE /api/projects/[...root]`,
- die Anbindung an die Seitenleiste und den Datei-Explorer,
- die Layout-Korrekturen, die in Kapitel 5 beschrieben sind.

Der Stand ist Commit `ed92611` auf `main`. Der Commit ist deployed auf agent-pc und in der Produktion.

Es gab zwei getrennte Messserien, mit zwei verschiedenen Chromium-Builds:

- Die **lokale Serie** lief unter WSL2 mit Chromium 1237 gegen einen Produktionsbuild, der lokal aus dem Repo gebaut wurde. Sie umfasste alle vier Viewports (390x844, 320x800, 768x1024, 1440x900) und liefert die Viewport-Matrix aus Kapitel 5: die 141px und 28 Knöpfe, die 53px und 7 Knöpfe, die 191px, die zwölf Kombinationen mit Delta 0.0, die 38px, die 76px→114px. Die Bidi-Zahlen aus 5.2 (x=533.1 gegen x=302.1) nennt das CHANGELOG, das den Build dieser Messung nicht angibt; sie stehen deshalb ohne Build-Angabe dort.
- Die **Produktionsmessung** lief auf agent-pc gegen `https://omp.steimercloud.xyz` mit Chromium 1243, bei 390x844 und einer Desktop-Gegenprobe bei 1440x900. Aus ihr stammen die Negativkontrolle des Einstellungsfensters (unten) und der Befund, dass die Korrektur im Produktivbetrieb trägt.

Die beiden Serien sind nicht dasselbe, und ihre Zahlen werden nicht vermischt: 1440x900 und 768x1024 kommen aus der lokalen Serie, nicht aus der Produktion.

Die Regeln wurden gegen den Vorzustand geprüft, in zwei getrennten Negativproben mit unterschiedlicher Beweiskraft:

- Die **CSS-Negativprobe** ist ein Test-Nachweis. In `components/SettingsConfig.layout.test.mjs` wurde die Deklaration `grid-template-rows` entfernt und durch andere Formen ersetzt (`auto`, `minmax(auto, 1fr)`, die festen 967px, ein Mobile-Block mit `auto`). Je Fall das Ergebnis: 1 pass, 1 FAIL; beim korrekten Wert `minmax(0, 1fr)` dagegen 2 pass, 0 fail. Der Test erkennt den Fehler also.
- Die **Browser-Negativkontrolle** wurde in der Produktion ausgeführt. Die alte Regel `grid-template-rows: auto` wurde clientseitig in die laufende Seite injiziert. Ergebnis: Zeile 967px gegen `clientHeight` 826px, fünf Knöpfe ohne scrollbaren Vorfahren, nach dem Scrollen aller Container noch zwölf unterhalb der Fensterunterkante, der Tasks-Knopf nicht mehr `fullyVisible`, und `elementFromPoint` traf wieder das Backdrop statt des Knopfes. Der Detektor schlug also an, im Browser, gegen den Produktivbetrieb.

Kapitel 9 benennt, was offen ist. Der wichtigste offene Punkt ist die Wartezeit von `GET /api/projects`; er gehört dort und nicht hierher.

---

## 2. Was ein Projekt ist

### Der Ordnerpfad ist das Projekt

Ein Projekt ist ein Ordner. Der absolute Pfad ist der Primärschlüssel (`lib/projects-schema.ts:80`, Feld `root`). Es gibt im Dashboard keinen Git-Ableitungs-Mechanismus: Git ist ein Attribut des Ordners, nicht seine Identität.

Das ist eine bewusste Abweichung von der Sitzungs-Logik. `resolveProject()` (`lib/worktree.ts:77`) leitet ein Projekt aus `git rev-parse --git-common-dir` ab, sodass alle Worktrees eines Repos ein `projectRoot` teilen und ein Verzeichnis ohne Git sein eigenes Projekt ist. Das ist das richtige Modell für die Frage „wo gehört eine Sitzung hin“. Es kann „Projekt löschen löscht diesen Ordner“ nicht ausdrücken, weil ein Repository mehrere Ordner umfasst. Die Begründung steht im Kopf von `lib/projects-schema.ts:12-20`.

### Die Registry pro Konto

Datei: `omp-web-projects.json` (`lib/projects-store.ts:21`).

Der Pfad ergibt sich aus `getProjectsPath(identity)` (`lib/projects-store.ts:29-31`) über `resolveTenantAgentDir(identity)` (`lib/tenant-config.ts:48-51`):

- für ein Administratorkonto: das globale Agent-Verzeichnis (`getAgentDir()`),
- für ein Mandantenkonto: `<home>/<name>/.omp/agent`.

Wer schreibt: ausschließlich der Server. `writeProjectsFile` (`lib/projects-store.ts:78-85`) schreibt atomar über `writePrivateFileAtomicSync`, Dateimodus `0o600`, Verzeichnis `0o700`. Der Browser schreibt die Datei nie; er schickt Patches an `PUT /api/projects`.

Der Zugriff ist pro Konto: `isProjectsPathAllowed` (`lib/projects-store.ts:43-45`) prüft, dass der fertige Pfad unter `getUserHome(identity)` liegt. Das ist die zweite Schicht — `resolveTenantAgentDir` ist die Herleitung, diese Prüfung ist die Zulassung, und sie fängt ein Konto, dessen `OMP_WEB_HOME_ROOT` ins Fremde zeigt.

Ein beschädigter Inhalt liest sich als leere, aber existierende Registry (`lib/projects-store.ts:60-67`), und wird dabei nicht überschrieben. Ein Seed über einen beschädigten Stand würde Arbeit zerstören, die der Nutzer weder sehen noch verteidigen kann.

### Prioritäten

Die fünf Kategorien und ihre Ids sind fest: `now`, `important`, `later`, `done`, `parked` (`lib/projects-schema.ts:33`). Die Ids sind die Sortordnung, nicht nur ein Schwellenwert.

Die Namen kommen aus der Registry des Kontos (`priorities[].name`, `lib/projects-schema.ts:63-68`). Sie sind pro Konto umbenennbar: `mergePriorityPatches` (`lib/projects-schema.ts:484-511`) übernimmt einen neuen Namen, behält aber `id` und `colorValue` — ein Konto darf eine Kategorie umbenennen, nicht neu einfärben und nicht umsortieren. `PUT /api/projects` ruft das in `app/api/projects/route.ts:261` auf. Der Test dafür ist „a client can rename a category but not repaint or reorder it“ (`app/api/projects/route.test.mjs:231`).

Der Erstlauf-Fallback sind `DEFAULT_PRIORITIES` (`lib/projects-schema.ts:153-159`): „Sofort“, „Wichtig“, „Nice to have“, „Erledigt“, „Unwichtig“. Sie werden geschrieben, wenn das Konto noch keine Registry hat (`loadOrAdopt`, `app/api/projects/route.ts:79-89`). Die i18n-Bundles tragen keinen Kategorienamen (`lib/i18n/messages/en.ts:75-119`); der einzige Ort, an dem ein Name feststeht, ist diese Default-Liste.

Die ausgelieferte Oberfläche bietet keine Bedienung zum Umbenennen. Die Fähigkeit liegt in der Registry und in `PUT /api/projects`; ein Umbenennen-Dialog ist nicht Teil des ausgelieferten Standes. Die Karten und Chips zeigen, was die Registry hält (`components/projects/ProjectCard.tsx:62-70`, `components/projects/PriorityFilterBar.tsx:97-112`).

### Was eine ProjectView ist

`ProjectView` (`lib/projects-schema.ts:119-141`) ist die gespeicherte Metadatenzeile plus allem, was aus der Sitzungsliste und vom Dateisystem ableitbar ist. Die Karte kennt:

| Feld | Woher |
|---|---|
| `root` (Pfad) | Registry, Primärschlüssel (`lib/projects-schema.ts:80`) |
| `name` | `basename(root)`, `projectDisplayName` (`lib/projects-schema.ts:288-292`), gesetzt in `app/api/projects/route.ts:135` |
| `priority` | Registry (`lib/projects-schema.ts:82`) |
| `openTodos` (Todos) | Registry, ein Zähler, kein Array (`lib/projects-schema.ts:87`) |
| `chatCount` | Zählung der Sitzungen dieses Kontos mit diesem `projectRoot`/`cwd` (`app/api/projects/route.ts:102-115`) |
| `sizeBytes` (Größe) | `du -sb` je Ordner, `lib/project-size.ts:71-93`; das Feld liegt in der Registry (`lib/projects-schema.ts:103`) |
| `branch` | `resolveProject(root)`, `app/api/projects/route.ts:131`; `null` bei einem Ordner ohne Repository |
| `isGit` | `branch !== null \|\| isWorktree` (`app/api/projects/route.ts:138`) |
| `lastActivityAt` | das spätere von `lastTouchedAt` und `lastSessionAt` (`app/api/projects/route.ts:123-126`) |
| `status` | Ampel, `lib/projects-schema.ts:43`; unabhängig von der Priorität |
| `isProtected` | Serverantwort auf `isProtectedProjectRoot(root, getUserHome(identity))` (`app/api/projects/route.ts:146`) |

Ein Feld, das sich neu berechnen lässt, wird nicht gespeichert. `chatCount`, `branch`, `lastSessionAt` und `name` stehen deshalb in `ProjectView` und nicht in `ProjectMeta` (`lib/projects-schema.ts:73-77`).

---

## 3. API-Oberfläche

Die Registry ist pro Konto. Es gibt dort kein `requireAdmin`, weil ein Konto sein eigenes Dashboard verwaltet; die Begründung steht im Kopf von `app/api/projects/route.ts:48-59`. `requireAdmin` bleibt dort stehen, wo etwas hostweit verändert wird — dazu Kapitel 7.

### GET /api/projects

Zweck: die Registry lesen, mit allem ableitbaren, und die Sichtbarkeit auf dieses Konto einschränken.

Reihenfolge der Guards:

1. `isApiRequestAllowed(req)` (`app/api/projects/route.ts:174`) — Herkunft des Requests, vor allem anderen. Antwort: `403 Untrusted API request`.
2. `requireIdentity(req)` (`app/api/projects/route.ts:177`, Definition `:61-69`) — `getRequestIdentity` (`lib/request-identity.ts:40`) und danach `isProjectsPathAllowed(identity, getProjectsPath(identity))`. Antwort: `403 Access denied`.

Danach: `loadOrAdopt` (`:192`), die Größenmessung (`:199-209`), `buildProjectViews` (`:211`) und die Sichtbarkeitsfilterung über `isVisibleTo` (`:162-171`, `:212-216`).

Fehler: `403` für beide Guard-Fälle, `500 Unable to read projects` bei einem unerwarteten Fehler (`:223-225`).

Antwort: `{ projects, priorities, home }` (`:218-222`).

### PUT /api/projects

Zweck: einen Zähler, eine Kategorie, eine Statusfarbe oder einen Kategorienamen ändern.

Reihenfolge der Guards: `isApiRequestAllowed` (`:229`), `requireIdentity` (`:232`), `hasJsonContentType` (`:236`, `lib/request-security.ts:121`) — Antwort `415 Content-Type must be application/json`.

Es ist ein Merge, kein Replace (`app/api/projects/route.ts:249-262`, `mergeProjectPatches` in `lib/projects-schema.ts:433-475`). `root`, `createdAt`, `adopted` und der Größencache gehören dem Server; ein Client kann sie nicht setzen (`lib/projects-schema.ts:404-418`). Ein Projekt, das der Client weglässt, wird nicht gelöscht, sondern behält seinen Eintrag — der Test heißt „omitting a project does not delete it“ (`app/api/projects/route.test.mjs:211`).

Antwort: der validierte Zustand, nicht die ungeprüfte Eingabe des Clients (`:267`).

### POST /api/projects

Zweck: ein Projekt anlegen, und das ist genau: einen Ordner anlegen.

Reihenfolge der Guards und Prüfungen:

1. `isApiRequestAllowed` (`:319`),
2. `requireIdentity` (`:322`),
3. `hasJsonContentType` (`:326`),
4. Namensprüfung `isValidProjectFolderName` (`:337`, `lib/projects-schema.ts:272-285`) — vor dem Zusammenfügen des Pfades. `400`,
5. Pfadprüfung `isPathWithinRoots` gegen `<home>/workspace` (`:351`) — `403`,
6. Schutzprüfung `isProtectedProjectRoot(root, home)` (`:369`) — `403` mit `code: "protected"`,
7. Existenzprüfung (`:389`) — `409` mit `code: "exists"`,
8. erst dann `mkdirSync` (`:396`).

Der Name wird vor dem Pfad geprüft, der Pfad vor dem Anlegen, weil eine Ablehnung, die nach einem `mkdir` kommt, eine Ablehnung ist, die etwas gekostet hat. Ein bereits existierender Ordner wird abgelehnt statt übernommen: `mkdirSync({recursive:true})` würde stillschweigend Erfolg haben, und ein stillschweigend übernommener `~/Documents` bekäme einen unumkehrbaren Lösch-Knopf (`:304-311`).

`initRepository` läuft nur, wenn der Client es verlangt hat (`:402-404`).

### GET /api/projects/[...root]

Zweck: die Vorschau, was ein Löschen zerstören würde, bevor danach gefragt wird.

Dieselben Guards in derselben Reihenfolge wie das Löschen: `isApiRequestAllowed` (`:182`), `requireIdentity` (`:185`), `protectedRootReason` (`:197`), `isWritePathAllowed` (`:205`).

Antwort: `{ root, sessionCount, sessionIds, entryCount, entriesTruncated, requiresConfirmation }` (`:210`). `400` bei ungültigem Root, `403` bei geschütztem Ordner oder fehlender Schreibberechtigung.

### DELETE /api/projects/[...root]

Zweck: ein Projekt mit seinem Ordner und seinen Chats löschen.

Reihenfolge:

1. `isApiRequestAllowed` (`:223`),
2. `requireIdentity` (`:226`, Definition `:79-83`),
3. `normalizeProjectRoot(filePathFromSegments(segments))` (`:241`) — `400`,
4. `protectedRootReason(root, getUserHome(identity))` (`:257`) — `403` mit `code: "protected"` und dem konkreten Grund,
5. `isWritePathAllowed(root, { mustExist: true }, identity)` (`:268`) — `403`,
6. Vorschau `buildPreview` (`:279`),
7. Bestätigung, wenn nötig (`:281-310`),
8. alle Sitzungen löschen (`:324-348`),
9. den Ordner über den `file-actions`-Handler löschen (`:351`),
10. den Registry-Eintrag zuletzt entfernen (`:368-374`).

Schritt 4 läuft vor dem ersten Schreibzugriff. Eine Ablehnung dort kostet keinen einzigen Chat. Der Test heißt „the protection check runs before the write-allowlist and before the session scan“ (`app/api/projects/delete-route.test.mjs:178`).

Schritt 8 delegiert an `DELETE /api/sessions/[id]`, Schritt 9 an `DELETE /api/file-actions/[...path]`, mit weitergereichten Identitäts-Headern (`:94-100`). Die Guards dieser Handler laufen dadurch unverändert mit, einschließlich `requireSessionAccess` (`app/api/sessions/[id]/route.ts:31`). Eine zweite Implementierung des Löschens wäre eine zweite Sache, die falsch sein kann.

Fehler: `409 confirmation-required`, wenn ab zehn Chats keine Bestätigung mitkommt (Schwelle `DELETE_CONFIRMATION_CHAT_THRESHOLD = 10`, `lib/projects-delete.ts:380`); `409 confirmation-stale`, wenn sich die Zahl zwischen Vorschau und Bestätigung geändert hat; `409 session-delete-failed`, wenn ein Chat-Löschen scheitert — dann bleibt der Ordner unangetastet.

### Welche Route die Dateien des Projekts bedient

`/api/files/[...path]` für Lesen, Auflisten, Hochladen und Herunterladen (`components/FileExplorer.tsx:305`); `/api/file-actions/[...path]` für Schreiboperationen (`components/FileExplorer.tsx:2895`, `:2936`). Beide arbeiten gegen die Allowlist, nicht gegen die Registry.

Die Dashboard-Routen selbst liefern keine Dateien aus. Ein Projekt öffnen heißt: den Cwd der Shell auf den Projektordner setzen (Kapitel 4); danach bedient der Explorer den Ordner über die Datei-Routen.

---

## 4. Die Ansicht

### Ein Zustand in AppShell, kein Router-Pfad

`activeView` ist ein `useState` in `AppShell` (`components/AppShell.tsx:179-181`), gesät aus `?view=`. Die Ansicht ist eine Eigenschaft der Shell, kein Pfad.

Der aktuelle Zustand: `const showProjects = activeView === "projects";` (`components/AppShell.tsx:1085`).

Der ursprüngliche Fehler war `activeView === "projects" && !showChat`. `showChat` (`components/AppShell.tsx:1053`) ist `selectedSession !== null || effectiveNewSessionCwd !== null` — und die Seitenleiste adoptiert beim ersten Laden selbst einen Cwd (`getRecentProjects → setSelectedCwd → onCwdChange`). `showChat` ist im Normalbetrieb also dauerhaft wahr, und die Bedingung machte den Zweig unerreichbar, während der Knopf in der Seitenleiste, der den Zustand direkt bekommt (`showProjectsDashboard={activeView === "projects"}`, `components/AppShell.tsx:1179`), den Knopf trotzdem als gedrückt zeichnete. Die Begründung steht in `components/AppShell.tsx:1059-1084`.

Damit das nicht geschieht, hängt die Ansicht an `activeView` allein. Die drei Zustände sind eine exklusive Verzweigung, keine Schichtung: `{showProjects ? <ProjectsDashboard … /> : showChat ? <ChatWindow … /> : …}` (`components/AppShell.tsx:2019-2027`). Solange das Dashboard steht, ist der Chat **nicht montiert** — es gibt keine zweite Ebene, die darunter weiterläuft, und kein Overlay. Der Weg zurück in den Chat ist explizit: `handleSelectSession`, `handleNewSession` und `handleCwdChange` schalten die Ansicht selbst (`components/AppShell.tsx:1083-1084`).

### Was der Wechsel der Ansicht mit dem Chat macht

Weil die Verzweigung exklusiv ist, wird `ChatWindow` beim Wechsel auf das Dashboard unmounted und beim Zurückwechseln neu montiert. Das ist eine vertraglich relevante Eigenschaft, keine Nebensache: wer das nicht weiß, hält den Zustandsverlust beim Viewwechsel für einen Randfall, den man nicht beachten muss.

Was den Unmount überlebt, ist das, was außerhalb der Komponente liegt:

- der **Text im Eingabefeld** überlebt. `ChatInput` führt ihn zwar in `useState` (`components/ChatInput.tsx:469`), spiegelt ihn aber bei jeder Änderung in einen modulweiten Entwurfsspeicher (`lib/draft-store.ts`), geschlüsselt nach der Session-Id (`components/ChatInput.tsx:796-802`, Schlüssel in `components/ChatWindow.tsx:430`). Beim nächsten Mount liest `ChatInput` den Entwurf wieder ein (`components/ChatInput.tsx:469`).
- der **Verlauf** überlebt ebenfalls, aber nicht aus dem React-Zustand: er wird beim Mount neu vom Server geladen (`hooks/useAgentSession.ts:2097-2099` → `loadSession`, `hooks/useAgentSession.ts:498`).

Was den Unmount **nicht** überlebt, ist der Zustand innerhalb von `ChatWindow`:

- die **Scrollposition der Nachrichtenliste** geht verloren. Der Scrollcontainer ist ein DOM-Knoten der unmounteten Komponente (`components/ChatWindow.tsx:573`), und beim nächsten Mount springt die Liste wieder nach unten (`hooks/useAgentSession.ts:2195-2200`).
- die **schrittweise nachgeladenen älteren Nachrichten** gehen ebenfalls verloren: der Zähler `visibleCount` beginnt wieder bei der ersten Seite (`components/ChatWindow.tsx:266`).

Der Beweis dafür steht im Test: solange das Dashboard montiert ist, existiert der Composer des Chats nicht im DOM (`components/AppShell.projects-view.test.mjs:254-269`, `:281`).

### Der URL-Parameter

`?view=projects` steht per `replaceState` in der URL (`components/AppShell.tsx:1091-1096`), nicht per Router-Navigation. Eine Router-Navigation liefe den Server-Komponenten-Baum neu an und remountete die ganze Shell — die geladene Projektliste ginge dabei verloren. Der Wert wird beim ersten Paint gelesen (`lib/initial-navigation.ts:15-24`); nur der exakte Wert `projects` zählt, jeder andere fällt auf `chat` zurück, damit eine unbekannte View-Namen-Zeichenkette keine View auswählen kann.

Der Test dafür ist „the dashboard button keeps ?view=projects in the URL“ (`components/AppShell.projects-view.test.mjs:286`).

### Seitenleiste und Datei-Explorer

Die Seitenleiste hat einen eigenen Knopf, der `setActiveView("projects")` aufruft (`components/AppShell.tsx:1178`, `components/SessionSidebar.tsx:1215-1220`). Er liest `activeView` direkt und nicht `showProjects`.

Der automatische Erstlauf-Cwd der Seitenleiste wird abgeschaltet, wenn die URL die Projektansicht nennt (`skipInitialProjectSelection`, `components/AppShell.tsx:197-198`). Ohne das würde die automatische Adoption über `handleCwdChange` die Ansicht verlassen — der Weg zurück in den Chat wäre also ein Nebeneffekt der Adoption und keine bewusste Entscheidung.

Ein Projekt öffnen heißt: zurück in den Chat und den Cwd auf den Projektordner setzen (`components/AppShell.tsx:2022-2024`). Ab dort behandelt die Shell den Ordner wie jeden anderen Cwd — die Seitenleiste zeigt ihn, der Explorer listet ihn, und der Explorer selbst ist über `handleOpenFile` (`components/AppShell.tsx:1172`) erreichbar. Das Dashboard hält keine eigene Dateiliste.

---

## 5. Layout-Invarianten

Jede Invariante nennt die Aussage, die Zahl, die Messung und den Test, der sie hält. Die Zahlen sind gemessen, nicht geschätzt.

### 5.1 Das Einstellungsfenster bindet seine Grid-Zeile an die Box

Aussage: `.window` ist `display: grid` mit `grid-template-columns`, und seine einzige Zeile hängt an der Box, nicht am Inhalt. Die Regel ist `grid-template-rows: minmax(0, 1fr)` (`components/SettingsConfig.module.css:35`).

Ohne die Regel entsteht genau eine implizite Zeile mit `auto`, und `auto` misst sich am Inhalt. Gemessen 2026-10-21 in der lokalen Serie (Chromium 1237 unter WSL2, lokal gebauter Produktionsbuild), Models-Abschnitt offen (`components/SettingsConfig.module.css:23-28`):

| Viewport | `grid-template-rows` | `clientHeight` | abgeschnitten | Knöpfe unterhalb der Fensterunterkante |
|---|---|---|---|---|
| 390x844 | 967px | 826px | 141px | 28 |
| 1440x900 | 910.5px | 858px | 53px | 7 |

Die Zahl der Knöpfe hängt von der Belegung des Fensters ab. Die 28 sind die Belegung mit dem Models-Abschnitt offen; in derselben Sitzung kam bei einer zweiten Messung vor der Änderung 39 heraus, bei anderer Belegung. Die 28 stehen im Kommentar in `components/SettingsConfig.module.css:25` und im CHANGELOG, die 39 in einem Messprotokoll dieser Sitzung. Eine Knopfzahl ohne ihren Kontext ist eine Zahl, die beim nächsten Nachmessen nicht mehr aufgeht.

`overflow: hidden` schneidet still ab, ohne Scrollbalken: `.content` meldet `scrollHeight == clientHeight` und hält sich für vollständig. `document.elementFromPoint` auf einem der betroffenen Knöpfe traf den Backdrop statt des Knopfes.

Nach der Regel misst dieselbe Seite 826px bzw. 858px, `.content` endet exakt auf der Fensterunterkante, 0 Knöpfe liegen darunter, das Fenster selbst scrollt nicht (`clientHeight == scrollHeight`) und die Navigation scrollt intern.

`min-height: 0` auf `.sidebar` und `.nav` ist ausdrücklich nicht nötig. Beide sind Grid-Items auf einer begrenzten Zeile und werden darauf gestreckt; `.nav` (flex: 1, `overflow-y: auto`) misst danach `clientHeight` 730 gegen `scrollHeight` 871 und scrollt. Ein zusätzliches `min-height: 0` dort änderte nichts Messbares (`components/SettingsConfig.module.css:31-34`). Diese Begründung steht hier, weil `min-height: 0` auf Flex-Items die naheliegende Scheinlösung ist und am Ende eine Regel mehr ist, die nichts trägt.

Test: `components/SettingsConfig.layout.test.mjs`. Er prüft die Deklaration, nicht die Geometrie, weil jsdom keine Geometrie rechnet. Der Test unterscheidet dabei eine *begrenzte* Zeile (`minmax(0, 1fr)`, `1fr`) von jeder Form, die den Fehler reproduziert: fehlend, `auto`, feste Länge, `min-content`/`max-content`, `minmax(auto, 1fr)`, `minmax(180px, 1fr)` (`components/SettingsConfig.layout.test.mjs:71-101`).

### 5.2 Der Pfad auf der Karte

Aussage: der Pfad wird am Anfang gekürzt, damit das projektidentifizierende Ende sichtbar bleibt, und die Glyphen behalten ihre Reihenfolge.

Der Container trägt `direction: rtl` (`components/projects/ProjectCard.tsx:177`). Das ist der Grund für die Kürzung am Anfang, und derselbe Container dreht die Reihenfolge neutraler Zeichen. Gemessen 2026-10-21 in Chromium: der führende `/` wurde ans Zeilenende gemalt, bei x=533.1 gegenüber x=302.1 für das `h` — rund 231px versetzt (CHANGELOG v0.11.0, „Layout“). Jede Karte in jedem Viewport las `home/steimmerbyte/workspace/omp-web/`.

Der Pfadtext liegt in `<bdi dir="ltr">` (`components/projects/ProjectCard.tsx:195`). Der Pfad ist damit ein eigenes linksläufiges Isolat: die Glyphen behalten ihre Reihenfolge, während der Container weiter am Anfang kürzt. Nach der Änderung liest der Pfad visuell wie logisch, mit führendem Slash links; das sichtbare Stück ist ein zusammenhängender Teilstring des logischen Textes in richtiger Reihenfolge und dessen Suffix — der Teil, der das Projekt identifiziert, bleibt stehen (CHANGELOG v0.11.0).

Steuerzeichen sind ausgeschlossen. Ein LEFT-TO-RIGHT MARK (U+200E) als Präfix rendert identisch und war der erste Kandidat; es wurde verworfen, weil es ein unsichtbares Zeichen im Quelltext ist und in alles kopiert, was der Nutzer aus der Karte markiert.

Test: `components/projects/ProjectCard.path-order.test.mjs:175-230`. Er hält beide Hälften fest: die Box bleibt RTL (sonst wandert die Kürzung ans Ende), das Isolat bleibt LTR (sonst dreht sich die Reihenfolge zurück), und der Text trägt kein Bidi-Steuerzeichen (`:224-227`).

### 5.3 Skelett und echtes Raster benutzen eine Regel

Aussage: beide Raster fragen dieselbe Spaltenregel ab.

`CARD_GRID_TEMPLATE = "repeat(auto-fill, minmax(258px, 1fr))"` (`components/projects/ProjectGrid.tsx:24`), benutzt vom echten Raster (`:142`) und vom Skelett (`:198`).

Vorher fragte das Skelett `repeat(3, minmax(0, 1fr))` und das echte Raster `auto-fill`. Bei 390x844 sprang das Raster von drei 106px-Spalten auf eine 342px-Spalte; bei 768x1024 von 3 × 145.3px auf 1 × 460px, bei 1440x900 von 3 × 369.3px auf 4 × 274px (CHANGELOG v0.11.0).

`auto-fill` und nicht `auto-fit`: `auto-fit` lässt die leeren Spuren zusammenfallen, sodass eine Gruppe mit zwei Karten in einem vierspaltigen Raster diese zwei über die ganze Breite streckt. Die Kartengröße hinge dann von der Gruppenzahl ab.

Test: `components/projects/ProjectCard.path-order.test.mjs:232-299`. Die Assertion vergleicht die beiden erzeugten `grid-template-columns`-Strings und schließt eine feste Spaltenzahl aus (`:265-277`).

### 5.4 Die Kategorie-Chips liegen in einem Streifen

Aussage: die Leiste ist eine Zeile, unabhängig von den Daten.

Der Streifen trägt `flex-wrap: nowrap` (`components/projects/PriorityFilterBar.tsx:88`) und `overflow-x: auto` (`components/projects/PriorityFilterBar.module.css:21`).

Vorher wuchs die Leiste von 76px auf 114px, als die Chips eintrafen, und schob die erste Karte um 38px nach unten (Commit `ed92611`; `components/projects/PriorityFilterBar.tsx:62-66`).

Nachher: 38px konstant, Delta 0.0 in allen zwölf Kombinationen aus vier Viewports (390x844, 320x800, 768x1024, 1440x900) und drei Kategoriezahlen (1, 3, 5). Höhe der Leiste, Position des Suchfelds und Position der ersten Karte waren in allen zwölf Kombinationen vor und nach dem Laden identisch.

Warum `nowrap` und nicht eine Reserve: die Kategorienamen kommen aus der Registry des Kontos und sind pro Konto umbenennbar. Zur Ladezeit sind sie unbekannt. Eine Reserve auf Default-Namen wäre eine Reserve auf einer Annahme über Daten. Eine Reserve mit unsichtbaren Chips ergänzt 90px Leere, die dauerhaft sichtbar ist. Der Streifen entkoppelt die Höhe von der Datenmenge.

Ein Chip ohne Projekt wird gar nicht gerendert (`components/projects/PriorityFilterBar.tsx:103`). Der Streifen fängt die Differenz auf; ein reservierter Platz wäre ein permanenter Zwischenraum für einen Chip, den niemand benutzt.

Die Bildlaufleiste ist ausgeblendet (`scrollbar-width: none`, `components/projects/PriorityFilterBar.module.css:24-30`). Eine sichtbare Leiste hätte beim Erscheinen 15px Layout-Höhe genommen — ein Sprung derselben Art.

Tests: `components/projects/ProjectCard.path-order.test.mjs:342-413` hält `flex-wrap: nowrap` fest und dass ein Chip ohne Projekt nicht gerendert wird. Der Streifen als eigener Knoten wird über die Struktur geprüft, nicht über einen Klassennamen — jsdom löst kein Stylesheet auf, eine Klassen-Assertion prüfte nur einen String.

### 5.5 Die Kopfzeile zählt keine Nullen, während die Anfrage läuft

Aussage: `projectCount` ist vor der Antwort keine Null, sondern keine Zahl.

Die Kopfzeile zeigt während des Ladens einen Platzhalter (`components/projects/DashboardTopbar.tsx:61-68`) statt „0 Projekte · 0 Chats“. Der Platzhalter liegt in einem `inline-flex`-Wrapper, weil ein Platzhalter auf Blockebene die Zeilenbox zusammenfallen lässt und der Header 8px verliert: der Text gibt 81.5px, ein Blockkind 73.5px, der Wrapper 81.5px (`components/projects/DashboardTopbar.tsx:63-65`).

Test: `components/projects/ProjectCard.path-order.test.mjs:300-340` — die Kopfzeile nennt im Ladezustand keine Null und im geladenen Zustand die echte Zahl.

### 5.6 Die Kartenhöhe ist eine Konstante

`PROJECT_CARD_HEIGHT = 191` (`components/projects/ProjectCard.tsx:27`). Die Karte trägt es als `min-height` (`components/projects/ProjectCard.tsx:110`), das Grid importiert dieselbe Konstante für den Platzhalter (`components/projects/ProjectGrid.tsx:45`, `:206`).

Gemessen 2026-10-21 bei 390x844, 320x800, 768x1024 und 1440x900: 191px, alle vier (`components/projects/ProjectCard.tsx:21-25`).

`min-height` und nicht `height`, damit die Karte wachsen kann, wenn ihr Inhalt es irgendwann verlangt. Jede Zeile in der Karte ist `white-space: nowrap`, deshalb ist die natürliche Höhe überall gleich.

Test: `components/projects/ProjectCard.path-order.test.mjs:279-297` — der Platzhalter reserviert dieselbe Höhe, die die Karte deklariert. Die Zahl wird zur Laufzeit aus dem Modul gelesen, nicht im Test festgeschrieben.

### 5.7 Der Datei-Explorer im Popup-Fenster

Aussage: auf schmalen Viewports nimmt der Explorer den Platz, den er hat, und nicht den, den sein Inhalt braucht.

Im `@media (max-width: 640px)`-Block bekommt `.explorer` `flex: 1 1 auto`, `width: 100%`, `min-height: 0` und keinen `border-bottom` (`components/FileExplorerWindow.module.css:387-393`).

Der Abschnitt war vorher inhaltsgroß (`flex: 0 0 auto`, `max-height: 40vh`), also hing seine Höhe an der Höhe des Baums — und der Baum misst seine eigene Höhe gegen den scrollenden Vorfahren (`measure()` in `components/FileExplorer.tsx`). Das war eine Rückkopplung, die bei `TREE_MIN_HEIGHT = 120` (`components/FileExplorer.tsx:1451`) endete: fünf Zeilen sichtbar, der Rest abgeschnitten, und der Rahmen des Abschnitts fiel mitten in die sechste Zeile. Beim Navigieren sprang die Zeile mit, weil die Ladezustandszeilen eine andere Höhe haben als die geladenen.

Der Kommentar, der das beschreibt, steht in `components/FileExplorerWindow.module.css:365-381`.

---

## 6. Der mobile Vertrag

Geprüft werden vier Viewports: 390x844 als Hauptfall, 320x800 als untere Grenze, 768x1024 und 1440x900 als Gegenprobe. Die Viewports stehen an den Stellen, an denen die Messungen festgehalten sind: `components/projects/ProjectCard.tsx:23` (Kartenhöhe), `components/projects/PriorityFilterBar.tsx:63-66` (Chip-Leiste), `components/SettingsConfig.module.css:23-28` (Einstellungsfenster).

Der Grund für die untere Grenze: 320px ist die schmalste Breite, auf der das Layout noch lesbar sein soll, und der Grund für die Gegenprobe bei 1440x900: die Fehlerklasse dieser Defekte ist auf schmalen Viewports entstanden. Ein Layoutfehler, der nur bei 1440px sichtbar wird, wäre eine andere Fehlerklasse.

Beide Defekte aus den Kapiteln 5.1 und 5.7 waren ausschließlich schmal sichtbar. Das Einstellungsfenster schnitt bei 390x844 141px ab und bei 1440x900 53px — beide Zahlen sind vorhanden, aber der schmale Fall ist der, in dem die betroffenen Bedienelemente (die Reasoning-Selektoren und die Navigationseinträge am Fuß der Seitenleiste) unterhalb des Fensters lagen. Es lohnt sich also, am Telefon zu messen: die Fehlerklasse tritt dort auf.

Der Chip-Streifen ist auf dem Telefon der Normalfall. In der lokalen Serie vom 2026-10-21 bei 390x844 belegten fünf Chips zusammen 551px, sichtbar blieben rund 342px — die Bildlaufleiste ist dort also die Regel und nicht die Ausnahme. Diese beiden Zahlen stehen in keinem Repository-Artefakt; sie stammen aus der Browser-Messung dieser Sitzung und sind nicht nachreproduzierbar.

---

## 7. Sicherheitsgrenzen

### Die Registry ist pro Konto

Ein Konto verwaltet sein eigenes Dashboard. In den Projektrouten gibt es deshalb kein `requireAdmin`; die Begründung steht im Kopf von `app/api/projects/route.ts:48-59`. Der Kommentar nennt auch den Grund, warum der Guard nicht inline gebaut ist: am 12.10.2026 übersprang eine Route ihren Guard mit dem Kommentar, der Proxy decke es ab — genau diese Lücke hat das Passwortschloss abgeschaltet.

Die Tests halten beides fest: „the route requires an identity but not an admin role“ (`app/api/projects/route.test.mjs:345`) und „PUT requires an identity, not an admin role“ (`:373`).

### Wo `requireAdmin` trotzdem gilt

Für hostweite Änderungen. `requireAdmin` (`lib/request-identity.ts:84`) ist die Rolle, die dort verlangt wird. `allowFileRoot` ist prozessweiter Zustand: eine Freigabe, die ein Konto macht, erweitert das Dateisystem für alle Betreiber im Prozess, dauerhaft (`AGENTS.md`, Abschnitt „File access allow-list“). Deshalb ist der Weg über `allowFileRoot` admin-gegatet, und deshalb ist auch der Knopf „Neues Projekt“ im Dashboard nur für Konten sichtbar, die ihn benutzen dürfen (`components/ProjectsDashboard.tsx:208`, `components/projects/DashboardTopbar.tsx:37-42`).

In `POST /api/projects` ist dieser Teil ausdrücklich: `if (isAdminIdentity(identity)) { allowFileRoot(root, identity); }` (`app/api/projects/route.ts:439-441`) — mit der Identität als Argument, damit die Freigabe nicht im unattributed-Bucket landet.

### Der Schreibpfad

Die Reihenfolge im Schreibpfad ist die Grenze: `isApiRequestAllowed` → `requireIdentity` → `hasJsonContentType` → Namensprüfung → Pfadprüfung → Schutzprüfung → Existenzprüfung → erst dann der Schreibzugriff (`app/api/projects/route.ts:276-292`).

Die Pfadprüfung läuft vor dem Anlegen eines Ordners. `isProtectedProjectRoot` fragt das *Kind*, nicht `<home>/workspace` mit — die Tiefen-1-Regel aus `lib/projects-delete.ts` schützt jedes Verzeichnis direkt unter dem Home, und der Workspace wäre damit selbst geschützt, was jedes Projekt blockieren würde, das diese Route anlegen soll (`app/api/projects/route.ts:359-368`).

`isProtectedProjectRoot` (`lib/projects-delete.ts:269-323`) verweigert:

- das Dateisystem-Wurzelverzeichnis und die Home selbst,
- jeden Pfad, der durch ein `.omp`-Segment läuft, und die aufgelösten omp-Laufzeitverzeichnisse (`lib/projects-delete.ts:149-211`) — für jede Identität, auch für ein Administratorkonto, dessen Home `/` ist,
- Vorfahren der Home und jedes fremde Home-Verzeichnis,
- Systemverzeichnisse (`/etc`, `/usr`, `/var`, …) und deren Unterverzeichnisse (`lib/projects-delete.ts:75-94`),
- jedes Verzeichnis in Tiefe 1 unter der Home.

Begründung und der Vorfall, der sie geprägt hat, stehen in `lib/projects-delete.ts:14-65`.

Für das übrige gilt `docs/authentication.md` (Identitäten, Passwortschloss, Admin-Rollen) und `docs/project-trust.md` (Trust-Gate für ausführbare Projekt-Ressourcen). Deren Inhalt wird hier nicht wiederholt.

---

## 8. Wie Projekte gefunden und gelöscht werden

### Finden

Ein Projekt kommt in die Registry auf zwei Wegen:

- **Übernahme.** Beim ersten GET eines Kontos ohne Registry werden die Wurzeln aus der Sitzungsliste dieses Kontos übernommen (`loadOrAdopt`, `app/api/projects/route.ts:79-89`; `adoptProjects`, `lib/projects-store.ts:98-121`). Die Übernahme ist konservativ: bestehende Einträge werden nie angefasst, ein übernommenes Projekt startet in der niedrigsten Priorität und ist als `adopted` markiert, damit die Oberfläche sagen kann, dass es abgeleitet und nicht gewählt wurde. Die Übernahme läuft nur, solange es keine Datei gibt. Eine leere Registry ist eine Entscheidung des Nutzers („alle Projekte gelöscht“) und überlebt den Reload.
- **Anlegen.** `POST /api/projects` legt den Ordner an und schreibt den Eintrag (`app/api/projects/route.ts:396-434`).

Was sichtbar ist, entscheidet `isVisibleTo` (`app/api/projects/route.ts:162-171`): ein Ordner, der nicht unter den erlaubten Wurzeln dieses Kontos liegt, wird ausgeblendet, nicht verweigert. Ein 403 würde bestätigen, dass dort etwas existiert.

Der Git-Status kommt als Attribut dazu, nicht als Identität: `resolveProject(project.root)` (`app/api/projects/route.ts:131`) liefert Branch und Worktree-Status. Ein Ordner ohne Repository löst sich zu sich selbst auf, mit `branch: null` — das ist die Zeile „kein Repo“ auf der Karte.

### Löschen

Das Löschen ist eine Route, keine Folge von Browser-Requests: `DELETE /api/projects/[...root]` (`app/api/projects/[...root]/route.ts:219-383`). Die Reihenfolge steht im Kopfkommentar derselben Datei (`:41-76`): Schutzprüfung vor jedem Schreibzugriff, dann alle Sitzungen, dann der Ordner über den `file-actions`-Handler, dann der Registry-Eintrag.

Die Vorschau zählt vorher, was ginge: `buildPreview` (`app/api/projects/[...root]/route.ts:136-151`) zählt die Sitzungen im Ordner und darunter und die Dateieinträge unterhalb des Ordners, begrenzt auf `PREVIEW_MAX_ENTRIES = 200_000` (`lib/projects-delete.ts:392`).

Ab zehn Chats verweigert die Route das Löschen, bis der Aufrufer die Zahl wiederholt, die der Server selbst gezählt hat (`x-omp-delete-confirm`, `app/api/projects/[...root]/route.ts:163-168`). Ein Boolean würde nur beweisen, dass etwas geklickt wurde; die Zahl beweist, dass der Aufrufer die Zahl 130 in der Hand hatte, als er klickte.

Die Schutzregeln selbst stehen in `lib/projects-delete.ts` und sind dort getestet (`lib/projects-delete.test.mjs`).

---

## 9. Offene Punkte

### Der wichtigste: `GET /api/projects` misst die Ordngrößen synchron

`GET /api/projects` misst die Größe jedes Projekts mit `du -sb`, bevor es antwortet. Acht Projekte parallel, 10s je Projekt (`SIZE_TIMEOUT_MS = 10_000`, `MAX_PARALLEL = 8`, `lib/project-size.ts:33-43`). Im schlimmsten Fall kostet die Anfrage `ceil(n / 8) * 10s`.

Gemessen 2026-10-21 lokal, gegen den lokalen Dev-Server: 30,7s bei 18 Projekten und 210 Chats, davon ein Projekt mit 2,7 GB. Zwei Karten zeigten „Size unavailable“ (`lib/i18n/messages/en.ts:103`). Diese Zahlen stehen in keinem Repository-Artefakt; sie stammen aus der Browser-Messung dieser Sitzung und sind nicht nachreproduzierbar. In der Produktion wurde die Wartezeit nicht nachgemessen.

Das Board sieht während der Wartezeit inzwischen gleich aus — es wartet aber weiterhin. Nichts in diesem Stand verkürzt die Wartezeit; die Messung aus dem Request herauszunehmen ist eine eigene Arbeit. Die Messung wird erst wiederholt, wenn der Cache älter als `SIZE_TTL_MS = 30_000` ist (`lib/projects-schema.ts:146`, `lib/projects-schema.ts:546-554`).

### Weitere offene Punkte

- Die geteilte Ansicht (Datei-Panel offen) wurde nicht gemessen. `CARD_HEIGHT` ist dort ungemessen.
- Der Chip-Streifen wurde nicht an einem echten Touchgerät getestet, nur am Renderer. Obwohl die Scrolleigenschaften im Code stehen, ist die tatsächliche Wischgeste nicht belegt.
- Umbenannte Kategorienamen wurden nicht gegen den Streifen gemessen, weil das Schreiben einer Registry mit umbenannten Namen auf diesem Host nicht zulässig war. Der Streifen ist davon unabhängig: `nowrap` heißt, die Namen können die Zeilenzahl nicht mehr beeinflussen, nur die Scrolldistanz.
- Die Bidi-Auflösung ist nicht auf einem echten Windows-Browser gegengeprüft. Die Messung, auf der die Korrektur in 5.2 beruht, stammt aus Chromium; welcher Build das war, steht im CHANGELOG nicht. Ein zweiter Browser blieb ungeprüft.
- Chromium `headless_shell` in der lokalen Serie unter WSL2, nicht iOS und nicht Safari.
- Es ist nicht gemessen, wie ein Konto mit einer anderen Registry-Datei als dem Standard-Pfad reagiert. Die Pfadprüfung (`isProjectsPathAllowed`) ist getestet, das Verhalten eines abweichenden Speicherorts im Betrieb nicht.

Diese Punkte betreffen die Spezifikation selbst. Befunde, die bewusst nicht behoben wurden, stehen in `docs/known-findings.md` und gehören dort.

---

## 10. Test-Karte

| Datei | Was sie hält |
|---|---|
| `components/projects/ProjectCard.path-order.test.mjs` | Pfad-Reihenfolge im RTL-Kasten und das LTR-Isolat, keine Bidi-Steuerzeichen (`:175-230`); Skelett und echtes Raster nennen dieselbe Spaltenregel (`:232-299`); die Kopfzeile nennt im Ladezustand keine Null (`:300-340`); der Chip-Streifen kann nicht umbrechen (`:342-413`) |
| `components/SettingsConfig.layout.test.mjs` | `.window` bindet seine Grid-Zeile an die Fensterhöhe (`:103-123`); die schmale Viewport-Überschreibung kann die Zeile nicht wieder weiten (`:125-148`) |
| `components/AppShell.projects-view.test.mjs` | `?view=projects` rendert das Dashboard auch, wenn eine Sitzung da ist (`:254-269`); es überlebt die automatische Cwd-Adoption der Seitenleiste (`:271-284`); der Knopf hält `?view=projects` in der URL (`:286-297`); ohne den Parameter gewinnt der Chat (`:299-311`) |
| `app/api/projects/route.test.mjs` | Identität statt Admin-Rolle, 415 ohne JSON, 400 bei ungültigem Body, kein Rewrite von `root`/`createdAt`/`adopted`, Weglassen löscht nicht, Umbenennen ja aber kein Umfärben, Erzeugen eines Ordners samt Ablehnung eines existierenden (`:70-632`) |
| `app/api/projects/delete-route.test.mjs` | Schutzprüfung vor jedem Schreibzugriff, 403 ohne Identität, Traversal erreicht keinen geschützten Ordner, Abbruch beim Fehlschlag eines Chat-Löschens, Vorschau und Bestätigungsschwelle (`:108-560`) |
| `lib/projects-delete.test.mjs` | die Schutzregeln selbst, segmentweise statt als String-Präfix, und die Tiefe, bei der Projekte beginnen (`:34-336`) |
| `lib/projects-store.test.mjs` | Registry pro Konto, Pfad in der eigenen Home, `null` ist nicht „leer“, beschädigter Inhalt wird nicht überschrieben, atomares Schreiben, Übernahme idempotent (`:49-217`) |
| `lib/project-size.test.mjs` | `null` statt `0`, Shell-Metazeichen und führender Bindestrich werden nicht ausgeführt, Gleichzeitigkeitsgrenze und Budget (`:38-171`) |

### Was kein Test hält, und warum

Drei Invarianten haben keinen Test, weil sie im JSDOM nicht messbar sind:

- die Position der ersten Karte,
- die Höhe des Chip-Streifens,
- die Geometrie des Einstellungsfensters.

JSDOM rechnet keine Geometrie: keine Zeilenboxen, kein Layout-Engine-Ergebnis, keine Bidi-Auflösung. Diese drei sind Browser-Messungen und wurden in Chromium gemessen, nicht in JSDOM behauptet. Der Test, der die Position der ersten Karte behauptet, wäre schädlicher als kein Test, weil er eine Behauptung über einen Wert trüge, den er nicht messen kann.

Der Kommentar in `components/projects/ProjectCard.path-order.test.mjs:10-48` sagt das ausdrücklich und begründet, warum die Datei trotzdem existiert: beide Defekte entscheiden sich im gerenderten DOM, und das DOM ist der richtige Ort, sie festzuhalten.
