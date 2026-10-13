# Inventur: Werkzeuge, Dateioperationen, Terminal

Rein lesend erstellt, kein Produktionscode geändert. Jede Aussage ist an einer
`Datei.tsx:Zeile` belegt. Was ich nicht belegen konnte, steht als **unklar**.

Format wie in `docs/inventory-ui.md`. Dort steht die **Darstellung** (Bedienelemente, Tastatur,
Overlays); hier steht, **was die Datei tut und wo die Grenzen liegen**.

> **Verwandtes Dokument.** `docs/inventory-auth.md` behandelt `proxy.ts`, Sitzungs-Cookie und
> Rechte. `docs/inventory-api.md` behandelt den übrigen API-Bestand. Die Überschneidung ist
> bewusst: die Mandantengrenze wird hier nur so weit wiederholt, wie Datei- und Shell-Zugriff
> sie unmittelbar betrifft.

---

## 0. Die beiden zu prüfenden Aussagen — beide bestätigt

### Die Mandantengrenze hängt an genau einer Funktion: `getUserHome`

**Bestätigt.** `lib/request-identity.ts:140-142` ist die einzige Stelle, die aus einer Identität
einen Konto-Wurzelraum macht:

```ts
export function getUserHome(identity: WebIdentity, env = process.env): string {
  if (identity.isAdmin) return "/";
  return join(resolveHomeRoot(env), identity.username);
}
```

Die Suche über `lib`, `app`, `bin`, `hooks`, `components` ergab 8 produktive Aufrufer
(`tenant-config.ts:50`, `allowed-roots.ts:93`, `path-security.ts:51`, `file-access.ts:60`,
`skill-lock.ts:73`, `quick-phrases-store.ts:66`, `terminal-manager.ts:146`, `session-reader.ts:106`)
sowie zwei in `app/api` (`default-cwd/route.ts:21`, `terminal/route.ts:73`). Alle rufen **diese**
Funktion. Eine zweite Variante gibt es nicht.

`lib/tenant-config.ts` hält sich tatsächlich frei von Identitätslogik: es importiert
`getUserHome`, `isAdminIdentity` und den Typ `WebIdentity` (`tenant-config.ts:4`) und sonst nichts
aus der Identitätsbestimmung. Der Modulkommentar sagt genau das (`:12-14`): „wer hier eine zweite
`getUserHome`-Variante aufmacht, hat die Mandantengrenze an zwei Stellen statt an einer." Die
Funktion dort ist `resolveTenantAgentDir` und sie entscheidet nur noch **Admin oder nicht**, nicht
mehr **welcher Benutzer**.

**Ein Detail, das die Grenze praktisch erweitert:** `env` ist ein Parameter und nicht `process.env`
(`request-identity.ts:140`). Das ist kein Detail, sondern die Voraussetzung dafür, dass ein Test
oder ein Aufrufer mit eigener Umgebung dieselbe Wurzel sieht, unter der die Konten auch angelegt
wurden. Ein stilles `/home` neben einem `OMP_WEB_HOME_ROOT` wäre ein Fehler, der nur in der
Testumgebung sichtbar ist.

### `isPathInUserHome` ist eine Validierung, keine Freigabe

**Bestätigt**, und der Quelltext benennt den Fehler selbst. `lib/path-security.ts:29-41`:

> „It is the check for callers that need to *ask* 'is this mine?' — validating a cwd, refusing
> another tenant's home — **without the side effect of making a path browsable**. Folding that
> question into `allowFileRoot()` turned a validation into a grant, which is how a path becomes
> permanently allowed to whoever asks next."

Die Funktion ist rein: sie nimmt keinen Lock, mutiert keine Allowlist und cacht nichts. Sie ruft
weder `allowFileRoot()` noch `getAllowedFileRoots()` auf. Umgekehrt ist `allowFileRoot()`
(`lib/allowed-roots.ts:105-117`) die **einzige** Funktion, die etwas dauerhaft macht, und sie legt
den Pfad in einen **Identitäts-Eimer**, nicht in eine globale Menge.

Das ist der zweite Unterschied, der in dieselbe Richtung geht: `getAdditionalAllowedRoots`
(`allowed-roots.ts:88-103`) ist eine Funktion der **Identität**, nie des angefragten Pfads. Der
Kommentar sagt es beim Bucket-Feld (`:8-20`): „a `Map` and not one process-wide `Set`: a single
shared set means one user calling `allowFileRoot()` widens the filesystem for every other user.
Since the read allowlist also feeds the write allowlist, that is a cross-tenant escalation and not
a nuisance."

---

## 1. Die Schichten des Pfadzugriffs

Bevor die einzelnen Werkzeuge kommen, die Reihenfolge, weil „Darf nicht" ohne sie nicht lesbar ist:

```
proxy.ts            setzt x-omp-user / x-omp-admin nach Prüfung der Anmeldedaten
   └─ getRequestIdentity()      liest NUR diese Header; null = 403, kein Fallback
getUserHome()       die EINE Mandantengrenze: Admin "/" , sonst /home/$name
   ├─ getAllowedFileRoots()     LESEN: Session-cwds + projectRoot + omp-cwd-* + getAdditionalAllowedRoots
   │     └─ allowFileRoot()     die einzige Funktion, die dauerhaft erweitert — pro Identität
   └─ getWritableRoots()        SCHREIBEN: Lesemenge minus "/"-Wurzeln, NUR Pfade mit "project"
         └─ isWritePathAllowed()  realpath-Auflösung, mustExist unterscheidet zwei Fälle
```

### getRequestIdentity — der einzige Identitätseingang
- **Kann**: Liest `x-omp-user` und `x-omp-admin` aus den Headern. `validateAccountName` muss den
  Namen akzeptieren, sonst `null` (`request-identity.ts:45-56`). Liefert `{ username, isAdmin }`
  oder `null`.
- **Tastatur**: keine.
- **Darf nicht**: **`null` heißt „niemand angemeldet" und ist keine Einladung, großzügig zu sein.**
  Es gibt bewusst keinen Fallback auf einen Default-Benutzer und keinen auf Admin
  (`request-identity.ts:36-39`). `proxy.ts` löscht eingehende Werte, bevor es seine eigenen setzt —
  ohne das wäre `x-omp-admin: 1` ein Kopf, den jeder Client mitschickt (`:25-28`). **Warum ein
  Header und kein Request-Parameter:** bei `/api/files/[...path]` kommt der Pfad aus der URL. Wer
  den Pfad wählt, wählt damit auch, welcher Mandant er sein will — die Absicherung darf nie aus
  dem Pfad selbst kommen, sonst ist jeder Mandant ein Einzeiler (`:20-25`).
- **Ort**: `lib/request-identity.ts:25-56`

### requireAdmin / requireIdentity — die geteilten Guards
- **Kann**: Antworten *oder* 403 bzw. 401, mit `Cache-Control: no-store`.
- **Tastatur**: keine.
- **Darf nicht**: (a) **`null` bedeutet in beiden „abgelehnt", nicht „durchgelassen"** — in
  `requireAdmin` ist der Kommentar ausdrücklich: „Eine fehlende Identitaet wird wie ein Nicht-Admin
  behandelt: 403, kein Default-Benutzer, kein Fallback auf Admin" (`:66-68`). (b) **Der Admin-Guard
  war genau einmal als Kopie pro Route vorhanden, und die Lücke wurde mit einem Kommentar
  überbrückt** („Every request here has already passed proxy.ts") — das ist laut Quelltext „die
  eigentliche Ursache des Einbruchs" (`:59-65`). Eine Guard-Kopie pro Route ist eine Kopie einer
  Frage, die nicht route-lokal ist. (c) Beide geben einen nackten `Response` zurück, keinen
  `NextResponse` — `lib/` hält sonst keine Next-Imports (`:71-73`).
- **Ort**: `lib/request-identity.ts:82-104` (`requireAdmin`), `:120-127` (`requireIdentity`)

---

## 2. Lesen und Schreiben von Dateien

### GET /api/files — Liste, Lesen, Download, Meta, Vorschau, Beobachtung
- **Kann**: Sechs Typen (`list`, `read`, `download`, `meta`, `preview`, `watch`), plus im POST-Zweig
  `upload` und `upload-check`. Textdateien kommen als JSON mit erkannter Sprache, Bilder/Audio/
  Dokumente als Stream mit `Range`-Unterstützung. Vorschauen sind begrenzt: Bild > 10 MB → 413,
  Text > 256 KB → 413.
- **Tastatur**: nicht im Dokument relevant; im Client `Cmd/Ctrl+I` für die Zeilen-Erwähnung
  (`FileViewer.tsx:957-973`) — das ist Darstellung, siehe `inventory-ui.md`.
- **Darf nicht**: (a) **Der Pfad kommt aus der URL, also ist er vom Aufrufer gewählt.** Alles
  Weitere leitet sich aus der Identität allein ab — nie aus dem Pfad, `sessionId` oder
  `expectedMtimeMs` (`route.ts:656-660`). (b) Es gibt **zwei** Prüfungen, und die zweite ist nicht
  überflüssig: erst `isFilePathAllowed` (rein lexikalisch, `:456`), dann nach `statSync` noch
  `isExistingFilePathAllowed` (realpath, `:472-475`). Die erste kann ein Symlink passieren, die
  zweite nicht. (c) `allowedBySessionReference` (`:458-461`) gilt **nur** für Nicht-`list` und
  hebt die realpath-Prüfung nicht auf, sondern überspringt sie bewusst: eine Datei, die eine
  Session referenziert, ist für diese lesbar. Das ist ein bewusster Durchlass, kein Loch, weil die
  Referenz selbst geprüft ist. (d) Eine fehlende Identität wird **zweimal** abgelehnt, einmal
  explizit und einmal implizit über die leere Root-Menge — „the explicit early return is there to
  make that impossible to get wrong by accident later" (`:447-453`).
- **Ort**: `app/api/files/[...path]/route.ts:432-640` (GET), `:40-46` (Typen), `:456-475` (Prüfungen)

### PUT /api/files — der Editor-Speicher
- **Kann**: Schreibt den Inhalt einer Datei zurück, mit Optimistic-Concurrency über
  `expectedMtimeMs` (Toleranz 0,5 ms, sonst 409 mit `conflict: true`). Atomar: Temp-Datei mit
  `flag: "wx"` daneben, dann `renameSync`.
- **Tastatur**: `Cmd/Ctrl+S` löst es aus (`FileViewer.tsx:1301-1306`).
- **Darf nicht**: (a) **Der Editor-Speicher war nur je gegen die *Leserechte* geprüft, und die
  enthalten für einen Admin `/`.** Genau daraus wurde „alles lesen" gleich „alles überschreiben,
  was der Dienst schreiben kann". Deshalb der zusätzliche `isWritePathAllowed(…, { mustExist: true })`
  (`route.ts:669-674`) — mit dem Kommentar wörtlich: „Reusing them here is what made 'read any
  file' equal 'overwrite any file the service can write'". (b) **Schreiben durch Symlinks wird
  abgelehnt**, wie beim Upload: das reale Ziel muss noch in einem erlaubten Root liegen
  (`:699-710`). (c) Die Temp-Datei wird bei Fehler **bestmöglich** wieder entfernt (`:718-723`) —
  das ist Aufräumen, keine Transaktion; der eigentliche Schutz ist, dass `renameSync` auf
  demselben Dateisystem atomar ist.
- **Ort**: `app/api/files/[...path]/route.ts:642-741`

### POST /api/files — Upload
- **Kann**: Multipart-Upload mit drei Konfliktstrategien (`error`, `skip`, ersetzen) und
  dreifacher Rückmeldung (`uploaded`, `skipped`, `errors`, Status 207 bei Teilfehlern).
- **Tastatur**: keine.
- **Darf nicht**: (a) **Die Zielordner-Prüfung läuft über `getUploadDirectory`, das die Identität
  als Parameter bekommt und nicht selbst liest** (`:86-136`, Aufruf `:152`). Der Kommentar nennt den
  Grund: „the URL decides *where* to upload, the identity decides *whether*". (b) Auch hier wird
  **beidseitig aufgelöst** — `realpathSync(directory)` gegen `realpathSync` aller Roots
  (`:113-129`) — plus `isWritePathAllowed` (`:131`); die Lesewurzeln allein reichen nicht.
  (c) **Ein Verzeichnis oder ein Symlink wird nie ersetzt** (`:216-220`), auch nicht mit der
  Ersetzungsstrategie — `nonReplaceable` aus `inspectUploadTargets`. (d) Drei Grenzen: 25 MB je
  Datei, 100 MB gesamt, 101 MB Anfrage inklusive Multipart-Rändern (`:43-46`, `:177-189`).
  (e) `path.join(directory, file.name)` ohne Namensvalidierung wäre ein Traversal — die Validierung
  passiert in `validateUploadFileNames` **zweimal**, vor und nach dem bodies (`lib/file-upload.ts:21-37`).
- **Ort**: `app/api/files/[...path]/route.ts:143-260`, `:86-136`, `lib/file-upload.ts:21-60`

### POST /api/file-actions — mkdir, rename, move, copy
- **Kann**: Vier zerstörende Operationen. Der Pfadsegment adressiert die **Quelle**, das Ziel
  kommt als **absoluter Verzeichnispfad** im Body — ein Move-Ziel ist ein vom Nutzer gewähltes
  Verzeichnis, kein relatives Schritt vom Quellort (`:26-29`).
- **Tastatur**: keine.
- **Darf nicht**: (a) **Die Route ist bewusst getrennt von `/api/files`**, und der Grund ist nicht
  die Dateigröße allein: „a separate module makes the write boundary auditable in one place — every
  handler that can destroy something is in this file, and every one of them opens with the same two
  checks" (`:22-26`). Jeder Handler beginnt mit `isApiRequestAllowed` und `getRequestIdentity`.
  (b) **Die Identität wird einmal gelesen, bevor irgendein Pfad aus URL oder Body angesehen wird**
  (`:110-114`) — damit können Quellpfad und Body-Ziel die Frage „wer wird autorisiert" nicht
  beeinflussen. (c) **`safeName` ist ein einzelnes Pfadsegment und sonst nichts**: kein `/`, kein
  `\`, kein `\0`, nicht `.` und nicht `..` (`:55-64`). Das ist die clientseitige Regel; die
  serverseitige Prüfung von `mkdir` und `rename` ist dieselbe Funktion. (d) **Das Ziel muss
  absolut sein** (`:143-145`) — sonst wäre es eine relative Eskalation gegen den Arbeitsordner des
  Prozesses. (e) **Ein vorhandenes Ziel wird mit 409 abgelehnt, nicht überschrieben**
  (`:150-153`): „the user cannot see what was there before it is gone". (f) `isSameOrBelow`
  verhindert „Ordner in sich selbst" (`:135-137`, `:163-166`). (g) **Kopieren folgt Symlinks nicht**
  (`copyTree`, `:78-92`): ein Symlink in der Quelle wird als Symlink kopiert, damit ein Link nach
  draußen nicht fremden Inhalt durch den Copy hineinzieht. `chmod` trägt den Modus über, weil
  `copyFileSync` das nicht überall tut (`:91`) — ein Executable ohne `+x` ist ein echter Regress.
  (h) **Ein `EXDEV` beim Move wird gemeldet, nicht umgangen** (`:170-182`): ein Copy-dann-Delete
  ließe einen halb verschobenen Baum, wenn der Prozess dazwischen stirbt. (i) Copy-Größe 512 MB
  (`:40`), geprüft **vor** dem Schreiben (`:168-173`).
- **Ort**: `app/api/file-actions/[...path]/route.ts:16-33` (Begründung), `:49-64` (`safeName`),
  `:97-207` (POST)

### DELETE /api/file-actions — rekursives Löschen
- **Kann**: Löscht Datei (`unlinkSync`) oder Baum rekursiv (`rmSync` mit `recursive: true`).
- **Tastatur**: im Kontextmenü `Shift`-Klick ohne Rückfrage (`en.ts` `files.deleteWithShiftClick`,
  `SessionSidebar.tsx:2598`).
- **Darf nicht**: (a) **Das Löschen eines Dateisystemwurzelverzeichnisses wird abgelehnt** —
  `path.resolve(target) === path.parse(path.resolve(target)).root` → 400 (`:224-229`), mit der
  Begründung: „a root that somehow entered the writable set must not be removable with one
  request". (b) `force: false` — ein nicht leerer Ordner, der sich nicht entfernen lässt, ist ein
  Fehler und kein Erfolg (`:230`). (c) `lstatSync` statt `statSync` (`:219`): ein Symlink ohne
  Ziel belegt den Namen, und `rmSync` auf einen solchen Pfad würde durch den Link hindurch löschen.
- **Ort**: `app/api/file-actions/[...path]/route.ts:209-259`

### isWritePathAllowed — die eigentliche Schreibgrenze
- **Kann**: Prüft, ob ein Ziel in einem **schreibbaren** Root liegt, nach Symlink-Auflösung.
  `mustExist` unterscheidet die zwei Wege, wie die Auflösung scheitern kann.
- **Tastatur**: keine.
- **Darf nicht**: (a) **Die Schreibmenge ist nicht die Lesemenge.** Sie entsteht aus den Teilen der
  Lesemenge, die ein echtes Projekt benennen, und erbt `/` **nie**
  (`write-access.ts:20-38`): (1) ein Pfad in einem Session-cwd oder Projekt-Root **dieser**
  Identität ist schreibbar; (2) `OMP_WEB_ALLOWED_ROOTS` ist schreibbar, weil ein Betreiber es
  gesetzt hat; (3) **das Home-Verzeichnis selbst ist nicht schreibbar**, nur was unterhalb eines
  Projekts darin liegt; (4) `/` und jeder andere Vorfahr eines Projekt-Root ist nicht schreibbar.
  (b) Warum das nicht nur Pinglichkeit ist: `renameSync("/etc/hosts", "/tmp/x")` braucht
  Schreibrecht auf **beiden** Seiten und **kein** Leserecht auf einer — ein Schreib-Guard, der die
  Lesemenge wiederverwendet, verschenkt beliebiges Schreiben auf jedem Pfad, den der Dienst
  schreiben kann, **mit einem Knopf darauf** (`:15-20`). (c) **Die eine Zeile
  `if (resolved === path.parse(resolved).root) continue;`** ist die gesamte Schreibgrenze für
  einen Admin. Löscht man sie, kippt `isWritePathAllowed` auf `/etc/passwd` von `false` auf `true`
  und ein kompromittiertes Admin-Passwort wird zu beliebigem Schreiben — **durch Mutation belegt,
  nicht durch Lesen** (`:95-104`). Ein Test, der nur die Ablehnungen prüft, hätte das nicht
  gefangen: eine solche Datei wird aus zwei unabhängigen Gründen abgelehnt, dieser Zeile **und** der
  Tatsache, dass sie in keinem Projekt liegt. Eine Ablehnung, zwei Ursachen, kein Signal, welche
  trägt. Deshalb prüft die Abdeckung die **gefilterte Menge** — dass kein Schreib-Root eine nackte
  Dateisystemwurzel ist (`:99-103`). (d) **Jede Funktion nimmt die Identität explizit und keine hat
  einen Default** (`:40-42`): ein Default wäre eine stille Rechteausweitung, sobald jemand das
  Argument vergisst, und das sind die Funktionen, durch die ein Schreibvorgang geht. (e) Der Cache
  ist **pro Identität** (`:74-78`) — ein gemeinsamer Satz ließe die Projekte eines Kontos zu den
  Schreibwurzeln eines anderen werden.
- **Ort**: `lib/write-access.ts:40-53` (Begründung), `:66-105` (`getWritableRoots`), `:107-137`
  (`isWritePathAllowed`)

### authorizeTransfer / destinationExists / isSameOrBelow
- **Kann**: Autorisiert Move und Copy. **Beide** Enden müssen passen.
- **Tastatur**: keine.
- **Darf nicht**: (a) **Ein Copy prüft die Quelle auf *Lesbarkeit*, ein Move auf *Schreibbarkeit***
  (`write-access.ts:170-183`) — ein Copy schreibt nur das Ziel, und die Quelle geht nicht unter.
  Ohne diese Unterscheidung würde „diese Datei kopieren" Schreibrecht auf die Datei selbst
  verlangen, was dem Kopieren nicht entspricht. (b) `destinationExists` nutzt `lstatSync`, nicht
  `statSync` (`write-access.ts:200-210`): „a symlink whose target is gone still occupies the name,
  and creating a file there would write *through* the link". Mit `stat` würde das Ziel als frei
  gemeldet und der Aufrufer bekäme einen Pfad, der den Schreibvorgang woanders hinführt.
  (c) `isSameOrBelow` lehnt „Ordner in sich selbst" ab (`:216-218`).
- **Ort**: `lib/write-access.ts:155-183`, `:200-218`

### getAllowedFileRoots / allowFileRoot — die Lesegrenze
- **Kann**: Baut die lesbare Menge aus Session-cwds, Projekt-Rooten, `omp-cwd-*`-Verzeichnissen und
  den zusätzlichen Grants. 5 Sekunden Cache.
- **Tastatur**: keine.
- **Darf nicht**: (a) **Ohne Identität ist das Ergebnis leer — und `listAllSessions()` wird dann
  gar nicht erst aufgerufen** (`file-access.ts:29-38`): „the unfiltered scan would rebuild the very
  root set the identity is there to narrow, and an empty result is the only genuinely safe one."
  (b) **`omp-cwd-*` wird in der Home der anfragenden Identität gesucht, nicht in `homedir()`**
  (`file-access.ts:53-58`) — der Dienst läuft als ein Konto, ein Scan im Prozess-Home hätte jedem
  angemeldeten Nutzer die Kratzverzeichnisse des Dienstkontos als lesbare Wurzeln gegeben: „a
  cross-tenant read that no identity check could catch afterwards, because by then the path was in
  the allowlist". (c) **`allowFileRoot` invalidiert den Cache, statt ihn zu flicken**
  (`allowed-roots.ts:112-116`): der gesetzte Eintrag wurde für *eine* Identität zusammengesetzt
  und kann durch sie gefiltert sein, ein Einsetzen könnte also die Home-Grenze durchbrechen, die
  beim Zusammensetzen lag. (d) **Für einen Admin liegt `/` in der Lesewurzelmenge — und das ist
  gefährlich, nicht sicher** (`allowed-roots.ts:85-96`): „It is *not* safe by accident of the OS:
  the service runs as one account, so the kernel only ever sees that account and will happily hand
  over every file it can read." Admins behalten es, weil sie die Maschine sehen sollen; kein
  Nicht-Admin-Request erreicht diesen Zweig, weil er die einzige Stelle ist, an der `/` je
  hinzukommt. (e) `OMP_WEB_ALLOWED_ROOTS` gilt **nur** für Admins, aus demselben Grund.
- **Ort**: `lib/file-access.ts:23-70`, `lib/allowed-roots.ts:8-30` (Buckets), `:88-117`

### isPathInUserHome — die Validierung
- **Kann**: „Liegt das in der Home **dieses** Kontos?" Reine Funktion, keine Nebenwirkung.
- **Tastatur**: keine.
- **Darf nicht**: **Die ganze Funktion ist ein „Darf nicht" — siehe Abschnitt 0.** Zusätzlich zur
  Trennung von Prüfung und Freigabe gilt für den Fallback (`path-security.ts:42-66`): Symlinks
  werden auf **beiden** Seiten aufgelöst, damit ein `~/link -> /etc` nicht durchkommt. Aber **nur
  so weit, wie Auflösung möglich ist**: existiert die Home oder das Ziel noch nicht, wirft
  `realpathSync`, und die naive Form ließ die Wurzel fallen und beantwortete alles mit `false` —
  „including the account's own home. That is not a strict check, it is a lockout". Der Fallback
  greift deshalb **nur, wenn die Home unauflösbar ist**, und die Bedingung ist bewusst auf die Home
  und nicht auf „irgendeine Seite": `<home>/escape -> /etc` mit nicht existierendem `passwd` darunter
  löst die Home auf und lässt das Ziel unauflösbar — ein Fallback, der dem vertraute, gäbe für
  jeden noch nicht vorhandenen Pfad einen Symlink-Ausbruch zurück.
- **Ort**: `lib/path-security.ts:42-66`

### isForeignUserHome — die Gegenprobe
- **Kann**: „Gehört dieser Pfad einem **anderen** Konto?" Strukturell, nicht durch Aufzählen.
- **Tastatur**: keine.
- **Darf nicht**: Die Antwort speist **nur eine Ablehnung**, deshalb ist die strukturelle Form
  (`/^\/home\/[^/]+(\/|$)/` auf dem aufgelösten Pfad, `:83-99`) zulässig, obwohl sie
  `/home/<service-account>` fälschlich als „fremd" einstuft. Der Dienst kann Mandanten nicht zuverlässig
  aufzählen, und die Antwort landet nie in einer Freigabe. **Umgekehrt darf diese Funktion nicht als
  Positivprüfung benutzt werden** — sie sagt nichts darüber, ob ein Pfad erlaubt ist.
- **Ort**: `lib/path-security.ts:68-99`

### filePathFromSegments — aus URL-Segmenten einen Pfad
- **Kann**: Fügt die dekodierten Catch-all-Segmente mit `/` zusammen und stellt einen führenden `/`.
- **Tastatur**: keine.
- **Darf nicht**: **Die Segmente werden bewusst nicht erneut validiert**, und der Grund steht im
  Quelltext (`file-paths.ts:15-27`): Segmente kommen prozent-dekodiert an, ein `%2F` im Dateinamen
  ist also schon ein echter Schrägstrich. „That is a property of the URL scheme rather than
  something this function introduces, and it is why the segments are rejoined verbatim instead of
  being re-validated: **the allowlist check downstream resolves the result and is what actually
  bounds access**." Wer hier zusätzlich filtert, ersetzt die einzige Prüfung, die auflöst, durch
  eine, die es nicht tut.
- **Ort**: `lib/file-paths.ts:15-27`

---

## 3. Das Terminal

### POST/GET /api/terminal — öffnen und listen
- **Kann**: Legt ein Terminal an (`spawn(cwd, cols, rows, identity.username)`) und listet die
  sichtbaren. `GET` zeigt einem Nicht-Admin nur die eigenen, einem Admin alle
  (`terminal/route.ts:52`).
- **Tastatur**: nicht hier, sondern im `TerminalViewer`.
- **Darf nicht**: **Der Besitzer wird bei `spawn` als Parameter übergeben und nicht aus dem `cwd`
  abgeleitet** (`terminal/route.ts:84`) — der `cwd` wählt das Verzeichnis, der Benutzername den
  Mandanten. (b) `requireIdentity` antwortet hier **404, nicht 403** (`owner-guard.ts:36-42`).
- **Ort**: `app/api/terminal/route.ts:44-89`, `app/api/terminal/owner-guard.ts:36-47`

### /api/terminal/[id]/{input,resize,stream} und DELETE
- **Kann**: Eingabe senden, Größe ändern, Ausgabe als SSE-Stream, Terminal beenden.
- **Tastatur**: Der `TerminalViewer` schickt Tasten unverändert an `/input`; `Enter` ist eine
  gewöhnliche Eingabe, keine Anwendungs-Logik. **Der Viewer hat keinen eigenen `keydown`-Handler.**
- **Darf nicht**: (a) **Beide Fälle sind 404 statt 403 — keine Identität und fremde Shell**
  (`owner-guard.ts:22-34`): „The difference would be an oracle: 403 confirms that the id belongs to
  a shell, and the ids are UUIDs that an attacker would not guess but would get from someone else's
  page list. 404 makes both cases indistinguishable." (b) **Der Admin-Zweig steht im Guard und nicht
  im Manager**, weil das die einzige Stelle ist, an der die Ausnahme gemacht wird
  (`owner-guard.ts:21`).
- **Ort**: `app/api/terminal/owner-guard.ts:1-47`,
  `app/api/terminal/[id]/{input,resize,stream,route.ts}`

### lib/sandbox.ts — die Isolierung, und das Fail-open
- **Kann**: Plant ein `bwrap`-argv für einen Mandanten: User-/PID-/IPC-/UTS-Namespace, `--tmpfs /tmp`,
  nur Systemverzeichnisse readonly (`/usr`, `/bin`, `/etc`, bedingt `/lib`, `/lib64`, `/sbin`),
  `--dev /dev`, `--proc /proc`, **genau ein** `--bind` für das eigene Home, und `--chdir` auf den
  umgeschriebenen Namespace-Pfad.
- **Tastatur**: keine.
- **Darf nicht**: **(a) FEHLT `bwrap`, LÄUFT DIE SHELL UNCONFINDED. Das ist gewollt.** Der Kommentar
  im Aufrufer sagt es (`terminal-manager.ts:133-137`): „A missing `bwrap` is not fatal: the shell
  still opens, unisolated, and the caller is told. Refusing outright would take the terminal away
  from every install that has no bubblewrap yet, which is a worse failure than a warning." Es gibt
  dafür **keinen** Fail-closed-Pfad im Code, nur `console.warn` mit der `remediation`
  (`terminal-manager.ts:158-160`), und das Feld `sandboxed` in `TerminalInfo` trägt die Aussage
  nach außen. **Jemand, der das zum Fail-close umbaut, schaltet die Shell auf kaputten Hosts
  komplett ab** — das ist der Fehler, den dieses Fail-open vermeidet. Ebenso darf der
  `checkSandboxPrerequisites`-Fehlerzweig **nicht** werfend gemacht werden: `ok: true` heißt
  „die Voraussetzungen sind da" und **nicht** „die Isolation greift" — genau dieser Unterschied hat
  den alten Strang scheitern lassen, der drei Binaries fand und daraus eine Freigabe machte, ohne den
  Aufruf zu prüfen, der die Berechtigung wirklich verrät (`sandbox.ts:132-137`).
  (b) **Die Reihenfolge im argv ist der Vertrag**: `--tmpfs /tmp` zuerst, damit kein fremder Pfad
  durch das echte `/tmp` sichtbar wird, danach genau **ein** `--bind` (`sandbox.ts:161-166`).
  „A second `--bind` on a foreign home would be exactly the error this function prevents by not
  having an argument for it."
  (c) **`HOME` muss gesetzt sein** (`--setenv HOME`, `:246-248`). Ohne das sieht die innere Shell
  das Home des aufrufenden Users, und damit wird die falsche Datei isoliert.
  (d) **Die Verzeichnisse werden gemountet, nicht erzeugt.** Ein echtes Verzeichnis anzulegen und
  zu verstecken wäre schwächer: es gäbe etwas zu sehen, das man nur nicht sieht (`:23-30`).
  (e) **Nicht-`/home`-Verzeichnisse werden per `existsSync` übersprungen** (`:239-244`) — der alte
  Kommentar behauptete das, der Code band sie trotzdem, und `bwrap --ro-bind /nonexistent
  /nonexistent` bricht mit `Can't find source path` ab und beendet den Spawn.
  (f) **`isInsideHome` benutzt `home + "/"`, nicht `startsWith(home)`** (`:277-281`): sonst käme
  `/home/alice2` als Kind von `/home/alice` durch, und die Shell chdirte in ein fremdes Verzeichnis.
  (g) **Ein cwd außerhalb der Home wird abgelehnt** (`:220-232`) — vorher unveraendert durchgereicht
  bwrap scheitert daran (`Can't chdir to … No such file or directory`), und das wäre erst *später*
  als `[Process exited with code 1]` im SSE-Strom aufgefallen. „A shell that opens in the wrong
  directory is worse than one that does not open at all."
  (h) **Der Benutzername muss `/^[a-z_][a-z0-9_-]{0,31}$/` erfüllen** (`:207-216`) — der Pfad im
  argv wird aus ihm gebaut.
  (i) **`OMP_WEB_PASSWORD` wird aus der Umgebung der Mandanten-Shell gelöscht**
  (`terminal-manager.ts:147-154`): „the admin secret must not lie in a tenant shell". Das ist der
  einzige echte Schnitt in dieser Kopie; alles andere bleibt durch die Bind-Liste unerreichbar.
  (j) Das `bwrap`-binary wird **gecacht** (`sandbox.ts:69-78`): das ist ein `PATH`-Scan auf dem Weg
  in jedes Terminal, und `which` pro Spawn wäre messbarer Ballast.
- **Ort**: `lib/sandbox.ts:1-45` (gemessene Belege), `:96-113` (Preflight), `:157-255` (`planSandboxSpawn`),
  `:277-296` (`isInsideHome`, `mapCwdIntoSandbox`); `lib/terminal-manager.ts:112-165` (Fail-open)

### lib/terminal-manager.ts — der Spawn
- **Kann**: Verwaltet die Terminals, weist jedem einen Besitzer zu, liefert die Liste gefiltert.
- **Tastatur**: keine.
- **Darf nicht**: (a) **`/usr/bin/script -qfc … /dev/null` für eine echte PTY** (`:119-127`) — ohne sie
  hätte bash keine Zeilendiskriminierung, keine neu gerenderten Prompts beim Resize und keine
  verschachtelten Shells. (b) **Das innere Kommando bleibt statisch: kein `$PWD`, kein `$$`, kein
  `export PS1`** (`:128-130`) — nicht, weil die Namespace es verbietet, sondern weil die
  `sudoers`-Nebenstelle einen interpolierten String nicht matchen kann.
  (c) **`listOwnedBy` für Nicht-Admins, `listAll` für Admins** (`terminal/route.ts:52`) — die
  Entscheidung steht in der Route, weil das die einzige Stelle mit der Ausnahme ist.
- **Ort**: `lib/terminal-manager.ts:112-165`, `:100-111`

---

## 4. Skills, Plugins, MCP

### /api/skills — lesen und Verwalten
- **Kann**: Listet Skills mit Install-Info, prüft Updates, sucht, installiert, aktualisiert.
- **Tastatur**: `Enter` löst die Suche aus (`SkillsConfig.tsx:477-478`), `Enter` installiert einen
  Plugin-Quelltext (`PluginsConfig.tsx:385-386`).
- **Darf nicht**: (a) **Ein globaler Install ist auf Admins beschränkt** (`skills/install/route.ts:41-53`):
  `npx skills add -g` schreibt in das `~/.agents` des **Prozesskontos** — es gibt kein Mandanten-`-g`,
  weil `npx` keine Identität kennt. „A global install by a non-admin would change the shared
  inventory, and that is exactly the decision above: the inventory is global, so only whoever is
  responsible for it writes it." Ein Nicht-Admin installiert mit `scope: "project"` in sein eigenes
  Verzeichnis. (b) **Ein Projekt-Install verlangt zusätzlich Vertrauen** (`:55-63`):
  `getProjectTrustStatus(cwd, getAgentDir()).trusted` — Projekt-Ressourcen führen lokalen Code aus.
  (c) **Und zusätzlich die Lesewurzel-Prüfung** (`:57-60`) — Trust ist eine Projektentscheidung,
  keine Freigabe für beliebige Verzeichnisse. (d) `npx` läuft mit `getSafeNpxEnv(...)` und einem
  60-Sekunden-Timeout (`:65-70`), die Ausgabe wird auf 4000 Zeichen gekürzt und von ANSI befreit
  (`:72`).
- **Ort**: `app/api/skills/install/route.ts:37-70`, `app/api/skills/route.ts:19-32`

### /api/plugins — Installieren, Entfernen, Aktivieren
- **Kann**: `install`, `remove`, `update` (als Neuinstallation mit `force: true`, „omp has no
  in-place update"), `enable`, `disable`.
- **Tastatur**: `Enter` installiert, nur wenn Quelle nicht leer und nicht `busy`.
- **Darf nicht**: (a) **Jeder Zweig prüft `cwd` gegen die Lesewurzeln dieser Identität**
  (`plugins/route.ts:170-172`) — und zwar **vor** der Konstruktion des `PluginManager`
  (`:175`), damit ein fremdes Verzeichnis nie einen Manager mit diesem Pfad bekommt. (b) **Das
  `update` läuft über `install(source, { force: true })`** (`:189`) — das ist Absicht, kein
  Kurzschluss.
- **Ort**: `app/api/plugins/route.ts:143-198`

### /api/mcp — MCP-Server-Konfiguration
- **Kann**: Liest und schreibt die MCP-Konfiguration in zwei Scopes: `user`
  (`<agentDir>/mcp.json`) und `project` (`<cwd>/.omp/mcp.json`). Schaltet Server ein und aus,
  entdeckt verfügbare, redigiert Geheimnisse in der Antwort.
- **Tastatur**: `Escape` schließt den OAuth-Dialog in `ModelsConfig.tsx:1697`.
- **Darf nicht**: (a) ~~**`configPath("user", …)` benutzt `getAgentDir()`**~~ — **behoben.**
  `configPath(identity, scope, cwd)` löst den User-Scope über `resolveTenantAgentDir` auf, und
  `scope: "user"` ist in `PUT` **und** `PATCH` Admin-only. Zwei getrennte Gründe, weil sie
  verschiedene Fehler schließen: der **Pfad** verhindert, dass `setMcpServerEnabled` bei einem
  unbekannten Servernamen über seinen `userPath`-Rückfall in eine fremde Datei schreibt — auch
  wenn `body.scope === "project"` ist, wo ein Guard auf `body.scope` allein nicht greift; der
  **Guard** verhindert das Versprechen, das ohne ihn falsch wäre: `rpc-manager.ts:1840` startet
  jede Session mit `getAgentDir()`, eine Mandantendatei `~/.omp/agent/mcp.json` würde **nie
  gelesen** (vgl. dieselbe Begründung bei `auth/api-key/[provider]`). `GET` filtert zusätzlich den
  User-Scope aus `loadCapability`, das `~` über `os.homedir()` des Prozesses auflöst.
  (b) **`validatedCwd` prüft gegen die Lesewurzeln** (`mcp/route.ts:315-321`) und wirft „Access denied",
  was `GET` auf 403 abbildet — ein Project-Scope ohne berechtigtes `cwd` ist damit nicht
  erreichbar. (c) **Ein `cwd` im Query ohne Berechtigung ist 403, kein 500** — die Fehlermeldung
  wird daraufhin geprüft, das ist etwas fragil und gehört beim Umbau auf einen eigenen
  Fehlertyp umgestellt. (d) `redactConfig` maskiert `headers` **alle** und `env` **nur** bei Schlüsseln
  auf `/token|key|secret|password|credential|auth/i` (`:50-59`) — die Maskierung ist also
  schemabhängig, ein `env`-Schlüssel `DSN` wird durchgelassen. **unklar**: ob das gewollt ist.
- **Ort**: `app/api/mcp/route.ts:46-60` (Redaktion), `:15-85` (Begründung), `:160-177`
  (`configPath`), `:217-267` (Discovery-Filter), `:304-343` (Guards), `:345-447` (Handler)

---

## 5. Sessions und Speicherung

Es gibt **kein `app/api/memory/`**. Der Pfad existiert nicht; Memory- und Verlaufsfunktionen liegen
unter `app/api/sessions/**` und in `lib/workspace-memory.ts`. `lib/workspace-memory.ts` wird von
genau einer Stelle benutzt (`AppShell.tsx:46`, `getLastOpenSession`/`setLastOpenSession`) — ein
`localStorage`-Spiegel, keine Route.

### GET /api/sessions — die Liste
- **Kann**: Liefert persistierte und laufende Sessions plus `runningSessionIds`, optional gefiltert
  über `?archived=1`.
- **Tastatur**: keine.
- **Darf nicht**: (a) **Beide Quellen filtern auf dieselbe Identität** (`sessions/route.ts:33-38`):
  „Nur die Platte zu filtern waere nutzlos: eine laufende Session taucht genau dann auf, wenn ihre
  Datei noch fehlt." (b) **Eine Session-Id aus dieser Liste ist ein Schlüssel, kein Anzeigename** —
  sie adressiert Prompt, Kontext, Export und `DELETE` (`:13-16`). Das ist der Grund für den
  `no-store` und den Kommentar, dass diese Route vorher ungefiltert jede Session nannte **und nicht
  einmal `isApiRequestAllowed`** hatte.
- **Ort**: `app/api/sessions/route.ts:12-48`

### isSessionOwnedBy — Besitz aus dem cwd
- **Kann**: Eine Session gehört dem Benutzer, dessen Home ihr `cwd` enthält. Ein Admin sieht alles.
- **Tastatur**: keine.
- **Darf nicht**: **Der Besitz ergibt sich aus dem `cwd`, weil der Bestand gemeinsam ist.** Alle
  Bediener teilen einen Baum (`~/.omp/agent/sessions/<cwd-kodiert>/*.jsonl`); pro Nutzer umziehen
  hieße, pro Request das Prozess-Agent-Dir umzuschalten — das ist eine Migration von Fremdbestand
  und keine Route (`session-reader.ts:71-79`). **Und das ist eine Zuordnung, keine Kapselung**
  (`:81-93`): „der `cwd` ist ein Feld im Inhalt der Datei, nicht eine Eigenschaft des Dateisystems:
  er steht nicht in der ersten Zeile, sondern in einer Folgezeile, und der Baum gehoert dem Konto,
  unter dem der Dienst laeuft. Wer dieses Konto ist, kann die Datei also auch umschreiben und damit
  die Zuordnung verschieben." Auf dem geprüften Bestand: erste Zeile `['type','v','title','source','updatedAt','pad']`,
  der `cwd` in Zeile 2. „A schaerfere Pruefung schliesst das nicht."
- **Ort**: `lib/session-reader.ts:95-107`

### Sessions mit einer konkreten Id (`[id]/`, `state/`, `export/`, `context/`, `auto-name/`, `entries/[entryId]/thinking/`)
- **Kann**: Verlauf, Zustand, Export, Kontextverbrauch, Auto-Namensvergabe, Denkanzeige eines
  einzelnen Eintrags.
- **Tastatur**: keine.
- **Darf nicht**: **Diese sechs Routen rufen `getRequestIdentity` überhaupt nicht auf.** Die Suche
  über alle sechs Dateien nach `getRequestIdentity`, `requireIdentity` und `identity` ergibt **null
  Treffer**. Sie prüfen `isApiRequestAllowed` (Request-Herkunft), aber keine Mandantenzugehörigkeit.
  Praktisch heißt das: die Id wird über `resolveSessionPath(id)` in einem **gemeinsamen**
  Pfad-Cache aufgelöst (`session-reader.ts:193-204`), und der Aufrufer bekommt den Verlauf.
  **Das ist dieselbe Klasse Fehler wie bei `mcp/route.ts` und ich melde es als Fund, nicht als
  Absicht.** Der Bestandsschutz liegt bisher nur in der **Liste**: wer keine Id kennt, kommt nicht
  an sie, und `resolveSessionPath` füllt seinen Cache aus `listAllSessions()` **ohne Identität**
  (`:202`) — also aus allen Sessions des Prozesses. Wer eine Id aus einem fremden Konto erahnt,
  kommt über diese Routen daran. **unklar**: ob das geprüft und bewusst so entschieden ist oder ob
  es beim Auth-Umbau übersehen wurde.
- **Ort**: `app/api/sessions/[id]/route.ts`, `[id]/state/`, `[id]/export/`, `[id]/context/`,
  `[id]/auto-name/`, `[id]/entries/[entryId]/thinking/`; `lib/session-reader.ts:193-204`

### lib/omp-runtime.ts und lib/tenant-config.ts — Settings je Konto
- **Kann**: Stellt `Settings`, `AuthStorage` und `ModelRegistry` bereit, pro Mandant über
  `Settings.loadIsolated()` in dessen eigenem `agentDir`.
- **Tastatur**: keine.
- **Darf nicht**: (a) **Der Admin läuft weiter über das Prozess-Singleton, weil sein Verzeichnis
  das Prozess-Verzeichnis ist** (`omp-runtime.ts:60-72`) — dort erwarten die Werkzeuge und
  `rpc-manager.ts` ihre Instanz. (b) **Der Tenant-Cache hängt an der `globalThis`, aber pro
  `agentDir`**, nicht pro Prozess (`:74-82`): eine gemeinsame Instanz hieße, dass Alices
  `config.yml` in Bobs Requests gelesen wird — und beim Schreiben in ihre Datei. (c)
  **`ensureTenantAgentDir` legt mit `0o700` an** (`tenant-config.ts:60-68`), weil
  `Settings.loadIsolated()` und `discoverAuthStorage()` weder Verzeichnis noch `agent.db` anlegen;
  ohne dieses `mkdir` endete die erste Anfrage eines frischen Kontos mit einem SQLite-Fehler statt
  mit einer leeren Konfiguration. (d) **Ein neues Nicht-Admin-Konto bekommt bewusst einen leeren
  Zustand** (`tenant-config.ts:46-49`): den globalen `models.yml` zu kopieren hieße, den API-Key des
  Betreibers an den ersten angemeldeten Mandanten weiterzugeben.
- **Ort**: `lib/omp-runtime.ts:34-82`, `lib/tenant-config.ts:49-68`

---

## 6. `hooks/**` (außer `useTheme.ts`)

Hooks sind keine Rechtegrenze — die Grenze liegt in den Routen. Hier stehen nur die Stellen, an
denen ein Hook **auf** eine Werkzeuggrenze wartet oder sie clientseitig vorwegnimmt.

### useGlobalKeyboardShortcuts
- **Kann**: `Escape` = laufenden Agenten abbrechen (über einen modulweiten `registerAbortHandler`),
  `Ctrl+Alt+N` = neue Sitzung im aktiven Projekt.
- **Tastatur**: `Escape` und `Strg`+`Alt`+`N`.
- **Darf nicht**: **`Escape` in `<textarea>` oder `<input>` wird hier bewusst nicht behandelt**
  (`useKeyboardShortcuts.ts:52-58`): `ChatInput` verwaltet sein eigenes Escape (Slash-/`@`-Menüs
  schließen, sonst abbrechen), weil es den lokalen Menüzustand kennen muss. Ein globaler Handler,
  der auch dort eingriffe, würde beim Schließen eines Menüs zusätzlich den Lauf abbrechen.
- **Ort**: `hooks/useKeyboardShortcuts.ts:29-73`

### useQuickPhrases — der einzige Hook mit Schreibpfad
- **Kann**: Hält die Kurzwortphrasen als Modul-Store, Quelle ist der Server.
- **Tastatur**: keine.
- **Darf nicht**: (a) **`pending` ist das laufende Versprechen** — ein zweiter Aufrufer bekommt
  dasselbe und stellt keinen zweiten Request (`useQuickPhrases.ts:26-32`): sonst feuern Composer und
  Dialog im Chat-Fall gleichzeitig zwei GETs, im ungünstigsten Fall zwei Säen. (b) **Der erste
  Snapshot ist leer, bis der Server geantwortet hat**, und das ist Absicht (`:33-37`): der Composer
  rendert die Knopfzeile nur bei `length > 0`, ein leerer Zwischenstand erzeugt also keinen Knopf,
  der dann wieder verschwindet. (c) **Ein Fehler leert nichts und blockiert nichts** (`:38-45`):
  die zuletzt gesehene Liste bleibt stehen. Nach einem Reload kommt der Stand aus dem Spiegel in
  `lib/quick-phrases.ts`, und `loaded` bleibt `false`, damit ein späterer Erfolg noch nachziehen
  kann.
- **Ort**: `hooks/useQuickPhrases.ts:26-45`, `lib/quick-phrases-store.ts:59-67`

### useDragDrop — Bild-Drop
- **Kann**: Nimmt nur Dateien an, deren Typ mit `image/` beginnt, und signalisiert „darüber".
- **Tastatur**: keine.
- **Darf nicht**: **`handleDragEnter` und `handleDragOver` kehren sofort zurück, wenn keine Datei ein
  Bild ist** (`useDragDrop.ts:9-20`) — ohne Bild wird kein `preventDefault()` gesetzt und der Browser
  öffnet beim Loslassen sein eigenes „Datei öffnen"-Verhalten. Und `handleDragLeave` nutzt einen
  **Zähler** (`:22-29`): `dragenter`/`dragleave` feuern paarweise, auch beim Überfahren von
  Kindelementen; ohne den Zähler flackert die Markierung.
- **Ort**: `hooks/useDragDrop.ts:9-37`

### useIsMobile
- **Kann**: Breakpoint bei 640 px, SSR-sicher.
- **Tastatur**: keine.
- **Darf nicht**: **Der Server-Snapshot ist `false`** (`useIsMobile.ts:24-26`) — auf dem Server und
  im ersten Client-Paint wird Desktop gerendert, danach wird synchronisiert. Wer den
  Server-Snapshot auf `true` setzt, erzeugt einen Hydration-Mismatch.
- **Ort**: `hooks/useIsMobile.ts:3-31`

### useViewportHeight
- **Kann**: Hält die App-Höhe am visuellen Viewport, solange eine Tastatur offen ist.
- **Tastatur**: keine.
- **Darf nicht**: `shouldUseVisualViewportHeight` verlangt **drei** Bedingungen
  (`useViewportHeight.ts:13-19`): ein fokussiertes editierbares Element, unskalierte Ansicht und
  eine echte Differenz > 1 px. iOS-PWAs im Standalone lassen `100dvh` sonst auf der Layout-Viewport-
  Höhe stehen, wodurch der Composer hinter der Tastatur landet **und die Seite selbst scrollt**.
- **Ort**: `hooks/useViewportHeight.ts:13-45`

### useAudio
- **Kann**: Zwei-Ton-Signal bei fertiger Aufgabe, mit Schalter in der Kopfzeile.
- **Tastatur**: keine.
- **Darf nicht**: **Ein einzelner `AudioContext` wird wiederverwendet** (`useAudio.ts:32-40`),
  weil ein außerhalb einer Nutzergeste erzeugter Kontext im Zustand `suspended` startet und **nicht**
  ertönt. Ohne Wiederverwendung könnte die Automatisierungspolitik des Browsers den Ton schlucken.
- **Ort**: `hooks/useAudio.ts:32-50`

### usePopupPlacement
- **Kann**: Rechnet, wo ein Popover öffnen und wie hoch es sein darf, neu bei Resize, Zoom und
  Layoutänderung des Ankers.
- **Tastatur**: keine.
- **Darf nicht**: Die Neuberechnung hängt **auch** an Layoutänderungen des Ankers, nicht nur an
  `resize` (`usePopupPlacement.ts:24-30`) — der Composer wächst beim Tippen, und ohne diesen Anlass
  liefe ein Popover aus dem Bild.
- **Ort**: `hooks/usePopupPlacement.ts:24-40`

### useAgentSession, useDisplaySettings, useI18n
- **Kann**: Sitzungs-/Agenten-Zustand, Anzeigeeinstellungen, Übersetzungen. Alle drei sind reine
  Client-Zustände und halten **keine** Rechteentscheidung.
- **Tastatur**: `useI18n` keine.
- **Darf nicht**: `useAgentSession` ist mit 2261 Zeilen der größte Hook und kapselt den
  SSE-/Eventstrom des Agenten. **Ich habe ihn nicht vollständig gelesen** — für Werkzeuggrenzen ist
  er nicht zuständig, das ist an den Routen belegt. **unklar**, ob er eigene Dateizugriffe auslöst.
- **Ort**: `hooks/useAgentSession.ts` (2261 Zeilen), `hooks/useDisplaySettings.ts`,
  `hooks/useI18n.tsx`

---

## 7. Zusammenfassung

| Schicht | Funktion(en) | Datei |
|---|---|---|
| Identität | `getRequestIdentity`, `getUserHome`, `requireAdmin`, `requireIdentity` | `lib/request-identity.ts` |
| Lesen | `getAllowedFileRoots`, `allowFileRoot`, `isExistingFilePathAllowed` | `lib/file-access.ts`, `lib/allowed-roots.ts` |
| Schreiben | `getWritableRoots`, `isWritePathAllowed`, `authorizeTransfer` | `lib/write-access.ts` |
| Pfadprüfung | `isPathWithinRoots`, `isPathInUserHome`, `isForeignUserHome` | `lib/path-security.ts` |
| Terminal | `planSandboxSpawn`, `checkSandboxPrerequisites`, `TerminalManager` | `lib/sandbox.ts`, `lib/terminal-manager.ts` |

### Was ich nicht erreichen konnte

| Punkt | Grund |
|---|---|
| **`app/api/memory/**`** | Das Verzeichnis existiert nicht. Memory-Funktionen liegen in `lib/workspace-memory.ts` (ein `localStorage`-Spiegel, von `AppShell.tsx:46` benutzt) und unter `app/api/sessions/**`. |
| **`isWritePathAllowed` für Nicht-Admin außerhalb eines Projekts** | Das Home selbst ist bewusst nicht schreibbar (`write-access.ts:33-35`). Ich habe keine Route gefunden, die ein Schreiben **in** die eigene Home ohne Projekt erlaubt — ob das Absicht oder eine Lücke ist, geht aus dem Code nicht hervor. **unklar**. |
| ~~`mcp/route.ts` Benutzer-Scope~~ | **Erledigt.** User-Scope ist Admin-only, Pfad mandantenfähig. Nicht-Admin bekommt dort eine leere Liste — gewollt, siehe Abschnitt 4. |
| **Sessions-Routen ohne Identitätsprüfung** | Belegbar keine Prüfung (null Treffer über alle sechs Dateien), **unklar** ob das geprüft entschieden ist. Ich melde es als Fund. |
| **`useAgentSession`** | 2261 Zeilen, nicht vollständig gelesen. Für Rechtefragen nicht zuständig (an den Routen belegt). |
| **`bwrap` auf einem echten Host** | Ich habe nur die Quelle gelesen. Die Messungen im Kommentar (fremdes Home unsichtbar, `/etc/shadow` denied, `uid=0` in der NS ist nicht Host-root) stammen aus dem Lauf vom 2026-10-03 und sind von mir **nicht** nachgemessen. |
| **Vergangenheitsverhalten** | „Vorher/nachher"-Aussagen nur dort, wo der Quelltext sie selbst als Kommentar trägt (Schreib-/Lesetrennung, Fail-open, `isPathInUserHome`, Tenant-Dir). Alles andere ist gegenwärtiger Zustand. |