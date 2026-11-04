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
