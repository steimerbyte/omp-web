# Inventur: Auth, Session, Rechte, Sicherheitsgrenzen

Stand Commit `2699054`. Umfang: `proxy.ts`, `lib/web-auth.ts`, `lib/web-auth-session.ts`,
`lib/request-identity.ts`, `lib/request-security.ts`, `bin/web-auth-store.js` (Laufzeitlogik),
`app/login/`, `app/recover/`, `app/api/web-access/**` sowie die angrenzenden Konsumenten der
Identitaet (`lib/allowed-roots.ts`, `lib/write-access.ts`, `lib/file-access.ts`,
`lib/path-security.ts`, `lib/session-reader.ts`, `app/api/whoami`, `hooks/useTheme.ts`).

Der Bestand umfasst **58** Route-Handler unter `app/api` (`find app/api -name route.ts`).

Konvention: **Kann** = was die Funktion tut. **Darf nicht** = was sie nicht tun darf, mit
Begruendung. Bei Sicherheitsregeln ist die Begruendung Pflicht, nicht Kür — sie ist das, was
beim nächsten Refactor wegoptimiert wird.

> **In Aenderung.** `isAdminUsername()` (`bin/web-auth-store.js:350`) wird gerade erweitert:
> die Admin-Rolle soll in der Kontendatei stehen und nicht mehr allein aus dem Namen
> abgeleitet werden. Bis dieser Commit landet, ist `isAdmin === resolveAdminUsernames(env).includes(username)`.
> Alle Eintraege, die das beruehren, sind als **in Aenderung** markiert. Die markierten
> Aussagen stimmen fuer `2699054` und nicht mehr fuer den Stand danach.

---

### Proxy / Web-Lock (`proxy.ts`)
- **Kann**: Entscheidet fuer jeden Request, der unter den Matcher faellt, in vier Schritten:
  (1) Host-Allowlist, (2) Cross-Site-Pruefung, (3) Basic Auth, (4) Session-Cookie. Ergebnis ist
  entweder eine weitergeleitete Identitaet (`x-omp-user`/`x-omp-admin` an den Request gehaengt),
  ein 302 auf `/login` (Browser-Navigation), ein 401 mit Challenge (Skript), ein 503
  (`unavailable`) oder 403 (`Untrusted request`). Der Matcher deckt genau `/`, `/login`,
  `/recover` und `/api/:path*` ab — jede andere Route sieht **gar keinen** Proxy.
- **Darf nicht**: `withIdentity()` (Zeile 88) darf **nicht** bedingt auf `identity !== null`
  aufgerufen werden. Das `headers.delete()` ist bedingungslos und muss es bleiben: auf einem
  ungesperrten Server (`policy.mode === "open"`) ist `identity` null, und ein nur-gesetzter
  Header liess ein vom Client geschicktes `x-omp-admin: 1` durch. Gemessen vor dem Fix:
  `curl -H 'x-omp-user: root' -H 'x-omp-admin: 1' .../api/files/etc?type=list` lieferte 200 und
  listete `/etc`. Ein `delete`, das ein Zweig nie erreicht, ist kein Schutz, sondern toter Code.
- **Darf nicht**: Der Header darf nur ueber `NextResponse.next({ request: { headers } })`
  gesetzt werden (`proxy.ts:96`). `new NextResponse(...)` mit Headers wuerde sie in die
  *Antwort* schreiben, wo die Route sie nie sieht. Wer die Form umstellt, verliert die
  Identitaet still.
- **Darf nicht**: `rejectionHeaders()` (`:54-57`) und `isNavigation()` (`:299`) duerfen
  **nicht** verschiedene Achsen lesen. Beide lesen `sec-fetch-mode` **oder** `sec-fetch-site`.
  Wer eine neue Achse in eine der beiden Funktionen einbaut, muss sie in die andere mitnehmen —
  sonst bekommt ein Browser gleichzeitig Login-Seite *und* native Basic-Dialog fuer dieselbe
  Tuer, und ein Skript, das als Navigation eingestuft wird, verliert die Challenge, mit der es
  sich ueberhaupt erst anmelden kann.
- **Darf nicht**: `WWW-Authenticate` niemals an einen Browser schicken. Der Header wird nur
  gesetzt, wenn **weder** `sec-fetch-mode` **noch** `sec-fetch-site** vorhanden sind
  (`proxy.ts:55`) — das sind ausschliesslich Nicht-Browser. Wer die Regel „Browser fragen nur bei
  Top-Level-Navigation" stattdessen traversieren will, traegt eine Browser-Eigenheit in den Code
  ein, die nicht erzwungen werden kann.
- **Darf nicht**: `/login`, `/recover`, `/api/web-access/login`, `/api/web-access/recovery`
  duerfen **nur nach** der Host- und Cross-Site-Pruefung durchgelassen werden
  (`proxy.ts:102-113` laeuft vor `:119-124`). Sie sind der Ausweg aus dem Lock; ohne sie
  entstuende eine Redirect-Schleife.
- **Ort**: `proxy.ts:99-198` (Proxy), `proxy.ts:88-97` (`withIdentity`), `proxy.ts:54-57`
  (`rejectionHeaders`), `proxy.ts:299-313` (`isNavigation`), `proxy.ts:215-225`
  (`acceptsHtmlDocument`), `proxy.ts:315` (Matcher)

### Immer erreichbare Pfade (auch bei gesperrtem Server)
- **Kann**: Vier Pfade werden immer durchgelassen, mit `withIdentity(request, null)`:
  `/login`, `/recover`, `/api/web-access/login`, `/api/web-access/recovery`
  (`proxy.ts:19-22`, `:119-124`). Keiner davon kann allein jemanden hereinlassen: die
  Login-API gibt nur bei korrektem Passwort ein Cookie, `/recover` druckt den Code auf der
  Server-Konsole.
- **Darf nicht**: Diese Pfade duerfen **nicht** durch `return NextResponse.next()` (ohne
  Header-Rewrite) beantwortet werden. Sie laufen bewusst durch `withIdentity` mit `null`, damit
  auch dort ein clientgeliefertes `x-omp-user`/`x-omp-admin` entfernt wird. Heute liest keine
  dieser Routen die Header — aber eine Regel mit einer Ausnahme bekommt beim naechsten Refaktor
  eine zweite Ausnahme, und diese Zeile waere die kopierte Vorlage.
- **Darf nicht**: Die Liste in `proxy.ts:19-22` nicht erweitern, ohne zu pruefen, ob der neue
  Pfad selbst eine Identitaet braucht. Jeder Eintrag hier ist eine Ausnahme von „alles wird
  geprueft".
- **Ort**: `proxy.ts:19-22`, `proxy.ts:106-124`

### Host-Allowlist (`isApiRequestHostAllowed`)
- **Kann**: Akzeptiert `localhost` und `*.localhost`, jede IP-Literal-Adresse (`isIP`), sowie die
  in `OMP_WEB_HOSTNAME` und `OMP_WEB_ALLOWED_HOSTS` (kommagetrennt) konfigurierten Namen.
  Muster `*` und `*.suffix` werden unterstuetzt (`lib/request-security.ts:33-37`). IP-Literale
  erhalten LAN-Zugriff **und** sind nicht DNS-reboundebar, weil der Browser die Literaladresse
  im `Host`-Header behaelt.
- **Darf nicht**: Die Allowlist nicht um `Sec-Fetch-Site` oder `Origin` erweitern — das ist eine
  andere Achse mit eigener Funktion. Und nicht so umbauen, dass ein nicht parsebarer `Host`
  durchgelassen wird: `hostnameFromAuthority` (`:10`) lehnt Leerzeichen, `/`, `@`, `\` sowie
  `user:pass@` ab, und `null` bedeutet `false`.
- **Ort**: `lib/request-security.ts:29-44`, `lib/request-security.ts:82-94`

### Cross-Site-Pruefung (`isApiRequestOriginAllowed`)
- **Kann**: Verwirft jeden Request mit `Sec-Fetch-Site: cross-site`. Sonst wird der Vergleich nur
  durchgefuehrt, wenn `Origin` **oder** `Sec-Fetch-Site` gesetzt ist (`shouldCheckApiRequestOrigin`,
  `:108-110`) — ein Skript ohne beide Header gilt als nicht-browser und passiert. `Origin` muss
  exakt der kanonischen Origin aus Protokoll + `Host` entsprechen.
- **Darf nicht**: Die Bedingung „kein Origin, kein `Sec-Fetch-Site` ⇒ erlaubt" **nicht**
  entfernen. Sie ist der einzige Weg, auf dem curl, der Reverse Proxy und die bestehenden Clients
  ueberhaupt ankommen. Ein Browser sendet `Sec-Fetch-Site` bei jedem Fetch/XHR immer mit; ein
  Skript sendet nichts.
- **Darf nicht**: Die Ausnahme fuer den Session-Export (`:60-71`) **nicht** verallgemeinern. Sie
  gilt nur, wenn **alle vier** Bedingungen zutreffen: `GET`, `Sec-Fetch-Mode: navigate`,
  `Sec-Fetch-Dest: document`, `Sec-Fetch-User: ?1`, **und** der Pfad passt auf
  `^/api/sessions/[^/]+/export$`. Das ist eine vom Benutzer ausgeloeste Navigation (Link-Klick,
  Download), bei der der Browser ein `Origin: null` oder einen fremden Origin mitschickt. Eine
  Ausnahme mit weniger Bedingungen macht aus einem Download-Link ein CSRF-Vektor, weil ein
  `<img>`/`fetch` ohne `Sec-Fetch-User` durchfallen wuerde.
- **Ort**: `lib/request-security.ts:60-71`, `lib/request-security.ts:96-118`

### `x-omp-user` / `x-omp-admin`
- **Kann**: Werden ausschliesslich von `proxy.ts` gesetzt, und zwar dort, wo die Anmeldedaten
  gerade verifiziert wurden. Es gibt keinen zweiten Weg: keine Route liest einen Namen aus Body,
  Query oder Pfad.
- **Darf nicht**: **Nicht auf `x-omp-user` vertrauen, ohne `proxy.ts` im Weg zu wissen.** Ein
  Request-Header ist etwas, das jeder Client mitschickt. `proxy.ts` ist die einzige Stelle, an
  der Identitaet entsteht — deshalb ist es auch die einzige, die den mitgelieferten Wert
  entfernen darf. Das Argument „bei `app/api/files/[...path]/route.ts` kommt der Pfad aus der URL"
  ist genau der Grund fuer den Header: wer den Pfad waehlt, waehlt damit auch den Mandanten;
  die Absicherung darf nie aus dem Pfad selbst kommen, sonst ist jeder Mandant ein Einzeiler.
- **Darf nicht**: Eine Route darf den Admin-Status **nie** aus einem Request-Feld ableiten.
  `body.isAdmin` waere eine Schaltflaeche, die jeder selbst umlegt.
- **Ort**: `lib/request-identity.ts:23-24` (Namen), `proxy.ts:88-97` (Setzen/Löschen)

### `getRequestIdentity(headers)`
- **Kann**: Liest `x-omp-user`, pruft den Wert gegen `validateAccountName` und liefert
  `{ username, isAdmin }` oder `null`. Der Header wird **wie alles aus dem Netz als
  unvertraeuig** behandelt: ein Name, der nicht als Pfadsegment taugt, ist kein Name, sondern
  ein Fehlversuch.
- **Darf nicht**: `null` darf **nicht** als Einladung zur Grosszuegigkeit gelesen werden. `null`
  heisst „niemand angemeldet" — die Antwort ist 403. Es gibt hier bewusst **keinen** Fallback auf
  einen Default-Benutzer und **keinen** Fallback auf Admin. Ein fehlender Header kam entweder
  aus einem Client, der `proxy.ts` umgangen hat, oder aus einer Route ausserhalb des Matchers —
  in beiden Faellen 403.
- **Darf nicht** (in Aenderung): `isAdmin` wird heute genauso gelesen wie der Name, also
  `headers.get(REQUEST_ADMIN_HEADER) === "1"`. Die Quelle dafuer ist `isAdminUsername()` in
  `bin/web-auth-store.js:350`; siehe Admin-Liste unten. Beide Header bleiben unveraenderlich
 loeschbar in `proxy.ts` — die Aenderung betrifft nur, **woher** der Admin-Status kommt.
- **Ort**: `lib/request-identity.ts:40-50`

### `requireAdmin(request)`
- **Kann**: Die einzige Admin-Pruefung fuer Routen, die etwas aendern, das dem ganzen Host gilt:
  Konten anlegen, Skills global schreiben, den Passwort-Store lesen und beschreiben. Gibt
  `null` zurueck, wenn die Identitaet Admin ist, sonst ein 403 mit `Cache-Control: no-store`.
  Antwort ist ein nackter `Response`, weil `lib/` sonst keine Next-Imports haelt.
- **Darf nicht**: **Keine Kopie pro Route schreiben.** Der Guard ist absichtlich in
  `lib/request-identity.ts` neben `isAdminIdentity` und nicht route-lokal. Er war vorher eine
  lokale Funktion in `app/api/web-access/users/route.ts`; beim Schreiben von
  `/api/web-access/route.ts` wurde er ein zweites Mal nicht geschrieben, sondern die Luecke mit
  einem Kommentar ueberbrueckt („Every request here has already passed proxy.ts") — und genau
  das war der Einbruch. Eine Guard-Kopie ist eine Kopie einer Frage, die nicht route-lokal ist.
- **Darf nicht**: Das Argument „der Proxy hat doch jeden Request geprueft" **nicht** als Begruendung
  fuer eine fehlende Zeile verwenden. `proxy.ts` autorisiert niemanden, es **identifiziert** nur:
  es laesst *jedes* gueltige Konto durch. „Authentifiziert" ist nicht „Administrator" — ein
  Mandant `bob` passiert den Proxy exakt wie der Betreiber.
- **Darf nicht**: `requireAdmin` **vor** `req.json()` und vor jeder Aktion aufrufen (Reihenfolge
  in `app/api/web-access/route.ts:66-69`, `users/route.ts:51/76/122`). Ein Tenant darf nichts an
  dem aendern koennen, was der ganze Host bei der Anmeldung verlangt.
- **Ort**: `lib/request-identity.ts:84-91`; Aufrufe in `app/api/web-access/route.ts:57,66`,
  `app/api/web-access/users/route.ts:51,76,122`

### Tenant-Isolation: `getUserHome(identity)`
- **Kann**: Liefert fuer einen Admin `/`, fuer alle anderen genau `join(resolveHomeRoot(env), username)`
  — also `/home/$name` unter Default. Das ist die **eine** Stelle, an der „Admin darf alles"
  technisch aussieht, und es ist gewollt: ein kompromittiertes Admin-Passwort heisst
  Host-Kompromittierung, weil der Prozess ohne uid-Wechsel als ein Benutzer laeuft.
- **Darf nicht**: **Kein `os.homedir()` im Admin-Fall.** Der Unterschied waere hier keiner (die
  Read-Grenze ist fuer einen Admin ohnehin offen), aber der Name waere falsch: das ist keine
  Home, das ist der Konto-Wurzelraum.
- **Darf nicht**: **Keine zweite `getUserHome`-Variante** aufmachen, z. B. in
  `lib/tenant-config.ts` oder `lib/quick-phrases-store.ts`. Beide Dateien rufen diese Funktion
  bewusst auf; eine eigene Variante spaltet die Mandantengrenze auf zwei Stellen.
- **Darf nicht**: `env` nicht zum impliziten `process.env` machen — es ist ein Parameter, damit
  ein Test oder ein Aufrufer mit eigener Umgebung dieselbe Wurzel sieht, unter der die Konten
  **auch angelegt** wurden. Ein stilles `/home` neben einem gesetzten `OMP_WEB_HOME_ROOT` waere
  ein Fehler, der nur in der Testumgebung sichtbar ist und im Betrieb keiner.
- **Darf nicht**: `resolveUserRoot()` nicht durch ein prozess-globales Pfad-Set ersetzen
  (`lib/request-identity.ts:123-125`). Ein globales Set heisst, dass ein Benutzer, dessen Home
  erlaubt wurde, die Rechte aller anderen erbt.
- **Ort**: `lib/request-identity.ts:110-113`, `lib/request-identity.ts:123-125`; Aufrufer u. a.
  `lib/path-security.ts:51`, `lib/allowed-roots.ts:93`, `lib/quick-phrases-store.ts:66`,
  `lib/session-reader.ts:106`, `lib/skill-lock.ts:73`, `lib/tenant-config.ts:50`,
  `app/api/default-cwd/route.ts:21`, `app/api/terminal/route.ts:73`, `app/api/whoami/route.ts:28`

### Admin-Lesemenge: `getAdditionalAllowedRoots(identity)`
- **Kann**: Jede Identitaet bekommt ihre eigene Home. Nur im Admin-Zweig kommen `/` und
  `OMP_WEB_ALLOWED_ROOTS` (kommagetrennt) dazu, plus die Grants aus dem „unattributed"-Bucket
  fuer Endpunkte, die vor der Identitaet geschrieben wurden (`lib/allowed-roots.ts:89-101`).
  Ohne Identitaet ist das Ergebnis **leer**.
- **Darf nicht**: `/` darf **nur** in diesem Admin-Zweig hinzugefuegt werden — dort ist die einzige
  Stelle im Repo, an der es passiert. `/` ist nicht sicher durch Zufall des Betriebssystems: der
  Dienst laeuft als ein Konto, der Kernel sieht nur dieses eine und gibt bereitwillig jede
  lesbare Datei heraus. Ein Root `/` macht `isPathWithinRoots` fuer jeden absoluten Pfad `true`,
  die Allowlist grenzt dann nichts ein (verifiziert: mit `{"/"}` werden `/etc/passwd` und
  `/proc/self/environ` akzeptiert).
- **Darf nicht**: `identity` nicht als optional mit Default behandeln.
  `getAdditionalAllowedRoots()` **ohne** Identitaet muss leer liefern und damit fail-closed sein —
  ein Default auf „das Konto des Dienstes" wuerde jeder nicht migrierten Route die Projekte des
  Betreibers in die Hand geben.
- **Darf nicht**: `OMP_WEB_ALLOWED_ROOTS` **nicht** in den Nicht-Admin-Zweig verschieben. Der
  Operator hat es absichtlich gesetzt; ein Tenant bekommt es nie.
- **Darf nicht**: `allowFileRoot(root)` ohne Identitaet nicht in einen gemeinsamen Bucket legen
  (`lib/allowed-roots.ts:112-115`). Der unclaimed Bucket ist nur fuer Admins sichtbar — eine nicht
  migrierte Route funktioniert damit weiter fuer den Betreiber, ohne das Ergebnis an einen
  Mandanten zu geben.
- **Ort**: `lib/allowed-roots.ts:56-61`, `lib/allowed-roots.ts:89-101`,
  `lib/allowed-roots.ts:112-115`, `lib/file-access.ts:35-73`

### Schreibgrenze: `getWritableRoots` / `isWritePathAllowed`
- **Kann**: Baut eine eigene Root-Menge aus den Projekt-Roots der Identitaet (Session-cwds,
  aufgeloeste Projektwurzeln, `omp-cwd-*`, `OMP_WEB_ALLOWED_ROOTS`) und loest **jeden** Pfad
  ueber `realpath` auf, bevor verglichen wird. Ein Symlink, der aus einem Projekt herauszeigt,
  kann also nicht zum Schreibziel werden.
- **Darf nicht**: Die eine Zeile `if (resolved === path.parse(resolved).root) continue;`
  **nicht** entfernen (`lib/write-access.ts:96`). Sie ist die **gesamte** Schreibgrenze fuer
  einen Admin. Verifiziert per Mutation: loescht man sie, kippt `isWritePathAllowed` auf
  `/etc/passwd` von false auf true — ein kompromittiertes Admin-Passwort wird damit zu beliebigem
  Schreiben. Ein Test, der nur die Ablehnungen beobachtet, faengt das **nicht**, weil `/etc/passwd`
  aus zwei unabhaengigen Gruenden abgelehnt wird (diese Zeile und „liegt in keinem Projekt"). Eine
  Ablehnung, zwei Ursachen, kein Signal, welche tragend ist. Der Test behauptet deshalb die
  gefilterte *Menge*.
- **Darf nicht**: Die Schreibgrenze **nicht** aus der Read-Allowlist ableiten.
  `renameSync("/etc/hosts", "/tmp/x")` braucht Schreibrecht auf beiden Seiten und keines auf
  either — ein Guard, der die Lese-Liste wiederverwendet, wuerde beliebiges Schreiben auf jedem
  Pfad herausgeben, den der Dienst schreiben kann, mit einem Button darauf.
- **Darf nicht**: Das Home-Verzeichnis selbst **nicht** als beschreibbar aufnehmen, nur was
  unterhalb eines Projekts darin liegt. Ein nackter Home-Root wuerde dieselbe Luecke eine Ebene
  tiefer wieder oeffnen. Ebenso: `/` und jeder andere Vorfahr einer Projektwurzel sind nicht
  beschreibbar.
- **Darf nicht**: `identity` zum optionalen Parameter mit Default machen. Jede Funktion hier nimmt
  die Identitaet explizit; ein Default waere eine stille Rechtevergabe, sobald jemand das Argument
  vergisst.
- **Ort**: `lib/write-access.ts:20-46`, `lib/write-access.ts:68-101`,
  `lib/write-access.ts:119-163`, `lib/write-access.ts:164-192` (`authorizeTransfer`)

### Basic Auth (`parseBasicCredentials`, `verifyCredential`, `authorizeWebRequest`)
- **Kann**: Zwei Tueren nebeneinander. Basic Auth nehmen curl, der Reverse Proxy und alle
  bestehenden Clients; das Session-Cookie ist die Browser-Variante. Beide sind an **dieselbe**
  Anmeldedatin gebunden — ein Passwortwechsel killt beide auf einmal. Der Vergleich laeuft ueber
  `timingSafeEqual` auf SHA-256-Hashes, damit die Laenge des Geheimnisses nicht ueber die Zeit
  lesbar ist (`lib/web-auth.ts:103-105`).
- **Kann**: `parseBasicCredentials` akzeptiert nur **genau eine** kanonische Base64-Kodierung —
  eine abweichende Re-Kodierung des Decodes (`decoded.toString("base64") !== match[1]`) und eine
  ungueltige UTF-8-Sequenz (`fatal: true`) ergeben `null`.
- **Darf nicht**: `verifyCredential` darf **nicht** unterscheiden, warum es gescheitert ist.
  Falscher Name, falsches Passwort und abgeschaltetes Konto ergeben alle `null`, und jede andere
  Antwort ist eine Oracle-Frage an einen Angreifer (`lib/web-auth.ts:224-227`).
- **Darf nicht**: Den Legacy-Pfad (Einzelbenutzer-Store `omp-web-auth.json` bzw.
  `OMP_WEB_PASSWORD`) nicht entfernen, nur weil es Mehrbenutzer gibt. Der Name ist fest, er kommt
  aus `getExpectedUsername()`, und er ist Admin, falls er in der Admin-Liste steht — sonst waere
  die bestehende Installation nach dem Update komplett handlungsunfaehig.
- **Darf nicht** (in Aenderung): `verifyCredential` ruft in beiden Zweigen `isAdminUsername()` auf
  (`lib/web-auth.ts:216`, `:225`). Der Admin-Status dieser Identitaet verschiebt sich mit der
  geplanten Aenderung von der Namensliste in die Kontendatei; die Aufrufstelle bleibt dieselbe.
- **Darf nicht**: `OMP_WEB_AUTH_USERNAME` (Modul-Ladzeit-Konstante, `lib/web-auth.ts:88`) **nicht**
  fuer Laufzeitpruefungen verwenden. `proxy.ts` und `lib/web-auth-session.ts` rufen
  `getExpectedUsername()`; nur so greift eine Aenderung im Settings-Panel sofort. Der Cache auf
  `globalThis.__ompWebAuthUsernameCache` ist **nur** fuer den Dateipfad erlaubt: der Env-only-Pfad
  cacht nie, weil die Env die einzige Eingabe ist, die sich zwischen zwei Aufrufen in einem lang
  laufenden Prozess aendern kann.
- **Ort**: `lib/web-auth.ts:40-88` (Username-Aufloesung), `lib/web-auth.ts:103-105`
  (Zeitkonstanz), `lib/web-auth.ts:114-138` (Parsing), `lib/web-auth.ts:141-151`,
  `lib/web-auth.ts:195-229` (`verifyCredential`), `lib/web-auth.ts:234-258` (`authorizeWebRequest`)

### Session-Cookie `omp_session`
- **Kann**: Traegt `version.issuedAt.expiry.nonce.username.signature`, sechs base64url-Felder.
  Signiert ist HMAC-SHA256 ueber den Payload, Schluessel ist scrypt(Geheimnis, Salz) mit
  N=16384, r=8, p=1, 64 Byte; der Salz kommt aus der Schluesseldatei (siehe unten). Der
  abgeleitete Schluessel ist prozessweit gecacht (`lib/web-auth-session.ts:188-209`, Cache-Key
  `salz|geheimnis`), weil scrypt ~50–100 ms kostet und `proxy.ts` das auf **jedem**
  authentifizierten Request zahlt — inklusive SSE-Reconnects.
- **Kann**: Der Konto-Name steht **im signierten Payload**, nicht im Schluessel. Das ist der ganze
  Punkt: eine Session ist nicht „der Server ist offen", sondern „diese Person ist angemeldet", und
  `proxy.ts` braucht den Namen, um die Identitaet zu bauen. Den Namen in den Schluessel zu legen
  wuerde das Cookie fuer genau die Person unpruefbar machen, fuer die es ausgestellt wurde.
- **Darf nicht**: Den Kontonamen **nicht** als unsigniertes Feld im Cookie fuehren. Das waere ein
  Header, den der Client einfach umschreibt. Signiert heisst: `alice`-Cookie auf `bob`
  umgeschrieben -> Signatur bricht, kein Wechsel.
- **Darf nicht**: `readCookieUsername()` (`:147-156`) darf **nicht** als Vertrauensquelle gelesen
  werden. Sie liest den Namen **vor** der Signaturpruefung, um den Schluessel zu waehlen — der
  Name ist ein Input fuer `resolveSessionSecret`, wie eine Datenbankzeilen-ID. Ein Name, der zu
  keinem Credential aufloest, produziert keinen Schluessel, und die Pruefung schlaegt fehl. Ein
  Cookie, das `steimerbyte` behauptet, kommt auf einem Server ohne dieses Konto nicht durch.
- **Darf nicht**: `timingSafeEqual` **nicht** direkt mit der Wire-Signatur aufrufen
  (`lib/web-auth-session.ts:393-396`). Es wirft bei Laengenunterschied; die Laengen werden deshalb
  vorher verglichen.
- **Kann** (bewusste Umkehr der frueheren Regel): `sessionKeySalt()` (`:152-161`) liest den
  Salz aus einer Datei, `0600`, eine Zeile, `resolveSessionKeyFile()` (`:86-90`):
  `OMP_WEB_SESSION_KEY_FILE`, sonst `<Verzeichnis der Credential-Datei>/omp-web-session-key`. Der
  Grund ist eine Messung, keine Neigung: auf agent-pc laeuft die Unit mit `Restart=always` und
  einem Healthcheck alle fuenf Minuten, am 30.10.2026 waren das **~10 Neustarts an einem Tag**
  (`journalctl`, jede Zeile ein Stopping+Started). Mit einem Salz pro Prozess hiess „Session" also
  „bis zum naechsten Deploy", und das Symptom meldet sich als „nach zehn Minuten abgemeldet".
  Erzeugt wird die Datei mit `flag: "wx"` (kein Ueberschreiben durch einen zweiten Prozess) und
  `mode: 0o600`; existiert sie schon, gewinnt ihr Inhalt. Was ein gestohlener Schluessel **bedeutet**:
  wer diese Datei lesen kann, kann Cookies fuer jedes Konto muenzen, ohne das Passwort zu kennen —
  und wer sie lesen kann, ist derselbe Benutzer, der `omp-web-auth.json` und jedes Konto-Home lesen
  kann. Es kommt also keine neue Rechteklasse hinzu, nur ein zweites Secret in dem Verzeichnis, in
  das `writeWebAuthConfig` schon schreibt. **Rotation** = Datei loeschen und neu starten: der
  naechste Start zieht einen neuen Salz, und jeder lebende Cookie stirbt (genau das war der alte
  Dauerzustand).
- **Darf nicht**: Die Salzdatei **nicht** unter `OMP_WEB_HOME_ROOT` legen. Das ist die Wurzel fuer
  die Home-Verzeichnisse der Konten und laut `checkHomeRootWritable` (`bin/web-auth-store.js`)
  haeufig `root:root` und fuer den Dienst unbeschreibbar; das Verzeichnis der Credential-Datei ist
  dagegen nachweislich beschreibbar (`writeWebAuthConfig` legt es mit `0700` an).
- **Kann**: `OMP_WEB_SESSION_KEY_EPHEMERAL=1` (`:74`) als Ausstieg: dann bleibt der Salz
  prozesslokal (`randomBytes(32)`), es entsteht keine Datei, und ein Neustart meldet wieder alle ab.
  Der Zweig existiert fuer Installationen, die genau das wollen — nicht als Default.
- **Darf nicht**: Bei unschreibbarem Ziel **nicht** werfen. `loadOrCreateSessionKey()` (`:111-128`)
  faellt auf einen Prozess-Salz zurueck: Anmelden funktioniert weiter, Sessions sterben mit dem
  Prozess. Ein `Set-Cookie`-Fehler wuerde eine laufende Installation wegen einer
  Verzeichnisberechtigung komplett abschalten.
- **Ist**: `SESSION_TTL_MS` (`:63`) ist **30 Tage**, nicht eine Stunde. Die Zahl ist die
  **Leerlaufzeit**, nicht die Sitzungslaenge: `proxy.ts:178-191` stellt den Cookie neu aus, sobald
  mehr als `SESSION_RENEW_AFTER_MS` (`:71`, die Haelfte) seit `issuedAt` vergangen sind, und die
  Drosselung ist der Punkt — ein offener Tab stellt gemessen ~36 authentifizierte Requests pro
  Minute; ohne die Halbwertsregel entstuende auf jedem davon ein `Set-Cookie`.
- **Darf nicht**: Die Lebensdauer wieder unter die Rueckkehrzeit eines Handys senken. Eine Stunde
  war der alte Wert und der Grund fuer den Fehler „nach dem Schliessen des Tabs wieder am Login":
  ein geschlossener Tab stellt keine Anfragen, also erreicht ihn die Gleitfrist nicht, und der
  Browser verwirft den Cookie, sobald `Max-Age` abgelaufen ist. Gemessen mit einem
  Handy-Viewport: 61 Minuten alter Cookie → Browser hat ihn geloescht → `/` antwortet mit `302` auf
  `/login`; 40 Minuten → `/`. Wer die TTL senkt, muss diese Messung wiederholen.
- **Darf nicht**: Eine lange TTL **ohne** die Gleitfrist. Beides zusammen ist die Regel: die
  Gleitfrist macht aus „in Benutzung“ ein immer neues Fenster und aus „nicht in Benutzung“ ein
  endliches. Eine Verlaengerung der TTL ohne die Gleitfrist (oder umgekehrt) macht aus einem
  vergessenen Laptop eine dauerhaft offene Sitzung.
- **Preis**: Ein kopierter Cookie ist eine kopierte Sitzung, jetzt bis zu 30 Tage statt einer
  Stunde. Die Gegenmittel haengen nicht am Ablaufdatum und sind unveraendert: Logout dreht die
  Epoche (alle Geraete), Passwortwechsel dreht den Schluessel, Schluesseldatei loeschen + Neustart
  meldet alles ab.
- **Darf nicht**: Im Gleit-Zweig **kein** `Set-Cookie` auf einem abgelehnten Request und keines auf
  dem Basic-Auth-Pfad. Beide kehren vor `proxy.ts:178` zurueck (`identity === null` bzw.
  `session === null`), und das muss so bleiben: sonst verlaengert ein Angreifer mit einem
  gestohlenen Cookie die Lebensdauer durch Klopfen auf einen 401.
- **Darf nicht**: Die Attribute der Erneuerung **nicht** getrennt von der Login-Route pflegen. Beide
  benutzen `sessionCookieOptions()` (`:420-430`): `HttpOnly`, `SameSite=lax`, `Path=/`,
  `Max-Age` aus `SESSION_TTL_MS`, `Secure` **nur** wenn die Anfrage ueber HTTPS kam
  (`x-forwarded-proto` oder `https:`-URL), nie `Domain`. Zwei `Set-Cookie` mit demselben Namen und
  unterschiedlichen Attributen sind zwei Cookies, und welches der Browser behaelt, haengt an der
  Header-Reihenfolge. `proxy.session-cookie.test.mjs` und
  `app/api/web-access/login/route.test.mjs` pruefen genau einen Header und die Attribute; vor
  dieser Aenderung hat **kein** Test die Attribute geprueft.
- **Ist**: `SameSite=lax`, **nicht** `strict`, und das ist kein Nachlassen. Ein Link, den der
  Betreiber in einer Mail oder einem Messenger antippt, ist eine **Cross-Site-Navigation**; `strict`
  haelt den Cookie bei genau dieser Anfrage zurueck, `proxy.ts` sieht keine Identitaet und
  antwortet `302 /login` — neben einem voll gueltigen Cookie im Browser. Gemessen mit einem echten
  Cross-Site-Link (`Sec-Fetch-Site: cross-site`, `Sec-Fetch-Mode: navigate`): `strict` landet auf
  `/login`, `lax` auf `/`.
- **Darf nicht**: `lax` fuer eine Absicherung der API halten. `lax` haelt den Cookie auf
  Cross-Site-**Subrequests** und Cross-Site-**POSTs** zurueck, und zusaetzlich weist
  `isApiRequestAllowed()` (`lib/request-security.ts`:112-119) `sec-fetch-site: cross-site` ab,
  **bevor** `proxy.ts` den Cookie liest — der 403 kommt vor jeder Authentifizierung.
  `proxy.session-cookie.test.mjs` haelt beides fest: derselbe Cross-Site-POST mit gueltigem Cookie
  bleibt 403, derselbe POST same-origin 200.
- **Darf nicht**: `SESSION_VERSION` nicht entfernen, wenn sich das Payload-Format aendert — ein
  alter Cookie muss **verworfen**, nicht falsch gelesen werden.
- **Ort**: `lib/web-auth-session.ts:35` (Cookie-Name), `:52` (TTL), `:60` (Erneuerungs-Schwelle),
  `:63` (Version), `:66-166` (Salz, Schluesseldatei, Ephemeral-Schalter), `:188-209`
  (Schluesselableitung), `:234-252` (`resolveSessionSecret` und `withEpoch`), `:266-281`
  (`readCookieUsername`), `:301-311` (Bau), `:366-399` (`readSession`), `:402-407`
  (`readSessionCookie`), `:420-430` (`sessionCookieOptions`)

### Session-Schluesselbindung (`resolveSessionSecret`)
- **Kann**: Schluesselt auf das, was eine Anmeldedatin eindeutig identifiziert **und sich mit ihr
  dreht**: der Klartext aus `OMP_WEB_PASSWORD`, oder der `salt:hash`-Fingerabdruck des
  gespeicherten Digests, oder beim Konto-Pfad `account:$name|$salt:$hash`. Damit stirbt ein neues
  Passwort **jedes** alte Cookie, ohne dass irgendwo ein Widerruf gefuehrt werden muss.
- **Darf nicht**: Den Konto-Zweig **nicht** entfernen, auch wenn es nie ein Passwort auf dem Server
  gab. Ohne ihn wuerde der Admin, der Konten aus dem Settings-Panel angelegt hat, feststellen,
  dass sich **keines** davon anmelden laesst, weil der Server nie eine Anmeldedatin verlangt hat —
  der ganze Mehrbenutzerpfad waere auf einem offenen Server tot. Das Konto-Digest ist der richtige
  Schluessel: einzigartig und mit dem Passwort rotierend.
- **Darf nicht**: `null` als „offener Server" interpretieren und einen Fallback-Schluessel erfinden.
  `open` ohne Konto dahinter hat nichts zu signieren, `unavailable` hat nichts Lesbares. In beiden
  Faellen gibt es nichts zu binden.
- **Kann**: Die **Widerrufs-Epoche** des Benutzers an jeden Zweig anhaengen (`withEpoch()`,
  `:250-252`): `…|session:<n>` aus `readSessionEpoch()` (`bin/web-auth-store.js`,
  `omp-web-sessions.json`). Das ist der einzige Weg, eine Sitzung zu beenden, **ohne** die
  Anmeldedatin anzufassen — und genau das verlangt ein Logout von einem selbsttragenden Cookie.
  Die Epoche steht im **Schluessel**, nicht im Payload: damit bleibt das Cookie-Format bei sechs
  Feldern und `SESSION_VERSION` bei 1, und ein alter Cookie faellt durch die Signatur statt durch
  eine zweite Pruefung, die man vergessen kann. Alle Sitzungen eines Benutzers sterben gemeinsam,
  auch auf einem zweiten Geraet — das ist „ueberall abmelden", nicht „hier abmelden".
- **Darf nicht**: Die Epoche **nicht** in den Payload legen. Dann muesste `readSession` zwei Dinge
  pruefen (Signatur und Feld), `SESSION_VERSION` muesste steigen, und jede Stelle, die die
  Feldzahl kennt (`readCookieUsername`, `lib/web-accounts.test.mjs:396`), muesste mitziehen. Ein
  Wert, der nur den Schluessel waehlt, gehoert in den Schluessel.
- **Darf nicht**: `omp-web-sessions.json` **nicht** als „Sitzungsliste" lesen. Sie enthaelt keine
  Sitzungen, nur einen Zaehler je Benutzer; es gibt weiterhin keinen Datensatz pro Login, keine
  Nonce-Familie und keine Replay-Sperre. Geht die Datei verloren, leben nur Cookies wieder auf, die
  innerhalb ihrer eigenen TTL widerrufen wurden.
- **Ort**: `lib/web-auth-session.ts:234-252`

### Login-API (`POST /api/web-access/login`)
- **Kann**: Tauscht Name + Passwort gegen ein `httpOnly`-Cookie und gibt `{ ok, user }` zurueck.
  Der Benutzername ist optional; leer bedeutet `getExpectedUsername()`, also der Pfad, den jede
  bestehende Installation benutzt und weshalb die Login-Seite mit `omp` vorbelegt ist. Der Name
  geht **signiert** ins Cookie, damit `proxy.ts` die Identitaet auf dem naechsten Request wieder
  aufbauen kann, ohne den Store zu fragen.
- **Darf nicht**: Der Login darf **nicht** die erste und einzige Authentifizierungsstelle werden.
  Basic Auth bleibt, weil curl, der Reverse Proxy und bestehende Clients darauf laufen. Wer Basic
  Auth entfernt, nimmt denen die einzige Maschinen-Tuer.
- **Darf nicht**: Die Fehlermeldung **nicht** veraendern. `REJECTED` (`:26`) ist fuer **jeden**
  Fehlschlag dieselbe: falsches Passwort, fehlender Store, Lock aus. Was der Angreifer daraus
  lernen will, hilft niemandem, der sich beim Passwort vertippt hat. Dazu kommt
  `FAILURE_DELAY_MS = 150` (`:34`), ungefaehr die Kosten einer scrypt-Verifikation, damit ein
  falsches Passwort, ein fehlender Store und ein richtiges Passwort **ueber das Draht nicht
  unterscheidbar** sind. Jede Verzoegerung, die nur den Fehlerfall trifft, ist selbst eine
  Oracle-Antwort.
- **Darf nicht**: `isApiRequestAllowed()` (`:48`) **nicht** entfernen, obwohl `proxy.ts` dieselbe
  Pruefung schon gemacht hat. Die Route ist per Matcher geschuetzt, aber der Guard ist billig und
  die Datei ist dadurch lesbar ohne den Proxy gelesen zu haben. Analog: `hasJsonContentType()`
  **vor** `req.json()` — sonst kann ein `text/plain`-Body als JSON geparst werden und den
  Content-Type-Vertrag umgehen.
- **Kann**: `Secure` folgt der Anfrage, ueber die sie kam: `sessionCookieOptions()` setzt es, wenn
  die URL `https:` ist oder `x-forwarded-proto` `https` meldet. Auf dem internen Klartext-Port
  `:8788` bleibt es aus — ein `secure`-Cookie wuerde der Browser dort bei jedem Request verwerfen,
  der Login waere unmoeglich — und hinter der TLS-Terminierung ist es an. Kein Schalter, den
  jemand vergessen kann: derselbe Helper schreibt Login, Erneuerung und Logout.
- **Darf nicht**: `maxAge` **nicht** hier berechnen. Es kommt aus `sessionCookieOptions()` und damit
  aus `SESSION_TTL_MS`; eine zweite Zahl an dieser Stelle waere die erste, die nach der
  naechsten TTL-Aenderung falsch ist.
- **Ort**: `app/api/web-access/login/route.ts:33` (`REJECTED`), `:40` (Delay), `:54-104` (POST),
  `:55-62` (Guards), `:80` (Verifikation), `:97-98` (Cookie-Set ueber `sessionCookieOptions`)

### Abmelden (`DELETE /api/web-access/login`)
- **Kann**: Zwei Dinge in einem Request: `omp_session` auf einen leeren Wert mit `maxAge: 0` und
  denselben Attributen wie beim Setzen, **und** `bumpSessionEpoch()` fuer den Benutzer aus dem
  vorgelegten Cookie. Das zweite ist der eigentliche Widerruf — vorher loeschte der Logout nur die
  Kopie im Browser, und die Kopie, die ein Angreifer schon hatte, galt weiter (gemessen: nach dem
  Logout war derselbe Cookie `200`). Jetzt faellt sie durch die Signatur, auf diesem Server und auf
  jedem, der dieselbe Datei liest.
- **Darf nicht**: **Nicht** behaupten, damit sei man ueberall abgemeldet. Der Basic-Auth-Pfad
  laesst sich nicht abmelden — ein Client, der `Authorization` schickt, ist nach dem Logout
  weiterhin angemeldet. Das steht so im Kommentar und gehoert dort hin. (Der Cookie-Pfad ist es
  jetzt wirklich: jede Sitzung dieses Benutzers stirbt.)
- **Darf nicht**: Das Erhoehen **nicht** scheitern lassen, wenn der Store nicht schreibbar ist
  (`try/catch`, `console.error`). Der Browser-Cookie ist dann trotzdem weg, die fremde Kopie
  laeuft mit ihrer TTL aus — ein 500 waere schlechter, weil der Nutzer dann auch hier angemeldet
  bliebe.
- **Darf nicht**: Die Cookie-Attribute hier veraendern. Sie muessen mit denen aus `POST`
  uebereinstimmen (gleicher Helper), sonst loescht der Browser das Cookie nicht.
- **Ort**: `app/api/web-access/login/route.ts:106-135`

### Login-Seite (`app/login/page.tsx`)
- **Kann**: Reines Formular: schickt `{ username, password }` als JSON an
  `/api/web-access/login`, bei Erfolg `router.replace("/")` + `router.refresh()` (`replace`, damit
  der Zurueck-Knopf nicht auf ein bereits erfuelltes Formular fuehrt).
  `autoComplete="username"` / `"current-password"`, `spellCheck={false}`,
  `autoCapitalize="off"` auf dem Namenfeld.
- **Darf nicht**: Kein `autoFocus` auf das Passwortfeld (`useEffect` bei `:78-80` stattdessen).
  `autoFocus` feuert waehrend des Commits, und `Reveal` hat zu diesem Zeitpunkt bereits
  `opacity: 0`, Y-Offset und 6 px Blur auf die Karte geschrieben. Ein Element, das der Browser
  nicht sehen kann, bekommt keinen Fokus: der Aufruf wird angenommen, der Cursor bleibt auf
  `<body>`, kein Fehler, kein Log.
- **Darf nicht**: `select()` in `focusPassword()` (`:49-55`) nicht als Dekoration entfernen. Chrome
  und Edge setzen den Cursor bei autofuellendem Passwort ans Ende; wer direkt tippt, schreibt sonst
  **in die Mitte** des gespeicherten Geheimnisses. Das gilt fuer jedes Formularfeld in einer
  animierten Flaeche, nicht nur fuer Login.
- **Darf nicht**: Den Effekt von `[focusPassword, rejected]` abhaengig machen, nicht von `busy`,
  `error`, `password`, `username` oder `revealed` — die alle waehrend eines normalen Versuchs churnen,
  und Fokus waehrenddessen zurueckzunehmen kaempft mit dem Besucher um den Cursor.
- **Darf nicht**: `key={rejected}` auf dem Submit-Button (`:180`) nicht entfernen, ohne den Fokus
  mitzudenken. Der Key bindet die Schuettel-Animation an einen Zaehler; weil der Button dadurch
  bei jedem Fehlversuch **remountet**, faellt der Fokus auf `body`. Der Effekt haengt an `rejected`
  und behebt das nebenbei. Wer den Key fuer die Animation setzt, sollte pruefen, ob die Fokuswirkung
  mitgedacht ist.
- **Darf nicht**: Das Passwortfeld als `text` rendern, solange `revealed` false ist, und
  `revealed` nicht an den Server schicken — es ist reiner UI-Zustand.
- **Ort**: `app/login/page.tsx:49-55` (`focusPassword`), `:78-80` (Effekt), `:82-103` (`signIn`),
  `:180` (`key={rejected}`)

### Recovery-Seite (`app/recover/page.tsx`)
- **Kann**: Zweistufig: `action: "request"` druckt auf dem Server einen Einmalcode,
  `action: "complete"` setzt mit diesem Code ein neues Passwort. Die Seite selbst kann niemanden
  hereinlassen — siehe unten. `MIN_PASSWORD_LENGTH = 8` (`:17`) spiegelt `validatePassword`; das
  Client-Gate `:75-78` ist Bequemlichkeit, die Serverseite prueft ohnehin.
- **Darf nicht**: Die Seite darf **nie** den Recovery-Code entgegennehmen, den sie selbst erzeugt
  hat, oder ihn irgendwo anzeigen, speichern oder per Mail versenden. Der Code wird auf der
  Konsole des Servers gedruckt, und der ganze Flow beweist damit, dass der Treiber diese Maschine
  sehen kann. Ein Code, den der Client selbst sehen kann, beweist nichts.
- **Darf nicht**: `post()` (`:30`) darf **nicht** die Cross-Site-/`isApiRequestAllowed`-Logik
  umgehen, indem sie eigene Header setzt. Sie nutzt denselben Pfad wie jede andere API und erbt die
  Pruefung aus `proxy.ts`.
- **Darf nicht**: Die Fehlermeldungen der Seite **nicht** „verschoenern". Insbesondere der Text
  „No terminal at hand? Run `omp-web --reset-password`" ist eine Wegbeschreibung fuer den
  legitimen Betreiber — er nennt aber gleichzeitig, dass es einen Weg gibt. Er darf nicht mit einem
  Hinweis auf Konten, Admins oder andere Mandanten verbunden werden.
- **Ort**: `app/recover/page.tsx:17` (Min-Laenge), `:30-39` (`post`), `:41-53` (`requestCode`),
  `:55-73` (`completeRecovery`), `:75-78` (`canSubmit`)

### Recovery-API (`POST /api/web-access/recovery`)
- **Kann**: Die **einzige** Endpunkt-Familie in diesem Bereich, die ohne Anmeldedaten antwortet —
  und sie gibt nichts heraus. `request` mintet einen Code und **druckt ihn auf der Server-Konsole**
  (`announceRecoveryCode`, `:23-38`), dem Terminal, in dem omp-web laeuft. `complete` gibt den Code
  aus und setzt ein neues Passwort. Form: `XXXX-XXXX-XXXX`, Crockford-Base32 ohne die mehrdeutigen
  Zeichen, damit ein Code von der Konsole ablesbar ist.
- **Darf nicht**: Der Code darf **nicht** in der HTTP-Antwort stehen. Wer ihn zurueckgibt, macht
  die Route zur Selbstbedienung: ein Portscanner, der sie findet, laesst sich selbst zum Besitzer
  des Passworts machen. Der Konsolen-Print **ist** der Authentifizierungsschritt.
- **Darf nicht**: Die Pfadpruefungen `managedByEnvironment` (`:53`), `unreadable` (`:62`) und
  `!stored` (`:68`) **nicht** entfernen oder in eine Reihenfolge bringen, die vorher `req.json()`
  liest. Eine Credential-Datei, die nicht parsebar ist, kann auch keinen Recovery-Code halten — und
  einen zu minten wuerde bedeuten, die Datei neu zu schreiben, also einen Server **entsperren**,
  dessen Passwort niemand verifizieren kann. Das braucht eine Shell auf der Maschine.
- **Darf nicht**: Bei `action: "complete"` das Passwort **vor** der Codepruefung validieren
  (`bin/web-auth-store.js:1055-1058`). Sonst ist die Validierungsantwort eine Oracle-Frage: „Ihr
  Code war richtig, das Passwort ist zu kurz".
- **Darf nicht**: `hasJsonContentType()` (`:41`) **nicht** nach `req.json()` legen.
- **Darf nicht**: Recovery als Aktion in `app/api/web-access/route.ts` aufnehmen. Es ist bewusst in
  `./recovery` getrennt: es ist die eine Endpunkt-Familie, die ohne Anmeldedaten antwortet, und es
  gehoert nicht in die Route, die den Admin-Guard traegt.
- **Ort**: `app/api/web-access/recovery/route.ts:23-38` (Konsolen-Print), `:40-113` (POST),
  `:53-73` (Vorbedingungen), `:75-88` (`request`), `:90-112` (`complete`)

### Recovery-Code (`bin/web-auth-store.js`)
- **Kann**: 10 Minuten TTL, 5 Versuche, 30 s Abstand zwischen zwei Ausstellungen, Einmalnutzung. Der
  Code wird **niemals im Klartext persistiert**, nur als Digest (`:1006-1016`).
  `normalizeRecoveryCode` (`:979-987`) verzeiht Gross-/Kleinschreibung und die
  Crockford-Verwechslungen `O`/`Q` -> `0`, `I`/`L` -> `1`, `U` -> `V`, damit ein von der Konsole
  abgelesener Code nicht an `O` gegen `0` scheitert.
- **Darf nicht**: Den Code nicht im Klartext speichern. Ein Digest ist der Grund, warum ein
  Lesezugriff auf `omp-web-auth.json` nicht sofort zur Kontrolle ueber den Host fuehrt — der Code
  ist ohnehin 10 Minuten gueltig.
- **Darf nicht**: `RECOVERY_MAX_ATTEMPTS` (5) nicht als reines Rate-Limit behandeln, das man
  wegkuerzen darf. Der Code wird bei Erfolg, Ablauf **und** bei erschöpften Versuchen **geloescht**
  (`:1034-1043`, `:1050-1053`). Ein falscher Tipp kann so nie unbegrenzt wiederholt werden.
- **Darf nicht**: Die Re-Kodierung in `formatRecoveryCode` (`:966-974`) nicht „verbessern".
  Ablehnungssampling waere hier Ueberfluss: das Alphabet hat 32 Symbole und ein Byte wird modulo 32
  reduziert, was exakt ist.
- **Ort**: `bin/web-auth-store.js:63-67` (Konstanten), `bin/web-auth-store.js:966-974` (Format),
  `bin/web-auth-store.js:979-987` (Normalisierung), `bin/web-auth-store.js:996-1021`
  (`issueRecoveryCode`), `bin/web-auth-store.js:1030-1067` (`consumeRecoveryCode`)

### Passwort-Store-API (`/api/web-access`, GET + PUT)
- **Kann**: Das Einzelschloss, so wie das Settings-Panel es fährt. GET liefert
  `getWebAuthStatus()` (inkl. `username` und absolutem Pfad der Credential-Datei). PUT versteht
  `set-password`, `set-username`, `enable`, `disable`, `clear` (`:46`).
- **Kann**: `ACTIONS` ist ein `Set`, kein Array zum Durchiterieren (`:46`, `:81`). Eine unbekannte
  Aktion ergibt 400. Das ist Absicht: eine Liste, die man durchlaeuft, waere eine Liste, die man
  vergisst zu ergaenzen.
- **Darf nicht**: **`requireAdmin` in GET **und** PUT, jeweils als erste Zeile** (`route.ts:57`,
  `:66`). Das ist der in dieser Runde behobene Einbruch (`bf170f9`): das Konto `bob` schickte
  `PUT {"action":"disable"}`, bekam 200, danach war `policy.mode === "open"` und `/api/settings`,
  `/api/models`, `/api/file-index` antworteten ohne jede Anmeldedatin mit 200. Der Einbruch kam
  **dadurch**, dass ein Kommentar das Gegenteil behauptete: er argumentierte aus der
  Proxy-Freigabe zur Stille der Route — der Proxy hatte jeden Request geprueft, also blieb hier
  nur noch der Payload zu polizeien. **Das Argument ist das, was sterben muss, nicht die fehlende
  Zeile darunter.**
- **Darf nicht**: `body.username` ungeprueft an `setWebPassword` weiterreichen (`:107`). `body` ist
  `unknown` von `req.json()` bis hierher; ein Nicht-String wird verworfen statt durchgereicht,
  weil `setWebPassword` `undefined` als „behalte das Gespeicherte" liest — ein Client, der eine
  Zahl schickt, bekommt sonst den bestehenden Benutzernamen zurueck statt ein gespeichertes
  `"42"`.
- **Darf nicht**: Den 409- bei `managedByEnvironment` (`:89-95`) **nicht** so lesen, als rueckte er
  den Vorrang von `OMP_WEB_PASSWORD` rueckgaengig. Er verhindert nur, dass die UI es versteckt.
  `resolveWebAuthPolicy` gibt der Environment-Variable weiterhin Vorrang vor der Datei — siehe
  unten.
- **Ort**: `app/api/web-access/route.ts:44-46` (Aktionen), `:52-61` (GET), `:63-119` (PUT),
  `:66-69` (Guard-Reihenfolge), `:81-86` (Aktionspruefung), `:89-95` (Env-Guard), `:99-107`
  (Password/Narrowing)

### Konten-API (`/api/web-access/users`)
- **Kann**: GET listet alle Konten plus `resolveHomeRoot()`. POST legt ein Konto an. PATCH setzt
  Passwort oder `enabled`. Drei Regeln, die jede Aktion hier einhaelt: Admin aus der Identitaet,
  kein Klartext-Passwort in der Antwort, kein Self-Service.
- **Darf nicht**: **Kein Klartext-Passwort in der Antwort.** `WebAccount` traegt den scrypt-Digest.
  Zurueck kommt der Datensatz genau so, wie er auf der Platte liegt — deshalb steht hier kein
  Filter, der Felder wegnimmt, sondern der Store kann das Klartext gar nicht liefern, es wurde beim
  Anlegen zu einem Digest gehasht und danach nie gespeichert. Sonst steht das Passwort im
  Terminal-Scrollback des Admins und danach in irgendeinem Log.
- **Darf nicht**: **Keine Registrierungsroute und kein Self-Service** hinzufuegen. Es gibt genau
  einen Weg, auf dem ein Konto entsteht, und der laeuft durch diese Datei. Wer sich anmelden kann,
  muss vorher hier eingetragen worden sein; wer hier steht, hat ein Passwort vom Admin bekommen. Eine
  Selbstbedienung, die sich ihr eigenes Verzeichnis anlegt, waere eine Anmeldeschleife, die sich
  selbst Rechte gibt.
- **Darf nicht**: `validateAccountName` **vor** jedem `mkdir` laufen lassen (`route.ts:99`,
  Reihenfolge-Kommentar `:89-94`). Es ist die Absicherung gegen `../etc` und `a/b`, und
  `createWebAccount` prueft es ein zweites Mal direkt vor dem `mkdir`. Ein 400 darf **kein**
  Verzeichnis hinterlassen.
- **Darf nicht**: Die trim-Pruefung `body.username.trim() !== body.username` (`:96`) nicht als
  Kosmetik behandeln. Zusammen mit `ACCOUNT_NAME_PATTERN` verhindert sie, dass ein Name als
  Verzeichnis unter `/home` etwas anderes als ein einzelnes Pfadsegment wird.
- **Darf nicht**: `ACCOUNT_ACTIONS` (`:45-48`) nicht zu einer Liste machen, die man durchiteriert.
  `set-password` und `set-enabled` sind ein Lookup; ein Default im PATCH-Handler waere ein Konto,
  dessen Passwort zurueckgesetzt werden kann, weil jemand die Aktionspruefung vergessen hat.
- **Darf nicht**: `body.enabled` nicht als truthy-Wert durchreichen (`:145-149`). Es muss
  `boolean` sein, sonst ist `set-enabled` eine Schaltflaeche, die jeder selbst umlegt.
- **Ort**: `app/api/web-access/users/route.ts:20-38` (drei Regeln), `:45-48` (`ACCOUNT_ACTIONS`),
  `:50-73` (GET), `:75-119` (POST), `:89-101` (Namenspruefung), `:121-163` (PATCH)

### `createWebAccount` — Konto + Home anlegen
- **Kann**: Legt Datensatz **und** Home-Verzeichnis an. Das Verzeichnis entsteht hier und **nur
  hier**. Rechte `0o700`, Besitzer der Prozessbenutzer. Das ist eine echte Grenze innerhalb des
  Hosts — sie war lange die einzige, weil der Prozess selbst weiter ohne uid-Wechsel laeuft. Die
  zweite Grenze ist die Terminal-Shell, die seit `lib/sandbox.ts` in einer User-Namespace laeuft
  und dieses Verzeichnis gar nicht sieht.
- **Kann**: Das Verzeichnis wird **vor** dem Datensatz angelegt. Existiert es schon, ist der Name
  vergeben, auch wenn der Datensatz fehlt — ohne diese Reihenfolge gaebe es ein Konto ohne Home,
  das nicht mehr loswird. Schreibt der Datensatz danach fehl, wird `rmdirSync(home)` aufgerufen:
  kein halb angelegtes Konto (`:774-779`).
- **Darf nicht**: `mkdirSync(home, { mode: 0o700 })` **nicht** auf einen laxeren Modus aendern.
  Die Rechte werden nie aufgeweicht — auch nicht auf einem bestehenden Verzeichnis.
- **Darf nicht**: Den Kommentar zu `mode: 0o700` (`:722-727`) nicht als ueberholt loeschen, nur weil
  die Sandbox die zweite Grenze ist. Beide Grenzen existieren; die Sandbox ist eine Verteidigung in
  die Tiefe, nicht ein Ersatz.
- **Ort**: `bin/web-auth-store.js:729-786`, `bin/web-auth-store.js:722-727` (Rechte-Begruendung),
  `bin/web-auth-store.js:768-779` (Reihenfolge + Rollback)

### `resolveWebAuthPolicy` — die vier Modi
- **Kann**: `mode` steuert jeden Aufrufer: `open` laesst durch, `environment` und `stored`
  verlangen Anmeldedaten, `unavailable` **failt geschlossen**. Ein gesperrter Server **ohne**
  benutzbaren Digest liefert `unavailable`, nicht `open`: niemand koennte sich authentifizieren,
  also ist Verweigern die einzige ehrliche Antwort (`:517-521`).
- **Darf nicht**: `OMP_WEB_PASSWORD` **vor** der Datei pruefen (`:506-507`). Diese Reihenfolge ist
  nicht offensichtlich und faellt erfahrungsgemaess erst im Betrieb auf: `OMP_WEB_PASSWORD`
  **schlaegt** das gespeicherte Passwort. Am 12.10.2026 wurde damit kurzzeitig ein Testzugang
  gesetzt, wodurch das gespeicherte Passwort eines Betreibers ausser Kraft gesetzt wurde. Der
  409-Guard in `app/api/web-access/route.ts:89` verhindert nur, dass die UI es versteckt — er macht
  den Vorrang nicht rueckgaengig. Steht auch in `docs/known-findings.md`.
- **Darf nicht**: `unavailable` in `open` umdeuten, um eine unlesbare Datei „nicht zu blockieren".
  Das waere genau der Einbruch, den `app/api/web-access/recovery/route.ts:62-67` verhindert.
- **Ort**: `bin/web-auth-store.js:502-521`, `bin/web-auth-store.js:524-556` (`getWebAuthStatus`)

### Admin-Liste (`isAdminUsername`, `resolveAdminUsernames`)
- **Kann** (Stand `2699054`, **in Aenderung**): `isAdminUsername(username)` ist
  `resolveAdminUsernames(env).includes(username)` (`bin/web-auth-store.js:350-353`). Die Liste
  kommt aus `OMP_WEB_ADMINS` (kommagetrennt) und ueberschreibt die Vorgabe
  `["pi","omp","steimerbyte"]` (`:88`, `:342-348`). **In Aenderung:** die Rolle soll in der
  Kontendatei stehen; diese Namenskonvention faellt dann als Quelle der Admin-Bestimmung weg.
- **Darf nicht**: `OMP_WEB_ADMINS` mit einer Wildcard-Syntax erweitern, die einen normalen
  Konto-Namen treffen koennte. Der Name muss exakt in der Liste stehen; ein Praefix-Match macht
  aus `bob_admin` einen Admin.
- **Darf nicht**: Leerer Wert als „alle" lesen. Leer heisst „es gibt **keine** Admins"
  (`:344`) — mit leerem `OMP_WEB_ADMINS` ist das gesamte Admin-Panel gesperrt (Kontenverwaltung,
  globale Skills, Passwort-Store).
- **Darf nicht**: `isAdmin` **beim Schreiben** in die Kontendatei legen. `normalizeAccountEntry`
  (`:680-693`) rechnet `isAdmin` bei jedem Lesen neu aus und **nie** aus der Datei: die Datei
  koennte von einem aelteren Stand stammen oder manipuliert sein, und die Admin-Frage gehoert der
  Installation, nicht dem Datensatz. Ein geschriebenes `isAdmin: true` fuer einen Nicht-Admin wird
  stillschweigend zu `false`. **In Aenderung:** diese Regel wandert mit der geplanten
  Rollen-Aenderung mit — sie ist der Grund, warum die Datei heute keine Autoritaet ueber Admin ist.
- **Darf nicht**: Eine eigene Admin-Liste in `lib/web-auth.ts` pflegen. `isAdminUsername` ist dort
  ein bewusster Re-Export der Store-Funktion, keine Kopie: die Liste gehoert der Installation, und
  ein zweiter Ort, an dem sie gepflegt wird, ist ein Ort, an dem sie veraltet.
- **Ort**: `bin/web-auth-store.js:88` (Vorgabe), `:342-348` (`resolveAdminUsernames`),
  `:350-353` (`isAdminUsername`), `:680-693` (`normalizeAccountEntry`); Re-Export in
  `lib/web-auth.ts:169`, `:174-180`

### Sicherheitsrelevante Umgebungsvariablen
- **Kann / wirkt**: `OMP_WEB_PASSWORD` — Klartextpasswort. Schlaegt die gespeicherte Anmeldedatin
  (siehe `resolveWebAuthPolicy`). Macht den Store `managedByEnvironment` und sperrt den
  Recovery-Pfad (`:53`). Ist sie gesetzt, ist das Schreiben im Store ein 409.
- **Kann / wirkt**: `OMP_WEB_ADMINS` — kommagetrennte Admin-Liste, **ueberschreibt** die Vorgabe
  `["pi","omp","steimerbyte"]`. Leerer Wert bedeutet „es gibt **keine** Admins" und **nicht**
  „alle" (`:342-348`). Wer `OMP_WEB_ADMINS=""` setzt, sperrt damit das gesamte Admin-Panel.
  **In Aenderung** — siehe Admin-Liste oben.
- **Kann / wirkt**: `OMP_WEB_AUTH_FILE` — ueberschreibt den Ort von `omp-web-auth.json`
  vollstaendig (`:128-132`). Alles XDG-Maessige wird ueber diese Variable adressiert.
- **Kann / wirkt**: `OMP_WEB_ACCOUNTS_FILE` — dasselbe fuer `omp-web-accounts.json` (`:156-160`).
- **Kann / wirkt**: `OMP_WEB_HOME_ROOT` — Wurzel, unter der Konto-Homes entstehen. Default
  `/home`. Ein stilles `/home` neben einem gesetzten Wert waere ein Fehler, der nur in der
  Testumgebung sichtbar ist und im Betrieb keiner — deshalb ist `env` in `getUserHome` ein
  Parameter.
- **Kann / wirkt**: `OMP_WEB_ALLOWED_ROOTS` — kommagetrennt, **nur Admins** (im Admin-Zweig von
  `getAdditionalAllowedRoots`). Zusaetzlich beschreibbar (`lib/write-access.ts:31-33`).
- **Kann / wirkt**: `OMP_WEB_HOSTNAME` / `OMP_WEB_ALLOWED_HOSTS` — die Host-Allowlist neben Loopback
  und IP-Literalen.
- **Kann / wirkt**: `OMP_WEB_USERNAME` — Fallback-Benutzername fuer Basic Auth, wenn die Datei
  keins traegt. Wird der Env-Pfad **nie** gecacht, weil die Env die einzige Eingabe ist, die sich
  zwischen zwei Aufrufen in einem lang laufenden Prozess aendern kann.
- **Darf nicht**: Keine dieser Variablen als Input eines Clients behandeln. Sie kommen alle aus der
  Prozessumgebung des Betreibers, nicht aus einem Request.
- **Ort**: `bin/web-auth-store.js:128-132`, `:156-160`, `:170-173`, `:342-348`, `:491-494`,
  `:506-507`; `lib/allowed-roots.ts:56-61`, `:94-99`; `lib/request-security.ts:39-44`

### `validateAccountName` vs. `validateUsername`
- **Kann**: `validateAccountName` (`:321-333`) ist bewusst strenger:
  `/^[a-z_][a-z0-9_-]{0,31}$/`, max 32 Zeichen, kein fuehrender/abschliessender Leerraum, kein
  Slash, kein `..`, keine Grossbuchstaben. `validateUsername` (`:304-311`) regelt nur, was Basic
  Auth uebertragen kann: max 256, kein Whitespace. Der Unterschied ist nicht Pedanterie: bei einem
  Konto geht es darum, was ein **Verzeichnisname** sein darf.
- **Darf nicht**: Die beiden nicht zusammenlegen oder die strenge Variante fuer Basic Auth
  verwenden. Ein Basic-Auth-Name darf mehr sein als ein Verzeichnisname; umgekehrt darf ein Konto
  **nie** einen Namen tragen, der als Verzeichnis unter `/home` etwas anderes als ein einzelnes
  Pfadsegment wuerde.
- **Darf nicht**: Whitespace-only-Namen nicht auf den Default zurueckfallen lassen
  (`validateUsername`, `:306-308`). Wer gerade einen eingegeben hat, soll sehen, was tatsaechlich
  geschrieben wurde.
- **Ort**: `bin/web-auth-store.js:101` (`ACCOUNT_NAME_PATTERN`), `:283-291` (`validatePassword`),
  `:304-311` (`validateUsername`), `:321-333` (`validateAccountName`)

### Passwort-Hashing und Verifikations-Cache
- **Kann**: scrypt mit N=16384, r=8, p=1, 64 Byte Key, 16 Byte Salz pro Digest (`:54`, `:386-395`).
  Ein von der Platte gelesener Digest gilt als **unvertraeuenge Eingabe**: Form **und** Kosten
  werden geprueft (`isUsableDigest`, `:372-383`), damit eine korrupte Datei keine Gigabytes
  anfordern kann. Obere Grenzen: `MAX_SCRYPT_COST = 1<<20`, BlockSize 32, Parallelisierung 8,
  Key 128. `maxmem` wird aus `128 * N * r * p` **abgeleitet**, nicht dem 32-MiB-Default von Node
  ueberlassen (`:355-364`).
- **Kann**: Der Verifikations-Cache (`:559-593`) speichert **nur erfolgreiche** Pruefungen, TTL
  5 Minuten, max 32 Eintraege, geschluesselt auf den Fingerabdruck des Digests, der sie akzeptiert
  hat. `proxy.ts` laeuft auf jedem Request — inklusive SSE-Reconnects und dem Session-Poll der
  Sidebar — und scrypt ist absichtlich langsam. Aendern oder Leeren des Passworts invalidiert jeden
  Eintrag, der davon abhing.
- **Darf nicht**: Fehlgeschlagene Verifikationen **nicht** cachen. Sonst ist die Map
  groessenbeschraenkt durch die Zahl der Rateversuche statt durch die Zahl realer Anmeldedaten —
  und der Cache wird zur zweiten Oracle-Quelle.
- **Darf nicht**: `clearVerificationCache()` nicht entfernen. Er wird nach jeder
  Credential-Aenderung in diesem Prozess aufgerufen (`:781`, `:947`, `:963`, und in
  `setWebAccountPassword`/`setWebAccountEnabled`).
- **Darf nicht**: `digestFingerprint` nicht durch den Klartext ersetzen. Der Fingerabdruck ist
  nicht-reversibel und dient nur als Cache-Key; `cacheKey` hasht `fingerprint:secret` noch einmal,
  sodass der Map-Key selbst kein Passwort enthaelt.
- **Darf nicht**: Die Dateirechte der Credential-Dateien nicht aufweichen. `writeWebAuthConfig`
  (`:451-479`) macht `mkdirSync(dir, { recursive: true, mode: 0o700 })`, schreibt ueber eine
  Temp-Datei mit `randomUUID()` im Namen und `renameSync` — atomar, damit ein Absturz mitten im
  Schreiben keine halbe Datei hinterlaesst.
- **Ort**: `bin/web-auth-store.js:54-60` (Parameter + Grenzen), `:355-364` (`scryptOptions`),
  `:372-383` (`isUsableDigest`), `:386-395` (`createDigest`), `:398-409` (`verifyDigest`),
  `:412-414` (`digestFingerprint`), `:451-479` (atomares Schreiben), `:559-593` (Cache)

### `whoami` — Nachweis der Verdrahtung
- **Kann**: Reine Leseabfrage ueber die Identitaet: liefert `{ user: { username, isAdmin, home } | null }`
  mit `Cache-Control: no-store`.
- **Darf nicht**: Sie steht **nicht** unter `/api/web-access/` und **darf** nicht dorthin verschoben
  werden. Der Bereich dort ist der Passwort-Store, den man auch bedienen muss, wenn man noch gar
  nicht weiss, wer man ist; diese Route gehoert in die Verwaltung, nicht in den Passwort-Store.
- **Kann**: Sie ist der Nachweis, dass die Kette Anmeldedaten -> Cookie-Signatur -> Proxy-Header
  angekommen ist. Gibt es diese Route nicht oder liefert sie `null`, ist irgendwo in dieser Kette
  ein Bruch.
- **Ort**: `app/api/whoami/route.ts:1-31`

### `hooks/useTheme.ts`
- **Kann**: Reiner Client-Zustand. `localStorage`-Keys `pi-theme` (Praeterenz), `omp-theme`
  (Legacy), `omp-theme-config` (gecachte omp-Konfiguration), alle drei gelesen **und** geschrieben,
  dazu `matchMedia`/`visibilitychange`/`focus` fuer Auto-Synchronisation und
  `document.startViewTransition` fuer den Theme-Wechsel.
- **Darf nicht**: **Kein sicherheitsrelevantes Verhalten.** In diesem Hook gibt es keine
  Anmeldedaten, keine Tokens, keine Cookies, keinen Zugriff auf `x-omp-user`. `localStorage` haelt
  nur Theme-Praeterenz und eine gecachte Farbkonfiguration — keine Geheimnisse. Der Eintrag steht
  hier, damit niemand auf die Suche nach „localStorage" hin eine Sicherheitsfrage stellt: das
  einzige Token im Client liegt in `httpOnly` und ist fuer JavaScript nicht lesbar.
- **Darf nicht**: Aus dem `THEME_CONFIG_KEY`-Cache keine Kontodaten machen. `refreshOmpTheme`
  (`:146-159`) holt `/api/theme?cwd=…` und legt die Antwort in `localStorage`; wenn dort eines
  Tages mandantenbezogene Daten landen, sind sie pro Browser und nicht pro Konto, weil
  `localStorage` nicht an `/api/web-access/login` gehaengt ist.
- **Ort**: `hooks/useTheme.ts:40-47` (Storage-Keys), `:146-159` (`refreshOmpTheme`), `:163-188`
  (`useTheme`)

---

## Bekannte Befunde aus `docs/known-findings.md` — als Regeln, nicht als Tickets

Diese drei Eintraege sind **keine offenen Tickets**, sondern Entscheidungen, die man beim
Refactor sonst wegoptimiert. Ausformuliert als „darf nicht".

### IDOR: `/api/sessions/[id]` filtert nicht nach Identitaet
- **Kann**: `GET`, `PATCH` und `DELETE` unter `app/api/sessions/[id]/route.ts:21/90/132` rufen
  `getRequestIdentity` **nicht** auf. `resolveSessionPath(id)` in `lib/session-reader.ts:202` ruft
  `listAllSessions()` ohne Identity-Argument und filtert deshalb nicht. `/api/sessions` (die Liste)
  prueft dagegen ueber `isSessionOwnedBy` sehr wohl — genau diese Inkonsistenz **ist** der Befund:
  die Liste ist zu, die Detailroute nicht.
- **Darf nicht** (warum es so bleibt): Session-IDs werden von `@oh-my-pi/pi-coding-agent` als
  `Bun.randomUUIDv7()` erzeugt, also mit 122 Bit Entropie. Es gibt keinen Enumerationsweg, und die
  Liste, die IDs preisgeben wuerde, filtert bereits. Bleibendes Risiko ist eine ID, die ausserhalb
  der App bekannt wurde: geteilter Link, Screenshot, Logfile, Export-Dateiname, Referrer.
- **Darf nicht** (die Form des Fixes, wenn er anfaellt): **Keinen eigenen Filter erfinden.** Die
  Detailroute braucht denselben `filterSessionsForIdentity`-Aufruf wie die Liste, mit derselben
  `null`-Semantik — denn `null` heisst in diesem Code „alles" und ist der CLI- und Startpfad. Wer
  heute einen Filter einbaut und diesen Fall mitreisst, sperrt den Besitzer aus seinen **eigenen**
  Sessions aus.
- **Darf nicht** (Ausloeser): Die Umsetzung faellt in dem Moment an, in dem ein **Nicht-Admin-Konto
  existiert**. Auf einem Einzelbenutzer-Host gibt es keine zweite Identitaet, die etwas anfragen
  koennte; der Befund ist dort theoretisch.
- **Ort**: `app/api/sessions/[id]/route.ts:21,90,132`; `lib/session-reader.ts:105-116`;
  `docs/known-findings.md:5-49`

### `OMP_WEB_PASSWORD` schlaegt das gespeicherte Passwort
- **Darf nicht**: Die Pruefreihenfolge in `resolveWebAuthPolicy()` nicht umdrehen und die Variable
  nicht als „Fallback" behandeln. `OMP_WEB_PASSWORD` hat **Vorrang** vor der Datei
  (`bin/web-auth-store.js:506-507`). Am 12.10.2026 wurde damit kurzzeitig ein Testzugang gesetzt,
  wodurch das gespeicherte Passwort eines Betreibers ausser Kraft gesetzt wurde. Die Reihenfolge ist
  nicht offensichtlich und faellt erfahrungsgemaess erst im Betrieb auf.
- **Darf nicht**: Den 409-Guard in `app/api/web-access/route.ts:89-95` als Fix missverstehen. Er
  verhindert nur, dass die UI den Zustand versteckt — er macht den Vorrang nicht rueckgaengig.
- **Ort**: `bin/web-auth-store.js:502-507`, `app/api/web-access/route.ts:89-95`,
  `app/api/web-access/recovery/route.ts:53-60`, `docs/known-findings.md:51-64`

### Sitzungen ueberleben einen Neustart
- **Kann**: Der Salz liegt in der Schluesseldatei (`lib/web-auth-session.ts:66-166`), also
  verifiziert der Prozess nach einem Deploy die Cookies des vorigen. Das ist die Umkehr der alten
  Regel („`KEY_SALT` nicht persistent machen") und beruht auf einer Messung, nicht auf einer
  Neigung: auf agent-pc laufen mit `Restart=always` und einem Healthcheck alle fuenf Minuten an
  einem Tag **~10 Neustarts** zusammen (`journalctl` 30.10.2026).
- **Darf nicht**: Die Datei wie eine Bequemlichkeit behandeln. Wer sie lesen kann, kann Cookies
  fuer jedes Konto muenzen, ohne das Passwort zu kennen — sie ist ein zweites Secret neben
  `omp-web-auth.json`, gehoert in dasselbe `0700`-Verzeichnis, mit `0600`, und in kein Backup, das
  weniger geschuetzt ist als das der Credential-Datei. Ein Konto-Home darf sie nie enthalten.
- **Darf nicht**: `OMP_WEB_SESSION_KEY_EPHEMERAL=1` zum Default machen, solange es keinen anderen
  Weg gegen das Symptom gibt: mit dem Schalter ist jeder Restart wieder ein Logout, und das sind
  auf agent-pc zehn pro Tag.
- **Darf nicht**: In Commit-Nachrichten oder Release-Notes eine feste Sitzungslaenge versprechen
  („24-Stunden-Session", „ueberlebt den Arbeitstag"). Die TTL ist eine **Leerlaufzeit**, sie gleitet,
  und die alte Formulierung stand schon einmal falsch da. Seit der Telefon-Messung sind es 30 Tage;
  eine Zahl in einer Release-Note ist nach der naechsten Aenderung falsch.
- **Ort**: `lib/web-auth-session.ts:66-166`, `docs/known-findings.md:111-134`,
  `docs/authentication.md` (Abschnitt „Sessions and what ends them")