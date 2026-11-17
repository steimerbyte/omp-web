# Test-Harness

Ein Kommando beantwortet drei Fragen: ist die Suite grün, ist eine neue
Quelldatei ungetestet, hat eine Datei neue ungetestete Funktionen bekommen.
Kein Zeilen-Prozentziel, kein `bun run build`, keine Quelltextänderung.
Stand 2026-11-04 (v0.23.0, Bun 1.4.4): 378 Dateien, 2.901 Fälle (2.900 pass,
1 skip, 0 fail in 41,5 s); vorher 229 Dateien, 2.005 Fälle, 57 s seriell.

## Kommandos

| Kommando | Umfang |
|---|---|
| `bun run test` | Suite + Coverage + Gate — **41,5 s gemessen** |
| `bun run test:fast` | Suite ohne Coverage (Innenschleife) |
| `bun run test:unit\|api\|ui` | Ausschnitte: `lib/ hooks/` · `app/api` · `components/` |
| `bun run test:coverage` | Coverage schreiben, **ohne** Gate |
| `bun run test:baseline` | Baseline neu schreiben |
| `bun run verify` | Typecheck, dann Gate (CI-Einstieg) |

Nur `test` und `verify` gaten (Ausschnitte schreiben kein vollständiges lcov).
`OMP_TEST_PARALLEL` setzt die Worker-Zahl (Default 8), z. B. `2` auf einem
4-Kern-Runner; bei 229 Dateien gemessen: 57 s seriell gegen 27–29 s mit 8.

## Aufbau

`scripts/test-gate.mjs` startet `bun test --parallel=<n> --timeout=30000` mit
`--coverage --coverage-reporter=lcov --coverage-dir=coverage`; ist die Suite rot,
endet es dort und das Gate läuft nicht. `scripts/test-coverage-gate.mjs` baut
danach den Importgraph über die Testdateien (Reichweite) und liest
`coverage/lcov.info` (Funktionen); `scripts/coverage-functions.mjs` misst eine Datei.

`--parallel` gibt jeder Testdatei einen eigenen Worker-Prozess mit frischem
Modulzustand — der Grund, warum `mock.module` und gesetzte `process.env`-Werte
nur noch in ihrer Datei gelten. `--timeout=30000` ist Konfiguration, nicht
Komfort: unter 8 Workern überschreiten die Subprozess-Proben Buns 5-s-Default.

## Gate-Regeln

R1 — **Reichweite.** Jede Datei in `lib/ components/ hooks/ app/ bin/ scripts/`
sowie `proxy.ts`, `next.config.ts`, `instrumentation.ts`, `public/sw.js` muss
von mindestens einer Testdatei **transitiv importiert** werden (`import`,
`export from`, `import()`, `require()`, `@/` oder relativ) — sonst muss sie in
`baseline.unreachable` stehen. `readFileSync(new URL("./x.ts"))` zählt nicht.

R2 — **Ratchet.** Steht eine Datei in `baseline.unreachable` und wird inzwischen
erreicht, scheitert das Gate, bis der Eintrag gelöscht ist — die Debt-Liste darf
nicht zur Dauererlaubnis werden.

R3 — **Funktionen.** Aus lcov, pro Datei `uncovered = FNF − FNH`: a) nicht in
`baseline.coverage` und `uncovered > 0` → fail; b) `uncovered` gestiegen → fail,
mit Delta; c) in der Baseline, aber nicht mehr im Report → fail (Test entfernt
oder Datei weg). So ist „neue Funktion ohne Test" auch in einer bestehenden
Datei erfasst, ohne Per-Funktion-Records von Bun.

R4 — **Kein `.only`.** Ein vergessenes `.only` blendet den Rest der Suite aus;
nicht baseline-fähig.

R5 — **Keine stillen Skips.** `test.skip(` und `test.todo(` → fail.
`{ skip: <ausdruck> }` → fail, wenn im Ausdruck kein String-Literal steht, das
nicht Teil eines Vergleichs ist. Erst hermetisch machen, dann skippen; die Probe
ist messbar — kein `process.env.CI`, kein Datum, kein Testname.

```js
{ skip: !CAN_RUN && "bwrap oder User-Namespaces fehlen" }      // ok
{ skip: process.platform === "win32" && "POSIX-Dateirechte" }  // ok
{ skip: process.platform === "win32" }                         // fail
```

## Baseline und Ratchet

`.test-baseline.json`, `schemaVersion: 1`: `unreachable[]` ist
`{ file, reason, since }` und **handgepflegt** — `reason` sagt, warum die Datei
ohne Test bleiben darf; `coverage{}` ist maschinell
`{ functionsFound, functionsHit, uncovered }` pro Datei und wird nie von Hand
editiert. `bun run test:baseline` schreibt den `coverage`-Block neu und ergänzt
unbekannte `unreachable`-Dateien mit `"reason": "TODO: Test oder Begründung"`,
damit sie im Diff auffallen. Beide Blöcke werden nur kleiner (R2, R3b); kein
Eintrag gilt einem roten Test. Stand: 332 Quelldateien, 315 erreichbar, 17 Debt.

## Eine Datei messen

```bash
bun run test                     # schreibt coverage/lcov.info
node scripts/coverage-functions.mjs --missing lib/skills-service.ts coverage
# 17	15	2	lib/skills-service.ts
```

Ohne `--missing` folgt eine Zeile je Datei plus Summe (`(total)`), TAB-getrennt:
`found hit uncovered datei`. Exit 2 heißt: kein Treffer — die Datei steht in
keinem Coverage-Lauf (Pfad prüfen oder R1). Gesamtstand im Gate-Kopf:
`Funktionen: 4174/4849 ausgeführt (86.1%), 675 ohne Test`.

## Die zwei Messgrenzen

**1. Keine Funktionsnamen aus lcov.** Bun 1.4.4 schreibt `FNF:`/`FNH:` pro
Datei, aber keine `FN:`/`FNDA:`-Sätze; ein Join auf Funktionsnamen ist
unmöglich. `FNF` zählt **jedes** Funktionsliteral, auch anonyme
Inline-Callbacks: 4.849 gefunden, 4.174 ausgeführt, 675 offen (86,1 %) —
überwiegend anonyme JSX-Callbacks in `FileExplorer`, `SessionSidebar`,
`AppShell` und `ModelsConfig`. Das Ratchet lässt sie schrumpfen, es behauptet
nicht, sie seien getestet. Neun dieser Callbacks (Filter und Sort in
`npx`, `rpc-manager`, `skills/check`, `skills/update`, `ModelsConfig`) laufen
nur, wenn die Testumgebung Provider-Keys im Env hat; die Baseline ist deshalb
im nüchternen Env des Deploy-Hosts gemessen (`env -i HOME=… PATH=…`), in einer
Entwickler-Shell sind es 4.183/666. Die unabhängige zweite Messung zählt benannte
Funktionen (2.144) — davon läuft alles bis auf eine dokumentierte Handvoll.
`FNF` kann um ±1 abweichen (bedingter Lazy-Import); `test:baseline` läuft
deshalb auf einem grünen Baum mit CI-Konfiguration (parallel=8, Coverage an).

**2. 67 Einzeiler sind nicht messbar.** Steht der ganze Rumpf auf der
Deklarationszeile (`const f = (x) => x + 1`, `() => void` in einem Props-Objekt),
läuft die Zeile schon beim Modul-Import; ein Zeilentreffer beweist dort nichts.
Sie zählen weder als gedeckt noch als ungedeckt.

## Browser-Abnahme

`bun run ui:audit` ist die zweite Ebene: eine echte Chromium-Sitzung gegen einen
eigenen Dev-Server. Sie existiert, weil eine ganze Fehlerklasse in der Suite
grundsätzlich grün ist — das DOM ist korrekt, nur der Blick darauf nicht:

- ein Werkzeug in der waagerecht rollenden Kopfleiste liegt ausserhalb des
  sichtbaren Bereichs (`elementFromPoint` auf seiner Mitte liefert etwas
  anderes);
- ein fester 36-px-Knopf liegt über dem Ende der Leiste und verdeckt das letzte
  Ziel;
- ein Popover wird gerendert und dann von `overflow-y: hidden` seiner Leiste
  abgeschnitten;
- ein Panel bekommt eine Geometrie, die nicht in den Viewport passt;
- ein Knopf verschwindet auf dem Telefon durch eine Breitenprüfung.

Diese Woche wurden alle fünf von Hand gefunden. Jede davon ist im Browser in
Sekunden messbar und in `bun test` unsichtbar, weil `linkedom` kein Layout hat.

```bash
bun run ui:audit                      # Exit != 0 bei mindestens einem FAIL
PLAYWRIGHT_CHROMIUM_PATH=/pfad/zu/chromium bun run ui:audit
```

Was der Lauf tut:

1. eigener `bun run dev`-Kindprozess auf einem freien Port ab 30142, mit
   `OMP_WEB_USERNAME=omp` und einem **pro Lauf zufälligen** `OMP_WEB_PASSWORD`
   — nur in der Umgebung des Kindes. Dazu ein eigenes `HOME` samt
   `XDG_*`-Variablen, ein eigener `PI_CODING_AGENT_DIR`, eigene
   Auth-/Session-/Kontendateien und ein eigenes `OMP_WEB_HOME_ROOT`; Bericht,
   Server-Log und Fixtures liegen unter `/tmp/omp-ui-audit-<Zeitstempel>/`: der
   Lauf schreibt weder in die echten Sitzungen noch in `~/.omp/logs`, und er
   liest nie `/etc/omp-web.env`. Gebaut wird nach `.next-ui-audit` (relativ,
   weil Next `distDir` gegen die Projektwurzel auflöst — ein absoluter Pfad
   landet als `<repo>/tmp/…` im Baum), und dieses Verzeichnis räumt der Lauf
   selbst wieder weg.
   `OMP_WEB_ADMINS=omp` macht die Identität zum Admin, sonst beantwortet
   `GET /api/project-trust` kein cwd und `GET /api/stats` (CPU/RAM-Popover)
   antwortet 403. Die Live-Instanzen 8788/8799 werden nicht berührt.
2. Login über `POST /api/web-access/login` **im Browser**, damit das Cookie
   dort landet, wo es hingehört und der Proxy den Weg eines Menschen sieht.
3. Prüfungen bei 390×844 (`hasTouch`, `isMobile`) und 1280×900, jeweils in drei
   Kopfleisten-Zuständen: ohne Sitzung (`/`), mit Sitzung (`/?cwd=…`) und mit
   Trust-Streifen (`/?cwd=` auf ein Projekt mit `.omp/config.yml`).
4. Klartext-Bericht auf stdout, JSON unter `/tmp/omp-ui-audit-<Zeitstempel>/report.json`
   (dort liegt auch `dev-server.log`). Kindprozess und Browser sterben in jedem
   Fall, auch bei `SIGINT`/`SIGTERM`.

Die Prüfungen: Erreichbarkeit jedes bedienbaren Elements in Kopfleiste,
Composer-Werkzeugleiste und Seitenleisten-Aktionen (an `scrollLeft` 0, an der
Zielmitte und am Maximum; ein Ziel gilt als erreichbar, sobald *eine* Position
seinen eigenen Mittelpunkt trifft), Überdeckung an der Maximalposition,
Abschneide-Vorfahr als Diagnose (erster Vorfahr mit `overflow-x`/`overflow-y`
≠ `visible`), jedes `aria-haspopup`-Popover (Rechteck im Viewport ±1 px,
Mittelpunkt trifft das Popover), Dokumentbreite ≤ `innerWidth + 1`,
Roll-Andeutung für jede waagerecht rollende Fläche (`data-*fade`-Attribut oder
sichtbare Scrollleiste), Tap-Ziele unter 44×44 px (WARN mit den fünf kleinsten,
kein Fehler) und `pageerror`/`console.error` (jeder ist ein FAIL).

Playwright ist als **`playwright-core`** installiert (kein Browser-Download):
der Lauf startet `chromium.launch({ executablePath })` mit
`PLAYWRIGHT_CHROMIUM_PATH` oder `/usr/bin/chromium`. Fehlt Chromium, bricht der
Lauf mit einem Satz ab, der den Pfad nennt.

Die Regeln ohne Browser — Viewport-Toleranz, Roll-Andeutung, Hit-Urteil,
Scroll-Positionen, Tap-Zählung, Abschneide-Vorfahr — stehen in
`lib/ui-audit.ts` und sind mit `lib/ui-audit.test.mjs` in `bun run test`
gedeckt. Das Skript `scripts/ui-audit.mjs` misst nur und steht deshalb in
`.test-baseline.json` als nicht importierbares CLI-Werkzeug.

`ui:audit` gehört **nicht** in `bun run verify`: es braucht einen Browser, einen
eigenen Dev-Server und **rund 5 Minuten**, weil der Dev-Server bei jedem Lauf in
ein frisches `.next` kompiliert (gemessen: 294 s für beide Viewports und alle
sechs Läufe). Die Trennung ist Absicht — zwei Dev-Server im selben Checkout
teilen sich sonst das Build-Verzeichnis und stören den des Entwicklers. `verify`
läuft ausserdem auf Hosts ohne Chromium. Der Lauf ist Teil der
Release-Checkliste (`docs/release.md`).

## Ausnahmen

Die 17 `unreachable`-Einträge sind echte Fälle: `app/layout.tsx` und
`app/manifest.ts` rendert Next, `components/PwaRegistration.tsx` und
`public/sw.js` laufen im Browser, der Rest sind CLI-/Build-/Operator-Skripte
samt Harness. Dazu eine Grenze in der Fläche: `lib/system-resources.ts:347`
braucht `/dev/nvidia*` (nvidia-Closure).

## Troubleshooting

**Ordnungsleck innerhalb einer Datei.** `--parallel` isoliert Dateien, nicht
Tests. `process.env` ist prozessweit: eine Zuweisung auf Modulebene gilt nicht
mehr, sobald eine andere Datei ihre eigene setzt — pro Test setzen und in
`test.after` zurücksetzen. 39 Dateien setzen Variablen auf Modulebene.

**`mock.module`.** Gilt prozessweit und lässt sich nicht zurücknehmen.
`lib/http-dispatcher.unit.test.mjs` mockt `undici` und ist deshalb nur unter
`--parallel` korrekt; mit zwei Dateien pro Prozess wird die Datei rot.

**jiti-Loader.** Die Tests laden TS über `jiti`. Wird dasselbe Modul in einem
Lauf über zwei Loader instanziiert (jiti-Transpilat und nativer Bun-Import),
verliert Bun die Zähler eines der beiden — im Einzellauf stimmen sie. Für eine
belastbare Zahl die Datei einzeln fahren, nicht den Gesamtlauf befragen.

**linkedom-Prototypen.** `HTMLElement.prototype` und `Element.prototype` sind
prozessweit geteilt: ein Geometrie-Stub aus einer Datei ist in der nächsten
sichtbar (gemessen: 600 px aus `FileExplorer.*`, danach maß `CalendarView`
einen Chip 600 px hoch). `restoreLinkedomPrototypesOnExit(win)` direkt nach
`parseHTML` aufrufen, vor jedem Patch. `globalThis.window` ist ebenfalls ein
geteilter Slot: eine Datei darf nur ihren eigenen Stub entfernen.

Nachtrag 2026-11-15 (bun 1.4.4): zwischen **Testdateien** wird nichts mehr
getragen. Eine Probe-Datei sieht `globalThis.HTMLElement` und `globalThis.document`
gar nicht erst (`undefined`), auch wenn `calendar-picker-dialogs.test.mjs` im
selben `bun test`-Lauf mitläuft — weder mit noch ohne Rückbau. Innerhalb *einer*
Datei gilt das Teilen weiter: zwei `parseHTML`-Fenster haben dieselbe
`HTMLElement`-Klasse (`a.HTMLElement === b.HTMLElement`), und ein Patch an `a`
ist an `b` sichtbar (gemessen mit einem Zwei-Fenster-Skript). Der Rückbau bleibt
deshalb Pflicht — nur wirkt er innerhalb der Datei, nicht mehr zwischen Dateien.

**Ein roter Test ohne Namen (2026-11-15).** Der erste `bun run verify` des Tages
meldete `1 fail` (`3217 pass`, 399 Dateien); weil die Ausgabe auf `tail -14`
gekürzt war, ist der Testname verloren. Sechs Vollläufe danach waren grün —
fünf mit `3218 pass`, einer mit `3217 pass`, alle mit `3 skip / 0 fail`,
`3221 Tests` und `✓ Gate bestanden`; zwei davon direkt hintereinander mit
identischem Befehl (`OMP_TEST_PARALLEL=2`, `nice -n 19 taskset -c 0-1`). Der
Lauf mit `3217` zählte einen Pass weniger bei 0 Failures: der Test wackelt, der
Stand ist nicht kaputt.

Der Verdacht — die beiden großen Kalender-Dialog-Dateien patchen
`HTMLElement.prototype.attachEvent`/`detachEvent` ohne
`restoreLinkedomPrototypesOnExit(win)` — ist **widerlegt**: Stubs einer Datei
erreichen die nächste nicht (Messung im Absatz oben). Die Umstellung ist
trotzdem drin und mit diesem Eintrag committet, weil sie die Regel erfüllt:
beide Dateien rufen `restoreLinkedomPrototypesOnExit(win)` direkt nach
`parseHTML`, und `calendar-picker-dialogs.test.mjs` prüft den Rückbau am
Dateiende in einem `test.after`-Hook gegen den geerbten Wert. Ein absichtlich
falscher Erwartungswert macht den Lauf rot (`1 error`, Exit 1, gemessen), der
Hook ist also ein Wächter und keine Dekoration. Der Flake selbst bleibt
**offen** und unbenannt: wer ihn braucht, schreibt den Lauf ungekürzt in eine
Datei und greppt `(fail)`.

## Wie man einen neuen Test schreibt

Datei neben das Modul, `*.test.mjs`, `node:test`-API, ausgeführt von Bun.
Behauptungen gelten dem Verhalten, nicht der Form: ein `readFileSync`-Regex auf
die Quelle ist kein Test (und zählt dem Gate nicht als Abdeckung).

**Route Handler.** Route über jiti laden, `Request` selbst bauen, gegen ein
temporäres Home laufen lassen, damit „geschrieben" auch „gelesen" heißt:

```js
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { PUT } = await jiti.import("./route.ts");
test.beforeEach(() => { process.env.OMP_WEB_HOME_ROOT = homeRoot; }); // prozessweit
const res = await PUT(new Request("http://test/api/quick-phrases", { method: "PUT", body: "[]" }));
```

**Lib-Modul.** Importieren, Eingabe→Ausgabe prüfen; bei Dateizugriff ein
`mkdtempSync`-Verzeichnis und die Umgebungsvariable dafür. Kein DOM nötig.

**React-Komponente.** Reine Darstellung mit `renderToStaticMarkup` und Assert
auf HTML-Strings (kein DOM). Alles mit State, Effekt, Radix-Portal über
`linkedom` + `createRoot` + `act`:

```js
const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
restoreLinkedomPrototypesOnExit(dom.window);
globalThis.document = dom.window.document;
globalThis.navigator = { languages: ["de-DE"], language: "de-DE" }; // I18nProvider
for (const [k, v] of Object.entries(linkedom)) if (/^[A-Z]/.test(k)) globalThis[k] = v;
const root = createRoot(dom.window.document.body);
await act(async () => root.render(React.createElement(Component, props)));
```

**Hook.** Es gibt keine Testing Library. Eine Probe-Komponente ruft den Hook auf
und schreibt den Rückgabewert in eine Closure; `act` flusht die Renders, danach
wird der Wert geprüft, nicht die Renderzahl (`hooks/useCalendar.test.mjs`).

Vor dem Commit: `bun run verify`. Neue Funktion ohne Test → R3 rot; neue Datei
ohne Import → R1 rot; Ausnahme nur mit `reason` in `.test-baseline.json`.
