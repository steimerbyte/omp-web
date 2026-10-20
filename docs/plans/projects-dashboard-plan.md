# Projects Dashboard — Umsetzungsplan

Status: Plan, nicht implementiert. Verifiziert gegen den Arbeitsstand vom 2026-10-20.
Verifikation: jede Behauptung der Design-Doku wurde am Code geprüft. Abweichungen sind in
§1 mit Belegstelle markiert.

---

## 1. STATUS der Design-Doku

### 1.1 Bestätigt (am Code verifiziert, korrekt)

| Aussage der Doku | Beleg | Befund |
|---|---|---|
| `resolveProject` leitet Projekt aus Git ab; Worktrees teilen `projectRoot` | `lib/worktree.ts:102-108` | ✅ exakt. `projectRoot: isWorktreeTopLevel ? dirname(commonDir) : cwd` |
| Kommentar ab `worktree.ts:99`: Unterverzeichnisse behalten eigene Projektidentität | `lib/worktree.ts:99-102` | ✅ wortgleich |
| Client-Gruppierung `session.projectRoot ?? session.cwd` | `SessionSidebar.tsx:211`, `:1000`, `:1015` | ✅ drei Fundstellen, nicht nur 965-973 |
| `SessionInfo` hat kein Größen-/Todo-Feld | `lib/types.ts:394-413` | ✅ bestätigt, Feldliste vollständig eingelesen |
| View-Verzweigung ist if/else-Kette, kein Router | `AppShell.tsx:993`, `:997`, `:1918` | ✅ exakt diese Zeilen |
| `?view=` ist neben `?session=`/`?cwd=` im Muster konsistent | `lib/initial-navigation.ts:6-12` | ✅ `getInitialNavigation` liest beide heute |
| `git worktree remove` auf Haupt-Checkout verboten | `lib/worktree.ts` (`removeWorktree`) | ✅ vorhanden |
| Registry-Dateimuster `omp-web-*.json` pro Account | `lib/quick-phrases-store.ts:43`, `:51` | ✅ `STORE_FILE`, `resolveTenantAgentDir(identity)` |
| `lib/quick-phrases.ts` ist fs-/fetch-frei, damit Browser und Route teilen | `lib/quick-phrases.ts:1-25` | ✅ bestätigt, Muster trägt |
| Allowlist ist pro Identity | `lib/write-access.ts:63-70`, Cache-Key `username\0admin|user` | ✅ |
| `/` wird aus dem Write-Set gefiltert | `lib/write-access.ts:95-101` | ✅ inkl. Kommentar "entire write boundary for an admin" |
| `allowFileRoot` ohne Identity → unattributed-Bucket | `lib/allowed-roots.ts:12`, `:38-46` | ✅ korrekt gewarnt |
| `file-actions` DELETE macht `rmSync(recursive)` | `app/api/file-actions/[...path]/route.ts:252` | ✅ vorhanden — Doku korrigierte sich hier selbst richtig |

### 1.2 Widerspricht der Realität — muss korrigiert werden

**W1 — `requireAdmin` ist in `app/api/default-cwd/route.ts` NICHT verwendet.**
Die Doku (Abschnitt 6, Punkt 2) nennt diese Route als Vorbild für
"`requireAdmin` — **nicht** `identity.isAdmin` inline". Der echte Code macht das Gegenteil:

```ts
// app/api/default-cwd/route.ts:4
import { getRequestIdentity, getUserHome, isAdminIdentity } from "@/lib/request-identity";
...
if (isAdminIdentity(identity)) {
  allowFileRoot(dir);        // ohne Identity-Argument
}
```

Das ist exakt das, was die Doku an anderer Stelle verbietet: `isAdminIdentity` inline
**und** `allowFileRoot` ohne Identity-Argument. `default-cwd` ist damit als Vorlage
**unbrauchbar**.

→ **Konsequenz:** Als Vorlage dienen `app/api/updates/route.ts` und
`app/api/auth/api-key/[provider]/route.ts` (beide `requireAdmin(req)` + `hasJsonContentType`),
nicht `default-cwd`. Die inhaltliche Regel der Doku bleibt richtig; nur der Verweis ist falsch.

**W2 — `lib/system-stats-and-anim` existiert nicht.**
Es gibt `app/api/system-stats/route.ts` + `lib/system-resources.ts`, aber die liefern
**Host**-Werte (CPU, RAM, Kerne, GPU) — keine Projektdaten. Die Doku-Aufgabenstellung vermutet
hier irrtümlich einen Bezugspunkt. Für Projekt-Größe existiert im Repo **kein** Helfer:
`grep -rn "du -sb|dirSize|folderSize" lib/ app/ components/` → **keine Treffer**.

→ **Konsequenz:** Der Größen-Cache ist **Neubau**, kein Ausbau. Siehe Schritt 4.

**W3 — `omp-pop-in` / `omp-slide-in-*` existieren als CSS-Klassen nicht mehr.**
`grep` findet sie nur in *Kommentaren* von `components/motion/animations.ts:15`,
`Enter.tsx:13` und `Shimmer.tsx:10` — dort steht ausdrücklich, dass `Enter` sie **ersetzt** hat.
In `app/globals.css` existiert als einzige Animationsklasse `.omp-shimmer`
(Zeile 1607/1644).

→ **Konsequenz:** Wer die Aufgabe umsetzt, darf nicht nach diesen Klassen suchen. Neu
 verwendbar sind `Reveal`, `Enter`, `ModalBackdrop`/`ModalPanel`, `Pressable`, `Skeleton`.

**W4 — `requireIdentity` in der Doku nicht erwähnt, obwohl es das Regelwerk ergänzt.**
`lib/request-identity.ts` exportiert **beide** Guards. `requireIdentity` (401 +
`Cache-Control: no-store`) ist der Guard für "irgendein angemeldetes Konto", `requireAdmin`
für host-weite Änderungen. Für Registry-Schreibzugriffe pro Konto ist `requireIdentity`
die richtige Stufe — `requireAdmin` wäre zu weit (siehe BLOCKER B1).

**W5 — `isApiRequestAllowed` fehlt in der Doku.**
Jede destruktive Route beginnt laut `AGENTS.md:266` mit `isApiRequestAllowed(request)`
(`lib/request-security.ts:112`) **vor** dem Identity-Check. `file-actions` DELETE macht es so
(Zeile 234-236). Die Doku Abschnitt 5/6 nennt nur die Identity-Guards.

### 1.3 BLOCKER (Sicherheitsgrenzen, die die Doku nicht abdeckt)

**B1 — Registry-Schreiben ist host-weit, nicht mandanten-scoped, wenn man `requireAdmin` nimmt.**
Die Doku schlägt für "Neues Projekt" `requireAdmin` vor. Das ist **falsch herum gedacht**:
ein Projekt-Ordner ist kein host-weiter Zustand. `requireAdmin` hieße, ein normaler
Benutzer kann seine eigene Projektliste nicht anlegen. Korrekt ist `requireIdentity` +
Pfadprüfung über `isQuickPhrasesPathAllowed`-Muster (`isPathWithinRoots(path, {getUserHome(identity)})`).

**Umgekehrt gilt aber:** `allowFileRoot()` bei Projektanlage ist eine **dauerhafte
Allowlist-Erweiterung** und gehört nach `AGENTS.md:270` hinter eine Admin-Bedingung — genau
wie in `default-cwd`. Diese Route muss also **beides**: `requireIdentity` für die
Registry, Admin-Bedingung **nur** um den `allowFileRoot`-Grant zu setzen.

**B2 — `~/docker/stacks` als Projekt ist ein Sicherheitsproblem, kein UX-Problem.**
Der Ordner liegt außerhalb des Konto-Home. Für einen Mandanten fällt
`isWritePathAllowed` ohnehin, für den Admin nicht. Ein Löschen dieses Eintrags
löscht produktive Compose-Dateien. Siehe offene Frage F6.

**B3 — Löschen braucht VOR dem Ordner auch das Löschen der Sessions, und die Doku's
Reihenfolge ist richtig — aber unvollständig.** Sie nennt 4 Schritte und lässt aus, dass
`DELETE /api/sessions/[id]` selbst **cascade re-parent** durchführt
(`app/api/sessions/[id]/route.ts:170-197`): Kind-Sessions werden auf den Eltern-Session
umgehängt, indem **jede** `.jsonl` im Verzeichnis gelesen und umgeschrieben wird. Ein
Projektordner mit vielen Chats löst damit pro Löschung Dutzende Dateischreibzugriffe aus.
Funktional korrekt, aber teuer — und es muss vor dem `rmSync` laufen, sonst sind die
umgeschriebenen Dateien weg.

### 1.4 Offene Entscheidungen (Abschnitt 7 der Doku) — mit Empfehlung

| # | Frage | Empfehlung | Begründung |
|---|---|---|---|
| **F1** | Priorität vs. Status: zwei Achsen oder Status sortiert? | **Zwei Achsen behalten.** Priorität sortiert, Status ist Ampel-Dekoration | Der Prototyp zeigt beide gleichzeitig; das ist die aussagekräftigere Ansicht. Eine Achse würde die Karte simpler machen, aber "Erledigt" und "grün" sind eben nicht dasselbe |
| **F2** | Karte flächig einfärben oder nur Statusbalken? | **Nur 3px-Balken links** = **Variante B (flat)** | Variante A (`color-mix(... 14% ...)`) färbt die ganze Karte; bei 4 Karten nebeneinander liest sich das als Rauschen, nicht als Status. Variante B ist auch die, die der Text der Doku ("Prototyp macht das über einen 3px-Statusbalken links") beschreibt — die Doku und Variante A widersprechen sich hier übrigens selbst |
| **F3** | Todos: Zähler mit −/+ oder Checkliste? | **Zähler mit −/+** | Passt zur Kartenhöhe, ein Feld in der Registry, kein zweites Artefakt |
| **F4** | Neues Projekt: immer `~/workspace/` oder freier Elternordner? | **Immer `<home>/workspace/<name>`** | Eine freie Elternwahl ist eine `mkdir`-Verzweigung ohne Mehrwert; `~/workspace` ist der de facto Ort aller echten Projekte |
| **F5** | Größe: echte Ordnerbytes oder Git-Metadaten? | **Echte Bytes via `du -sb`, mit TTL-Cache.** Git-Metadaten (`git count-objects`) als **zweite** Zeile, nicht als Ersatz | Die Karte braucht "wie groß ist das Projekt auf der Platte", weil das die Löschentscheidung beeinflusst. `count-objects` beantwortet eine andere Frage. Falls beide gewünscht: 2 Zeilen, nicht 1 |
| **F6** | `~/docker/stacks` ohne zweite Rückfrage löschbar? | **Nein — harte Sperre im Code, nicht nur im Dialog.** Pfad `/docker/`, `/etc/`, `/usr/`, `/var/`, `~` selbst und alle Tiefen ≤1 unter `~` werden nie gelöscht | Eine UI-Bestätigung ist kein Schutz: derselbe Fehler im Code löscht produktive Compose-Dateien. Die Sperre gehört neben `isWritePathAllowed`, davor |

**Zusätzlich offene Frage, die die Doku nicht stellt (F7):**
**Soll die Projektliste pro Konto getrennt sein?** Die Registry liegt pro `resolveTenantAgentDir(identity)`,
die Ordner sind aber dieselben. Ein Konto könnte also ein Projekt anlegen, das ein anderes
Konto nicht sieht — obwohl beide dieselbe Platte sehen. → Empfehlung: Registry pro Konto
(wie geplant), aber `GET` liefert nur die Projekte, deren `root` für **diese** Identity
überhaupt lesbar ist (`isExistingPathWithinRoots` gegen `getAllowedFileRoots(identity)`).
Sonst sieht ein Konto Pfade, die es nicht öffnen kann.

---

## 2. DATENMODELL

### 2.1 `lib/projects-schema.ts` — NEW, kein `fs`, kein `fetch`

Bewusst getrennt von der Store-Schicht, damit Browser-Bundle und Route dieselbe
Validierung teilen (Muster `lib/quick-phrases.ts`).

```ts
/** Feste Reihenfolge = Sortierreihenfolge. Frei benennbar, nicht frei löschbar. */
export const PRIORITY_IDS = ["now", "important", "later", "done", "parked"] as const;
export type PriorityId = (typeof PRIORITY_IDS)[number];

export type ProjectStatus = "green" | "yellow" | "red";

/** Farbe kommt ausschließlich aus dem Theme — nie als Literal. */
export type PriorityColorToken =
  | "var(--danger)" | "var(--warning)" | "var(--accent)"
  | "var(--success)" | "var(--text-dim)";

export interface PriorityDef {
  id: PriorityId;
  name: string;                 // pro Account umbenennbar
  colorToken: PriorityColorToken;
}

export interface ProjectMeta {
  root: string;                 // absoluter Pfad = Primärschlüssel
  priority: PriorityId;
  openTodos: number;            // Zähler, absichtlich auf 0 setzbar
  status: ProjectStatus;
  createdAt: string;            // ISO
  lastTouchedAt: string;        // ISO, eigene Writes
  /** Aus listAllSessions() übernommen, nicht bewusst angelegt. */
  adopted?: boolean;
  /** Größe in Bytes, TTL-Cache (F5). null = noch nie gemessen. */
  sizeBytes?: number | null;
  sizeMeasuredAt?: string;      // ISO; TTL-Vergleich
}

export interface ProjectsFile {
  schemaVersion: 1;
  projects: ProjectMeta[];
  priorities: PriorityDef[];
}

/** Was GET /api/projects liefert — Meta + abgeleitete Werte. */
export interface ProjectView extends ProjectMeta {
  name: string;                 // basename(root)
  chatCount: number;            // Anzahl Sessions mit cwd === root
  lastSessionAt: string | null; // max(session.modified)
  isGit: boolean;
  branch: string | null;
  /** lastTouchedAt vs. lastSessionAt — angezeigt wird max(beider) */
  lastActivityAt: string;
}
```

**Herkunft jedes Feldes:**

| Feld | Herkunft |
|---|---|
| `root` | Registry; initial aus `session.projectRoot ?? session.cwd` |
| `priority` | Registry; Default `parked` bei Adoption |
| `openTodos` | Registry, manuell. **Keine** Ableitung — `SessionInfo` trägt kein Todo-Feld (`lib/types.ts:394-413`) |
| `status` | Registry, manuell. Bewusst unabhängig von `priority` |
| `createdAt` | Registry |
| `lastTouchedAt` | Registry, nur bei bewusster Aktion |
| `adopted` | Registry, bei Ersterfassung aus `listAllSessions()` |
| `sizeBytes` | `du -sb <root>`, TTL 30 s |
| `name` | `basename(root)` |
| `chatCount` | Anzahl `listAllSessions()`-Einträge mit `cwd === root` |
| `lastSessionAt` | `max(session.modified)` — steht bereits im Listing |
| `isGit`, `branch` | `resolveProject(root)` → `ProjectInfo.isWorktree`/`branch` |
| `lastActivityAt` | `max(lastTouchedAt, lastSessionAt)` |

**Nicht in die Registry** (bewusst abgeleitet, damit sie nicht veralten): `chatCount`,
`lastSessionAt`, `isGit`, `branch`, `name`.

### 2.2 `lib/projects-store.ts` — NEW, fs-Zugriff, Server-only

Spiegelt `lib/quick-phrases-store.ts` exakt:

```ts
const STORE_FILE = "omp-web-projects.json";

export function getProjectsPath(identity: WebIdentity): string {
  return join(resolveTenantAgentDir(identity), STORE_FILE);
}
export function isProjectsPathAllowed(identity: WebIdentity, path: string): boolean {
  return isPathWithinRoots(path, new Set([getUserHome(identity)]));
}
export function readProjectsFile(identity: WebIdentity): { exists: boolean; file: ProjectsFile };
export function writeProjectsFile(identity: WebIdentity, file: ProjectsFile): void;  // atomic, 0o600
```

Schreiben über `writePrivateFileAtomicSync`, Verzeichnis `0o700` — wie `quick-phrases-store.ts:96-100`.

### 2.3 `lib/project-size.ts` — NEW (W2: existiert nicht)

```ts
export function measureProjectSize(root: string): Promise<number | null>;  // du -sb
```
- `execFile("du", ["-sb", root])`, **keine** Shell-Interpolation
- Abbruch nach 10 s (`execFile` `timeout`), Fehler → `null`
- **Vorher** `isWritePathAllowed(root, { mustExist: true }, identity)` — nie einen Pfad
  betreten, der die Identity nicht ohnehin sehen darf

---

## 3. API-ROUTE

Eine Route, wie die Doku vorsieht. Pfad: **`app/api/projects/route.ts`**

**Muster:** `app/api/quick-phrases/route.ts` (GET/PUT, `requireIdentity`-Äquivalent,
Pfad-Guard) + `app/api/updates/route.ts` (Guard-Reihenfolge, `hasJsonContentType`).

### 3.1 `GET /api/projects`

```
1. isApiRequestAllowed(request)                    → 403   (lib/request-security.ts:112)
2. getRequestIdentity(request.headers)             → 403   (kein Header = niemand)
3. isProjectsPathAllowed(identity, path)           → 403   (isPathWithinRoots vs. getUserHome)
4. readProjectsFile(identity)                      → Defaults wenn !exists
5. listAllSessions({ identity })                   → Ableitungen
6. Promise.all über Projekte: measureProjectSize   → nur wenn Cache older than 30s
   → NICHT blockierend: Response sofort, Größe kommt beim zweiten Poll
```

**Antwort:**
```ts
{
  projects: ProjectView[];   // nach priority-Reihenfolge sortiert
  priorities: PriorityDef[];
}
```

**Filter (F7):** Jedes Projekt, dessen `root` nicht unter `getAllowedFileRoots(identity)`
liegt, wird aus der Antwort entfernt — nicht 403, sondern ausgeblendet.

### 3.2 `PUT /api/projects`

```
1. isApiRequestAllowed          → 403
2. requireIdentity(request)     → 401   (NICHT requireAdmin — siehe B1)
3. hasJsonContentType(request)  → 415
4. isProjectsPathAllowed(...)   → 403
5. validateProjectsBody(body)   → 400   (aus lib/projects-schema.ts)
6. writeProjectsFile(...)       → 200
```
**Body:** `{ projects: ProjectMeta[], priorities: PriorityDef[] }`
**Antwort:** `{ ok: true, projects: ProjectView[] }`

**Merging, nicht Replace:** nur `priority`, `openTodos`, `status`, `lastTouchedAt`, `name`
der Prioritäten sind vom Client schreibbar. `root`, `createdAt`, `adopted`, `sizeBytes` sind
server-owned und werden aus dem alten Stand erhalten — ein Client kann so kein fremdes
`root` einschleusen.

### 3.3 Lösch-Projekt (Reihenfolge aus Doku §5, korrigiert um B3)

Der Doku folgend **drei** Aufrufe aus der UI, **keine** neue Delete-Route für den Ordner —
der Ordnerlösch-Zweig existiert bereits:

| # | Aufruf | Guard (im Bestand) |
|---|---|---|
| 1 | `GET /api/sessions` | `requireIdentity` + Owner-Filter |
| 2 | `DELETE /api/sessions/[id]` je Session mit `cwd === root` | `session-guard.ts` → 404 bei fremd |
| 3 | `DELETE /api/file-actions/<root>` | `isApiRequestAllowed` → `getRequestIdentity` → `isWritePathAllowed(…, {mustExist:true})` → `lstat` → fs-root-Refusal → `rmSync` |
| 4 | `PUT /api/projects` ohne den Eintrag | wie 3.2 |

**BLOCKER B2 als zusätzlicher Guard vor Schritt 3**, im Client **und** in einer
neuen Route `DELETE /api/projects`:

```ts
// lib/projects-delete.ts (NEW)
export function isProtectedProjectRoot(root: string): boolean {
  const r = path.resolve(root);
  const home = path.resolve(os.homedir());
  if (r === home || r === path.parse(r).root) return true;
  if (SYSTEM_PREFIXES.some(p => r === p || r.startsWith(p + path.sep))) return true;
  if (path.dirname(r) === home) return true;   // ~/docker, ~/Documents …
  return false;
}
```
Diese Funktion muss **vor** dem `DELETE /api/file-actions`-Aufruf im Dashboard stehen.
Ohne sie ist `~/docker/stacks` ein Ein-Klick-Datenverlust.

---

## 4. UI-AUFBAU

### 4.1 Komponentenbaum

```
components/ProjectsDashboard.tsx           NEW  "use client" — Orchestrator, holt /api/projects
├── components/projects/DashboardTopbar.tsx     NEW  Titel, Zähler, Sortier-/Dichte-Button, "Neues Projekt"
├── components/projects/PriorityFilterBar.tsx   NEW  Chips + Suche
├── components/projects/ProjectGrid.tsx         NEW  gruppiert nach priority-Reihenfolge
│   └── components/projects/ProjectCard.tsx     NEW  eine Karte
│       ├── components/projects/TodoStepper.tsx NEW  −/+ Zähler
│       └── components/projects/ConfirmDialog.tsx NEW  ModalBackdrop/ModalPanel
├── components/projects/NewProjectDialog.tsx    NEW  Modal
└── components/projects/ProjectListRow.tsx     NEW  Sidebar-Zeile "Nach Dringlichkeit"
```

**Empfehlung: `ProjectCard.tsx` und `ProjectGrid.tsx` sind server-taub** — sie nehmen
fertige `ProjectView`-Objekte als Props und machen keine eigenen Fetches. Das hält
`ProjectsDashboard` zur einzigen Stelle, die lädt.

### 4.2 Wiederverwendung — was NICHT neu gebaut wird

| Neu gebaut | Wird wiederverwendet | Quelle |
|---|---|---|
| Karten-Grid | `Enter` für das Einrasten jeder Sektion | `components/motion/Enter.tsx:38` (`direction`-Prop) |
| Dialog | `ModalBackdrop` + `ModalPanel` | `Enter.tsx:59`, `:75` |
| Einblenden der Karten | `Reveal` | `components/motion/Reveal.tsx` |
| Hover/Press | `Pressable` | `components/motion/Pressable.tsx` |
| Ladezustände | `Skeleton`, `Shimmer` | `components/motion/` |
| Farben | `--danger`, `--warning`, `--accent`, `--success`, `--text-dim`, `--bg-hover` | `app/globals.css:55-90` |
| **NICHT verwenden** | `omp-pop-in`, `omp-slide-in-*` | existieren nicht (W3) |
| Icons | Inline-SVG wie in der Sidebar | `SessionSidebar.tsx` |
| View-Umschaltung | bestehende if/else-Kette | `AppShell.tsx:1918` |

Alle Farben als `style={{ "--status-color": colorToken }}` — **nie** ein Hex-Literal,
weil `applyOmpPalette` die Variablen zur Laufzeit umschreibt.

### 4.3 AppShell-Anbindung

In `components/AppShell.tsx`:

```ts
// nach Zeile 997 (showPlaceholder)
const showProjects = activeView === "projects" && !showChat;
```
Render-Zweig in Zeile 1918 **vor** `showChat`, sonst nie erreicht:
```tsx
{showProjects ? <ProjectsDashboard … /> : showChat ? … : …}
```

`activeView` startet aus `?view=projects` (erweitert `lib/initial-navigation.ts:1-4`
um `requestedView`) und wird von der Sidebar gesetzt. Beim Setzen von `selectedSession`
oder `effectiveNewSessionCwd` fällt der View auf `"chat"` zurück.

**Konfliktgefahr:** `AppShell.tsx` ist eine 2000-Zeilen-Datei, an der auch der
File-Explorer-Agent arbeiten könnte. → Sequenzell, nicht parallel (siehe §7).

---

## 5. i18n

**Struktur (verifiziert):** `lib/i18n/messages/en.ts` (623 Z.) und `zh-CN.ts` (618 Z.),
flaches Objekt `"namespace.key": "text"`, ausgewertet über `useI18n()` → `t`
(`AppShell.tsx:178`). Registry in `lib/i18n/registry.ts`, Locale-Typ in `lib/i18n/types.ts`.

> ⚠️ **Konfliktgefahr: beide Dateien.** Der parallele Agent ändert die Download-Buttons
> und braucht dieselben zwei Dateien. → **Sequenzell, s. §7 Schritt 6.**

Neue Schlüssel (Auszug, ~30):

```ts
"projects.title":            "Projekte" | "项目"
"projects.subtitle":         "{count} Projekte · {chats} Chats"
"projects.new":              "Neues Projekt"
"projects.search":           "Projekt suchen…"
"projects.filter.all":       "Alle"
"projects.metric.todos":     "Todos"
"projects.metric.size":      "Größe"
"projects.metric.last":      "Zuletzt"
"projects.status.green":     "Läuft"
"projects.status.yellow":    "In Arbeit"
"projects.status.red":       "Blockiert"
"projects.noRepo":           "Kein Git-Repo"
"projects.chats":            "{n} Chats"
"projects.branch":           "Branch"
"projects.delete":           "Projekt löschen"
"projects.delete.confirmTitle":  "Projekt wirklich löschen?"
"projects.delete.body":      "Ordner, Inhalt und alle {n} Chats werden entfernt."
"projects.delete.protected": "Dieser Ordner ist geschützt und kann nicht gelöscht werden."
"projects.open":             "Öffnen"
"projects.adopted":          "Aus Sessions übernommen"
"projects.priority.now":     "Sofort"
"projects.priority.important": "Wichtig"
"projects.priority.later":   "Nice to have"
"projects.priority.done":    "Erledigt"
"projects.priority.parked":  "Unwichtig"
"projects.empty":            "Noch keine Projekte"
"projects.error":            "Projekte konnten nicht geladen werden"
```

Die Prioritätsnamen kommen aus `priorities[].name` (Registry), **nicht** aus i18n —
sie sind pro Account umbenennbar. Die i18n-Werte sind nur der Fallback für
unbenannte. Default-Name auf `de` ist nicht möglich (es gibt kein `de`-Paket) →
`en`-Texte als Default.

---

## 6. SICHERHEITSWANDE

| # | Aktion | Route | Guards in dieser Reihenfolge |
|---|---|---|---|
| S1 | Projekte lesen | `GET /api/projects` | `isApiRequestAllowed` → `getRequestIdentity` (403) → `isProjectsPathAllowed` → Ergebnisfilter gegen `getAllowedFileRoots(identity)` |
| S2 | Registry schreiben | `PUT /api/projects` | `isApiRequestAllowed` → `requireIdentity` (401) → `hasJsonContentType` (415) → `isProjectsPathAllowed` → Schema-Validierung |
| S3 | Session löschen | `DELETE /api/sessions/[id]` | **Bestand**, unverändert: `isApiRequestAllowed` → `session-guard.ts` (fremd → **404**) → `unlinkSync` |
| S4 | Ordner löschen | `DELETE /api/file-actions/…` | **Bestand**, unverändert: `isApiRequestAllowed` → `getRequestIdentity` (403) → `isWritePathAllowed(…, {mustExist:true})` → `lstat` → fs-root-Refusal (400) → `rmSync` |
| S5 | `allowFileRoot` bei Neuanlage | in `POST`-Zweig | nur wenn `isAdminIdentity(identity)`; **mit** `identity` als Argument (`AGENTS.md:271`) |
| S6 | Ordner anlegen | in `POST`-Zweig | `isPathWithinRoots` **vor** `mkdirSync` (`default-cwd/route.ts:47-51`) |
| S7 | Registry löschen | `DELETE /api/projects` | wie S2 + `isProtectedProjectRoot(root)` (B2) |
| S8 | `du` auf Projekt | intern | `isWritePathAllowed(root, {mustExist:true}, identity)` vor dem Aufruf |

**Unveränderlich in diesem Feature:** `isWritePathAllowed`, `getWritableRoots`,
`allowFileRoot`, `getRequestIdentity`, `requireAdmin`, `requireIdentity`, `proxy.ts`,
`file-actions/route.ts`, `sessions/[id]/route.ts`.

**AGENTS.md-Konformität:** keine neue Route ohne Guard; jede schreibende Route ruft
`isWritePathAllowed` oder trägt ein **begründetes** Ausnahme-Argument im Kommentar.
`app/api/host-wide-guards.test.mjs` prüft per Quelltext-Scan, dass `requireAdmin` **vor**
jeder Verzweigung steht — falls S7 admin-only wird, muss das dort greifen.

---

## 7. ARBEITSPROTOKOLL

**Gesamt: 8 Schritte. Parallel nur 1–3 (alles neue Dateien, keine gemeinsamen).**

| # | Schritt | Dateien | Parallel |
|---|---|---|---|
| 1 | Schema + Store + Tests | `lib/projects-schema.ts`, `lib/projects-store.ts`, `lib/projects-store.test.mjs` | ✅ mit 2 |
| 2 | Größen-Cache | `lib/project-size.ts`, `lib/project-size.test.mjs` | ✅ mit 1 |
| 3 | Löschen-Wächter | `lib/projects-delete.ts`, `lib/projects-delete.test.mjs` | ✅ mit 1 |
| 4 | **Route** | `app/api/projects/route.ts`, `app/api/projects/route.test.mjs` | ← nach 1–3 (braucht die Libs) |
| 5 | **i18n** ⚠️ | `lib/i18n/messages/en.ts`, `lib/i18n/messages/zh-CN.ts` | ← **sequenzell, nach dem Download-Buttons-Agent** |
| 6 | **UI-Komponenten** | `components/projects/*.tsx` (5 neue Dateien) | ← nach 4; untereinander parallel |
| 7 | **AppShell + initial-navigation** ⚠️ | `components/AppShell.tsx`, `lib/initial-navigation.ts`, `components/SessionSidebar.tsx` | ← **sequenzell** |
| 8 | Abschluss | alle | ← allein |

### Konfliktgefahr — explizit

| Datei | Wer | Koordination |
|---|---|---|
| `lib/i18n/messages/en.ts` + `zh-CN.ts` | **Download-Buttons-Agent** | **Schritt 5 erst abwarten.** Danach beide in **einem** Commit, damit kein Zwischendrittel-Zustand entsteht |
| `components/FileExplorer.tsx`, `FileBrowserDialog.tsx` | Download-Buttons-Agent | **Nicht anfassen.** Kein Bezug nötig |
| `components/AppShell.tsx` | ggf. beide | Schritt 7 **nach** dem Download-Agent |
| `components/SessionSidebar.tsx` | ggf. beide | Schritt 7, gemeinsames Fenster mit Main klären |
| `app/api/file-actions/…`, `app/api/sessions/[id]/…` | keiner | nur **lesend**, nicht ändern |

**Kommunikation vor Schritt 5 und 7:** Main eine Nachricht, welche Dateien gerade
belegt sind.

---

## 8. VERIFIKATION

Nach **jedem** Schritt (AGENTS.md: `bun run typecheck`, `bun run lint`, `bun test`):

| Schritt | Prüfung |
|---|---|
| 1 | `bun test lib/projects-store.test.mjs` — Pfad enthält Mandantengrenze; Datei `0o600`; kaputtes JSON → `exists:true, projects:[]` (kein Seed auf zerstörtem Bestand); `readProjectsFile` zweimal ohne Schreiben → Defaults bleiben |
| 2 | `bun test lib/project-size.test.mjs` — Timeout → `null`; nicht existierender Pfad → `null`; Symlink-Ausbruch → abgelehnt |
| 3 | `bun test lib/projects-delete.test.mjs` — **Positivliste**: `~`, `/`, `/etc`, `/usr`, `/var`, `/docker/stacks`, `~/docker` → alle `true`. **Negativliste**: `~/workspace/proj`, `~/workspace/proj/sub` → `false`. Test muss die *Liste* prüfen, nicht nur Ablehnungen — dieselbe Lücke, die `lib/write-access.identity.test.mjs` (AGENTS.md-Kommentar `write-access.ts:88-100`) ausdrücklich beschreibt |
| 4 | `bun test app/api/projects/route.test.mjs` — GET ohne `x-omp-user` → 403; PUT ohne Admin/Identity → 401; PUT `root` im Body → serverseitig **ignoriert**; Registry-Datei außerhalb der Konto-Home → 403; Registry-Pfad enthält `..` → 403 |
| 5 | `bun run typecheck` — beide Message-Dateien typisieren sich als `LocalePlugin` (fehlender Schlüssel in einer der beiden ist ein Compile-Fehler) |
| 6 | `bun run lint`; `bun run typecheck`; Render-Smoke in `bun run dev` (Port 30141) |
| 7 | `bun run typecheck`; `?view=projects` direkt aufgerufen → Dashboard; Klick auf Session → View wechselt zu `chat` |
| 8 | **Gesamt:** `bun run typecheck && bun run lint && bun test` — einmal, allein |

**Harness:** Repo hat kein Playwright-Harness. Für die visuelle Prüfung entweder den
Prototyp-Stand per `bun run dev` + Browser prüfen oder den bestehenden
`components/motion/motion.test.mjs`-Ansatz übernehmen. **Ausdrücklich nicht** `bun run build`
(AGENTS.md: bricht `bun run dev`).

**Manuelle Abnahme:** neues Projekt anlegen → Priority ändern → Todo-Zähler ±
→ Größe erscheint nach erstem Poll → schützen Pfad (`~/docker/stacks`) → Löschen
scheitert mit `projects.delete.protected` → Projekt ohne Chats löschen → Ordner weg,
Registry-Eintrag weg.

---

## 9. Was der Nutzer entscheiden muss (nur abnicken)

1. **F1** zwei Achsen behalten? → *ja, zwei*
2. **F2** Variante B (nur Statusbalken)? → *ja, B*
3. **F3** Zähler mit −/+? → *ja*
4. **F4** immer `~/workspace/`? → *ja*
5. **F5** echte Bytes mit TTL, Git-Metadaten optional als 2. Zeile? → *ja*
6. **F6** Pfadsperre im Code, nicht nur im Dialog? → *ja*
7. **F7** Registry pro Konto, aber auf unlesbare Pfade filtern? → *ja*

**Zusätzlich zu entscheiden:** F5 hat einen Preis, den die Doku nennt — ein 2.4-GB-Ordner
braucht einen echten Walk. Mit TTL 30 s und `Promise.all` ist das vertretbar. Soll die
Größe **standardmäßig aus** sein und nur auf Klick gemessen werden? → Empfehlung: **nein**,
aber mit `execFile`-Timeout 10 s und `null` statt Abbruch der Route.