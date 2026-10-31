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
## Zwei Ursachen, ein Bildschirm: der Link und der geschlossene Tab

**Behoben.** Der Bericht kam vom Telefon: den Link im Browser oeffnen, anmelden,
Tab schliessen, spaeter wieder auf die Seite — und statt der letzten Sitzung die
Anmeldeseite. Es waren **zwei** unabhaengige Ursachen mit demselben Bild, und das
ist der Grund, warum dieser Eintrag beide nennt: wer nur eine davon prueft, hoert
auf, weil er „die" Ursache gefunden hat.

### 1. `SameSite=strict` auf einer Cross-Site-Navigation

Ein Link, den man in Mail, Messenger oder Chat antippt, startet die Navigation
auf einer **anderen Seite**. Der Browser schickt bei `strict` den Cookie auf
genau dieser Anfrage nicht mit, `proxy.ts` sieht keine Identitaet und antwortet
`302 /login` — der Cookie liegt dabei gueltig im Browser.

**Gemessen** (Chromium, iPhone-14-Viewport, echter Cross-Site-Link von einem
anderen Host): `Sec-Fetch-Site: cross-site`, `Sec-Fetch-Mode: navigate`,
Cookie im Jar vorhanden, beim Request **withheld**, gelandet auf `/login`. Nach
`sameSite: "lax"`: derselbe Klick landet auf `/`.

`lax` ist die sichere Seite davon, nicht die schwache: der Cookie reist weiterhin
nicht auf Cross-Site-Subrequests oder Cross-Site-POSTs mit, und
`isApiRequestAllowed()` (`lib/request-security.ts:112-119`) weist
`sec-fetch-site: cross-site` ab, **bevor** `proxy.ts` den Cookie liest. Test:
derselbe Cross-Site-POST mit gueltigem Cookie → 403; derselbe POST same-origin →
200.

### 2. Die Lebensdauer war eine Stunde

`SESSION_TTL_MS` war eine **Leerlaufzeit**, und der Cookie gleitet nur, wenn
Anfragen kommen. Ein geschlossener Tab stellt keine, also verwirft der Browser
ihn, sobald `Max-Age` abgelaufen ist.

**Gemessen:** ein Cookie, der vor 61 Minuten ausgestellt wurde, liegt im Browser
nicht mehr (mit seiner eigenen `expires` gesetzt, beim Aufruf abgelaufen), und
`GET /` antwortet mit `302` auf `/login`; bei 40 Minuten landet derselbe Aufruf
auf `/`.

**Ausgeschlossen, jeweils gemessen:** Login, Gleit-Erneuerung und Logout tragen
identische Attribute inklusive `Max-Age` und `Expires` — kein Session-Cookie,
keine Verkuerzung auf dem Erneuerungspfad; ein Browserneustart mit demselben
Profil landet innerhalb der Lebensdauer auf `/`; ein Neustart des Prozesses
ebenfalls, weil die Schluesseldatei da ist (`0600`, 44 Byte); `Secure` erscheint
genau dann, wenn die Anfrage ueber HTTPS kam (`x-forwarded-proto`).

**Warum es wie der Neustart-Befund oben aussah:** beide Symptome sind derselbe
Text („wieder am Login") und haben verschiedene Ursachen. Der Eintrag oben ist
der Prozess, dieser hier sind das Attribut und die Zeit. Wer das naechste Mal
„abgemeldet" hoert, misst zuerst das Alter des Cookies — juenger als die TTL
heisst Schluessel oder Attribut, aelter heisst Ablauf.

**Jetzt:** `sameSite: "lax"` und 30 Tage Lebensdauer, weiterhin gleitend
(`SESSION_RENEW_AFTER_MS` = die Haelfte). Die 30 Tage sind eine Setzung, keine
Messung: die Zeitspanne, die ein Telefon ohne Anfrage bleiben darf. Der Preis
steht in `docs/inventory-auth.md`: ein kopierter Cookie ist bis zu 30 Tage eine
kopierte Sitzung. Die Gegenmittel haengen nicht am Ablaufdatum — Logout dreht die
Epoche, Passwortwechsel dreht den Schluessel, Schluesseldatei loeschen plus
Neustart meldet jedes Geraet ab.
