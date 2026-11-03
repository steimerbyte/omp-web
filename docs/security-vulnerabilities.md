# Sicherheitsbefunde aus dem Audit vom 2026-11-03

Dieses Dokument hält die 21 Datensätze des Audits fest: den Mechanismus, die beobachtete oder aus dem Quelltext abgeleitete Ausnutzbarkeit, den Fix und den Nachweis. Geprüfter Quellstand des Audits war `15a24ff` (v0.22.2). Der Audit lief quelltextbasiert und ohne Ausführung des Ziels; deshalb steht er bei **0 confirmed, 20 needs_validation, 1 rejected** — die Spalte `Impact (Audit)` ist die redaktionelle Rangfolge des Audits, keine gemessene Schwere. Die Verifikation am 2026-11-03 bestätigte 17 Befunde durch Beobachtung, OMP-015 nur aus dem Quelltext und widerlegte OMP-008 und OMP-018 auf dem geprüften Pfad. v0.22.4 (`67d86f5`, Nachlauf `ebf3875`, Release 2026-11-03) behebt alle behebbaren Befunde; OMP-008 bekam keinen Fix, OMP-021 ist kein Befund. Die Abschnitte folgen der ID-Reihenfolge. „Beobachtet“ und „aus Quellanalyse abgeleitet“ sind getrennt; wo keine Beobachtung vorliegt, steht das dort. Zeilennummern beziehen sich auf `ebf3875`, maßgeblich sind die Symbole.

## Status

| ID | Kurztitel | Impact (Audit) | Status | Fix (Hauptdatei) |
|---|---|---|---|---|
| OMP-001 | `!`-Provider-Header werden als Shell-Kommandos ausgeführt | critical | behoben (v0.22.4) | `lib/model-discovery-auth.ts` |
| OMP-002 | Prozess-Provider-Schlüssel geht an eine vom Aufrufer gewählte `baseUrl` | high | behoben (v0.22.4) | `lib/model-discovery-auth.ts` |
| OMP-003 | Mandant schreibt operator-weiten MCP/SSH/Plugin-State über `execute_slash_command` | high | behoben (v0.22.4) | `lib/rpc-manager.ts` |
| OMP-004 | Jedes Konto mit cwd installiert prozessweite Plugins | high | behoben (v0.22.4) | `app/api/plugins/route.ts` |
| OMP-005 | Projekt-Scope-MCP folgt einem symlinkten `.omp` in die Prozess-`mcp.json` | high | behoben (v0.22.4) | `app/api/mcp/route.ts` |
| OMP-006 | `omp-cwd-*`-Symlink wird zur erlaubten Datei-Wurzel | high | behoben (v0.22.4) | `lib/file-access.ts` |
| OMP-007 | `filterLoads` vergleicht Linktext, Symlink lädt fremde Dateien in den Prompt | high | behoben (v0.22.4) | `lib/load-policy.ts` |
| OMP-008 | Laufende Session behält die Tool-Identität ihres Erzeugers | high | widerlegt (kein Fix) | — |
| OMP-009 | Inline-SVG läuft als aktives Dokument in der App-Origin | high | behoben (v0.22.4) | `app/api/files/[...path]/route.ts` |
| OMP-010 | Projekt-Trust entscheidet am cwd statt am Projekt-Root | medium | behoben (v0.22.4) | `lib/project-trust.ts` |
| OMP-011 | Code-Allowlist für untrusted Projekte ist das ganze Prozess-Home | medium | behoben (v0.22.4) | `lib/project-trust.ts` |
| OMP-012 | Git-Treiber werden nur aus `<cwd>/.git/config` und nur quoted gelesen | medium | behoben (v0.22.4) | `lib/git-safe.ts` |
| OMP-013 | Copy läuft als ungebundener synchroner Baumdurchlauf | medium | behoben (v0.22.4) | `lib/file-actions-tree.ts` |
| OMP-014 | DELETE läuft als ungebundene synchrone rekursive Löschung | medium | behoben (v0.22.4) | `lib/file-actions-tree.ts` |
| OMP-015 | Prompt-Pfad hat kein Turn-/Tool-/Spend-Budget | medium | behoben (v0.22.4) | `lib/session-run-budget.ts` |
| OMP-016 | 30-MiB-Deckel prüft nur `Content-Length` | medium | behoben (v0.22.4) | `lib/request-body.ts` |
| OMP-017 | Öffentliche Login-/Recovery-Bodies puffern vor jeder Prüfung | medium | behoben (v0.22.4) | `lib/web-access-body.ts` |
| OMP-018 | Leeres `OMP_WEB_ADMINS` fällt auf die Vorgabenamen zurück | medium | behoben (v0.22.4) | `bin/web-auth-store.js` |
| OMP-019 | Prüfung und Zugriff sind zwei Pfadauflösungen | low | behoben (v0.22.4) | `lib/file-access.ts` |
| OMP-020 | Login-Fehlerzeit verrät, ob ein Kontoname existiert | low | behoben (v0.22.4) | `lib/web-auth.ts` |
| OMP-021 | Tenant-Dateitools umgehen die Ressourcen-Autorisierung | — (verworfen) | verworfen (kein Befund) | — |

## Methodik

### Der Audit

Der Audit lief als sechsphasiger Cloudflare-Skill über 32 Prüfeinheiten (Auth-Kante, API-Autorisierung, Dateien/Schreiben/Git, Terminal/Sandbox, Agent-RPC/SSE/MCP, Projekt-Trust/Load-Policy, Secrets, Plugins/Skills, Rendering, Kalender, Ressourcen). Er durfte das Ziel nicht ausführen, kein Netzwerk benutzen und keine Deployment-Endpunkte kontaktieren; jede Prüfung war eine Quelltextlesung mit `artifact: null`. Die `confirmed`-Schwelle verlangt ein begrenztes beobachtetes Ergebnis, deshalb blieb jeder quelltextbelegte Datensatz `needs_validation`; die Impact-Spalte ist ausdrücklich eine redaktionelle Rangfolge. 20 Datensätze wurden in Phase 5 von je einem unabhängigen Verifier nachgeprüft; Korrekturen an Zitaten, an einem Live-Traffic-Plan und an einem Fixture, das den echten Plugin-Root berührt hätte, wurden übernommen. OMP-021 wurde vom Verifier verworfen und bleibt nur zur Nachvollziehbarkeit im Datensatz.

### Die Verifikation

Die Live-Verifikation lief am 2026-11-03 gegen die deployte v0.22.3 über einen SSH-Tunnel auf den Loopback-Port. Sitzungscookies wurden auf dem Host mit `issueSessionCookie()` gemintet und nie ausgegeben; jede Hypothese bekam eine einzige, minimale Anfrage. Marker waren harmlose `!touch`-Kommandos in temporären Pfaden; der Operator-Store wurde vorher per sha256 festgehalten und nach jedem Eingriff byte-identisch zurückgelegt, die Marker und Symlinks danach entfernt. Die lokale Verifikation lief aus einer `git archive HEAD`-Kopie mit symlinktem `node_modules`, einem Scratch-`HOME`, eigenem `OMP_WEB_HOME_ROOT`, `PI_CODING_AGENT_DIR` und `TMPDIR`, Dummy-Konten und einem Dev-Server auf Loopback; für OMP-009 wurde genau eine Headless-Chromium-Seite benutzt. Es gab keine Modellaufrufe, nur `ensure_session`. Die Aufräumprüfung belegte: keine Prozesse, Ports frei, Scratch-Verzeichnis entfernt. Ergebnis: 17 durch Beobachtung bestätigt, OMP-015 quelltextbestätigt, OMP-008 und OMP-018 auf dem geprüften Pfad widerlegt.

### Fix-Review und Test-Gate

Der Fix steckt in `67d86f5` (56 Dateien, +5152/−578) und dem Nachlauf `ebf3875`, der drei Wiring-Tests an die neuen Guards und Budgets anpasste. Ein unabhängiger Diff-Review trieb drei Nachbesserungen, die im Code sichtbar sind: `O_NONBLOCK` beim Öffnen (sonst blockiert ein FIFO den einzigen Bun-Thread schon im `open`, bevor `fstat` ablehnen kann), `GIT_CONFIG_GLOBAL=/dev/null` und `GIT_CONFIG_NOSYSTEM=1` bei der Treiberabfrage (sonst verliert git-lfs seine globalen Filter), und die Identität pro `send()` statt pro Session (sonst entscheidet der zweite Aufrufer über den ersten Slash-Befehl). Die volle Suite lief auf dem Deploy-Host gegen ein Baseline-Log: v0.22.4 zählte 1952 Tests in 226 Dateien mit 1941 bestandenen, 10 fehlgeschlagenen, 1 übersprungenen und 5 Fehlern (60,55 s); das Baseline-Log zählte 1831 Tests in 213 Dateien mit 1821 bestandenen, 9 fehlgeschlagenen, 1 übersprungenen und 4 Fehlern (60,19 s). Die fünf namentlich genannten Fehlschläge sind in beiden Läufen dieselben (Projekte-Löschen, Sandbox-/Unit-Umgebung); die beiden neuen Agent-Body-Testdateien brechen im vollen Lauf beim Import mit dem bekannten `Setting "extensions" is registered twice` ab (eine zweite jiti-Instanz, kein Produktpfad), weshalb ihre Assertions unten aus dem Quelltext zitiert und nicht als Lauf-Ergebnis ausgegeben werden.

### Live-Re-Probe nach dem Deploy (v0.22.4)

Nach `systemctl is-active = active` und Version 0.22.4 auf Platte wurden die folgenden Proben am 2026-11-03 gegen die laufende Instanz wiederholt. Mandantenkonto ist ein aktiviertes Nicht-Admin-Konto; das Cookie wurde auf dem Host gemintet und nie ausgegeben. Was hier nicht steht, wurde nach dem Deploy **nicht** erneut geprobt.

| Probe | Ergebnis |
|---|---|
| OMP-001/002, Mandant: `POST /api/models-config/discover` mit `headers.X-Probe = "!touch <marker>"` | HTTP 403 `{"error":"Administrator access is required."}`; Markerdatei nicht angelegt |
| OMP-001, Admin: derselbe Request | HTTP 400 `{"error":"\"provider.headers.X-Probe\" must not be a command value"}`; kein Marker |
| OMP-003, Mandant: `/mcp add --scope user -- /bin/true` über `execute_slash_command` | HTTP 200, `handled:true`, Output: `Refused: /mcp add --scope user needs administrator access; it writes user-scope state shared by every account.`; Operator-`mcp.json` sha256 vorher = nachher, kein Eintrag |
| OMP-005, Mandant: `GET /api/mcp?scope=project` mit `cwd/.omp` als Symlink auf das Operator-Agent-Verzeichnis | HTTP 403 `{"error":"Access denied"}`; kein Operator-Servername im Body |
| OMP-005, Mandant: `PUT /api/mcp` auf denselben cwd | HTTP 400 `{"error":"Access denied"}`; Operator-`mcp.json` sha256 vorher = nachher |
| OMP-006, Mandant: `GET /api/files/<home>/omp-cwd-YYYYMMDD/mcp.json?type=read`, wobei `omp-cwd-*` ein Symlink aus dem Home heraus ist | HTTP 403 `{"error":"Access denied"}` (Wurzel nicht freigegeben) |
| OMP-017, ohne Cookie: `POST /api/web-access/login` mit 5 155-Byte-JSON | HTTP 413 `{"error":"Request body is too large"}`, kein `Set-Cookie` |
| OMP-017, ohne Cookie: normaler Login-Body | HTTP 401 `{"error":"Sign-in failed. Check the password and try again."}`, kein `Set-Cookie` |
| OMP-016, Mandant: 32 505 856 Byte chunked an `POST /api/agent/<id>` (`Content-Type: application/json`) | HTTP 413 `{"error":"Request body is too large (30MB); attach fewer or smaller images","code":"prompt_rejected","accepted":false}`; Session blieb bei 0 Nachrichten, keine Sessiondatei |
| OMP-016, Mandant: derselbe Body an `POST /api/agent/new` | HTTP 413 `prompt_rejected`, `accepted:false`; keine Session angelegt |
| Regression Admin: `GET /api/mcp?scope=user` / `GET /api/files/.../mcp.json?type=read` / `GET /api/whoami` | 200 (JSON parst) / 200 (`application/json; charset=utf-8`, 492 Byte) / `isAdmin:true` |
| Regression Mandant: `GET /api/whoami` | 200, `isAdmin:false` |
| Endzustand | Operator-`mcp.json`-Hash unverändert, `ssh.json` weiterhin nicht vorhanden, Marker und beide Symlink-Pfade entfernt, Dienst `active`, `GET /` = 302 |

Zwei Präzisierungen: Exakt 30 MiB (31 457 280 Byte) chunked wurden vom Deckel **durchgelassen** — die Grenze ist strikt `>` — und scheiterten dann erwartungsgemäß am JSON-Parser mit HTTP 500; erst 31 MiB lösten 413 aus. Die Grenze greift also oberhalb von 30 MiB. Außerdem wartet bei `Content-Length: 31457281` ohne Body der Next-Proxy auf den angekündigten Body, bevor die Route läuft; der 413 der Route ist erst mit tatsächlich gestreamten Bytes beobachtbar. Das ist die dokumentierte Proxy-Klon-Grenze und kein Widerspruch zum Fix (siehe „Bekannte Grenzen“).

## OMP-001 — Modell-Proberouten führen `!`-präfixierte Provider-Header als Shell-Kommandos aus

**Impact (Audit):** critical · **Status:** behoben (v0.22.4) · **Fix:** `lib/model-discovery-auth.ts`, `app/api/models-config/discover/route.ts`, `app/api/models-config/test/route.ts`

**Mechanismus.** `POST /api/models-config/discover` und `POST /api/models-config/test` übernahmen ein beliebiges Provider-Objekt aus dem JSON-Body, schrieben es in eine temporäre `models.json` und ließen den SDK-`ModelRegistry` darüber laufen. `resolveModelDiscoveryAuth` rief `getApiKeyAndHeaders`; das SDK baute über `createConfigHeaderResolver` einen Resolver über die Request-Body-Header und gab jeden Header-Wert an `resolveConfigValue`. Dieses SDK-Feature führt jeden String, der mit `!` beginnt, über `/bin/sh -c` aus (ptree.exec, Server-cwd, kein Allowlist) — es ist für operatorgeschriebene `models.yml` gedacht, nicht für ein HTTP-Objekt. Beide Routen prüften nur `isApiRequestAllowed` (Host-Allowlist und Cross-Site-Schutz); `requireIdentity` existierte, wurde aber nicht aufgerufen. Der Discover-Pfad startete den Resolver sogar dann, wenn kein Schlüssel auflösbar war, und verwarf nur dessen Ausgabe.

**Ausnutzbarkeit.** Jedes authentifizierte Konto genügte; auf einer unverschlossenen Instanz auch ein anonymer Netzteilnehmer. **Beobachtet (live, vor dem Fix):** Ein Nicht-Admin sendete `provider.headers["X-Probe"] = "!touch <marker>"` an `/discover`; die Antwort war HTTP 500 mit `ECONNREFUSED` auf die tote `baseUrl`, aber die Markerdatei existierte danach als Dienstkonto, Modus 644 — das Kommando lief vor dem fehlgeschlagenen ausgehenden Fetch. Dieselbe Probe über `/test` legte den zweiten Marker an (HTTP 200, `ok:false`, `latencyMs:20001`). Beide Marker wurden entfernt. **Beobachtet (live, nach dem Fix):** Nicht-Admin 403 ohne Marker; Admin 400 mit Pfad `provider.headers.X-Probe` und ohne Marker.

**Fix.** `requireAdmin(req)` steht jetzt in beiden Routen vor dem Lesen des Bodys. Zusätzlich läuft `commandConfigValuePath` über das gesamte Provider- und Modellobjekt — nicht nur über Header — und lehnt den ersten `!`-String mit HTTP 400 und seinem Pfad ab; derselbe Check sitzt in `resolveModelDiscoveryAuth`, damit auch ein künftiger Aufrufer nicht an der Route vorbei kommt. Die Entscheidung fällt an der Grenze, an der ein HTTP-Objekt zur SDK-Konfiguration wird; der Helfer ist die letzte Stelle vor dem Resolver.

**Nachweis.** `app/api/models-config/discover/route.test.mjs` prüft: Mandant 403 und **keine** Anfrage an seine `baseUrl`; Aufruf ohne Identität 403; `!`-Header eines Mandanten wird nicht ausgeführt; `!`-Header und `!`-apiKey werden auch für den Admin mit 400 und `must not be a command value` abgelehnt; der Admin bekommt weiterhin Modelle und sein Key steht im Request. `app/api/models-config/test/route.test.mjs` prüft dieselben Fälle für die Testroute, inklusive `!`-Werten in Modell-Headern. `lib/model-discovery-auth.test.mjs` prüft die Pfadfindung in verschachtelten Feldern und dass der Resolver vor dem Kommando ablöst. Live-Probe nach dem Deploy: siehe Tabelle in der Methodik.

## OMP-002 — Modell-Discovery schickt die Prozess-Provider-Anmeldedaten an eine vom Aufrufer gewählte `baseUrl`

**Impact (Audit):** high · **Status:** behoben (v0.22.4) · **Fix:** `lib/model-discovery-auth.ts`, `app/api/models-config/discover/route.ts`, `app/api/models-config/test/route.ts`

**Mechanismus.** `resolveModelDiscoveryAuth` baute den `ModelRegistry` aus dem Aufrufer-Provider, löste die Anmeldedaten aber über den prozessweiten `getOmpRuntime().authStorage` auf — ein Agent-Verzeichnis für alle Konten, derselbe Store, in den `POST /api/auth/api-key/[provider]` schreibt. Die Auswahl erfolgt über den Provider-Namen; die `baseUrl` des Modells wird nur als Metadatum durchgereicht und schränkt die Credential-Auswahl nicht ein. Die Discover-Route baute aus `body.provider.baseUrl` den Endpunkt (`new URL` akzeptiert beliebige Schemata und Hosts, nur `/models` wird angehängt) und schickte den aufgelösten `Authorization`-Header dorthin. Die Testroute verdoppelte den Weg über `completeSimple` gegen das aufrufergewählte Modell und dieselbe `baseUrl`. Keine der beiden Routen band die Anmeldedaten an Identität oder Ziel.

**Ausnutzbarkeit.** Jedes authentifizierte Konto, auf einer unverschlossenen Instanz auch anonym; Voraussetzung war eine Prozess-Anmeldedaten für einen ratbaren Provider-Namen. `GET /api/auth/api-key/[provider]` meldet jedem identifizierten Aufrufer `configured`/`source` (ohne den Schlüssel), sodass Provider-Namen mit Prozess-Credential aufzählbar waren. **Beobachtet (lokal, vor dem Fix):** Ein Dummy-Credential für den Provider `dummy` und ein Loopback-Fixture zeigten im Fixture-Log `Authorization: Bearer <dummy>`; der Header-Hash war gleich `sha256("Bearer " + key)`. **Nicht live geprobt:** die Übertragung eines echten Prozess-Schlüssels. **Beobachtet (live, nach dem Fix):** derselbe Aufruf als Mandant ergibt 403, bevor ein Fetch entsteht.

**Fix.** Dieselbe Admin-Grenze wie OMP-001: Beide Proberouten sind admin-only, weil sie den prozessweiten Store benutzen und das Ziel aus dem Body kommt. Das ist eine Autoritätsgrenze, keine technische Bindung des Schlüssels an das Ziel: Der Fix verkleinert die Menge der Aufrufer auf das Betreiberkonto, er ändert nicht das Prozess-Schlüsselmodell. Die Route ist die letzte Stelle, an der ein HTTP-Aufrufer das Ziel wählt.

**Nachweis.** Dieselben Testdateien wie OMP-001; der entscheidende Fall ist „ein Mandant bekommt 403 und keine Anfrage an seine `baseUrl`“ mit `stub.calls.length === 0`. Die lokale Vorher-Beobachtung ist oben zitiert; die Live-Probe nach dem Deploy steht in der Methodik-Tabelle. Ein erneuter Credential-Transfer-Test nach dem Deploy fand bewusst nicht statt.

**Restrisiko/Grenze.** Der Prozess-Schlüssel bleibt prozessweit und die Ziel-`baseUrl` bleibt frei wählbar; ein Admin oder eine übernommene Admin-Sitzung kann den Schlüssel weiterhin an jeden Host schicken. `GET /api/auth/api-key/[provider]` verrät weiterhin jedem Konto, ob ein Provider einen Prozess-Schlüssel hat. Der Eintrag „Model keys are process-wide“ in `docs/known-findings.md` bleibt offen, bis ein identitätsspezifischer `AuthStorage` existiert.

## OMP-003 — Mandanten-Session liest und schreibt operator-weiten MCP/SSH/Plugin-State über `execute_slash_command`

**Impact (Audit):** high · **Status:** behoben (v0.22.4) · **Fix:** `lib/rpc-manager.ts`, `app/api/agent/[id]/route.ts`

**Mechanismus.** `POST /api/agent/[id]` prüfte nur `requireSessionAccess` (Identität plus Session-Besitz) und reichte den Body unverändert an den Wrapper. `executeAcpBuiltinSlashCommand` schlug den Namen in der statischen Builtin-Registry nach und rief jeden Handler mit einem Handle auf, ohne die Identität des Aufrufers zu fragen. `/mcp add --scope user` löst über `getMCPConfigPath("user")` nach `getAgentDir()/mcp.json` auf, `/ssh add --scope user` nach `getAgentDir()/ssh.json`, `/marketplace install` in den Prozess-Plugin-Baum und `/plugins enable|disable` in die globale Registry. Jede Session — auch eine Mandanten-Session — wird mit `agentDir = getAgentDir()` gebaut; die Mandanten-Konfiguration verschiebt nur die `Settings`, nicht diese Dateien. Auf der HTTP-Oberfläche war `scope=user` für Nicht-Admins bereits gesperrt; die Slash-Brücke war der zweite Transport, der dieselbe Datei ohne Rollenprüfung erreichte.

**Ausnutzbarkeit.** Ein Nicht-Admin mit einer Session im eigenen Home. **Beobachtet (live, vor dem Fix):** `/mcp add <probe> --scope user -- /bin/true` über `execute_slash_command` antwortete HTTP 200 mit `success:true` und `Added MCP server (user)`; der Operator-`mcp.json`-Hash änderte sich, der Probeserver stand mit `{type:"stdio",command:"/bin/true"}` in der Datei. Die Kontrolle über `PUT /api/mcp` mit `scope:"user"` ergab 403 — derselbe Effekt über einen anderen Transport. Der Store wurde byte-identisch zurückgelegt, `grep` auf den Probenamen war danach 0. **Beobachtet (live, nach dem Fix):** HTTP 200, `handled:true`, Output `Refused: /mcp add --scope user needs administrator access …`; Hash vorher = nachher, kein Eintrag.

**Fix.** `send(command, callerIdentity)` bindet die Identität bei **jedem** Dispatch als Argument, nicht als Feld am Wrapper: Zwei Aufrufer können sich überlappen, und ein Feld würde die Identität des zweiten über den ersten Slash-Befehl entscheiden lassen. Die Route liest sie aus den Proxy-Headern (nie aus dem Body) und reicht sie auf dem schnellen und dem kalten Pfad an `send`. Für Nicht-Admins prüft `operatorScopeSlashCommand` den Text: `/mcp enable|disable|reauth` und die Marketplace-/Plugin-Schreibverben sind immer operatorweit; `/mcp|/ssh add|remove|rm` nur, wenn der effektive Scope `user` ist. Die Parser sind dieselben wie im Builtin (`parseCommandArgs` stoppt Optionen an `--`; `parseNamedScopeArgs` defaultet auf `project`; ein unparsebarer Scope gilt fail-closed als `user`). Die Entscheidung liegt damit an der Dispatch-Grenze, nach der Session-Berechtigung und vor dem SDK-Handler, der die Prozesspfade auflöst.

**Nachweis.** `lib/rpc-manager.test.mjs` prüft: Eine Mandanten-Session wird für `/mcp add --scope user` (auch `--scope=user` und ohne Wert), `/mcp remove --scope user`, `/mcp enable|disable|reauth`, `/ssh add|remove --scope user`, `/marketplace remove` und `/plugins disable` mit `needs administrator access` abgelehnt und schreibt **keine** Datei in das Agent-Verzeichnis; `/mcp list` bleibt lesbar; Projekt-Scope (`--scope project`, ohne Scope, und ein `--scope user` hinter `--`) bleibt erlaubt und landet in `<cwd>/.omp/mcp.json`; ein Admin schreibt weiterhin User-Scope; der Gate folgt dem Aufrufer, nicht dem Erzeuger (auch bei veralteter Bindung und beim per-Dispatch-Argument). Der Route-Test prüft, dass `existing.send(body, identity)` und `session.send(body, identity)` die Identität aus den Headern bekommen und der Body keine Identität liefert. Live-Probe nach dem Deploy: siehe Methodik.

**Restrisiko/Grenze.** Die **lesenden** Verben bleiben absichtlich offen (`/mcp list`, `/ssh list`, `/marketplace installed`) und geben Metadaten aus dem Prozess-Store aus — Servernamen, URLs, Kommandopfade, SSH-Hosts/Benutzer/Ports —, weil jede Session mit dem Prozess-Agent-Verzeichnis startet. Der Fix schließt die Schreibpfade, nicht die Offenlegung. Der Gate gilt außerdem nur für `execute_slash_command`; andere RPC-Typen laufen nicht durch diese Prüfung.

## OMP-004 — Jedes Konto mit cwd kann prozessweite Plugins installieren, die in anderen Sessions laden

**Impact (Audit):** high · **Status:** behoben (v0.22.4) · **Fix:** `app/api/plugins/route.ts`

**Mechanismus.** `POST /api/plugins` autorisierte nur das übergebene `cwd` gegen die erlaubten Wurzeln des Aufrufers und baute dann `new PluginManager(body.cwd)`. `install`, `uninstall` und `setEnabled` schreiben aber `getPluginsDir()` — den gemeinsamen Plugin-Baum des Prozesskontos — und die globale Plugin-Lockfile; das `cwd` wählt nur Projekt-Overrides. Der Installationspfad rief `loadExtensions` auf den im Manifest deklarierten Einträgen auf, importierte also den Modul-Code des Pakets während der Installationsanfrage im Serverprozess, und trug das Paket anschließend mit `enabled: true` ein. Jede spätere Session jedes Kontos sammelt die aktivierten Plugins in der identitätsfreien Ambient-Discovery ein. Die Route hatte weder eine Rollen- noch eine Projekt-Trust-Prüfung; die Schwesterroute für globale Skills (`/api/skills/install`) verlangte bereits `isAdminIdentity`.

**Ausnutzbarkeit.** Ein Nicht-Admin, dessen Home in seinen erlaubten Wurzeln liegt (das ist jedes Konto). **Beobachtet (lokal, vor dem Fix):** Ein `install` von einem lokalen Git-Daemon wurde ohne Admin angenommen; `bun install` und `git clone` liefen; das Plugin landete im prozessweiten `<HOME>/.omp/plugins/node_modules/<paket>`; die Extension wurde bei der Installation und erneut beim Start der Session eines zweiten Kontos importiert (Cross-Account-Marker). Kein Live-Test vor dem Fix (Installation führt Zielcode aus). Nach dem Deploy keine erneute Probe.

**Fix.** `requireAdmin(req)` ist jetzt die erste Anweisung von `POST`, vor `isApiRequestAllowed`, vor dem Body und vor jeder Aktion. Der Guard steht am Einstieg, nicht in einem Zweig, damit eine später ergänzte Aktion ihn erbt. `GET` bleibt die Leseliste hinter der Root-Prüfung. Die Entscheidung liegt damit vor der einzigen Stelle, die Prozess-State mutiert und Fremdcode importiert.

**Nachweis.** `app/api/plugins/route.test.mjs` prüft: Für `install`, `update`, `remove`, `enable` und `disable` antwortet ein Tenant mit 403 und `Administrator access is required.`; der Admin passiert den Guard und erreicht die 400 `cwd required` (ohne einen Store anzufassen); eine Quelltext-Assertion belegt, dass `requireAdmin` vor `install`/`remove`/`setEnabled` steht und `GET` ihn nicht ruft. Die lokale Vorher-Beobachtung (Cross-Account-Import) ist oben zitiert. Nach dem Deploy keine erneute Probe.

**Restrisiko/Grenze.** Der Plugin-Baum bleibt prozessweit: Ein Admin-Install importiert weiterhin Fremdcode im Dienstprozess und lädt ihn in alle Sessions. Das ist die dokumentierte Folge der gemeinsamen Prozess-Identität, keine offene Rollenlücke mehr.

## OMP-005 — Projekt-Scope-MCP folgt einem symlinkten `.omp` in die Prozess-`mcp.json`

**Impact (Audit):** high · **Status:** behoben (v0.22.4) · **Fix:** `app/api/mcp/route.ts`

**Mechanismus.** `PUT /api/mcp` behandelte `scope=user` als admin-only, erlaubte `scope=project` aber jedem Konto, dessen `cwd` `validatedCwd` passierte. `validatedCwd` löste nur das `cwd` selbst auf und prüfte es gegen die Lesewurzeln; das Ziel wurde anschließend durch Anhängen von `.omp/mcp.json` gebildet. `mkdirSync(dirname(path), {recursive:true})` und der atomare Writer folgten dabei einem `.omp`, das ein Symlink auf das Prozess-Agent-Verzeichnis war. Ein Mandant konnte diesen Link in seinem Home anlegen (Agent-Bash oder ausgechecktes Projekt) und mit `scope=project` die globale `mcp.json` überschreiben; `restoreRedactedValues` setzte bei gleichem Servernamen sogar das echte Betreiber-Secret wieder ein. `GET` las über denselben Pfad die Betreiber-Server (redigiert) und gab sie als Projekt-Server zurück. Betreiber-Sessions mit aktiviertem MCP laden die Datei beim Start.

**Ausnutzbarkeit.** Ein Nicht-Admin mit schreibbarem `cwd`. **Beobachtet (live, vor dem Fix):** `GET /api/mcp?cwd=<projekt>` mit `.omp -> <operator-agent-dir>` lieferte HTTP 200 und den Betreiber-Server samt URL; `PUT` mit `scope=project` lieferte HTTP 200, der Operator-Hash änderte sich, und der Probeserver stand in der Datei. Der Store wurde byte-identisch zurückgelegt. **Beobachtet (live, nach dem Fix):** GET 403 `Access denied` ohne Betreiber-Servernamen; PUT 400 `Access denied`; Operator-Hash vorher = nachher.

**Fix.** `configPath` löst beide Scopes über den echten Pfad auf: Für einen Admin `resolvedPath` (auflösen, ohne Containment — ein dotfile-verwaltetes `mcp.json` darf ein normaler Link bleiben), für einen Nicht-Admin `resolvedPathInside` gegen das Agent-Verzeichnis bzw. den Projekt-Root. Ein unauflösbarer oder herausführender Pfad ergibt `undefined` und damit `Access denied` statt eines stillen Falls zurück auf den Linktext. Der zweite Leseweg, `addDiscoveredServers`, filtert User-Scope für Nicht-Admins und verwirft Projekt-Einträge, deren echter Pfad den Projekt-Root verlässt. Die Entscheidung fällt an der Stelle, an der der Scope zu einem Dateinamen wird, unmittelbar vor Lesen/Schreiben; der Discovery-Filter schließt denselben Befund auf dem zweiten Weg.

**Nachweis.** `app/api/mcp/route.test.mjs` prüft: Ein `.omp`-Symlink auf einen fremden Store ergibt für den Mandanten GET 403 (kein Fremdname im Body) und PUT 400 bei unveränderter Zieldatei; ein Admin darf sein `mcp.json` aus dem Agent-Verzeichnis heraus verlinken und schreibt durch den Link in das Ziel; ein Mandanten-Link auf eine fremde `mcp.json` ergibt 403 und lässt das Ziel unberührt; ein fremdes `cwd` ergibt auch für den Admin-Scope 400 und legt keine Datei an. Live-Probe nach dem Deploy: siehe Methodik.

## OMP-006 — `omp-cwd-*`-Symlink wird zur erlaubten Datei-Wurzel

**Impact (Audit):** high · **Status:** behoben (v0.22.4) · **Fix:** `lib/file-access.ts`

**Mechanismus.** `getAllowedFileRoots(identity)` las das Home des Aufrufers mit `readdirSync` und fügte jeden Eintrag mit dem Namen `omp-cwd-<YYYYMMDD>` als Lesewurzel hinzu — ohne `withFileTypes`, `lstat`, `realpath` oder eine Prüfung, ob das Ziel im Home liegt. `isExistingPathWithinRoots` löste anschließend jede Wurzel per `realpath` auf; ein Symlink-Eintrag wurde damit zu seinem Ziel, und das Ziel war fortan eine erlaubte Wurzel. `getWritableRoots` erbt dieselbe Menge; Lesen, Schreiben, Upload und der file-actions-DELETE liefen als Dienstkonto auf das Ziel. Den Symlink konnte der Mandant im eigenen Home anlegen, weil das Home als Lese- und Schreibwurzel dient und das Terminal es read-write bindet.

**Ausnutzbarkeit.** Ein Nicht-Admin mit schreibbarem Home. **Beobachtet (live, vor dem Fix):** Ein `omp-cwd-<datum>`-Symlink im Home zeigte auf ein Verzeichnis außerhalb; `GET /api/files/<home>/omp-cwd-<datum>/<datei>?type=read` lieferte HTTP 200 mit dem Inhalt der außerhalb liegenden Datei. Symlink und Zielverzeichnis wurden entfernt, `find` fand danach keinen `omp-cwd-*`-Link mehr. **Beobachtet (live, nach dem Fix):** Dieselbe Anfrage ergibt 403 `Access denied`; die Wurzel wird nicht freigegeben.

**Fix.** Der Scan akzeptiert einen Eintrag nur noch, wenn `lstatSync(candidate).isDirectory()` gilt **und** `realpathSync(candidate)` innerhalb des echten Home liegt; sonst wird er übersprungen. Die Wurzel wird weiterhin unter ihrem lexikalischen Pfad gespeichert, damit die späteren Realpath-Prüfungen unverändert funktionieren. Die Entscheidung fällt in der Funktion, die die Wurzelmenge baut — jede spätere Autorisierung wird gegen diese Menge gemessen, es gibt keinen zweiten Ort, an dem ein Link nachträglich hineinkäme.

**Nachweis.** `lib/file-access.test.mjs` prüft: Ein symlinkter `omp-cwd-*`-Eintrag steht nicht in den Wurzeln, ein echtes Verzeichnis schon; die lexikalische Vorprüfung ist für den Link wahr, die aufgelöste Prüfung falsch; eine Datei im echten Scratch-Verzeichnis bleibt lesbar. Live-Probe nach dem Deploy: siehe Methodik.

**Restrisiko/Grenze.** Die Wurzelmenge wird fünf Sekunden gecacht und die Wurzeln werden bei jeder Prüfung erneut aufgelöst. Ein zur Scan-Zeit echtes `omp-cwd-*`-Verzeichnis, das innerhalb dieses Fensters gegen einen Symlink ausgetauscht wird, wird bei der nächsten Prüfung als Ziel aufgelöst; nach Ablauf des Caches wird der Link beim nächsten Scan übersprungen. Das ist aus dem Quelltext abgeleitet, nicht gemessen.

## OMP-007 — `filterLoads` vergleicht Linktext, ein Symlink lädt fremde Dateien in den Prompt

**Impact (Audit):** high · **Status:** behoben (v0.22.4) · **Fix:** `lib/load-policy.ts`, `lib/project-trust.ts`

**Mechanismus.** Die Load-Policy behielt einen Kandidaten, solange sein Pfad-String unter dem Home des Mandanten lag: `isOperatorStore` gab `false` zurück, bevor die Betreiber-Wurzeln geprüft wurden, und `isInsideProject` verglich nur `resolve`/`relative` — also den Linktext, nicht das Ziel. Die SDK-Discovery folgt Symlinks: `loadStandaloneContextFiles` liest `<cwd>/AGENTS.md` per `stat` und `Bun.file(...).text()` durch den Link, Prompt-Templates laden symlinkte `.md`-Dateien, der Skill-Scan akzeptiert `entry.isSymbolicLink()`. Ein Projekt im Mandanten-Home konnte daher `AGENTS.md -> <operator-agent-dir>/AGENTS.md` oder auf die Datei eines anderen Mandanten zeigen; der Loader lieferte den Pfad unter dem Projekt mit dem Inhalt des Ziels, die Policy hielt ihn, und der Inhalt landete als `contextFiles` im Prompt. Der Mandanten-Zweig schloss außerdem nur die Betreiber-Wurzeln aus, nicht beliebige Ziele außerhalb des Projekts.

**Ausnutzbarkeit.** Ein Mandant, der eine Session in seinem Projekt startet (der `cwd` wird nur selbst realpath-geprüft, nicht die Dateien darin). **Beobachtet (lokal, vor dem Fix):** `alice/proj/AGENTS.md` war ein Symlink auf `bob/AGENTS.md`; `get_state.systemPrompt` enthielt den Marker `BOB-ONLY CONTEXT MARKER 7f3a9` aus der fremden Datei. Nach dem Deploy keine erneute Probe.

**Fix.** `isInsideProject` löst beide Seiten über `realPath` auf (jede existierende Komponente per `realpath`, ein nicht auflösbarer Link wird verweigert). `filterLoads` beurteilt jedes projektgebundene Load am echten Pfad und verwirft es für **jede** Identität, wenn der Pfad den mit `resolveProjectRoot(cwd)` bestimmten Projekt-Root verlässt; der Grund erscheint als `info`-Diagnostic, nicht als stiller Drop. `trustedProjectSkills` und `untrustedProjectSessionOptions` verwenden denselben aufgelösten Vergleich. Die Entscheidung fällt im Filter, bevor ein Kandidat zu `options.contextFiles`, einer Prompt-Quelle oder einem Extension-Pfad wird.

**Nachweis.** `lib/load-policy.test.mjs` prüft: Ein `AGENTS.md`-Symlink aus dem Projekt auf eine fremde Datei wird für den Mandanten **und** für den Operator verworfen, die eigene Datei bleibt, `withheld` ist 1, der Diagnostic nennt den Symlink. `lib/project-trust.test.mjs` prüft, dass Geschwisterverzeichnisse nicht als projektlokal gelten. `lib/project-skill-trust.test.mjs` prüft die Skill-Varianten (Unterverzeichnis folgt dem Repo-Root, `skills.customDirectories` schmuggelt nichts hinein). Die lokale Vorher-Beobachtung ist oben zitiert. Nach dem Deploy keine erneute Probe.

**Restrisiko/Grenze.** `SYSTEM.md` und `APPEND_SYSTEM.md` werden in `lib/session-system-prompt.ts` über `findConfigFile` gefunden und als Text gelesen; sie laufen nicht durch `filterLoads`. Ein Symlink an dieser Stelle kann weiterhin eine Datei außerhalb des Projekts in den Prompt ziehen, solange das Projekt nicht ohnehin trust-pflichtig und unvertraut ist. Das ist aus dem Quelltext abgeleitet, nicht gemessen.

## OMP-008 — Laufende Session behält die Tool-Identität ihres Erzeugers

**Impact (Audit):** high · **Status:** widerlegt (kein Fix) · **Fix:** — (kein Fix)

**Mechanismus.** `requireSessionAccess` lässt einen Aufrufer durch, wenn entweder `isRpcSessionVisibleTo` (Runtime-Owner-Map) oder `listAllSessions({identity})` (persistierte Session mit `cwd` unter dem Home des Aufrufers) passt. Für eine bereits laufende Wrapper-Session reichte der POST-Handler den Body ohne Vergleich zwischen Aufrufer und der beim Start eingefangenen `WebIdentity` an `existing.send` weiter. Die Kalender-Tools und der Shell-Guard werden einmal aus dieser Identität gebaut und nie pro Request neu abgeleitet, während `proxy.ts` `isAdmin` bei jeder Anfrage neu aus dem Account-Store liest. Ein Nicht-Admin konnte damit den Guard für eine laufende Admin-/Betreiber-Session passieren, deren persistierter `cwd` unter seinem Home lag; die Session behielt die Admin-Tools (Kalender auf dem Betreiber-Store, Shell-Guard ohne cwd-Bindung), und der Event-Stream gab ihm den laufenden Transcript. Eine Rollenänderung (Demotion) erreichte die laufende Session ebenfalls nicht.

**Ausnutzbarkeit.** Voraussetzung war eine **laufende, persistierte** Session, die ein Admin/eine Betreiber-Identität in einem Mandanten-Home gestartet hat, oder eine Demotion bei laufender Session. **Beobachtet (live, vor dem Fix):** Der minimale Pfad reproduzierte das nicht. Ein Admin konnte `POST /api/agent/new` mit `cwd` im Mandanten-Home erst nach `POST /api/cwd/validate` mit 200 anlegen; die Session war eine idle, **nicht persistierte** Wrapper-Session, sodass `listAllSessions({identity})` keine zeilenweise Besitzzuordnung hatte und die Runtime-Owner-Map den Admin nannte. Der Mandant bekam für `POST` und `GET /events` HTTP 404 `Session not found`; eine nicht existierende Kontroll-ID ergab dasselbe 404. Damit war der Befund **auf dem geprüften Pfad widerlegt**, nicht die Quellkette als solche.

**Fix.** Kein Fix. Der Befund war auf dem getesteten Pfad nicht auslösbar; der Audit-Datensatz wurde nicht in die Fixwelle aufgenommen. Die mit OMP-003 eingeführte Identität pro `send()` bindet nur den Slash-Gate an den Aufrufer; die Kalender-Tools und `makeSessionShellGuard` werden weiterhin aus `options.identity` bei der Erzeugung gebaut. Ein Fix müsste die Session-Autorität (nicht nur den Zugriff) pro Dispatch an den Aufrufer binden oder die cwd-basierte Besitzzuordnung für laufende Wrapper abschaffen.

**Nachweis.** Kein Test und keine Live-Probe nach dem Deploy. Die Widerlegung stützt sich auf den Vorher-Lauf: 404 für POST und Events, kein Session-File, kein `/api/sessions`-Eintrag, die idle Wrapper laufen nach zehn Minuten aus. **Nicht getestet:** eine persistierte Session-Datei mit `cwd` unter dem Mandanten-Home, die ein Admin live gestartet hat, und eine Demotion bei laufender Session. Für diese Zustände bleibt die Quellkette plausibel und ungeklärt.

**Restrisiko/Grenze.** Der Zustand ist weder belegt noch geschlossen. `isSessionOwnedBy` leitet Besitz aus dem `cwd` ab und geht davon aus, dass ein Nutzer keine Session in einem fremden Home anlegen kann; die Admin-Wurzel `/` bricht diese Annahme für den Live-Pfad. Solange die Session-Autorität an der Erzeugung hängt, ist die Frage für persistierte Admin-Sessions in Mandanten-Homes offen.

## OMP-009 — Inline-SVG läuft als aktives Dokument in der App-Origin

**Impact (Audit):** high · **Status:** behoben (v0.22.4) · **Fix:** `app/api/files/[...path]/route.ts`

**Mechanismus.** Der `read`-Zweig von `GET /api/files/[...path]` lieferte eine `.svg` als `image/svg+xml` über `streamFile` aus: `Content-Disposition: inline`, kein `Content-Security-Policy`, kein `nosniff`. Derselbe Routen-DOCX-Vorschau-Zweig setzte bereits eine strikte CSP — die aktive-Dokument-Policy existierte also nur für eine Vorschauart. Ein Markdown-Link mit `/api/`-Ziel bleibt nach der Sanitisierung ein normaler `target=_blank`-Anchor (die Dateilink-Auflösung überspringt `/api/`), und die `present_files`-Bildkarte verlinkt `?type=read` same-origin; beide erzeugen eine Top-Level-Navigation. Eine Mandanten-Session kann das SVG und den Link in ihrem eigenen Transkript platzieren; ein Admin, der die Session öffnet und klickt, führt das Skript mit seiner Sitzung in der App-Origin aus. Die SameSite=Lax-Cookie-Regel sendet das Sitzungscookie bei dieser same-site Navigation mit.

**Ausnutzbarkeit.** Ein Mandant pflanzt SVG plus Link; ein Admin/eine Betreiber-Identität öffnet und klickt. **Beobachtet (lokal, vor dem Fix, eine Headless-Chromium-149-Seite):** Die Antwort kam mit 200, `content-type: image/svg+xml`, `inline`, ohne CSP, `nosniff` und CORP; Chrome renderte das SVG als Dokument, das `<script>` lief, `fetch('/api/whoami')` antwortete 200, und `document.title` wurde zum Marker `SVG-EXEC:<benutzer>`. Eine Anfrage mit `Sec-Fetch-Site: cross-site` ergab 403 — der same-origin-Klick war der Weg. Nach dem Deploy keine erneute Probe.

**Fix.** `isActiveContent` erkennt `image/svg+xml`, `text/html`, `application/xhtml+xml` sowie `text/xml`/`application/xml`. Für diese Typen setzt `streamFile` `Content-Disposition: attachment`, `Content-Security-Policy: sandbox; default-src 'none'` und `X-Content-Type-Options: nosniff`; Rasterbilder und PDFs bleiben inline. Die Entscheidung fällt beim Schreiben der Antwort-Header, also an der letzten Stelle, bevor der Browser die Bytes als Dokument interpretieren könnte.

**Nachweis.** `app/api/files/[...path]/route.active-content.test.mjs` prüft: SVG kommt mit 200, `image/svg+xml`, `attachment`, exakt `sandbox; default-src 'none'` und `nosniff`, die Bytes werden weiterhin ausgeliefert; ein PNG bleibt `inline` ohne CSP/nosniff und die Bytes kommen aus dem autorisierten Deskriptor (auch im Range-Fall); ein Symlink innerhalb des Home bleibt lesbar. Die Chrome-Beobachtung ist oben zitiert. Nach dem Deploy keine erneute Probe.

## OMP-010 — Projekt-Trust entscheidet am cwd statt am Projekt-Root

**Impact (Audit):** medium · **Status:** behoben (v0.22.4) · **Fix:** `lib/project-trust.ts`, `lib/load-policy.ts`

**Mechanismus.** `getProjectTrustStatus` berechnete `requiresTrust` mit `hasTrustRequiringProjectResources(cwd)`, das nur `<cwd>/.omp|.agents|.claude/...` und `<cwd>/.omp/config.yml|settings.json` prüfte. Die Skill-Provider von omp laufen aber jeden Vorfahren bis zum Repository-Root ab (`.omp/skills`, `.agents/skills` und weitere Provider; `findRepoRoot` steigt bis zum Verzeichnis mit `.git`, ohne Repo bis zum Home). Eine Session in `<repo>/src` meldete deshalb `requiresTrust: false`, obwohl am Repo-Root `.agents/skills/evil/SKILL.md` lag; auf dem nicht-genarrowten Pfad wurde kein Skill-Filter gesetzt und die SDK-Discovery lud den Root-Skill ohne Dialog. Auf dem genarrowten Pfad behielt `trustedProjectSkills` außerdem Skill-Pfade außerhalb des cwd, sodass ein `skills.customDirectories`-Eintrag des Projekts überlebte.

**Ausnutzbarkeit.** Ein Mandant öffnet ein Repository-Unterverzeichnis (das `cwd`-Feld und die Custom-Path-Eingabe akzeptieren jedes Verzeichnis im Home); das Repository liefert die Anweisung, `src/` zu öffnen. **Beobachtet (lokal, vor dem Fix):** `repo/.agents/skills/evil/SKILL.md` und Session-cwd `repo/src`; `GET /api/project-trust?cwd=repo/src` antwortete `{requiresTrust:false,trusted:true}`, `GET /api/skills?cwd=repo/src` listete `evil` (`sourceInfo: agents:project`), und die Session in `src` hatte `evil` verfügbar. Nach dem Deploy keine erneute Probe.

**Fix.** `resolveProjectRoot(cwd)` steigt vom Sitzungsverzeichnis zum nächsten Verzeichnis mit `.git` oder `.omp` auf (ein Home-`.omp/agent` zählt nicht als Projektmarker) und stoppt unterhalb von Home und Temp-Wurzeln. `getProjectTrustStatus`, `trustProject`, `hasTrustRequiringProjectResources`, `trustedProjectSkills`, `untrustedProjectSessionOptions` und `filterLoads` entscheiden alle an diesem Root; `trustProject` speichert den realpath des Root, sodass eine Freigabe aus dem Unterverzeichnis überall im Projekt gilt. Die Entscheidung fällt vor jedem Load und ist zugleich der Schlüssel, unter dem die Freigabe persistiert wird.

**Nachweis.** `lib/project-trust.test.mjs` prüft: `repo/src` mit Root-Skill ergibt `requiresTrust:true`/`trusted:false`, `trustedProjectSkills` verwirft `evil`; `trustProject` aus `src` speichert den realpath von `repo`, danach liefert der Filter `undefined` (normaler Pfad). `lib/project-skill-trust.test.mjs` prüft, dass eine Session im Unterverzeichnis der Root-Entscheidung folgt, dass `skills.customDirectories` nichts schmuggelt und dass der Mandanten-Store eine untrusted Projekt-Skill nicht überlebt. Die lokale Vorher-Beobachtung ist oben zitiert. Nach dem Deploy keine erneute Probe.

**Restrisiko/Grenze.** `resolveProjectRoot` erkennt nur `.git` und `.omp`. Ein Verzeichnisbaum ohne diese Marker, dessen `.agents/skills` in einem Vorfahren liegt, wird weiterhin am cwd verankert; auf dem nicht-genarrowten Pfad gibt `trustedProjectSkills` dann `undefined` zurück und die SDK-Discovery entscheidet. Das ist aus dem Quelltext abgeleitet, nicht gemessen.

## OMP-011 — Code-Allowlist für untrusted Projekte ist das ganze Prozess-Home

**Impact (Audit):** medium · **Status:** behoben (v0.22.4) · **Fix:** `lib/project-trust.ts`

**Mechanismus.** `untrustedProjectSessionOptions` sollte den Code eines nicht vertrauten Projekts neutralisieren. Es baute aber `roots = [agentDir, homedir()]` und behielt jede konfigurierte Extension und jeden Custom-Tool-Pfad, der außerhalb des cwd und innerhalb einer dieser Wurzeln lag. Das SDK löst die im Projekt-Config genannten Extension-Pfade relativ zum cwd auf und fügt sie unbedingt hinzu; ein Projekt in `<repo>/src` mit `extensions: ['../evil.ts']` ergab also `<repo>/evil.ts`. Weil das Prozess-Home alle Projekte enthält, lag `<repo>/evil.ts` „innerhalb der Allowlist“ und wurde als `preloadedExtensionPaths` importiert und als Dienstkonto gebunden. Der Kommentar nannte `<agentDir>/extensions`, `~/.agents`, `~/.claude`, `~/.omp/plugins` „und nichts anderes“ — der Code meinte das ganze Home.

**Ausnutzbarkeit.** Ein Mandant öffnet ein nicht vertrautes Repository (Trust-Dialog abgelehnt oder nie ausgelöst). **Beobachtet (lokal, vor dem Fix):** Ein `repo/src/.omp/config.yml` mit `extensions: ['../evil.ts']` führte beim Session-Start `<repo>/evil.ts` aus (Marker geschrieben); die Datei lag im Prozess-Home und passierte deshalb den Filter. Der Live-Fall setzt voraus, dass `OMP_WEB_HOME_ROOT` unter dem Dienst-Home liegt; die Dokumentation empfiehlt genau das. Nach dem Deploy keine erneute Probe.

**Fix.** `userCodeRoots(agentDir)` ist die positive Allowlist: Agent-Verzeichnis, `~/.claude`, `~/.codex` und der Plugin-Baum — nicht `homedir()`. Wurzeln, die selbst im Projekt liegen, werden zusätzlich entfernt (`roots.filter(root => !isInsideProject(root, projectRoot))`). Die Entscheidung fällt im Trust-Options-Builder, bevor `loads.options` an `createAgentSession` weitergereicht wird; der Projekt-Root ist derselbe wie bei OMP-010.

**Nachweis.** `lib/project-trust.test.mjs` prüft: Ein Projekt-Config-Pfad unter dem Prozess-Home (`~/.cache/...`) und ein Symlink in `agentDir/extensions`, der aus dem Projekt herauszeigt, werden verworfen; nur die echte User-Extension in `agentDir/extensions` überlebt. `lib/load-policy.test.mjs` prüft denselben Fall über die Session-Optionen (`extensionPaths` enthält nur `op-ext.ts`). Die lokale Vorher-Beobachtung ist oben zitiert. Nach dem Deploy keine erneute Probe.

## OMP-012 — Git-Treiber werden nur aus `<cwd>/.git/config` und nur quoted gelesen

**Impact (Audit):** medium · **Status:** behoben (v0.22.4) · **Fix:** `lib/git-safe.ts`

**Mechanismus.** `GIT_ISOLATION_ARGS` schaltete Hooks, fsmonitor und externes Diff ab; `gitDriverOverrides(cwd)` ergänzte `-c filter.<name>.clean|smudge|process` und `-c diff.<name>.command|textconv` für Namen, die es aus `<cwd>/.git/config` per Regex las. Die Enumeration war an genau eine Datei und eine Syntaxform gebunden. In einem verlinkten Worktree ist `<worktree>/.git` eine Datei; `statSync(join(cwd,'.git','config'))` scheiterte mit `ENOTDIR`, die Funktion gab eine leere Liste zurück, und git las weiterhin die gemeinsame Config des Haupt-Repositories. Die veraltete, unquoted Form `[filter.demo]` matchte die Regex nicht, und `include.path`/`includeIf` wurde nicht verfolgt. Ein Repository, das ein Mandant schreiben darf, konnte so einen `clean`-Filter definieren, den `git status` beim Rehashen einer stat-dirty Datei als Dienstkonto ausführte.

**Ausnutzbarkeit.** Ein Mandant mit schreibbarem Repository unter einer erlaubten Wurzel, das er über `GET /api/git/status` prüfen lässt. **Beobachtet (lokal, vor dem Fix):** Drei Repositories unter dem Mandanten-Home, deren Clean-Filter je einen Marker schrieb, ergaben über `getGitStatus`/`gitIsolationArgs`: (a) die veraltete `[filter.demo]`-Form — Marker ×6; (b) ein Filter in einer per `include.path` eingebundenen Datei — Marker ×6; (c) ein verlinkter Worktree mit `.git`-Datei — Marker ×6. Eine quoted-Sektion wurde nicht separat als Kontrolle gefahren (die Regex trifft sie dem Quelltext nach). Nach dem Deploy keine erneute Probe.

**Fix.** `configuredDriverNames` fragt die effektive Repo-Config mit `git -C cwd config --list --name-only --includes -z` ab, mit `GIT_CONFIG_NOSYSTEM=1` und `GIT_CONFIG_GLOBAL=/dev/null`; damit kommen Repo-Config, deren Includes und `config.worktree`, aber keine globalen/System-Treiber. Jeder Treiber-Key (`filter.*.clean|smudge|process|textconv|command`) wird über `-c` neutralisiert; Namen mit Zeichen außerhalb `[A-Za-z0-9_.-]` (ein `=` lässt sich nicht als `-c`-Schlüssel schreiben) wandern in eine inhaltsadressierte Include-Datei in einem pro Prozess angelegten `mkdtemp`-Verzeichnis. Scheitert die Abfrage, wirft die Funktion und der git-Aufruf wird abgelehnt, statt ohne Overrides zu laufen. Die Entscheidung fällt unmittelbar vor jedem git-Aufruf über `gitIsolationArgs(cwd)`.

**Nachweis.** `lib/git-safe.test.mjs` prüft: Ohne Schutz läuft der fsmonitor-Hook (Fixture-Liveness); mit Schutz läuft kein Repo-Hook und `git status` bleibt korrekt; ein Repo mit `post-checkout`-Hook lässt sich weiterhin als Worktree benutzen; die veraltete unquoted `[filter.x]`-Sektion, ein `include.path`-Treiber (clean und textconv) und ein verlinkter Worktree mit `.git`-Datei werden abgeschaltet; ein Treibername mit `=` wird über die Include-Datei abgeschaltet; ein globaler Treiber (git-lfs-Fall) bleibt aktiv. Die lokale Vorher-Beobachtung ist oben zitiert. Nach dem Deploy keine erneute Probe.

**Restrisiko/Grenze.** Globale und System-Treiber bleiben absichtlich aktiv; ein Mandant kann sie nicht schreiben, aber ein kompromittiertes Dienstkonto schon. Die Abfrage startet einen zusätzlichen `git config`-Prozess pro git-Aufruf (Timeout 5 s) und lehnt bei Fehlschlag ab — das ist eine Verfügbarkeits-, keine Vertraulichkeitsgrenze (siehe „Bekannte Grenzen“).

## OMP-013 — Copy läuft als ungebundener synchroner Baumdurchlauf

**Impact (Audit):** medium · **Status:** behoben (v0.22.4) · **Fix:** `lib/file-actions-tree.ts`, `app/api/file-actions/[...path]/route.ts`

**Mechanismus.** `POST /api/file-actions/<src>?type=copy` nahm die Quelle aus der URL und das Ziel aus dem Body; `authorizeTransfer` verlangte nur, dass die Quelle lesbar und das Ziel schreibbar ist. `treeSize` lief rekursiv mit `lstatSync`/`readdirSync` über den ganzen Baum, **bevor** `MAX_COPY_BYTES` (512 MiB) verglichen wurde. Einträge, die weder reguläre Datei noch Verzeichnis waren, zählten 0 Bytes; ein Baum aus leeren Dateien oder Verzeichnissen oder ein FIFO umging den Byte-Deckel, während `copyTree` pro Eintrag ein `mkdir`/`copyFileSync` ausführte. Beide Durchläufe liefen synchron in dem einen `next start`-Prozess, der auch alle SSE-Streams und In-Process-Agent-Sessions hostet.

**Ausnutzbarkeit.** Jedes authentifizierte Konto mit einem Verzeichnis in seinen Schreibwurzeln (mindestens Tiefe 2 unter dem Home, weil die geschützte-Tree-Regel direkte Kinder ablehnt). **Beobachtet (lokal, vor dem Fix):** 20 021 Einträge unter dem Mandanten-Home, ein Copy-Request; HTTP 200 nach **1023 ms**, die 10-ms-Sonde gegen `/api/whoami` sah **813 ms** maximale Loop-Lücke (Baseline max. 284 ms), zwei Sonden während des Requests lagen über 100 ms. Der Baum wurde entfernt. Nach dem Deploy keine erneute Probe.

**Fix.** `inspectTree` läuft asynchron und iterativ über einen expliziten Stack, zählt Einträge, Tiefe, Bytes und Zeit und wirft `TreeRefusal`, sobald eine Grenze überschritten wird — **bevor** der erste Schreibzugriff passiert. Für Copy gelten 50 000 Einträge, 64 Ebenen, 512 MiB und 10 s; `copyTree` arbeitet mit `fs/promises`, kopiert Symlinks als Links und lehnt FIFOs, Sockets und Geräte ab. Die Entscheidung fällt vor dem ersten Write auf demselben Baum, den der Copy danach läuft; die asynchronen Primitive geben den Loop zwischen den Einträgen frei.

**Nachweis.** `app/api/file-actions/limits.test.mjs` prüft: ein kleiner Baum kopiert und der Copy löscht; ein zu tiefer Baum wird vor dem Copy **und** vor dem Delete mit 422 abgelehnt, ohne Teilziel bzw. ohne Löschung; die benannten Grenzen sind die der Route; der Eintragsdeckel greift vor dem Copy, nicht beim Delete; der Byte-Deckel greift vor dem Copy, auch bei einer einzelnen zu großen Datei; das Zeitbudget stoppt den Walk; ein FIFO wird beim Copy abgelehnt und beim Delete erlaubt; `copyTree` lehnt einen nach dem Walk erschienenen FIFO ab; eine Quelltext-Assertion belegt asynchrone Primitive und die Reihenfolge „Cap zuerst“. Die lokale Vorher-Beobachtung ist oben zitiert. Nach dem Deploy keine erneute Probe.

**Restrisiko/Grenze.** Das 10-s-Budget wird zwischen den Einträgen geprüft; ein einzelner langsamer `copyFile` kann es überschreiten. Es gibt keine per-Konto-Concurrency-Grenze, und 50 000 Einträge bleiben Sekunden Arbeit (die Fix-Notiz misst 1184 ms für 20 200 Einträge bei 34,1 ms maximaler Loop-Lücke, auf dem Arbeitsrechner am 2026-11-03 mit 12 Kernen und Last 5,19).

## OMP-014 — DELETE läuft als ungebundene synchrone rekursive Löschung

**Impact (Audit):** medium · **Status:** behoben (v0.22.4) · **Fix:** `lib/file-actions-tree.ts`, `app/api/file-actions/[...path]/route.ts`

**Mechanismus.** `DELETE /api/file-actions/<pfad>` verlangte eine Identität, prüfte das Ziel mit `isWritePathAllowed({mustExist:true})`, verweigerte geschützte Bäume und die Dateisystem-Wurzel und rief dann `fs.rmSync(target, {recursive:true, force:false})` synchron auf. Es gab keine Eintrags-, Tiefen-, Zeit-, Concurrency- oder Worker-Grenze; `MAX_COPY_BYTES` galt nur im Copy-Zweig und wurde von DELETE nie gelesen. Die Projekt-Dashboard-Vorschau zählte bis 200 000 Einträge, warf bei Überschreitung aber nur `entriesTruncated` weg, statt den Delete zu verweigern. Der Handler lief im selben JS-Thread wie alle SSE-Streams und Agent-Sessions, sodass der Heartbeat und fremde Live-Ausgaben während der Löschung nicht liefen.

**Ausnutzbarkeit.** Jedes authentifizierte Konto mit einem existierenden Ziel in seinen Schreibwurzeln, mindestens Tiefe 2 unter dem Home. **Beobachtet (lokal, vor dem Fix):** 20 021 Einträge, ein DELETE; HTTP 200 nach **825 ms**, die 10-ms-Sonde sah **552 ms** maximale Loop-Lücke (Baseline max. 295 ms). Der Baum wurde entfernt. Nach dem Deploy keine erneute Probe.

**Fix.** DELETE löst zuerst den echten Pfad auf, prüft ihn erneut gegen die Schreibwurzeln und die geschützten Bäume (auch den aufgelösten Pfad), entfernt einen Symlink als Link per `unlink` und ruft für alles andere `inspectTree(resolved, "delete", treeDeadline())` auf — Tiefe 64 und 10 s, **ohne** Eintragsdeckel — und danach `fs.promises.rm(resolved, {recursive:true, force:false})`. Die Entscheidung fällt unmittelbar vor der Löschung und auf dem Objekt, das tatsächlich verschwindet; das asynchrone `rm` blockiert den Loop nicht.

**Nachweis.** `app/api/file-actions/limits.test.mjs` prüft: Ein zu tiefer Baum wird vor dem Delete mit 422 abgelehnt und bleibt unverändert; der Eintragsdeckel gilt beim Delete nicht; ein Symlink wird als Link gelöscht, sein Ziel überlebt; ein Delete durch ein symlinktes Verzeichnis entfernt den aufgelösten Ordner. Die lokale Vorher-Beobachtung ist oben zitiert. Nach dem Deploy keine erneute Probe.

**Restrisiko/Grenze.** `inspectTree` begrenzt nur den Prüf-Walk; das anschließende `fs.promises.rm` hat keine Deadline und kann bei sehr großen Bäumen lange den Thread-Pool beschäftigen. Es gibt keine per-Konto-Concurrency-Grenze; der Eintragsdeckel ist bewusst ein Copy-Budget.

## OMP-015 — Prompt-Pfad hat kein Turn-/Tool-/Spend-Budget

**Impact (Audit):** medium · **Status:** behoben (v0.22.4) · **Fix:** `lib/session-run-budget.ts`, `lib/rpc-manager.ts`

**Mechanismus.** `POST /api/agent/[id]` prüfte nur den Session-Zugriff und reichte den Body an `AgentSessionWrapper.send`; der `prompt`-Fall rief `inner.prompt(...)` ohne Budget. `startRpcSession` übergab weder `deadline` noch `costGate` an `CreateAgentSessionOptions`; die Session baute ihren `CostGate` aus den `Settings`, `session.maxCost` ist per Default `undefined`, und omp-web setzt es nie — der Gate ließ also jede Anfrage durch. Ein Goal-Modus setzte Fortsetzungen über einen 800-ms-Timer und `promptCustomMessage` fort; die Idle-Abschaltung (10 Minuten) wurde durch jede laufende Fortsetzung zurückgesetzt. Alle Prompts rechneten gegen den prozessweiten `ModelRegistry`/`AuthStorage`, also gegen die Betreiber-Credentials; `POST /api/agent/new` hatte zusätzlich keine per-Konto-Grenze für laufende Sessions oder Erzeugungsrate.

**Ausnutzbarkeit.** Jedes authentifizierte Konto mit einer eigenen Session; der Effekt ist verbrauchte Betreiber-Kontingenz und Host-Last, kein Datenzugriff. **Aus Quellanalyse abgeleitet (quelltextbestätigt, nicht ausgeführt):** Der Prompt-Pfad hatte keinen Zähler, der Goal-Loop keine Abbruchbedingung außer „keine Tool-Calls“, und `CostGate.check` gab bei fehlendem `session.maxCost` `undefined` zurück. Ein Verhaltenstest mit einem Stub-Provider fand nicht statt (keine Modellaufrufe in der Verifikation). Nach dem Deploy keine erneute Probe.

**Fix.** `SessionRunBudget` zählt pro Lauf die `turn_start`-Frames (eine Modellanfrage pro Frame), mit `DEFAULT_RUN_BUDGET_LIMITS` = 400 Anfragen und 45 Minuten; der Wanduhr-Timer wird beim Start des Laufs armiert. Ein Steer teilt den laufenden Lauf, ein neuer Prompt startet ein frisches Budget; eine Goal-Fortsetzung startet einen frischen Lauf, aber **kein** frisches Goal-Budget. Für die Goal-Lebensdauer läuft ein zweites Budget mit denselben Grenzen, das Fortsetzungen nicht zurücksetzen und das `/goal resume` neu armiert. Bei Erschöpfung emittiert der Wrapper genau eine `prompt_error`-Meldung und geht durch denselben Abbruchpfad wie der Abort-Knopf (`goalMode.onAbort()` plus `inner.abort()`); der Zähler sitzt in der Event-Schleife des Wrappers, weil nur sie jede Session und jeden Lauf sieht.

**Nachweis.** `lib/session-run-budget.test.mjs` prüft: exakt `maxRequests` Frames sind erlaubt, der nächste beendet den Lauf; alte Tokens und Frames eines beendeten Laufs zählen nicht in den nächsten; die Wanduhr beendet einen Lauf ohne weitere Anfrage; `end()` löscht den Timer; die Produktionsdefaults sind großzügig. `lib/rpc-manager.test.mjs` prüft: Der Cap bricht den Lauf ab und ein Steer teilt das Budget; ein neuer Prompt startet bei null; die Wanduhr bricht ab, statt weiterzustreamen; ein kurzer Lauf hinterlässt keinen Timer; eine Goal-Kette wird über die Goal-Lebensdauer begrenzt (Abbruch mit „Goal paused after …“) und ein neues Goal startet ein frisches Budget. Die Quellanalyse ist oben zitiert. Nach dem Deploy keine erneute Probe.

**Restrisiko/Grenze.** Das Budget ist pro Lauf und pro Goal, **nicht pro Konto**: Ein neuer Prompt oder eine neue Session startet ein frisches Budget, und `POST /api/agent/new` hat weiterhin keine Konto-Concurrency-Grenze. `turn_start` unterzählt In-Turn-Provider-Re-Samples (der Code markiert das als Shortcut; die Wanduhr begrenzt sie). Ein `session.maxCost`/Kosten-Cap existiert weiterhin nicht; 400 Anfragen sind eine Arbeits-, keine Geldgrenze.

## OMP-016 — 30-MiB-Deckel prüft nur `Content-Length`

**Impact (Audit):** medium · **Status:** behoben (v0.22.4) · **Fix:** `lib/request-body.ts`, `app/api/agent/[id]/route.ts`, `app/api/agent/new/route.ts`

**Mechanismus.** Die Agent-Route begrenzte den Prompt-Body über die damalige `declaredBodyLength()`, die für einen fehlenden, doppelten oder nicht-numerischen `Content-Length` `null` zurückgab; der 413-Zweig lief nur bei einem auswertbaren, zu großen Header. Ein chunked Body oder ein kaputter Längenheader fiel deshalb bis zu `req.json()` durch, das den ganzen Body las und parste. Die einzige verbleibende Transportschranke war der Next-Proxy-Klon von 104 MB, der bei Überschreitung still endet statt abzulehnen. `requireSessionAccess` lief vor der Größenprüfung, die Bypass-Möglichkeit bestand also für jedes Konto, das eine Session erreichen konnte, nicht für anonyme Aufrufer.

**Ausnutzbarkeit.** Ein Konto mit Zugriff auf eine Session. **Beobachtet (lokal, vor dem Fix):** Derselbe 60-MB-JSON-Body ergab mit `Content-Length: 62914589` HTTP 413 `prompt_rejected`; identisch chunked (ohne Header) ergab HTTP 200, und der Befehl wurde ausgeführt. **Beobachtet (live, nach dem Fix):** 32 505 856 Byte chunked an `/api/agent/<id>` ergaben 413 `prompt_rejected` bei 0 Nachrichten und ohne Sessiondatei; derselbe Body an `/api/agent/new` ergab 413 und keine Session. Exakt 30 MiB (31 457 280 Byte) wurden durchgelassen (Grenze strikt `>`), erst 31 MiB lösten 413 aus.

**Fix.** `readJsonBodyWithinLimit` prüft zuerst einen auswertbaren `Content-Length` und lehnt ohne Lesen ab. Fehlt er, liest der Reader den Stream selbst, bricht beim Überschreiten von `maxBytes` ab, cancelt den Reader und wirft `RequestBodyTooLargeError`; erst danach wird der gesammelte Body als JSON geparst. Beide Agent-Routen (`[id]` und `new`) benutzen denselben Reader mit `MAX_AGENT_REQUEST_BODY_BYTES` = 30 MiB und antworten in der bekannten `prompt_rejected`-Form mit 413. Die Entscheidung fällt an der einzigen Stelle, die die tatsächlich ankommenden Bytes zählt; der Proxy kann das nicht, weil sein Limit still abschneidet.

**Nachweis.** `lib/request-body.test.mjs` prüft: ein Body unter dem Limit wird akzeptiert; ein deklariert zu großer Body wird ohne Lesen abgelehnt (`state.reads` bleibt 0); ein chunked Body wird nach der zweiten Überschreitung abgebrochen und gecancelt, nicht weitergelesen; ein chunked Body ohne `Content-Length` wird akzeptiert; ein kaputter `Content-Length` wird ignoriert, aber die Bytes werden weiterhin begrenzt; `declaredContentLength` akzeptiert nur einfache Ganzzahlen. `app/api/agent/agent-body-limit.test.mjs` prüft 413 ohne Ausführung für chunked und deklariert zu groß sowie 200 für einen Body unter dem Limit; `app/api/agent/new/body-limit.test.mjs` prüft 413 vor der cwd-Prüfung und Durchlass unter dem Limit. **Caveat:** Beide Agent-Body-Testdateien brachen im vollen v0.22.4-Suite-Lauf beim Import mit `Setting "extensions" is registered twice` ab (zweite jiti-Instanz, kein Produktpfad); ihre Assertions sind hier aus dem Quelltext zitiert, nicht als Lauf-Ergebnis. Die lokalen und die Live-Nachher-Beobachtungen stehen oben.

**Restrisiko/Grenze.** Der Reader hält die Chunks plus den geparsten Blob, also etwa die doppelte Body-Größe im Speicher — bei 30 MiB rund 60 MiB pro gleichzeitigem Request. Die Grenze ist strikt `>`; exakt 30 MiB gehen an den JSON-Parser. Der Proxy-Klon bleibt bestehen (siehe „Bekannte Grenzen“).

## OMP-017 — Öffentliche Login-/Recovery-Bodies puffern vor jeder Prüfung

**Impact (Audit):** medium · **Status:** behoben (v0.22.4) · **Fix:** `lib/web-access-body.ts`, `app/api/web-access/login/route.ts`, `app/api/web-access/recovery/route.ts`

**Mechanismus.** `POST /api/web-access/login` und `POST /api/web-access/recovery` sind die beiden öffentlichen JSON-Endpunkte, die `proxy.ts` ohne Credential durchlässt. Beide riefen `req.json()` **vor** `verifyCredential` bzw. vor Status- und Aktionsprüfung und hatten keine eigene Größenprüfung. Der einzige konfigurierte Deckel war `experimental.proxyClientMaxBodySize = 104 MB`; Next normalisiert ihn auf 109 051 904 Byte und benutzt ihn als Klonfenster: `cloneBodyStream` schiebt jeden Chunk in zwei `PassThrough`-Streams und beendet beide beim Überschreiten still, statt einen Fehler zu liefern. Der Klon entsteht für jede Nicht-GET/HEAD-Anfrage, bevor `proxy.ts` läuft — ein unauthentifizierter Body wurde also gepuffert, bevor die Route ihn ansah, und die 150-ms-Pause der Login-Route bzw. die 429 der Recovery-Route kamen danach.

**Ausnutzbarkeit.** Jeder unauthentifizierte Netzteilnehmer. **Beobachtet (lokal, vor dem Fix):** 2 MiB in 20 Chunks an den Login; `text/plain` ergab 415 erst nach allen 2 150 400 Byte, `application/json` ergab 400 erst nach dem vollen Body. Der RSS-Delta war verrauscht (38,5 MB bzw. 2,4 MB); belegt ist, dass die Route den Body vollständig konsumierte, bevor sie antwortete. **Beobachtet (live, nach dem Fix):** Ein 5 155-Byte-JSON an den Login ergab 413 `{"error":"Request body is too large"}` ohne `Set-Cookie`; ein normaler Login-Body ergab 401 mit der generischen Meldung und ohne `Set-Cookie`.

**Fix.** Beide Routen lesen über `readJsonBodyWithinLimit` mit `MAX_CREDENTIAL_REQUEST_BODY_BYTES` = 4 KiB und antworten bei Überschreitung mit `CREDENTIAL_BODY_TOO_LARGE` (413), bevor der Credential-Store oder ein Recovery-Code angefasst wird. Der Reader zählt die tatsächlich ankommenden Bytes, begrenzt also auch chunked Requests ohne `Content-Length`. Die Entscheidung fällt am Eingang der beiden einzigen unauthentifizierten Routen; der Proxy-Deckel ist dafür keine Ablehnung.

**Nachweis.** `app/api/web-access/login/route.body-limit.test.mjs` prüft: Ein chunked Body über dem Deckel ergibt 413, bevor `verifyCredential` läuft; ein deklarierter Riesen-Body ergibt 413 ohne Lesen; ein normales Login funktioniert weiter, und die 413-Antwort nennt kein Konto; kaputtes JSON bleibt 400. `app/api/web-access/recovery/route.test.mjs` prüft dieselben Fälle für die Recovery-Route, inklusive „kein Code gemintet“. Die lokale Vorher- und die Live-Nachher-Beobachtung stehen oben. Nach dem Deploy wurden nur diese beiden Proben wiederholt.

**Restrisiko/Grenze.** Der Next-Klon bis 104 MB bleibt bestehen und schneidet still ab; die Route liest 4 KiB und antwortet, aber der Klon ist keine Ablehnungsschicht. Das ist die gemeinsame Proxy-Grenze (siehe „Bekannte Grenzen“).

## OMP-018 — Leeres `OMP_WEB_ADMINS` fällt auf die Vorgabenamen zurück

**Impact (Audit):** medium · **Status:** behoben (v0.22.4) · **Fix:** `bin/web-auth-store.js`

**Mechanismus.** `resolveAdminUsernames` und `hasEnvironmentAdminList` prüften beide `raw.trim().length > 0`. Ein ausdrücklich leeres oder nur aus Trennzeichen bestehendes `OMP_WEB_ADMINS` war damit von einer ungesetzten Variable nicht zu unterscheiden und fiel auf `DEFAULT_WEB_ADMIN_USERNAMES` zurück. Für ein Konto ohne explizites `isAdmin`-Feld — `createWebAccount` schreibt keines, und Altkonten haben keines — entschied `accountIsAdmin` über die Vorgabenamen; für einen Namen, der nicht in der Kontendatei steht (auch den Einzelbenutzer-Namen), entschied `isAdminUsername` genauso. `proxy.ts` setzte daraus `x-omp-admin: 1`, und `requireAdmin`/`isAdminIdentity` akzeptierten das als hostweite Adminrechte. Die Dokumentation (`docs/inventory-auth.md`) versprach dagegen, ein leeres `OMP_WEB_ADMINS` bedeute „niemand ist Admin“.

**Ausnutzbarkeit.** Nur wenn die Unit `OMP_WEB_ADMINS` ausdrücklich leer setzt **und** ein Konto ohne `isAdmin`-Feld einen Vorgabenamen trägt oder der Einzelbenutzer-Name in der Vorgabeliste liegt. **Beobachtet (live, vor dem Fix):** Die Unit, die Environment-Datei und das Prozess-Environment setzten `OMP_WEB_ADMINS` **nicht** (nicht leer — abwesend); die Konten hatten kein `isAdmin`-Feld, und der Admin-Bit des Einzelbenutzer-Namens kam aus der Vorgabeliste. Der leer-Zweig war auf dieser Unit damit nicht erreichbar; der Befund war **auf dem geprüften Pfad widerlegt**, der Quellzustand aber wie beschrieben. Nach dem Deploy keine erneute Probe (auf der Live-Unit weiterhin nicht auslösbar).

**Fix.** Die **gesetzte** Variable entscheidet allein, auch wenn sie leer ist: `typeof raw === "string"` führt zu `split(",").filter(...)`, ein leerer Wert also zu `[]`; `hasEnvironmentAdminList` prüft nur noch die Anwesenheit. Der Rollen-Cache unterscheidet „unpinned“ (`\u0000unpinned`) von der ausdrücklich leeren Liste, damit ein warmer Cache nach `OMP_WEB_ADMINS=""` nicht die alten Rollen weiterliefert. Ein explizites `isAdmin: true` in der Datei verliert gegen die leer gesetzte Umgebungsvariable. Die Entscheidung fällt im Store, der als einzige Stelle Rollen beantwortet; der Proxy trägt nur das Ergebnis.

**Nachweis.** `lib/web-auth-store.test.mjs` prüft: fehlende Variable = Vorgabeliste; `""`, `" "`, `"  \t "`, `","` und `" , "` = leere Liste, auch für ein Konto mit `isAdmin:true` in der Datei; eine nicht-leere Liste entscheidet allein. Ein zweiter Test prüft, dass ein warmer Rollen-Cache „fehlt“ nicht mit „ausdrücklich leer“ verwechselt. `proxy.admin-role.test.mjs` wurde auf die neue Semantik angepasst. Die Live-Beobachtung (Variable abwesend, Zweig unerreichbar) ist oben zitiert. Nach dem Deploy keine erneute Probe.

**Restrisiko/Grenze.** Ein Host, der `OMP_WEB_ADMINS` versehentlich leer oder nur aus Trennzeichen setzt, hat jetzt wirklich niemanden mit Adminrechten und kann sich aus dem Admin-Panel aussperren; das ist die dokumentierte Semantik, keine Fehlfunktion.

## OMP-019 — Prüfung und Zugriff sind zwei Pfadauflösungen

**Impact (Audit):** low · **Status:** behoben (v0.22.4) · **Fix:** `lib/file-access.ts`, `app/api/files/[...path]/route.ts`, `app/api/file-actions/[...path]/route.ts`

**Mechanismus.** `GET /api/files` löste den Pfad mit `isExistingFilePathAllowed` auf, warf das Ergebnis aber weg und las danach `readFileSync(filePath)` bzw. übergab denselben Pfadnamen an `createReadStream`, dessen `open` noch später passiert. `PUT` löste den Pfad auf, baute die Temp-Datei aus dem Pfad und benannte sie über den Pfad um; der file-actions-DELETE prüfte den Pfad und rief dann `lstat`/`rmSync`/`unlinkSync` auf demselben Namen. Die Autorisierung war ein Boolean über eine `realpath`-Auflösung; ein Aufrufer, der eine Komponente zwischen Prüfung und Zugriff austauscht, lenkt die Operation aus den erlaubten Wurzeln. Das Home ist schreibbare Wurzel, und das Terminal bindet es read-write, sodass ein zweiter Prozess den Tausch ausführen kann.

**Ausnutzbarkeit.** Ein Konto, das eine Pfadkomponente im eigenen Home kontrolliert und während eines Requests austauscht. **Beobachtet (lokal, vor dem Fix):** (a) Ein deterministischer Hook tauschte `raced` nach `isExistingFilePathAllowed` vor dem Read; die Antwort war 200 mit `OUTSIDE-SECRET-9e71` — die Autorisierung sah `safe`, der Read `outside`. (b) Ein natürlicher Zwei-Prozess-Tausch plus 120 HTTP-Reads traf bei Request 19: 200 mit `OUTSIDE-PNG-SECRET-`, während `raced` zwischen `safe/` und einem Außenverzeichnis wechselte. Nach dem Deploy keine erneute Probe.

**Fix.** `openAuthorizedFile` bindet die Entscheidung an den Deskriptor: erst `resolveAuthorizedPath` (realpath + Wurzelprüfung), dann `openSync` mit `O_RDONLY | O_NONBLOCK | O_NOFOLLOW` (`O_NONBLOCK`, damit ein FIFO nicht schon im `open` blockiert; `O_NOFOLLOW`, damit die letzte Komponente nicht nachträglich zum Link wird), dann `fstat` (nur reguläre Dateien), erneuter `realpath` gegen die aufgelösten Wurzeln und Vergleich von `dev`/`ino` zwischen `fstat` und `stat` des frischen Pfads. Alle Lesepfade (`read`, Stream, Download, Vorschau, Meta) lesen den `fd`; `PUT` schreibt die Temp-Datei neben das aufgelöste Ziel; der DELETE entfernt einen Symlink als Link und löst sonst den echten Pfad auf, prüft ihn erneut und löscht diesen. Die Entscheidung fällt am Objekt, das tatsächlich gelesen, ersetzt oder entfernt wird.

**Nachweis.** `lib/file-access.test.mjs` prüft: `openAuthorizedFile` liest die geprüfte Datei und verweigert sowohl den Tausch eines Verzeichnisses gegen einen Außen-Symlink als auch den Tausch der letzten Komponente (`not-allowed`); ein Link, der im Root bleibt, funktioniert weiter; ein FIFO im Root wird ohne Blockieren abgelehnt (Kindprozess mit 2-s-Budget, `SIGKILL`, weil der SDK-Import einen SIGTERM-Handler installiert). `app/api/files/[...path]/route.write-atomicity.test.mjs` prüft: Rechte und Ausführbarkeit bleiben beim Speichern erhalten, keine Temp-Reste, ein fehlgeschlagener Write legt keine halbe Datei ab, ein Speichern durch einen Link im Home schreibt das Ziel und lässt den Link, ein Link nach draußen wird abgelehnt. `app/api/file-actions/limits.test.mjs` prüft den Delete durch ein symlinktes Verzeichnis. Die lokalen Vorher-Beobachtungen stehen oben. Nach dem Deploy keine erneute Probe.

**Restrisiko/Grenze.** Node hat kein deskriptorrelatives `rm`/`rename`; `PUT` und der DELETE dokumentieren im Code das verbleibende Fenster, in dem ein Elternverzeichnis zwischen der Auflösung und dem `rename`/`rm` gegen einen Symlink getauscht wird. Der Fix entfernt den Zwischensymlink-Hop, den der Befund beschrieb, nicht dieses Sprachfenster (siehe „Bekannte Grenzen“).

## OMP-020 — Login-Fehlerzeit verrät, ob ein Kontoname existiert

**Impact (Audit):** low · **Status:** behoben (v0.22.4) · **Fix:** `lib/web-auth.ts`

**Mechanismus.** Antwortkörper und Status waren uniform, die Kosten der Ablehnung aber nicht. Ein Name, der auf ein aktiviertes Konto mit nutzbarem Digest auflöst, lief durch `verifyWebPassword` und damit durch `scryptSync` (N=16384, r=8). Ein unbekannter Name oder ein abgeschaltetes Konto kehrte aus `findWebAccount` zurück, bevor `resolveWebAuthPolicy` und scrypt liefen; der Einzelbenutzer-Zweig verglich per SHA-256, und der Environment-Modus verglich konstantzeitig, aber ohne scrypt. Die Route addierte auf **beide** Fehlerpfade dieselbe 150-ms-Pause (nicht auf den Erfolg), sodass die Differenz erhalten blieb. Ein unauthentifizierter Client konnte mit wiederholten Versuchen und Medianvergleich Namen unterscheiden, die zu aktivierten Konten gehören.

**Ausnutzbarkeit.** Jeder unauthentifizierte Netzteilnehmer, der die Login-Route erreicht. **Beobachtet (lokal, vor dem Fix):** 30 Fehlversuche je Fall über die Route: Median **404,8 ms** (existierender Name) gegen **391,5 ms** (unbekannt), p95 483,8 gegen 442,8 ms. Direkt gegen `verifyCredential`, 50 Aufrufe: Median **36,06 ms** gegen **0,10 ms** — die scrypt-Verzweigung existiert nur für existierende Konten. Die Route-Messung lief auf einem belasteten Host; absolute Zeiten sind relativ zu lesen, die 36 ms sind die direkte Branch-Kosten. Nach dem Deploy keine erneute Probe.

**Fix.** `payCredentialCost()` prüft gegen einen festen Dummy-Digest und wird auf jedem Fehlerpfad bezahlt, der sonst ohne scrypt zurückkehren würde: unbekannter/abgeschalteter Name, Environment-Modus-Fehlschlag und fehlender Store. Der Dummy-Vergleich schlägt immer fehl und landet nie im Erfolgs-Cache (der nur erfolgreiche Prüfungen speichert); ein existierendes Konto bezahlt weiterhin sein eigenes Digest. Die Entscheidung fällt in `verifyCredential`, der einzigen Funktion, durch die Login und Basic-Auth gehen — der Aufwand wird an der Quelle angeglichen.

**Nachweis.** `app/api/web-access/login/route.equal-cost.test.mjs` patcht `crypto.scryptSync` und prüft: existierender Name mit falschem Passwort, unbekannter Name und deaktiviertes Konto ergeben jeweils 401 mit identischem Body und **genau einem** scrypt-Aufruf; der existierende Fall nutzt das echte Salz, die beiden anderen denselben Dummy; der Test misst die Aufrufzahl, nicht die Uhr. Die lokale Vorher-Messung steht oben. Nach dem Deploy keine erneute Probe.

**Restrisiko/Grenze.** Der Test belegt gleiche scrypt-Arbeit, nicht gleiche Wanduhrzeit; ein Digest mit anderen Kostenparametern würde abweichen. Ein leerer Name oder ein leeres Passwort kehrt weiterhin vor jeder Digest-Arbeit zurück — das ist kein Existenz-Orakel, weil beide Fälle unabhängig vom Konto billig sind. Die ~36 ms pro abgelehnter Prüfung sind zugleich eine CPU-Last ohne Auth-Rate-Limit (siehe „Bekannte Grenzen“).

## OMP-021 — Tenant-Dateitools umgehen die Ressourcen-Autorisierung (verworfen)

**Impact (Audit):** — (verworfen) · **Status:** verworfen (kein Befund) · **Fix:** — (kein Fix)

**Mechanismus.** Der Datensatz behauptete, die read/write-Tools einer Mandanten-Session könnten jede Datei des Dienstkontos lesen und schreiben, weil `makeSessionShellGuard` für jedes Tool außer `bash` früh zurückkehrt und nur das `cwd`-Argument prüft; das SDK löse absolute Pfade unverändert auf und lese sie in-process, während die HTTP-Route ihre identitätsspezifische Allowlist anwende. Die Spur ist codegenau, aber die behauptete Grenze existiert nicht: Dieselbe Session bekommt über das Default-Tool-Preset `bash`, und der Guard erlaubt jeden Kommandotext aus dem Session-cwd — der eigene Test hält `cd / && ls /` als erlaubt fest, und `docs/inventory-tools.md` dokumentiert, dass die Agent-Shell als Dienstbenutzer läuft. Die read/write-Tools fügen damit keine Autorität hinzu, die die Session nicht schon über bash hat.

**Ablehnungsgrund.** Die Audit-Regel verlangt den Nachweis, dass der Angreifer dieselbe Aktion nicht ohnehin ausführen kann; hier kann er es. Die HTTP-Allowlist ist eine Routen-Kontrolle, keine Kontrolle über die In-Process-Agent-Tools, und der Guard ist ausdrücklich keine Sandbox. Der Datensatz bleibt nur zur Nachvollziehbarkeit in `findings.json` und zählt nicht als Befund. Der veraltete Testkommentar, read/write seien „the route allowlist's business“, und dieselbe Aussage in `docs/inventory-tools.md` sind Dokumentationsfehler, keine eigene Lücke.

## Bekannte Grenzen

Diese Grenzen gelten über die einzelnen Befunde hinweg und sind im Code bzw. in den Release-Notizen dokumentiert; sie sind keine offenen Befunde der Fixwelle.

- **Auth-Kosten ohne Rate-Limit.** Jede abgelehnte Credential-Prüfung kostet seit OMP-020 etwa 36 ms scrypt-CPU (gemessen 36,06 ms direkt gegen `verifyCredential`, lokale Fixture, 2026-11-03), auch auf dem unauthentifizierten Basic-Auth-Pfad, den `proxy.ts` bei jeder Anfrage prüft. omp-web drosselt Authentifizierungsversuche nicht; der Fix nimmt das Timing-Orakel, nicht die CPU-Last.
- **Proxy-Klon und zwei Body-Kopien.** `experimental.proxyClientMaxBodySize` steht unverändert auf `104mb` (109 051 904 Byte). Next klont jeden `/api`-Body für die Middleware und beendet den Klon beim Überschreiten still — das ist eine Transport-, keine Ablehnungsgrenze. Die Routen zählen deshalb selbst: 30 MiB für `/api/agent/[id]` und `/api/agent/new`, 4 KiB für Login und Recovery. Der Agent-Reader hält die Chunks plus den geparsten Blob, also etwa die doppelte Body-Größe (bei 30 MiB rund 60 MiB pro gleichzeitigem Request). Beobachtet: Bei `Content-Length: 31457281` ohne Body wartet der Proxy auf den angekündigten Body, bevor die Route läuft; der 413 der Route ist erst mit tatsächlich gestreamten Bytes sichtbar.
- **Kein deskriptorrelatives `rm`/`rename`.** Node bietet keine fd-relativen Varianten; `PUT` und der file-actions-DELETE lösen den Pfad auf und dokumentieren im Code das Fenster, in dem ein Elternverzeichnis zwischen Auflösung und `rename`/`rm` gegen einen Symlink getauscht wird. Der Fix schließt den Zwischensymlink-Hop, nicht dieses Sprachfenster.
- **`git config` pro git-Aufruf.** `gitDriverOverrides` startet seit OMP-012 für jeden git-Aufruf einen zusätzlichen `git config`-Prozess (Timeout 5 s). Schlägt die Abfrage fehl, wird der git-Aufruf abgelehnt statt ungeschützt zu laufen. Globale und System-Treiber bleiben absichtlich aktiv, damit git-lfs funktioniert; ein Repository kann sie nicht schreiben.
- **Run-Budget ist pro Lauf und pro Goal, nicht pro Konto.** 400 Modellanfragen und 45 Minuten gelten für einen Prompt-Lauf und für die gesamte Goal-Lebensdauer; ein neuer Prompt oder eine neue Session startet ein frisches Budget, und `/api/agent/new` hat keine Konto-Concurrency-Grenze. `turn_start` unterzählt In-Turn-Re-Samples; ein Geld-Cap (`session.maxCost`) existiert nicht.
- **Prozessweite Modell-Schlüssel.** Die Anmeldedaten liegen weiterhin in einem `AuthStorage` für alle Konten; die Proberouten sind jetzt admin-only, aber `GET /api/auth/api-key/[provider]` meldet jedem Konto, ob ein Provider einen Prozess-Schlüssel hat. Der Eintrag in `docs/known-findings.md` bleibt offen.
- **Live-Nachweis ist unvollständig.** Nach dem Deploy wurden nur die in der Methodik-Tabelle genannten Proben wiederholt (OMP-001/002, OMP-003, OMP-005, OMP-006, OMP-016, OMP-017 plus Regressionen). Für OMP-004, OMP-007, OMP-009, OMP-010, OMP-011, OMP-012, OMP-013, OMP-014, OMP-015, OMP-018, OMP-019 und OMP-020 stützt sich der Nachweis auf die Vorher-Verifikation und die Tests; OMP-008 hat weder Fix noch Test.

## Rohdaten und Reproduktion

**Audit.** Die Artefakte liegen unter `~/security-audit-skill/omp-web/run-1/`: `FINDINGS-DETAIL.md` (alle 21 Datensätze mit Trace, Evidenz, Blockern und Validierungsplan), `REPORT.md`, `NEEDS-VALIDATION.md`, `run-metadata.json`, `findings.json`, `coverage-ledger.json` und `phase5/`. Sie sind bewusst **nicht** in dieses Repository kopiert: Sie enthalten Deployment-Fakten (Unit-Umgebung, Host-Pfade, Kontenlage), die nicht in die Quelltextablage gehören. Quellstand: `15a24ff` (v0.22.2); der Worktree wanderte während des Laufs auf `1dbbdb2` (v0.22.3), der Diff betraf nur Kalender, CHANGELOG und Paketmetadaten, und Phase 5 las jede zitierte Sicherheitszeile gegen den aktuellen Stand erneut.

**Verifikation.** Die beiden Berichte liegen in `/tmp/omp-verify-live.md` und `/tmp/omp-verify-local.md`. `/tmp` ist flüchtig; wer sie länger braucht, kopiert sie vorher weg. Der Live-Bericht nennt die genauen Request-/Antwort-Paare und die Aufräum-Nachweise, der lokale Bericht die Fixture-Kommandos und die Grenzen der Messung (belasteter Host, relative Latenzen, verrauschter RSS-Delta bei OMP-017).

**Fix.** `67d86f5` ist der Sicherheits-Fix, `ebf3875` der Nachlauf für drei Wiring-Tests; Tag und Release sind `v0.22.4` (Release angelegt am 2026-11-03). `git show 67d86f5` und `git show ebf3875` sind die primären Diffs; die Dateien in der Status-Tabelle sind die jeweiligen Hauptorte.

**Tests erneut fahren.** Die folgenden Listen sind aus dem Fix-Commit abgeleitet und thematisch gruppiert; `NODE_ENV=test bun test <dateien>` ist der fokussierte Lauf. Der volle Lauf auf dem Deploy-Host benutzte `NODE_ENV=test nice -n 10 bun test --max-concurrency 1` und wurde gegen `/tmp/omp-baseline-suite.log` verglichen.

```bash
# Modell-Proben (OMP-001/002)
NODE_ENV=test bun test app/api/models-config/discover/route.test.mjs \
  app/api/models-config/test/route.test.mjs lib/model-discovery-auth.test.mjs

# Slash-Gate und Plugin-Route (OMP-003/004)
NODE_ENV=test bun test lib/rpc-manager.test.mjs app/api/plugins/route.test.mjs

# MCP-Symlink, Projekt-Trust, Loads (OMP-005/007/010/011)
NODE_ENV=test bun test app/api/mcp/route.test.mjs lib/project-trust.test.mjs \
  lib/project-skill-trust.test.mjs lib/load-policy.test.mjs

# Dateizugriff, aktive Inhalte, atomares Schreiben, Baumgrenzen (OMP-006/009/013/014/019)
NODE_ENV=test bun test lib/file-access.test.mjs \
  "app/api/files/[...path]/route.active-content.test.mjs" \
  "app/api/files/[...path]/route.write-atomicity.test.mjs" \
  app/api/file-actions/limits.test.mjs app/api/file-actions/protected.test.mjs

# Git-Treiber (OMP-012)
NODE_ENV=test bun test lib/git-safe.test.mjs

# Adminliste und Login-Kosten (OMP-018/020)
NODE_ENV=test bun test lib/web-auth-store.test.mjs \
  app/api/web-access/login/route.equal-cost.test.mjs proxy.admin-role.test.mjs

# Body-Deckel (OMP-016/017)
NODE_ENV=test bun test lib/request-body.test.mjs \
  app/api/agent/agent-body-limit.test.mjs app/api/agent/new/body-limit.test.mjs \
  app/api/web-access/login/route.body-limit.test.mjs \
  app/api/web-access/recovery/route.test.mjs

# Lauf- und Goal-Budget (OMP-015)
NODE_ENV=test bun test lib/session-run-budget.test.mjs lib/rpc-manager.test.mjs

# Wiring der Schreib-Guards (Nachlauf ebf3875)
NODE_ENV=test bun test lib/write-access.identity.test.mjs \
  lib/goal-mode.wiring.test.mjs app/api/mcp/route.test.mjs
```

Die beiden Agent-Body-Testdateien (`app/api/agent/agent-body-limit.test.mjs`, `app/api/agent/new/body-limit.test.mjs`) brachen im vollen v0.22.4-Lauf beim Import mit `Setting "extensions" is registered twice` ab; das ist die bekannte Folge einer zweiten jiti-Instanz, kein Produktpfad. Ein Einzellauf wurde für dieses Dokument nicht erhoben; wer die Assertions als Lauf-Ergebnis braucht, führt sie isoliert in einem Prozess aus, in dem die SDK-Registry nicht bereits geladen ist.
