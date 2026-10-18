# Inventur: alle API-Routen

Stand: Commit `2699054`. **58 Routen** unter `app/api/**/route.ts` (nicht 61 —
belegt durch `find app/api -name route.ts | wc -l`).

Jede Route hat vier Felder: **Kann** (was sie tut), **Identität** (anonym / Session
bzw. Basic Auth / admin-only, und woran das im Code festzumachen ist),
**Darf nicht** (Einschränkung plus Begründung), **Ort** (`datei:zeile`).

Die Identitätslage ergibt sich **nicht** aus einem Kommentar, sondern daraus, ob
`getRequestIdentity` / `isAdminIdentity` / `requireAdmin` aufgerufen wird. Wo
keiner dieser Aufrufe dasteht, steht das bei der Route.

---

## Gemeinsame Identitätsmechanik

`proxy.ts` hat den Matcher `["/", "/login", "/recover", "/api/:path*"]`. Jede
`/api`-Route passiert ihn also. Es gibt genau zwei Ausnahmen, die ohne
Credential durchgelassen werden: `/api/web-access/recovery` und
`/api/web-access/login`.

Die Lage ist zweigeteilt, und das ist der wichtigste Satz in diesem Dokument:

- **Verriegelter Server** (Passwort gesetzt): `proxy.ts` verifiziert Basic Auth
  oder das signierte Cookie `omp_session` und setzt `x-omp-user` /
  `x-omp-admin`. Jeder gültige Request bekommt eine Identität — **„angemeldet"
  ist nicht „Administrator"**. Auf einer Multi-Account-Installation passiert ein
  Mandant namens `bob` den Proxy exakt wie der Betreiber.
- **Offener Server** (`policy.mode === "open"`, `lib/web-auth.ts:254`): jeder
  Request wird durchgelassen, die Identität ist `null`.

### Identitäts-Header (`x-omp-user`, `x-omp-admin`)

- **Kann**: `proxy.ts` löscht eingehende Werte und setzt sie neu aus dem, was
  der Request tatsächlich bewiesen hat (`proxy.ts:76-90`, `withIdentity`).
- **Darf nicht**: Der Header darf nie aus Body, Query oder Pfad gelesen werden.
  Grund: bei `/api/files/[...path]` kommt der Pfad aus der **URL** — wer den
  Pfad wählt, wählt damit auch den Mandanten. Die Absicherung darf nie aus dem
  Pfad selbst kommen, sonst ist jeder Mandant ein Einzeiler. Nur `proxy.ts` darf
  `x-omp-admin` setzen, und das Löschen ist **unbedingt**: ein Delete, den ein
  Zweig nie erreicht, ist kein Schutz, sondern toter Code. Auf einem offenen
  Server ist die Identität `null`, also lief ein clientgeliefertes
  `x-omp-admin: 1` unangetastet in die Route und lieferte `/etc`.
  Gemessen vor dem Fix: `curl -H 'x-omp-user: root' -H 'x-omp-admin: 1' .../api/files/etc?type=list`
  → 200, mit vollständiger Liste von `/etc`.
- **Ort**: `lib/request-identity.ts:26-53`, `proxy.ts:76-90`

### `getRequestIdentity()` — `null` heißt Ablehnung

- **Kann**: Gibt `{username, isAdmin}` zurück, wenn der Proxy-Header gesetzt ist
  und der Name `validateAccountName` besteht; sonst `null`.
- **Darf nicht**: `null` darf nie als Default-Benutzer, als Admin oder als
  „unbeschränkt" gelesen werden. Es gibt bewusst keinen Fallback. Der Wert wird
  wie alles aus dem Netz als unvertraeuich behandelt: ein Name, der nicht als
  Pfadsegment taugt, ist kein Name, sondern ein Fehlversuch.
- **Ort**: `lib/request-identity.ts:38-53`

### Woher die Admin-Rolle kommt (ändert sich gerade)

- **Kann**: Heute entscheidet **allein der Name**:
  `isAdminUsername(username)` → `resolveAdminUsernames(env).includes(username)`
  (`bin/web-auth-store.js:350`, Vorgabeliste `["pi", "omp", "steimerbyte"]` in
  `bin/web-auth-store.js:88`, überschreibbar über `OMP_WEB_ADMINS`). Der Wert
  wird bei **jedem Aufruf neu berechnet**, nicht aus dem Kontodatensatz
  gelesen — `WebAccount.isAdmin` steht im Typ, wird aber nie gelesen
  (`bin/web-auth-store.d.ts:104-106`).
- **Darf nicht**: Für `features.md` darf daraus **nicht** abgeleitet werden,
  Admin sei dauerhaft eine Namenskonvention. Die Rollenquelle **ändert sich**:
  es kommt ein Rollenfeld in die Kontendatei. Die Aussage „admin-only" bleibt
  für alle Routen richtig, aber die Begründung „weil der Name in der Admin-Liste
  steht" ist dann falsch. `features.md` soll deshalb schreiben: *die Admin-Rolle
  kommt aus der Kontenverwaltung, nicht aus einer Namenskonvention* — und
  nicht, *welcher* Name gerade Admin ist.
- **Ort**: `bin/web-auth-store.js:342-353`, `bin/web-auth-store.js:88`,
  `lib/web-auth.ts:169-178`, `proxy.ts:142`

---

## Zugangskontrolle und Passwortverwaltung

### Passwortstatus lesen und ändern — `GET` / `PUT` `/api/web-access`

- **Kann**: `GET` liefert `WebAccessStatus` (Modus, gespeichert,
  `managedByEnvironment`, Credential-Dateipfad). `PUT` mit `action` ∈
  `set-password` | `set-username` | `enable` | `disable` | `clear` schreibt den
  Passwort-Store. `set-password` validiert die Stärke und schreibt `username` im
  selben atomaren Vorgang mit; ein Nicht-String-`username` wird verworfen, weil
  `setWebPassword` `undefined` als „behalte den gespeicherten" liest — sonst
  bekäme ein Client, der eine Zahl sendet, eine gespeicherte `"42"` zurück.
- **Identität**: **admin-only**. `requireAdmin` steht als erste Anweisung in
  beiden Handlern, **vor** dem Content-Type-Check, **vor** `req.json()`, **vor**
  jedem Store-Zugriff. `null` bedeutet hier „durchgelassen ist nicht" — eine
  fehlende Identität wird wie ein Nicht-Admin behandelt: 403, kein
  Default-Benutzer, kein Fallback auf Admin. Die Ablehnung trägt
  `Cache-Control: no-store`.
- **Darf nicht**: Ein Nicht-Admin darf den globalen Passwort-Lock nicht
  abschalten und das Passwort nicht ändern. Grund: der Lock gilt für den **ganzen
  Host**, nicht für einen Mandanten. Das war ein echter Einbruch, behoben in
  `bf170f9`: das Konto `bob` sandte `PUT {"action":"disable"}` und bekam 200,
  danach war `policy.mode` `open` und `/api/settings`, `/api/models`,
  `/api/file-index` antworteten ohne jede Credential mit 200. Die Ursache war
  **nicht** die fehlende Zeile, sondern ein Kommentar, der aus dem Proxy-Pass auf
  das eigene Schweigen schloss („every request here has already passed
  proxy.ts"). Genau dieses Argument muss sterben, nicht die Zeile darunter.
  Ebenfalls verboten: den 409-Guard gegen `managedByEnvironment` als Erlaubnis zu
  lesen — er verhindert nur das **Schreiben**, nicht den **Vorrang** der
  Environment-Variable `OMP_WEB_PASSWORD` über das gespeicherte Passwort
  (`resolveWebAuthPolicy`, `bin/web-auth-store.js:504`). Die Reihenfolge steht in
  `docs/known-findings.md`, weil sie im Betrieb auffällt und nicht im Code.
- **Ort**: `app/api/web-access/route.ts:52-130`, Guard `lib/request-identity.ts:84-97`

### Konten verwalten — `GET` / `POST` / `PATCH` `/api/web-access/users`

- **Kann**: `GET` liefert die Kontenliste mit `homeRoot` und den
  scrypt-Digest-Einträgen. `POST` legt ein Konto an (Name → Passwort → Anlage,
  201). `PATCH` setzt Passwort (`set-password`) oder `enabled` (`set-enabled`)
  eines bestehenden Kontos. Unbekannte `action` → 400, das ist ein Lookup
  (`ACCOUNT_ACTIONS`) und keine Liste zum Durchiterieren.
- **Identität**: **admin-only**, `requireAdmin` in allen drei Handlern, jeweils
  als erste Anweisung.
- **Darf nicht**:
  1. **Kein Klartext-Passwort in der Antwort.** Der Store kann es nicht liefern —
     es wurde beim Anlegen zu einem Digest gehasht und danach nie gespeichert.
     Deshalb steht hier kein Filter, der Felder wegnimmt, sondern genau der
     Datensatz, der auch auf der Platte liegt. Grund des Verbots: sonst steht
     das Passwort im Terminal-Scrollback des Admins und danach in irgendeinem Log.
  2. **Kein `body.isAdmin`.** Admin kommt aus dem Header, den `proxy.ts` nach
     dem Prüfen der Anmeldedaten gesetzt hat. Ein `body.isAdmin` wäre eine
     Schaltfläche, die jeder selbst umlegt. (Siehe auch oben: die Rollenquelle
     verschiebt sich in die Kontendatei — sie kommt aber **weiterhin** von
     `proxy.ts` und nicht aus dem Request.)
  3. **Kein Self-Service, keine Registrierungsroute.** Es gibt genau einen Weg,
     auf dem ein Konto entsteht, und der läuft durch diese Datei. Wer sich
     anmelden kann, muss vorher hier eingetragen worden sein.
  4. **`validateAccountName` vor jedem `mkdir`.** Es ist die Absicherung gegen
     `../etc` und `a/b`; ein 400 hier darf kein Verzeichnis hinterlassen.
- **Ort**: `app/api/web-access/users/route.ts:50-169`

### Anmelden — `POST` / `DELETE` `/api/web-access/login`

- **Kann**: `POST {username?, password}` prüft die Credential und setzt
  `omp_session` als httpOnly-Cookie (`sameSite: strict`, `path: /`,
  `secure: false`, `maxAge` aus `SESSION_TTL_MS` = 24 h). `username` ist optional
  und fällt auf den konfigurierten Einzelbenutzernamen zurück — das ist der Weg,
  den jede bestehende Installation geht, und deshalb kommt die Login-Seite
  vorbelegt. `DELETE` löscht das Cookie.
- **Identität**: **anonym erreichbar** — `proxy.ts:120-127` lässt
  `/api/web-access/login` mit `null`-Identität durch. Das ist der einzige Zweck
  der Route.
- **Darf nicht**: Keine unterscheidbare Fehlermeldung und keine unterscheidbare
  Latenz für falsches Passwort / fehlenden Store / deaktivierten Lock. Grund: was
  davon zutrifft, ist genau das, was ein Angreifer lernen will, und keinem
  hilft es, der ein Passwort getippt hat. Jeder Fehlerpfad kostet
  `FAILURE_DELAY_MS` = 150 ms, ungefähr eine scrypt-Verifikation.
  Ebenso: der Basic-Auth-Pfad kann **nicht** abgemeldet werden. Das ist
  dokumentiert und kein Fehler — curl, Reverse Proxy und bestehende Clients
  senden `Authorization`, und die Sitzung ersetzt diesen Weg nicht.
- **Ort**: `app/api/web-access/login/route.ts:47-117`, `lib/web-auth-session.ts`

### Passwort zurücksetzen — `POST` `/api/web-access/recovery`

- **Kann**: `action: "request"` mintet einen Einmalcode und **druckt ihn auf der
  Serverkonsole** des Prozesses, mit Ablaufzeit. `action: "complete"` verbraucht
  den Code und setzt ein neues Passwort. Die Antwort auf `request` enthält nur
  `expiresAt`.
- **Identität**: **anonym erreichbar** — die einzige Route, die `proxy.ts` ohne
  Credential durchlässt.
- **Darf nicht**: Der Code darf **nie** in die HTTP-Antwort. Grund: der Beweis der
  Wiederherstellbarkeit ist der Blick auf die Konsole des Betreibers — wer den
  Flow abschließen kann, kann diese Maschine sehen. Ein Portscanner, der die
  Route findet, kann Codes erzeugen, die niemand liest. Bei
  `managedByEnvironment` (409) und unlesbarer Credential-Datei (409) darf
  überhaupt kein Code geprägt werden: das würde einen Server entsperren, dessen
  Passwort niemand verifizieren kann; dafür braucht es eine Shell auf der Maschine.
  Die Route läuft trotzdem durch `withIdentity(..., null)`, damit ein
  clientgeliefertes `x-omp-admin: 1` hier nichts ist.
- **Ort**: `app/api/web-access/recovery/route.ts:40-114`, `proxy.ts:120-127`

### Wer bin ich — `GET` `/api/whoami`

- **Kann**: Liefert `{user: {username, isAdmin, home}}` oder `user: null`, immer
  mit `Cache-Control: no-store`. `home` kommt aus `getUserHome`: für Admin `/`,
  sonst `/home/$username`.
- **Identität**: liest nur, prüft nichts. Auf verriegeltem Server setzt der Proxy
  den Header; auf offenem kommt `user: null`.
- **Darf nicht**: Nicht als Autorisierungsquelle benutzen. Die Route ist der
  Verdrahtungsnachweis der Kette Anmeldung → Cookie-Signatur → Proxy-Header:
  gibt es sie nicht oder liefert sie `null`, ist die Kette nirgends angekommen.
  Sie steht bewusst **nicht** unter `/api/web-access/`, weil sie kein
  Passwort-Store-Zugriff ist und bedient werden muss, bevor man weiss, wer man ist.
- **Ort**: `app/api/whoami/route.ts:25-33`, `lib/request-identity.ts:113-118`

---

## Sessions

### Session-Liste — `GET` `/api/sessions`

- **Kann**: Liefert `{sessions, runningSessionIds}`. Beide Quellen — Platte und
  laufende RPC-Sessions — sind auf dieselbe Identität gefiltert. `?force=1`
  invalidiert den Scan, `?archived=1` zeigt die Archiv-Menge.
- **Identität**: `getRequestIdentity` → 403 `Unknown user` bei `null`, Antwort
  mit `Cache-Control: no-store`.
- **Darf nicht**: Ungefiltert antworten. Eine Session-Id aus dieser Liste
  adressiert Prompt, Kontext, Export und DELETE — sie ist ein **Schlüssel**, kein
  Anzeigename. Nur die Platte zu filtern wäre nutzlos: eine laufende Session taucht
  genau dann auf, wenn ihre Datei noch fehlt. Der Scan-Cache in `listAllSessions`
  darf den **ungefilterten** Bestand halten und erst bei der Rückgabe filtern —
  ein Cache-Schlüssel pro Mandant hieße, dass ein Mandant den Cache eines
  anderen lesen kann.
- **Ort**: `app/api/sessions/route.ts:13-47`, Filter `lib/session-reader.ts:112-137`

### Session-Detail — `GET` / `PATCH` / `DELETE` `/api/sessions/[id]`

- **Kann**: `GET` liefert `filePath`, `info` (mit `cwd`, `firstMessage`,
  `parentSessionId`, `transient`), `leafId`, `tree`, `context`, `totalActiveMs` und
  optional `contextUsage`. `?deferThinking` und `?deferMedia` lassen Denkblöcke und
  Tool-Ergebnisbilder weg. `PATCH {name?, archived?}` benennt oder archiviert.
  `DELETE` löscht die Datei und re-parentet direkte Kinder auf den Elternteil.
- **Identität**: **keine**. `getRequestIdentity` wird in dieser Datei nicht
  aufgerufen. Nur `isApiRequestAllowed` (Host-Allowlist + Cross-Site-Achse) und
  bei `PATCH` zusätzlich ein Content-Type-Check.
- **Darf nicht**: Das ist der dokumentierte **IDOR** aus
  `docs/known-findings.md` und gehört **nicht** auf die Liste der Kanns.
  `resolveSessionPath(id)` ruft `listAllSessions()` ohne Identity-Argument und
  filtert deshalb nicht, während die Liste sehr wohl über `isSessionOwnedBy`
  filtert — genau diese Inkonsistenz ist der Befund: die Liste ist zu, die
  Detailroute nicht.
  Warum das trotzdem kein offenes Loch ist: Session-IDs werden als
  `Bun.randomUUIDv7()` erzeugt, also mit 122 Bit Entropie; es gibt keinen
  Enumerationsweg, und die Liste, die IDs preisgeben würde, filtert bereits.
  Bleibendes Risiko ist eine ID, die außerhalb der App bekannt wurde — geteilter
  Link, Screenshot, Logfile, Export-Dateiname, Referrer.
  Auslöser für die Behebung: in dem Moment, in dem ein Nicht-Admin-Konto
  existiert. **Falls** sie behoben wird, muss der Filter derselbe
  `filterSessionsForIdentity`-Aufruf wie in der Liste sein, mit derselben
  `null`-Semantik (null = alles, das ist der CLI- und Startpfad). Kein eigener
  Filter: wer den dritten Fall mitreisst, sperrt den Besitzer aus seinen eigenen
  Sessions aus.
- **Ort**: `app/api/sessions/[id]/route.ts:30-191`, `lib/session-reader.ts:202`

### Session-Kontext — `GET` `/api/sessions/[id]/context`

- **Kann**: Liefert `context` plus optional `contextUsage` für einen gewählten
  `leafId`. Nutzt die laufende RPC-Session, wenn es eine gibt, sonst die
  Plattendatei.
- **Identität**: **keine**.
- **Darf nicht**: Session-Inhalte fremder Identitäten nicht liefern — dieselbe
  IDOR-Familie wie oben, hier ohne jede eigene Prüfung. (Einschränkung, kein
  eigenständiges Feature.)
- **Ort**: `app/api/sessions/[id]/context/route.ts:6-38`

### Session-Export — `GET` `/api/sessions/[id]/export`

- **Kann**: Exportiert die Session als HTML — bevorzugt über die omp-CLI
  (`--export`), mit Fallback auf das Export-Modul des Pakets. Das Ergebnis landet
  in einer UUID-Datei unter `tmpdir()/omp-web-export` und wird inline oder als
  Attachment ausgeliefert (`Content-Disposition` mit ASCII-Fallback **und**
  `filename*` UTF-8-Form). Header: `Content-Security-Policy: frame-ancestors 'none'`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`.
- **Identität**: keine eigene. `isApiRequestAllowed` ist gesetzt, aber die
  Origin-Achse wird für **benutzerausgelöste Browser-Navigationen** bewusst
  übersprungen (`isUserInitiatedSessionExportNavigation`) — nur bei
  `sec-fetch-mode: navigate` **und** `sec-fetch-dest: document` **und**
  `sec-fetch-user: ?1` **und** Pfad `/api/sessions/*/export`. Ein Download darf
  nicht als Cross-Site-Request eingestuft werden.
- **Darf nicht**: (a) Kein fremder Session-Inhalt (IDOR-Familie). (b) Die
  Ausnahme darf **nicht** auf andere Routen erweitert werden — sie ist an genau
  diese drei Fetch-Metadaten und ein Pfadmuster gebunden; jede Verallgemeinerung
  ist eine deaktivierte Cross-Site-Achse.
- **Ort**: `app/api/sessions/[id]/export/route.ts:105-140`, `lib/request-security.ts:64-79`

### Session-Zustand — `GET` `/api/sessions/[id]/state`

- **Kann**: `{running: true, state}` bei laufender RPC-Session; sonst
  `{running: false}`, wenn die Plattendatei existiert; sonst 404.
- **Identität**: **keine**.
- **Darf nicht**: Die Auflösung über `resolveSessionPath` ist ungefiltert
  (IDOR-Familie) — die Route darf daraus keine Existenz-Auskunft über fremde
  Sessions machen.
- **Ort**: `app/api/sessions/[id]/state/route.ts:5-24`

### Auto-Titel — `POST` `/api/sessions/[id]/auto-name`

- **Kann**: Erzeugt per `generateSessionTitle` einen Titel, schreibt ihn mit
  Quelle `"auto"` und invalidiert den Listen-Cache. Rückgabe: `{title}`, oder
  `{title: null, skipped: true}`, oder 409 wenn die Session währenddessen
  geschlossen wurde.
- **Identität**: **keine**.
- **Darf nicht**: Keinen bedeutungslosen Namen schreiben, wenn das Modell keinen
  liefert — deshalb der `skipped`-Zweig statt eines Leerstrings. IDOR-Familie
  gilt auch hier.
- **Ort**: `app/api/sessions/[id]/auto-name/route.ts:6-46`

### Denkblock einer Assistant-Nachricht — `GET` `/api/sessions/[id]/entries/[entryId]/thinking`

- **Kann**: Liefert `{thinking}` für genau einen Block, adressiert über `entryId`
  und einen **verpflichtenden** `blockIndex` (sicherer Integer ≥ 0, sonst 400).
- **Identität**: **keine**.
- **Darf nicht**: Den Inhalt anderer Nachrichtenrollen liefern. Geprüft wird auf
  `type === "message"`, `role === "assistant"` und `block.type === "thinking"`;
  alles andere 404. Das Parsing läuft über `SessionManager`, damit die Toleranz
  des SDK für fehlerhafte Zeilen erhalten bleibt. IDOR-Familie gilt auch hier.
- **Ort**: `app/api/sessions/[id]/entries/[entryId]/thinking/route.ts:4-35`

---

## Agent-Laufzeit

### Neue Session starten — `POST` `/api/agent/new`

- **Kann**: Spawnt eine pi-Session im `cwd` aus dem Body und liefert die echte
  Session-Id plus Model-/Thinking-Zustand. `type: "ensure_session"` legt nur die
  Laufzeit an. Das Thinking-Level wird mit omp' eigenem Parser gelesen
  (inklusive Abkürzungen wie `"med"`), damit Browser und CLI dieselbe Grammatik
  akzeptieren.
- **Identität**: `getRequestIdentity` → 403 `Access denied`, **kein Fallback auf
  das Dienstkonto**. Der `cwd` kommt aus dem Body, der Aufrufer wählt ihn also.
- **Darf nicht**: Eine Session in einem `cwd` starten, den die Identität nur
  **lesen** darf. Grund: eine laufende Session **schreibt** dort — Session-Dateien,
  History, Tools. Being allowed to read a directory is therefore not enough to be
  allowed to work in one. Deshalb prüft die Route zusätzlich `isWritePathAllowed`.
- **Ort**: `app/api/agent/new/route.ts:23-70`

### Kommando an eine Session — `POST` / `GET` `/api/agent/[id]`

- **Kann**: `POST` schickt ein Kommando an eine bestehende Session; `GET` liefert
  den aktuellen Agent-Zustand. Schnellpfad über die laufende RPC-Session, sonst
  wird sie aus der Plattendatei gestartet. Fehlgeschlagene Prompts kommen in der
  Form `prompt_rejected` mit `accepted: false`, damit der Client sie von einem
  Serverfehler unterscheiden kann.
- **Identität**: **keine**. Weder `getRequestIdentity` noch `getAllowedFileRoots`.
- **Darf nicht**: (a) Prompts an fremde Sessions — dieselbe IDOR-Familie, hier über
  `resolveSessionPath(id)`. (b) Die 30-MB-Body-Grenze nicht entfernen: `proxy.ts`
  würde sonst mit einem nackten 413 ohne Erklärung antworten, den der Client nicht
  von einem abgelehnten Prompt unterscheiden kann. Die Route prüft darum zuerst
  `Content-Length` und antwortet in der Form, die der Client kennt.
- **Ort**: `app/api/agent/[id]/route.ts:22-90`

### Agent-Events — `GET` `/api/agent/[id]/events`

- **Kann**: SSE-Strom der Agent-Events; startet die Session bei Bedarf, sendet
  alle 30 s einen Heartbeat und räumt beim Disconnect auf. Gefiltert:
  `turn_start`, `turn_end` und `tool_execution_update` werden nicht gesendet; bei
  `agent_end` kommt nur der Typ.
- **Identität**: **keine**. `isApiRequestAllowed` ist gesetzt.
- **Darf nicht**: (a) Keine Ströme fremder Sessions (IDOR-Familie). (b)
  `assistantMessageEvent` darf nicht mitgesendet werden — das ist ein Token, das
  der Client nicht braucht.
- **Ort**: `app/api/agent/[id]/events/route.ts:21-70`

### Bash-Ausgabe lesen — `GET` `/api/agent/[id]/bash-output`

- **Kann**: Liest eine Bash-Ausgabe-Datei aus `tmpdir()`, auf die diese Session
  **referenziert**. `?download=1` streamt die Datei ohne Puffern als Attachment;
  inline gibt es ein Größenlimit (`MAX_INLINE_BASH_OUTPUT_BYTES`), sonst 413 mit
  Größe und Limit.
- **Identität**: keine eigene — die Bindung an die Session ersetzt sie für
  diesen Pfad.
- **Darf nicht**: Den Pfad **nicht** durchreichen. `resolveBashOutputPath(path, tmpdir())`
  plus `isBashOutputPathReferencedBySession(resolved, id)` sind die Absicherung:
  ein beliebiges `path=`-Argument darf keine beliebige Datei des Prozesses lesen.
  Zusätzlich `openRegularFileNoFollow` — ein Symlink im Temp-Verzeichnis darf nicht
  als Datei geöffnet werden.
- **Ort**: `app/api/agent/[id]/bash-output/route.ts:15-70`, `lib/bash-output.ts`

### Laufende Sessions — `GET` `/api/agent/running`, `GET` `/api/agent/running/events`

- **Kann**: Der erste Endpunkt liefert `{runningSessionIds}` als leichten
  Snapshot für das Polling sichtbarer Tabs. Der zweite ist ein SSE-Strom, der bei
  jeder Zustandsänderung im Prozess pusht (Heartbeat 30 s), mit initialem Snapshot.
- **Identität**: `getRequestIdentity` → 403. Beim SSE als
  `new Response("Unknown user", {status: 403})`, nicht als leerer Strom.
- **Darf nicht**: Bei fehlender Identität **keine leere Liste** liefern. Grund: eine
  leere Liste sieht für den Client aus wie „nichts läuft" und ist damit eine
  Falschaussage, keine Absage. Symmetrisch gilt das für den Strom. Der Broadcast
  feuert für **jede** Zustandsänderung im Prozess, auch für die einer fremden
  Session; der Abonnent filtert deshalb selbst, weil „fremd" für den Admin nicht
  dasselbe ist wie für einen Mandanten. Das Abonnieren happens **vor** dem
  Snapshot, damit keine Änderung durch die Lücke rutscht.
- **Ort**: `app/api/agent/running/route.ts:8-23`, `app/api/agent/running/events/route.ts:12-70`

---

## Dateien

### Dateien browsen, lesen, herunterladen — `GET` `/api/files/**`

- **Kann**: `type` ∈ `list` | `read` | `download` | `meta` | `preview` | `watch`.
  Bilder, Audio und Dokumente werden mit Range-Support gestreamt, Text mit
  256-KB-Grenze (`TEXT_PREVIEW_MAX_BYTES`), Bilder mit 10-MB-Grenze
  (`IMAGE_PREVIEW_MAX_BYTES`). Directory-Listings überspringen `node_modules`,
  `.git`, `.next`, `dist`, `build`, `__pycache__`, `.turbo`, `.cache`,
  `coverage`, `.pytest_cache`, `.mypy_cache`, `target`, `vendor`, `.DS_Store` und
  `*.pyc`.
- **Identität**: `getRequestIdentity` → 403 `Access denied`, aufgelöst **einmal**
  und für alle Prüfungen darunter verwendet. Ein `null` ergibt aus
  `getAllowedFileRoots` ohnehin eine leere Menge; der frühe Return steht da, damit
  das später nicht versehentlich falsch wird.
- **Darf nicht**: Pfade außerhalb der Root-Menge. Es gibt eine bewusste
  **Ausnahme** an der *lexikalischen* Allowlist: mit `?sessionId=` darf eine Datei
  gelesen werden, die von dieser Session als strukturiertes Werkzeug-Pfadfeld
  referenziert wird, auch wenn sie lexikalisch außerhalb der Root-Menge liegt. Sie
  gilt nur für Nicht-`list`-Typen. Das ist **keine** Ausnahme von der
  Mandantengrenze: `isExistingFilePathAllowed` nach `realpath` läuft seit `9c974b4`
  für jeden Pfad, auch über den Durchlass, sodass ein Pfad außerhalb der Roots der
  *anrufenden* Identität auch mit korrekter Sessionreferenz abgelehnt wird. Der
  Durchlass existiert für den Fall, dass eine Root selbst über einen Symlink
  erreicht wird und ein Werkzeug in `details.resolvedPath` den aufgelösten Pfad
  meldet — siehe `docs/inventory-tools.md`, Abschnitt GET /api/files, Punkt (c).
  Er darf **nicht** auf `list` ausgedehnt werden, und die Referenz ist an einen
  Katalog benannter Pfadfelder gebunden, nicht an Fließtext.
- **Ort**: `app/api/files/[...path]/route.ts:432-523`, `lib/file-access.ts:38-90`

### Datei hochladen — `POST` `/api/files/**`

- **Kann**: Multipart-Upload in das Verzeichnis aus dem URL-Pfad. Grenzen: 25 MB
  pro Datei, 100 MB gesamt, 101 MB für den gesamten Request inklusive
  Multipart-Boundaries und -Header.
- **Identität**: `identity` wird in die Hilfsfunktion **durchgereicht**
  (`getUploadDirectory(segments, getRequestIdentity(request.headers))`), nicht
  dort neu gelesen — die Entscheidung kommt so aus genau einer Stelle, und nichts
  downstream kann sie erweitern.
- **Darf nicht**: (a) Die **Leser**-Roots nicht als Schreibfreigabe benutzen — sie
  enthalten für einen Admin `/`; ein Upload braucht zusätzlich
  `isWritePathAllowed`, dessen Menge absichtlich schmaler ist und das
  admin-only-`/` nie erbt. (b) Symlinks auflösen, **bevor** geschrieben wird, und
  zwar auf beiden Seiten (`realpathSync` des Zielverzeichnisses und aller Roots):
  ein Symlink innerhalb einer erlaubten Root darf das Upload-Ziel nicht nach
  draußen umleiten. (c) Alle Prüfungen **vor** der ersten angenommenen Byte —
  nachdem die Schleife geschrieben hat, ist der Schaden da. (d) Existierende
  Dateien nicht still überschreiben; `type=` und die Konfliktstrategie werden über
  `inspectUploadTargets`, `parseUploadConflictStrategy` und
  `validateUploadFileNames` ausgewertet. (e) Das Zielverzeichnis muss ein
  existierendes Verzeichnis sein, kein Pfad im Leerlauf.
- **Ort**: `app/api/files/[...path]/route.ts:88-148`, `:143-430`

### Datei speichern — `PUT` `/api/files/**`

- **Kann**: Schreibt den Editorinhalt. Atomar: Temp-Datei mit `wx`-Flag neben die
  Ziel-Datei, dann `renameSync`; bei Fehler wird die Temp-Datei wieder entfernt.
  Bei gesetztem `expectedMtimeMs` und einer Abweichung > 0,5 ms: 409 mit
  `conflict: true`, aktuellem `currentMtimeMs` und `currentSize`.
- **Identität**: `getRequestIdentity` → 403. Der Kommentar im Code sagt
  ausdrücklich: der Pfad kommt aus der URL, also wählt der Aufrufer ihn; alles
  Folgende leitet sich **allein** aus der Identität ab — nie aus dem Pfad, nie aus
  `expectedMtimeMs`, nie aus einem anderen request-gelieferten Wert.
- **Darf nicht**: (a) Nicht gegen die **Read**-Roots prüfen. Genau das machte
  „alles lesen" zu „alles überschreiben, was der Dienst schreiben kann" — für
  einen Admin enthält die Lesemenge `/`. `isWritePathAllowed(..., {mustExist: true})`
  ist zusätzlich nötig, weil die Datei existieren und auf einen echten Pfad
  auflösen muss. (b) Nicht durch Symlinks schreiben: `realpathSync` auf beiden
  Seiten und erneute Root-Prüfung. (c) `content` muss ein String sein.
- **Ort**: `app/api/files/[...path]/route.ts:642-746`

### Dateien verschieben, kopieren, löschen — `POST` / `DELETE` `/api/file-actions/**`

- **Kann**: `POST` mit `type` = `mkdir` | `rename` | `move` | `copy`;
  `DELETE` löscht Datei oder Verzeichnis rekursiv. Kopiegrenze 512 MB.
- **Identität**: `getRequestIdentity` → 403 `Access denied`, **einmal vor der
  ersten Pfadauswertung** aufgerufen. Beide Handler reichen nur diesen Wert an
  `isWritePathAllowed` / `authorizeTransfer`.
- **Darf nicht**: (a) Bei `move` und `copy` darf das `destination` aus dem Body
  die Autorisierung nicht beeinflussen — beide Enden müssen `authorizeTransfer`
  bestehen. Genau deshalb wird die Identität zentral aufgelöst: Quellpfad und
  Ziel dürfen nicht bestimmen, **wer** autorisiert wird. (b) `copyTree` folgt
  **keinen** Symlinks; ein Link im Quellbaum wird als Link kopiert, damit ein
  Link nach draußen keinen fremden Inhalt durch die Kopie zieht. (c) Kein
  Kopieren oder Move in sich selbst (`isSameOrBelow`) — das rekursiert bis zur
  vollen Platte, und der Größenwächter würde erst danach überhaupt etwas merken.
  (d) Kein Cross-Device-Move mit Copy-und-Löschen-Fallback — das hinterlässt bei
  Prozessabbruch einen halb verschobenen Baum; `EXDEV` wird als 409 **gemeldet**
  statt versucht. (e) Kein Löschen eines Dateisystem-Wurzelverzeichnisses, auch
  wenn es in die Schreibmenge geraten wäre. (f) `name` muss ein einzelnes
  Pfadsegment sein (`.` und `..` abgelehnt); `destination` muss absolut sein.
- **Ort**: `app/api/file-actions/[...path]/route.ts:104-263`, `lib/write-access.ts`

### Dateiindex — `GET` `/api/file-index`

- **Kann**: Ohne `q`: relative Dateiliste bis `MAX_FILES`, plus `truncated`.
  Mit `q`: bewertete Treffer gegen das **vollständige** Listing — der Cap greift
  erst nach dem Match, damit grosse Repos tiefe Dateien finden (so wie die TUI
  die Query an `fd` weitergibt). Git-Listing mit Walk-Fallback, 5-Sekunden-Cache
  pro `cwd`.
- **Identität**: `getAllowedFileRoots(getRequestIdentity(request.headers))`.
- **Darf nicht**: Den `cwd` aus dem Query-String als Prüfmaßstab benutzen. Der
  Aufrufer wählt den `cwd`, die Roots kommen allein aus der Identität; eine daraus
  abgeleitete Prüfung würde sich selbst genehmigen.
- **Ort**: `app/api/file-index/route.ts:112-175`

### Git-Status und Git-Diff — `GET` `/api/git/status`, `GET` `/api/git/diff`

- **Kann**: `status` liefert `getGitStatus(cwd)`. `diff` liefert
  `getGitFileDiff(cwd, filePath)`.
- **Identität**: Roots aus `getAllowedFileRoots(getRequestIdentity(...))`; beide
  Pfade müssen erlaubt sein, `cwd` zusätzlich mit `isExistingFilePathAllowed`.
- **Darf nicht**: (a) Den `cwd` aus dem Query-String nicht als Prüfmaßstab
  benutzen. (b) In `/api/git/diff` die **Existenz der Diff-Datei nicht** prüfen:
  sie kann entfernt worden sein, während Git sie als gelöscht meldet. Deshalb prüft
  dort nur der `cwd` auf Existenz, und `getGitFileDiff` verifiziert selbst, dass
  der angefragte Pfad zu diesem Repository und zu seinem Status gehört. Wer das
  umdreht, verhindert legitime Lösch-Diffs.
- **Ort**: `app/api/git/status/route.ts:7-36`, `app/api/git/diff/route.ts:6-38`

### Arbeitsverzeichnis browsen — `GET` `/api/cwd/browse`

- **Kann**: Listet lesbare Unterverzeichnisse mit `path`, `parentPath` und
  `directories`. Unter Windows liefert sie die Drives.
- **Identität**: `getRequestIdentity` → 403 `Unknown user`.
- **Darf nicht**: (a) Ohne Root-Prüfung ein Verzeichnislisting liefern.
  `getBrowseStartDirectory` fällt auf `homedir()` zurück und `resolveDirectory`
  löst alles auf, was der Prozess lesen kann — ohne die Prüfung gegen
  `getAllowedFileRoots(identity)` war der cwd-Browser ein **unbeschränkter
  Verzeichnisleser**. (b) Keine leere Antwort als Ersatz für die Ablehnung: eine
  403 sagt dem Aufrufer, dass es hier nicht weitergeht. (c) Die Drive-Liste für
  Nicht-Admin: `drives: []`.
- **Ort**: `app/api/cwd/browse/route.ts:14-60`

### Arbeitsverzeichnis validieren — `POST` `/api/cwd/validate`

- **Kann**: Prüft, dass ein Kandidat nicht leer ist, existiert, ein Verzeichnis
  ist, und liefert den `realpath`-aufgelösten Pfad zurück. Im Admin-Zweig wird der
  Pfad zusätzlich global freigegeben (`allowFileRoot`).
- **Identität**: `getRequestIdentity` → 403 `Unknown user`; danach `isAdminIdentity`.
  Der Kommentar sagt ausdrücklich: ohne Header ist niemand angemeldet — 403, nicht
  Admin, nicht `/`.
- **Darf nicht**: Ein Nicht-Admin darf `allowFileRoot` **nicht** aufrufen. Grund:
  nur der Admin erweitert die globale Menge, und das bleibt eine bewusste,
  lebenslange Freigabe durch einen Betreiber — kein Nebeneffekt einer
  Nutzeranfrage.
- **Ort**: `app/api/cwd/validate/route.ts:11-45`

### Standard-Arbeitsverzeichnis anlegen — `POST` `/api/default-cwd`

- **Kann**: Legt `~/omp-cwd-<YYYYMMDD>` an, falls es fehlt, und liefert den Pfad.
- **Identität**: `getRequestIdentity` → 403; der Zielpfad kommt aus
  `getUserHome(identity)`.
- **Darf nicht**: (a) Nicht `homedir()` des Prozessbenutzers — sonst legte jeder
  Bediener sein Verzeichnis unter `/home/pi` an. (b) Die Home-Prüfung muss
  **vor** dem `mkdir` laufen. Umgekehrt erzeugt der alte Ablauf ein Verzeichnis
  und fragt erst danach: jeder, der diese Route erreicht, hat dann schon ein
  `omp-cwd-*` in fremder Home angelegt. (c) Die Prüfung ist hier **lexikalisch**
  und nicht auflösend, und das ist richtig: `isPathInUserHome` löst mit
  `realpathSync` auf und kann nur bestehen, wenn die Home schon existiert. Eine
  Home existiert aber nicht für jedes Konto — sie wird in
  `normalizeAccountEntry` rein rechnerisch gesetzt, und nur `createWebAccount`
  legt das Verzeichnis an. Ein Datensatz aus Hand, Migration oder Backup kann
  sich einloggen, ohne dass seine Home je existiert hat; für genau diese Konten
  wäre die auflösende Variante ein 403 beim allerersten `omp-cwd`. Die eigentliche
  Grenze ist `getUserHome(identity)` statt `homedir()`; die Lexikalisierung ist die
  zweite Schicht darüber.
- **Ort**: `app/api/default-cwd/route.ts:10-51`

### Worktrees — `GET` / `POST` / `DELETE` `/api/worktrees`

- **Kann**: `GET` liefert `{projectRoot, isGit, isTopLevel, worktrees}` und erlaubt
  jeden gelisteten Pfad im Datei-Browser — damit der Switcher Worktrees auch zeigt,
  bevor sie eine Session haben. `POST` legt einen Worktree an, `DELETE` entfernt
  ihn (mit `force`). `DELETE` meldet `dirty: true` mit 409, wenn Git wegen
  Änderungen `--force` verlangt, damit die UI eine Rückfrage stellen kann.
- **Identität**: `checkCwdAllowed(cwd, identity)` → 403 bei `null` oder außerhalb
  der Roots, mit der ausdrücklichen Begründung im Code: `cwd` kommt aus Query
  oder Body, eine daraus abgeleitete Prüfung würde sich selbst genehmigen.
- **Darf nicht**: Den in-memory `allowFileRoot`-Eintrag **nicht** prozessweit
  teilen — er wird pro Identität gesetzt und überlebt keinen Serverneustart.
  Deshalb nimmt `GET` zusätzlich den git-verifizierten Weg: jeder gelistete Pfad
  ist ein echter Worktree dieses Projekts.
- **Ort**: `app/api/worktrees/route.ts:11-140`, `lib/worktree.ts`

---

## Terminal

### Terminals auflisten und starten — `GET` / `POST` `/api/terminal`

- **Kann**: `GET` liefert `{terminals}` mit `id`, `cwd`, `pid`, `status`,
  `exitCode`, `shell`, `cols`, `rows`, `createdAt`, `lastActivityAt`, `owner` und
  `sandboxed`. `POST` spawnt eine Shell; ohne `cwd` wird die **eigene** Home
  verwendet, `cols`/`rows` werden auf 2–500 bzw. 1–200 begrenzt.
- **Identität**: `requireIdentity` aus `owner-guard`. Admin sieht
  `manager.listAll()`, jeder andere `manager.listOwnedBy(identity.username)`.
- **Darf nicht**: (a) Fremde Shells sind **nicht ausgeblendet**, sie sind in der
  Liste nicht vorhanden — `listOwnedBy`, kein Filtern im Client. (b) Keine Shell
  ohne Besitzer aufzuziehen: eine Shell ohne Besitzer wäre für niemanden
  auffindbar. Der Default-`cwd` ist die eigene Home, nicht `homedir()` des
  Prozessbenutzers. (c) `sandboxed` muss in der Antwort stehen, weil „isoliert"
  sonst nur eine Behauptung im Modulkommentar wäre; der Schlüssel fehlt nie — auf
  einem Host ohne `bwrap` ist er `false`, nicht abwesend. (d) Die
  `toInfo`-Serialisierung ist eine Kopie, und die gleiche Datei an
  `/api/terminal/[id]/route.ts` muss dasselbe sagen.
- **Ort**: `app/api/terminal/route.ts:43-96`

### Terminal lesen, schreiben, beenden — `/api/terminal/[id]` und Unterrouten

- **Kann**: `GET` liefert die Terminal-Info, `DELETE` killt den Prozess
  (`alreadyGone`, wenn er schon weg ist). `GET /stream` ist der SSE-Strom der
  PTY-Ausgabe; er sendet ein `connected`-Event mit den Startwerten und beendet
  mit genau einer `{"type":"exit"}`-Zeile, damit der Client sauber finalisieren
  kann. `POST /input` schreibt `{data}` in die PTY, `POST /resize` setzt
  `{cols, rows}`.
- **Identität**: `requireIdentity` + `authorizeTerminalAccess` in **allen vier**
  Routen. In `/input` steht die Prüfung vor dem Body-Parsing und vor jedem
  Zustandszugriff.
- **Darf nicht**: **404 statt 403**, und zwar in beiden Fällen — ohne Identität
  *und* bei fremder Shell. Grund: 403 bestätigt, dass die Id zu einer Shell gehört,
  und die Ids wären genau die, die ein Angreifer aus einer fremden Seitenliste
  bekäme. 404 macht „darfst nicht" und „gibt es nicht" ununterscheidbar. Eine
  fremde Shell darf auch **nicht angehängt** werden — sonst liefert der Stream die
  Ausgabe eines Prozesses, der jemand anderem gehört, und zwar dauerhaft über SSE.
  `/input` gibt 410, wenn die Shell bereits beendet ist, damit der Client den
  Zustand unterscheiden kann.
- **Ort**: `app/api/terminal/owner-guard.ts:19-46`, `app/api/terminal/[id]/route.ts:27-56`,
  `app/api/terminal/[id]/stream/route.ts:11-20`, `app/api/terminal/[id]/input/route.ts:8-22`,
  `app/api/terminal/[id]/resize/route.ts:8-16`

---

## Einstellungen und Konfiguration

### Einstellungen lesen und schreiben — `GET` / `PATCH` `/api/settings`

- **Kann**: `GET` liefert Tabs, Felder (Typ, Default, Optionen, Reihenfolge,
  Bedingung), die verfügbaren Web-Themes und das aktive Theme. `PATCH {path, value}`
  validiert gegen `SETTINGS_SCHEMA` und `validateSettingValue`, prüft
  Theme-Namen gegen die tatsächlich verfügbaren und schreibt.
- **Identität**: `GET` liest über
  `getSettingsForIdentity(getRequestIdentity(req.headers), cwd)`. `PATCH`
  prüft `isApiRequestAllowed` **und** `identity === null` → 403. Begründung im
  Code: ohne die Origin-Achse war dies eine POST-als-GET-Wörterbuchlücke auf dem
  einen Endpunkt, der fremde Herkunft überhaupt bemerken würde.
- **Darf nicht**: (a) **Credential-Felder** (`isCredential(path)`) dürfen nie einen
  Wert liefern — `value` und `defaultValue` sind dort `null`, nur `configured` ist
  ein Boolean. (b) `settings.set()` darf nicht auf das Prozess-Singleton gehen:
  `getSettingsForIdentity(identity, undefined)` liefert die Konto-Instanz und
  schreibt in **diese** `config.yml`. Mit dem Singleton wäre es die `config.yml`
  des Betreibers gewesen — derselbe Leck-Typ wie bei `models.yml`, nur eine Ebene
  höher. (c) `theme.dark`/`theme.light` müssen ein existierendes Theme sein.
  (d) Ein `cwd` aus dem Query muss gegen die Identity-Roots geprüft werden, sonst
  sieht ein Mandant die `config.yml` des Prozesskontos.
- **Ort**: `app/api/settings/route.ts:128-215`, `lib/omp-runtime.ts:95`

### Anzeige-Einstellung — `GET` `/api/display-settings`

- **Kann**: Liefert `{hideThinkingBlock}` — bewusst der kleine Ausschnitt, der
  das Rendern eines Transkripts beeinflusst.
- **Identität**: Roots-Prüfung gegen `getAllowedFileRoots(getRequestIdentity(...))`,
  nur wenn `cwd` mitgeschickt wurde.
- **Darf nicht**: Das darf kein Weg werden, den vollen Settings-Stand zu bekommen
  — dafür ist die eigene Route da, der Client liest hier nur die eine
  Anzeigeproprio zurück.
- **Ort**: `app/api/display-settings/route.ts:15-32`

### Theme-Konfiguration — `GET` `/api/theme`

- **Kann**: Liefert `getWebThemeConfig(settings)` für den Client.
- **Identität**: Roots-Prüfung nur, wenn `cwd` mitkommt.
- **Darf nicht**: Die Prüfung nicht weglassen, wenn `cwd` gesetzt ist — dieselbe
  Absicht wie bei `display-settings`.
- **Ort**: `app/api/theme/route.ts:10-26`

### Schnellphrasen — `GET` / `PUT` `/api/quick-phrases`

- **Kann**: `GET` liefert `{phrases, exists}`. `PUT {phrases}` schreibt und
  liefert die **validierte** Liste zurück, damit der Client sieht, was gespeichert
  wurde, und nicht seine eigene noch ungeprüfte.
- **Identität**: eigene `requireIdentity`, die zusätzlich den **abgeleiteten**
  Pfad gegen die Konto-Home prüft
  (`isQuickPhrasesPathAllowed(identity, getQuickPhrasesPath(identity))`) — bevor
  irgendein Verzeichnis entsteht. `null` heißt 403.
- **Darf nicht**: (a) Kein generischer Key-Value-Speicher, in den ein Client
  beliebig viel und beliebig wohin schreiben kann — es gibt genau eine Liste, und
  ein solcher Speicher wäre eine **neue** Mandantengrenze statt einer gelösten.
  (b) Eine existierende Datei mit leerer Liste nie überschreiben: das ist eine
  Entscheidung des Nutzers, `exists` entscheidet. (c) Die Pfadprüfung nicht als
  Default-Parameter von `resolveTenantAgentDir` bauen — man überliest
  Default-Parameter beim Aufruf, und die Grenze muss dort stehen, wo niemand sie
  überliest.
- **Ort**: `app/api/quick-phrases/route.ts:32-78`, `lib/quick-phrases-store.ts:51-106`

### Modelle — `GET` `/api/models`

- **Kann**: Liefert die sichtbaren Modelle, das Default-Modell, die
  Thinking-Stufen, Pin-Warnungen und die Rollen. `enabledModels` unterstützt Globs
  und Fuzzy-Muster, die Auflösung läuft deshalb genauso wie in der CLI statt
  Muster-Zeichenketten zu vergleichen. Sortierung numerisch per `Intl.Collator`.
- **Identität**: `getAllowedFileRoots(getRequestIdentity(...))` gegen den
  aufgelösten `cwd` (Default `process.cwd()`).
- **Darf nicht**: Den Ladefehler nicht als leere Modellliste tarnen — bei Fehler
  kommt `withSafeModelLoadFailure(EMPTY_MODELS)`, damit die UI einen Zustand
  sieht, in dem etwas schiefging.
- **Ort**: `app/api/models/route.ts:89-114`

### Modellrollen — `GET` / `PUT` `/api/model-roles`

- **Kann**: `GET` listet alle Rollen, die omp kennt, mit ihrer Zuweisung. `PUT
  {cwd, role, selector, scope}` schreibt; `selector` ist omp' Rollensyntax
  `provider/modelId[:thinkingLevel]`, sodass ein hier geschriebener Wert im
  `/model`-Selektor der CLI identisch zurückgelesen wird. `selector: null` räumt
  die Rolle auf dieser Ebene und lässt die darunter greifen. Die Antwort enthält
  die neu gelesenen Rollen.
- **Identität**: `requireAllowedCwd` prüft den `cwd` gegen die Identity-Roots
  (nach `resolve`, mit `isExistingFilePathAllowed`).
- **Darf nicht**: `scope: "global"` schreibt über die **prozessweite** Settings-
  Instanz (`runtime.settings`), `scope: "project"` über
  `getSettingsForCwd(cwd)`. Das darf nicht vertauscht werden, sonst schreibt ein
  Mandant in die globale `config.yml`. Nach dem Flush wird für die Antwort neu
  gelesen, damit Projekt-Overrides sichtbar sind.
- **Ort**: `app/api/model-roles/route.ts:11-90`

### models.yml je Konto — `GET` / `PUT` `/api/models-config`

- **Kann**: `GET` liest die `models.yml` des Kontos, `PUT` schreibt sie und
  invalidiert danach Models-Cache und Runtime, damit die Registry gegen die
  bearbeiteten Provider neu aufgebaut wird.
- **Identität**: `requireIdentity` → 403. Der Agent-Dir kommt aus
  `resolveTenantAgentDir(identity)`: Admin = globales Prozessverzeichnis,
  Nicht-Admin = `/home/$name/.omp/agent`.
- **Darf nicht**: (a) Die globale `models.yml` **nicht** in ein neues
  Nicht-Admin-Konto kopieren — das hieße, den API-Key des Betreibers an den
  ersten angemeldeten Mandanten weiterzugeben. Genau dieses Kostenleck schließt
  die Trennung. Ein neues Konto startet deshalb bewusst leer, und nichts wandert
  und nichts wird kopiert. (b) Der Admin bleibt im globalen Verzeichnis: Der
  Prozess läuft ohne uid-Wechsel als ein Benutzer, und `pi`, `omp` und
  `steimerbyte` sind genau die Konten, die es vor dem Mandantenumbau gab. Ein
  Umstellen auf ein eigenes Verzeichnis ließe den Provider-Key verschwinden,
  **ohne dass irgendwo ein Fehler auftritt**.
- **Ort**: `app/api/models-config/route.ts:93-140`, `lib/tenant-config.ts:48-51`

### Modellkatalog von models.dev — `GET` `/api/models-config/catalog`

- **Kann**: Holt `https://models.dev/api.json` (Timeout 15 s), cached eine Stunde,
  und liefert zu `q` / `provider` / `baseUrl` / `limit` (jeweils auf 120 / 120 /
  500 Zeichen bzw. Default 50 gekappt) gefilterte Modelle plus eine
  Preset-Empfehlung. Steht ein gültiger Cache, wird er bei einem Fehlschlag
  trotzdem zurückgegeben, statt die Liste zu leeren.
- **Identität**: **keine** — weder `getRequestIdentity` noch
  `isApiRequestAllowed`. Die Identität ergibt sich allein aus dem Proxy.
- **Darf nicht**: Der Katalog enthält keine Schlüssel. Das ist die einzige
  Zusage dieser Route; die Antwort nennt ihre Quelle (`source`) explizit. Für
  einen Refactor: diese Route hat keine eigene Request-Achse. Das zu „schließen"
  ist eine bewusste Entscheidung und keine Lücke, die man stillschweigend mit
  `isApiRequestAllowed` behebt, ohne den Grund zu notieren.
- **Ort**: `app/api/models-config/catalog/route.ts:62-77`

### Modell-Discovery und Modelltest — `POST` `/api/models-config/discover`, `POST` `/api/models-config/test`

- **Kann**: `discover` fragt die konfigurierte Endpoint-URL mit dem passenden
  Auth-Header — anthropic: `x-api-key` **plus** `anthropic-version: 2023-06-01`,
  google: `x-goog-api-key`, sonst `Authorization: Bearer`; Timeout 20 s. `test`
  macht einen echten `completeSimple`-Aufruf gegen das gewählte Modell.
- **Identität**: nur `isApiRequestAllowed`. Keine eigene Identitätsprüfung.
- **Darf nicht**: (a) Der `apiKey` darf nie in der Antwort zurückkommen. (b) Ein
  Header darf nur gesetzt werden, **wenn er nicht schon vorhanden** ist — sonst
  überschreibt ein vom Client mitgeschickter Header die Absicherung. (c) Das ist
  kein Verwaltungs-Interface, sondern das einzige Werkzeug, das einen fremden
  Provider-Endpunkt mit dem gespeicherten Key anspricht; es gehört deshalb nicht
  neben `/api/models-config` als „gehört dazu".
- **Ort**: `app/api/models-config/discover/route.ts:19-45`, `app/api/models-config/test/route.ts:29-45`

### MCP-Server — `GET` / `PATCH` / `PUT` `/api/mcp`

- **Kann**: `GET` liefert User- und Projekt-Scope mit entdeckten Servern und dem
  effektiven Enabled-Zustand. `PATCH {scope, name, enabled}` schaltet einen Server
  an oder aus. `PUT {scope, servers}` schreibt die Liste.
- **Identität**: Alle drei Handler beginnen mit `requireIdentity` → 403, **vor**
  jeder Pfadableitung. `configPath(identity, scope, cwd)` löst den User-Scope über
  `resolveTenantAgentDir` auf: Admin = globales Prozessverzeichnis (Prozess =
  Admin), Nicht-Admin = `$HOME/$name/.omp/agent`. `validatedCwd` prüft den `cwd`
  aus dem Query gegen `getAllowedFileRoots(identity)` und wirft `Access denied` →
  403. Servernamen müssen auf `^[a-zA-Z0-9_.:-]{1,100}$` passen, Namen müssen
  eindeutig sein.
- **Rollen**: `scope: "user"` ist **Admin-only** (`requireUserScope` → 403), in
  `PUT` **und** `PATCH`. Die MCP-Konfiguration ist eine prozessweite
  Ausführungskonfiguration: `lib/rpc-manager.ts:1840` startet jede Session mit
  `getAgentDir()`, eine Mandantendatei würde nie gelesen. `scope: "project"`
  bleibt jedem Konto, dessen `cwd` die Wurzelprüfung besteht.
- **Darf nicht**: (a) **Nie ein Secret im Klartext liefern.** `redactNestedStrings`
  ersetzt jeden String unter einem Schlüssel, der auf
  `token|key|secret|password|credential|auth` passt, durch `••••••••`. Genau
  deshalb liest `PUT` die bestehende Datei vorher und braucht
  `restoreRedactedValues` — ein Redigieren ohne Wiederherstellen würde einen
  gepflegten Key bei jedem Speichern zerstören. (b) Ein vorhandenes ungültiges
  JSON darf nicht überschrieben werden (eigene Fehlermeldung mit Pfad). (c)
  `scope: "project"` ohne `cwd` ist ein Fehler. (d) **`loadCapability` filtert
  den User-Scope für Nicht-Admins** — es löst `~` über `os.homedir()` des
  Prozesses auf und würde die globale `mcp.json` sonst als *entdeckt*
  zurückgeben, unabhängig von `configPath`.
- **Ort**: `app/api/mcp/route.ts:15-85` (Begründung), `:160-177` (`configPath`),
  `:217-267` (Discovery-Filter), `:304-343` (Guards), `:345-447` (Handler)

### Plugins — `GET` / `POST` `/api/plugins`

- **Kann**: `GET` liefert Pakete, Gesamtzahlen und Diagnosen, gruppiert nach
  Extensions, Skills, Prompts und Themes. `POST` mit `action` ∈ `install` |
  `remove` | `update` | `disable` | `enable`.
- **Identität**: Roots aus `getAllowedFileRoots(getRequestIdentity(...))` gegen
  `body.cwd`, 403 bei `null`.
- **Darf nicht**: (a) Tools und Hooks nicht als eigene Zähler ausweisen — beides ist
  Code, den die Session lädt, und steht deshalb unter `extensions`; Kommando-Dateien
  stehen unter `prompts`, weil sie alle `/`-aufrufbarer Text sind. (b)
  `enabledFeatures === null` bedeutet „Manifest-Defaults", also jede Feature mit
  `default: true` — nicht „alles an". (c) Ein fehlgeschlagener Doctor darf die
  Liste nicht leeren: die Health-Checks sind beratend, ein Fehler dort ist kein
  Grund, die Pakete zu verstecken. (d) `cwd` aus dem Body nicht als Prüfmaßstab.
- **Ort**: `app/api/plugins/route.ts:137-200`

### Projekt-Vertrauensstatus — `GET` / `POST` `/api/project-trust`

- **Kann**: `GET` liefert `getProjectTrustStatus(cwd, getAgentDir())`. `POST`
  vertraut ein Projekt und zerstärt laufende RPC-Sessions dieses `cwd` — bzw.
  weist darauf hin, dass eine Session noch arbeitet.
- **Identität**: `validateCwd` prüft den `cwd` (aus Query oder Body) nach `resolve`
  und `stat` gegen die Identity-Roots.
- **Darf nicht**: (a) `cwd` nie zum Prüfmaßstab machen — der Aufrufer wählt ihn.
  (b) Das Zerstören der laufenden Sessions ist Absicht und darf nicht durch eine
  „tolerantere" Variante ersetzt werden: eine als vertrauend markierte Session
  darf nicht weiter auf untrusted Code laufen.
- **Ort**: `app/api/project-trust/route.ts:13-47`

### Skills lesen — `GET` `/api/skills`

- **Kann**: Nutzt omp' **eigene** Skill-Discovery — dieselbe `loadSkills`, die der
  AgentSession-Start ausführt — damit `.omp/skills`, `~/.omp/agent/skills`,
  `.claude/skills`, Plugin-Skills und `.agents/skills` mit identischer Präzedenz
  enthalten sind. Dazu die Install-Info.
- **Identität**: Roots aus `getAllowedFileRoots(getRequestIdentity(...))` gegen den
  `cwd`.
- **Darf nicht**: Eine zweite, eigene Skill-Discovery hier aufbauen. Zwei
  Entdeckungsordnungen sind zwei Wahrheiten über dieselbe Frage.
- **Ort**: `app/api/skills/route.ts:14-36`

### Skill umschalten — `PATCH` `/api/skills`

- **Kann**: Setzt `disable-model-invocation` in einer `SKILL.md` und liefert die
  neu gelesenen Skills zurück. Der Frontmatter wird geparst und die Zeile
  **chirurgisch** ersetzt, damit die YAML-Formatierung aller anderen Felder
  erhalten bleibt.
- **Identität**: **admin-only**. `getRequestIdentity` → 403, dann
  `isAdminIdentity` → 403, und zwar **vor** jeder Pfadprüfung.
- **Darf nicht**: (a) Die Pfadprüfung hier nicht als Absicht lesen: sie wäre
  Tautologie, denn die Admin-Prüfung entscheidet bereits. (b) `filePath` muss nach
  `basename` **und** nach `realpath` noch `skill.md` heißen und eine reguläre
  Datei sein — sonst umgeht ein Symlink oder `..` die Beschränkung. (c) Nicht den
  Skill-Bestand pro Mandant aufspalten. Er bleibt **ein** Bestand: eine
  `SKILL.md` ist Code, den alle Mandanten brauchen, und ein Bestand, den alle sehen
  aber nur der Betreiber ändert, ist ein gemeinsamer Bestand mit einem
  Verantwortlichen. Pro Nutzer würde jeder Mandant einen anderen Satz
  Instruktionen bekommen — und der Aufwand, denselben Bestand N-mal zu pflegen,
  wäre auch dann nicht zu rechtfertigen, wenn man die Mandantengrenze für sicher
  hält. Was einem Nicht-Admin bleibt, ist ohnehin schon da: eigene Skills im
  eigenen Projektverzeichnis (`<cwd>/.omp/skills`) über die `getAllowedFileRoots`-
  Prüfung, und Lesen des gemeinsamen Bestands über `GET`. (d) Für den
  Schreibpfad gehören die globale Skills-Root (`~/.agents/skills`) und
  `getAgentDir()` zur Menge: global installierte Skills werden dorthin symlinkt,
  das echte Ziel liegt sonst außerhalb.
- **Ort**: `app/api/skills/route.ts:38-120`

### Skills suchen, installieren, aktualisieren, prüfen — `/api/skills/search`, `/install`, `/update`, `/check`

- **Kann**: `search` ruft `npx skills find` und parst die Ausgabe (ANSI
  entfernt, Limit 1–50, Query maximal 200 Zeichen). `install` prüft das Paketformat
  `owner/repo@skill` (maximal 256 Zeichen). `update` baut die Argumente über
  `buildSkillUpdateArgs`. `check` vergleicht installierte Skills mit dem
  Registry-Stand.
- **Identität**: `install`, `update` und `check` prüfen `identity === null` → 403
  und danach die Roots. `search` prüft nur `isApiRequestAllowed`.
- **Darf nicht**: (a) **`scope: "global"` nur für Admin.** `npx skills add -g`
  schreibt in das `~/.agents` des **Prozesskontos** — es gibt kein Mandanten-`-g`,
  weil `npx` keine Identität kennt. Ein globaler Install durch einen Nicht-Admin
  würde den gemeinsamen Skill-Bestand verändern, und genau das ist die Folge der
  Entscheidung unter `PATCH /api/skills`. Ein Nicht-Admin installiert mit
  `scope: "project"` in sein eigenes Verzeichnis. (b) `scope: "project"` braucht
  zusätzlich `getProjectTrustStatus(...).trusted`. (c) `npx`-Ausgabe in
  Fehlerantworten muss durch `redactNpxOutput`, sonst landen Tokens im
  Response-Body.
- **Ort**: `app/api/skills/install/route.ts:16-54`, `app/api/skills/update/route.ts:13-46`,
  `app/api/skills/check/route.ts:11-45`, `app/api/skills/search/route.ts:93-95`

---

## Werkzeuge und Status

### Aktualisierung — `GET` / `POST` `/api/updates`

- **Kann**: `GET` liefert `getOmpWebUpdateStatus()` mit `Cache-Control: private,
  no-store`; ein Fehler wird als 502 mit Meldung beantwortet. `POST` installiert,
  wenn `status.install.canInstall`, sonst 409 mit dem Status. Die Antwort enthält
  `output`, `restartRequired`, `installedVersion` und `command`.
- **Identität**: nur `isApiRequestAllowed`. **Kein** `requireAdmin`, **kein**
  `isAdminIdentity`.
- **Darf nicht**: Faktisch, nicht als Regel: **jedes angemeldete Konto kann hier
  einen Update des Hosts auslösen.** Es gibt keinen Admin-Guard und keinen
  Session-Besitz-Check. Das ist kein Design, das im Code begründet wäre — anders
  als fast jede andere Route in diesem Dokument, und der Negativteil existiert
  genau für solche Fälle. Wer beim Refactoring einen Guard „hinzufügt", verändert
  das Sicherheitsmodell des Hosts; das ist eine Entscheidung, die man trifft und
  dokumentiert, keine Korrektur. (Ebenfalls verboten: `npx`-Ausgabe in
  Fehlerantworten ohne `redactNpxOutput`.)
- **Ort**: `app/api/updates/route.ts:8-63`

### Systemstatistik — `GET` `/api/system-stats`

- **Kann**: CPU-Auslastung in Prozent, Kernezahl, Speicher (gesamt, frei, belegt),
  `process.memoryUsage()`, Load-Average und GPU-Werte. Die CPU wird als Differenz
  zweier Samples über `hrtime.bigint()` berechnet; Busy-Zeit ist
  `user + nice + sys + irq` über alle Kerne, und `busyDelta` wird durch
  `elapsedDelta` **und** durch die Kernzahl geteilt. Der Vorab-Sample überlebt
  Modul-Reloads in `globalThis`.
- **Identität**: **keine**.
- **Darf nicht**: (a) Idle **nicht** in `busy` einrechnen. Grund: das macht busy und
  total ununterscheidbar und nagelt die Prozentzahl bei der Obergrenze fest,
  sobald alle Kerne mostly idle sind. (b) `cpuPercent` darf nicht `0` sein, solange
  kein Vorab-Sample existiert — der erste Wert ist `null`, weil eine Differenz
  gegen nichts keine Auslastung ist.
- **Ort**: `app/api/system-stats/route.ts:39-70`

### Home des Prozesses — `GET` `/api/home`

- **Kann**: Liefert `{home: os.homedir()}` — das Home des **Prozess**kontos.
- **Identität**: **keine**.
- **Darf nicht**: Das ist bewusst nicht mandantenfähig und darf nicht gelesen
  werden, als wäre es das eigene Home des Aufrufers. Das eigene Home kommt aus
  `/api/whoami` (`getUserHome(identity)`), für einen Nicht-Admin
  `/home/$username`. Beide auseinanderzuhalten ist der Punkt: `os.homedir()` ist
  die provisorische Fallback-Wurzel, die `getAllowedFileRoots` bei einem
  Nicht-Admin gerade durch die eigene Home ersetzt — ein stilles `/home` neben
  einem abweichenden `OMP_WEB_HOME_ROOT` wäre ein Fehler, der nur in der
  Testumgebung sichtbar ist.
- **Ort**: `app/api/home/route.ts:6-8`, `lib/file-access.ts:63-77`

---

## Provider-Anmeldung (`/api/auth/*`)

### Anbieterlisten — `GET` `/api/auth/providers`, `GET` `/api/auth/all-providers`

- **Kann**: `providers` listet die Anbieter, die eine OAuth-Login-Methode
  deklarieren (inklusive anthropic / Claude Pro-Max). `all-providers` listet die,
  die einen API-Key akzeptieren (inklusive Dual-Auth-Anbietern wie anthropic).
  Die Mitgliedschaft ist **capability-basiert**, nicht anbieterbasiert.
- **Identität**: **keine**. Nur der Proxy.
- **Darf nicht**: Nur die Fähigkeitsauskunft liefern — keinen konfigurierten
  Schlüssel und keinen Konto-Setup-Zustand. Das ist der Unterschied zwischen
  „dieser Anbieter kann das" und „dieser Anbieter ist angemeldet", und die zweite
  Frage gehört an `/api/auth/api-key/[provider]`.
- **Ort**: `app/api/auth/providers/route.ts:8-10`, `app/api/auth/all-providers/route.ts:8-10`

### API-Key-Status, setzen, löschen — `GET` / `POST` / `DELETE` `/api/auth/api-key/[provider]`

- **Kann**: `GET` liefert `{provider, displayName, configured, source, models}` und
  **niemals den Schlüssel**. `POST {apiKey}` schreibt über `AuthStorage.set` —
  omp speichert eine Zeile pro Credential in `agent.db`, und der Weg durch
  `AuthStorage` hält CLI und omp-web auf demselben Store und Lock — und
  invalidiert den Models-Cache. `DELETE` entfernt den Key.
- **Identität**: **keine**. Weder `getRequestIdentity` noch `isApiRequestAllowed`.
- **Darf nicht**: (a) Der **Status** ist erlaubt, der **Schlüssel** nie — das ist
  der ausdrückliche Vertrag dieser Route und der Grund für den Kommentar an der
  Getter-Signatur. (b) `DELETE` darf keinen OAuth-Login löschen: existiert ein
  OAuth-Credential, 409 „authenticated with OAuth, not an API key". (c) Ein
  unbekannter Provider wird mit 400 abgewiesen, **bevor** irgendetwas geschrieben
  wird. (d) Wie `/api/updates`: diese Routen schreiben in den `agent.db` des
  **Prozesskontos** und kennen keine Mandantengrenze. Für Nicht-Admins gilt das
  ohne Begründung im Code — vor dem Refactor bewusst entscheiden, nicht stillschweigend
  mitnehmen.
- **Ort**: `app/api/auth/api-key/[provider]/route.ts:10-60`

### OAuth-Login — `GET` / `POST` `/api/auth/login/[provider]`

- **Kann**: `GET` ist ein SSE-Strom für den OAuth-Fluss; der Abbruch des Clients
  wird über einen `AbortController` in `AuthStorage.login()` propagiert. `POST
  {token, code}` löst den im Speicher gehaltenen Callback für diesen Token auf.
- **Identität**: **keine**.
- **Darf nicht**: (a) Der `token` muss mit `provider-` beginnen — sonst könnte ein
  Token eines anderen Providers eingelöst werden. (b) Der Callback wird aus der
  Registry **gelöscht**, sobald er aufgelöst wurde: einmal, nicht wiederverwendbar.
  (c) `token` **und** `code` sind Pflicht (400 sonst). Die Registry ist ein
  `globalThis`-Map, damit Dev-Hot-Reload die laufenden Logins nicht verwirft.
- **Ort**: `app/api/auth/login/[provider]/route.ts:8-70`

### OAuth-Abmeldung — `POST` `/api/auth/logout/[provider]`

- **Kann**: Meldet einen OAuth-Provider ab und invalidiert Models-Cache und
  Runtime.
- **Identität**: **keine**.
- **Darf nicht**: Einen API-Key-Login nicht als OAuth abmelden — sind gespeicherte
  Credentials vorhanden, aber keins davon OAuth, 409. Und: ein unbekannter Provider
  400, nicht „erfolgreich abgemeldet".
- **Ort**: `app/api/auth/logout/[provider]/route.ts:7-27`

---

## Befunde aus `docs/known-findings.md` (Einschränkungen, keine Features)

- **IDOR `/api/sessions/[id]`**: ausführlich unter *Session-Detail* beschrieben.
- **`OMP_WEB_PASSWORD` schlägt das gespeicherte Passwort**: ausführlich unter
  *Passwortstatus* beschrieben. `resolveWebAuthPolicy()`
  (`bin/web-auth-store.js:504`) gibt der Environment-Variable Vorrang vor der
  Datei; am 12.10.2026 wurde damit kurzzeitig ein Testzugang gesetzt, wodurch das
  gespeicherte Passwort eines Betreibers außer Kraft gesetzt wurde.
- **Sessions überleben keinen Neustart**: `KEY_SALT` in
  `lib/web-auth-session.ts:47` ist `randomBytes(32)` und wird bei jedem Kaltstart
  neu erzeugt; auf agent-pc läuft der Dienst mit `Restart=always`, jeder Deploy
  meldet also ab. Der `SESSION_TTL_MS` von 24 Stunden ist die Obergrenze der
  Cookie-Lebensdauer und **keine** Zusage, dass eine Anmeldung den Tag übersteht.