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

## `OMP_WEB_PASSWORD` schlaegt das gespeicherte Passwort

**Kein Befund, sondern eine bewusste Entscheidung.** `resolveWebAuthPolicy()` in
`bin/web-auth-store.js:504` gibt der Environment-Variable Vorrang vor der
Datei. Am 12.10.2026 wurde damit kurzzeitig ein Testzugang gesetzt, wodurch das
gespeicherte Passwort eines Betreibers ausser Kraft gesetzt wurde.

Steht hier, weil die Reihenfolge nicht offensichtlich ist und die Reihenfolge
erfahrungsgemaess erst im Betrieb auffaellt. Der 409-Guard in
`app/api/web-access/route.ts:56-61` verhindert nur, dass die UI es im UI
versteckt — er macht den Vorrang nicht rueckgaengig.

## Sessions ueberleben keinen Neustart

**Kein Befund.** `KEY_SALT` in `lib/web-auth-session.ts:47` ist `randomBytes(32)`
und wird bei jedem Kaltstart neu erzeugt. Auf agent-pc laeuft der Dienst mit
`Restart=always`, jeder Deploy meldet also ab. Der `SESSION_TTL_MS` von 24 Stunden
ist die Obergrenze der Cookie-Lebensdauer und **keine** Zusage, dass eine Anmeldung
den Tag uebersteht. Steht hier, weil die Commit-Nachricht sonst etwas anderes
verspricht als der Code tut.