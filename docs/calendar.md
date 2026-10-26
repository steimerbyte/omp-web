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

`calendar_write` hat drei Aktionen:

- `create` — braucht `title`, `start`, `end`,
- `update` — braucht `id` und nur die Felder, die sich ändern sollen,
- `delete` — braucht `id`.

Dazu kommt der Parameter `color`: ein Preset-Name (`accent`, `success`,
`warning`, `danger`, `violet`) oder ein Hex-Code. Er wird mit derselben
Funktion geprüft wie in den Routen (`normalizeCalendarColor()`), damit das
Werkzeug nicht etwas annehmen kann, was die Route ablehnt.

`calendar_read` liest alle Termine oder nur die in einem Zeitraum. Die
Antwort nennt zu jedem Termin Titel, Farbe, Wochentag, Datum, Uhrzeit oder
Ganztag, den Ort und die Notiz — und die Kennung, damit der Agent denselben
Termin danach ändern oder löschen kann.

Ein Verschieben ist ein `update` mit neuem `start`; es gibt dafür keinen
zweiten Endpunkt: ein `move`-Werkzeug wäre dieselbe Logik unter einem zweiten
Namen.

Ohne Konto geben die Werkzeuge eine klare Fehlermeldung, statt in den
Kalender des Betreibers zu greifen.

### Der Vertrag ist englisch, das Ergebnis ist deutsch

Die Beschreibung der Werkzeuge liest das **Modell**, das Ergebnis liest der
**Nutzer** im Chatverlauf. Deshalb ist die Beschreibung englisch und der
Ergebnistext deutsch. Die Werkzeuge folgen damit derselben Regel wie das
andere native Werkzeug `present_files` (`lib/present-files-tool.ts`): die
Beschreibung ist englisch und für das Modell geschrieben.

### Jede Antwort beginnt mit dem heutigen Anker

Der Ergebnistext von `calendar_read` beginnt mit einem **Anker**:

```
Heute ist Montag, 26.10.2026.
Diese Kalenderwoche: Mo 26.10.2026 – So 01.11.2026.
Nächste Kalenderwoche: Mo 02.11.2026 – So 08.11.2026.
```

Der Anker kommt aus dem Kalender, nicht aus dem Modell: „heute" ist der
lokale Tag, weil das Kalenderformat keine Zeitzone kennt.

**Der Wochentag ist der eigentliche Gewinn.** Das Harness schreibt in die
erste User-Nachricht nur `Today: <YYYY-MM-DD>` — **ohne** Wochentag
(`node_modules/@oh-my-pi/pi-coding-agent/src/session/date-cwd-reminder.ts`,
Vorlage `src/prompts/system/date-cwd-reminder.md`). Der Agent musste den
Wochentag also selbst rechnen, und genau das war der Anlass für die
`bash date`-Aufrufe: Das Datum stand da, die Woche nicht. Der Anker liefert
die zweite, müllfreie Quelle.

**Warum „Kalenderwoche" und nicht „Woche".** „Kalenderwoche" ist im Deutschen
der etablierte Begriff für die ISO-Woche — die Anwendung selbst schreibt
„KW 11" in die Kopfzeile. „Diese Woche" meint im Gespräch dagegen die
laufende Woche, und genau diese Verwechslung hat ein Agent produziert: In der
Nach-Messung las er die Ankerzeile „Nächste Woche: Mo 02.11. – So 08.11.",
rief dann aber ein **zwei Wochen breites** Fenster ab und bezeichnete in
seiner Antwort „Mo 26.10. – So 01.11." als „die nächste Woche". Er hat also
zwei Linien verwechselt, weil er zu breit abgefragt hat. Der Anker sagt
deshalb beide Male „Kalenderwoche" — ein Begriff, den es nur einmal gibt.

**Die Regel für die Abfrage.** Fragt der Nutzer nach einer Woche, fragt der
Agent genau den Bereich ab, den der Anker nennt — **eine** Woche, kein
breiteres Fenster — und antwortet mit demselben Bereich. Das steht so auch
in der Beschreibung von `calendar_read`.

#### Was der Anker nicht leistet

Der Anker **präzisiert** relative Angaben, er löst die Frage „welche Woche
meinst du" nicht.

Das ist an einem gemessenen Fall sichtbar geworden: Die Baseline lief
**sonntags** um 23:55, die Nach-Messung **montags**. Prompt 2 („Was steht
diese Woche bei mir im Kalender?") war in der Baseline nur deshalb falsch,
weil „diese Woche" an einem Sonntagabend mehrdeutig ist — die laufende oder
die kommende. Ein **Kontrolllauf mit dem alten Vertrag am selben Montag**
lieferte dieselbe richtige Antwort. Der Fehler lag also am Wochentag,
nicht am Vertrag.

Der Anker nennt die *laufende* Kalenderwoche, und die ist an einem Sonntag die
Woche, die gerade endet. Wer „diese Woche" an einem Sonntag fragt, meint
die kommende. Der Anker ist damit der Anker für **relative Angaben**
(Wochentag, „diese Kalenderwoche", „morgen") — nicht die Auflösung der
Frage, welche Woche gemeint ist.

### Was gemessen wurde

Die Nach-Messung lief mit **elf** natürlichen deutschen Aufgaben — sieben aus
der Baseline plus vier neue, die genau die geänderten Pfade treffen:

- **11/11** Agenten nutzten die Kalenderwerkzeuge,
- **10/11** kamen zu einem korrekten Ergebnis,
- **0** erfundene Behauptungen des Agenten,
- **0** vom Werkzeug abgelehnte Aufrufe in beiden Läufen,
- `bash date`-Aufrufe zur Datumsermittlung: **4 → 1** über die sieben
  gemeinsamen Aufgaben; wochentagsbereinigt (Kontrolllauf mit dem alten
  Vertrag am selben Tag: 2) bleibt **2 → 1**.

Die drei neuen Fälle, die der alte Vertrag nicht konnte, gelingen jetzt.

#### Der Werkzeug-Vergleich alt gegen neu

Am Werkzeug selbst gemessen, je eigenes Temp-HOME — das sind die härtesten
Belege, weil sie nicht vom Modell abhängen, sondern vom Werkzeug:

| Fall | alt | neu |
|---|---|---|
| `update` mit **nur** `start`, nach vorn | ERROR „Das Ende liegt vor dem Beginn." | korrekt, Dauer erhalten |
| `update` mit **nur** `start`, nach hinten | **stillschweigend falsch** (3-Tage-Termin) | korrekt, Dauer erhalten |
| Ganztag → mit Uhrzeit | ERROR | korrekt |
| mit Uhrzeit → Ganztag | ERROR | korrekt |
| `end == start` bei bezeitigt | „Das Ende liegt vor dem Beginn." (sachlich falsch) | eigene Meldung: das Ende muss **nach** dem Beginn liegen |
| Lösch-Meldung bei einem Termin mit Uhrzeit | „am 06T15:00.11.2026." | „am 06.11.2026, 15:00 Uhr" |

Die letzten beiden Zeilen sind **zwei echte Fehler**, die die Baseline
gefunden hat. Sie gehören in die Doku, weil sie die Fehlerklasse zeigen, nach
der man suchen muss: eine Meldung, die ein Datum **mit** Uhrzeit wie ein
reines Datum formatiert, und eine Meldung, die zwei verschiedene Fehler
(Ende vor Beginn, Ende gleich Beginn) mit demselben Satz belegt.

### Der Bereichsfilter filtert nach Überschneidung

`from` und `to` sind Daten (`YYYY-MM-DD`). Der Filter prüft **Überschneidung**,
nicht den Beginn: ein Termin, der nur teilweise im Zeitraum liegt, wird
mitgeliefert — ein Termin vom 01.03. bis 31.03. erscheint auch für
`from = to = '2026-03-10'`. Ein Filter nach dem Beginn würde einen Termin
verdecken, der noch läuft.

### Ein Verschieben behält die Dauer

Ein `update` mit nur einem neuen `start` rechnet das Ende aus der bestehenden
Dauer; ein `update` mit nur einem neuen `end` rechnet entsprechend den
Beginn. Vor dieser Regel scheiterte der Aufruf immer, sobald der neue
Beginn nach dem alten Ende lag — das Ende hätte vor dem Beginn gelegen, und
der Termin wäre ungültig.

### Der Ganztag-Flag folgt der Schreibweise — auch beim Ändern

`"2026-03-14"` *ist* ein Ganztagestermin, `"2026-03-14T15:00"` ist ein Termin
mit Uhrzeit. Das gilt für `create` und für `update` gleichermaßen: wird beim
Ändern kein Flag angegeben, richtet er sich nach der Schreibweise des
angegebenen Wertes. Vor dieser Regel behielt ein `update` den Flag des
bestehenden Termins, und der Wechsel zwischen Ganztag und Uhrzeit brauchte
ein ausdrückliches Flag. Wird gar kein Wert angegeben, bleibt der Flag des
bestehenden Termins stehen.

So muss das Modell nicht beides angeben und kann sich nicht widersprechen.

### Die Fehlermeldungen sagen, was zu tun ist

- Ein unbrauchbares Datum nennt das erwartete Format (`YYYY-MM-DD`) und sagt,
  dass relative Angaben („nächste Woche", „morgen") in ein konkretes Datum
  umgerechnet werden müssen. Im Fehlerfall nennt die Meldung zusätzlich den
  heutigen Tag auf Englisch — das Modell soll ihn nicht selbst bestimmen.
- Eine fehlende `id` sagt, dass `calendar_read` zuerst aufzurufen ist.
- Ein fehlender Titel sagt, dass ein Titel gebraucht wird.
- Ein Ende **gleich** dem Beginn ist ein eigener Fall und hat eine eigene
  Meldung: bei einem bezeitigten Termin muss das Ende **nach** dem Beginn
  liegen, sonst hat der Termin keine Länge. Vorher trugen „Ende vor Beginn"
  und „Ende gleich Beginn" denselben Satz — und der war für den zweiten Fall
  sachlich falsch.

Diese Meldungen sind englisch: sie gehen an das Modell, nicht an den Nutzer.
Die einzige Ausnahme ist der Hinweis auf das fehlende Konto — der bleibt
deutsch, weil er dem Nutzer im Chatverlauf erklärt werden soll, nicht dem
Modell.

### Gekürzte Felder werden gemeldet

Ein Titel über 300 Zeichen wird gekürzt, eine Notiz oder ein Ort über 4000
Zeichen ebenfalls. Der Ergebnistext sagt dann ausdrücklich, dass gekürzt
wurde. Ein Nutzer, dessen Text gekürzt wurde, muss es vom Werkzeug erfahren
und nicht an der Kürzung selbst.

### Das Löschen ist endgültig

Es gibt keinen Papierkorb und kein Rückgängig. Der Ergebnistext sagt das dem
Nutzer, sonst sucht er später vergebens nach dem Termin.

### Die Farbe gehört zum Termin

`calendar_write` kann die Farbe setzen: einen Preset-Namen oder einen
Hex-Code. Geprüft wird mit derselben Funktion `normalizeCalendarColor()`, die
auch die Routen benutzen — das Werkzeug schreibt in dieselbe Datei, und was
die Route ablehnt, muss auch hier abgelehnt werden. Ohne `color` behält ein
bestehender Termin seine Farbe, ein neuer bekommt die Voreinstellung.

### Zwei Fehler, die die Messung gefunden hat

Die beiden sind in der Tabelle unter „Der Werkzeug-Vergleich alt gegen neu"
mit ihrem alten und ihrem neuen Wortlaut belegt:

- Die Löschmeldung formatierte einen Termin mit Uhrzeit wie ein reines Datum
  und schrieb `am 06T15:00.11.2026`. Sie nennt jetzt Datum und Uhrzeit
  getrennt: `am 06.11.2026, 15:00 Uhr`.
- Die Werkzeugausgabe verlor das Enddatum eines Termins über Mitternacht
  (`26.10.2026, 22:00–02:00 Uhr`). Sie nennt jetzt beide Tage.

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

Die fünf deutschen Namen der Preset-Farben („Akzent“, „Erfolg“, „Warnung“,
„Gefahr“, „Violett“) stehen **nicht** im Katalog, sondern in
`lib/calendar.ts` neben den Monats- und Wochentagsnamen. Es ist ein festes
Vokabular des Kalenders, und es muss für Client und Server reichen — die
Dialog-Komponente und die Werkzeug-Ausgabe nennen dieselben fünf Wörter.

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

### Das Zeit- und Datumsfeld

Der Dialog hat **eigene Textfelder** für Datum und Uhrzeit: die Uhrzeit im
24-Stunden-Format `HH:MM`, das Datum in deutscher Schreibweise `DD.MM.JJJJ`.

Der Grund ist eine Messung in Chromium mit englischem Browser-Locale: ein
natives `<input type="time">` zeigt den Wert `15:00` als `03:00 PM`, ein
natives `<input type="date">` den Wert `2026-10-26` als `10/26/2026` — und
`lang="de"` am Element ändert daran nichts. Der **Wert** war die ganze Zeit
richtig (`input.value` stand `15:00`); falsch war allein die **Anzeige**.

Die nativen Felder wurden deshalb ersetzt, nicht umformatiert: ihr Format
folgt dem **Browser**, nicht der Seite. Ein deutscher Kalender, in dem 15 Uhr
als „03 PM" erscheint, ist falsch.

Die Felder sind **uncontrolled**: der getippte Text steht im DOM, nicht im
Zustand. Wer „15:3" schreibt, muss danach noch „0" schreiben können — ein
Zustand, der schon beim Tippen normalisierte, würde die Eingabe zerstören.
Der Zustand hält die *kanonischen* Werte; die Normalisierung sitzt an der
Grenze zum Kalenderformat, in `normalizeTimeInput()` und
`normalizeDateInput()`: `15`, `15:0` und `15:00` ergeben alle `15:00`, und
`14.3.2026` und `14.03.2026` beide `2026-03-14`. Beim Verlassen des Feldes
bekommt der Text seine endgültige Form.

### Die Farbe eines Termins

Ein Termin kann farblich markiert werden. Der Dialog bietet fünf
**Preset-Farben** und einen Knopf **„Benutzerdefiniert“**, der einen
Farbwähler öffnet.

Die Farbe ist **Datenhaltung**: sie steht in der Kalenderdatei beim Termin.
Ein Termin, den der Nutzer farblich markiert hat, soll seine Farbe behalten,
wenn das Theme wechselt.

#### Die Presets sind Theme-Variablen

Die fünf Presets — `accent`, `success`, `warning`, `danger`, `violet` — sind
Theme-Variablen (`var(--accent)`, `var(--success)`, `var(--warning)`,
`var(--danger)`, `var(--violet)`), keine festen Farben. `AGENTS.md` verbietet
Farbliterale im Code, und `applyOmpPalette` schreibt die Variablen zur Laufzeit
um: eine Kachel mit festem `#1f8b4c` bliebe in einem importierten Theme die
alte Farbe.

**`violet` ist die eine Ausnahme, und die ist gewollt.** Die Titanium-Palette
hat kein Violett; der Wert stammt aus omp's Amethyst-Theme (dort `deepPurple`,
im dunklen Theme `violet`) und steht deshalb in beiden Blöcken von
`app/globals.css` fest. `applyOmpPalette` kennt nur Akzent, Erfolg, Fehler
und Warnung — Violett wird nicht überschrieben. In einem importierten Theme
folgen die vier übrigen Presets dem Theme, das Violett bleibt bei der
Anwendung. Der Kommentar in `app/globals.css` sagt das ausdrücklich, damit
die Asymmetrie nicht als Versehen gelesen wird.

#### Die fünf deutschen Namen stehen in der Domäne

„Akzent“, „Erfolg“, „Warnung“, „Gefahr“, „Violett“ stehen in
`lib/calendar.ts` neben `GERMAN_MONTHS` und `GERMAN_WEEKDAYS` — **nicht** im
i18n-Katalog. Es ist ein festes Vokabular des Kalenders, das in jeder Sprache
des Programms deutsch ist, und es muss für zwei Seiten reichen: die
Dialog-Komponente (Client) und die Werkzeug-Ausgabe (Server) nennen dieselben
fünf Wörter. Eine Konstante in `lib/calendar-tool.ts` könnte der Client nicht
importieren (die Datei zieht `fs` über den Store), und ein i18n-Schlüssel
könnte das Server-Werkzeug nicht ohne das gesamte Sprachpaket auflösen.

#### Der eigene Hex-Code wird wörtlich gespeichert

Wer eine eigene Farbe wählt, hat sie gewählt — sie darf sich nicht mit dem
Theme ändern. Ein Hex-Code ist deshalb **Datenhaltung** und wird genau so in
der Datei abgelegt, wie der Nutzer ihn wählt; nur die Schreibweise wird
vereinheitlicht.

Der eigene Farbwähler ist ein natives `<input type="color">` **plus** ein
Feld für den Hex-Code. Beide sind in beide Richtungen synchron: wer im
Hex-Feld tippt, sieht den Wähler die Farbe annehmen, und wer den Wähler
benutzt, sieht den Code im Feld stehen.

Gespeichert wird nur eine Form — klein und sechs Stellen (`#f0a` wird zu
`#ff00aa`). Zwei Schreibweisen derselben Farbe wären in der Datei zwei
verschiedene Termine, und der Vergleich zweier Termine würde sie für zwei
Farben halten.

Der Wähler wird mit der **tatsächlichen** Farbe des Termins vorbelegt, nicht
mit einem Wert aus dem Quelltext: `readThemeHex()` liest die geltende
Theme-Variable über `getComputedStyle`, weil `applyOmpPalette` die Farben zur
Laufzeit umschreibt und ein importiertes Theme eigene Werte hat. Wählt der
Nutzer ein Preset, bekommt der eigene Wähler die laufende Farbe dieses
Presets zu sehen.

#### Wie die Farbe gezeichnet wird

Der Hintergrund eines Termins ist die Terminfarbe, mit der Fläche des Themes
gemischt — nicht die Terminfarbe selbst. Das ist der Grund, warum ein Termin
auch mit `#ffffff` lesbar bleibt: eine gefüllte weiße Fläche im hellen Theme
wäre ein weißes Rechteck auf weißem Grund. Der Text bleibt `var(--text)`, die
Theme-Farbe — nicht die Terminfarbe. Nur so tragen *alle* Terminfarben
denselben Text; der Kontrast hängt am Theme, nicht an der Wahl des Nutzers.
Der linke Rand bleibt die volle Terminfarbe: er ist das, was den Termin auf
einen Blick erkennbar macht.

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
| `GET /api/calendar` | Alle Termine des Kontos. `?from=`/`?to=` filtern den Zeitraum — nach Überschneidung, wie der Filter im Werkzeug. |
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

`POST` und `PATCH` nehmen ein optionales `color` an: einen Preset-Namen
(`accent`, `success`, `warning`, `danger`, `violet`) oder einen Hex-Code.
Eine **unbrauchbare** Farbe ist ein `400` — der Client hat sie gewählt, also
stimmt etwas nicht, und das gehört gemeldet statt stillschweigend verworfen.
Eine **fehlende** Farbe ist kein Fehler: sie ist optional, und ein Termin
ohne Farbe trägt die Voreinstellung. Bei `PATCH` bleibt die Farbe des
Termins, wenn sie nicht mitschickt.

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
| `lib/calendar.ts` | Ereignismodell, Validierung, deutsche Datumslogik, Feiertage, Farben, die Normalisierung von Zeit-, Datums- und Farbeingaben. Ohne `fs`, ohne `fetch` — damit Browser und Server dieselbe Rechnung benutzen. |
| `lib/calendar-store.ts` | Die Datei pro Konto, atomar geschrieben, plus der Änderungs-Emitter. |
| `lib/calendar-tool.ts` | Die beiden Agent-Werkzeuge. |
| `app/api/calendar/route.ts` | Liste und Anlegen. |
| `app/api/calendar/[id]/route.ts` | Ändern und Löschen. |
| `app/api/calendar/events/route.ts` | Der SSE-Strom. |
| `app/globals.css` | Die Theme-Variablen — und dort auch `--violet`, die fünfte Preset-Farbe, in beiden Themes. |
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
| `lib/calendar.test.mjs` | Datumslogik, ISO-Woche, Feiertage, Raster, Terminpositionen, Farben und ihre Normalisierung. |
| `lib/calendar-store.test.mjs` | Dateipfad, Mandantengrenze, Schreibweise, Normalisierung, Sortierung, Änderungsmeldungen. |
| `lib/calendar-tool.test.mjs` | Werkzeugnamen, Freigabestufen, Lesen, Schreiben, Verschieben, Löschen, der heutige Anker, die Gekürzungs-Hinweise, die Farben, Mandantengrenze. |
| `app/api/calendar/calendar-routes.test.mjs` | Zugriff, Anlegen, Ändern, Löschen, Filter, Farben, Mandantengrenze. |
| `components/calendar/calendar-model.test.mjs` | Die Rechenlogik der Anzeige: Raster, Mitternacht, Verschieben. |
| `components/calendar/calendar-event-dialog.test.mjs` | Vorbelegung von Beginn und Ende, das Ende folgt dem Beginn, die Rückfrage vor dem Löschen, die fünf Presets und der eigene Farbcode. |
| `components/calendar/calendar-view.test.mjs` | Die verdrahtete Ansicht: Ziehen im Monats- und im Wochenraster, und der Servertext erscheint nicht unübersetzt. |
| `components/calendar/calendar-sse.test.mjs` | Der SSE-Strom: die Änderung erreicht einen Listener, für den der Client sich tatsächlich registriert. |
| `lib/i18n/locale-parity.test.mjs` | Die Vollständigkeit des deutschen Pakets und die `calendar.*`-Ausnahme. |
| `lib/i18n/registry.test.mjs` | Die Erkennung der deutschen Browsersprache und die Registrierung. |

Ein Test, der eine Zahl nennt, prüft diese Zahl auch — die Regel aus
`AGENTS.md` gilt hier genauso wie im Rest des Projekts.
