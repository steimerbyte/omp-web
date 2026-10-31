# Changelog

All notable changes to this distribution. Versions are independent of the
upstream line — see the Provenance section in the README.

## Unreleased

### Features

**Der Kalender.** Eine eigene Ansicht in omp-web, erreichbar über den Knopf
neben dem Projekt-Dashboard in der Seitenleiste und über `?view=calendar`.
Monats-, Wochen- und Tagesansicht; Termine lassen sich per Klick anlegen,
per Ziehen verschieben, bearbeiten und löschen. Das Löschen fragt vorher nach,
weil es sich nicht zurücknehmen lässt und der Agent vom gelöschten Termin
nichts erfährt: eine Rückfrage kostet einen Klick, ein Versehen kostet den
Termin.

Die Rückfrage steht jetzt **im Dialog selbst**, und sie kostet **zwei Klicks**:
der erste schaltet den Dialog in den Bestätigungszustand, der zweite löscht.
Sie nennt den Termin — „Kunde Meier“ wirklich löschen? —, weil bei vielen
Terminen sonst keiner zu erkennen ist. Vorher stand hier ein natives Fenster
(`window.confirm`), und das hat in der Desktop-App gar nicht gefragt: das
Webview (`wry` 0.55.1) führt `runJavaScriptConfirmPanel` nicht aus, und Apple
dokumentiert für genau diese Lücke, dass sich die WebView verhält, als hätte
der Nutzer abgebrochen. Das Löschen fand dort also nie statt — ohne jede
sichtbare Rückmeldung, der Knopf tat schlicht nichts. Im Browser blockierte
das Fenster außerdem den Seitenthrend, bis der Nutzer antwortet.

Fehler beim Speichern und beim Löschen stehen jetzt **im** Dialog und nicht
mehr in der Meldungsleiste unter der Kalender-Kopfzeile: die Leiste liegt
hinter dem offenen Dialog und war unsichtbar, genau dann, wenn der Nutzer den
Fehler gebraucht hätte. Die Meldungsleiste bleibt für den Erfolgsfall — dort
ist der Dialog zu.

Ein neuer Termin aus einem freien Stundenraster bekommt eine Stunde als
Ende, nicht dieselbe Uhrzeit wie der Beginn — ein Termin, dessen Ende gleich
seinem Beginn wäre, wäre ungültig, und der Nutzer hätte an der freien
Stunde nichts falsch gemacht.

Der Kalender ist deutsch, und das ist mehr als eine Übersetzung: Die Woche
beginnt am Montag, die Kalenderwoche wird nach ISO 8601 gezählt (KW), die neun
bundesweiten Feiertage stehen in der Kopfzeile (Karfreitag, Ostermontag,
Christi Himmelfahrt und Pfingstmontag über die Gauss-Formel für das
Osterdatum berechnet), und das Datum erscheint als `14.03.2026`. Bundesländer-
spezifische Feiertage fehlen — ohne eine Bundesland-Auswahl kann der Kalender
sie nicht zutreffend anzeigen, und ein falscher Feiertag ist schlimmer als
ein fehlender.

Der Kalender ist in *jeder* Oberflächensprache deutsch. Seine Texte
kommen aus dem deutschen Sprachpaket, nicht aus der eingestellten Sprache:
deutsche Monats- und Wochentagsnamen, die ISO-Woche, die deutschen
Feiertagsnamen, das deutsche Datumsformat. Eine Oberfläche, in der der Kalender
„Oktober 2026" und „Tag der Deutschen Einheit" zeigt, aber die Knöpfe „Month"
und „Week" trägt, ist halb übersetzt — und einen englischen Kalender mit
deutschen Feiertagen gibt es nicht. Die `calendar.*`-Schlüssel stehen darum
ausschließlich im deutschen Paket; `lib/i18n/locale-parity.test.mjs` hält das
fest.

**Termine farblich markieren.** Ein Termin kann eine Farbe tragen: fünf
Presets (Akzent, Erfolg, Warnung, Gefahr, Violett) oder ein frei
gewählter Hex-Code über den Knopf „Benutzerdefiniert". Die Presets sind
Theme-Variablen und folgen dem importierten Theme — eine im Quelltext
festgeschriebene Farbe bliebe dort die alte. Violett ist dabei die eine
Ausnahme: die Titanium-Palette hat kein Violett, und `applyOmpPalette` kennt
nur Akzent, Erfolg, Fehler und Warnung. Im importierten Theme folgen die
vier übrigen Presets dem Theme, das Violett bleibt bei der Anwendung; der
Kommentar in `app/globals.css` sagt das ausdrücklich, damit die
Asymmetrie nicht als Versehen gelesen wird. Der eigene Hex-Code wird
wörtlich gespeichert, weil eine Farbe, die der Nutzer gewählt hat, seine
Wahl behalten soll, wenn das Theme wechselt — und nur in einer Schreibweise,
klein und sechs Stellen, damit dieselbe Farbe nicht als zwei Termine in der
Datei steht.

Die deutschen Namen der fünf Presets stehen dabei nicht im Sprachpaket,
sondern in `lib/calendar.ts` neben den Monats- und Wochentagsnamen: es ist
ein festes Vokabular des Kalenders, und Client und Server müssen dieselben
fünf Wörter nennen.

Der Hintergrund eines Termins ist die Terminfarbe, mit der Fläche des Themes
gemischt, und der Text bleibt in der Theme-Farbe. So bleibt ein Termin auch
mit `#ffffff` lesbar — und der Kontrast hängt am Theme, nicht an der Wahl
des Nutzers.

**Datum und Uhrzeit im 24-Stunden-Format.** Der Dialog hat eigene
Textfelder für Datum und Uhrzeit: die Uhrzeit als `15:00`, das Datum als
`14.03.2026`. Gemessen in Chromium mit englischem Browser-Locale zeigt ein
natives `<input type="time">` den Wert `15:00` als `03:00 PM` und ein
natives `<input type="date">` den Wert `2026-10-26` als `10/26/2026` — ein
`lang="de"` am Element ändert daran nichts. Der gespeicherte Wert war dabei
die ganze Zeit richtig; falsch war allein die Anzeige. Die nativen Felder
wurden deshalb ersetzt, nicht umformatiert: ihr Format folgt dem Browser,
nicht der Seite. Die Felder sind uncontrolled, damit „15:3" getippt und
danach „0" nachgetippt werden kann — die Normalisierung sitzt an der Grenze
zum Kalenderformat.

**Import aus einer `.ics`-Datei.** In der Kalender-Kopfzeile steht ein Knopf
„ICS importieren", der eine `.ics`-Datei annimmt. Der Import läuft in zwei
Schritten: die Datei wird gelesen und ausgewertet, und das Ergebnis erscheint
als Vorschau — es wird **nichts** geschrieben. Erst ein Klick auf
„Importieren" legt die Termine an. Zwei Schritte, weil ein Import sich nicht
zurücknehmen lässt: die Vorschau macht den Fehler sichtbar, **bevor**
geschrieben wird, und nicht danach.

Die Vorschau sagt, was importiert würde: die Zahl der Termine, die
**übersprungenen** Termine mit ihrem Grund, die **Warnungen**, die Zahl der
nicht ausgewerteten Wiederholungsregeln und die **Angaben, die nicht übernommen
wurden** — Erinnerungen, Teilnehmer, Kategorien, Organisatoren, Webadressen,
Statusangaben, Durchsichtigkeitsangaben, Zeitzonen und die übrigen Bestandteile
der Datei. Die Vorschau listet dabei nur die Formate auf, die wirklich
vorkommen; eine Liste voller Nullen wäre Rauschen. Eine Datei über 2 MB wird
schon im Browser abgewiesen — sie erzeugt gar keinen Request.

Ein Import kann teilweise gelingen: ein Termin ohne Startdatum oder ohne
brauchbares Ende fällt heraus, und die Datei nennt ihn mit seinem Grund — ein
unbrauchbarer Termin bricht den Import nicht ab. Die Grenzen des Formats
stehen dabei offen in der Vorschau. Eine Regel ohne Ende (kein `COUNT`, kein
`UNTIL`) wird nicht endlos expandiert, sondern liefert nur den ersten Termin
und steht als Meldung im Bericht. `BYSETPOS`, `BYYEARDAY` und andere Teile
der Regel, die der Kalender nicht kennt, werden nicht ausgewertet und ebenso
gemeldet.

Ein Duplikat erkennt der Import auf **zwei** Wegen, und die beiden Wege
unterscheiden sich. **Innerhalb der Datei** entscheidet die UID: zwei
Termine mit derselben UID sind derselbe Termin — der erste gewinnt, der
spätere fällt weg, samt aller seiner Wiederholungen. **Gegenüber dem
bereits vorhandenen Kalender** hilft nur der Inhalt, denn die UID wird nicht
gespeichert: dort entscheiden Titel, Beginn und Ende — für jeden Termin im
Kalender, ob er selbst angelegt oder importiert wurde.

Die Termine liegen in `omp-web-calendar.json` im Agent-Verzeichnis des Kontos:
eine Datei pro Konto, atomar geschrieben, `0o600`. Das ist dieselbe Form wie
bei den Quick Phrases und der Projekt-Registry.

**Der Agent liest und schreibt denselben Kalender.** Zwei neue Werkzeuge,
`calendar_read` und `calendar_write`, sind nativ angemeldet — im selben
`customTools`-Feld wie `present_files`. Nativ, weil der Kalender dem *Konto*
gehört und nicht dem Projekt: eine Datei unter `.omp/extensions` hinge am
Vertrauen in das Projekt, der Kalender an der Identität, die die Sitzung
geöffnet hat. Die Identität wandert deshalb mit der Sitzung
(`RpcSessionStartOptions.identity`), und die Werkzeuge sind daran gebunden —
ohne diese Bindung würde der Agent eines Mandanten den Kalender des
Betreibers lesen und schreiben.

`calendar_write` kann anlegen, ändern, verschieben und löschen. Ein Verschieben
ist ein Ändern von Beginn und Ende; dafür gibt es keinen zweiten Endpunkt.
Die Länge eines Termins bleibt dabei erhalten — wer einen zweistündigen Termin
verschiebt, bekommt keinen einstündigen. Jetzt reicht dafür ein einziger
Wert: ein `update` mit nur einem neuen Beginn berechnet das Ende aus der
bestehenden Dauer, und umgekehrt. Vorher scheiterte der Aufruf immer, sobald
der neue Beginn nach dem alten Ende lag. Auch der Ganztag-Flag folgt jetzt
der Schreibweise — beim Ändern wie beim Anlegen —, sodass der Wechsel zwischen
Ganztag und Uhrzeit keinen ausdrücklichen Flag mehr braucht.

Der Vertrag der Werkzeuge ist englisch, das Ergebnis deutsch: die Beschreibung
liest das Modell, das Ergebnis liest der Nutzer im Chatverlauf. Dasselbe
Muster wie beim anderen nativen Werkzeug `present_files`.

Jede Antwort von `calendar_read` beginnt mit dem heutigen Datum, seinem
Wochentag und den Grenzen der laufenden und der nächsten **Kalenderwoche**
(Montag bis Sonntag). Der Wochentag ist dabei der eigentliche Gewinn: Das
Harness schreibt in die erste User-Nachricht nur `Today: <YYYY-MM-DD>`, ohne
Wochentag, also musste der Agent den Wochentag selbst rechnen — und genau
das war der Anlass für die `bash date`-Aufrufe. Der Anker liefert die zweite,
müllfreie Quelle; er kommt aus dem Kalender, weil das Kalenderformat keine
Zeitzone kennt.

„Kalenderwoche" statt „Woche" ist kein Wortklang, sondern eine gemessene
Fehlerklasse: In der Nach-Messung las ein Agent die Ankerzeile „Nächste
Woche", rief ein zwei Wochen breites Fenster ab und bezeichnete in seiner
Antwort die falsche der beiden Linien als „die nächste Woche". „Kalenderwoche"
ist im Deutschen der etablierte Begriff für die ISO-Woche — die Anwendung
schreibt selbst „KW 11" in die Kopfzeile —, und „diese Woche" meint im
Gespräch die laufende. Der Anker sagt deshalb beide Male „Kalenderwoche".
Fragt der Nutzer nach einer Woche, fragt der Agent genau den Bereich ab, den
der Anker nennt — eine Woche, kein breiteres Fenster — und antwortet mit
demselben Bereich.

Der Anker präzisiert relative Angaben, er löst die Frage „welche Woche meinst
du" nicht: Die Baseline lief sonntags um 23:55, die Nach-Messung montags, und
Prompt 2 („Was steht diese Woche bei mir im Kalender?") war nur deshalb falsch,
weil „diese Woche" an einem Sonntagabend mehrdeutig ist. Ein Kontrolllauf mit
dem alten Vertrag am selben Montag lieferte dieselbe richtige Antwort.

Der Zeitraumfilter prüft Überschneidung, nicht den Beginn: ein Termin, der
nur teilweise im Zeitraum liegt, wird mitgeliefert. Ein Filter nach dem
Beginn würde einen Termin verdecken, der noch läuft.

Die Fehlermeldungen sagen, was zu tun ist: ein unbrauchbares Datum nennt das
erwartete Format und verlangt ein konkretes Datum statt „nächste Woche", eine
fehlende Kennung verweist auf `calendar_read`, ein fehlender Titel sagt, dass
ein Titel gebraucht wird. Gekürzte Felder werden gemeldet — ein Titel über 300
Zeichen und eine Notiz oder ein Ort über 4000 Zeichen werden gekürzt, und
das Ergebnis sagt es dem Nutzer, damit er es nicht am Text bemerkt. Und das
Löschen wird als endgültig gemeldet: es gibt keinen Papierkorb und kein
Rückgängig.

`calendar_write` kann auch die Farbe setzen (`color`): einen Preset-Namen
(`accent`, `success`, `warning`, `danger`, `violet`) oder einen Hex-Code.
Geprüft wird mit derselben Funktion wie in den Routen — was die Route
ablehnt, muss auch das Werkzeug ablehnen.

Zwei Fehler in der Werkzeugausgabe sind dabei aufgefallen und behoben: die
Löschmeldung formatierte einen Termin mit Uhrzeit wie ein reines Datum
(`am 06T15:00.11.2026`), und die Ausgabe eines Termins über Mitternacht
verlor dessen Enddatum (`26.10.2026, 22:00–02:00 Uhr`). Beides steht jetzt
richtig im Ergebnis.

**Der Werkzeug-Vertrag, gemessen.** Elf natürliche deutsche Aufgaben, sieben
aus der Baseline plus vier neue, die genau die geänderten Pfade treffen:
11/11 Agenten nutzten die Kalenderwerkzeuge, 10/11 kamen zu einem korrekten
Ergebnis, 0 erfundene Behauptungen, 0 vom Werkzeug abgelehnte Aufrufe in
beiden Läufen. Die `bash date`-Aufrufe zur Datumsermittlung gingen von 4 auf
1 zurück; wochentagsbereinigt (Kontrolllauf mit dem alten Vertrag am selben
Tag: 2) bleibt es 2 auf 1.

Am Werkzeug selbst gemessen, je eigenes Temp-HOME, alt gegen neu: ein
`update` mit nur `start` nach vorn scheiterte vorher mit „Das Ende liegt vor
dem Beginn." und rechnet jetzt die Dauer fort; nach hinten war er sogar
stillschweigend falsch (3-Tage-Termin) und ist es nicht mehr; der Wechsel
Ganztag ↔ Uhrzeit scheiterte vorher und gelingt jetzt; ein Ende gleich dem
Beginn bekommt jetzt eine eigene Meldung (das Ende muss *nach* dem Beginn
liegen), weil der alte Satz sachlich falsch war; und die Löschmeldung nennt
bei einem Termin mit Uhrzeit jetzt `am 06.11.2026, 15:00 Uhr` statt
`am 06T15:00.11.2026.`.

Die Oberfläche hängt an einem SSE-Strom (`GET /api/calendar/events`). Legt der
Agent einen Termin an, steht er im Kalender im Browser, ohne dass die Seite
neu geladen werden muss. Ohne diesen Strom stünde im Chat „Ich habe einen
Termin angelegt", während der Kalender leer bliebe. Der Strom schickt benannte
Ereignisse (`event: calendar_changed`), und der Browser hört mit
`addEventListener("calendar_changed", …)` darauf: eine SSE-Nachricht ohne
`event:`-Zeile käme als Standard-Ereignis `message` an und der Listener
feuerte nie — die Live-Aktualisierung fände dann stillschweigend nicht statt.

**Deutsch als Oberflächensprache.** `lib/i18n/messages/de.ts` ist ein
vollständiges Sprachpaket: es trägt alle 690 Schlüssel des englischen Katalogs
in derselben Reihenfolge und dazu 53 eigene `calendar.*`-Schlüssel, insgesamt
743. Ein deutscher Browser bekommt Deutsch, ohne dass etwas eingestellt werden
muss.

### Updates

**The update check compared this fork against the upstream package.** It asked
`registry.npmjs.org` for the version of `omp-web` and read the latest release
from `ddallabenetta/omp-web`. Both are the *upstream* distribution: the npm
package name belongs to the upstream line and the publish workflow is disabled
in this repository (`docs/release.md`), so the npm `latest` was a version of a
build nobody here ships. The comparison was therefore against a foreign version
line — and against a much lower one: the npm `latest` read 0,5,1 on 2026-10-23,
while this fork's `package.json` says 0,12,0. The result was that
`updateAvailable` was permanently `false` and the indicator rendered nothing.

The worse half was the other direction. `commandForManager()` built
`npm install --global omp-web@latest` (and the `bun add` variant of it), and
`installOmpWebUpdate()` ran that command through `execFile` from
`POST /api/updates`. The plan's `canInstall` was `true` whenever the foreign
package happened to be newer, so the one button in the update panel would have
replaced the running server with the upstream build over the top of it.

The check now reads exactly one source — the latest release of **this**
repository, `https://api.github.com/repos/steimerbyte/omp-web/releases/latest` —
and the npm registry is not consulted at all. Every release link that leaves
the server points at `steimerbyte/omp-web`: a payload whose `html_url` names
another repository has that link replaced rather than forwarded, so an upstream
link cannot travel to the browser through the panel.

There is no automatic install any more, because there is nothing to install:
this distribution ships no artifact a route could install. `install.canInstall`
is permanently `false` and `install.reason` names the reason (`manual`,
`disabled`, `current-version-unknown`). `POST /api/updates` stays admin-only and
answers 409 with the status, whose release link points at this repository; `GET`
stays open. The indicator renders nothing while `updateAvailable` is false, as
before, and when a release *is* newer it now shows the release notes and the
link to the release instead of a command that would have installed a different
build.

`lib/omp-updates.test.mjs` pins this: the status check asks this repository's
release API and nothing else, a foreign npm package with a higher version
yields neither `canInstall: true` nor a foreign release URL, and the module
names neither the upstream repository nor the npm registry.

### Settings

- Draw the navigation entries that are inactive without a project in the
  panel's own muted tone. They were the palest thing in the window at 0.36,
  paler than every other disabled control of the same panel — the switches
  and the reload hint sit at 0.55, the primary button at 0.5 — so it could
  not be told whether an entry was disabled or merely set in a thin weight.
  The contrast against the panel rises from 1.62:1 to 2.16:1 in the light
  theme and from 1.98:1 to 3.05:1 in the dark one.

- Draw the navigation labels at weight 600. At weight 500 the stem of the
  monospace glyphs is narrower than a pixel, the browser spreads it over two
  and mixes it into a lighter grey, so a label was painted in a colour other
  than the one it asked for — measured rgb(141,141,141) instead of
  rgb(108,108,108) — and the last letter of a word read like a different
  one ("Themes" like "Themed"). Nothing was cut off: the label is as wide as
  its text at every width. At weight 600 the stem is a full pixel and the
  label reaches its own colour exactly.

## v0.21.0

Released 2026-10-31.

Die drei Abschnitte standen bis hierher unter `Unreleased`; sie stehen jetzt
hier, weil dieser Release sie schneidet. Der Rest von `Unreleased` bleibt
unverändert stehen, wie in `v0.13.0`, `v0.14.0` und `v0.20.0`.

### Shell-Isolation

**Das Terminal ist fail-closed, und die Umgebung ist eine Allow-Liste.** Vorher
war die Sandbox nur der glückliche Pfad: fehlendes `bwrap`, abgeschaltete
User-Namespaces, ein cwd außerhalb des Homes und ein fehlendes Home öffneten
alle eine **unconfined** Shell, und die Env-Kopie lag innerhalb des
`if (plan.ok)`-Zweigs, sodass `OMP_WEB_PASSWORD` nur auf dem sandboxed Zweig
verschwand. Gemessen standen `BRAVE_API_KEY`, `OPENROUTER_API_KEY` und
`OMP_WEB_PASSWORD` in jeder Mandanten-Shell. Jetzt antwortet
`POST /api/terminal` mit **503**, `reason` und `remediation`, wenn keine Sandbox
gebaut werden kann; es startet kein Prozess. Ein **Admin** läuft bewusst
unconfined (`sandboxed: false`, wie bisher) — eine Entscheidung, kein Versehen,
und seine Umgebung ist dieselbe Allow-Liste.

Die Umgebung kommt aus `TERMINAL_ENV_ALLOWLIST` hinter `--clearenv`
(`PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `HOME`, `USER`, `LOGNAME`), auf beiden
Zweigen. Das ist die Umgebung, die der Spawn übergibt, nicht die endgültige: die
interaktive Shell startet über `script(1)` und liest `/etc/profile`, sodass
`/etc/profile.d/*` ergänzt — in einer Mandanten-Shell gemessen (`VSSCRIPT_PATH`,
`VIRTUAL_ENV_DISABLE_PROMPT`, `XDG_DATA_DIRS`). Diese Dateien gehören root und
sind in der Sandbox nur lesbar; ein Dienstgeheimnis kann auf diesem Weg nicht
auftauchen, weil es gar nicht in der Prozessumgebung steht.
Weil `/etc` für eine benutzbare Shell gebunden sein muss, werden die
eigenen Geheimnisdateien des Dienstes darin mit einer leeren Datei maskiert — ein
`/dev/null`-Bind scheitert an `MS_NODEV`, gemessen. Windows bekommt keine
Mandanten-Shell mehr (`unsupported-platform`), statt sie unconfined zu öffnen. Ein `delete env.X` ist weg: gemessen entfernt es den Wert nicht aus
`/proc/self/environ` und nicht aus einem Kind ohne eigene env-Map. Neu im argv:
`--ro-bind /run/systemd/resolve`, weil `/etc/resolv.conf` dorthin zeigt und
Namensauflösung in der Sandbox sonst tot ist (kein `npm install` möglich);
`home-missing` und `admin-home` als eigene Absagegründe, damit ein fehlendes
Konto-Home nicht als bwrap-Fehler erscheint und `/` nie gebunden wird.

**Dienstgeheimnisse stehen nicht mehr in der Prozessumgebung.** `OMP_WEB_PASSWORD`
(und jeder Provider-Key) kommt aus `OMP_WEB_SECRETS_FILE` (Vorgabe
`/etc/omp-web.env`) und liegt in einem Modulwert. Die Unit darf dafür weder
`Environment=` noch `EnvironmentFile=` benutzen — beide vererben den Wert an
jeden Kindprozess, und genau das war der Fund. Der Start loggt die Namen der
Geheimnisse, die er noch geerbt findet. Der mtime-Cache der Anmeldung bleibt
unverändert: die Umgebung ändert nur den Passwortwert, nie `OMP_WEB_AUTH_FILE`.

**`git` führt keinen Code eines Mandanten mehr aus — bis auf Includes.** Jeder
`git`-Aufruf trägt `GIT_ISOLATION_ARGS` (`core.hooksPath=/dev/null`,
`core.fsmonitor=false`, `diff.external=`, `--no-optional-locks`), die
abgeschalteten Treiber aus der Repo-Config (`filter.*.clean/smudge/process`,
`diff.*.textconv/command`) und eine Umgebung ohne Geheimnisse; die beiden Diffs
laufen mit `--no-textconv`. Gemessen bekam ein `core.fsmonitor`-Hook vorher
`BRAVE_API_KEY`, `OMP_WEB_PASSWORD` und `OPENROUTER_API_KEY`, und `git status`
führte den selbst definierten `clean`-Filter des Repos aus. Offen bleibt ein
Treiber, den das Repo über `include.path` in eine andere Datei auslagert — diese
Lösung liest nur die `.git/config`.

**Der Agent-`bash` hat jetzt eine Grenze — mehr gibt das SDK nicht her.**
`lib/session-shell-guard.ts` registriert pro Sitzung einen `tool_call`-Haken
(`CreateAgentSessionOptions.extensions`, in 18.14.0 pro Sitzung gebunden und an
Subagenten vererbt): `bash` wird abgelehnt, wenn die Sitzungswurzel außerhalb
des Kontohomes und der ausdrücklich vergebenen Wurzeln liegt. Das ist die ganze
Grenze, gemessen: das Parameterschema des `bash`-Werkzeugs ist in 18.14.0
`{command, timeout}`, es gibt keinen Arbeitsverzeichnis-Parameter im Aufruf, also
entscheidet der Haken einmal pro Aufruf gegen `ctx.cwd` — ein `cd /` im
Kommandotext sieht er nicht, und die Shell läuft weiter als Dienstbenutzer. Ein
SDK-Spawn-Haken (`BashToolOptions` hat einen, die Sitzung bekommt ihn nicht) oder
ein OS-Benutzer pro Konto wäre nötig; beides gibt es hier nicht.

### Behoben

**Ein Projekt konnte Code von außerhalb laden.** Der Codefilter für nicht
vertraute Projekte war eine Ausschlussregel: alles, was nicht unter dem
Projekt-Root lag, blieb geladen. Ein Projekt kann aber auf einen Pfad
*außerhalb* zeigen, und genau das passierte — eine `.omp/config.yml` mit
`extensions: [/tmp/outside-evil2/ext.ts]` lud dieses Modul, während der
Vertrauensdialog nichts zu fragen hatte, weil die Datei selbst nicht als
vertrauenswürdigende Ressource zählte. Jetzt entscheiden die Wurzeln, die omp
für dieses Konto ohnehin durchsucht: Agent-Verzeichnis und Prozess-Home. Eine
Erweiterung, die der Betreiber unter `/opt/foo.ts` eingetragen hat, lädt in
einem nicht vertrauten Projekt nicht mehr und ist nach einem Vertrauensklick
wieder da — ein Pfad unter den eigenen Wurzeln ist seine Entscheidung, ein
Pfad außerhalb des Projekts ist eine Zahl des Projekts.

`.omp/config.yml`, `.omp/settings.json` und `.claude/settings.json` lösen den
Dialog jetzt selbst aus, weil ihre Schlüssel bestimmen, was omp importiert; ein
Projekt, das nur eine Modell- oder Denkstufen-Einstellung mitbringt, wird
einmal gefragt. Ein nicht vertrautes Projekt lädt außerdem nichts mehr aus
seinem Inneren: keine Regeln, kein `AGENTS.md`, keine Prompt-Templates oder
Slash-Commands, kein eigenes `SYSTEM.md`/`APPEND_SYSTEM.md`. Vorher galten sie
als reine Daten und luden immer — sie sind aber Anweisungen an das Modell, und
wer ein Repository nur öffnet, hat sie nicht geschrieben.

**Ein Mandant erbte den Autorenbestand des Betreibers.** omp liest
`getAgentDir()` und `os.homedir()` aus dem Prozesszustand; jede
Mandantensitzung trug damit die `AGENTS.md`, `RULES.md`, `SYSTEM.md`,
`APPEND_SYSTEM.md`, Prompt-Templates und Slash-Commands des Betreibers. Die
Last-Policy (`lib/load-policy.ts`, ein `resolveSessionLoads` für Sitzung und
Panel) nimmt einer Mandantensitzung genau diese Lasten und lässt, was eine
Sitzung zum Arbeiten braucht: den Provider-Katalog, die Skills, die der
Betreiber installiert hat (die v0.20.0-Entscheidung), seine installierten
Erweiterungen und Werkzeuge, die eigenen Regeln und Prompts unter
`$HOME/.omp/agent` und den Inhalt eines Projekts, das kein Vertrauen verlangt.

MCP ist für einen Mandanten aus, nicht nur für ein nicht vertrautes Projekt:
`enableMCP` ist der einzige Hebel, und ein MCP-Server des Betreibers ist ein
Prozess mit den Rechten dieses Hosts; eine MCP-Verwaltung pro Konto gibt es
nicht. `memory.backend` steht auf `off` und `autolearn.enabled` auf `false`,
festgenagelt über `Settings.overlay` im Speicher, nie geschrieben:
`getMemoryRoot(agentDir, cwd)` und `getManagedSkillsDir()` zeigen auf das
Agent-Verzeichnis des Prozesses, ein Mandant läse sonst den Speicher des
Betreibers und legte seine Skills in dessen Bestand. Speicher für Mandanten
braucht eine Naht im SDK — die Lücke steht in `docs/project-trust.md` statt
einer Umleitung.

Weggelassenes bleibt sichtbar: je Liste eine `info`-Diagnose mit Anzahl, die
`GET /api/skills` mitliefert und der Sitzungsstart mit dem Präfix
`[load-policy]` protokolliert. Ein `/reload` weitet die Liste nicht — Regeln,
Context-Dateien und Prompt-Templates sind beim Anlegen fest, und die
Slash-Commands, die eine Aktualisierung neu aus den Prozesswurzeln liest,
laufen über `subscribeCommandMetadataChanged` und `setSlashCommands` erneut
durch denselben Filter.

**Ein Mandant schaltete hostweite Einstellungen.** `PATCH /api/settings`
prüfte nur, ob überhaupt ein Konto angemeldet ist. `autolearn.enabled` schaltet
`manage_skill` frei, das in den Prozess-Store schreibt, `memory.backend` lässt
eine Sitzung den Speicher des Betreibers lesen, `skills.*` und `commands.*`
verschieben die Discovery — Wirkung für den ganzen Host, geschrieben aus einem
Konto. Diese Schlüssel verlangen jetzt `requireAdmin` und antworten sonst 403;
`GET` markiert dieselben Felder mit `writable: false`, damit die Oberfläche den
Schalter sperrt, statt einen Schreibvorgang anzubieten, den der Server ablehnt.
Theme und Anzeige bleiben pro Konto und offen.

### Behoben: der Link auf dem Handy landete wieder am Login

Auf dem Telefon den Link öffnen, anmelden, den Tab schließen, später wieder
auf die Seite — statt der letzten Sitzung kam die Anmeldeseite. Das waren
**zwei** unabhängige Ursachen, die dieselbe Seite zeigen. Beide sind gemessen
und beide sind behoben.

**1. `SameSite=strict` hielt den Cookie auf dem Link zurück.** „Den Link im
Browser öffnen" heißt: eine Navigation, die in einer anderen App beginnt —
Mail, Messenger, Chat. Das ist eine Cross-Site-Navigation, und `strict` schickt
den Cookie bei genau dieser Anfrage nicht mit. `proxy.ts` sieht dann keine
Identität und antwortet `302 /login`, während im Browser ein voll gültiger
Cookie liegt. Gemessen mit einem echten Cross-Site-Link (anderer Host, gleicher
Browser, `Sec-Fetch-Site: cross-site`, `Sec-Fetch-Mode: navigate`): mit `strict`
landet die Navigation auf `/login`, mit `lax` auf der App — bei identischem
Cookie. `sameSite` ist jetzt `lax`; `lax` hält den Cookie weiterhin auf
Cross-Site-Subrequests und Cross-Site-POSTs zurück, und `isApiRequestAllowed()`
weist `sec-fetch-site: cross-site` ohnehin ab, bevor `proxy.ts` den Cookie
liest. Ein Test hält beides fest: derselbe Cross-Site-POST mit gültigem
Cookie bleibt 403, derselbe POST same-origin 200.

**2. Die Sitzung starb nach einer Stunde, auch ohne Zutun.** `SESSION_TTL_MS`
war eine Stunde, und eine Stunde ist eine *Leerlaufzeit*: der Cookie gleitet nur,
wenn Anfragen kommen. Ein geschlossener Tab stellt keine, also verwirft der
Browser ihn, sobald `Max-Age` abgelaufen ist. Gemessen mit einem
iPhone-14-Viewport gegen einen eigenen Produktionsbuild: ein Cookie, der vor 61
Minuten ausgestellt wurde, liegt im Browser nicht mehr und `GET /` antwortet mit
`302` auf `/login`; bei 40 Minuten landet derselbe Aufruf auf `/`.

Was **nicht** die Ursache war, jeweils gemessen: Login, Gleit-Erneuerung und
Logout schrieben die ganze Zeit dieselben Attribute (inklusive `Max-Age` und
`Expires`) — kein Session-Cookie, keine Verkürzung auf dem Erneuerungspfad; ein
Browserneustart mit demselben Profil kam innerhalb der Lebensdauer auf `/`
zurück, und ein Neustart des Prozesses ebenfalls, weil die Schlüsseldatei da
ist (`0600`, 44 Byte). Die Weiterleitung auf `/login` existiert nur für den
Fall „keine Sitzung" (`proxy.ts`, `decision === "unauthorized"`); mit gültigem
Cookie antwortet `GET /` mit 200.

Die Lebensdauer ist jetzt **30 Tage**, weiterhin gleitend (Erneuerung nach der
Hälfte). Die Zahl ist eine Setzung, keine Messung: sie ist die Zeitspanne, die
ein Telefon ohne Anfrage bleiben darf, und sie ist eine Konstante. Was eine
Sitzung vorzeitig beendet, hängt nicht am Ablaufdatum: Logout dreht die Epoche
des Kontos, ein Passwortwechsel dreht den Schlüssel, Schlüsseldatei löschen
plus Neustart meldet jedes Gerät ab. Der Preis: ein kopierter Cookie ist bis zu
30 Tage eine kopierte Sitzung statt einer Stunde — dokumentiert in
`docs/inventory-auth.md` und `docs/authentication.md`.

`lib/web-auth-session.test.mjs` hält den Tab-Fall fest (ein 61 Minuten alter
Cookie verifiziert), `proxy.session-cookie.test.mjs` prüft ihn am Proxy und
hält den Cross-Site-POST abgewiesen, und `app/api/web-access/login/route.test.mjs`
vergleicht die Attributnamen von Login und Erneuerung direkt miteinander statt
gegen abgeschriebene Literale.

### Nicht geprüft

Stated plainly, because a release note that claims more than what was run is
worse than one that admits the gap:

- **Der Terminal-Knopf in der Oberfläche.** Die Routen sind gefahren, der Klick
  nicht: eine Sitzung braucht ein Modell, und im Wegwerf-Agent-Verzeichnis der
  Messung war keines eingerichtet (`REPORT-shell-isolation.md`, §7). Belegt ist
  damit `POST /api/terminal` und was danach kommt — Spawn-Umgebung, Grenzen,
  `id`/`cat`/`ls`/`curl` —, nicht der Weg vom Knopf dorthin.
- **Nur Chromium.** Jede Browsermessung lief in Chromium. Firefox und Safari
  sind ungemessen, und ein echtes Telefon war nicht im Spiel: der Handy-Fall
  (ein 61 Minuten alter Cookie landet wieder auf `/login`, mit `lax` nicht) ist
  mit einem iPhone-14-Viewport gegen einen eigenen Produktionsbuild gemessen,
  nicht an einem Gerät. Der gemeldete Fehler kam von einem Telefon, also ist
  genau dort nichts nachgestellt.
- **Das Erneuerungsintervall.** Die 30 Tage und die Erneuerung nach der Hälfte
  (15 Tage) sind durch Unit-Tests belegt — `Max-Age=2592000`, `Expires`, die
  Drosselung auf ein `Set-Cookie` pro Halbwertszeit, der abgelehnte Request ohne
  `Set-Cookie`. Dass ein Browser 15 Tage wirklich durchhält, ist nicht gemessen;
  die Zahlen sind Konstanten, keine Beobachtung.
- **Memory, Themes und MCP pro Konto.** `memory.backend` und `autolearn` sind
  für einen Mandanten fest auf `off`/`false` genagelt, MCP ist aus — das ist die
  Absage, nicht die Lösung. Ein Speicher pro Konto braucht eine Naht im SDK
  (`getMemoryRoot` nimmt das Prozess-Agent-Verzeichnis; `docs/project-trust.md`,
  „Known gap"), und eine MCP-Verwaltung pro Konto gibt es nicht. Theme und
  Anzeige bleiben pro Konto und offen, aber nur über den Pfad, den
  `getSettingsForIdentity` auflöst — gemessen ist das an den Skills (v0.20.0)
  und an `GET /api/display-settings`, nicht an jedem Theme-Schlüssel.
- **Die uid-Grenze des Agent-`bash`.** Der Haken prüft die Sitzungswurzel, nicht
  das Kommando: ein `cd /` im Kommandotext sieht er nicht, und die Shell läuft
  als Dienstbenutzer weiter. Ein OS-Benutzer pro Konto wäre die Grenze, die das
  schließt; die gibt es hier nicht, und sie ist nicht gebaut worden.

What was run, in this checkout, on the tree that was committed:

| check | result |
| --- | --- |
| `bun run typecheck` (`tsc --noEmit`) | 0 errors |
| `bun test` (`NODE_ENV=test bun test`) | 1770 pass, 1 skip, 0 fail — 1771 tests, 207 files |
| `bun run build` (`scripts/run-next.mjs build --webpack`) | exit 0, `BUILD_ID` `8w016bl3pj7db6Ruj-R2Q`, 496 files under `.next/static/**/*.js` |
| `bunx eslint components/ app/ lib/ instrumentation.ts hooks/ bin/` | 0 problems |

## v0.13.0

Released 2026-10-30.

`Unreleased` above stays where it is: its contents are not in `v0.12.0`
either — the calendar work is in the eight commits this release cuts — and
moving them under a version number would claim a shipped state that was never
checked. This section carries only what this release changes. The header
carries no date because no header in this file's own release history does;
the date sits in this line instead.

### Internal

**The app now compiles against `@oh-my-pi/*` 18.14.0.** It was pinned to
18.1.x, and the SDK's internals moved between the two lines: the app did not
merely need a new version number, it named modules and functions that no
longer exist. Five packages move together — `pi-coding-agent`, `pi-ai`,
`pi-tui`, `pi-utils` and `pi-agent-core` — and `bun.lock` carries the same
versions, so an install that ignores the lockfile cannot land on a
half-migrated tree.

**Settings are typed handles, not a schema table.** `Settings.get`,
`Settings.set` and `Settings.getGroup` are gone; each setting is its own
handle that reads and writes a scope (`cfgThemeDark.get(settings)`), and the
handles live next to the domain they belong to
(`session/settings`, `modes/settings`, `extensibility/settings`,
`goals/settings`). `orderedSettings()` replaces the old
`SETTINGS_SCHEMA`/`getType`/`getEnumValues`/`getUi`/`hasUi`/`isCredential`
lookup, and the tab definitions (`SETTING_TABS`, `TAB_GROUPS`,
`TAB_METADATA`) come from `@oh-my-pi/pi-tui/overlays/settings-defs`. The
settings panel keeps the order it had, because `orderedSettings()` is the same
order the schema carried.

**`AuthStorage` is namespaced.** Stored credentials are reached through
`authStorage.credentials.*` and API keys through `authStorage.keys.*`
(`credentials.list`, `credentials.set`, `credentials.remove`, `keys.source`,
`keys.keyless`), and OAuth goes through `authStorage.oauth.login`. The
unnamespaced `set`/`remove`/`login`/`logout` calls and
`listStoredCredentials`/`hasAuth`/`getCredentialOrigin` no longer exist. This
touches `app/api/auth/**` and `lib/provider-listing-runtime.ts`.

**`thinking` and `theme` live in `pi-tui`.** `ConfiguredThinkingLevel` and
`parseConfiguredThinkingLevel` moved from
`pi-coding-agent/thinking` to `pi-tui/thinking`, and the theme functions
(`getResolvedThemeColors`, `getThemeExportColors`, `isLightTheme`) moved from
`pi-coding-agent/modes/theme/theme` to `pi-tui/theme`.

**`Goal` moved to `pi-tui/tools/goal`.** The goal *tool's* type comes from
there now — it carries the tool's own renderer — while `GoalModeState` stays
in `pi-coding-agent/goals/state`, which re-imports the type. The code uses
both paths on purpose; that is not an oversight to be tidied up.

**Runtime floor: bun >= 1.4.4.** All five packages declare `engines.bun:
">=1.4.4"`. Moving `engines.bun` alone was not enough and a test caught it: the
startup gate reads `MIN_BUN_VERSION` from `bin/runtime.js`, so the constant,
`engines.bun` and the boundary fixtures in `lib/runtime.test.mjs` all moved
together. `lib/runtime.test.mjs` asserts that the two agree, so the next bump
cannot update one and forget the other. An older bun is now refused at startup
with a message naming 1.4.4, instead of failing somewhere inside the agent.

### Nicht geprüft

Stated plainly, because a release note that claims more than what was run is
worse than one that admits the gap:

- **No interactive session was driven against a running instance.** The
  build, the type check and the suite are green (see below), but nobody has
  opened the app in a browser, signed in, and clicked through the settings
  panel and the sign-in and sign-out routes that this release rewrites. That
  happens during deployment, not here. A release that has not been signed into
  is not a verified release (`docs/release.md`).
- **`docs/release.md` also asks for `bunx eslint components/ app/ lib/`
  before tagging.** It was run after the gate below and reported no findings
  (exit 0), but after the tag was pushed — so it did not gate this release, it
  only confirms it. The gate below is typecheck, tests and build.
- **The desktop bundles were not built**, and `src-tauri/Cargo.toml` /
  `src-tauri/tauri.conf.json` still read `0.2.10`. `bun run
  desktop:sync-version` is the step that aligns them, and it runs inside
  `publish-desktop.yml`, not in this checkout.

What was run, with the numbers it produced:

| check | result |
| --- | --- |
| `bun run typecheck` (`tsc --noEmit`) | 0 errors |
| `bun test` (`NODE_ENV=test bun test`) | 1446 pass, 0 fail, 1 skip — 1447 tests, 172 files |
| `bun run build` (`scripts/run-next.mjs build --webpack`) | exit 0, `BUILD_ID` `8xWjlexFbq7R3EW26w41g`, 490 files under `.next/static/**/*.js` |

## v0.14.0

Released 2026-10-30.

`Unreleased` above stays where it is, for the same reason as in `v0.13.0`:
its contents are not shipped by any version number yet, and moving them under
one would claim a checked state that does not exist.

### Geplante Aufgaben

**Der Agent kann jetzt zu einem Zeitpunkt laufen, den der Nutzer vorher
bestimmt hat.** Eine geplante Aufgabe besteht aus Name, Zeitplan, Modell und
Prompt; ist sie faellig, startet der Zeitplaner eine **gewoehnliche
omp-Sitzung** mit diesem Prompt. Es gibt keinen zweiten Sitzungstyp und kein
getrenntes Protokoll: der Lauf erscheint im normalen Verlauf des Kontos.

**Jeder Lauf ist eine frische Sitzung, und das ist eine Entscheidung.** Den
Prompt in eine bestehende Sitzung zu schreiben haette zwei Folgen, die beide
falsch sind: er wuerde ein Gespraech unterbrechen, und `send({type:"prompt"})`
wirft sogar, solange dort ein Shell-Befehl laeuft. Der Lauf traegt `owner` und
`identity` mit, weil `startRpcSession` ohne `owner` den Leerstring speichert —
die Sitzung waere dann fuer ihr eigenes Konto unsichtbar, waehrend sie laeuft.
Weil es eine normale Sitzung ist, raeumt sie der vorhandene Leerlauf-Reaper
nach ihrer eigenen Leerlaufzeit ab wie jede andere.

**Der Zeitplan ist ein eigener, strenger Parser** (`lib/schedule.ts`): fuenf
Felder, `*` / Zahl / `a-b` / `a-b/n` / `*/n` / Kommalisten — und nichts
darueber hinaus. `L`, `W`, `#`, `@reboot` und sechs Felder werden mit einem
typisierten Fehler abgelehnt, der Feld und Token nennt, statt interpretiert zu
werden. Tag-des-Monats und Wochentag verknuepfen sich mit ODER, wenn beide
eingeschraenkt sind (POSIX). Die Uhrzeit ist **Serverzeit**: der Agent laeuft
auf derselben Maschine, und selbstgebaute Zeitzonenrechnung ist die Stelle, an
der ein Zeitplan anfaengt, zur falschen Stunde zu feuern. Der Dialog zeigt
`describeSchedule` waehrend des Tippens, damit man den Ausdruck lesen kann
bevor man ihn speichert.

**Ein Timer, nicht einer pro Aufgabe.** Er haengt an `globalThis` — eine
Modulvariable waere nach dem Hot-Reload des Dev-Servers wieder leer, und dann
liefen zwei Timer nebeneinander. Er wird auf den fruehesten faelligen Slot
ueber alle Konten gestellt, nach jedem Tick und nach jeder Aenderung ueber die
API neu berechnet, und auf eine Stunde gedeckelt, damit eine Aufgabe Wochen in
der Zukunft den Prozess nicht daran hindert, eine geaenderte Datei zu
bemerken. Gestartet wird er aus `instrumentation.ts` in einem `try`/`catch`:
ein kaputter Zeitplaner ist ein fehlendes Feature, eine werfende
Instrumentation ist ein Server, der nicht startet.

**Der Claim liegt in der Datei, nicht im Speicher.** `claimRun` vergleicht
`slotMs <= claimedSlotMs` unter einer Sperrdatei (`wx`, nach 30 s per
Rename-and-Verify uebernommen), also ueberlebt der Claim einen Neustart und
deckt eine zweite Instanz auf demselben Dateisystem ab — was hier normal ist,
weil zwei Instanzen dieselben Konten bedienen. Reihenfolge: erst beanspruchen,
dann starten. Zwei Prozesse, die beide starten und es danach merken, sind
genau der Fehler, gegen den der Claim existiert.

**Kein Nachholsturm.** Faellig ist eine Aufgabe, wenn ein Slot in
`(lastTickMs, nowMs]` liegt — hoechstens einmal pro Aufgabe und Fenster, mit
dem **ersten** Slot. Sechs Stunden Ausfall bei einem Viertelstundenplan
ergeben einen Lauf, nicht vierundzwanzig. Es gibt bewusst keine Warteschlange
und keinen Retry. Springt die Uhr rueckwaerts, feuert nichts, bis sie wieder
aufholt: ein verpasster Lauf ist besser als ein doppelter.

**Die Aufgaben liegen pro Konto in `omp-web-scheduled-tasks.json`**, im
Agent-Verzeichnis des Kontos — dieselbe Form, dasselbe `0o600`, derselbe
atomare Schreibvorgang und derselbe Pfadschutz wie Kalender und Quick Phrases.
Ein `schemaVersion`-Vergleich beim Lesen verweigert das Schreiben bei
Abweichung (HTTP 409), statt Felder zu vernichten, die eine neuere Fassung
angelegt hat. Eine unlesbare Zeile wird verworfen und nicht repariert: die App
darf wegen einer kaputten Zeile nicht nicht starten, und ein Normalisierer darf
keine Felder erfinden — ein fehlendes `createdAt` verwirft die Zeile, statt
"jetzt" zu stempeln, weil der Nutzer sonst glaubte, er haette sie heute
angelegt.

**Der `cwd` einer Aufgabe wird beim Schreiben *und* beim Lesen begrenzt.** Die
API prueft ihn gegen die Konto-Home; eine von Hand bearbeitete Datei geht an
dieser Pruefung vorbei, und weil der Besitz einer Sitzung aus ihrem `cwd`
abgeleitet wird, waere ein fremder `cwd` eine Sitzung, die einem anderen Konto
zugerechnet wird. Beim Lesen wird deshalb nur das Feld verworfen, nicht die
Aufgabe; der Lauf faellt auf die Home des Kontos zurueck.

**Modell und Zeitplan werden gegen lebende Quellen geprueft.** Die Route reicht
`modelRegistry.find(provider, modelId)` in den Speicher hinein, statt eine
zweite, veraltende Kopie von `config.yml` zu halten; der Dialog holt seine
Modellliste aus `/api/models`. Ein unbekanntes Modellpaar oder ein
ungueltiger Cron ergibt 400 und erreicht die Datei nicht.

Die Ansicht haengt an `?view=scheduled` neben dem Kalender in der
Seitenleiste. Die Loeschrueckfrage ist ein Zustand im Dialog selbst, nicht
`window.confirm()`, aus demselben Grund wie beim Kalender: im Desktop-Webview
gibt `window.confirm()` immer `false` zurueck, der Knopf taete dort nichts.

**Das stellt die Haltung "Hintergrundarbeit ist request-getrieben" bewusst
wieder her.** Das Projekt-Dashboard misst nur, solange jemand hinsieht; eine
geplante Aufgabe hat per Definition niemanden, der hinsieht. Dies ist damit der
eine Timer im Prozess. Er ist von der Bauart her begrenzt — ein Timer, ein
Weckruf je faelligem Slot, keine Warteschlange, kein Nachholen —, die Last
ohne Request ist also eine Sitzung, die der Nutzer vorher bestellt hat.
`AGENTS.md` traegt den Abschnitt mit dieser Begruendung nach.

### Nicht geprüft

Stated plainly, because a release note that claims more than what was run is
worse than one that admits the gap:

- **Kein Browser-Lauf gegen eine laufende Instanz — auch fuer den Zeitplaner
  nicht.** Die Ansicht, der Dialog, die Modellauswahl und die
  Loeschrueckfrage sind nicht von einem Menschen angeklickt worden.
- **Das Feuern ist nur durch Tests belegt, nicht durch eine echte Uhr.** Was
  geprueft ist: `selectDueTasks` (Fenster, erster Slot, ODER-Regel, gesperrte
  und kaputte Zeilen), `claimRun` (Doppelclaim, Restart, zweite Instanz),
  der Speicher (atomar, Sperre, Pfadschutz, Schema-Abweichung) und der Parser.
  Was **nicht** geprueft ist: dass ein Prozess ueber Stunden mit einem echten
  Timer wirklich zum richtigen Zeitpunkt feuert. Das passiert auf agent-pc
  direkt nach diesem Release.
- **`lastRunStatus: "ok"` heisst "gestartet", nicht "gelungen".** Die Sitzung
  wird angestossen und der Prompt abgeschickt; ob der Lauf danach erfolgreich
  war, zeichnet diese Anzeige nicht auf. Die Oberflaeche nennt es deshalb
  "Gestartet" und nicht "Erfolgreich" — die Beschriftung ist absichtlich
  schwaecher als das Feld. Wer den Ausgang wissen will, oeffnet die Sitzung
  des letzten Laufs.
- **Der Zeitplaner ist an eine einzelne Instanz je Host gebunden, was hier
  genuegt**, aber nicht geprueft ist ein zweiter Host auf demselben
  Netzwerk-Dateisystem — die Sperre ist eine Dateisperre und setzt ein
  Dateisystem mit funktionierendem `wx` und `rename` voraus, nicht NFS-Semantik
  mit ihrem eigenen Verhalten.
- **`enabled` kann auf einer von Hand bearbeiteten Datei fehlen.** Der Parser
  der Datei verwirft eine Zeile ohne boolesches `enabled` (`typeof raw.enabled
  !== "boolean"` → Zeile entfaellt), was bedeutet: von Hand eine Aufgabe ohne
  dieses Feld anzulegen macht sie unsichtbar, statt sie als aktiv zu lesen. Das
  ist die vorsichtige Richtung, aber es ist eine Fußangel fuer den Betreiber.

What was run, in this checkout, on the tree that was committed:

| check | result |
| --- | --- |
| `bun run typecheck` (`tsc --noEmit`) | 0 errors |
| `bun test` (`NODE_ENV=test bun test`) | 1540 pass, 0 fail, 1 skip — 176 files |
| `bun run build` (`scripts/run-next.mjs build --webpack`) | exit 0, `BUILD_ID` `9KCWTVZWFA6hyyldWM_V6`, both `/api/scheduled-tasks` routes in the app-paths manifest |
| `bunx eslint components/ app/ lib/ instrumentation.ts hooks/` | 0 problems |

`BUILD_ID` is random per build (`next.config.ts` sets no `generateBuildId`); it
identifies the build that was checked, not a reproducible artifact.

## v0.14.1

Released 2026-10-30.

### Geplante Aufgaben

**„Neue geplante Aufgabe" riss die ganze App mit.** Ein Klick auf den Knopf
ersetzte in `v0.14.0` die Oberflaeche durch Next' globale Fehlerseite
(„This page couldn't load"); die Sitzung, die man gerade offen hatte, war
weg. Nur der Dialog war kaputt, aber React verwirft beim Rendern den ganzen
Baum — ein Fehler in einer Komponente sieht aus wie ein Fehler der App.

**Ursache: eine Zuordnung wurde als Liste gelesen.** Der Dialog holte
`/api/models` und rief `.map` auf `body.models` auf. In dieser Antwort ist
`models` aber eine **Zuordnung** `"provider:id" -> Anzeigename`
(`lib/models-cache.ts:ModelsData`); die Liste mit Provider-Angabe heisst
`modelList`. `(models ?? []).map` ist damit `TypeError: ... is not a
function` — mitten im Commit, sobald der Dialog mit einem angemeldeten Konto
aufging. Der Quelltext sah dabei richtig aus; falsch war die Annahme ueber
die Form der Antwort.

**Fix: `modelList` lesen und in die Form der Auswahl bringen.** Der Dialog
liest jetzt `body.modelList` und bildet jeden Eintrag auf seine
`ModelOption` ab (`{ provider, modelId: id, name }`), so wie
`components/ChatInput.tsx` und `components/ModelRolesPanel.tsx` es mit
derselben Antwort schon taten. Der Fehlerpfad liefert bei einer nicht-ok
Antwort `{}` statt `{ models: [] }` — ein leeres Feld, das wie eine Liste
aussieht, war genau die Falle.

**Ein Test, der die echte Komponente gegen die echte Antwortform mountet**
(`components/ScheduledTasksView.models.test.mjs`, 2 Tests). Eine Pruefung des
Quelltextes haette den Fehler nicht gefangen: `body.models ?? []` liest sich
richtig, und der TypeError entsteht erst, wenn ein Objekt durch `.map`
laeuft. Der Test oeffnet deshalb den echten Dialog und liest danach die
Modellauswahl — nicht den Zustand. Gegen den `v0.14.0`-Quelltext laeuft er
in den erwarteten Fehler (`TypeError: (models ?? []).map is not a function`,
`ScheduledTasksView.tsx:735`); mit dem Fix ist er gruen. Der zweite Fall
haelt fest, dass der Dialog bei einer fehlschlagenden Antwort aufgeht und
nur den Platzhalter anbietet — ein Fehler beim Laden der Modelle darf nicht
wieder die App kosten.

### Nicht geprüft

Stated plainly, because a release note that claims more than what was run is
worse than one that admits the gap:

- **Die ausgelieferte Instanz.** Der Fix ist in einem echten Browser geprueft
  (Chromium, Produktionsbuild, angemeldetes Konto, echte Antwort von
  `/api/models`) samt vollem Durchlauf Anlegen/Bearbeiten/Loeschen; die
  Auslieferung auf `agent-pc` passiert im selben Arbeitsschritt direkt nach
  diesem Release. Ein Release, in das niemand hineingeklickt hat, ist kein
  geprueftes Release (`docs/release.md`) — der Browser-Lauf steht deshalb
  hier und nicht im Nachhinein.
- **Die Desktop-Bundles wurden nicht gebaut**, und `src-tauri/Cargo.toml` /
  `src-tauri/tauri.conf.json` stehen weiter auf `0.2.10`.
  `bun run desktop:sync-version` gleicht sie an und laeuft in
  `publish-desktop.yml`, nicht in diesem Checkout.

What was run, in this checkout, on the tree that was committed:

| check | result |
| --- | --- |
| `bun run typecheck` (`tsc --noEmit`) | 0 errors |
| `bun test` (`NODE_ENV=test bun test`) | 1542 pass, 0 fail, 1 skip — 1543 tests, 177 files |
| `bun run build` (`scripts/run-next.mjs build --webpack`) | exit 0, `BUILD_ID` `cPvUt6zxPOfG3q9cDC8hn`, 492 files under `.next/static/**/*.js` |
| `bunx eslint components/ app/ lib/ instrumentation.ts hooks/` | 0 problems |

## v0.14.2

Released 2026-10-30.

### Zeitplaner

**Der Dialog spricht jetzt die Sprache der Oberflaeche.** In `v0.14.0`/`v0.14.1`
war seine Beschriftung deutsch und zwar in *jeder* Sprache: Presets
("Stündlich", "Werktags um 08:00"), die Feldnamen des einfachen Editors
("Minute", "Stunde", "Wochentag"), die Wochentagsnamen und die Beschreibung
unter dem Cron-Feld kamen als fertige deutsche Saetze aus dem Quelltext. Wer
die Oberflaeche auf Englisch oder Chinesisch stellte, bekam einen deutschen
Dialog. Die Texte stehen jetzt als Katalogschluessel in `de`, `en` und `zh-CN`;
`lib/schedule.ts` ist **sprachfrei** und liefert statt eines Satzes einen
Deskriptor (`{ kind: "daily", hour: 8, minute: 0 }`, `{ kind: "weekly", weekday }`
mit `Date#getDay`), den die Ansicht uebersetzt. Der rohe Cron-Ausdruck bleibt
die Rueckfallbeschreibung fuer Formen, die kein Mensch so sagen wuerde.

**Ein Fehlschlag von `/api/models` ist sichtbar.** Vorher wurde er verschluckt:
der Dialog zeigte eine leere Modellauswahl und ein gesperrtes Speichern, ohne
Grund. Fuer den Nutzer sah das aus wie "es ist kein Modell eingerichtet" — ein
Zustand, gegen den er nichts tun kann. Der Grund steht jetzt unter der
Auswahl, als `role="alert"`, mit dem uebersetzten Satz davor und dem
Servertext als Detail. `null` (noch nicht geladen) und `[]` (geladen, aber
leer) sind dafuer getrennte Zustaende.

**Sonntag ist als `7` waehlbar.** `parseSchedule` akzeptiert `0` und `7` als
Sonntag, das Auswahlfeld kannte nur `0`. Ein `<select>` ohne passende
`<option>` zeigt in Chromium den ersten Eintrag: eine gespeicherte Aufgabe mit
`0 8 * * 7` oeffnete den Editor auf "taeglich", und ein Speichern daraus machte
den Sonntag stillschweigend zu "jeden Tag". Beide Schreibweisen stehen jetzt
im Feld, und das Feld wird beim Speichern unveraendert uebernommen.

**`400`/`409`/`503` werden zu Saetzen statt zu Entwicklertext.** Der Server
antwortet im Fehlerfall mit englischem Text ("written by another version and
this build writes 1"). Fuer `409` (andere Schemafassung) und `503` (Datei
gerade gesperrt) gibt es jetzt einen uebersetzten Satz, weil das Zustaende
sind und keine gewoehnlichen Fehlschlaege. Die Zuordnung laeuft ueber den
HTTP-Status, nicht ueber den Text: `docs/i18n.md` verbietet, einen API-Fehler
an seiner Formulierung zu uebersetzen. Andere Fehler behalten den Servertext,
weil er das Feld nennt.

**Die Zuordnung Preset → Cron ist festgeschrieben.** Ein Test vergleicht die
vollstaendige Liste (fuenf Eintraege, Ausdruck und Reihenfolge) mit dem
Literal. Sie ist eine Zusicherung und keine Beschriftung: ein Preset, das
etwas anderes erzeugt als sein Name sagt, legt eine Aufgabe fuer eine Zeit an,
die niemand gewaehlt hat.

**Gefunden beim Zusammenbauen: die Live-Pruefung des Cron-Ausdrucks war
stumm.** `describeSchedule` meldet einen ungueltigen Ausdruck seit diesem
Release mit `null` statt mit einem Wurf — der Dialog hing aber noch am alten
Vertrag (`try { describeSchedule(…) } catch`), und dieser `catch` ging nie mehr
in Betrieb. Folge: `ok` blieb immer `true`, Speichern war fuer `0 8 L * *`
freigegeben, kein roter Rand, keine Meldung. Die Rueckmeldung, fuer die die
Pruefung existiert, war still verschwunden. Feld und Token kommen jetzt aus
`parseSchedule`, das `ScheduleError` wirft; ein neuer Test haelt beides fest
(Speichern gesperrt, `role="alert"`, `aria-invalid`, Feld und Token im Text,
und wieder frei nach der Korrektur). Gegen den unkorrigierten Baum faellt er
mit genau dieser Zusicherung.

### Nicht geprüft

Stated plainly, because a release note that claims more than what was run is
worse than one that admits the gap:

- **Die ausgelieferte Instanz.** Der Dialog ist in Chromium gegen einen
  Produktionsbuild in allen drei Sprachen geprueft (Presets, Editor-Felder,
  Wochentagsnamen, Beschreibung), samt Umschalten der Sprache und einem
  erzwungenen Fehlschlag von `/api/models`; die Auslieferung auf `agent-pc`
  passiert im selben Arbeitsschritt direkt nach diesem Release.
- **Die Uebersetzung selbst ist nicht gegengelesen.** Die chinesischen Texte
  sind gesetzt, aber niemand mit der Sprache als Muttersprache hat sie
  freigegeben; sie sind eine Uebersetzung, keine Zusicherung.
- **Die Desktop-Bundles wurden nicht gebaut**, und `src-tauri/Cargo.toml` /
  `src-tauri/tauri.conf.json` stehen weiter auf `0.2.10`.
  `bun run desktop:sync-version` gleicht sie an und laeuft in
  `publish-desktop.yml`, nicht in diesem Checkout.

What was run, in this checkout, on the tree that was committed:

| check | result |
| --- | --- |
| `bun run typecheck` (`tsc --noEmit`) | 0 errors |
| `bun test` (`NODE_ENV=test bun test`) | 1549 pass, 0 fail, 1 skip — 1550 tests, 177 files |
| `bun run build` (`scripts/run-next.mjs build --webpack`) | exit 0, `BUILD_ID` `HR0h0lqWlHtem0O5urRzi`, 492 files under `.next/static/**/*.js` |
| `bunx eslint components/ app/ lib/ instrumentation.ts hooks/` | 0 problems |

## v0.14.3

Released 2026-10-30.

### Zeitplaner

**Ein Knopf „Jetzt ausführen" an jeder Aufgabe.** Bis hierher liess sich eine
geplante Aufgabe nur abwarten: man tippte einen Cron-Ausdruck, speicherte und
sah dann zu, ob der Takt sie zur richtigen Zeit startet. Wer den Prompt
ausprobieren wollte, musste ihn in eine gewoehnliche Sitzung kopieren — und
damit etwas anderes testen als das, was der Zeitplaner tut. Der Knopf startet
die Aufgabe mit genau demselben Weg, den der Takt nimmt: gleiche
Session-Kennung, gleicher Besitzer, gleiches Modell, gleicher Cache.

**Eine neue Route `POST /api/scheduled-tasks/[id]/run`.** Sie antwortet mit
`{ sessionId }`. Die Waechter stehen in derselben Reihenfolge wie beim
Nachbarn `[id]/route.ts`: erst der Ursprung (`403` bei fremdem Host oder
fehlendem Origin), dann die Identitaet (`401` ohne Konto, `403` wenn das
Konto die Aufgabendatei nicht lesen darf), dann die Existenz. Eine unbekannte
**und** eine fremde Kennung ergeben beide `404`: die Aufgaben liegen pro Konto
in getrennten Dateien, eine fremde existiert in dieser Datei nicht, und ein
`403` wuerde verraten, dass es sie anderswo gibt.

**Ein Handstart beansprucht keinen Slot — das ist die Zusicherung, an der der
Knopf haengt.** `runTaskNow` ruft `claimRun` nicht auf. `claimedSlotMs` ist die
Behauptung „diesen faelligen Slot hat schon jemand gestartet"; ein Klick um
07:59 darf den Slot um 08:00 nicht verschlucken. Deshalb bleiben `nextRun` und
`cron` einer Aufgabe nach einem Handstart, was sie vorher waren, und der
naechste geplante Lauf feuert regulaer. Ein Test haelt das fest, indem er
*nach* dem Handstart denselben Slot wirklich beansprucht: er muss noch zu
haben sein, und ein zweites `claimRun` muss ihn dann ablehnen.

**Eine deaktivierte Aufgabe darf laufen, und das ist eine Entscheidung.**
`enabled` sagt „der Zeitplan soll sie starten", nicht „sie darf ueberhaupt
nicht laufen". Wer deaktiviert und dann klickt, hat den Lauf ausdruecklich
bestellt; ihn mit `409` abzuweisen hiesse, den ausdruecklichen Befehl gegen die
eigene fruehere Einstellung auszuspielen. Die Aufgabe bleibt danach
deaktiviert, und der Takt ist davon unberuehrt — ein Test prueft beides.

**Ein gescheiterter Start wird sichtbar, nicht geschluckt.** Der Takt schluckt
Fehler, weil ein einzelner kaputter Eintrag nicht den ganzen Durchlauf beenden
darf; der Handstart reicht sie weiter, damit die Route einen Status liefern
kann. Vermerkt wird der Fehlschlag in beiden Faellen als
`lastRunStatus: "error"` — das ist die Wahrheit ueber den Lauf, auch wenn er
nicht fahrplanmaessig war. In der Zeile steht der Grund unter der Aufgabe
(`role="alert"`), nicht in der Meldungsleiste der Ansicht: bei mehreren
Aufgaben waere eine gemeinsame Zeile nicht zuzuordnen.

**Ein Test fuer den Durchlauf selbst.** Bisher war „ein Fehler beendet den Tick
nicht" nur eine Absicht im Kommentar. Der neue Test legt zwei Aufgaben in
dasselbe Fenster, laesst die erste werfen und prueft drei Dinge: die zweite
wird trotzdem gestartet, der Tick wirft nicht, und gezaehlt wird nur der
erfolgreiche Start. Der Fehler wird aus `selectDueTasks` genommen und nicht aus
der Anlagereihenfolge — welche zuerst kommt, entscheidet die zufaellige UUID,
und ein Test, der daran haengt, ist ein Test, der irgendwann grundlos rot wird.

**Zwei Test-Naehte, die im Betrieb niemand uebergibt.** `runTaskNow` und
`runSchedulerTick` nehmen `starter` und `identities` als Parameter mit dem
echten Start beziehungsweise allen Konten als Vorgabe. Ein `mock.module` waere
hier falsch: es ist prozessweit und laesst sich nicht zuruecknehmen, also
vergiftet es Testdateien, die dasselbe Modul spaeter brauchen. Kein Aufrufer im
Produktionscode setzt sie.

### Nicht geprüft

Stated plainly, because a release note that claims more than what was run is
worse than one that admits the gap:

- **Die ausgelieferte Instanz.** Der Knopf ist gegen einen Produktionsbuild
  geklickt worden, und die gestartete Sitzung wurde danach zurueckgelesen; die
  Auslieferung auf `agent-pc` passiert im selben Arbeitsschritt direkt nach
  diesem Release.
- **Der Start ueber Minuten hinweg.** Geprueft ist, dass eine Sitzung mit dem
  Prompt des Tasks entsteht und dass der Klick den Takt nicht verschiebt. Nicht
  geprueft ist, dass der Agent die Aufgabe danach auch *erledigt* — das haengt
  am Modell und am Prompt, nicht an diesem Knopf.
- **Die Desktop-Bundles wurden nicht gebaut**, und `src-tauri/Cargo.toml` /
  `src-tauri/tauri.conf.json` stehen weiter auf `0.2.10`.
  `bun run desktop:sync-version` gleicht sie an und laeuft in
  `publish-desktop.yml`, nicht in diesem Checkout.

What was run, in this checkout, on the tree that was committed:

| check | result |
| --- | --- |
| `bun run typecheck` (`tsc --noEmit`) | 0 errors |
| `bun test` (`NODE_ENV=test bun test`) | 1564 pass, 0 fail, 1 skip — 1565 tests, 178 files |
| `bun run build` (`scripts/run-next.mjs build --webpack`) | exit 0, `BUILD_ID` `r3XAnmMxcimau1286CC-V`, 493 files under `.next/static/**/*.js`, `/api/scheduled-tasks/[id]/run` in the app-paths manifest |
| `bunx eslint components/ app/ lib/ instrumentation.ts hooks/` | 0 problems |

## v0.15.0

Released 2026-10-30.

### Neu: Arbeitsordner fuer geplante Aufgaben

**Eine Aufgabe darf in einem anderen Ordner starten als der Home des Kontos.**
Bisher lief jeder geplante Lauf in der Home des Kontos. Fuer einen Prompt, der
in einem Projekt arbeitet, ist das der falsche Ort: der Agent oeffnete die
Home, sah dort Unterordner und musste den Pfad im Prompt erraten. Jetzt hat
jede Aufgabe ein Feld *Arbeitsordner*, und die Einstellungen haben denselben
Wert als Voreinstellung fuer das ganze Konto.

**Die Aufloesung ist `task.cwd` → Kontostandard → Home.** Die Angabe an *dieser*
Aufgabe schlaegt den Kontostandard, und erst wenn beides fehlt, die Home. Damit
ist die Konto-Einstellung ein Default im Wortsinn: sie aendert jede Aufgabe,
die keine eigene Angabe hat, und keine, die eine hat. Beide Wege — der
Zeitplaner-Durchlauf und der Handstart — rufen dieselbe Funktion `runCwd`. Ein
zweiter Aufloeser haette frueher oder spaeter eine andere Reihenfolge, und dann
startete der Handstart in einem anderen Verzeichnis als der Zeitplan.

**Die Pruefung ist serverseitig und in dieser Reihenfolge: absolut → innerhalb
der Konto-Home → existiert → ist ein Verzeichnis → auch aufgeloest innerhalb
der Home.** Ein abgelehnter Ordner antwortet als `400` mit `field: "cwd"`, in
derselben Form wie `name` und `cron`. Die letzte Stufe faengt den Symlink, der
lexikalisch drinnen und echt draussen liegt. Die Grenze steht bewusst **vor**
der Bestandspruefung: andernfalls verriete der Unterschied zwischen "gibt es
nicht" und "ist kein Verzeichnis", was ausserhalb der Home liegt.

**Warum die Grenze genau die Konto-Home ist und nicht weiter.** Der Besitz
einer Sitzung wird aus ihrem `cwd` abgeleitet (`lib/session-reader.ts`); ein
Lauf in fremder Home waere eine Sitzung eines anderen Kontos. `assertCwd` im
Aufgabenspeicher zieht dieselbe Grenze und wirft beim Lesen jeden `cwd`
ausserhalb davon weg. Eine *weitere* Grenze — etwa `getAllowedFileRoots`, das
auch Projektordner ausserhalb der Home kennt — wuerde einen Pfad speichern, den
der Speicher beim naechsten Lesen stillschweigend verwirft: der Lauf fiele ohne
Meldung auf die Home zurueck, obwohl der Nutzer einen Ordner gewaehlt und
"gespeichert" gesehen hat. Es gibt deshalb eine Grenze, nicht zwei.

**Der Standard liegt in `omp-web-scheduled-settings.json`, nicht in
`config.yml`.** `config.yml` gehoert omp; ein Feld dort waere eine Einstellung,
die omp beim naechsten Speichern nicht kennt und weglaesst. Dieselbe
Begruendung und derselbe Ort wie bei `omp-web-quick-phrases.json`. Die Datei
wird atomar und mit `0o600` geschrieben, und auch beim *Lesen* wird die Grenze
geprueft: eine von Hand bearbeitete Datei geht an jeder API-Pruefung vorbei, und
ein `defaultCwd` ausserhalb der Home faellt deshalb auf `null` zurueck statt
einen Lauf in fremder Home zu starten. Eine unlesbare *Vorliebe* darf einen
Durchlauf nicht beenden.

**Im Dialog bleibt ein gespeicherter Ordner sichtbar, auch wenn er nicht in der
Liste steht.** Die Auswahl bietet Home, die Projektordner und "Custom path…".
Ein Pfad, der in keiner dieser Listen ist (Projekt entfernt, von Hand gesetzt),
wird als eigener Eintrag angezeigt statt stillschweigend auf
"Voreinstellung" zurueckzuspringen — sonst wuerde das blosse Oeffnen des
Dialogs die Angabe loeschen. Das Feld "Custom path…" aendert nichts, bis ein
Pfad getippt ist; ein sofortiges `null` waere eine Loeschung, die niemand
bestellt hat.

### Behoben: EXPLORER zeigte „Failed to load files (HTTP 404)"

`encodeFilePathForApi("/")` gab den **leeren String** zurueck: `"/".split("/")`
ergibt zwei leere Segmente, und beide fielen durch `.filter(Boolean)`. Der
Client fragte damit `/api/files/?type=list` — eine URL ohne Pfad. Next leitet
sie mit `308` auf `/api/files` um, und dort greift keine Route: `[...path]` ist
ein nicht-optionaler Catch-all, also matcht `/api/files` gar nichts, und die
Antwort war `404`. Sichtbar wurde das in der Seitenleiste als „Failed to load
files (HTTP 404)" statt der Ordnerliste — fuer jedes Konto, dessen Home `/`
ist, also fuer Administratoren.

Der Fix ist eine Zeile: ein Pfad aus lauter Schraegstrichen kodiert jetzt als
das **eine** Segment `%2F`, das die Route zu `/` zurueckdekodiert. Alle anderen
Pfade bleiben byte-identisch, und das steht als Gegenprobe im Test
(`/home/me/workspace` kodiert weiter zu `home/me/workspace`, ein Dateiname mit
Leerzeichen und Prozentzeichen weiter zu `tmp/a%20b%25c`). Dazu kommt ein Test,
dass die Allowlist unveraendert bleibt — `<home-root>` und `/etc` werden
weiterhin mit `403` abgelehnt, der Fix hat die Grenze nicht verschoben — und
drei Komponenten-Tests, die ihren Pfad aus der URL ableiteten, falten fuehrende
Schraegstriche jetzt genauso wie `filePathFromSegments`.

### Nicht geprüft

Stated plainly, because a release note that claims more than what was run is
worse than one that admits the gap:

- **Die ausgelieferte Instanz.** Beide Aenderungen sind gegen einen
  Produktionsbuild in Chromium geprueft (Explorer listet und navigiert, das
  Feld steht im Dialog, der Kontostandard greift, die Aufgabenangabe schlaegt
  ihn); die Auslieferung auf `agent-pc` passiert im selben Arbeitsschritt
  direkt nach diesem Release.
- **Ein Lauf in einem Ordner ausserhalb der Konto-Home ist nicht vorgesehen**,
  und das ist eine Grenze und kein Versehen (siehe oben, Sitzungsbesitz). Wer
  das braucht, braucht zuerst eine andere Besitzregel.
- **Die Desktop-Bundles wurden nicht gebaut**, und `src-tauri/Cargo.toml` /
  `src-tauri/tauri.conf.json` stehen weiter auf `0.2.10`.
  `bun run desktop:sync-version` gleicht sie an und laeuft in
  `publish-desktop.yml`, nicht in diesem Checkout.

What was run, in this checkout, on the tree that was committed:

| check | result |
| --- | --- |
| `bun run typecheck` (`tsc --noEmit`) | 0 errors |
| `bun test` (`NODE_ENV=test bun test`) | 1585 pass, 0 fail, 1 skip — 1586 tests, 180 files |
| `bun run build` (`scripts/run-next.mjs build --webpack`) | exit 0, `BUILD_ID` `XhlGSZR1KxkQ1P7groG2F`, 494 files under `.next/static/**/*.js`, `/api/scheduled-settings` in the app-paths manifest |
| `bunx eslint components/ app/ lib/ instrumentation.ts hooks/` | 0 problems |

## v0.16.0

Released 2026-10-30.

### Neu: Doppel-Enter steuert sofort

**Ein einzelnes Enter hat schon gesteuert — nur die Geste fehlte.** Laeuft ein
Turn, schickt `ChatInput` die Eingabe bereits als Steer (`case "steer"` →
`inner.steer()`), und der Text steht im Transkript, waehrend der Turn noch
laeuft. Der Schalter war also vorhanden; was fehlte, war die *Geste*, mit der
man ihn ohne Nachdenken trifft.

**Was wirklich kaputt war: zwei schnelle Enter haben den Entwurf zweimal
gesendet.** Am unveraenderten Build gemessen: zweimal Enter im Abstand von
wenigen Millisekunden ergab zwei Nachrichten mit demselben Text. Der zweite
Anschlag las noch den alten `value` — der Zustand aus dem Abschluss des letzten
Renderns —, weil beide Anschlaege im selben Frame liegen. Genau daran ist die
Geste vorher gescheitert.

**Die Regel steht in `lib/chat-input-enter.ts`, nicht im Handler.**
`DOUBLE_ENTER_WINDOW_MS = 400`, und die Grenze ist **einschliesslich**
(`nowMs - previous <= DOUBLE_ENTER_WINDOW_MS`): zwei Anschlaege bei genau
400 ms sind eine Geste, bei 401 ms sind es zwei Eingaben. `classifyEnter` ist
ein reiner Zeitvergleich ohne DOM und gibt den Zustand fuer den naechsten Druck
zurueck, damit ein Test ihn ohne Timer nachstellen kann, indem er `nowMs`
vorgibt. Der Handler bleibt eine Uebersetzung von Tasten in Aufrufe.

**Das erste Enter geht unveraendert seinen Weg, das zweite wird verbraucht.**
Laeuft ein Turn, steuert das erste Enter wie bisher; ohne Turn sendet es wie
bisher. In beiden Faellen ist das Feld danach leer, und der zweite Anschlag
findet nichts mehr vor — er wird konsumiert statt gesendet. Damit sind zwei
Fehler mit einem Griff weg: der doppelte Versand im Leerlauf und der zweite
Steer waehrend eines Turns. Gelesen wird `valueRef.current`, nicht `value`;
`clearInput` pflegt `valueRef` synchron, deshalb sieht der zweite Anschlag
schon das leere Feld.

**`Shift+Enter` und ein laufender IME bleiben unberuehrt.** `Shift+Enter` macht
weiter einen Zeilenumbruch, und ein Zeichen, das ein IME gerade zusammensetzt
(`nativeEvent.isComposing`, `keyCode 229`), ist keine Eingabe: es bestaetigt
einen Kandidaten. Solche Anschlaege setzen den Zeitstempel zurueck, statt die
halbe Geste einer spaeteren Eingabe zu werden.

**Gemessen an einer laufenden Sitzung.** Steer-Text in
`queuedMessages.steering` nach **106 ms**, im Transkript angekommen bei
**2701 ms**, waehrend der Turn noch streamte, das Modell antwortete im selben
Turn — und genau **eine** Nutzernachricht mit der Markierung.

### Sicherheit: ein Mandant schrieb die globale Modellkonfiguration

`PUT /api/model-roles` mit `scope: "global"` schreibt in die `config.yml` des
**Prozesskontos**, nicht in die des Aufrufers. Ein Mandant konnte damit den
Standard des Betreibers verschieben — und mit ihm den jeder anderen Sitzung.
Gefunden im Mehrbenutzer-Audit (Zeile 30, Befund G1), nachgestellt mit zwei
Mandanten: `bob PUT … scope:"global"` antwortete **200**, danach lasen `alice`
und `admin` **bobs** Selector.

Die Sperre sitzt **vor** dem Schreiben (`app/api/model-roles/route.ts:77-79`):
`scope === "global"` und keine Admin-Identitaet ergibt **403**. Der eigene Satz
eines Mandanten ist `scope: "project"` unter einem `cwd`, das er benutzen darf,
und bleibt erlaubt. Auch ein Aufruf **ohne** `scope` gilt als `global` — der
Default der Route darf nicht das Loch sein, das die Pruefung uebersieht.

Geprueft mit der Datei, die danach auf der Platte liegt, nicht mit einer
Attrappe: vier neue Tests laden die Route als echtes Modul und stellen eine
isolierte `Settings` auf ein Wegwerf-Verzeichnis. `bob` global **403** bei
byte-gleicher Prozess-`config.yml`, `admin` global **200**, `bob` eigenes
`project` **200** und nur in seiner eigenen Datei.

### Nicht geprüft

Stated plainly, because a release note that claims more than what was run is
worse than one that admits the gap:

- **Die ausgelieferte Instanz.** Beide Aenderungen werden gegen einen
  Produktionsbuild in Chromium geprueft; die Auslieferung auf `agent-pc`
  passiert im selben Arbeitsschritt direkt nach diesem Release.
- **Der IME ist nur im Unit-Test geprueft**, nicht an einer echten
  Eingabemethode: Zwei Wege sind abgedeckt (`isComposing`, `keyCode 229`), aber
  welcher Browser ihn wann setzt, ist damit nicht belegt. Auf einer
  Tastatur ohne IME ist der Zweig unerreichbar und die Geste unberuehrt.
- **Die Desktop-Bundles wurden nicht gebaut**, und `src-tauri/Cargo.toml` /
  `src-tauri/tauri.conf.json` stehen weiter auf `0.2.10`.
  `bun run desktop:sync-version` gleicht sie an und laeuft in
  `publish-desktop.yml`, nicht in diesem Checkout.

What was run, in this checkout, on the tree that was committed:

| check | result |
| --- | --- |
| `bun run typecheck` (`tsc --noEmit`) | 0 errors |
| `bun test` (`NODE_ENV=test bun test`) | 1607 pass, 0 fail, 1 skip — 1608 tests, 182 files |
| `bun run build` (`scripts/run-next.mjs build --webpack`) | exit 0, `BUILD_ID` `TerkEl6PVU82TcXRvCvwn`, 494 files under `.next/static/**/*.js`, `/api/model-roles/route` in the app-paths manifest |
| `bunx eslint components/ app/ lib/ instrumentation.ts hooks/` | 0 problems |

## v0.17.0

Released 2026-10-30.

### Layout

**Die Wortmarke verlaesst die Kopfzeile.** Sie stand in der Seitenleiste ueber
den vier Knoepfen und kostete genau die Breite, die denen fehlte. Jetzt stehen
die vier als beschriftetes Raster: zwei Spalten, zwei Reihen, **116,5 x 44 px**
je Knopf — gemessen bei 1440x900 und bei 390x844, in beiden Faellen dieselben
Masse, weil das Raster an der Spalte haengt und nicht am Fenster. Ein Knopf ist
damit 44 px hoch, das ist die kleinste Flaeche, die ein Finger zuverlaessig
trifft.

**Der Grund fuer den waagerechten Ueberlauf war ein Selektor, nicht ein
Wert.** `.sidebar-container > *` erbte die Breite des Elternelements, und ein
Element, das breiter ist als seine Spalte, macht die Spalte scrollbar statt
sich zu kuerzen. Die Regel ist jetzt auf `width: 100%` und `min-width: 0`
gesetzt; `min-width` ist der Teil, der das Kuerzen erlaubt, `width` allein
haette den Ueberlauf nur verschoben.

**Das OMP-Zeichen steht als Wasserzeichen hinter dem Gespraech.** Zentriert,
`min(42%, 22rem)` gross, Deckkraft **0,08** im hellen und **0,05** im dunklen
Schema, `pointer-events: none` — es ist Hintergrund, kein Ziel. Die niedrigeren
Werte als zuerst geplant sind Absicht: bei 0,12 war das Zeichen hinter Text mit
zwei Zeilen Abstand noch als Kontur zu lesen.

**Trefferflaechen unter 44 px sind auf Touch-Geraeten angehoben.** Unter
`@media (max-width: 640px), (hover: none)` werden die Werkzeugknoepfe der Zeile
und die Zeilenaktionen auf 44x44 px gebracht und die Aktionen dauerhaft
eingeblendet, statt erst beim Ueberfahren zu erscheinen — auf einem Geraet ohne
Zeiger gibt es kein Ueberfahren.

### Modellwechsel

**Der Modellwaehler in einem Gespraech mit Verlauf war tot oder langsam.** Drei
Ursachen, jede gemessen, jede einzeln behoben:

**Ein Klick, der waehrend eines laufenden Wechsels kam, wurde verworfen.**
`if (modelSwitchPendingRef.current) return` warf jeden zweiten Klick weg, und
der Ausloeser war waehrend der Anfrage `disabled`. Jetzt gibt es eine
Warteschlange, in der der **letzte** Klick gewinnt — nicht der erste, nicht
beide — und die Anfrage bricht nach **20 s** ab, statt den Knopf fuer immer
gesperrt zu lassen.

**Nach jedem Wechsel wurde das ganze Transkript neu geladen.** Die Route gibt
jetzt die geaenderten Felder zurueck — Modell, Thinking-Level und den neuen
Leaf — und der Client uebernimmt sie, statt `GET /api/sessions/<id>` zu rufen.
Gemessen an einer Sitzung mit **2000 Nachrichten**: **0** `GET
/api/sessions/<id>` nach dem Wechsel (vorher einer), und die Beschriftung
wechselt in **585 ms** statt **708 ms**. Die 123 ms sind der Request, der
wegfaellt; der Rest ist die Antwort der Route.

**Eine kalte Sitzung wurde innerhalb des POST gestartet.** Der Wechsel in einer
Sitzung, die noch nicht geladen war, baute sie im Request auf und oeffnete dabei
einen `EventSource` — der Client wartete auf ein Ereignis, das er selbst
ausgeloest hatte. Jetzt schreibt der Wechsel den Journal-Eintrag direkt:
**528 ms**, kein `EventSource`.

### Zeitplaner-Haertung

**Ein Cron-Ausdruck, der nie zutrifft, kostete einen Durchlauf durch die
Jahre.** `0 0 31 2 *` — der 31. Februar — wurde Minute fuer Minute vorwaerts
gesucht, **246,7 ms** je Aufruf, synchron, im Request. `isUnsatisfiable` prueft
jetzt die Feldmasken: ein Monat, dessen Tage im Tagesfeld nicht vorkommen, oder
ein Wochentag, der im Monatsraster nicht existiert, ist in **0,1 ms** erkannt,
und die Antwort ist `null` statt eines Datums im Jahr 2400.

**Ein nie zutreffender Ausdruck sieht jetzt anders aus als ein abgeschalteter
Task.** Beides ergab vorher „kein naechster Lauf"; das eine heisst „du hast ihn
ausgeschaltet", das andere „dieser Ausdruck wird nie wahr". Die Zeile sagt
welches (`scheduled.neverMatches`), und `nextRun` ist nicht mehr optional,
sondern `null` mit Grund.

**Der Modelldialog fragt die Liste jetzt fuer das Projekt der Aufgabe ab.**
`/api/models` ohne `cwd` loest auf `process.cwd()` des Servers auf; fuer einen
Mandanten, dessen erlaubte Wurzeln das nicht enthalten, antwortet die Route
**403** und die Liste kam leer zurueck — ein leerer Katalog sah wie „es gibt
keine Modelle" aus. Der Aufruf traegt jetzt `?cwd=<Projekt der Aufgabe>` und
laedt neu, wenn das Arbeitsverzeichnis im Dialog wechselt. Schlaegt er fehl,
steht der Fehler da, statt einer erfundenen leeren Liste.

### Upstream-Port

Fuenf Stuecke aus `ddallabenetta/omp-web` uebernommen, jedes einzeln geprueft
und mit seinem Test:

- **Die `.jl`-Sprachzuordnung** im Dateibetrachter
  (`app/api/files/[...path]/route.ts`, `route.language.test.mjs`).
- **`BROWSER_NATIVE_DESCRIPTIONS`** fuer `/fork` — der Browser beschreibt die
  Gabelung selbst, statt sie dem Modell zu ueberlassen (`lib/agent-client.ts`).
- **`SessionIdentity`, `RuntimeSessionBinding` und
  `canApplySessionIdentity`** (`lib/types.ts`) — die Typen, an denen die
  Sitzungsbindung haengt.
- **Die Fortsetzungs-API von `workspace-memory`**
  (`lib/workspace-memory.ts`, `workspace-memory.test.mjs`).
- **PR #106: `ModelsConfigFile.invalidate()`** in `invalidateOmpRuntime`
  (`lib/omp-runtime.ts`, `omp-runtime.test.mjs`) — eine geaenderte
  `models.yml` wird jetzt auch dann gesehen, wenn der Prozess sie schon einmal
  gelesen hat.

### README

**Die README beschreibt jetzt das Produkt, das hier laeuft.** Die alte Fassung
sagte „this fork adds: …" und listete fuenf Punkte; tatsaechlich sind
Konten, Zeitplaner, Kalender, Terminal, Dateiarbeit und Steuerung eigenes
Arbeitsgebiet, und `docs/inventory-api.md` zaehlt 69 Routen. Neu sind ein
Abschnitt *What is in flight* fuer das Unveroeffentlichte, die gemessenen
Zahlen aus frueheren Releases, und Korrekturen an Stellen, an denen der Text
dem Code widersprach — der Kalender bot `PUT` an, die Route kennt nur `PATCH`;
ein Thinking-Block wird nicht mitgestreamt, sondern per `blockIndex` geholt;
und der `#quick-start`-Anker, auf den `docs/docker.md` zeigt, existierte nicht.

### Nicht geprüft

Stated plainly, because a release note that claims more than what was run is
worse than one that admits the gap:

- **Der IME ist nur im Unit-Test geprueft**, nicht an einer echten
  Eingabemethode. Aus der Steuerungs-Geste in v0.16.0 sind zwei Wege abgedeckt
  (`isComposing`, `keyCode 229`); welcher Browser ihn wann setzt, ist damit
  nicht belegt.
- **Kein echtes Telefon und kein Touch-Geraet.** Die 44-px-Regeln sind bei
  390x844 im Browser gemessen, aber mit der Maus und ohne echte Touch-Eingabe;
  wie sich die Ziele unter einem Finger verhalten, ist damit nicht belegt.
- **Die Tauri-Desktop-Shell wurde nicht gebaut.** `src-tauri/` steht weiter auf
  `0.2.10`; `bun run desktop:sync-version` gleicht sie an und laeuft in
  `publish-desktop.yml`, nicht in diesem Checkout.
- **Die `runtimeId`-Familie aus Upstream (PR #134, 20 Commits) wurde bewusst
  nicht uebernommen.** Sie ordnet Sitzungen einer Laufzeit-Kennung zu, waehrend
  unsere Mandantentrennung auf dem Eigentuemer der Sitzung beruht; beides
  nebeneinander ergaebe zwei Wahrheiten darueber, wem eine Sitzung gehoert. Das
  ist eine Architekturentscheidung, kein Port.

What was run, in this checkout, on the tree that was committed:

| check | result |
| --- | --- |
| `bun run typecheck` (`tsc --noEmit`) | 0 errors |
| `bun test` (`NODE_ENV=test bun test`) | 1646 pass, 0 fail, 1 skip — 1647 tests, 187 files (two consecutive runs) |
| `bun run build` (`scripts/run-next.mjs build --webpack`) | exit 0, `BUILD_ID` `f_buZIGYXKA5umDsBzB57`, 494 files under `.next/static/**/*.js`, `/api/model-roles/route` and `/api/agent/[id]/route` in the app-paths manifest |
| `bunx eslint components/ app/ lib/ instrumentation.ts hooks/` | 0 problems |

## v0.18.0

Released 2026-10-30.

### Dateianhang im Chat

**Eine Papierklammer im Composer legt beliebige Dateien in das
Arbeitsverzeichnis der Sitzung.** Sie steht neben dem Bildknopf, nimmt eine
Datei auf einmal, und was ankommt, landet genau dort, wo der Agent sucht — kein
Unterordner, kein Umweg.

**Ein zweiter Endpunkt waere ein zweiter Fehlerpfad gewesen.** Der Upload
existiert seit langem als `POST /api/files/**?type=upload`; die Klammer benutzt
ihn unveraendert, mit `conflict=skip` und dem Feld `files`. Damit gibt es eine
Stelle, an der Schreibrechte, Symlink-Aufloesung und Groessengrenzen entschieden
werden, und nicht zwei, die auseinanderlaufen koennen.

**`skip` statt `rename`.** Eine gleichnamige Datei bleibt unveraendert, der
Server meldet sie in `skipped`, und der Composer sagt das. Ein clientseitig
geratener Suffix waere ein Name, den der Agent nicht kennt — der Chip zeigte
dann auf `bericht-2.pdf`, waehrend in `cwd` `bericht.pdf` liegt.

**Der Chip ist eine Referenz, keine Kopie.** Beim Senden haengt der Composer
`@<name>` an den Prompt, und die SDK loest die Erwaehnung relativ zum `cwd` auf
und liest die Datei. Ein Zeilenbereich (`@name:12-14`) wird dabei nicht
aufgeloest und darf nicht angehaengt werden. Steht die Erwaehnung schon im
Entwurf — auch gequotet —, kommt keine zweite dazu; verglichen wird der aus der
Erwaehnung ausgepackte Pfad, exakt so, wie die SDK ihn liest.

**8 MB je Datei, clientseitig geprueft** (`lib/file-upload-client.ts`). Das ist
eine Produktentscheidung und keine Notwendigkeit: ein Anhang soll in den Prompt
passen und nicht minutenlang hochladen. Die Route selbst traegt seit diesem
Release ihre eigenen Grenzen (siehe unten).

Der Chip laesst sich entfernen, ohne die Datei zu loeschen — er ist ein Verweis,
kein Besitz. Deutsche, englische und chinesische Beschriftung, Fehlermeldungen
eingeschlossen; auf Touch-Geraeten ist der Knopf 44x44 px gross.

### Upload-Grenzen

**Der Proxy hat Bodies abgeschnitten, statt sie abzulehnen.** `next.config.ts`
setzte `experimental.proxyClientMaxBodySize` auf 32 MB. Dieser Wert ist keine
Ablehnung: Next beendet den Body-Klon stillschweigend
(`node_modules/next/dist/server/body-streams.js`, `cloneBodyStream`, pusht `null`
in beide Passthroughs), und der Handler liest einen mitten im Teil endenden
Body. Die dokumentierten Grenzen der Route — 25 MB je Datei, 100 MB gesamt,
101 MB je Request — waren damit oberhalb von etwa 32 MB **nicht erreichbar**,
und ein zu grosser Multipart-Upload antwortete mit **500**
`FormData parse error missing final boundary` statt mit einer Ablehnung.

**Vorher und nachher, am Produktionsbuild gemessen:**

| Fall | vorher | nachher |
| --- | --- | --- |
| roher 40-MB-POST | 33,4 MB kamen an, 8 MB still verloren, **200** | 40 MB vollstaendig |
| Multipart 40 MB | **500** (Parserfehler) | **413** mit der Meldung der Route |
| 3x20 MB in einem 60-MB-Request | unmoeglich (Klon-Grenze) | angenommen, alle sha256 gleich |
| 120 MB gesamt | — | **413**, nichts geschrieben |

**Die Klon-Grenze steht jetzt ueber der Route-Grenze, nicht darunter.** 104 MB
(109 051 904 Bytes) gegen 105 906 176 Bytes Request-Limit der Route — 3 MB
Luft, damit die Grenze, die der Code selbst zieht, die ist, die der Aufrufer
sieht.

**Ein abgeschnittener Body wird erkannt, nicht hingenommen.**
`lib/bounded-form-data.ts` prueft die gelesene Laenge gegen `Content-Length`;
ein zu kurzer Body wirft `RequestBodyTruncatedError`, und die Route antwortet
**413** mit beiden Byte-Zahlen, statt einen halben Multipart-Body als
Parserfehler zu melden. Eine Datei wird dabei nicht geschrieben.

**Zwei Dokumente sagten das Gegenteil.** `lib/image-attachments.ts:5-24` und
`docs/inventory-api.md:416-457` behaupteten, die Route-Grenzen seien oberhalb
von 32 MB nicht durchsetzbar und der Proxy lehne ab — beides falsch, und beides
jetzt korrigiert. `lib/write-access.ts:32-33` behauptete, das Home eines
Mandanten sei grundsaetzlich nicht beschreibbar; auch das stimmt nicht, und der
Test deckt jetzt eine Mandanten-Identitaet ab.

### Nicht geprüft

Stated plainly, because a release note that claims more than what was run is
worse than one that admits the gap:

- **Kein echtes Touch-Geraet.** Die 44x44-px-Flaeche ist im Browser bei 390x844
  gemessen, aber mit der Maus; wie sie sich unter einem Finger verhaelt, ist
  damit nicht belegt.
- **Der IME ist weiterhin nur im Unit-Test geprueft**, nicht an einer echten
  Eingabemethode (aus v0.16.0, unveraendert).
- **Die Tauri-Desktop-Shell wurde nicht gebaut.** `src-tauri/` steht weiter auf
  `0.2.10`.
- **Chips ueberleben keinen Remount.** Der Entwurf kennt Text und Bilder, keine
  Dateiverweise; nach einem Neuladen der Ansicht ist der Chip weg, die Datei
  liegt aber weiterhin in `cwd` und laesst sich per `@name` nennen. Das ist eine
  Grenze des Entwurfs-Speichers, nicht des Uploads.

What was run, in this checkout, on the tree that was committed:

| check | result |
| --- | --- |
| `bun run typecheck` (`tsc --noEmit`) | 0 errors |
| `bun test` (`NODE_ENV=test bun test`) | 1661 pass, 0 fail, 1 skip — 1662 tests, 189 files |
| `bun run build` (`scripts/run-next.mjs build --webpack`) | exit 0, `BUILD_ID` `U4S1OEsbMbebZ-m3xHrQy`, 494 files under `.next/static/**/*.js` |
| `bunx eslint components/ app/ lib/ instrumentation.ts hooks/` | 0 problems |

## v0.20.0

Released 2026-10-31.

Die Skill-Abschnitte standen bis hierher unter `Unreleased`; sie stehen jetzt
hier, weil dieser Release sie schneidet. Der Rest von `Unreleased` bleibt
unverändert stehen, wie in `v0.13.0` und `v0.14.0`.

### Skills

**Die Skills-Verwaltung.** Ein fünfter Knopf in der Kopfzeile der Seitenleiste
öffnet `?view=skills`: der eigene Skill-Bestand als Liste, daneben der Editor
für die `SKILL.md`, mit Speichern, Verwerfen und Löschen (Rückfrage im Dialog).
Dazu zwei Wege in einen Chat: **Neuen Skill anlegen** öffnet einen neuen Chat
mit dem vorausgefüllten Recherche-Prompt, und **Mit KI bearbeiten** öffnet einen
Chat, der die Skill-Datei über einen absoluten `@`-Pfad referenziert. Beides
schreibt nur den Entwurf, sendet nichts und setzt den Fokus in den Composer.

Der Bestand ist **pro Konto**: Der Betreiber behält `~/.omp/agent/skills`, ein
Mandant bekommt `<sein Agent-Verzeichnis>/skills`. `startRpcSession` behält das
Prozess-Agent-Verzeichnis (der Loader ignoriert `agentDir` für Skills, und ein
Wechsel würde Credentials, Memory und `agent.db` abspalten), löst aber die
**Settings** nach der Identität auf. Der Ordner wird idempotent als absoluter
`skills.customDirectories`-Eintrag in der eigenen `config.yml` eingetragen —
ohne diesen Eintrag sieht `loadSkills()` den Ordner nicht. Folge: der Bestand
des Betreibers bleibt für Mandanten lesbar; eigene Skills kommen additiv dazu.

Die neuen Routen (`/api/skills/user`, `/api/skills/user/[name]`) adressieren
einen Namen, nie einen Pfad, validieren `^[a-z0-9][a-z0-9-]{0,63}$`, lehnen
Symlinks ab und schreiben atomar. Die gemeinsame `.omp`-Sperre
(`protectedRootReason`, 403 `omp-runtime`) bleibt unangetastet — die Verwaltung
umgeht sie, indem sie keinen Pfad annimmt und genau einen Unterbaum besitzt.
Ein fremder Name antwortet 404. `PATCH /api/skills` bleibt admin-only.
Die Registrierung schreibt **nur die globale Ebene** der Konto-`config.yml`
fort: `cfgSkills.get()` mischt die Projektebene des Prozess-Arbeitsverzeichnisses
ein, und dieser Pfad darf nicht als Benutzer-Eintrag im Konto landen — sonst
überlebt er jeden Projekt-Vertrauensfilter.

**Projekt-Skills folgen dem Projekt-Vertrauen.** Ein nicht vertrautes Projekt
lädt seine eigenen Skills nicht mehr: `trustedProjectSkills` entfernt jeden
Eintrag mit `level: "project"` **und** jeden, dessen Datei unter dem
Projekt-Root liegt (`customDirectories` trägt `custom:user`, also fängt nur die
Pfadprüfung eine Projekt-`config.yml`, die auf sich selbst zeigt). Globale
Skills bleiben geladen — ein nicht vertrautes Projekt ist eine verengte, keine
lahmgelegte Sitzung. Panel und Sitzung rufen denselben Loader
(`loadSessionSkills`); was wegfällt, nennt eine `info`-Diagnose. Ein Projekt,
das nur eine `SKILL.md` mitbringt, verlangt jetzt den Vertrauensdialog.

Dazu gehörte ein Fix am Sitzungsstart: `/api/agent/new` und die Folge-Routen
setzen jetzt den **Eigentümer** der Sitzung. Ohne ihn war eine frisch gestartete
Sitzung für ihren eigenen Event-Stream unsichtbar (404), und ein Mandant konnte
den gerade vorausgefüllten Chat gar nicht absenden — der Admin sah das nie, weil
der Filter Admins durchlässt.

### Behoben

**Ein Schalter, der nur für den Betreiber schaltete.** `GET
/api/display-settings` las `hideThinkingBlock` über die Prozess-`Settings`.
Geschrieben wird der Wert über `PUT /api/settings` in die `config.yml` des
Aufrufers, gelesen aber wurde die des Betreibers — für jeden Mandanten war der
Schalter damit ein Blindschalter. Die Route löst ihre Settings jetzt mit
`getSettingsForIdentity` auf, wie die schreibende Seite es längst tat.

**Ein fremdes Projekt in der `config.yml` eines Kontos.** Die Registrierung des
Skill-Ordners baute ihre Liste aus `cfgSkills.get()`, und das mischt die
Projektebene des Prozess-Arbeitsverzeichnisses ein. Ein Projekt-Pfad wäre damit
als Benutzer-Eintrag im Konto gelandet und hätte jeden
Projekt-Vertrauensfilter überlebt, weil er dann als `custom:user` gilt. Die
Registrierung liest und schreibt nur noch `getGlobalSettings().skills`.

### Nicht geprüft

Stated plainly, because a release note that claims more than what was run is
worse than one that admits the gap:

- **Nur Chromium.** Jede Messung an der Verwaltung — Laden, Speichern, Löschen,
  der vorausgefüllte Composer — lief in Chromium. Firefox und Safari sind
  ungemessen, und mobil ist die Ansicht nur über die schmale Leiste im selben
  Chromium geprüft, nicht auf einem Gerät.
- **Die Antwort des Recherche-Prompts ist ungemessen.** Belegt ist, dass der
  Text vollständig im Entwurf steht, `{{topic}}` stehen bleibt, der absolute
  Bestandspfad im Prompt steht, der Fokus im Composer landet und nichts gesendet
  wird. Nicht belegt ist, dass ein Modell den Prompt bis zum Ende durchläuft und
  dabei eine brauchbare `SKILL.md` schreibt.
- **`/reload` weitet eine nicht vertraute Sitzung nicht.** Die Skill-Liste wird
  beim Sitzungsstart gefiltert; `reload` ruft `refreshSkills()` der Sitzung, und
  ob das den Trust-Filter erneut anwendet, ist nicht gemessen. Wer ein Projekt
  nachträglich vertraut, soll einen neuen Chat öffnen.
- **Der Trust-Speicher bleibt prozessweit.** Er liegt in der
  Prozess-Agent-Wurzel (`omp-web-trusted-projects.json`), nicht pro Konto. Ein
  Vertrauensklick für ein Verzeichnis gilt damit für jedes andere Konto, das
  dasselbe `cwd` öffnet. Das ist die bisherige Semantik und keine neue Lücke,
  aber es ist eine Aussage über alle Konten und nicht über eines.

What was run, in this checkout, on the tree that was committed:

| check | result |
| --- | --- |
| `bun run typecheck` (`tsc --noEmit`) | 0 errors |
| `bun test` (`NODE_ENV=test bun test`) | 1717 pass, 0 fail, 1 skip — 1718 tests, 200 files |
| `bun run build` (`scripts/run-next.mjs build --webpack`) | exit 0, `BUILD_ID` `UCSVUspSRaf33mqdpGg1R`, 496 files under `.next/static/**/*.js` |
| `bunx eslint components/ app/ lib/ instrumentation.ts hooks/` | 0 problems |

## v0.19.0

Released 2026-10-30.

### Sitzung

**Eine Stunde, gleitend.** `SESSION_TTL_MS` ist von 24 h auf 1 h gefallen, und
`proxy.ts` stellt den Cookie neu aus, sobald mehr als die Haelfte davon
(`SESSION_RENEW_AFTER_MS`, 30 min) seit `issuedAt` vergangen ist. Damit ist die
Stunde die **Leerlaufzeit** und nicht die Sitzungslaenge: wer die Seite offen
haelt, bleibt angemeldet, wer sie eine Stunde nicht anfasst, faellt heraus.

**Was als Aktivitaet zaehlt, ist jede authentifizierte Anfrage** — jeder
Seitenaufruf, jede API-Antwort, jedes `EventSource`-Wiederaufnehmen. Es gibt
keinen eigenen Keepalive und keinen Timer: das Cookie traegt seinen
Ausstellungszeitpunkt selbst, also braucht die Drosselung keinen Serverzustand.
Ein Vordergrund-Tab mit 36 authentifizierten Requests pro Minute bekommt
deshalb nicht 36 `Set-Cookie`, sondern hoechstens eines pro halbe Stunde. Nur
die Cookie-Tuer erneuert: Basic Auth hat keine Sitzung zu verlaengern, und ein
abgelehnter Request erreicht die Zeile nicht — ein gestohlener Cookie laesst
sich also nicht durch Klopfen an ein 401 am Leben halten.

**Die Attribute kommen aus einem Helper**, den Login, Erneuerung und Logout
gemeinsam nutzen: `SameSite=strict`, `HttpOnly`, `Path=/` und host-only bleiben,
`Secure` folgt jetzt der Anfrage. Hinter TLS-Terminierung an — auf dem internen
Klartext-Port `:8788` aus, weil ein `secure`-Cookie dort bei jedem Request
verworfen worden waere. Vorher hat kein Test die Attribute geprueft; jetzt schon.

### Sicherheit

**Der Schluessel der Sitzung ueberlebt einen Neustart.** Bis hierher war er ein
`randomBytes(32)` auf Modulebene, also zog jeder Kaltstart einen neuen und jede
lebende Anmeldung war tot. Das war kein theoretischer Fall: `omp-web.service`
laeuft mit `Restart=always` und einem Healthcheck alle fuenf Minuten, und im
`journalctl` vom 30.10.2026 stehen **zehn** Stopping+Started-Paare an einem Tag
(00:39, 01:18, 01:19, 06:33, 08:03, 09:00, 10:01, 11:01, 13:37, 21:30 UTC) —
mehrere davon im Stundenraster, jeder davon hat jeden offenen Tab abgemeldet.
Das war die Ursache des Symptoms „nach zehn Minuten abgemeldet"; im Code gibt es
keine Zehn-Minuten-Frist fuer das Cookie (die beiden 10-Minuten-Werte im Repo
sind ein Recovery-Code und der Idle-Timeout der Agent-Session).

**Was das kostet, klar benannt:** wer die Schluesseldatei lesen kann, kann
Cookies fuer jedes Konto muenzen, ohne das Passwort zu kennen — der Schluessel
ist ein zweites Geheimnis neben `omp-web-auth.json`. Das ist die Umkehr einer
bewusst getroffenen Entscheidung, und der Preis steht hier, weil er der Grund
dafuer ist, wie die Datei liegt: `0600`, im Verzeichnis der Credential-Datei
(`OMP_WEB_SESSION_KEY_FILE` verschiebt sie), dessen `0700` schon das Passwort
schuetzt. Wer sie lesen kann, ist derselbe Dienstbenutzer, der auch die
Kontendatei und jedes Mandanten-Home lesen kann — es kommt keine neue
Rechteklasse hinzu, nur ein zweites Secret an einem Ort, an dem schon eines
liegt.

**Rotation ist ein `rm` und ein Neustart.** Jeder lebende Cookie stirbt damit,
was der alte Dauerzustand war. `OMP_WEB_SESSION_KEY_EPHEMERAL=1` stellt das alte
Verhalten wieder her: kein File, Salz pro Prozess, Neustart = Logout. Es ist
dokumentiert und getestet, aber nicht der Default.

**Ein Logout widerruft endlich etwas.** Gemessen war der alte Cookie nach
`DELETE /api/web-access/login` weiterhin `200`: es gab keinen Server-Record,
also nichts zu widerrufen. Jetzt haengt der Schluessel an einer
Widerrufs-Epoche je Benutzer (`omp-web-sessions.json`), die der Logout erhoeht;
jede Kopie, die vorher entstanden ist, faellt damit durch die Signatur — auf
jedem Geraet dieses Benutzers. Was weiterhin nicht geht, und was hier nicht
behauptet wird: Basic Auth laesst sich nicht abmelden (es ist ein Header, keine
Sitzung), und die Epoche ist kein Sitzungsprotokoll — es gibt weiterhin keinen
Datensatz pro Login und keine Replay-Sperre.

**Dieses Deploy meldet jeden offenen Browser genau einmal ab.** Die heute
gueltigen Cookies sind mit dem alten, prozessgebundenen Schluessel signiert;
der erste Start mit persistiertem Schluessel kann sie nicht pruefen. Danach
ueberlebt eine Anmeldung die Neustarts, die sie vorher gekostet hat — das ist
der Zweck des Release.

### Nicht geprüft

Stated plainly, because a release note that claims more than what was run is
worse than one that admits the gap:

- **Kein echtes Telefon.** Die Sitzungs- und Erneuerungsmessungen laufen im
  Browser, nicht auf einem Geraet; wie ein mobiler Browser den Cookie ueber
  einen echten Netzwechsel haelt, ist damit nicht belegt.
- **Der IME ist weiterhin nur im Unit-Test geprueft**, nicht an einer echten
  Eingabemethode (unveraendert seit v0.16.0).
- **Die Tauri-Desktop-Shell wurde nicht gebaut.** `src-tauri/` steht weiter auf
  `0.2.10`.
- **Kein Test fuer einen Schluessel, der von einem anderen Benutzer geschrieben
  wurde.** Die Datei wird mit `0600` angelegt und ein `EACCES` beim Lesen ist
  nicht als eigener Fall gemessen — nur der Normalfall und der fehlende Fall.

What was run, in this checkout, on the tree that was committed:

| check | result |
| --- | --- |
| `bun run typecheck` (`tsc --noEmit`) | 0 errors |
| `bun test` (`NODE_ENV=test bun test`) | 1681 pass, 0 fail, 1 skip — 1682 tests, 193 files |
| `bun run build` (`scripts/run-next.mjs build --webpack`) | exit 0, `BUILD_ID` `v-JIHe6I8Y7asOh-4tJfz`, 494 files under `.next/static/**/*.js` |
| `bunx eslint components/ app/ lib/ bin/ proxy.ts test/` | 0 problems |

## v0.11.0

### Layout

**Every project card drew its path backwards.** The path sits in a
`direction: rtl` box, which is what makes the truncation happen at the *start*
so the informative end of the path stays on screen. That same directive
reorders the glyphs: measured in Chromium on 2026-10-21, the leading `/` was
painted at the **end** of the string, so every card in every viewport read
`home/steimmerbyte/workspace/omp-web/` instead of
`/home/steimmerbyte/workspace/omp-web`. Read back per character, the `/` sat at
x=533.1 while the `h` behind it sat at x=302.1 — about 231px out of place.

The path is now wrapped in `<bdi dir="ltr">`, which isolates it as
left-to-right while the box around it stays RTL and keeps truncating at the
start. Measured after the change on the same long path: the visible run is a
contiguous substring of the logical text in the right order (was: not a
substring at all) and it is a suffix of it, so the tail — the part that
identifies the project — is what stays visible. The full path is still in the
`title` attribute, and the DOM text carries no bidi control character, so
copying a path out of a card yields the path.

A LEFT-TO-RIGHT MARK (U+200E) prefix renders identically and was the first
candidate. It was rejected: it is an invisible character in the source, and it
copies into anything the user selects from the card.

**The board rearranged itself after a thirty-second wait.** `GET /api/projects`
measures folder sizes synchronously and can take up to 30 seconds. The skeleton
and the real grid asked for different column rules — the skeleton for a fixed
`repeat(3, minmax(0, 1fr))`, the real grid for
`repeat(auto-fill, minmax(258px, 1fr))` — so the columns could not agree:

| viewport | skeleton | after loading |
| --- | --- | --- |
| 390x844 | 3 × 106px | 1 × 342px |
| 768x1024 | 3 × 145.3px | 1 × 460px |
| 1440x900 | 3 × 369.3px | 4 × 274px |

Both grids now take one shared rule, and the `columns` parameter is gone: it
was a number that had nothing to do with the rule and could therefore drift
away from it. The card's own height moved into `ProjectCard` as
`PROJECT_CARD_HEIGHT` and the skeleton imports it, so the placeholder reserves
the box the card declares rather than a number copied out of a comment.

The loading state also stopped claiming things it did not know. It said
"0 projects · 0 chats" for the whole wait, which reads as an empty board
rather than a slow one; it now shows a bar of the header's own line height, and
the header measures 81.5px in both states.

The category chips are one scrolling strip instead of a wrapping row. The
names are account data from the registry (`GET /api/projects` returns
`file.priorities`, renameable per account), so their width is not known before
the answer arrives — and it is what decided how many rows the chips took.
Measured at 390x844, five categories wrapped the chips into two rows and put
the first card 38px lower than it had been a moment earlier; at 768x1024 the
same happened at a different name length than anyone would have predicted. The
strip is `flex-wrap: nowrap` and scrolls sideways when the chips do not fit, so
its height is one line whatever the data says. Measured after the change at
390x844, 320x800, 768x1024 and 1440x900, with one, three and five categories
in use: the bar's height, the search field's position and the first card's
position are identical before and after the load in all twelve combinations.
Nothing is reserved for categories that are not in use.

The skeleton cannot know how many *groups* there will be — `priorities` is
empty until the same response that brings the projects — so the board shows two
groups while loading and up to five afterwards. The first group stands still;
the content below it grows because the answer was longer than the placeholder,
not because two rules disagreed. That is what `ProjectGridSkeleton`'s docstring
says now, replacing a sentence that claimed the opposite of what the code did.

All of it is pinned by `components/projects/ProjectCard.path-order.test.mjs`,
which mounts the components in jsdom and asserts what they produced. It fails
on the pre-fix code — checked by re-introducing each defect: 0 pass, 4 fail.
Two of its assertions are about properties of the DOM and not of the layout
(the path's character order, the identity of the two grid rules); the ones that
are layout — where the first card stands, how tall the strip is — are proved in
a browser, because jsdom has no line boxes.

**Still open: the thirty seconds themselves.** `GET /api/projects` measures
folder sizes with `du` synchronously, eight at a time, before it answers
(`lib/project-size.ts`: 10s per project, `ceil(n/8) * 10s` worst case). The
board now looks the same throughout that wait, but it is still a wait: nothing
in this change shortens it. Moving the measurement off the request is a
different piece of work.

### Settings

**The settings window cut off part of its own content, with no scrollbar to
show for it.** `.window` is `display: grid` with `grid-template-columns` but no
`grid-template-rows`, so its single row was an implicit `auto` row — sized by
its content — while the box was bounded by `height`. The row grew past the box
and `overflow: hidden` cut it away. `.content` reported `scrollHeight ==
clientHeight` and therefore believed it was complete, so nothing scrolled.

Measured 2026-10-21 on a production build, Chromium 1237, with the Models
section open:

| Viewport | `grid-template-rows` | `clientHeight` | Cut off | Buttons below the bottom edge |
|---|---|---|---|---|
| 390x844 | 967px | 826px | **141px** | **28** |
| 1440x900 | 910.5px | 858px | **53px** | **7** |

`document.elementFromPoint` on the centre of one of those buttons returned the
`SettingsConfig_backdrop`, not the button — on the phone the hit point was
outside the viewport entirely. The affected controls are the model reasoning
selectors (`inherit`, `off`, `auto`, `minimal`, `low`, `medium`, `high`) and
the nav entries at the foot of the sidebar.

`grid-template-rows: minmax(0, 1fr)` bounds the row to the window. After it the
same two viewports measure 826px and 858px, `.content` ends exactly on the
window's bottom edge, 0 buttons lie below it, the window itself no longer
scrolls (`clientHeight == scrollHeight`), and `.content` scrolls internally.
`.sidebar` and `.nav` need no `min-height: 0` for this — they are grid items
stretched onto the bounded row, and `.nav` measures `clientHeight` 730 against
`scrollHeight` 871 and scrolls. Adding it changed nothing measurable.

### Data loss

**A change made while the folder sizes were measured was lost.** `GET
/api/projects` measured the sizes inside the request and wrote the result back
afterwards — but it wrote back the registry it had read *at the start* of the
request. A `PUT` in between, a changed priority, a todo counter or a status,
was silently overwritten by that stale snapshot. The window was as wide as the
measurement: 20,5 s for the 18 roots of a real registry (measured 2026-10-22),
and up to 90 s when the 30 s per-folder budget is hit in all three serial pool
rounds (a calculation from the constants, not a measurement).

The measurement now runs in the background, and the run reads the registry
**again** immediately before it writes and applies the measurement to that
state — `applySizeMeasurements` touches the size fields (`sizeBytes`,
`sizeMeasuredAt`, `sizeIsLowerBound`) and nothing else. The window between read
and write is milliseconds instead of
twenty seconds, and a project that was deleted in between is not written back
at all. The regression test was written first and was red against the old code
(`'now' !== 'later'`): `app/api/projects/size-race.test.mjs`.

**Deleting a project could destroy the omp installation.** On 2026-10-20 a test
ran `DELETE /api/projects/home/steimerbyte/.omp` against the dev server and lost
130 chats. `isProtectedProjectRoot` did not fire, and the reason was structural:
`getUserHome()` returns `/` for an **admin**, so every home-derived rule was
evaluated against the filesystem root, where `/home/steimerbyte/.omp` sits at
depth 3 — outside the depth-1 rule that normally protects `~/.omp`. Measured
before the fix: `isProtectedProjectRoot("/home/steimerbyte/.omp", "/")` was
`false`; for a non-admin it was `true`. The protection was a coincidence of the
identity's home pointing at the right tree.

- The omp runtime directories are now refused **by their resolved path**, from
  `getAgentDir()` / `getConfigRootDir()` / `getSessionsDir()` and from any path
  passing through a `.omp` segment — for every identity, admin or not. The
  answer no longer depends on what `getUserHome()` returned. Both the resolved
  config-dir name and omp's default `.omp` are matched, because
  `getConfigDirName()` follows `PI_CONFIG_DIR`.
- An **ancestor** of the home and **any account's home directory** are refused
  too. `/home` measured `false` before: it is nobody's home, and no rule
  reached it.
- `protectedRootReason()` gained `omp-runtime`, `home-ancestor` and
  `account-home`, and `DELETE /api/projects/…` reports the reason next to
  `code: "protected"`. "Pick a different folder" and "this is the running
  installation's own state" are different sentences and the UI now tells them
  apart.

**Every other write on a protected folder is refused as well.** Delete, create
directory, rename, move and copy under the file explorer ran their filesystem
call first and only asked afterwards — so a rename that would have landed on the
agent directory was already irreversible once the guard answered. Each of those
handlers now asks before touching anything, and asks twice where it takes a
source and a target.

**Deleting a project now states what it would destroy first.** `GET
/api/projects/[…root]` returns the chat count, the recursive entry count and
whether a confirmation is required, under the same guards in the same order as
the delete. At ten or more chats the delete is refused with `409
confirmation-required` until the request repeats that number in
`x-omp-delete-confirm`; a number that no longer matches answers `409
confirmation-stale`. A boolean "confirmed" cannot tell "the user saw 3" from
"the folder holds 130".

### Sign-in

**The native Basic-Auth dialog is gone.** A browser without a valid session
cookie now gets a `302` to `/login` and the styled form, and nothing else.
Two things caused the dialog and both are removed from `proxy.ts`:

- The inline NGINX-style page that `unauthorizedPage()` returned as the
  non-navigation fallback is deleted. Nothing referenced it outside the branch
  that answered with it.
- `WWW-Authenticate` can no longer reach a browser. It is withheld from any
  request carrying Fetch Metadata — `Sec-Fetch-Mode` or `Sec-Fetch-Site`, which
  every browser sends on any request and no CLI sends — so a header that
  cannot arrive in a browser cannot open a dialog, whatever a future engine
  does with a `401` on an XHR.

**What did not change, for scripting clients.** An unauthenticated `/api/*`
request is still refused with `401` and the same body:

```bash
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/whoami   # 401
curl -s http://127.0.0.1:8080/api/whoami | jq -r .error                 # Authentication required
curl -u omp:'…' http://127.0.0.1:8080/api/whoami                          # 200
```

The challenge header itself is still sent to callers without Fetch Metadata, so
`curl --anyauth` and the Go/Java/Rust stacks keep working unchanged. Two
behaviours are worth knowing when a script reads a *page* URL rather than an
API one:

- `curl -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/` now answers
  `302`, not `401` — bare curl sends no fetch metadata and is read as a
  navigation. Use `-L` to follow it, or point the check at an `/api/*` route.
- `unavailable` still answers `503` and still answers `503` on `/api/*`, and a
  rejected request still refuses the same paths as before. Only the *form* of
  the refusal moved.

### Animations

- **The login scanline ran once and then went quiet for good.** Reported as
  "the animation on the login card is broken". It was not broken — it was a
  mis-timed loop, and the two read the same to the person looking at it.
  Measured in Chromium against production (card 470×410, the band's pixels
  compared against the parked state, both themes):

  | animTime | before | after |
  | --- | --- | --- |
  | 0 – 2400 ms | travelling, peak deviation 396 (light) / 366 (dark) | travelling, 3 runs of 2100 ms each |
  | 2400 – 3200 ms | — | rest, 1100 ms |
  | 3200 – 5600 ms | **nothing to see**, deviation 0 | travelling |
  | 5600 – 6400 ms | — | rest |
  | 6400 – 8800 ms | **nothing to see**, deviation 0 | travelling |
  | 8800 – 9600 ms | — | rest |
  | after | finished, `fill: both`, still forever | finished, still |

  The old cycle was 2.4 s travel against 4.8 s rest at
  `iteration-count: 1`, so 4.8 s of a 7.2 s cycle — two thirds — showed
  nothing, and after the single run nothing ever again. The rest was not calm:
  the parked band measures 15 (light) and 10 (dark) against 255 against bare
  panel, so a viewer got a card that stood still and read it as a failure. The
  cycle is now 3.2 s at 75 % travel and 25 % rest — the same ratio
  `@keyframes omp-shimmer-wash` uses — and runs three times, so 20 of the 20
  sampled frames in the first two seconds after page load are moving, in both
  themes.

  What did not change, and was checked rather than assumed: the card still
  stands still. The band is on `::after`, which carries `pointer-events: none`
  and changes no box, so the bounding box is **one** value over 591 sampled
  frames across 9.8 s — `425.72,250,482.56,400`, identical while the band is
  in motion — and all 15 `locator.click()` calls across the cycle pass in
  69–78 ms. It is also still finite: `iteration-count: 3`, never `infinite`,
  because the card standing still at the end was the point of the original
  change. The reported break was not in production either: the CSS module
  hashes served there (`login_scanline__BO0D1`, `login_login-scanline__CMDUD`)
  are identical to the local build's, and the runtime behaviour matched frame
  for frame.

**`motion` is now the single animation source.** The `.omp-*` classes and their
eighteen `@keyframes` are gone from `app/globals.css`; every moving surface now
runs through `components/motion/`. The duplicated `session-info-pop` keyframes
that lived in an inline `<style>` block inside `AppShell` are gone with them.

- **A global switch: Settings → Animations.** Full, Reduced or Off. It is stored
  as `omp-animations` in `localStorage`, deliberately not as a `/api/settings`
  key — that route projects a schema out of the pinned
  `@oh-my-pi/pi-coding-agent`, so a new path there would mean patching a
  foreign package for a value the server never reads. Off stands still
  regardless of the OS setting; Reduced defers to `prefers-reduced-motion`.
  Changing it takes effect without a reload, and `hooks/useTheme.ts` reads the
  same attribute so a theme change does not wipe while everything else stands
  still.
- **Loading states are no longer blank text or nothing at all.**
  - A session that is still loading shows three skeleton lines instead of a
    bare "Loading session" string.
  - The file explorer shows ten skeleton rows instead of "Loading files…", and
    the gear that appears while a directory opens now turns. It was rendered
    without any animation before, on a path the user takes on every folder
    click.
  - The terminal's "connecting…" chip runs as a shimmer, and the status dot in
    the terminal menu pulses while a session is running instead of standing
    still. Its colour is now `var(--success)` rather than a hard-coded hex, so
    an imported theme applies to it.
  - The models, skills and plugins detail panels render skeletons instead of
    leaving the whole area empty.
  - While the agent writes a message, a three-dot shimmer runs under it. That
  separates "the agent is thinking" from "the agent is writing" — previously
  only the first was visible.
- **The press feedback lost a distinction that no longer exists.**
  `.omp-press-scale` was needed because a CSS keyframe overwrote `transform`
  outright and clobbered an element's own rotation. Motion composes transforms,
  so it is now the same `whileTap` as the plain variant.
- SMIL `<animateTransform>` on the subagent spinner is replaced by motion.
  SMIL and motion on the same node fight each other.
- **The shimmer is on every surface now, for loading and for pop-up.** Two
  things had to be fixed for that to be true, and neither showed up in the code
  review:
  - The loading placeholder set `background` as a shorthand, which overwrote
    `background-image` — the gradient itself — so the shimmer rendered as a
    flat block. It is `backgroundColor` now.
  - The wash ran at 26 % accent and was invisible against the panel colour in
    both themes. It runs at 46 % with a light core, and it follows the active
    theme either way.
  - A panel that pops up now plays a one-shot wash on the way in. Rising and
    un-blurring alone says "it appeared"; the sweep says "it arrived". The
    endless variant belongs to loading surfaces only — on a finished panel it
    would never stop.
  - The plugins list, the access and account panels, and the two top-bar
    panels (system prompt and language) showed plain text or rendered as bare
    elements with no entrance at all. They shimmer now.
  - **The endless wash now ends.** It circles once, runs out, and only then
    begins again — on the login page and on every panel, since they share the
    one rule. The cause was not the looping but `background-repeat`, which the
    rule never set and which therefore defaulted to `repeat`. The band is a tile
    twice the element's width whose gradient is transparent over its outer 10 %
    at each end, which paints [20, 180] of each tile and leaves a clear gap of
    40 percentage points before the next tile's paint begins. The element's own
    window is 100 points wide, and a 100-point window cannot fit inside a
    40-point gap — so the neighbouring tile always closed in behind the band
    and refilled what it vacated, and the old travel had no empty moment
    anywhere in it. Travelling further could not have helped. The darkest point
    of that run was 0.19 against the band's 0.46, at 150 % of the way through,
    and that is a dim position rather than a cleared one.
    `background-repeat: no-repeat` is the condition for the run's endpoints
    being empty at all, and therefore for a rest existing between two runs: the
    run is now 190 % → -90 %, measured peak 0.0000 at both ends against 0.4600
    at the midpoint. The fade is the gradient's own transparent tail, measured
    decaying 0.38 → 0.27 → 0.16 → 0.05 → 0 across the last quarter of the run, so
    it needs no second `opacity` claim on the same pixels. The last quarter of
    the 1.6 s cycle is a rest: at 0.4 s it reads as a deliberate beat between
    passes, where a shorter one would be integrated back into continuous motion
    and a longer one would read as finished. Only the band rests — the surface
    underneath is the skeleton, the badge or the label, so a loading panel is
    never an empty one. `SHIMMER_DURATION` still rules the timing: the 75 % is a
    share of the cycle, not a second duration.

**Not verified in this release.** Stated plainly, because a release note that
claims more than was tested is worse than one that admits the gap:

- The sandbox was exercised on one host, on Linux, with `bubblewrap` present
  and unprivileged user namespaces enabled. The `userns-disabled` and
  Windows branches are covered by type and by the refusal contract, not by a
  run.
- The Docker image was built and `command -v bwrap` was confirmed inside it.
  The container was not started against a real multi-account setup.
- A working directory outside the account's home is now refused. If a
  deployment relied on opening a terminal in such a directory — an
  `~/omp-cwd-*` grant, for instance — that terminal will now be refused with a
  remediation instead of opening. Bind it deliberately rather than expecting it
  to keep working.
- The animation switch itself has **not** been exercised through a browser. The
  mode mapping, the fallback on an invalid stored value and the storage/DOM
  round trip are covered by `components/motion/motion.test.mjs`; the rendered
  motion is not. Verify it on a real session before relying on it.

### Gradient border

**The chat input can wear a rotating gradient border while an agent works.**
The ring is drawn around the composer bar, its colours turn, and it is gone
the moment the agent stops. It is a new look, so it is **off by default** and
the user switches it on in **Settings → Animations**, where the whole group
lives: a switch, five colour presets, four colour pickers, a slider for the
width, one for the rotation speed and one for the glow.

The defaults are a **6 px** ring, a **2.4 s** turn, the **Omphie** palette
(amber, green, blue, violet) and a glow at **0.25** with a **4 px** blur. The
rotation runs **only while an agent is working** — a running shell command
does not light it up, because the busy state of the surface and the state of
the agent are not the same thing. The colours, the width, the speed and the
glow are stored in `localStorage` under `omp-gradient-border`, in this browser
only, next to the other surface preferences.

The ring is a band, not a frame. It lies outside the bar and covers the one
pixel border the bar has, and it reaches **no pixel into the padding** the
text lives in, at any width — the bar's box is the same with and without the
ring, measured. That took the geometry apart: the containing block of an
absolutely positioned layer is the **padding box** of its positioned ancestor
and not the border box, so the offsets have to be the width plus the border
on both sides. The formula lives in
`components/motion/gradient-border-settings.ts` and
`components/motion/gradient-border-settings.test.mjs` holds it down.

**A colour that vanishes on white is a colour that is not there.** The first
palette was measured against the two surfaces the bar stands on, and its green
reaches **1.34:1** against white — invisible as a line. A second palette,
**Omphie Light**, carries the same hues with depth: the four colours reach
3.19:1 at the weakest against white and keep 3.11:1 against the dark
surface. The glow was pulled back to 0.25 and its blur to 4 px for the same
reason: at the earlier values the halo, not the ring, was what the eye saw.

The rendered motion was measured in Chromium: two frames 1.5 s apart differ in
**4 411 of 17 661** pixels of the ring zone and in **none** of the 22 230
pixels of the surface inside the bar.

### Terminal

**Tenant shells run in a user namespace.** `lib/sandbox.ts` builds a
`bubblewrap` argv whose only bind is the account's own home, and
`lib/terminal-manager.ts` replaces the shell command with it. Measured: a
foreign home answers `No such file or directory` rather than `Permission
denied`, `/etc/shadow` stays unreadable, and `uid=0` inside the namespace is
not host root. The OS-user-per-account route was measured and is unavailable
on the target host — no root, no sudo, `setpriv` answers `setresuid failed` —
and the namespace has the property that route would have broken: an
unprivileged namespace maps the fake uid back onto the service account, so the
service can still read and clean up after a tenant.

- `sandboxed` is now part of `GET /api/terminal` and `GET /api/terminal/<id>`.
  Without `bubblewrap` or with user namespaces disabled the shell still opens,
  unconfined, and the flag is `false` — the key is always present, never
  absent, so a client does not have to tell "not isolated" from "unknown".
- A working directory outside the account's home is refused as
  `cwd-outside-home` with a remediation, rather than passed through to fail
  later as `[Process exited with code 1]` in the SSE stream. A username that
  would escape its path segment is refused as `bad-username` instead of
  borrowing the unrelated `no-home` reason.
- Bind sources that the host does not have are skipped. `bwrap` aborts on a
  missing `--ro-bind` source rather than ignoring it, so a host without
  `/lib64` previously lost the terminal entirely.
- The Docker image installs `bubblewrap`. It is the one host where every
  terminal otherwise took the `bwrap-missing` branch.

### Quick phrases

**Saved texts are one click deep in the composer.** A phrase carries a button
label and, separately, the text to insert. Each configured phrase renders as a
button row above the input field; one click inserts its text **at the cursor
position**, keeping the text to the left and right of the caret untouched. The
full text is the button's tooltip, so a short caption can carry a long or
multi-line insertion.

- Managed in Settings → Quick phrases. The list is the button order; there is
  no separate sorting, grouping or shortcut layer, by design.
- **The list is stored on the server, one file per account.**
  `app/api/quick-phrases/route.ts` (GET/PUT) follows the `models-config` route:
  `requireIdentity`, `403` in both handlers, `415` without a JSON content type.
  The file is `omp-web-quick-phrases.json` inside
  `resolveTenantAgentDir(identity)` — the same directory the trust store uses —
  written with `writePrivateFileAtomicSync` (`0o600`, temp file plus rename).
  The path is checked with `isPathWithinRoots` **before** the directory is
  created, so a refused request leaves nothing behind in a foreign home.
  A `localStorage` list followed the browser, not the account: a second browser,
  a private window or a different workstation showed a different set, and
  changing machine lost it silently. The agent never reads these phrases, so
  they still do **not** go through `/api/settings` — that endpoint projects a
  schema owned by a pinned package, and extending it would mean patching
  `node_modules`.
- **Existing phrases migrate without loss.** At the first server fetch, if no
  file exists yet, the phrases from `omp-quick-phrases` move to the file. The
  defaults are seeded only when *both* legacy keys are absent — the same rule
  the old seed used, and for the same reason: overwriting a list the user
  wrote, at the moment of the first read, before they ever see it, is the worst
  thing a seed can do. The legacy keys are cleared after the `PUT` succeeds, so
  a server that goes down in between leaves the phrases in the browser to be
  offered again.
- A phrase without a non-empty `text` is dropped on read and on write: a button
  that inserts nothing is a silent malfunction. An empty label is allowed and
  falls back to the text, shortened to one line.
- The row does not wrap. On a 390 px screen with twenty phrases it stays a
  single 18 px-tall line that scrolls horizontally (measured: `scrollWidth`
  1540 vs `clientWidth` 330), so every phrase remains one click deep instead of
  costing three rows of transcript height.
- **Typing writes once, not once per letter.** The settings section debounces
  400 ms and additionally writes on field blur and on dialog close, so closing
  without touching anything else still persists. Delete and Add bypass the
  timer: a delete that waits for a debounce window looks to the user like the
  row came back.
- A failing server does not clear or freeze the view. The last list the user
  saw stays on screen and the settings section says what went wrong; a failed
  request is retried on the next load. The first fetch is single-flight, so
  composer and dialog mounted together cause one request, not two.
- The button label is user content and is never translated; only the settings
  section's own strings are.
- Seven defaults are seeded on the first fetch when there is nothing to
  migrate: `Research`, `Compare`, `Verify`, `Explain`, `Review`, `Tests`,
  `Fix`. The first three reach outward — they research a topic or compare
  options instead of talking about the code in the window, which is why they
  work with an empty input field. **Seen once, never again:** the existence of
  the file is what decides, not the list contents. Delete all seven and they
  stay gone, on every tab, every browser and across reloads. A file that exists
  but is empty is a decision, and an unreadable file counts as existing too —
  neither is topped up.

### Accounts

- Uploads in the file explorer land in the directory the user is looking at,
  not in the project root. `cwd` was passed down the upload chain where the
  current browse position was meant.
- Account creation checks `OMP_WEB_HOME_ROOT` before it creates anything, so a
  failure names the variable to set instead of surfacing a raw `EACCES` from
  `mkdir`. An existing, writable root is accepted even when its parent is
  read-only, and a root writable through group ownership is no longer
  refused.

### Interface

**The file explorer's separator line no longer crosses the tree on a phone.**
Reported as "the separator lines are too far up, and as long as I navigate
they should not be there at all". Measured in Chromium at 390×844 against the
big explorer window, the tree area was 120px tall — the minimum from
`TREE_MIN_HEIGHT` — and the section's `border-bottom` landed at y=305, which
is inside the sixth tree row (302–326), so the line ran straight through its
text. The cause was a feedback loop: on narrow viewports the section was
content-sized (`flex: 0 0 auto`, `max-height: 40vh`), so its height depended
on the tree and the tree's own height measurement (`measure()` in
`FileExplorer.tsx`) depended on the section. The loop settled at the
minimum, and the line moved with the tree whenever the listing changed.

The section now takes the space it has (`flex: 1 1 auto`) instead of the
space its content needs, and the line is gone. Measured after the change at
the same viewport: the tree is 611px tall, all 20 rows are inside it, and no
border crosses any row. The line also had nothing to separate — the tree is
the content of its own tab, and the two-column arrangement on a desktop puts
no line between tree and file view either. The desktop layout is unchanged.

**The download button in the file explorer is always there.** It was rendered
only while the row was hovered and positioned absolutely over it, so a
download was reachable by pointer but not discoverable, and the overlay could
cover the file name it belonged to. Every file row now renders the anchor in
the normal flow with `flexShrink: 0`, and the row text gives way with an
ellipsis instead. The remaining hover-only buttons (image preview, mention)
derive their right offset from the same row-action constants, so they keep
their place without a second hardcoded inset, and the dead archive-specific
branch is gone.

### Projects

**The dashboard measured the folder sizes inside the request, and the board was
empty for twenty seconds.** `GET /api/projects` ran `du -sb` per project before
it answered — eight at a time. One measurement of the 18 roots of a real
registry takes **6,9 s to 20,5 s** (three runs over identical paths on
2026-10-22 on the dev host: 3 pool rounds, 11 of 18 folders measured, 7
without a size, 51,97 GB in the measured folders; the spread is the page cache
of the filesystem, not the code), and the endpoint answered only after it. The
board showed nothing at all for those seconds: not a spinner, not a partial
board.

The measurement runs in the background now (`lib/projects-sizes.ts`). The
request answers with the last known size at once, the run replaces it when it
is done, and the client picks it up from the new `GET /api/projects/sizes` — a
cheap endpoint that reads one small JSON file instead of starting a git
process per project. The same route answers in 0,13 s to 4,39 s now (median
1,21 s over ten requests, same server, same registry), 0,69 s to 1,37 s while
a background measurement is running. The old code answered in 5,0 s with a warm
cache and 52,0 s with a cold one.

**The same change, verified in production.** Deployed on agent-pc and measured
there, with five projects and the same commands before and after: the cold run
answered in **2073,3 ms** before the change — the measurement ran inside the
request — and the route answers with a **median of 2,95 ms** now. The sizes are
in the payload either way, with the same values, none of them marked as a lower
bound. A deliberately forced stale cold run on the new build was **not** taken —
the sizes were only 54 s old at first access — so the numbers show the request
without a measurement step, not a cold run measured end to end. The full
numbers, the measurement environment and what was *not* verified are in
`docs/spec.md`.

**The size cache expired faster than it could be filled — and it never
expiryed at all.** `SIZE_TTL_MS` was 30 seconds against a measurement that
takes 6,9 s to 20,5 s, so every request found the previous result already
expired and started a new `du` swarm — per request and per open tab. It is
five minutes now. The run is not on a timer but request-triggered, so the load
is not "every TTL" but "every time somebody opens the dashboard": one run
costs up to 20,5 s of eight parallel `du` processes, 6,8 % of the five
minutes, and a closed dashboard costs nothing at all, because no request comes
in and no run starts. With the old 30 s it would have been 68 % on every open
inside a minute. The number stands in the comment above the constant, with the
measurement and the calculation, and `lib/projects-schema.test.mjs` asserts the
same value.

The old rule that decided this was worse than the TTL: "no size" counted as
"stale", and seven of the eighteen folders have no size. So `stale.length` was
never zero, the TTL was never reached, and every single request measured
again. The rule now looks at the timestamp — a measurement that failed has a
timestamp, and it is an answer, not a promise.

**The four biggest folders had no size at all, and now they do.** The
per-folder budget was 10 seconds, and in the measurement above four of the 18
roots hit it: `workspace/omp-web` (10 115,9 ms), `workspace/AGENT`
(10 032,5 ms), `tmp` (10 006,8 ms) and `workspace` (10 004,7 ms) — among them
the project that was being worked on. The budget used to protect the *request*,
which waited for the measurement; nobody waits for it any more, so the budget
now only bounds the background work, and what it costs is the size of the
biggest folders. It is 30 seconds now, which turns a cold run of 18 roots
into up to 90 s (three serial pool rounds of 30 s) — the client's poll window
covers that, and it is derived from the budget rather than guessed next to it
— while a warm run is unaffected (0,16-4,81 s per folder). **16 of the 18
folders have a number now**; the two that have none are roots that do not
exist on the disk, and one of the sixteen is a lower bound. The number is
asserted in `lib/project-size.test.mjs`.

**What makes the measurement expensive is the number of tree entries, not the
number of bytes.** The comment in `lib/project-size.ts` used to say that a
2,4 GB folder takes visibly longer to measure than a 40 MB one. Measured over
15 folders on 2026-10-22, with a linear fit each:

```
t(Bytes)  = 924,95 ms + 2,085e-7 ms/Byte * S      r2 = 0,334
t(Inodes) = 270,13 ms + 0,0212 ms/Inode * I        r2 = 0,919
```

`tmp` holds 20,82 GB and is measured in 0,52 s, because it has 27.518 tree
entries. `omp-web` holds 2,41 GB and needs 4,47 s, because it has 131.766.
`du` walks the tree and stats the entries; it does not read the contents. And
because 11 of the 18 roots lie inside other roots, the workspace tree is
walked **nine times** — nine passes over 487.348 entries. That is also the
argument for the traversal that was rejected: one pass instead of nine saves
not bytes but inode traversals.

**"No size" is an answer, and the card says which one it is.** A folder that
could not be measured is not "not measured yet": the attempt happened, the
answer is "no size", and the next attempt is due when its TTL expires. The
card draws the states apart: "Measuring..." while the number is still owed,
"Size unavailable" when there will never be one, and a "≥" when the number
is a lower bound because `du` could not read part of the tree.

With the 30 s budget, **16 of the 18 folders of the measured registry have a
number and 2 have none** (two roots that do not exist on the disk). "Seven
without a size" was the state of the old 10 s budget, not of this one.

**A folder with an unreadable subdirectory kept the number `du` had computed
and threw it away.** `du` cannot list one subdirectory, prints the error on
stderr and exits 1 — and still prints the total of what it could read.
`execFile` throws on the non-zero exit and throws the stdout away with it, so
every folder with one unreadable subdirectory lost its size even though `du`
had measured it; `/tmp` was only the everyday case. On this host `du -sb
/tmp` exits 1, prints `16830164\t/tmp` on stdout and the permission error on
stderr. The number is kept now,
and it is kept as what it is: a **lower bound**, because the unreadable part
was not counted. The registry carries that as its own field
(`sizeIsLowerBound`), and the card shows a "≥" and a tooltip. A number that
looks exact and is not would be worse than no number.

**The poll window is derived from the measurement, it does not stand next to
it.** The poll has to outlast the measurement it waits for, and the worst case
of a measurement is `ceil(projects / 8) * 30 s`, because the pool rounds are
serial. With a fixed 60 polls of 2 s the window was 120 s and the worst case
of 40 projects was 150 s: the client gave up while the measurement was still
running, and the card kept the old value — and nothing noticed, because the
two numbers were tested separately. The window is now a function of the
project count (`sizePollLimitFor`), derived from the same constants the
measurement uses, and `lib/project-size-poll.test.mjs` holds the *relation*:
it derives the worst case from `MAX_PARALLEL` and `SIZE_TIMEOUT_MS` and
checks that the window covers it. For the 18 projects of the measured
registry that is 3 rounds of 30 s = 90 s = 45 polls plus the reserve of 15 =
60 polls — the number the design named, as the outcome of the derivation
rather than its input.

**After the poll ends, the size stands, and the card says how old it is.** The
poll does not continue in a slower rhythm: that would trigger server-side
measurement runs again, so the same `du` load as before, only in another
cadence. One run costs 6,9 s to 20,5 s of eight parallel `du` processes; a
poll every minute would mean one run per TTL for as long as the tab is open —
6,8 % of the filesystem, continuously, for a number nobody is looking at. The
old code measured on *every* request, so this is still far below that, but
"far below" is not a reason to keep reading. The size on the card is
therefore the size of the last measurement, and once it is older than the TTL
the metric says so ("Size · 2 h ago").

**The rest of the request was never the expensive part.** Measured with 211
sessions on 2026-10-22: the session list 1492,9-3823,6 ms cold and 0,1-0,2 ms
warm, reading the registry 1,8-2,3 ms, `resolveProject` 0,2-0,3 ms (2 git
processes), `isVisibleTo` 0,4-0,6 ms; 16 git processes in all, 14 of them from
the session list. The floor of `GET /api/projects` is the session list — cold
~1498,8 ms, warm ~2,9 ms — and the sizes were 20,5 s on top of it.

**The sizes endpoint answered about folders the board hides.** `GET
/api/projects` filters its cards to the folders the account may see, and
`GET /api/projects/sizes` did not: it read the same registry and reported
the size and the measurement time of every root in it, including the ones the
board deliberately hides — and the client could not tell that the folder
exists at all. The filter now lives in one place (`visibleProjectRoots`,
`lib/projects-guards.ts`) and both routes use it. It also applies to
`pending`: a hidden folder that owes a measurement no longer keeps the client
polling for two minutes for a number it will never be shown. Measured cost:
about 1,7 ms per request (30 requests in 60 s against the dev server: median
0,0840 s with the filter, 0,0835 s without).

**The poll window was two seconds short at every wave boundary.** The window
has to outlast the measurement it waits for, and the worst case of a
measurement is `ceil(projects / 8) * 30 s` because the pool rounds are serial.
The derivation counted the polls instead of the span — the first poll fires
at t = 0, so 60 polls cover 59 intervals, 118 s, not 120 s. At 25 projects
the run needs 4 rounds (120 s) and the client gave up while it was still
running; nothing noticed, because `pending` was never asked again. The window
is now derived from the span, with a reserve of one whole wave (the project
count can grow while the run is in flight) and one interval: 18 projects get
**62 polls** (122 s of span) instead of 60 (118 s). The test holds the
relation itself, including the wave boundaries — the wave count jumps at 9,
17, 25, 33, … projects, and at every one of those the window of the count
below still carries the count above.

**A failing poll said nothing.** The poller reported its errors to an
`onError` that nobody had passed, so a 500 from the sizes endpoint produced
60 silent polls over two minutes and cards that sat on "Measuring..." with no
explanation. The dashboard now hears the error: the board shows it and the
cards name it instead of waiting in silence.

**The sizes on the cards overlap, and that is not a bug.** `du -sb` on a
parent counts the bytes of its children: `workspace` (20,37 GB) contains the
bytes of the 8 project roots below it, and `.omp` (4,95 GB) contains
`.omp/plugins` (1,21 GB). The sum of the sizes on the cards is therefore
counted twice and is not a total of anything. The semantics stay as they are —
the card shows the size of *that folder* — and `docs/spec.md` says so now for
the reader. A single traversal for the whole tree (`du -sb --max-depth=1`)
would remove the cost driver: the tree is walked nine times, because 11 of the
18 roots lie inside other roots. It would change what the number *means*,
though, which is a decision about the card and not a refactoring.

**A project view instead of a folder browser.** A new top-level view lists the
projects an account works on, with size, priority and todo progress, and can
create, rename and delete them. The registry is a JSON file per account in the
agent directory, following the existing `omp-web-quick-phrases.json` pattern and
the same atomic private write, so one account never sees another's list.
`GET`/`PUT /api/projects` reads and writes it, `DELETE /api/projects/[root]`
removes one entry.

- Deleting a project **checks the protection rule before the first write** and
  then hands session and folder removal to the existing handlers rather than
  reimplementing their cascade. Re-implementing it would duplicate
  `requireSessionAccess` and its deliberate 404-on-foreign-session answer, and
  the identity headers have to travel with the delegated request or the handler
  sees an anonymous one.

**The Projects button now shows the Projects view.** Clicking it pressed the
button and then rendered nothing. The view was gated behind "no chat is open",
but the sidebar adopts a working directory at startup, so a chat is open from
the first moment and that condition was never true again — the panel was dead
code behind a live button. Loading `?view=projects` fell back into the chat for
the same reason after a moment. The view now depends only on the active view,
and the directory chosen at startup no longer steals the initial selection away
from the URL. Choosing a session, starting a new chat or switching the working
directory returns to the chat explicitly instead of by accident.

**Creating a project no longer answers 405.** "New project" posted to
`/api/projects`, which only had a read and an update handler, so the dialog's
submit always failed. The create handler exists now, behind the same identity,
path and protection checks a delete gets, and refuses a name or target that is
already taken instead of silently writing over it. Creating a folder is an
ordinary per-account action, so it needs no admin role.

### Sign-in

The login field no longer arrives pre-filled with `omp`. The value was a
hardcoded state initial value, so the form suggested one account name to
everyone and a user had to clear it before typing their own.

## v0.9.0

The first release of the independent distribution. 98 files, +13,793/−352,
43 commits. Everything below exists only here.

### Security

**A client-supplied header granted full admin access.** `proxy.ts` set the
identity headers on a path that only ran when an identity already existed, so
on an unlocked server — the default, and the state of the machine this was
found on — the client-supplied `x-omp-admin: 1` survived into the route and
`owner-guard.ts` let it through without an ownership check. A forged header
plus an arbitrary username gave arbitrary write via another account's shell.
Found by execution, not by reading: `curl -H 'x-omp-user: root' -H 'x-omp-admin: 1'`
listed `/etc` with status 200.

**A refusal that had two causes.** The write boundary that keeps an admin from
writing `/etc` was verified by mutation, not by watching refusals. Such a file
is refused for two independent reasons — the root filter and the fact that it
sits in no project — so a test that only checks the refusal sees neither. The
coverage asserts the filtered *set* instead.

**Account names are validated before any directory is created**, so `../etc`
never becomes a path segment.

### Accounts

- Real per-account access replacing the single credential: an admin creates
  accounts, each gets its own home, `models.yml`, `config.yml`, sessions, and
  terminals.
- File access is a per-account root set rather than one process-wide allowlist.
  `/` and `OMP_WEB_ALLOWED_ROOTS` are added in the admin branch only.
- Admins can read `/etc` but not write to it — the write boundary is
  deliberately narrower than the read one.
- A foreign session or terminal answers `404`, not `403`, so a probe learns
  nothing about whether the id exists. The `agent/running` snapshot and its SSE
  stream filter too; they publish the ids the rest of the API addresses things
  by.
- A new account's config starts empty on purpose. Copying the operator's
  `models.yml` would hand his API key to the first tenant.
- `OMP_WEB_HOME_ROOT` documented. It is the one variable account creation
  needs, and it was in no documentation at all — the default `/home` is not
  writable by a service account, and the mkdir has no permission check, so
  account creation failed with a raw system error naming the server's path.

### Files

- The explorer tree became a permanent first tab: never closable, files open
  beside it, a button hands the tree back. Previously the tree was a fixed
  column and a preview rendered as a layer underneath it.
- The window portal-renders out of the sidebar. The sidebar sets `overflow-x:
  hidden` on the explore container, and `position: fixed` does not escape a
  clipping ancestor — on a phone the panel was cut in half down the middle.
  `DirectoryPicker` and `FileContextMenu` had always portalled for this reason;
  the explorer was the one overlay that did not.
- Write operations behind a guard: create, rename, move, copy, delete, upload.
- Context menu on tree rows, with a reusable target-folder dialog.
- Image preview with zoom and grid/list modes.

### Terminal

- PTY-backed shell in a browser tab, session-scoped, with input, resize, and a
  stream. On mobile the layout switches to a 90vh overlay.

### Interface

- Live CPU and RAM badge with a sparkline popover, reporting the container's
  actual limits rather than what the host kernel advertises.
- Cookie sessions on top of Basic Auth, a login page with a looping entrance
  animation, and a recovery flow.
- Opening a new tab scrolls it into view. The strip could already scroll;
  nothing asked it to, so on a narrow window the tab you just opened hung past
  the edge and looked clipped.

### Fixes

- A refocused dialog could sit in the background with no focus, taking no
  keypresses: the focus effect ran once against a panel that was not mounted.
- The context menu rendered 84px off.
- Long session titles in a tab appeared mid-component, as if truncated.
- CPU percent read from `os.cpus()` counted idle as busy and pinned at 100%.

### Documentation

- `AGENTS.md` now carries the per-account rules, the owner filter, and the
  statement that none of it is containment. The architecture diagram described
  `/api/sessions` with no ownership condition, which reads as "the tree is
  everyone's" — and it is, one tree owned by the service account.
- `docs/authentication.md` gained a section on where account homes live.

### Provenance

The upstream remote has been removed. There is no merge path and no automatic
tracking; pulling upstream changes in is now a deliberate operation. The npm
publish workflow inherited from the fork is disabled. Releases are GitHub
releases only, installed from a checkout or a release tarball.

### Internal

- `components/motion/animation-mode.ts` holds the animation-mode rules without
  React or JSX, so they can be tested directly instead of inferred from
  component source. `AnimationProvider.tsx` is only the React binding.
- Every primitive in `components/motion/` forwards its ref and the remaining
  motion props. Several popovers measure their own box to decide which way to
  open; a primitive that cannot hand back a ref gets reimplemented inline, and
  that is how the duplicated `session-info-pop` keyframes ended up in
  `AppShell` in the first place.
- `AGENTS.md` gained an "Animations" section recording the same decision, so
  the next animation does not go back to a keyframe or to `/api/settings`.
