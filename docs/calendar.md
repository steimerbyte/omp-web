# Kalender

Der Kalender ist eine eigene Ansicht in omp-web: ein Monats-, Wochen- und
Tageskalender mit deutschen Konventionen, in dem Termine per Klick angelegt
und per Ziehen verschoben werden. Der Agent liest und schreibt denselben
Kalender über zwei eigene Werkzeuge.

Dieses Dokument beschreibt, was ausgeliefert ist, und begründet die
Entscheidungen, die nicht offensichtlich sind. Die Dateien, die es beschreibt,
stehen in Kapitel 7.

---

## 1. Was der Kalender ist

Ein Kalender ist eine Liste von Terminen mit einem Beginn und einem Ende. In
dieser Anwendung ist das eine Liste **pro Konto**: die Termine liegen in
`omp-web-calendar.json` im Agent-Verzeichnis des Kontos, das sie angelegt hat.

Das ist dieselbe Form, die die Anwendung für alles andere benutzt, was pro
Konto liegt — `omp-web-quick-phrases.json`, `omp-web-projects.json`. Eine
Datei pro Konto, im Agent-Verzeichnis, mit `omp-web-`-Präfix. Drei Beispiele,
eine Regel; die zweite Form wäre eine zweite Antwort auf dieselbe Frage.

### Die Zeitform: lokal und ohne Zone

Ein Termin liegt als String `"2026-03-14"` (Ganztag) oder
`"2026-03-14T15:00"` (mit Uhrzeit) vor. Kein `Z`, kein Offset.

Das ist eine bewusste Entscheidung. Ein Kalender zeigt Termine in der Zeitzone
des Nutzers an, der sie liest — nicht in der des Servers und nicht in der des
Browsers, der sie gespeichert hat. Ein gespeicherter Offset müsste beim Lesen
in die Zeitzone des Lesers umgerechnet werden, und genau an dieser Stelle
fängt ein Kalender an, zur falschen Zeit zu stehen. Ohne Zone gibt es nichts
umzurechnen: derselbe String bedeutet in jedem Prozess dasselbe — „halb drei an
diesem Tag".

Der Preis ist offen benannt: ein Termin, den ein Agent über eine Schnittstelle
anlegt, trägt *diese* Zeit ein, nicht die Zeit des Agenten. Das ist bei einem
Kalender, den ein Mensch liest, das richtige Verhalten.

---

## 2. Die deutschen Konventionen

### Die Woche beginnt am Montag

`weekdayIndex()` liefert 0 = Montag bis 6 = Sonntag. Das ist nicht
kosmetisch: in den angelsächsischen Kalendern beginnt die Woche am Sonntag,
und ein Kalender, der die Wochentagsnamen in der falschen Reihenfolge unter
einander schreibt, verschiebt jeden Termin um einen Tag.

### Die Kalenderwoche ist die ISO-Woche

`isoWeek()` rechnet nach ISO 8601: die Woche beginnt am Montag, und die erste
Woche des Jahres ist die, in der der 4. Januar liegt. Der 1. Januar 2021
gehört damit zu KW 53 des Jahres 2020.

Die Umsetzung benutzt den Donnerstag der Woche, nicht den 1. Januar. Der
Donnerstag ist der einzige Tag, der *immer* in derselben Woche liegt — der
1. Januar kann in der letzten Woche des Vorjahres liegen, und dann wäre eine
Rechnung über den Jahresanfang zwei Jahre lang falsch.

Die erste Woche des Jahres wird über `firstThursdayOfYear()` bestimmt: das ist
der Donnerstag der Woche, die den 4. Januar enthält, und nicht „der erste
Donnerstag des Jahres“. Der Unterschied ist sichtbar: 2026 hat den 4. Januar
an einem Sonntag, die erste Woche beginnt also am 29. Dezember 2025, und ihr
Donnerstag ist der 1. Januar 2026.

### Die Feiertage

`germanHolidays()` liefert die neun bundesweit geltenden Feiertage: Neujahr,
Karfreitag, Ostermontag, Tag der Arbeit, Christi Himmelfahrt, Pfingstmontag,
Tag der Deutschen Einheit, 1. und 2. Weihnachtstag.

Die beweglichen Feiertage hängen am Ostersonntag, der nach der
Gauss-Formel berechnet wird (`easterSunday()`). Die Formel gilt seit 1583 für
die katholische und die protestantische Kirche gleichermaßen, weil beide das
gregorianische Osterdatum benutzen — für einen deutschen Arbeitskalender ist
das genau richtig.

**Bundesländerspezifische Feiertage fehlen** (Fronleichnam, Dreikönig,
Mariä Himmelfahrt, Buß- und Bettag, …). Sie hängen am Bundesland, und ein
Kalender ohne Bundesland-Auswahl kann sie nicht zutreffend anzeigen. Ein
falscher Feiertag ist schlimmer als ein fehlender, deshalb bleiben sie weg,
bis der Kalender eine Auswahl kennt.

### Der Monatsraster hat immer sechs Wochen

`buildMonthGrid()` liefert 42 Tage — sechs Wochen zu sieben Tagen. Die Zahl
der Wochen, die ein Monat überdeckt, hängt davon ab, an welchem Wochentag der
Erste fällt: zwischen vier und sechs. Eine Tabelle, die ihre Höhe mit dem
Monat verändert, springt beim Blättern — und ein Kalender, der springt, ist
unbrauchbar, weil man beim Wechseln den falschen Termin anfasst.

---

## 3. Der Agent am Kalender

Der Agent bekommt zwei Werkzeuge, `calendar_read` und `calendar_write`. Sie
sind in `lib/calendar-tool.ts` definiert und über
`CreateAgentSessionOptions.customTools` **nativ** angemeldet — dasselbe
Feld, das `present_files` benutzt.

### Warum nativ und nicht als Extension

Der Kalender gehört dem *Konto*, nicht dem Projekt. Eine Datei unter
`.omp/extensions` wäre vom Projekt abhängig — und damit vom Vertrauen in
dieses Projekt (`lib/project-trust.ts`). Der Kalender hängt an der Identität,
die die Sitzung geöffnet hat.

### Die Identität wandert mit der Sitzung

Das Werkzeug läuft im Serverprozess und findet dort keinen Request mehr, aus
dem es das Konto lesen könnte. Deshalb wird die Identität beim Start der
Sitzung festgehalten (`RpcSessionStartOptions.identity`) und in die Werkzeuge
eingeschlossen.

Ohne diese Bindung gälte für alle Konten dieselbe Datei: ein Agent eines
Mandanten würde den Kalender des Betreibers lesen und schreiben. Die Bindung
ist deshalb nicht eine Bequemlichkeit, sondern die Mandantengrenze.

### Was die Werkzeuge können

`calendar_read` liest alle Termine oder nur die in einem Zeitraum. Die
Antwort nennt zu jedem Termin Titel, Wochentag, Datum, den Ganztag-Flag, den
Ort und die Notiz — und die Kennung, damit der Agent denselben Termin danach
ändern oder löschen kann. Der Text kommt deutsch zurück, weil der Nutzer ihn
im Chatverlauf liest.

`calendar_write` hat drei Aktionen:

- `create` — braucht `title`, `start`, `end`,
- `update` — braucht `id` und nur die Felder, die sich ändern sollen,
- `delete` — braucht `id`.

Ein Verschieben ist ein `update` mit neuem `start` und `end`. Es gibt dafür
keinen zweiten Endpunkt: ein `move`-Werkzeug wäre dieselbe Logik unter einem
zweiten Namen.

Der Ganztag-Flag wird aus der Schreibweise geschlossen, wenn er nicht
ausdrücklich angegeben ist: `"2026-03-14"` *ist* ein Ganztagestermin,
`"2026-03-14T15:00"` ist ein Termin mit Uhrzeit. So muss das Modell nicht
beides angeben und kann sich nicht widersprechen.

Ohne Konto geben die Werkzeuge eine klare Fehlermeldung, statt in den
Kalender des Betreibers zu greifen.

---

## 4. Die Oberfläche

`components/CalendarView.tsx` rendert die Ansicht. Sie hat keine Props und
holt ihre Daten selbst: `hooks/useCalendar.ts` lädt die Termine, schreibt sie
und hält sie über den SSE-Strom aktuell.

### Der Kalender ist immer deutsch

Der Kalender liest seine Texte **nicht** aus der Oberflächensprache, sondern
aus dem **deutschen** Sprachpaket: `components/calendar/useCalendarText.ts`
holt das Paket `de` aus dem Register und übersetzt mit ihm.

Das ist Absicht und keine unterlassene Übersetzung. Der Kalender ist ein
*deutsches* Kalendersystem, und das betrifft mehr als die Wörter: Die Woche
beginnt am Montag, die Kalenderwoche ist die ISO-Woche (KW), die Feiertage
sind die neun bundesweit geltenden deutschen Feiertage mit ihren deutschen
Namen — „Tag der Deutschen Einheit“ heißt in jedem Land „Tag der Deutschen
Einheit“ —, das Datum steht als `14.03.2026`, und die Monats- und
Wochentagsnamen sind „Oktober“ und „Montag“.

Eine Oberfläche, in der der Kalender „Oktober 2026“ und „Tag der Deutschen
Einheit“ zeigt, aber die Knöpfe „Month“ und „Week“ trägt, ist halb
übersetzt. Und einen englischen Kalender mit deutschen Feiertagen gibt es
nicht. Die `calendar.*`-Schlüssel stehen deshalb **nur** in
`lib/i18n/messages/de.ts` — nicht in `en.ts`, nicht in `zh-CN.ts`. In den
anderen Paketen wären sie tote Kopien: der Kalender liest sie ohnehin aus dem
deutschen Paket.

`lib/i18n/locale-parity.test.mjs` hält beides fest: das deutsche Paket darf
mehr Schlüssel haben als der englische Katalog, aber ausschließlich mit dem
Präfix `calendar.` — und der englische und der chinesische Katalog dürfen
keinen einzigen `calendar.`-Schlüssel enthalten.

Die Oberfläche *um* den Kalender herum darf englisch sein. Der Knopf, der den
Kalender öffnet, ist aus demselben Grund deutsch beschriftet
(`components/SessionSidebar.tsx`).

### Die drei Ansichten

- **Monat** — ein 6×7-Raster, Montag zuerst. Jede Zelle zeigt den Tag, den
  Feiertagsnamen und die Termine. Ein Klick auf eine freie Stelle legt einen
  Ganztagestermin an.
- **Woche** — sieben Tagesspalten mit einer Stundenskala von 00 bis 24 Uhr.
  Ganztagestermine stehen in einer eigenen Zeile darüber, Termine mit Uhrzeit
  werden absolut positioniert.
- **Tag** — eine Spalte, dieselbe Stundenskala.

### Ein neuer Termin bekommt eine echte Endzeit

Ein Klick auf eine freie Stunde im Wochen- oder Tagesraster legt einen Termin
**einer Stunde** an: das Ende ist der Beginn plus 60 Minuten. Das ist keine
Kosmetik, sondern eine Notwendigkeit — ein Termin, dessen Ende gleich seinem
Beginn wäre, wäre ungültig, und die Validierung lehnt ihn mit „Das Ende liegt
vor dem Beginn.“ ab; die Route würde ihn nicht speichern. Der Nutzer hätte
dabei nichts falsch gemacht: er hatte auf eine freie Stunde geklickt.

Solange der Nutzer das Ende nicht selbst anfasst, wandert es mit der
Beginnzeit: wer 14:00 anklickt, bekommt 14:00 bis 15:00, und wer danach die
Beginnzeit auf 16:00 setzt, bekommt 16:00 bis 17:00. Ein stehen gebliebenes
Ende wäre entweder vor dem Beginn (und der Termin ungültig) oder läge
plötzlich weit in der Zukunft.

Ein Ganztagestermin aus der Monatsansicht bekommt den angeklickten Tag als
Beginn und denselben Tag als Ende — das ist ein Termin mit genau einem Tag,
kein leerer Zeitraum.

### Ziehen zum Verschieben

Ein Termin lässt sich auf einen anderen Tag (Monatsansicht) oder auf eine
andere Stelle (Wochen- und Tagesansicht) ziehen. Beim Fallen wird ein `PATCH`
mit dem neuen `start` und `end` abgesetzt. Die Länge des Termins bleibt
dabei erhalten — wer einen zweistündigen Termin verschiebt, bekommt keinen
einstündigen. In der Monatsansicht bleibt sogar die Uhrzeit stehen: 14:00
bleibt 14:00, weil es dort keine Zeitachse gibt, auf die man fallen könnte.

Verwendet wird natives HTML5-Drag-and-Drop (`draggable`, `onDragStart`,
`onDragEnter`, `onDragOver`, `onDrop`). Die Anwendung hat keine eigene
Drag-and-Drop-Bibliothek: `react-dnd` ist nur ein Peer von `react-arborist`
(der Dateibaum), und eine zweite Bibliothek für eine Kalenderfläche wäre eine
Abhängigkeit ohne Gegenstück.

#### `dragenter` und `dragover` müssen beide abgebrochen werden

Das Abholziel ist in der Monatsansicht die Tageszelle selbst und in der
Wochen- und Tagesansicht die Stundenzelle. Beide brauchen **zwei**
Ereignisbehandlungen: `dragenter` *und* `dragover`.

Der Grund ist eine Eigenschaft des Browsers, gemessen in Chromium: Wenn der
Mauszeiger ein neues Element erreicht, feuert Chromium zuerst `dragenter` und
`dragover` erst bei der *nächsten* Mausbewegung. Der Browser gilt einen Zug
aber nur dann als angenommen, wenn das zuletzt gelieferte Ereignis
abgebrochen wurde. Bricht die Oberfläche nur `dragover` ab, ist der letzte
Eindruck ein ungebrochenes `dragenter` — der Zug gilt als nicht angenommen,
und Chromium verweigert den Fall: es wird kein `drop` geliefert, und der
Termin bleibt stehen.

Gemessen im Browser am Zellraster: ohne `dragenter` kommt kein `drop` an,
mit `dragenter` kommt es an — und zwar unabhängig davon, ob der Zug schnell
oder langsam über die Zellen läuft. Der Effekt ist derselbe wie bei einer
abgelehnten Aktion: Der Cursor zeigt "nicht erlaubt".

Der Termin-Chip liegt als Kind in der Tageszelle und ist selbst der Ursprung
des Ziehens. Das ist unproblematisch: Die Ereignisse laufen vom Chip zur
Zelle hoch, und die Zelle nimmt sie an.

Die Tageszeile mit der Tageszahl ist ein Geschwister des Chips und nicht sein
Vorfahr; sie darf den Zug deshalb nicht auffangen — sonst wäre über der
Tageszahl kein Fall möglich.

### Löschen fragt nach

Vor dem Löschen fragt die Oberfläche mit `window.confirm`. Das Löschen ist
nicht rückgängig zu machen: der Termin ist weg, und der Agent weiß nichts
davon. Eine Rückfrage kostet einen Klick, ein Versehen kostet den Termin.

### Ein Serverfehler erscheint nicht als englischer Text

Die Routen antworten bei einem Fehler mit einem englischen Text im Feld
`error`. Dieser Text bleibt im Protokoll (`console.error`), angezeigt wird
stattdessen eine deutsche Meldung aus dem Kalender-Katalog:
`calendar.saveFailed` beim Speichern, `calendar.deleteFailed` beim Löschen.
Die Regel aus `docs/i18n.md` sagt das ausdrücklich: einen API-Fehler
übersetzt man nicht, indem man seinen englischen Text erkennt, sondern indem
man den *lokalen* Text darüberlegt.

### Live-Updates aus dem Agenten

Die Ansicht hängt an `GET /api/calendar/events`, einem SSE-Strom. Der Strom
schickt **benannte** Ereignisse:

```
event: calendar_changed
data: {"type":"calendar_changed"}
```

und der Browser hört mit `addEventListener("calendar_changed", …)` darauf.
Das ist nicht verhandelbar: eine SSE-Nachricht ohne `event:`-Zeile kommt im
Browser als Standard-Ereignis `message` an, und ein Listener auf
`"calendar_changed"` feuert dann **nie** — unabhängig davon, was der JSON-Body
enthält. Die Live-Aktualisierung fände dann stillschweigend nicht statt.
Dasselbe Muster verwendet `app/api/files/[...path]/route.ts`, wo der
Datei-Viewer auf `connected` und `change` hört.

`components/calendar/calendar-sse.test.mjs` liest die echten Bytes aus der
echten Route durch einen Parser, der die Zuordnung der HTML-Spezifikation
nachbildet — ein Test, der nur in der Quelle nach einem String sucht, würde
beide Fehler gleich setzen.

Kommt eine Änderungsmeldung, lädt die Ansicht die Termine neu.

Das ist der Punkt, an dem die beiden Hälften des Features zusammenkommen:
der Agent legt einen Termin an, und der Kalender im Browser zeigt ihn sofort
— ohne Neuladen. Ohne diesen Strom stünde im Chat „Ich habe einen Termin
angelegt", während der Kalender leer bliebe.

Der Strom filtert selbst: die Meldung trägt die Identität des Schreibenden,
und der Abonnent vergleicht deren Benutzernamen mit dem eigenen. Das lässt
sich in einem prozess-globalen Broadcast nicht entscheiden — dort kennt der
Broadcast nur die Identität, die geschrieben hat, nicht die, die zuhört.

---

## 5. Die API

| Route | Zweck |
|---|---|
| `GET /api/calendar` | Alle Termine des Kontos. `?from=`/`?to=` filtern den Zeitraum. |
| `POST /api/calendar` | Einen Termin anlegen. |
| `PATCH /api/calendar/[id]` | Einen Termin ändern oder verschieben. |
| `DELETE /api/calendar/[id]` | Einen Termin löschen. |
| `GET /api/calendar/events` | SSE-Strom der Änderungen. |

`PATCH` und nicht `PUT`: `PUT` bedeutet „ersetze diese Ressource", und der
Client schickt bei einer Verschiebung nur das, was sich ändert. Ein `PUT`
würde damit Beschreibung und Ort löschen, wenn der Client sie nicht
mitschickt.

Die Kennung und die Zeitstempel vergibt der Server. Ein Client, der seine
eigene Kennung wählt, könnte einen fremden Termin überschreiben.

Ein fremder Termin ist in der Datei des Kontos gar nicht vorhanden — es gibt
nichts, was ein `403` verbergen könnte. Die Antwort lautet deshalb `404`.

---

## 6. Die Mandantengrenze

Der Kalender ist pro Konto getrennt, an drei Stellen:

1. **Der Pfad.** `resolveTenantAgentDir(identity)` legt das Verzeichnis fest —
   für einen Admin das globale, für einen Mieter das Agent-Verzeichnis in
   seiner eigenen Home. `isCalendarPathAllowed()` prüft zusätzlich, ob der
   fertige Pfad unter der Konto-Home liegt, **vor** dem Anlegen des
   Verzeichnisses. Ein Pfad, der erst erzeugt und dann geprüft wird,
   hinterlässt bei jeder verweigerten Anfrage eine Datei in fremder Home.
2. **Die API.** Jede Route holt die Identität aus den Headern, die
   `proxy.ts` gesetzt hat, und verweigert ohne sie.
3. **Das Werkzeug.** Es ist an die Identität der Sitzung gebunden (Kapitel 3).

---

## 7. Die Dateien

| Datei | Inhalt |
|---|---|
| `lib/calendar.ts` | Ereignismodell, Validierung, deutsche Datumslogik, Feiertage. Ohne `fs`, ohne `fetch` — damit Browser und Server dieselbe Rechnung benutzen. |
| `lib/calendar-store.ts` | Die Datei pro Konto, atomar geschrieben, plus der Änderungs-Emitter. |
| `lib/calendar-tool.ts` | Die beiden Agent-Werkzeuge. |
| `app/api/calendar/route.ts` | Liste und Anlegen. |
| `app/api/calendar/[id]/route.ts` | Ändern und Löschen. |
| `app/api/calendar/events/route.ts` | Der SSE-Strom. |
| `hooks/useCalendar.ts` | Laden, Schreiben und die Verbindung zum SSE-Strom. |
| `components/CalendarView.tsx` | Die Oberfläche. |
| `components/calendar/calendar-model.ts` | Die Rechenlogik der Anzeige: wo ein Termin sitzt, wie lang er ist, wie er verschoben wird. |
| `components/calendar/CalendarEventDialog.tsx` | Der Dialog zum Anlegen und Bearbeiten eines Termins. |
| `components/calendar/useCalendarText.ts` | Die Texte des Kalenders — immer aus dem deutschen Sprachpaket. |
| `lib/i18n/messages/de.ts` | Das deutsche Sprachpaket, vollständig — und als einziges Paket mit den `calendar.*`-Schlüsseln. |
| `lib/i18n/locale-parity.test.mjs` | Die Vollständigkeit des deutschen Pakets und die Ausnahme der `calendar.*`-Schlüssel. |

---

## 8. Die Tests

| Datei | Deckt ab |
|---|---|
| `lib/calendar.test.mjs` | Datumslogik, ISO-Woche, Feiertage, Raster, Terminpositionen, Farben. |
| `lib/calendar-store.test.mjs` | Dateipfad, Mandantengrenze, Schreibweise, Normalisierung, Sortierung, Änderungsmeldungen. |
| `lib/calendar-tool.test.mjs` | Werkzeugnamen, Freigabestufen, Lesen, Schreiben, Verschieben, Löschen, Mandantengrenze. |
| `app/api/calendar/calendar-routes.test.mjs` | Zugriff, Anlegen, Ändern, Löschen, Filter, Mandantengrenze. |
| `components/calendar/calendar-model.test.mjs` | Die Rechenlogik der Anzeige: Raster, Mitternacht, Verschieben, Farben. |
| `components/calendar/calendar-event-dialog.test.mjs` | Vorbelegung von Beginn und Ende, das Ende folgt dem Beginn, die Rückfrage vor dem Löschen. |
| `components/calendar/calendar-view.test.mjs` | Die verdrahtete Ansicht: Ziehen im Monats- und im Wochenraster, und der Servertext erscheint nicht unübersetzt. |
| `components/calendar/calendar-sse.test.mjs` | Der SSE-Strom: die Änderung erreicht einen Listener, für den der Client sich tatsächlich registriert. |
| `lib/i18n/locale-parity.test.mjs` | Die Vollständigkeit des deutschen Pakets und die `calendar.*`-Ausnahme. |
| `lib/i18n/registry.test.mjs` | Die Erkennung der deutschen Browsersprache und die Registrierung. |

Ein Test, der eine Zahl nennt, prüft diese Zahl auch — die Regel aus
`AGENTS.md` gilt hier genauso wie im Rest des Projekts.
