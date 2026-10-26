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
