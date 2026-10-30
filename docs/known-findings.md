# Bekannte Befunde, nicht behoben

Diese Datei sammelt Befunde aus dem Code-Scan vom 12.10.2026, die **bewusst nicht
in dieser Runde** behoben werden. Jeder Eintrag nennt die Bedingung, unter der er
sich aendert — ein Befund ohne Ausloeser wird zu einem Befund, den niemand mehr liest.

## IDOR: `/api/sessions/[id]` filtert nicht nach Identitaat

**Schwere:** mittel, abhaengig von der Anzahl der Konten.

**Was:** `GET`, `PATCH` und `DELETE` unter `/api/sessions/[id]` rufen
`getRequestIdentity` nicht auf. `resolveSessionPath(id)` in
`lib/session-reader.ts:202` ruft `listAllSessions()` ohne Identity-Argument und
filtert deshalb nicht. `/api/sessions` (die Liste) prüft dagegen über
`isSessionOwnedBy` (`lib/session-reader.ts:112-116`) sehr wohl. Genau diese
Inkonsistenz ist der Befund: die Liste ist zu, die Detailroute nicht.

**Gemessen:** nicht im Browser, aus dem Code gelesen. Der Scan hat die Export-Route
geprueft, dieselbe Familie ist nicht gemessen.

**Warum kein offenes Loch:** Session-IDs werden von
`@oh-my-pi/pi-coding-agent/src/session/session-manager.ts:98` als
`Bun.randomUUIDv7()` erzeugt, also mit 122 Bit Entropie. Es gibt keinen
Enumerationsweg, und die Liste, die Ids preisgeben wuerde, filtert bereits.
Bleibendes Risiko ist eine ID, die ausserhalb der App bekannt wurde: geteilter
Link, Screenshot, Logfile, Export-Dateiname, Referrer.

**Ausloeser fuer die Umsetzung:** in dem Moment, in dem ein Nicht-Admin-Konto
existiert. Auf einem Einzelbenutzer-Host gibt es keine zweite Identitaet, die etwas
anfragen koennte, der Befund ist dort theoretisch.

**Warum nicht heute, obwohl es eigentlich hingehoert:** die richtige Regel muss
drei Faelle gleichzeitig treffen, und sie sind nicht gleich:

- Admin sieht alles (`getUserHome` gibt `/` zurueck)
- Nicht-Admin sieht nur die eigene Home
- **Identitaet `null` heisst "alles"** — das ist der CLI- und Startpfad,
  `filterSessionsForIdentity` gibt bei `null` ungefiltert zurueck

Wer heute einen Filter einbaut und den dritten Fall mitreisst, sperrt den
Besitzer aus seinen eigenen Sessions aus. Das ist ein schlechter Trade an einem
Tag, an dem es sonst um eingefrorene Farbbaender geht.

**Form des Fixes, wenn er anfaellt:** die Detailroute braucht denselben
`filterSessionsForIdentity`-Aufruf wie die Liste, mit derselben `null`-Semantik.
Nicht einen eigenen Filter erfinden.

## Modellschluessel sind prozessweit, nicht pro Konto

**Schwere:** mittel — ein Mandant kann heute keinen fremden Schluessel setzen, aber
die Trennung, die das verhindert, ist eine Rollenpruefung, keine Datentrennung.

**Was:** `app/api/auth/api-key/[provider]/route.ts` schreibt ueber
`authStorage.set()` in das `agent.db` des **Prozesskontos**, genauso der
OAuth-Login in `app/api/auth/login/[provider]/route.ts` und das Loeschen in
`app/api/auth/logout/[provider]/route.ts`. Der Runtime kommt aus `getOmpRuntime()`
(`lib/omp-runtime.ts:50`), das ist ein `globalThis`-Singleton ueber genau ein
`agentDir`. Es gibt also genau eine Zeile fuer alle Konten.

**Warum das ein Problem ist:** die Anmeldung ist pro Mandant
(`app/api/web-access/users/route.ts`), die Ablage nicht. "Mein Modellschluessel"
ist damit eine Behauptung des Clients und keine Eigenschaft des Datensatzes — ein
Mandant, der denkt, er schreibe seinen eigenen, verdient das Guthaben des
Betreibers oder bricht den Betrieb, wenn sein Schluessel ungueltig ist.

**Wie es heute aufgefangen wird:** `requireAdmin` auf POST und DELETE. Das ist
korrekt, aber es ist eine **Sperre**, keine Trennung: es beantwortet die Frage
"wer darf das", nicht die Frage "wessen Guthaben ist das". Und es hat eine
unangenehme Folge, die bleiben wird, bis der Speicher umgestellt ist — ein
Nicht-Admin kann seinen Anbieter **nicht** selbst konfigurieren. Das ist ein
Schritt zurueck von dem, was die Oberfläche verspricht.

**Warum nicht heute:** der Fix ist eine Speicherumstellung, kein Guard. Der
Wegweiser ist bereits gelegt — `lib/tenant-config.ts` hat `resolveTenantAgentDir`
und `ensureTenantAgentDir`, und `lib/models-config/route.ts:105,132` sowie
`lib/quick-phrases-store.ts:52` nutzen sie fuer genau diese Trennung. Was fehlt,
ist das Gegenstueck fuer die Credentials: `lib/omp-runtime.ts` hat
`getSettingsForIdentity` fuer die `config.yml` je Konto (Cache pro `agentDir`),
aber **kein** `getAuthStorageForIdentity` und **keinen** `ModelRegistry` je
Mandant. Ein Aufruf davon braucht `discoverAuthStorage(tenantDir)` und einen
Registry pro Verzeichnis; das ist eine eigene Aenderung an `lib/omp-runtime.ts`,
kein zweiter Guard.

**Ausloeser fuer die Umsetzung:** sobald Mandanten Modelle **selbst** konfigurieren
sollen — also in dem Moment, in dem die Admin-Sperre zum Produktproblem wird, nicht
nur zum Sicherheitsproblem. Der Kandidat dafuer ist eine gemischte Installation:
Admin setzt den Providerschluessel, die Mandanten melden sich an und finden
`configured: false`, ohne den Unterschied zu sehen.

**Form des Fixes, wenn er anfaellt:** dieselbe Form wie bei den anderen beiden
Mandanten-Routen — `ensureTenantAgentDir(identity)` als Quelle des `agentDir` in
einer dem `getSettingsForIdentity` nachgebauten `getAuthStorageForIdentity`, mit
einem Cache pro `agentDir` statt pro Prozess. Kein neuer Guard, keine
Sonderregel fuer die api-key-Route: wenn die Ablage mandantenfaehig ist, faellt
`requireAdmin` dort weg und `requireIdentity` reicht. Der Bestand bleibt
dabei liegen, denn ein Admin *ist* das Prozesskonto — dieselbe Begruendung, die
schon in `lib/tenant-config.ts` steht.

## `OMP_WEB_PASSWORD` schlaegt das gespeicherte Passwort

**Kein Befund, sondern eine bewusste Entscheidung.** `resolveWebAuthPolicy()` in
`bin/web-auth-store.js:504` gibt der Environment-Variable Vorrang vor der
Datei. Am 12.10.2026 wurde damit kurzzeitig ein Testzugang gesetzt, wodurch das
gespeicherte Passwort eines Betreibers ausser Kraft gesetzt wurde.

Steht hier, weil die Reihenfolge nicht offensichtlich ist und die Reihenfolge
erfahrungsgemaess erst im Betrieb auffaellt. Der 409-Guard in
`app/api/web-access/route.ts:56-61` verhindert nur, dass die UI es im UI
versteckt — er macht den Vorrang nicht rueckgaengig.

## Sessions ueberlebten keinen Neustart — seit v0.18.x schon

**Behoben, und die Historie ist der Grund, warum es hier steht.** Bis v0.18.0 war
der Salz in `lib/web-auth-session.ts` ein `randomBytes(32)` auf Modulebene: jeder
Kaltstart zog einen neuen, jede Signatur war damit falsch. Auf agent-pc laeuft der
Dienst mit `Restart=always` und einem Healthcheck alle fuenf Minuten; am 30.10.2026
standen im `journalctl` **zehn** Stopping+Started-Paare an einem Tag, mehrere davon
im Stundenraster. Ein Deploy meldete also ab, ein Healthcheck-Restart auch — und
weil das aus der Ferne wie ein TTL-Ablauf aussieht, wurde daraus das Symptom
„nach zehn Minuten abgemeldet", obwohl im Code keine Zehn-Minuten-Frist existiert
(die 10 Minuten an zwei Stellen sind ein Recovery-Code und ein Idle-Timeout der
Agent-Session, keiner beruehrt das Cookie).

Der Salz liegt jetzt in `<Verzeichnis der Credential-Datei>/omp-web-session-key`
(`0600`, eine Zeile, Override `OMP_WEB_SESSION_KEY_FILE`) und wird beim ersten
Start mit `flag: "wx"` angelegt. Ein Neustart verifiziert die Cookies des vorigen
Prozesses. Wer den alten Zustand will, setzt `OMP_WEB_SESSION_KEY_EPHEMERAL=1`;
das ist dokumentiert und getestet (`lib/web-auth-session.key.test.mjs`), aber
nicht der Default. Die Begruendung und der Preis stehen in
`docs/inventory-auth.md` und `docs/authentication.md`.

Steht hier weiterhin, weil ein Commit sonst etwas anderes versprechen kann, als
der Code tut — und weil die Umkehr einer dokumentierten Sicherheitsentscheidung
einen Ort braucht, an dem sie nachlesbar ist.